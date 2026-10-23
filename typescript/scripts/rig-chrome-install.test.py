import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector_install", Path(__file__).with_name("rig-chrome-install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTest(unittest.TestCase):
    def setUp(self):
        build = patch.object(installer, "build_extension")
        self.build = build.start()
        self.addCleanup(build.stop)

    def test_failed_preflight_preserves_existing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            _, launcher, registration = installer.paths(home)
            installer.atomic_write(launcher, "old launcher", 0o700)
            installer.atomic_write(registration, "old manifest", 0o600)
            with patch.object(installer, "preflight", side_effect=RuntimeError("missing credentials")):
                with self.assertRaises(RuntimeError):
                    installer.install(home=home)
            self.assertEqual(launcher.read_text(), "old launcher")
            self.assertEqual(registration.read_text(), "old manifest")

    def test_rerun_and_uninstall_preserve_operational_state(self):
        with tempfile.TemporaryDirectory(prefix="saqi install spaces ") as temporary:
            home = Path(temporary)
            state, launcher, registration = installer.paths(home)
            installer.atomic_write(state / "collector-status.json", '{"state":"collecting"}', 0o600)
            with patch.object(installer, "preflight", return_value="/node with spaces/bin/node"), patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stderr='Could not find service "app.saqi.rig.collect" in domain for user gui: 501')):
                installer.install(home=home)
                installer.install(home=home)
            self.assertIn("'/node with spaces/bin/node'", launcher.read_text())
            self.assertEqual(installer.shlex.split(launcher.read_text().splitlines()[1])[1], installer.sys.executable)
            self.assertEqual((state / "collector-status.json").read_text(), '{"state":"collecting"}')
            installer.uninstall(home)
            installer.uninstall(home)
            self.assertFalse(launcher.exists())
            self.assertFalse(registration.exists())
            self.assertTrue((state / "collector-status.json").exists())

    def test_doctor_reports_stale_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(installer, "preflight", return_value="/new/node"):
                with self.assertRaisesRegex(RuntimeError, "stale"):
                    installer.doctor(home=Path(temporary))

    def test_a_failed_legacy_collector_stop_preserves_startup_and_bridge(self):
        loaded = subprocess.CompletedProcess([], 0)
        for outcomes in (
            [subprocess.CompletedProcess([], 1, stderr='Operation not permitted')],
            [loaded, subprocess.CompletedProcess([], 5)],
            [loaded, loaded, *([loaded] * 30)],
        ):
            with self.subTest(calls=len(outcomes)), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                _, launcher, registration = installer.paths(home)
                startup = home / 'Library/LaunchAgents/app.saqi.rig.collect.plist'
                for path, body in ((launcher, 'previous launcher'), (registration, 'previous registration'), (startup, 'previous startup')):
                    installer.atomic_write(path, body, 0o600)
                with patch.object(installer, 'preflight', return_value='/node'), \
                     patch.object(installer.subprocess, 'run', side_effect=outcomes), \
                     patch.object(installer.LAUNCHCTL.time, 'sleep'):
                    with self.assertRaises(RuntimeError):
                        installer.install(home=home)
                self.assertEqual(launcher.read_text(), 'previous launcher')
                self.assertEqual(registration.read_text(), 'previous registration')
                self.assertEqual(startup.read_text(), 'previous startup')

    def test_a_confirmed_legacy_stop_precedes_installing_the_new_bridge(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            _, launcher, registration = installer.paths(home)
            startup = home / 'Library/LaunchAgents/app.saqi.rig.collect.plist'
            installer.atomic_write(startup, 'previous startup', 0o600)
            results = iter([
                subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 1, stderr='Could not find service "app.saqi.rig.collect" in domain for user gui: 501'),
            ])
            def command(arguments, *, capture_output, timeout, text=False, env=None):
                self.assertTrue(startup.exists())
                self.assertFalse(launcher.exists())
                self.assertFalse(registration.exists())
                return next(results)
            with patch.object(installer, 'preflight', return_value='/node'), \
                 patch.object(installer.subprocess, 'run', side_effect=command):
                installer.install(home=home)
            self.assertFalse(startup.exists())
            self.assertTrue(launcher.exists())
            self.assertTrue(registration.exists())

    def test_malformed_runtime_reports_are_rejected_before_native_health(self):
        for report in (b'{}', b'/node\0oops', b'node\x0026', b'/node\x0026\0extra'):
            with self.subTest(report=report), \
                 patch.object(installer.platform, 'system', return_value='Darwin'), \
                 patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=report)) as run:
                with self.assertRaises(RuntimeError):
                    installer.preflight(installer.ROOT)
                self.assertEqual(run.call_count, 1)

    def test_runtime_probe_preserves_spaces_and_rejects_invalid_health(self):
        import json
        import struct
        for reply in ({'ready': True, 'protocol': 1}, {'ready': True, 'protocol': True}, [], {'ready': False, 'protocol': 1, 'error': 'invalid'}):
            with self.subTest(reply=reply):
                body = json.dumps(reply).encode()
                results = [subprocess.CompletedProcess([], 0, stdout=b'/node with spaces/bin/node\x0026'),
                           subprocess.CompletedProcess([], 0, stdout=struct.pack('<I', len(body)) + body)]
                with patch.object(installer.platform, 'system', return_value='Darwin'), \
                     patch.object(installer.subprocess, 'run', side_effect=results) as run:
                    if reply == {'ready': True, 'protocol': 1} and reply.get('protocol') is not True:
                        self.assertEqual(installer.preflight(installer.ROOT), '/node with spaces/bin/node')
                        self.assertEqual(run.call_args_list[1].args[0][0], '/node with spaces/bin/node')
                    else:
                        with self.assertRaises(RuntimeError):
                            installer.preflight(installer.ROOT)

    def test_doctor_explains_unreadable_saved_status_without_changing_it(self):
        for body in ('private incomplete JSON', '[]', '{"seenAt": {}}', '{"seenAt":"not a date"}', '{"seenAt":"2026-01-01T00:00:00"}'):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                state, launcher, registration = installer.paths(home)
                script, manifest = installer.configuration(installer.ROOT, home, '/node')
                installer.atomic_write(launcher, script, 0o700)
                installer.atomic_write(registration, manifest, 0o600)
                snapshot = state / 'collector-status.json'
                snapshot.write_text(body)
                output = io.StringIO()
                with patch.object(installer, 'preflight', return_value='/node'), redirect_stdout(output):
                    installer.doctor(home=home)
                self.assertIn('open its popup to refresh', output.getvalue())
                self.assertNotIn('private incomplete JSON', output.getvalue())
                self.assertEqual(snapshot.read_text(), body)

    def test_future_saved_heartbeat_is_not_a_live_connection(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state, launcher, registration = installer.paths(home)
            script, manifest = installer.configuration(installer.ROOT, home, '/node')
            installer.atomic_write(launcher, script, 0o700)
            installer.atomic_write(registration, manifest, 0o600)
            installer.atomic_write(state / 'collector-status.json', '{"seenAt":"2099-01-01T00:00:00Z","state":"collecting"}', 0o600)
            output = io.StringIO()
            with patch.object(installer, 'preflight', return_value='/node'), redirect_stdout(output):
                installer.doctor(home=home)
            self.assertIn('Chrome: disconnected', output.getvalue())


if __name__ == "__main__":
    unittest.main()
