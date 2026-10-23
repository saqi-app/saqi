import os
import subprocess
import time


def job_status(target):
    result = subprocess.run(["launchctl", "print", target], capture_output=True,
                            text=True, timeout=10, env={**os.environ, "LC_ALL": "C"})
    if result.returncode == 0:
        return result
    # Apple DTS documents this exact-label unloaded-service diagnostic:
    # https://developer.apple.com/forums/thread/802443
    prefix = f'Could not find service "{target.rsplit("/", 1)[-1]}" in domain for '
    stripped = (line.strip() for line in result.stderr.splitlines())
    diagnostics = [line for line in stripped if line and line != "Bad request."]
    if (result.returncode > 0 and len(diagnostics) == 1
            and diagnostics[0].startswith(prefix) and diagnostics[0][len(prefix):]):
        return None
    raise RuntimeError(f"Could not inspect the launchd job {target}; its startup file was preserved")


def job_loaded(target):
    return job_status(target) is not None


def stop_job(target, known_loaded=False, *, sleeper=lambda interval: time.sleep(interval)):
    if not known_loaded and not job_loaded(target):
        return
    result = subprocess.run(["launchctl", "bootout", target],
                            capture_output=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeError("The launchd job could not stop; its startup and previous files were preserved")
    for _ in range(30):
        if not job_loaded(target):
            return
        sleeper(0.1)
    raise RuntimeError("The launchd job could not stop; its startup and previous files were preserved")
