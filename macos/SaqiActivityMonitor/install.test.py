import contextlib
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


spec = importlib.util.spec_from_file_location("monitor_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
with patch.object(subprocess, "run", side_effect=AssertionError("Import must not execute installer commands")):
    spec.loader.exec_module(installer)


class Commands:
    def __init__(self, test, *, loaded, failure, activations):
        self.test = test
        self.loaded = loaded
        self.failure = failure
        self.outcomes = list(activations)
        self.calls = []
        self.activations = []
        self.stuck = False
        self.prints = 0
        self.inspection_error = False
        self.inspection_error_after = None
        self.inspection_diagnostic = "Could not inspect domain: Operation not permitted"
        self.absent_bootout_failure = False

    def compile(self, command):
        if self.failure == "compile":
            return 1
        Path(command[command.index("-o") + 1]).write_bytes(b"new monitor")
        return 0

    def sign(self, command):
        self.test.assertTrue((Path(command[-1]) / "Contents/Info.plist").exists())
        return 1 if self.failure == "sign" else 0

    def inspect(self, command):
        self.prints += 1
        if self.inspection_error or (self.inspection_error_after is not None and self.prints > self.inspection_error_after):
            return 5, self.inspection_diagnostic
        if self.loaded:
            return 0, ""
        label = command[-1].rsplit("/", 1)[-1]
        return 1, f'Bad request.\nCould not find service "{label}" in domain for user gui: {os.getuid()}\n'

    def bootout(self):
        if self.stuck or (not self.loaded and self.absent_bootout_failure):
            return 5
        self.loaded = False
        self.inspection_error = False
        return 0

    def bootstrap(self):
        self.activations.append((self.test.binary.read_bytes(), self.test.plist.read_bytes()))
        outcome = self.outcomes.pop(0)
        self.loaded = outcome in ["ok", "partial", "partial-stuck", "uninspectable", "uninspectable-stuck", "rejected-uninspectable"]
        self.stuck = outcome in ["partial-stuck", "uninspectable-stuck"]
        self.inspection_error = outcome in ["uninspectable", "uninspectable-stuck", "rejected-uninspectable"]
        self.absent_bootout_failure = outcome == "absent-stop-fail"
        return 5 if outcome in ["fail", "partial", "partial-stuck", "rejected-uninspectable", "absent-stop-fail"] else 0

    def __call__(self, command, check=False, *, capture_output=False, text=False, timeout=None, env=None):
        self.calls.append(command)
        diagnostic = ""
        if command[0] == "xcrun":
            code = self.compile(command)
        elif command[0] == "codesign":
            code = self.sign(command)
        elif command[:2] == ["launchctl", "print"]:
            code, diagnostic = self.inspect(command)
        elif command[:2] == ["launchctl", "bootout"]:
            code = self.bootout()
        elif command[:2] == ["launchctl", "bootstrap"]:
            code = self.bootstrap()
        else:
            raise AssertionError(f"Unexpected installer command: {command}")
        if check and code:
            raise subprocess.CalledProcessError(code, command)
        return subprocess.CompletedProcess(command, code, stdout="" if text else b"",
                                           stderr=diagnostic if text else diagnostic.encode())


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="saqi monitor install spaces ")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.root = self.home / "source repository"
        self.app = self.home / "Applications/Saqi Activity Monitor.app"
        self.binary = self.app / "Contents/MacOS/SaqiActivityMonitor"
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"old monitor")
        self.plist = self.home / "Library/LaunchAgents/app.saqi.monitor.plist"
        self.plist.parent.mkdir(parents=True)
        self.previous_plist = plistlib.dumps({
            "Label": installer.LABEL,
            "ProgramArguments": [str(self.binary)],
            "PreviousConfiguration": "keep",
        })
        self.plist.write_bytes(self.previous_plist)
        self.plist.chmod(0o640)
        self.unrelated = self.app.parent / "unrelated.txt"
        self.unrelated.write_text("keep unrelated files")
        self.output = io.StringIO()

    def install(self, commands):
        with patch.object(installer.subprocess, "run", side_effect=commands), \
                patch.object(installer.LAUNCHCTL.time, "sleep"), contextlib.redirect_stdout(self.output):
            return installer.install(home=self.home, root=self.root)

    def backups(self):
        return list(self.app.parent.glob(".saqi-monitor-backup-*"))

    def assert_previous_files(self):
        self.assertEqual(self.binary.read_bytes(), b"old monitor")
        self.assertEqual(self.plist.read_bytes(), self.previous_plist)
        self.assertEqual(self.plist.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.unrelated.read_text(), "keep unrelated files")

    def assert_staging_removed(self):
        self.assertEqual(list(self.app.parent.glob(".saqi-monitor-build-*")), [])

    def assert_interrupted_move(self, phase, loaded):
        commands = Commands(self, loaded=loaded, failure=None, activations=["ok"])
        original_rename = Path.rename
        interrupted = False
        primary = KeyboardInterrupt(f"Interrupted after {phase} move")

        def rename(source, destination):
            nonlocal interrupted
            result = original_rename(source, destination)
            matched = ((phase == "app" and source == self.app)
                       or (phase == "plist" and source == self.plist)
                       or (phase == "replacement" and destination == self.app))
            if matched and not interrupted:
                interrupted = True
                raise primary
            return result

        with patch.object(Path, "rename", rename):
            with self.assertRaises(KeyboardInterrupt) as failure:
                self.install(commands)
        self.assertIs(failure.exception, primary)
        self.assertTrue(interrupted)
        self.assert_previous_files()
        self.assertEqual(commands.loaded, loaded)
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_interruption_after_moving_the_previous_app_restores_it(self):
        for loaded in (False, True):
            with self.subTest(loaded=loaded):
                self.assert_interrupted_move("app", loaded)

    def test_interruption_after_moving_the_previous_plist_restores_it(self):
        for loaded in (False, True):
            with self.subTest(loaded=loaded):
                self.assert_interrupted_move("plist", loaded)

    def test_interruption_after_moving_the_replacement_restores_previous_files(self):
        for loaded in (False, True):
            with self.subTest(loaded=loaded):
                self.assert_interrupted_move("replacement", loaded)

    def test_an_uncertain_app_path_preserves_the_owned_backup_and_unrelated_entry(self):
        commands = Commands(self, loaded=False, failure=None, activations=["ok"])
        original_rename = Path.rename

        def rename(source, destination):
            result = original_rename(source, destination)
            if source == self.app:
                self.app.mkdir()
                (self.app / "unrelated.txt").write_text("preserve unexpected entry")
                raise KeyboardInterrupt("Interrupted after app move")
            return result

        with patch.object(Path, "rename", rename):
            with self.assertRaisesRegex(RuntimeError, "rollback failed"):
                self.install(commands)
        self.assertEqual((self.app / "unrelated.txt").read_text(), "preserve unexpected entry")
        self.assertEqual(self.plist.read_bytes(), self.previous_plist)
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual((self.backups()[0] / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assert_staging_removed()

    def test_build_and_sign_failures_leave_the_old_monitor_running(self):
        for failure in ["compile", "sign"]:
            with self.subTest(failure=failure):
                commands = Commands(self, failure=failure, loaded=True, activations=["ok"])
                with self.assertRaises(subprocess.CalledProcessError):
                    self.install(commands)
                self.assert_previous_files()
                self.assertTrue(commands.loaded)
                self.assertFalse(any(command[0] == "launchctl" for command in commands.calls))
                self.assertEqual(self.backups(), [])
                self.assert_staging_removed()

    def test_success_activates_the_signed_app_and_removes_only_its_own_backup(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        self.assertEqual(self.install(commands), self.app)
        self.assertEqual(self.binary.read_bytes(), b"new monitor")
        self.assertTrue(commands.loaded)
        info = plistlib.loads((self.app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["SaqiRepository"], str(self.root.resolve()))
        self.assertEqual(info["SaqiPythonExecutable"], sys.executable)
        agent = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(agent["ProgramArguments"], [str(self.binary)])
        self.assertEqual(self.plist.stat().st_mode & 0o777, 0o600)
        sign_index = next(index for index, command in enumerate(commands.calls) if command[0] == "codesign")
        stop_index = next(index for index, command in enumerate(commands.calls) if command[:2] == ["launchctl", "bootout"])
        self.assertLess(sign_index, stop_index)
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()
        self.assertEqual(self.unrelated.read_text(), "keep unrelated files")
        self.assertIn("menu bar", self.output.getvalue())
        self.assertIn("continue when you quit", self.output.getvalue())

    def test_the_installer_records_its_selected_interpreter_including_spaces(self):
        python = "/managed Python 3.15/bin/python3"
        with patch.object(installer.sys, "executable", python):
            self.install(Commands(self, loaded=True, failure=None, activations=["ok"]))
        info = plistlib.loads((self.app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["SaqiPythonExecutable"], python)

    def test_an_unverifiable_interpreter_aborts_before_building_or_stopping(self):
        for python in ("", "python3"):
            with self.subTest(python=python):
                commands = Commands(self, loaded=True, failure=None, activations=["ok"])
                with patch.object(installer.sys, "executable", python):
                    with self.assertRaisesRegex(RuntimeError, "absolute Python"):
                        self.install(commands)
                self.assertEqual(commands.calls, [])
                self.assert_previous_files()

    def test_a_job_that_cannot_stop_keeps_its_files_and_is_not_replaced(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        commands.stuck = True
        with self.assertRaisesRegex(RuntimeError, "could not stop"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(commands.activations, [])
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_a_failed_inspection_cannot_downgrade_a_known_loaded_job_after_bootout_fails(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        commands.stuck = True
        commands.inspection_error_after = 1
        with self.assertRaisesRegex(RuntimeError, "could not stop"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(commands.activations, [])
        self.assertTrue(any(command[:2] == ["launchctl", "bootout"] for command in commands.calls))
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_an_initial_inspection_error_leaves_the_previous_job_and_files_untouched(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        commands.inspection_error = True
        with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertFalse(any(command[:2] == ["launchctl", "bootout"] for command in commands.calls))
        self.assertEqual(commands.activations, [])
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_a_missing_diagnostic_for_another_label_is_not_proof_the_monitor_is_absent(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        commands.inspection_error = True
        commands.inspection_diagnostic = f'Could not find service "{installer.LABEL}.other" in domain for user gui: {os.getuid()}'
        with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertFalse(any(command[:2] == ["launchctl", "bootout"] for command in commands.calls))
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_a_failed_inspection_after_bootout_does_not_authorize_replacing_files(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        commands.inspection_error_after = 1
        with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
            self.install(commands)
        self.assert_previous_files()
        self.assertFalse(commands.loaded)
        self.assertEqual(commands.activations, [])
        self.assertEqual(sum(command[:2] == ["launchctl", "bootout"] for command in commands.calls), 1)
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_interrupted_initial_inspections_never_stop_or_replace_the_previous_monitor(self):
        for error in [OSError("launchctl unavailable"), subprocess.TimeoutExpired(["launchctl", "print"], 10)]:
            with self.subTest(error=type(error).__name__):
                commands = Commands(self, loaded=True, failure=None, activations=["ok"])

                def interrupted(command, check=False, *, capture_output=False, text=False, timeout=None, env=None):
                    if command[:2] == ["launchctl", "print"]:
                        raise error
                    return commands(command, check=check, capture_output=capture_output, text=text, timeout=timeout, env=env)

                with self.assertRaises(type(error)):
                    self.install(interrupted)
                self.assert_previous_files()
                self.assertTrue(commands.loaded)
                self.assertFalse(any(command[:2] == ["launchctl", "bootout"] for command in commands.calls))
                self.assertEqual(commands.activations, [])
                self.assertEqual(self.backups(), [])
                self.assert_staging_removed()

    def test_empty_mixed_or_interrupted_diagnostics_are_not_evidence_of_absence(self):
        target = f"gui/{os.getuid()}/{installer.LABEL}"
        missing = f'Could not find service "{installer.LABEL}" in domain for user gui: {os.getuid()}'
        for code, diagnostic in [(1, ""), (1, f"{missing}\nOperation not permitted"), (-9, missing)]:
            with self.subTest(code=code, diagnostic=diagnostic):
                result = subprocess.CompletedProcess(["launchctl", "print", target], code, stdout="", stderr=diagnostic)
                with patch.object(installer.subprocess, "run", return_value=result):
                    with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
                        installer.job_loaded(target)

    def test_failed_activation_restores_files_permissions_and_the_previous_job(self):
        commands = Commands(self, activations=["fail", "ok"], loaded=True, failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual([binary for binary, _ in commands.activations], [b"new monitor", b"old monitor"])
        self.assertEqual(commands.activations[-1][1], self.previous_plist)
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_a_partially_loaded_replacement_is_stopped_before_restoring_the_old_app(self):
        commands = Commands(self, activations=["partial", "ok"], loaded=True, failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(sum(command[:2] == ["launchctl", "bootout"] for command in commands.calls), 2)
        self.assertEqual(self.backups(), [])

    def test_a_successful_bootstrap_that_did_not_load_rolls_back(self):
        commands = Commands(self, activations=["missing", "ok"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "did not load"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(self.backups(), [])

    def test_accepted_replacement_is_stopped_even_if_its_verification_cannot_inspect_it(self):
        commands = Commands(self, activations=["uninspectable", "ok"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(sum(command[:2] == ["launchctl", "bootout"] for command in commands.calls), 2)
        self.assertEqual(self.backups(), [])

    def test_uninspectable_accepted_replacement_that_cannot_stop_keeps_its_backup(self):
        commands = Commands(self, activations=["uninspectable-stuck"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "rollback failed"):
            self.install(commands)
        self.assertEqual(self.binary.read_bytes(), b"new monitor")
        self.assertTrue(commands.loaded)
        self.assertEqual(len(self.backups()), 1)
        backup = self.backups()[0]
        self.assertEqual((backup / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assertEqual((backup / "previous.plist").read_bytes(), self.previous_plist)
        self.assert_staging_removed()

    def test_rejected_bootstrap_with_failed_inspection_still_stops_the_partial_replacement(self):
        commands = Commands(self, activations=["rejected-uninspectable", "ok"], loaded=True, failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual(sum(command[:2] == ["launchctl", "bootout"] for command in commands.calls), 2)
        self.assertEqual(self.backups(), [])

    def test_failed_bootout_after_rejected_bootstrap_keeps_the_original_backup(self):
        commands = Commands(self, activations=["absent-stop-fail"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "rollback failed"):
            self.install(commands)
        self.assertEqual(len(self.backups()), 1)
        backup = self.backups()[0]
        self.assertEqual((backup / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assertEqual((backup / "previous.plist").read_bytes(), self.previous_plist)
        self.assert_staging_removed()

    def test_plist_write_failure_restores_the_old_files_and_loaded_job(self):
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        with patch.object(installer, "write_launch_agent", side_effect=OSError("plist write failed")):
            with self.assertRaisesRegex(OSError, "plist write failed"):
                self.install(commands)
        self.assert_previous_files()
        self.assertTrue(commands.loaded)
        self.assertEqual([binary for binary, _ in commands.activations], [b"old monitor"])
        self.assertEqual(self.backups(), [])

    def test_rollback_preserves_an_intentionally_unloaded_monitor(self):
        commands = Commands(self, loaded=False, activations=["fail"], failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assert_previous_files()
        self.assertFalse(commands.loaded)
        self.assertEqual(len(commands.activations), 1)
        self.assertEqual(self.backups(), [])

    def test_rollback_preserves_app_symlinks_without_deleting_their_target(self):
        previous = self.home / "Previous Monitor.app"
        self.app.rename(previous)
        self.app.symlink_to(previous, target_is_directory=True)
        commands = Commands(self, activations=["fail", "ok"], loaded=True, failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assertTrue(self.app.is_symlink())
        self.assertEqual(self.app.readlink(), previous)
        self.assertEqual((previous / "Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assert_previous_files()
        self.assertEqual(self.backups(), [])

    def test_a_failed_fresh_install_removes_only_the_new_app_and_agent(self):
        shutil.rmtree(self.app)
        self.plist.unlink()
        commands = Commands(self, loaded=False, activations=["fail"], failure=None)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(commands)
        self.assertFalse(self.app.exists())
        self.assertFalse(self.plist.exists())
        self.assertFalse(commands.loaded)
        self.assertEqual(self.unrelated.read_text(), "keep unrelated files")
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()

    def test_failed_rollback_keeps_both_previous_files_outside_staging(self):
        commands = Commands(self, activations=["fail", "fail"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "rollback failed") as failure:
            self.install(commands)
        self.assert_previous_files()
        self.assertEqual(len(self.backups()), 1)
        backup = self.backups()[0]
        self.assertIn(str(backup), str(failure.exception))
        self.assertEqual((backup / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assertEqual((backup / "previous.plist").read_bytes(), self.previous_plist)
        self.assert_staging_removed()

    def test_rollback_copy_failure_keeps_the_previous_app_and_plist_in_its_backup(self):
        commands = Commands(self, activations=["fail"], loaded=True, failure=None)
        with patch.object(installer, "copy_entry", side_effect=OSError("restore failed")):
            with self.assertRaisesRegex(RuntimeError, "rollback failed"):
                self.install(commands)
        self.assertEqual(len(self.backups()), 1)
        backup = self.backups()[0]
        self.assertEqual((backup / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assertEqual((backup / "previous.plist").read_bytes(), self.previous_plist)
        self.assert_staging_removed()

    def test_an_unstoppable_replacement_keeps_previous_files_for_manual_recovery(self):
        commands = Commands(self, activations=["partial-stuck"], loaded=True, failure=None)
        with self.assertRaisesRegex(RuntimeError, "rollback failed"):
            self.install(commands)
        self.assertEqual(self.binary.read_bytes(), b"new monitor")
        self.assertEqual(len(self.backups()), 1)
        backup = self.backups()[0]
        self.assertEqual((backup / "previous.app/Contents/MacOS/SaqiActivityMonitor").read_bytes(), b"old monitor")
        self.assertEqual((backup / "previous.plist").read_bytes(), self.previous_plist)
        self.assert_staging_removed()

    def test_a_loaded_job_without_a_restorable_agent_is_not_stopped(self):
        self.plist.unlink()
        commands = Commands(self, loaded=True, failure=None, activations=["ok"])
        with self.assertRaisesRegex(RuntimeError, "no complete installation"):
            self.install(commands)
        self.assertEqual(self.binary.read_bytes(), b"old monitor")
        self.assertTrue(commands.loaded)
        self.assertFalse(any(command[:2] == ["launchctl", "bootout"] for command in commands.calls))
        self.assertEqual(self.backups(), [])
        self.assert_staging_removed()


@unittest.skipUnless(sys.platform == "darwin", "Read-only launchctl inspection requires macOS")
class LaunchctlInspectionTests(unittest.TestCase):
    def test_current_macos_reports_a_unique_nonexistent_label_as_absent(self):
        target = f"gui/{os.getuid()}/{installer.LABEL}.absence-probe-{uuid.uuid4().hex}"
        self.assertFalse(installer.job_loaded(target))


if __name__ == "__main__":
    unittest.main()
