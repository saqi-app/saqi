# Exercise the real exec/fcntl boundary without Chrome, credentials, or D1.
import json
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

LAUNCHER = Path(__file__).with_name("rig-chrome-launcher.py")


class LauncherLockTest(unittest.TestCase):
    def test_node_holds_lock_until_killed_and_second_profile_cannot_start(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required to test the actual exec boundary")
        command = [sys.executable, str(LAUNCHER), node, "-e",
                   "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"]
        with tempfile.TemporaryDirectory(prefix="saqi-lock-test-") as directory:
            env = {**os.environ, "HOME": directory}
            first = self.start_owner(command, env)
            try:
                request = json.dumps({"id": 7, "action": "hello"}).encode()
                second = subprocess.run(command, input=struct.pack("<I", len(request)) + request,
                                        env=env, capture_output=True, timeout=5)
                self.assertEqual(second.returncode, 1)
                self.assertEqual(second.stderr, b"")
                length = struct.unpack("<I", second.stdout[:4])[0]
                self.assertEqual(len(second.stdout), 4 + length)
                reply = json.loads(second.stdout[4:])
                self.assertEqual(reply["id"], 7)
                self.assertFalse(reply["ok"])
                self.assertEqual(reply["error"]["code"], "COLLECTOR_ALREADY_RUNNING")
                self.assertIsNone(first.poll(), "Competing profile must not stop the owner")
            finally:
                first.kill()
                first.communicate(timeout=5)
            # A stale lock file remains, but the kernel releases ownership on SIGKILL.
            self.assertTrue((Path(directory) / "Library/Application Support/Saqi/collector.lock").exists())
            restarted = self.start_owner(command, env)
            restarted.kill()
            restarted.communicate(timeout=5)

    def start_owner(self, command, env):
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=env)
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], "Node did not start")
            self.assertEqual(child.stdout.readline(), b"READY\n")
            return child
        except BaseException:
            child.kill()
            child.communicate(timeout=5)
            raise


if __name__ == "__main__":
    unittest.main()
