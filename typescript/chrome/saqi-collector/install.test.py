import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTest(unittest.TestCase):
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
            with patch.object(installer, "preflight", return_value="/node with spaces/bin/node"), patch.object(installer.subprocess, "run"):
                installer.install(home=home)
                installer.install(home=home)
            self.assertIn("'/node with spaces/bin/node'", launcher.read_text())
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


if __name__ == "__main__":
    unittest.main()
