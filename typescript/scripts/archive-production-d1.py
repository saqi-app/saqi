#!/usr/bin/env python3
"""Export a quiescent production D1 into verified private R2 objects.

Run only after publication backfill/audit, with collection and rig writers off.
The SQL and verification downloads live in a temporary directory and are
removed after the manifest has been uploaded and read back.
"""

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone


OPERATIONS = pathlib.Path(__file__).resolve().parents[1] / "packages/operations"
BUCKET = "saqi-corpus-archive"
PART_BYTES = 200_000_000
DATABASE_ID = "ffaae610-4dae-4d7e-bf86-8232f46ca2b5"


def wrangler(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["yarn", "wrangler", *args],
        cwd=OPERATIONS,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout or ""


def bookmark() -> str:
    value = json.loads(wrangler("d1", "time-travel", "info", "saqi-db", "--json", capture=True))
    result = value.get("bookmark")
    if not isinstance(result, str) or not result:
        raise RuntimeError("D1 did not return a Time Travel bookmark")
    return result


def counts() -> dict[str, int]:
    query = "SELECT (SELECT COUNT(*) FROM author) AS authors, (SELECT COUNT(*) FROM poem) AS poems, (SELECT COUNT(*) FROM poem WHERE publication_json IS NOT NULL) AS snapshots, (SELECT COUNT(*) FROM pragma_foreign_key_check) AS fk_errors"
    value = json.loads(wrangler("d1", "execute", "saqi-db", "--remote", "--command", query, "--json", capture=True))
    row = value[0]["results"][0]
    return {key: int(row[key]) for key in ("authors", "poems", "snapshots", "fk_errors")}


def digest(path: pathlib.Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1_048_576), b""):
            hasher.update(block)
    return hasher.hexdigest()


def split_gzip(source: pathlib.Path, directory: pathlib.Path) -> list[pathlib.Path]:
    output = directory / "corpus.sql.gz"
    with source.open("rb") as raw, output.open("wb") as compressed:
        with gzip.GzipFile(fileobj=compressed, mode="wb", mtime=0) as stream:
            for block in iter(lambda: raw.read(1_048_576), b""):
                stream.write(block)
    parts: list[pathlib.Path] = []
    with output.open("rb") as stream:
        number = 0
        while block := stream.read(PART_BYTES):
            number += 1
            part = directory / f"corpus.sql.gz.part-{number:04d}"
            part.write_bytes(block)
            parts.append(part)
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Run the remote export and verified upload")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Pass --execute during a maintenance window after the publication audit")
    if os.environ.get("SAQI_DIRECT_SOURCE_ACTIVE") == "1" or os.environ.get("SAQI_RIG_ACTIVE") == "1":
        parser.error("Collection and rig writers must be disabled")

    key = f"d1/{datetime.now(timezone.utc):%Y-%m-%dT%H-%M-%SZ}-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="saqi-d1-archive-") as temporary:
        directory = pathlib.Path(temporary)
        sql = directory / "corpus.sql"
        before_bookmark = bookmark()
        before_counts = counts()
        if before_counts["fk_errors"]:
            raise RuntimeError("Production D1 has foreign-key errors")
        wrangler("d1", "export", "saqi-db", "--remote", "--skip-confirmation", "--output", str(sql))
        after_counts = counts()
        after_bookmark = bookmark()
        if before_bookmark != after_bookmark or before_counts != after_counts:
            raise RuntimeError("D1 changed during export; discard this archive and retry after writers stop")

        parts = split_gzip(sql, directory)
        if not parts:
            raise RuntimeError("Export compressed to no data")
        manifest = {
            "format": "saqi.d1-sql-gzip-parts.v1",
            "database_id": DATABASE_ID,
            "bookmark": before_bookmark,
            "counts": before_counts,
            "sql_bytes": sql.stat().st_size,
            "sql_sha256": digest(sql),
            "parts": [],
        }
        for part in parts:
            object_path = f"{BUCKET}/{key}/{part.name}"
            wrangler("r2", "object", "put", object_path, "--remote", "--file", str(part))
            downloaded = directory / f"verify-{part.name}"
            wrangler("r2", "object", "get", object_path, "--remote", "--file", str(downloaded))
            expected = digest(part)
            if downloaded.stat().st_size != part.stat().st_size or digest(downloaded) != expected:
                raise RuntimeError(f"R2 roundtrip mismatch: {part.name}")
            manifest["parts"].append({"key": object_path, "bytes": part.stat().st_size, "sha256": expected})
            downloaded.unlink()

        manifest_path = directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        manifest_key = f"{BUCKET}/{key}/manifest.json"
        wrangler("r2", "object", "put", manifest_key, "--remote", "--file", str(manifest_path))
        downloaded_manifest = directory / "verify-manifest.json"
        wrangler("r2", "object", "get", manifest_key, "--remote", "--file", str(downloaded_manifest))
        if digest(downloaded_manifest) != digest(manifest_path):
            raise RuntimeError("R2 manifest roundtrip mismatch")
        print(json.dumps({"manifest": manifest_key, "bookmark": before_bookmark, "counts": before_counts, "parts": len(parts)}))


if __name__ == "__main__":
    main()
