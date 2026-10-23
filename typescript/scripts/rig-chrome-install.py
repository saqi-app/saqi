#!/usr/bin/env python3
"""Install, diagnose, or remove only the personal Chrome collector bridge."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shlex
import struct
import subprocess
import sys
import tempfile

SOURCE_ENV = Path(__file__).resolve().parents[3] / "private/source.env"
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("saqi_launchctl", Path(__file__).with_name("rig_launchctl.py"))
LAUNCHCTL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHCTL)


def paths(home):
    state = home / "Library/Application Support/Saqi"
    registration = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/app.saqi.collector.json"
    return state, state / "chrome-host", registration


def extension_id(root):
    manifest = json.loads((root / "typescript/chrome/saqi-collector/manifest.json").read_text())
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(97 + int(char, 16)) for char in digest)


def atomic_write(path, body, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as staged:
        temporary = Path(staged.name)
        staged.write(body.encode())
    try:
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def preflight(root):
    if platform.system() != "Darwin":
        raise RuntimeError("This installer supports macOS and standard Google Chrome.")
    runtime = subprocess.run(["node", str(root / "typescript/scripts/rig-node-runtime.ts")],
                             capture_output=True, check=True, timeout=15)
    fields = runtime.stdout.split(b"\0")
    if len(fields) != 2 or not fields[1].isdigit() or len(fields[1]) > 6:
        raise RuntimeError("Node runtime could not be verified. Check its installation.")
    node = fields[0].decode("utf-8")
    if not Path(node).is_absolute():
        raise RuntimeError("Node did not report an absolute executable path.")
    if int(fields[1]) < 24:
        raise RuntimeError("Node 24 or newer is required.")
    result = subprocess.run([node, f"--env-file={SOURCE_ENV}", str(root / "typescript/scripts/rig-chrome-host.ts"), "--health"],
                            capture_output=True, timeout=90)
    output = result.stdout
    if len(output) < 4 or len(output) != 4 + struct.unpack("<I", output[:4])[0]:
        raise RuntimeError("Native health check failed. Run yarn build:api and yarn workspace @saqi/source-collector build in typescript, then retry.")
    reply = json.loads(output[4:])
    if not isinstance(reply, dict):
        raise RuntimeError("Native health response is invalid. Rebuild and reinstall the collector.")
    if result.returncode or reply.get("ready") is not True or reply.get("protocol") != 1 or reply.get("protocol") is True:
        error = reply.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        raise RuntimeError(message if isinstance(message, str) else "Native protocol mismatch. Update this checkout and rebuild.")
    return node


def configuration(root, home, node):
    _, launcher, _ = paths(home)
    if not sys.executable or not Path(sys.executable).is_absolute():
        raise RuntimeError("Run setup with an installed Python interpreter that reports its absolute executable path.")
    command = [sys.executable, str(root / "typescript/scripts/rig-chrome-launcher.py"),
               node, f"--env-file={SOURCE_ENV}", str(root / "typescript/scripts/rig-chrome-host.ts")]
    script = "#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n'
    registration = json.dumps({"name": "app.saqi.collector", "description": "Saqi source-only native bridge",
                               "path": str(launcher), "type": "stdio",
                               "allowed_origins": [f"chrome-extension://{extension_id(root)}/"]}, indent=2) + "\n"
    return script, registration


def build_extension(root, home, node):
    subprocess.run([node, f"--env-file={SOURCE_ENV}",
                    str(root / "typescript/scripts/build-collector.ts"),
                    str(home / "Library/Application Support/Saqi/extension")], check=True, timeout=30)

def install(root=ROOT, home=None):
    home = home or Path.home()
    node = preflight(root)  # Do not change a working installation unless this passes.
    _, launcher, registration = paths(home)
    script, manifest = configuration(root, home, node)
    LAUNCHCTL.stop_job(f"gui/{os.getuid()}/app.saqi.rig.collect")
    (home / "Library/LaunchAgents/app.saqi.rig.collect.plist").unlink(missing_ok=True)
    build_extension(root, home, node)
    atomic_write(launcher, script, 0o700)
    atomic_write(registration, manifest, 0o600)
    print("Native bridge verified and installed. Background translation is unchanged.")
    print("In your personal Chrome, open chrome://extensions, enable Developer mode, and Load unpacked:")
    print(home / "Library/Application Support/Saqi/extension")
    print("If already loaded, click Reload. Open the Saqi popup and select Start collection or Resume.")
    print("Bridge installation alone does not verify Chrome connection. The popup must confirm it.")


def doctor(root=ROOT, home=None):
    home = home or Path.home()
    node = preflight(root)
    state, launcher, registration = paths(home)
    script, manifest = configuration(root, home, node)
    if not launcher.exists() or launcher.read_text() != script or not registration.exists() or registration.read_text() != manifest:
        raise RuntimeError("Bridge paths/registration are missing or stale. Rerun this command with install.")
    print("PASS: Node, built source parser, credentials, read-only API access, protocol, and registration.")
    snapshot = state / "collector-status.json"
    if snapshot.exists():
        from datetime import datetime, timezone
        try:
            status = json.loads(snapshot.read_text())
            if not isinstance(status, dict):
                raise ValueError("Invalid saved status")
            seen = status.get("seenAt")
            fresh = False
            if seen is not None:
                if not isinstance(seen, str):
                    raise ValueError("Invalid saved timestamp")
                timestamp = datetime.fromisoformat(seen.replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError("Missing saved timezone")
                age = (datetime.now(timezone.utc) - timestamp).total_seconds()
                fresh = 0 <= age < 150
        except (OSError, ValueError):
            print("Chrome status could not be read. Load/reload the extension and open its popup to refresh it. The saved file was preserved.")
            return
        print(f"Chrome: {'connected' if fresh else 'disconnected'}; last state: {status.get('state', 'unknown')}")
    else:
        print("Chrome connection not verified. Load/reload the extension and open its popup.")


def uninstall(home=None):
    _, launcher, registration = paths(home or Path.home())
    registration.unlink(missing_ok=True)
    launcher.unlink(missing_ok=True)
    print("Native bridge removed. Remove the Saqi extension manually in Chrome.")
    print("Keychain credentials, background translation, pending results, and corpus data are preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=["install", "doctor", "uninstall"], default="install")
    args = parser.parse_args()
    try:
        {"install": install, "doctor": doctor, "uninstall": uninstall}[args.command]()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Never print subprocess stdout/stderr, which can include authentication material.
        print(f"Setup needs attention: {error if isinstance(error, RuntimeError) else 'A prerequisite check failed; verify Node and build dependencies.'}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
