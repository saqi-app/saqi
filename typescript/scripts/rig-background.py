#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import plistlib
import shlex
import shutil
import subprocess
import sys
from typing import Final

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOMAIN = f"gui/{os.getuid()}"
AGENTS = pathlib.Path.home() / "Library/LaunchAgents"
STATE = pathlib.Path.home() / "Library/Application Support/Saqi"
JOBS: Final[dict[str, int]] = {"translate": 30}


SPEC = importlib.util.spec_from_file_location("saqi_launchctl", pathlib.Path(__file__).with_name("rig_launchctl.py"))
LAUNCHCTL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHCTL)
job_status = LAUNCHCTL.job_status


def prepare_installation():
    local = pathlib.Path.home() / ".local"
    os.environ["PATH"] = f"{local / 'share/mise/shims'}:{local / 'bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}"
    runtime = subprocess.check_output(["node", str(ROOT / "typescript/scripts/rig-node-runtime.ts")],
                                      cwd=ROOT / "typescript", timeout=15).split(b"\0")
    if len(runtime) != 2 or not runtime[1].isdigit() or len(runtime[1]) > 6 or int(runtime[1]) < 24:
        raise SystemExit("Node 24 or newer is required; check its installation.")
    node = runtime[0].decode("utf-8")
    if not pathlib.Path(node).is_absolute():
        raise SystemExit("Node did not report an absolute executable path.")
    codex = shutil.which("codex")
    if not codex:
        raise SystemExit("codex must be installed and signed in")
    AGENTS.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    return node, codex


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"install", "stop", "status"}:
        raise SystemExit("Usage: rig-background.py install|stop|status")
    action = sys.argv[1]
    if sys.platform != "darwin":
        raise SystemExit("This installer uses macOS launchd")
    if action == "install":
        node, codex = prepare_installation()
    for operation, interval in JOBS.items():
        label = f"app.saqi.rig.{operation}"
        target = f"{DOMAIN}/{label}"
        plist = AGENTS / f"{label}.plist"
        if action == "status":
            result = job_status(target)
            if result is not None:
                print(result.stdout, end="")
            else:
                print(f"{label} is stopped")
            continue
        if action == "stop":
            # launchd terminates the process group. Unknown Codex outcomes stay
            # fenced in D1; restarting never silently dispatches another call.
            LAUNCHCTL.stop_job(target)
            plist.unlink(missing_ok=True)
            continue
        if job_status(target) is not None:
            print(f"{label} already installed; leaving its current task untouched")
            continue
        command = shlex.join([node, str(ROOT / "typescript/scripts/rig-local.ts"), operation])
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
            },
        }
        plist.write_bytes(plistlib.dumps(value))
        plist.chmod(0o600)
        subprocess.run(["launchctl", "bootstrap", DOMAIN, str(plist)], check=True)
        print(f"Installed {label}; checks every {interval}s without overlapping itself")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
