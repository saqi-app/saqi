#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import pathlib
import shlex
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
manifest = json.loads((root / "chrome/saqi-collector/manifest.json").read_text())
digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
identifier = "".join(chr(97 + int(char, 16)) for char in digest)
node = subprocess.check_output(["node", "-p", "process.execPath"], cwd=root / "typescript", text=True).strip()
state = pathlib.Path.home() / "Library/Application Support/Saqi"
state.mkdir(parents=True, exist_ok=True, mode=0o700)
launcher = state / "chrome-host"
launcher.write_text("#!/bin/sh\nexec " + shlex.join([node, str(root / "typescript/scripts/rig-chrome-host.mjs")]) + ' "$@"\n')
launcher.chmod(0o700)
hosts = pathlib.Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
hosts.mkdir(parents=True, exist_ok=True)
(hosts / "app.saqi.collector.json").write_text(json.dumps({
    "name": "app.saqi.collector", "description": "Saqi source-only native bridge",
    "path": str(launcher), "type": "stdio", "allowed_origins": [f"chrome-extension://{identifier}/"],
}, indent=2) + "\n")
# Retire the separate-profile job. The translator continues independently.
subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/app.saqi.rig.collect"], capture_output=True)
(pathlib.Path.home() / "Library/LaunchAgents/app.saqi.rig.collect.plist").unlink(missing_ok=True)
(state / "collect.log").write_text("PERSONAL_CHROME attention\nAwaiting extension installation in personal Chrome\n")
print(f"Native bridge installed for extension {identifier}")
print(f"Load unpacked in personal Chrome: {root / 'chrome/saqi-collector'}")
