#!/usr/bin/env python3
"""Import a private corpus archive into a disposable D1 and compare every row.

Restore uses bounded batches in foreign-key dependency order, with bound
parameters for rows above D1's SQL text limit. Production is never the destination.
All local files and the disposable D1 are removed.
"""

import argparse
import contextlib
import importlib.util
import json
import pathlib
import re
import sqlite3
import subprocess
import tempfile
import time
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
TOKEN: dict[str, object] = {"value": None, "expires": 0.0}
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


def wrangler(*args: str) -> str:
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
            "D1_RESET_DO", "FOREIGN KEY constraint failed", "Statement too long",
            "SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_BUSY",
        ) if code in diagnostic]
        raise RuntimeError(
            f"Wrangler {args[0]} failed ({error.returncode}); "
            f"output_bytes={len(diagnostic)}; known_errors={known}"
        ) from None


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
        for table in ready:
            ordered.append(table)
            del dependencies[table]
    return ordered


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
                layout = table_layout(database, table)
                columns = layout.columns
                names = ",".join(f'"{column}"' for column in columns)
                deferred = DEFERRED_COLUMNS.get(table, set()) & set(columns)
                for row in database.execute(f'SELECT {names} FROM "{table}"'):
                    values = [None if column in deferred else row[column] for column in columns]
                    sql = f'INSERT INTO "{table}" ({names}) VALUES (' + ",".join(map(sql_literal, values)) + ")"
                    if len(sql.encode("utf-8")) + 2 <= RESTORE.D1_MAX_STATEMENT_BYTES:
                        append(sql)
                    else:
                        if table not in {"poem", "model_enrichment_artifact"} or columns[0] != "id":
                            raise RuntimeError("Oversized SQL statement needs a reviewed bound-import rule")
                        flush()
                        placeholders = ",".join("?" for _ in columns)
                        steps.append(BoundInsert(table, row["id"], f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})', values))
                flush()
            # Restore the two nullable cycle edges before installing any triggers.
            for table, candidates in DEFERRED_COLUMNS.items():
                if table not in tables:
                    continue
                columns = candidates & set(table_layout(database, table).columns)
                for column in sorted(columns):
                    for row in database.execute(f'SELECT id,"{column}" FROM "{table}" WHERE "{column}" IS NOT NULL'):
                        append(f'UPDATE "{table}" SET "{column}"={sql_literal(row[column])} WHERE id={sql_literal(row["id"])}')
            flush()
            for row in database.execute("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"):
                append(row[0])
    finally:
        flush()
    return steps


def d1_query(database_id: str, sql: str, params: list[object] | None = None, *, retry: bool = True):
    if database_id == PRODUCTION_DATABASE_ID:
        raise RuntimeError("Refusing to query production through the disposable restore client")
    if TOKEN["value"] is None or time.monotonic() >= TOKEN["expires"]:
        TOKEN["value"] = json.loads(wrangler("auth", "token", "--json"))["token"]
        TOKEN["expires"] = time.monotonic() + 1200
    body: dict[str, object] = {"sql": sql}
    if params is not None:
        body["params"] = params
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{database_id}/query",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {TOKEN['value']}", "Content-Type": "application/json"},
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


def archived_tables(source: sqlite3.Connection, database_id: str) -> list[str]:
    tables = [row[0] for row in source.execute(TABLES_SQL)]
    if any(re.fullmatch(r"[a-z][a-z0-9_]*", table) is None for table in tables):
        raise RuntimeError("Archive contains an unexpected table identifier")
    remote = d1_query(database_id, TABLES_SQL)
    if [row["name"] for row in remote] != tables:
        raise RuntimeError("Disposable D1 table inventory differs from archive")
    return tables


def table_layout(source: sqlite3.Connection, table: str) -> TableLayout:
    info = source.execute(f"PRAGMA table_info({table})").fetchall()
    columns = [row[1] for row in info]
    if any(re.fullmatch(r"[a-z][a-z0-9_]*", column) is None for column in columns):
        raise RuntimeError(f"Unexpected {table} column identifier")
    primary_key = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    return TableLayout(columns, primary_key)


def assert_page_equal(
    table: str, columns: list[str], primary_key: list[str],
    remote: list[dict], originals: list[sqlite3.Row]
) -> None:
    for row, original in zip(remote, originals, strict=True):
        if any(row.get(column) != original[column] for column in columns):
            key = {column: original[column] for column in primary_key}
            raise RuntimeError(f"Disposable D1 differs from archive in {table} row {key}")


def verified_table_count(source: sqlite3.Connection, database_id: str, table: str) -> int:
    expected = source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
    remote_count = d1_query(database_id, f'SELECT count(*) AS rows FROM "{table}"')
    if remote_count != [{"rows": expected}]:
        raise RuntimeError(f"Disposable D1 {table} count mismatch")
    return expected


def compare_table(source: sqlite3.Connection, database_id: str, table: str) -> int:
    expected = verified_table_count(source, database_id, table)
    layout = table_layout(source, table)
    columns, primary_key = layout.columns, layout.primary_key
    if not primary_key:
        if expected:
            raise RuntimeError(f"Cannot compare {table} without a primary key")
        return 0
    projection = ",".join(f'"{column}"' for column in columns)
    order = ",".join(f'"{column}"' for column in primary_key)
    question_marks = ",".join("?" for _ in primary_key)
    source_rows = source.execute(f'SELECT {projection} FROM "{table}" ORDER BY {order}')
    cursor: list[str] | None = None
    checked = 0
    while True:
        where = f"WHERE ({order}) > ({question_marks}) " if cursor is not None else ""
        rows = d1_query(
            database_id,
            f'SELECT {projection} FROM "{table}" {where}ORDER BY {order} LIMIT 25',
            cursor,
        )
        if not rows:
            break
        assert_page_equal(table, columns, primary_key, rows, source_rows.fetchmany(len(rows)))
        checked += len(rows)
        if any(rows[-1][column] is None for column in primary_key):
            raise RuntimeError(f"Null primary key in {table}")
        cursor = [str(rows[-1][column]) for column in primary_key]
        if checked % 1000 < len(rows):
            print(json.dumps({"table": table, "rows_checked": checked}), flush=True)
    if checked != expected:
        raise RuntimeError(f"Disposable D1 {table} count mismatch: {checked} != {expected}")
    return checked


def compare_rows(restored: pathlib.Path, database_id: str) -> dict[str, int]:
    with contextlib.closing(sqlite3.connect(f"file:{restored}?mode=ro", uri=True)) as source:
        source.row_factory = sqlite3.Row
        counts = {
            table: compare_table(source, database_id, table)
            for table in archived_tables(source, database_id)
        }
    fk = d1_query(database_id, "SELECT count(*) AS errors FROM pragma_foreign_key_check")
    if fk != [{"errors": 0}]:
        raise RuntimeError("Disposable D1 has foreign-key errors")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-key", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    key = args.manifest_key
    if not args.execute:
        parser.error("Pass --execute to create and remove a disposable D1")
    if not key.startswith(f"{RESTORE.BUCKET}/d1/") or not key.endswith("/manifest.json"):
        parser.error("Expected a private saqi-corpus-archive/d1/.../manifest.json key")
    name = f"saqi-restore-rehearsal-{uuid.uuid4().hex[:12]}"
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
                    wrangler("d1", "execute", name, "--remote", "--file", str(step), "--yes")
                else:
                    d1_query(database_id, step.sql, step.params, retry=False)
            counts = compare_rows(restored, database_id)
            print(json.dumps({"disposable_d1": name, "counts": counts, "d1_import_rehearsal": "passed"}), flush=True)
    finally:
        if created:
            wrangler("d1", "delete", name, "--skip-confirmation")
            print(json.dumps({"disposable_d1": name, "deleted": True}), flush=True)


if __name__ == "__main__":
    main()
