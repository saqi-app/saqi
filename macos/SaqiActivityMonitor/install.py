#!/usr/bin/env python3
import os
import pathlib
import plistlib
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[2]
app = pathlib.Path.home() / "Applications/Saqi Activity Monitor.app"
contents = app / "Contents"
binary = contents / "MacOS/SaqiActivityMonitor"
label = "app.saqi.monitor"
domain = f"gui/{os.getuid()}"
subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True)
# Allow launchd to finish unregistering the old job before replacing the bundle.
for _ in range(30):
    if subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True).returncode != 0:
        break
    time.sleep(0.1)
binary.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="saqi-monitor-build-") as cache:
    subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors",
                    str(root / "macos/SaqiActivityMonitor/main.swift"), "-o", str(binary),
                    "-module-cache-path", cache], check=True)
(contents / "Info.plist").write_bytes(plistlib.dumps({
    "CFBundleIdentifier": "app.saqi.ActivityMonitor",
    "CFBundleName": "Saqi Activity Monitor",
    "CFBundleExecutable": "SaqiActivityMonitor",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "2.0",
    "LSUIElement": True,
    "SaqiRepository": str(root),
}))
subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
plist = pathlib.Path.home() / f"Library/LaunchAgents/{label}.plist"
plist.parent.mkdir(parents=True, exist_ok=True)
plist.write_bytes(plistlib.dumps({"Label": label, "ProgramArguments": [str(binary)],
                                 "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10}))
plist.chmod(0o600)
subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
print(f"Installed {app}")
