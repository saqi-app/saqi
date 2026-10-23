import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name("rig-background.py")
SPEC = importlib.util.spec_from_file_location("rig_background", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ABSENT = subprocess.CompletedProcess([], 1, stderr='Could not find service "app.saqi.rig.translate" in domain for user gui: 501\n')


class InstallationPreflightTests(unittest.TestCase):
    def test_selected_node_path_with_spaces_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            with patch.dict(MODULE.os.environ, {}, clear=True), \
                 patch.object(MODULE, "AGENTS", directory / "agents"), \
                 patch.object(MODULE, "STATE", directory / "state"), \
                 patch.object(MODULE.subprocess, "check_output", return_value=b"/node with spaces/bin/node\x0026") as probe, \
                 patch.object(MODULE.shutil, "which", return_value="/codex/bin/codex"):
                self.assertEqual(MODULE.prepare_installation(), ("/node with spaces/bin/node", "/codex/bin/codex"))
            self.assertEqual(probe.call_args.args[0], ["node", str(MODULE.ROOT / "typescript/scripts/rig-node-runtime.ts")])
            self.assertEqual(probe.call_args.kwargs["timeout"], 15)
            self.assertTrue((directory / "agents").is_dir())
            self.assertEqual((directory / "state").stat().st_mode & 0o777, 0o700)

    def test_invalid_runtime_never_creates_startup_or_state_directories(self):
        for runtime in [b"relative/node\x0026", b"/node\x0023", b"/node\x00invalid", b"/node\x0026\x00extra"]:
            with self.subTest(runtime=runtime), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                with patch.dict(MODULE.os.environ, {}, clear=True), \
                     patch.object(MODULE, "AGENTS", directory / "agents"), \
                     patch.object(MODULE, "STATE", directory / "state"), \
                     patch.object(MODULE.subprocess, "check_output", return_value=runtime):
                    with self.assertRaises(SystemExit):
                        MODULE.prepare_installation()
                self.assertEqual(list(directory.iterdir()), [])


class StopTranslationTests(unittest.TestCase):
    def run_stop(self, directory, outcomes):
        with patch.object(MODULE, "AGENTS", directory), \
             patch.object(MODULE.sys, "platform", "darwin"), \
             patch.object(MODULE.sys, "argv", [str(SCRIPT), "stop"]), \
             patch.object(MODULE.LAUNCHCTL.time, "sleep"), \
             patch.object(MODULE.subprocess, "run", side_effect=outcomes) as run:
            MODULE.main()
            return run

    def test_failed_bootout_preserves_startup_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            plist = directory / "app.saqi.rig.translate.plist"
            plist.write_text("previous startup")
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_stop(directory, [subprocess.CompletedProcess([], 0), subprocess.CalledProcessError(5, "launchctl")])
            self.assertEqual(plist.read_text(), "previous startup")

    def test_a_job_still_loaded_after_bootout_preserves_startup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            plist = directory / "app.saqi.rig.translate.plist"
            plist.write_text("previous startup")
            with self.assertRaisesRegex(RuntimeError, "could not stop"):
                self.run_stop(directory, [subprocess.CompletedProcess([], 0)] * 32)
            self.assertEqual(plist.read_text(), "previous startup")

    def test_confirmed_stop_removes_startup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            plist = directory / "app.saqi.rig.translate.plist"
            plist.write_text("previous startup")
            run = self.run_stop(directory, [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0), ABSENT])
            self.assertFalse(plist.exists())
            self.assertEqual(run.call_args_list[1].args[0][1], "bootout")
            self.assertEqual(run.call_args_list[1].kwargs["timeout"], 10)

    def test_already_unloaded_stop_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            run = self.run_stop(directory, [ABSENT])
            self.assertEqual(run.call_count, 1)

    def test_inspection_failure_preserves_startup_before_or_after_bootout(self):
        for prefix in ([], [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0)]):
            for diagnostic in ('Permission denied', 'Could not find service "other.job" in domain for user gui: 501', ABSENT.stderr + 'Permission denied'):
                with self.subTest(prefix=len(prefix), diagnostic=diagnostic), tempfile.TemporaryDirectory() as temporary:
                    directory = pathlib.Path(temporary)
                    plist = directory / "app.saqi.rig.translate.plist"
                    plist.write_text("previous startup")
                    with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
                        self.run_stop(directory, [*prefix, subprocess.CompletedProcess([], 1, stderr=diagnostic)])
                    self.assertEqual(plist.read_text(), "previous startup")

    def test_inspection_timeout_preserves_startup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            plist = directory / "app.saqi.rig.translate.plist"
            plist.write_text("previous startup")
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_stop(directory, [subprocess.TimeoutExpired('launchctl', 10)])
            self.assertEqual(plist.read_text(), "previous startup")


if __name__ == "__main__":
    unittest.main()
