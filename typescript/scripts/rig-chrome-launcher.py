#!/usr/bin/env python3
# The kernel releases this per-user native-host lock on process exit.
import fcntl
import json
import os
from pathlib import Path
import struct
import sys


def failure(code, message):
    prefix = sys.stdin.buffer.read(4)
    request_id = None
    if len(prefix) == 4:
        length = struct.unpack("<I", prefix)[0]
        if length <= 1048576:
            try:
                request_id = json.loads(sys.stdin.buffer.read(length)).get("id")
            except (ValueError, AttributeError):
                pass
    body = json.dumps({"id": request_id, "ok": False, "error": {"code": code, "message": message}}).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
    sys.stdout.buffer.flush()
    raise SystemExit(1)


def main():
    directory = Path.home() / "Library/Application Support/Saqi"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(directory / "collector.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        failure("COLLECTOR_ALREADY_RUNNING", "Collection is already connected in another Chrome profile. Use that profile or close it first.")
    os.set_inheritable(lock, True)
    try:
        os.execv(sys.argv[1], sys.argv[1:])
    except OSError:
        failure("NATIVE_SETUP_REQUIRED", "The installed Node runtime is unavailable. Rerun the Saqi collector installer.")


if __name__ == "__main__":
    main()
