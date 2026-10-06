import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("device_login", Path(__file__).with_name("activate-device-login.py"))
device_login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device_login)


class DeviceLoginTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.pending = Path(self.directory.name) / "pending.json"
        self.destination = Path(self.directory.name) / "auth.json"
        self.destination.write_text("previous login")
        claims = base64.urlsafe_b64encode(json.dumps({"email": "authorized@example.com"}).encode()).decode().rstrip("=")
        self.credentials = json.dumps({"tokens": {"id_token": f"header.{claims}.signature"}}).encode()
        self.pending.write_bytes(self.credentials)

    def activate(self, expected_email="authorized@example.com"):
        return device_login.activate(self.pending, self.destination, expected_email, os.getuid(), os.getgid())

    def test_busy_translation_keeps_existing_login_until_it_finishes(self):
        with patch.object(device_login.subprocess, "check_output", side_effect=["activating\n", "active\n", "inactive\n"]), patch.object(device_login.time, "sleep") as sleep:
            sleep.side_effect = lambda _: self.assertEqual(self.destination.read_text(), "previous login")
            self.assertTrue(self.activate())
            self.assertEqual(sleep.call_count, 2)
        self.assertEqual(self.destination.read_bytes(), self.credentials)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.destination.stat().st_uid, os.getuid())
        self.assertFalse(self.pending.exists())
        self.assertEqual(sorted(path.name for path in Path(self.directory.name).iterdir()), ["auth.json"])

    def test_wrong_account_preserves_both_logins_and_does_not_pause_work(self):
        with patch.object(device_login.subprocess, "check_output") as inspect_service:
            with self.assertRaisesRegex(ValueError, "does not match"):
                self.activate("different@example.com")
            inspect_service.assert_not_called()
        self.assertEqual(self.destination.read_text(), "previous login")
        self.assertEqual(self.pending.read_bytes(), self.credentials)

    def test_missing_pending_login_leaves_existing_login_untouched(self):
        self.pending.unlink()
        with patch.object(device_login.subprocess, "check_output") as inspect_service:
            self.assertFalse(self.activate())
            inspect_service.assert_not_called()
        self.assertEqual(self.destination.read_text(), "previous login")

    def test_service_inspection_failure_preserves_existing_and_pending_logins(self):
        with patch.object(device_login.subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, "systemctl")):
            with self.assertRaises(subprocess.CalledProcessError):
                self.activate()
        self.assertEqual(self.destination.read_text(), "previous login")
        self.assertEqual(self.pending.read_bytes(), self.credentials)


if __name__ == "__main__":
    unittest.main()
