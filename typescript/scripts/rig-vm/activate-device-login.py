#!/usr/bin/env python3
"""Activate a staged Codex login at a translation boundary without SSH."""

import base64
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import time


def activate(pending, destination, expected_email, uid, gid):
    if not pending.exists():
        print("No pending Codex device login.", flush=True)
        return False
    if not expected_email:
        raise ValueError("SAQI_CODEX_LOGIN_EMAIL is required for a pending login")
    credentials = pending.read_bytes()
    token_payload = json.loads(credentials)["tokens"]["id_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(token_payload + "=" * (-len(token_payload) % 4)))
    if claims.get("email") != expected_email:
        raise ValueError("Pending Codex login does not match the expected account")

    print("Waiting for the current translation before activating the device login.", flush=True)
    while True:
        state = subprocess.check_output(
            ["systemctl", "show", "saqi-translate.service", "-p", "ActiveState", "--value"],
            text=True,
        ).strip()
        if state not in {"active", "activating", "deactivating", "reloading"}:
            break
        time.sleep(2)

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".device-login-", delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), uid, gid)
            output.write(credentials)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    pending.unlink()
    print("Activated the authorized Codex device login.", flush=True)
    return True


def main():
    user = pwd.getpwnam("saqi")
    private_directory = Path(user.pw_dir) / ".config" / "saqi"
    activate(
        private_directory / "pending-codex-auth.json",
        Path(user.pw_dir) / ".codex" / "auth.json",
        os.environ.get("SAQI_CODEX_LOGIN_EMAIL"),
        user.pw_uid,
        user.pw_gid,
    )
    (private_directory / "pending-codex-login.env").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
