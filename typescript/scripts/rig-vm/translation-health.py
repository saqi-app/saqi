#!/usr/bin/env python3

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import statistics
import subprocess

BUSY_STATES = {"active", "activating", "deactivating", "reloading"}


def publication_history(records, now):
    history = {"starts": {}, "completed": {}, "failures": 0, "latest": None}
    for record in records:
        timestamp = datetime.fromtimestamp(int(record["__REALTIME_TIMESTAMP"]) / 1_000_000, timezone.utc)
        message = record.get("MESSAGE", "")
        match = re.fullmatch(r"Translating ([0-9a-f-]+): (\d+) Arabic lines \(([^)]+)\)", message)
        if match:
            invocation = {"poemId": match[1], "arabicLines": int(match[2]), "model": match[3], "startedAt": timestamp}
            if record.get("_SYSTEMD_UNIT") != "saqi-translate-pool.service":
                history["latest"] = invocation
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


def current_invocation(latest, now, service):
    if service not in BUSY_STATES or latest is None:
        return None
    return {**latest, "startedAt": latest["startedAt"].isoformat(), "elapsedMinutes": round((now - latest["startedAt"]).total_seconds() / 60, 1)}


def flow_health(current, failures, units):
    issues = []
    if failures:
        issues.append("translation service failures in the last 20 minutes")
    if current is not None and current["elapsedMinutes"] >= 60:
        issues.append("current poem has been running for at least 60 minutes; inspect before retrying")
    if units["timer"] != "active" and units["login"] not in BUSY_STATES and units.get("pool") not in BUSY_STATES:
        issues.append("translation timer is not active")
    if units.get("pool") == "failed":
        issues.append("translation pool is failed")
    if units["service"] == "failed":
        issues.append("translation service is failed")
    if issues:
        return "attention", issues
    if units["login"] in BUSY_STATES or units.get("pool") == "deactivating":
        return "maintenance", issues
    if units["service"] in BUSY_STATES or units.get("pool") in BUSY_STATES:
        return "busy", issues
    return "idle", issues


def summarize(records, now, service, timer, login, pool="inactive", snapshot=None):
    history = publication_history(records, now)
    current = current_invocation(history["latest"], now, service)
    status, issues = flow_health(current, history["failures"], {"service": service, "timer": timer, "login": login, "pool": pool})
    active, pool_issues = pool_health(pool, snapshot, now)
    issues.extend(pool_issues)
    if issues:
        status = "attention"
    pool_snapshot = snapshot or {}
    return {
        "checkedAt": now.isoformat(),
        "status": status,
        "issues": issues,
        **completion_metrics(history, now),
        "currentPoem": current,
        "translationService": service,
        "translationTimer": timer,
        "loginActivation": login,
        "poolService": pool,
        "poolConcurrency": pool_snapshot.get("concurrency"),
        "cacheMaintenanceError": pool_snapshot.get("cacheMaintenanceError"),
        "poolDraining": pool == "deactivating" and bool(pool_snapshot.get("stopping")),
        "activePoolPoems": active,
        "pausedWorkers": pool_snapshot.get("pausedWorkers", []),
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


def main():
    now = datetime.now(timezone.utc)
    journal = subprocess.check_output(["journalctl", "-u", "saqi-translate.service", "-u", "saqi-translate-pool.service", "-u", "saqi-publication-repair.service", "--since", (now - timedelta(hours=24)).isoformat(), "-o", "json", "--no-pager"], text=True)
    snapshot_path = Path("/home/saqi/.local/state/saqi/results/pool-health.json")
    snapshot = json.loads(snapshot_path.read_text()) if snapshot_path.exists() else None
    report = summarize(
        [json.loads(line) for line in journal.splitlines()],
        now,
        unit_state("saqi-translate.service"),
        unit_state("saqi-translate.timer"),
        unit_state("saqi-codex-login.service"),
        unit_state("saqi-translate-pool.service"),
        snapshot,
    )
    print(json.dumps(report), flush=True)
    if report["issues"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
