#!/usr/bin/env python3

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import statistics
import subprocess

BUSY_STATES = frozenset({"active", "activating", "deactivating", "reloading"})


def publication_history(records, now):
    history = {"starts": {}, "completed": {}, "failures": 0}
    for record in records:
        timestamp = datetime.fromtimestamp(int(record["__REALTIME_TIMESTAMP"]) / 1_000_000, timezone.utc)
        if timestamp > now or timestamp < now - timedelta(hours=24):
            continue
        message = record.get("MESSAGE", "")
        match = re.fullmatch(r"Translating ([0-9a-f-]+): (\d+) Arabic lines \(([^)]+)\)", message)
        if match:
            invocation = {"poemId": match[1], "arabicLines": int(match[2]), "model": match[3], "startedAt": timestamp}
            history["starts"][match[1]] = invocation
        if re.fullmatch(r"Published [0-9a-f-]+(?: \(cache purge pending\))?", message):
            history["completed"][message.split()[1]] = timestamp
        if timestamp >= now - timedelta(minutes=20) and "Failed with result" in message:
            history["failures"] += 1
    return history


def completion_metrics(history, now):
    starts = history["starts"]
    completed = history["completed"]
    recent = [poem_id for poem_id, timestamp in completed.items() if timestamp >= now - timedelta(minutes=20)]
    hourly = [poem_id for poem_id, timestamp in completed.items() if timestamp >= now - timedelta(hours=1)]
    durations = [(completed[poem_id] - starts[poem_id]["startedAt"]).total_seconds() for poem_id in hourly if poem_id in starts]
    return {
        "publishedLast20Minutes": len(recent),
        "publishedLastHour": len(hourly),
        "publishedLast24Hours": len(completed),
        "arabicLinesPublishedLastHour": sum(starts[poem_id]["arabicLines"] for poem_id in hourly if poem_id in starts),
        "medianGenerationAndPublicationSecondsLastHour": round(statistics.median(durations), 1) if durations else None,
        "lastPublishedAt": max(completed.values()).isoformat() if completed else None,
    }


def summarize(records, now, pool, login="inactive", snapshot=None, quota=None, quota_timer="inactive"):
    history = publication_history(records, now)
    active, issues = pool_health(pool, snapshot, now)
    if history["failures"]:
        issues.append("translation service failures in the last 20 minutes")
    if pool == "failed":
        issues.append("translation pool is failed")
    status = "busy" if pool in BUSY_STATES else "idle"
    pool_snapshot = snapshot or {}
    if login in BUSY_STATES or pool == "deactivating" or pool_snapshot.get("stopping"):
        status = "maintenance"
    quota_snapshot = quota or {}
    checked = quota_snapshot.get("checkedAt")
    quota_fresh = checked and timedelta(0) <= now - datetime.fromisoformat(checked) <= timedelta(minutes=10)
    if quota_timer == "active" and pool == "inactive" and login not in BUSY_STATES:
        if quota_fresh and quota_snapshot.get("status") == "waiting_for_quota" and quota_snapshot.get("quota", {}).get("available") is False:
            status = "waiting_for_quota"
        else:
            issues.append("translation pool is not active")
    return {
        "checkedAt": now.isoformat(),
        "status": "attention" if issues else status,
        "issues": issues,
        **completion_metrics(history, now),
        "loginActivation": login,
        "poolService": pool,
        "poolConcurrency": pool_snapshot.get("concurrency"),
        "cacheMaintenanceError": pool_snapshot.get("cacheMaintenanceError"),
        "poolDraining": pool in BUSY_STATES and bool(pool_snapshot.get("stopping")),
        "activePoolPoems": active,
        "pausedWorkers": pool_snapshot.get("pausedWorkers", []),
        "quota": quota_snapshot.get("quota"),
        "quotaWatcherTimer": quota_timer,
        "automaticResume": bool(quota_timer == "active" and quota_fresh and quota_snapshot.get("automaticResume", False)),
        "interruptedPoemsAwaitingQuota": len(quota_snapshot.get("pending", [])),
    }


def pool_health(pool, snapshot, now):
    if pool not in BUSY_STATES:
        return [], []
    if not snapshot:
        return [], ["translation pool snapshot is missing"]
    active = []
    for invocation in snapshot.get("activePoems", []):
        started = datetime.fromisoformat(invocation["startedAt"])
        active.append({**invocation, "elapsedMinutes": round((now - started).total_seconds() / 60, 1)})
    issues = []
    if now - datetime.fromisoformat(snapshot["checkedAt"]) > timedelta(seconds=60):
        issues.append("translation pool snapshot is stale")
    if any(item["elapsedMinutes"] >= 60 for item in active):
        issues.append("a pool poem has been running for at least 60 minutes; inspect before retrying")
    if snapshot.get("cacheMaintenanceError"):
        issues.append("public cache maintenance requires recovery; inspect pending purges")
    if snapshot.get("pausedWorkers"):
        issues.append("translation workers require recovery; inspect their metadata")
    return active, issues


def unit_state(unit):
    return subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "--value"], text=True).strip()


def journal_records(now):
    # Stream one record at a time: a day's logs must not compete with the pool
    # for the 1 GiB VM's memory. Filter unrelated diagnostics before JSON
    # serialization and stop at the snapshot time while paid work continues.
    command = ["journalctl", "-u", "saqi-translate-standard.service", "-u", "saqi-publication-repair.service", "--since", (now - timedelta(hours=24)).isoformat(), "--until", now.isoformat(), "--grep", r"^(Translating |Published )|Failed with result", "-o", "json", "--output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_UNIT,MESSAGE", "--no-pager"]
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as journal:
        for line in journal.stdout:
            yield json.loads(line)
        returncode = journal.wait()
        if returncode:
            raise subprocess.CalledProcessError(returncode, command)


def main():
    now = datetime.now(timezone.utc)
    standard_state = unit_state("saqi-translate-standard.service")
    quota_timer = unit_state("saqi-translation-quota.timer")
    directory = Path("/home/saqi/.local/state/saqi/results-standard")
    quota_path = directory / "quota-health.json"
    snapshot_path = directory / "pool-health.json"
    report = summarize(
        journal_records(now), now, standard_state,
        login=unit_state("saqi-codex-login.service"),
        snapshot=json.loads(snapshot_path.read_text()) if snapshot_path.exists() else None,
        quota=json.loads(quota_path.read_text()) if quota_path.exists() else None,
        quota_timer=quota_timer,
    )
    print(json.dumps(report), flush=True)
    if report["issues"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
