#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile

LABEL = "app.saqi.monitor"


def exists(path):
    return path.exists() or path.is_symlink()


SPEC = importlib.util.spec_from_file_location(
    "saqi_launchctl", pathlib.Path(__file__).resolve().parents[2] / "typescript/scripts/rig_launchctl.py")
LAUNCHCTL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHCTL)
job_loaded = LAUNCHCTL.job_loaded
stop_job = LAUNCHCTL.stop_job


def copy_entry(source, destination):
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination)


def same_entry(path, identity):
    return identity is not None and exists(path) and os.path.samestat(path.lstat(), identity)


def restore_app(app, previous, staged_identity, original_identity):
    # rename may complete before Python delivers KeyboardInterrupt. Match the
    # staged directory's inode instead of depending on a flag set afterward.
    if same_entry(app, staged_identity):
        app.rename(previous.parent / "replacement.app")
    if exists(previous):
        if exists(app):
            raise RuntimeError("The monitor app path changed during installation; its backup was preserved")
        copy_entry(previous, app)
    elif original_identity is not None:
        if not same_entry(app, original_identity):
            raise RuntimeError("The previous monitor app could not be located; its backup was preserved")
    elif exists(app):
        raise RuntimeError("An unexpected monitor app was preserved for manual recovery")


def restore_plist(plist, previous, changed, original_identity):
    if exists(previous):
        if exists(plist):
            if not changed:
                raise RuntimeError("The monitor startup path changed during installation; its backup was preserved")
            plist.unlink()
        copy_entry(previous, plist)
    elif original_identity is not None:
        if not same_entry(plist, original_identity):
            raise RuntimeError("The previous monitor startup file could not be located; its backup was preserved")
    elif changed and exists(plist):
        plist.unlink()
    elif exists(plist):
        raise RuntimeError("An unexpected monitor startup file was preserved for manual recovery")


def write_launch_agent(path, data):
    descriptor, temporary = tempfile.mkstemp(prefix=".saqi-monitor-plist-", dir=path.parent)
    temporary = pathlib.Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def activate(domain, plist):
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    if not job_loaded(f"{domain}/{LABEL}"):
        raise RuntimeError("The monitor LaunchAgent did not load")


def remove_backup(backup):
    try:
        shutil.rmtree(backup)
    except OSError as error:
        print(f"Monitor backup retained at {backup}: {error}")


def install(home=None, root=None):
    home = pathlib.Path.home() if home is None else pathlib.Path(home)
    root = pathlib.Path(__file__).resolve().parents[2] if root is None else pathlib.Path(root).resolve()
    if not sys.executable or not pathlib.Path(sys.executable).is_absolute():
        raise RuntimeError("Run the monitor installer with an absolute Python executable")
    app = home / "Applications/Saqi Activity Monitor.app"
    plist = home / f"Library/LaunchAgents/{LABEL}.plist"
    domain = f"gui/{os.getuid()}"
    target = f"{domain}/{LABEL}"
    app.parent.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".saqi-monitor-build-", dir=app.parent) as staging:
        staged_app = pathlib.Path(staging) / app.name
        staged_contents = staged_app / "Contents"
        staged_binary = staged_contents / "MacOS/SaqiActivityMonitor"
        staged_binary.parent.mkdir(parents=True)
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-warnings-as-errors",
                        str(root / "macos/SaqiActivityMonitor/CollectorStatus.swift"),
                        str(root / "macos/SaqiActivityMonitor/main.swift"), "-o", str(staged_binary),
                        "-module-cache-path", str(pathlib.Path(staging) / "cache")], check=True)
        (staged_contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "app.saqi.ActivityMonitor", "CFBundleName": "Saqi Activity Monitor",
            "CFBundleExecutable": "SaqiActivityMonitor", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "3.0", "LSUIElement": True, "SaqiRepository": str(root),
            "SaqiPythonExecutable": sys.executable,
        }))
        subprocess.run(["codesign", "--force", "--sign", "-", str(staged_app)], check=True)
        was_loaded = job_loaded(target)
        if was_loaded and (not exists(app) or not exists(plist)):
            raise RuntimeError("The loaded monitor has no complete installation to restore; its files were not replaced")
        original_app = app.lstat() if exists(app) else None
        original_plist = plist.lstat() if exists(plist) else None
        staged_identity = staged_app.lstat()
        # This backup is deliberately outside TemporaryDirectory. Failed rollback
        # must never let staging cleanup delete the previous working application.
        backup = pathlib.Path(tempfile.mkdtemp(prefix=".saqi-monitor-backup-", dir=app.parent))
        old_app = backup / "previous.app"
        old_plist = backup / "previous.plist"
        try:
            stop_job(target, known_loaded=was_loaded)
        except BaseException:
            remove_backup(backup)
            raise
        plist_changed = activation_attempted = False
        try:
            if original_app is not None:
                app.rename(old_app)
            if original_plist is not None:
                plist.rename(old_plist)
            staged_app.rename(app)
            plist_changed = True
            write_launch_agent(plist, plistlib.dumps({
                "Label": LABEL, "ProgramArguments": [str(app / "Contents/MacOS/SaqiActivityMonitor")],
                "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10,
            }))
            activation_attempted = True
            activate(domain, plist)
        except BaseException as installation_error:
            try:
                if activation_attempted:
                    # Even a rejected bootstrap can have partially loaded a
                    # replacement. Failed inspection is not proof it stopped.
                    stop_job(target, known_loaded=True)
                restore_app(app, old_app, staged_identity, original_app)
                restore_plist(plist, old_plist, plist_changed, original_plist)
                if was_loaded:
                    activate(domain, plist)
            except BaseException as rollback_error:
                raise RuntimeError(
                    f"Monitor installation failed ({installation_error}); rollback failed. "
                    f"Previous files are retained at {backup}"
                ) from rollback_error
            remove_backup(backup)
            raise
        remove_backup(backup)
    print(f"Installed {app}. Find Saqi in the menu bar. "
          "Translation and collection continue when you quit the monitor.")
    return app


if __name__ == "__main__":
    install()
