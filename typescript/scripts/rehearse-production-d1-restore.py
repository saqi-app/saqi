#!/usr/bin/env python3
"""Download a private D1 archive and replay it into disposable SQLite.

This is a restore rehearsal, not a production restore. The SQL, compressed
parts, and restored database exist only inside a temporary directory.
"""

import argparse
import contextlib
import gzip
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass


OPERATIONS = pathlib.Path(__file__).resolve().parents[1] / "packages/operations"
BUCKET = "saqi-corpus-archive"
DATABASE_ID = "ffaae610-4dae-4d7e-bf86-8232f46ca2b5"


@dataclass(frozen=True)
class SqlDigest:
    size: int
    sha256: str
    largest_statement_bytes: int
    oversized_statement_count: int


D1_MAX_STATEMENT_BYTES = 100_000
NUL_POLICY_INSERT = b'INSERT INTO "catalog_unsafe_control" ("value") VALUES(\'\x00\');\n'
PORTABLE_NUL_POLICY_INSERT = (
    b'INSERT INTO "catalog_unsafe_control" ("value") VALUES(char(0));\n'
)


def portable_export_line(line: bytes) -> bytes:
    if b"\x00" not in line:
        return line
    if line == NUL_POLICY_INSERT:
        return PORTABLE_NUL_POLICY_INSERT
    raise RuntimeError("Unexpected literal NUL in D1 SQL export")


def download(key: str, destination: pathlib.Path) -> None:
    subprocess.run(
        ["yarn", "wrangler", "r2", "object", "get", key, "--remote", "--file", str(destination)],
        cwd=OPERATIONS,
        check=True,
    )


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_manifest(manifest: dict, manifest_key: str) -> None:
    if manifest.get("format") != "saqi.d1-sql-gzip-parts.v1":
        raise ValueError("Unexpected archive format")
    if manifest.get("database_id") != DATABASE_ID:
        raise ValueError("Archive belongs to another D1 database")
    verify_parts(manifest.get("parts"), manifest_key)
    counts = manifest.get("counts")
    if not isinstance(counts, dict) or any(
        not isinstance(counts.get(key), int) or counts[key] < 0
        for key in ("authors", "poems", "snapshots", "fk_errors")
    ):
        raise ValueError("Invalid archive counts")
    if counts["fk_errors"] != 0:
        raise ValueError("Archived D1 had foreign-key errors")
    if not isinstance(manifest.get("sql_bytes"), int) or manifest["sql_bytes"] < 1:
        raise ValueError("Invalid SQL byte count")
    if not isinstance(manifest.get("sql_sha256"), str) or len(manifest["sql_sha256"]) != 64:
        raise ValueError("Invalid SQL digest")


def verify_parts(parts: object, manifest_key: str) -> None:
    if not isinstance(parts, list) or not parts:
        raise ValueError("Archive has no parts")
    prefix = manifest_key.removesuffix("manifest.json")
    for number, part in enumerate(parts, 1):
        if not isinstance(part, dict):
            raise ValueError("Invalid archive part")
        if part.get("key") != f"{prefix}corpus.sql.gz.part-{number:04d}":
            raise ValueError("Unexpected archive part key")
        if not isinstance(part.get("bytes"), int) or part["bytes"] < 1:
            raise ValueError("Invalid archive part size")
        if not isinstance(part.get("sha256"), str) or len(part["sha256"]) != 64:
            raise ValueError("Invalid archive part digest")


def restore(parts: list[pathlib.Path], database: pathlib.Path) -> SqlDigest:
    process = subprocess.Popen(
        ["sqlite3", "-bail", str(database)],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    digest = hashlib.sha256()
    total = 0
    largest_statement_bytes = 0
    oversized_statement_count = 0
    statement = bytearray()
    try:
        # gzip accepts a seekable file, so join the already verified parts in
        # the same disposable directory. Only compressed bytes are duplicated.
        joined = database.parent / "corpus.sql.gz"
        with joined.open("wb") as output:
            for part in parts:
                with part.open("rb") as source:
                    for block in iter(lambda: source.read(1_048_576), b""):
                        output.write(block)
        with gzip.open(joined, "rb") as sql:
            for line in sql:
                digest.update(line)
                total += len(line)
                portable_line = portable_export_line(line)
                assert process.stdin is not None
                process.stdin.write(portable_line)
                statement.extend(portable_line)
                if sqlite3.complete_statement(statement.decode("utf-8")):
                    # The D1 limit applies to the SQL statement text, not the
                    # SQLite row value. Newlines inside literals are supported.
                    largest_statement_bytes = max(largest_statement_bytes, len(statement))
                    oversized_statement_count += len(statement) > D1_MAX_STATEMENT_BYTES
                    statement.clear()
        if statement.strip():
            raise RuntimeError("Archive ends with an incomplete SQL statement")
        assert process.stdin is not None
        process.stdin.close()
        assert process.stderr is not None
        error = process.stderr.read().decode("utf-8", "replace")
        process.stderr.close()
        if process.wait() != 0:
            raise RuntimeError(f"SQLite archive replay failed: {error[-1000:]}")
    except BrokenPipeError:
        assert process.stderr is not None
        error = process.stderr.read().decode("utf-8", "replace")
        code = process.wait()
        known = [message for message in (
            "database or disk is full", "out of memory", "disk I/O error",
            "unable to open database file", "no such table", "syntax error",
            "UNIQUE constraint failed", "FOREIGN KEY constraint failed",
            "database is locked", "database disk image is malformed",
        ) if message in error]
        raise RuntimeError(f"SQLite replay exited early: code={code}, known_errors={known}") from None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in (process.stdin, process.stderr):
            if stream is not None:
                with contextlib.suppress(BrokenPipeError):
                    stream.close()
    return SqlDigest(
        size=total,
        sha256=digest.hexdigest(),
        largest_statement_bytes=largest_statement_bytes,
        oversized_statement_count=oversized_statement_count,
    )


def verify_restored(database: pathlib.Path, manifest: dict) -> dict[str, int]:
    with contextlib.closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as connection:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"Restored SQLite integrity check failed: {integrity}")
        fk_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if fk_errors:
            raise RuntimeError(f"Restored SQLite has {len(fk_errors)} foreign-key errors")
        counts = {
            "authors": connection.execute("SELECT count(*) FROM author").fetchone()[0],
            "poems": connection.execute("SELECT count(*) FROM poem").fetchone()[0],
            "snapshots": connection.execute(
                "SELECT count(*) FROM poem WHERE publication_json IS NOT NULL"
            ).fetchone()[0],
            "fk_errors": 0,
        }
    if counts != manifest["counts"]:
        raise RuntimeError(f"Archive count mismatch: {counts} != {manifest['counts']}")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-key", required=True)
    args = parser.parse_args()
    key = args.manifest_key
    if not key.startswith(f"{BUCKET}/d1/") or not key.endswith("/manifest.json"):
        parser.error("Expected a private saqi-corpus-archive/d1/.../manifest.json key")
    with tempfile.TemporaryDirectory(prefix="saqi-d1-restore-rehearsal-") as temporary:
        directory = pathlib.Path(temporary)
        manifest_path = directory / "manifest.json"
        download(key, manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        verify_manifest(manifest, key)
        parts = []
        for number, item in enumerate(manifest["parts"], 1):
            part = directory / f"part-{number:04d}"
            download(item["key"], part)
            if part.stat().st_size != item["bytes"] or sha256(part) != item["sha256"]:
                raise RuntimeError(f"Archive part {number} failed its roundtrip digest")
            parts.append(part)
        database = directory / "restored.sqlite3"
        sql_digest = restore(parts, database)
        if sql_digest.size != manifest["sql_bytes"] or sql_digest.sha256 != manifest["sql_sha256"]:
            raise RuntimeError("Decompressed SQL differs from archived source")
        counts = verify_restored(database, manifest)
        print(json.dumps({
            "manifest": key,
            "bookmark": manifest["bookmark"],
            "counts": counts,
            "restore_rehearsal": "passed",
            "largest_sql_statement_bytes": sql_digest.largest_statement_bytes,
            "sql_statements_over_d1_limit": sql_digest.oversized_statement_count,
            "d1_sql_import_rehearsal": "required" if sql_digest.oversized_statement_count else "required_for_final_gate",
        }))


if __name__ == "__main__":
    main()
