#!/usr/bin/env python3
"""Copy canonical poems in bounded batches before the atomic slim-table swap.

This one-time upgrade helper targets the approved production D1 only. All schema
changes use Wrangler's migration ledger. Re-running safely resumes preparation;
0073 refuses to swap unless every retained value matches, with zero extra rows.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import time
import urllib.error
import urllib.request

SCRIPT = pathlib.Path(__file__).with_name("archive-production-d1.py")
SPEC = importlib.util.spec_from_file_location("archive", SCRIPT)
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)
ACCOUNT_ID = "58e48987bbd8d9c3f50510f0ab7766b6"
BATCH_SIZE = 500


def copy_poems(query):
    columns = [row["name"] for row in query("PRAGMA table_info(_poem_next)")]
    if not columns:
        return 0
    if len(columns) != 28 or "id" not in columns or any(
        re.fullmatch(r"[a-z_]+", name) is None for name in columns
    ):
        raise RuntimeError("Unexpected staged poem schema")
    names = ",".join('"' + name + '"' for name in columns)
    updates = ",".join('"' + name + '"=excluded."' + name + '"' for name in columns if name != "id")
    cursor = None
    copied = 0
    while True:
        rows = query(
            "SELECT id FROM poem WHERE (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2",
            [cursor, BATCH_SIZE],
        )
        if not rows:
            break
        last = rows[-1]["id"]
        query(
            f"INSERT INTO _poem_next ({names}) SELECT {names} FROM poem "
            "WHERE (?1 IS NULL OR id>?1) AND id<=?2 "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            [cursor, last],
        )
        cursor = last
        copied += len(rows)
        print(json.dumps({"canonical_poems_copied": copied}), flush=True)
    return copied


class D1Query:
    def __init__(self):
        self.token = None
        self.refreshed_at = 0

    def __call__(self, sql, params=None):
        if self.token is None or time.monotonic() - self.refreshed_at > 60:
            self.token = os.environ.get("CLOUDFLARE_API_TOKEN") or json.loads(
                ARCHIVE.wrangler("auth", "token", "--json", capture=True)
            )["token"]
            self.refreshed_at = time.monotonic()
        request = urllib.request.Request(
            f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{ARCHIVE.DATABASE_ID}/query",
            data=json.dumps({"sql": sql, "params": params or []}).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"D1 query failed with HTTP {error.code}; rerun to resume") from None
        if not body.get("success") or not all(item.get("success") for item in body.get("result", [])):
            raise RuntimeError("D1 query failed; rerun to resume")
        return body["result"][0]["results"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--archive-manifest", required=True)
    args = parser.parse_args()
    if not args.execute:
        parser.error("Use --execute only with collection and translation stopped")
    if os.environ.get("SAQI_RIG_ACTIVE") == "1" or os.environ.get("SAQI_DIRECT_SOURCE_ACTIVE") == "1":
        parser.error("Stop collection and translation before contraction")
    if not re.fullmatch(r"saqi-corpus-archive/d1/[A-Za-z0-9-]+/manifest.json", args.archive_manifest):
        parser.error("Expected a private corpus archive manifest key")
    ARCHIVE.verify_database_identity()
    with tempfile.TemporaryDirectory(prefix="saqi-contraction-") as temporary:
        directory = pathlib.Path(temporary)
        path = directory / "manifest.json"
        ARCHIVE.wrangler("r2", "object", "get", args.archive_manifest, "--remote", "--file", str(path))
        manifest = json.loads(path.read_text())
        if manifest.get("database_id") != ARCHIVE.DATABASE_ID or manifest.get("format") != "saqi.d1-sql-gzip-parts.v1":
            raise RuntimeError("Unexpected archive manifest")
        if ARCHIVE.counts() != manifest["counts"] or manifest["counts"]["fk_errors"] != 0:
            raise RuntimeError("Canonical counts changed since the archive")
        config = directory / "wrangler.json"
        config.write_text(json.dumps({
            "name": "saqi-contraction", "account_id": ACCOUNT_ID,
            "d1_databases": [{
                "binding": "DB", "database_name": "saqi-db", "database_id": ARCHIVE.DATABASE_ID,
                "migrations_dir": str(ARCHIVE.OPERATIONS / "migrations"),
                "migrations_pattern": str(ARCHIVE.OPERATIONS / "migrations/007[12]_*.sql"),
            }],
        }))
        ARCHIVE.wrangler("d1", "migrations", "apply", "saqi-db", "--remote", "--config", str(config))
        copied = copy_poems(D1Query())
        ARCHIVE.wrangler("d1", "migrations", "apply", "saqi-db", "--remote")
        if ARCHIVE.counts() != manifest["counts"]:
            raise RuntimeError("Canonical counts changed during contraction")
        print(json.dumps({"contraction": "complete", "copied": copied, "counts": manifest["counts"]}), flush=True)


if __name__ == "__main__":
    main()
