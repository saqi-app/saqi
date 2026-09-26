#!/usr/bin/env python3
"""Install, stop or inspect the two SQLite-free macOS rig jobs."""
import os
import pathlib
import plistlib
import shlex
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOMAIN = f"gui/{os.getuid()}"
AGENTS = pathlib.Path.home() / "Library/LaunchAgents"
STATE = pathlib.Path.home() / "Library/Application Support/Saqi"
JOBS = {"translate": 30, "collect": 300}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"install", "stop", "status"}:
        raise SystemExit("Usage: rig-background.py install|stop|status")
    action = sys.argv[1]
    if sys.platform != "darwin":
        raise SystemExit("This installer uses macOS launchd")
    if action == "install":
        local = pathlib.Path.home() / ".local"
        os.environ["PATH"] = f"{local / 'share/mise/shims'}:{local / 'bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}"
        node = subprocess.check_output(["node", "-p", "process.execPath"], text=True, cwd=ROOT / "typescript").strip()
        codex = shutil.which("codex")
        if not codex:
            raise SystemExit("codex must be installed and signed in")
        AGENTS.mkdir(parents=True, exist_ok=True)
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    for operation, interval in JOBS.items():
        label = f"app.saqi.rig.{operation}"
        target = f"{DOMAIN}/{label}"
        plist = AGENTS / f"{label}.plist"
        if action == "status":
            subprocess.run(["launchctl", "print", target], check=False)
            continue
        if action == "stop":
            # launchd terminates the process group. Unknown Codex outcomes stay
            # fenced in D1; restarting never silently dispatches another call.
            subprocess.run(["launchctl", "bootout", target], check=False)
            plist.unlink(missing_ok=True)
            continue
        if subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0:
            print(f"{label} already installed; leaving its current task untouched")
            continue
        command = shlex.join([node, str(ROOT / "typescript/scripts/rig-local.mjs"), operation])
        # Keep only the current/last run log, not an append-only local history.
        command = f"exec {command} > {shlex.quote(str(STATE / (operation + '.log')))} 2>&1"
        value = {
            "Label": label,
            "ProgramArguments": ["/bin/sh", "-c", command],
            "WorkingDirectory": str(ROOT),
            "RunAtLoad": True,
            "StartInterval": interval,
            "ProcessType": "Background",
            "EnvironmentVariables": {
                "PATH": f"{pathlib.Path(node).parent}:{pathlib.Path(codex).parent}:/usr/bin:/bin:/usr/sbin:/sbin",
                "SAQI_RIG_ACTIVE": "1",
                "SAQI_BROWSER_PROFILE": str(STATE / "source-browser"),
            },
        }
        plist.write_bytes(plistlib.dumps(value))
        plist.chmod(0o600)
        subprocess.run(["launchctl", "bootstrap", DOMAIN, str(plist)], check=True)
        print(f"Installed {label}; checks every {interval}s without overlapping itself")


if __name__ == "__main__":
    main()
