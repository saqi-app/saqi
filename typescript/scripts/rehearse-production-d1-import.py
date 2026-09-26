#!/usr/bin/env python3
"""Import a private corpus archive into a disposable D1 and compare every row.

Restore uses bounded batches in foreign-key dependency order, with bound
parameters for rows above D1's SQL text limit. Production is never the destination.
All local files and the disposable D1 are removed.
"""

import argparse
import contextlib
import datetime
import gzip
import importlib.util
import json
import itertools
import pathlib
import os
import re
import sqlite3
import shutil
import subprocess
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass


RESTORE_SCRIPT = pathlib.Path(__file__).with_name("rehearse-production-d1-restore.py")
SPEC = importlib.util.spec_from_file_location("saqi_restore_rehearsal", RESTORE_SCRIPT)
RESTORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESTORE)

ACCOUNT_ID = "58e48987bbd8d9c3f50510f0ab7766b6"
PRODUCTION_DATABASE_ID = RESTORE.DATABASE_ID
TRANSIENT_HTTP_STATUSES = {429, 500, 502, 503, 504}
MAX_QUERY_ATTEMPTS = 7


@dataclass(frozen=True)
class BoundInsert:
    table: str
    row_id: str
    sql: str
    params: list[object]


@dataclass(frozen=True)
class TableLayout:
    columns: list[str]
    primary_key: list[str]


def wait_for_oauth_window() -> None:
    # This personal Mac uses Wrangler's default OAuth profile. API tokens have
    # no local expiry. Do not begin a bulk request just before OAuth expires:
    # Wrangler only refreshes an expired token when the next command starts.
    # A slow bulk request outlasted the former two-minute margin in rehearsal.
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        return
    config = pathlib.Path.home() / "Library/Preferences/.wrangler/config/default.toml"
    if not config.exists():
        return
    expiration = tomllib.loads(config.read_text()).get("expiration_time")
    if not expiration:
        return
    deadline = datetime.datetime.fromisoformat(expiration).timestamp()
    remaining = deadline - time.time()
    while 0 < remaining < 900:
        print(json.dumps({"waiting_for_oauth_refresh_seconds": round(remaining + 2)}), flush=True)
        time.sleep(min(remaining + 2, 30))
        remaining = deadline - time.time()


def wrangler(*args: str) -> str:
    wait_for_oauth_window()
    try:
        return subprocess.run(
            ["yarn", "wrangler", *args],
            cwd=RESTORE.OPERATIONS,
            check=True,
            text=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError as error:
        diagnostic = (error.stderr or "") + "\n" + (error.stdout or "")
        # Never echo SQL, response payloads, credentials, or signed upload URLs.
        known = [code for code in (
            "D1_RESET_DO", "Authentication error", "FOREIGN KEY constraint failed", "Statement too long",
            "SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_BUSY", "fetch failed",
            "connectivity issue", "ECONNRESET", "ETIMEDOUT",
        ) if code in diagnostic]
        raise RuntimeError(
            f"Wrangler {args[0]} failed ({error.returncode}); "
            f"output_bytes={len(diagnostic)}; known_errors={known}"
        ) from None


def import_batch(name: str, path: pathlib.Path) -> None:
    if re.fullmatch(r"saqi-restore-rehearsal-[0-9a-f]{12}", name) is None:
        raise RuntimeError("Refusing to import into a non-disposable database")
    # Only generated data batches are repeatable. Triggers are installed last,
    # after every data batch finishes. Conflict handling preserves the first
    # inserted row; the final exhaustive comparison rejects any wrong value.
    prefix = path.read_bytes()[:32]
    repeatable = prefix.startswith((b'INSERT INTO ', b'UPDATE '))
    for attempt in range(4):
        try:
            wrangler("d1", "execute", name, "--remote", "--file", str(path), "--yes")
            return
        except RuntimeError as error:
            transient = any(marker in str(error) for marker in (
                "fetch failed", "connectivity issue", "ECONNRESET", "ETIMEDOUT",
                "D1_RESET_DO", "Authentication error",
            ))
            if not repeatable or not transient or attempt == 3:
                raise
            print(json.dumps({"retrying_disposable_data_batch": path.name, "attempt": attempt + 2}), flush=True)
            time.sleep(min(2 ** attempt, 4))


MAX_IMPORT_BYTES = 8_000_000
DEFERRED_COLUMNS = {
    "poem": {"active_source_revision_id"},
    "source_poem_identity": {"current_revision_id"},
}


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        if "\x00" in value:
            return "CAST(X'" + value.encode("utf-8").hex() + "' AS TEXT)"
        return "'" + value.replace("'", "''") + "'"
    raise RuntimeError("Unsupported archived value type")


def restore_table_order(database: sqlite3.Connection, tables: list[str]) -> list[str]:
    dependencies = {
        table: {
            row[2] for row in database.execute(f'PRAGMA foreign_key_list("{table}")')
            if row[3] not in DEFERRED_COLUMNS.get(table, set())
        }
        for table in tables
    }
    ordered: list[str] = []
    while dependencies:
        ready = sorted(table for table, parents in dependencies.items() if parents <= set(ordered))
        if not ready:
            raise RuntimeError("Archive has an unreviewed foreign-key cycle")
        ordered.extend(ready)
        dependencies = {table: parents for table, parents in dependencies.items() if table not in ready}
    return ordered


def table_inserts(database: sqlite3.Connection, table: str):
    columns = table_layout(database, table).columns
    names = ",".join(f'"{column}"' for column in columns)
    deferred = DEFERRED_COLUMNS.get(table, set()) & set(columns)
    for row in database.execute(f'SELECT {names} FROM "{table}"'):
        values = [None if column in deferred else row[column] for column in columns]
        sql = f'INSERT INTO "{table}" ({names}) VALUES (' + ",".join(map(sql_literal, values)) + ")"
        if len(sql.encode("utf-8")) + 2 <= RESTORE.D1_MAX_STATEMENT_BYTES:
            yield sql + " ON CONFLICT DO NOTHING"
            continue
        if table not in {"poem", "model_enrichment_artifact"} or columns[0] != "id":
            raise RuntimeError("Oversized SQL statement needs a reviewed bound-import rule")
        placeholders = ",".join("?" for _ in columns)
        yield BoundInsert(table, row["id"], f'INSERT INTO "{table}" ({names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING', values)


def restore_cycle_updates(database: sqlite3.Connection, tables: list[str]):
    for table in sorted(set(DEFERRED_COLUMNS) & set(tables)):
        columns = DEFERRED_COLUMNS[table] & set(table_layout(database, table).columns)
        for column in sorted(columns):
            for row in database.execute(f'SELECT id,"{column}" FROM "{table}" WHERE "{column}" IS NOT NULL'):
                yield f'UPDATE "{table}" SET "{column}"={sql_literal(row[column])} WHERE id={sql_literal(row["id"])}'


def portable_import_plan(
    restored: pathlib.Path, directory: pathlib.Path
) -> list[pathlib.Path | BoundInsert]:
    # The caller has already verified the raw archive and replayed it into SQLite.
    # Generate bounded batches from that verified copy, with all parent rows first.
    steps: list[pathlib.Path | BoundInsert] = []
    output = None
    size = 0
    number = 0

    def flush() -> None:
        nonlocal output, size
        if output is not None:
            output.close()
            output = None
        size = 0

    def append(sql: str) -> None:
        nonlocal output, size, number
        data = (sql.rstrip(";\n") + ";\n").encode("utf-8")
        if len(data) > RESTORE.D1_MAX_STATEMENT_BYTES:
            raise RuntimeError("Generated restore statement exceeds D1 text limit")
        if size + len(data) > MAX_IMPORT_BYTES:
            flush()
        if output is None:
            number += 1
            path = directory / f"portable-{number:04d}.sql"
            steps.append(path)
            output = path.open("wb")
        output.write(data)
        size += len(data)

    try:
        with contextlib.closing(sqlite3.connect(f"file:{restored}?mode=ro", uri=True)) as database:
            database.row_factory = sqlite3.Row
            tables = [row[0] for row in database.execute(TABLES_SQL)]
            if any(re.fullmatch(r"[a-z][a-z0-9_]*", table) is None for table in tables):
                raise RuntimeError("Unexpected archive table identifier")
            ordered = restore_table_order(database, tables)
            for table in ordered:
                append(database.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0])
            flush()
            for table in ordered:
                for statement in table_inserts(database, table):
                    if isinstance(statement, BoundInsert):
                        flush()
                        steps.append(statement)
                    else:
                        append(statement)
                flush()
            # Restore the two nullable cycle edges before installing any triggers.
            for statement in restore_cycle_updates(database, tables):
                append(statement)
            flush()
            for row in database.execute("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"):
                append(row[0])
    finally:
        flush()
    return steps


def d1_query(database_id: str, sql: str, params: list[object] | None = None, *, retry: bool = True):
    if database_id == PRODUCTION_DATABASE_ID:
        raise RuntimeError("Refusing to query production through the disposable restore client")
    token = json.loads(wrangler("auth", "token", "--json"))["token"]
    body: dict[str, object] = {"sql": sql}
    if params is not None:
        body["params"] = params
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{database_id}/query",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    for attempt in range(MAX_QUERY_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                result = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if not retry or error.code not in TRANSIENT_HTTP_STATUSES or attempt == MAX_QUERY_ATTEMPTS - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if not retry or attempt == MAX_QUERY_ATTEMPTS - 1:
                raise
        # Read queries can retry; INSERT callers disable ambiguous retries.
        time.sleep(min(0.5 * 2**attempt, 4.0))
    if not result.get("success") or not all(item.get("success") for item in result.get("result", [])):
        raise RuntimeError("Disposable D1 query failed")
    return result["result"][0].get("results", [])


TABLES_SQL = (
    "SELECT name FROM sqlite_master WHERE type = 'table' "
    "AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name"
)


def table_layout(source: sqlite3.Connection, table: str) -> TableLayout:
    info = source.execute(f"PRAGMA table_info({table})").fetchall()
    columns = [row[1] for row in info]
    if any(re.fullmatch(r"[a-z][a-z0-9_]*", column) is None for column in columns):
        raise RuntimeError(f"Unexpected {table} column identifier")
    primary_key = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    return TableLayout(columns, primary_key)


def compare_copies(expected: pathlib.Path, actual: pathlib.Path) -> dict[str, int]:
    schema_sql = (
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY type,name"
    )
    with contextlib.closing(sqlite3.connect(f"file:{expected}?mode=ro", uri=True)) as source, \
         contextlib.closing(sqlite3.connect(f"file:{actual}?mode=ro", uri=True)) as target:
        if source.execute(schema_sql).fetchall() != target.execute(schema_sql).fetchall():
            raise RuntimeError("Disposable D1 schema differs from archive")
        if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("Disposable D1 export failed integrity check")
        if target.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("Disposable D1 export has foreign-key errors")
        counts = {}
        for (table,) in source.execute(TABLES_SQL):
            if re.fullmatch(r"[a-z][a-z0-9_]*", table) is None:
                raise RuntimeError("Unexpected table identifier")
            layout = table_layout(source, table)
            columns = layout.columns
            names = ",".join(f'"{column}"' for column in columns)
            order = ",".join(f'"{column}"' for column in (layout.primary_key or columns))
            query = f'SELECT {names} FROM "{table}" ORDER BY {order}'
            count = 0
            for original, restored in itertools.zip_longest(source.execute(query), target.execute(query)):
                if original != restored:
                    raise RuntimeError(f"Disposable D1 differs from archive in {table}")
                count += 1
            counts[table] = count
            print(json.dumps({"table": table, "rows_checked": count}), flush=True)
        return counts


def compare_export(restored: pathlib.Path, name: str) -> dict[str, int]:
    if re.fullmatch(r"saqi-restore-rehearsal-[0-9a-f]{12}", name) is None:
        raise RuntimeError("Refusing to export a non-disposable database")
    with tempfile.TemporaryDirectory(prefix="saqi-d1-export-parity-") as temporary:
        directory = pathlib.Path(temporary)
        sql = directory / "restored.sql"
        # Capture Wrangler output: an export can print a signed download URL.
        wrangler("d1", "export", name, "--remote", "--output", str(sql))
        compressed = directory / "restored.sql.gz"
        with sql.open("rb") as source, gzip.open(compressed, "wb", compresslevel=1) as target:
            shutil.copyfileobj(source, target)
        sql.unlink()
        actual = directory / "restored.sqlite3"
        RESTORE.restore([compressed], actual)
        return compare_copies(restored, actual)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-key", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--database-name", help="Optional disposable name for CI cleanup")
    args = parser.parse_args()
    key = args.manifest_key
    if not args.execute:
        parser.error("Pass --execute to create and remove a disposable D1")
    if not key.startswith(f"{RESTORE.BUCKET}/d1/") or not key.endswith("/manifest.json"):
        parser.error("Expected a private saqi-corpus-archive/d1/.../manifest.json key")
    name = args.database_name or f"saqi-restore-rehearsal-{uuid.uuid4().hex[:12]}"
    if re.fullmatch(r"saqi-restore-rehearsal-[0-9a-f]{12}", name) is None:
        parser.error("Expected a disposable restore database name")
    created = False
    try:
        with tempfile.TemporaryDirectory(prefix="saqi-d1-import-rehearsal-") as temporary:
            directory = pathlib.Path(temporary)
            manifest_path = directory / "manifest.json"
            RESTORE.download(key, manifest_path)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            RESTORE.verify_manifest(manifest, key)
            parts = []
            for number, item in enumerate(manifest["parts"], 1):
                part = directory / f"part-{number:04d}"
                RESTORE.download(item["key"], part)
                if part.stat().st_size != item["bytes"] or RESTORE.sha256(part) != item["sha256"]:
                    raise RuntimeError(f"Archive part {number} failed its digest")
                parts.append(part)
            restored = directory / "restored.sqlite3"
            digest = RESTORE.restore(parts, restored)
            if digest.size != manifest["sql_bytes"] or digest.sha256 != manifest["sql_sha256"]:
                raise RuntimeError("Archive SQL digest mismatch")
            RESTORE.verify_restored(restored, manifest)
            steps = portable_import_plan(restored, directory)
            output = wrangler("d1", "create", name)
            created = True
            match = re.search(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", output)
            if match is None or match.group() == PRODUCTION_DATABASE_ID:
                raise RuntimeError("Cannot verify disposable D1 identity")
            database_id = match.group()
            bound_count = sum(isinstance(step, BoundInsert) for step in steps)
            print(json.dumps({"disposable_d1": name, "oversized_rows": bound_count}), flush=True)
            for index, step in enumerate(steps, 1):
                print(json.dumps({"import_step": index, "total_steps": len(steps)}), flush=True)
                if isinstance(step, pathlib.Path):
                    import_batch(name, step)
                else:
                    d1_query(database_id, step.sql, step.params, retry=False)
            counts = compare_export(restored, name)
            print(json.dumps({"disposable_d1": name, "counts": counts, "d1_import_rehearsal": "passed"}), flush=True)
    finally:
        if created:
            wrangler("d1", "delete", name, "--skip-confirmation")
            print(json.dumps({"disposable_d1": name, "deleted": True}), flush=True)


if __name__ == "__main__":
    main()
