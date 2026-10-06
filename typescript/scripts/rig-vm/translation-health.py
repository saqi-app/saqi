#!/usr/bin/env python3
"""Report translation throughput and health without inference or secret reads."""

from datetime import datetime, timedelta, timezone
import json
import re
import statistics
import subprocess

BUSY_STATES = {"active", "activating", "deactivating", "reloading"}


def summarize(records, now, service, timer, login):
    starts = {}
    completed = {}
    failures = 0
    latest = None
    for record in records:
        timestamp = datetime.fromtimestamp(int(record["__REALTIME_TIMESTAMP"]) / 1_000_000, timezone.utc)
        message = record.get("MESSAGE", "")
        match = re.fullmatch(r"Translating ([0-9a-f-]+): (\d+) Arabic lines \(([^)]+)\)", message)
        if match:
            latest = {"poemId": match[1], "arabicLines": int(match[2]), "model": match[3], "startedAt": timestamp}
            starts[match[1]] = latest
        if re.fullmatch(r"Published [0-9a-f-]+", message):
            poem_id = message.split()[1]
            completed[poem_id] = timestamp
        if timestamp >= now - timedelta(minutes=20) and "Failed with result" in message:
            failures += 1

    recent = [poem_id for poem_id, timestamp in completed.items() if timestamp >= now - timedelta(minutes=20)]
    hourly = [poem_id for poem_id, timestamp in completed.items() if timestamp >= now - timedelta(hours=1)]
    durations = [(timestamp - starts[poem_id]["startedAt"]).total_seconds() for poem_id, timestamp in completed.items() if poem_id in starts and timestamp >= now - timedelta(hours=1)]
    current = None
    if service in BUSY_STATES and latest is not None:
        current = {**latest, "startedAt": latest["startedAt"].isoformat(), "elapsedMinutes": round((now - latest["startedAt"]).total_seconds() / 60, 1)}

    issues = []
    if failures:
        issues.append("translation service failures in the last 20 minutes")
    if current is not None and current["elapsedMinutes"] >= 60:
        issues.append("current poem has been running for at least 60 minutes; inspect before retrying")
    if timer != "active" and login not in BUSY_STATES:
        issues.append("translation timer is not active")
    if service == "failed":
        issues.append("translation service is failed")
    status = "attention" if issues else "maintenance" if login in BUSY_STATES else "busy" if service in BUSY_STATES else "idle"
    return {
        "checkedAt": now.isoformat(),
        "status": status,
        "issues": issues,
        "publishedLast20Minutes": len(recent),
        "publishedLastHour": len(hourly),
        "publishedLast24Hours": len(completed),
        "arabicLinesPublishedLastHour": sum(starts[poem_id]["arabicLines"] for poem_id in hourly if poem_id in starts),
        "medianGenerationAndPublicationSecondsLastHour": round(statistics.median(durations), 1) if durations else None,
        "lastPublishedAt": max(completed.values()).isoformat() if completed else None,
        "currentPoem": current,
        "translationService": service,
        "translationTimer": timer,
        "loginActivation": login,
    }


def unit_state(unit):
    return subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "--value"], text=True).strip()


def main():
    now = datetime.now(timezone.utc)
    journal = subprocess.check_output(["journalctl", "-u", "saqi-translate.service", "--since", (now - timedelta(hours=24)).isoformat(), "-o", "json", "--no-pager"], text=True)
    report = summarize(
        [json.loads(line) for line in journal.splitlines()],
        now,
        unit_state("saqi-translate.service"),
        unit_state("saqi-translate.timer"),
        unit_state("saqi-codex-login.service"),
    )
    print(json.dumps(report), flush=True)
    if report["issues"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
