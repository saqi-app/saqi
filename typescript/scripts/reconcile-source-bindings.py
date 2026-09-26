#!/usr/bin/env python3
"""Bind five reviewed source exceptions to their existing canonical poem rows.

Dry-run by default. Execute only after publication parity, private D1 archive,
disposable restore rehearsal, and direct-source deployment have passed.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
from dataclasses import dataclass
from typing import NewType


OPERATIONS = pathlib.Path(__file__).resolve().parents[1] / "packages/operations"
DATABASE_ID = "ffaae610-4dae-4d7e-bf86-8232f46ca2b5"
BUCKET = "saqi-corpus-archive"
COUNTS_SQL = "SELECT (SELECT count(*) FROM author) authors, (SELECT count(*) FROM poem) poems, (SELECT count(*) FROM pragma_foreign_key_check) fk_errors"
SourceId = NewType("SourceId", str)
PoemId = NewType("PoemId", str)
EXCEPTIONS = (
    ("22937", "4df35b2d-55bc-4bee-b202-a08b74f26941", "34b09bf6-a530-464f-8581-eb76983581e7", "aec08129eeeedcfe956891604ae5be9449f569e8a2a4d91a54f27c737c0bd283", "identity"),
    ("65608", "cc065d9e-686b-4506-8826-56fb7130d781", "8ed34cd4-16a5-48e5-aff1-3a7f65f54d30", "50e5fdd9638b87eb49f6a71edf4c58667862d72b76ada7587c9490142b3c4af0", "identity"),
    ("95050", "eaa1c6cb-402f-4e5d-bf1f-f13569483608", "a0407c81-0cda-4587-9ba0-642d17439f53", "ea2e1004fb317ed60e3fcfd76f93820c95f9ee66349316b53c923c9d6af55a3b", "identity"),
    ("95053", "c3718eff-15af-46bf-9258-a843d5222181", "a0407c81-0cda-4587-9ba0-642d17439f53", "918967bfbc3dfc53b5eae2f4b1f3a814cecc9481902020e395c7a9573aec9cce", "sealed"),
    ("95064", "d2ad44f1-577c-456a-a1be-fe0d57e52daa", "a0407c81-0cda-4587-9ba0-642d17439f53", "926aedaf43967e7c4457a64f2cdba70d33f0bffc773a3696614e83ab251756c5", "sealed"),
)


@dataclass(frozen=True)
class D1Result:
    rows: list[dict]
    metadata: dict


@dataclass(frozen=True)
class PreparedBinding:
    source_id: SourceId
    poem_id: PoemId
    source_hash: str
    sets: str
    where: str
    preserve_snapshot: bool


def wrangler(*args: str) -> str:
    return subprocess.run(
        ["yarn", "wrangler", *args],
        cwd=OPERATIONS,
        text=True,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_nullable(value: str | None) -> str:
    return "NULL" if value is None else sql_text(value)


def query(sql: str) -> D1Result:
    response = json.loads(wrangler("d1", "execute", "saqi-db", "--remote", "--command", sql, "--json"))
    if len(response) != 1 or response[0].get("success") is not True:
        raise RuntimeError("Unexpected D1 response")
    return D1Result(response[0]["results"], response[0]["meta"])


def one(sql: str) -> dict:
    rows = query(sql).rows
    if len(rows) != 1:
        raise RuntimeError("Expected exactly one source/canonical row")
    return rows[0]


def verify_archive(key: str) -> dict:
    if not key.startswith(f"{BUCKET}/d1/") or not key.endswith("/manifest.json"):
        raise RuntimeError("Expected a private Saqi D1 archive manifest key")
    with tempfile.TemporaryDirectory(prefix="saqi-source-binding-") as temporary:
        path = pathlib.Path(temporary) / "manifest.json"
        wrangler("r2", "object", "get", key, "--remote", "--file", str(path))
        manifest = json.loads(path.read_text(encoding="utf8"))
    if manifest.get("database_id") != DATABASE_ID or manifest.get("format") != "saqi.d1-sql-gzip-parts.v1":
        raise RuntimeError("Archive does not cover the approved production D1")
    return manifest


def prepare_binding(binding: tuple[str, str, str, str, str]) -> PreparedBinding:
    source_id, poem_id, author_id, expected_hash, provenance = binding
    row = one(
        "SELECT id, author_id, name_arabic, content_arabic, source_name, "
        "source_poem_id, source_url, source_hash, source_version, "
        "publication_json, publication_hash, publication_source_hash "
        f"FROM poem WHERE id = {sql_text(poem_id)}"
    )
    if row["author_id"] != author_id or row["source_hash"] is not None:
        raise RuntimeError(f"Canonical owner/hash changed for source {source_id}")
    content = json.loads(row["content_arabic"])
    if (content.get("titleArabic", row["name_arabic"]) != row["name_arabic"]
            or not isinstance(content.get("content"), list)):
        raise RuntimeError(f"Canonical Arabic shape changed for source {source_id}")
    canonical = json.dumps(
        {"content": content["content"], "titleArabic": row["name_arabic"]},
        ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    )
    actual_hash = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    if actual_hash != expected_hash:
        raise RuntimeError(f"Canonical Arabic hash changed for source {source_id}")
    url = f"https://www.aldiwan.net/poem{source_id}.html"
    if provenance == "identity":
        if (row["source_name"], row["source_poem_id"], row["source_url"], row["source_version"]) != ("aldiwan", source_id, url, 1):
            raise RuntimeError(f"Established binding changed for source {source_id}")
        relation = (
            "EXISTS (SELECT 1 FROM source_poem_identity s "
            f"WHERE s.source_name = 'aldiwan' AND s.external_id = {sql_text(source_id)} "
            f"AND s.canonical_poem_id = {sql_text(poem_id)})"
        )
    else:
        if (row["source_name"], row["source_poem_id"], row["source_url"], row["source_version"]) != (None, None, None, 0):
            raise RuntimeError(f"Unbound import changed for source {source_id}")
        relation = (
            "EXISTS (SELECT 1 FROM crawl_import_record r JOIN crawl_import_bundle b ON b.id = r.bundle_id "
            f"WHERE r.source_name = 'aldiwan' AND r.source_poem_id = {sql_text(source_id)} "
            f"AND r.canonical_poem_id = {sql_text(poem_id)} AND b.status = 'sealed')"
        )
    if one(f"SELECT count(*) n FROM poem WHERE id = {sql_text(poem_id)} AND {relation}")["n"] != 1:
        raise RuntimeError(f"Source provenance changed for {source_id}")
    snapshot = json.loads(row["publication_json"]) if row["publication_json"] else None
    valid_snapshot = (
        isinstance(snapshot, dict) and snapshot.get("schemaVersion") == 2
        and snapshot.get("active") is False and isinstance(row["publication_hash"], str)
        and len(row["publication_hash"]) == 64
    )
    if row["publication_source_hash"] is not None:
        raise RuntimeError(f"Publication source hash changed for {source_id}")
    where = (
        f"id = {sql_text(poem_id)} AND author_id = {sql_text(author_id)} "
        f"AND name_arabic = {sql_text(row['name_arabic'])} "
        f"AND content_arabic = {sql_text(row['content_arabic'])} "
        f"AND source_hash IS NULL AND source_name IS {sql_nullable(row['source_name'])} "
        f"AND source_poem_id IS {sql_nullable(row['source_poem_id'])} "
        f"AND source_url IS {sql_nullable(row['source_url'])} "
        f"AND source_version = {row['source_version']} "
        f"AND publication_hash IS {sql_nullable(row['publication_hash'])} "
        f"AND publication_source_hash IS NULL AND {relation}"
    )
    sets = [f"source_hash = {sql_text(expected_hash)}"]
    if provenance == "sealed":
        sets += ["source_name = 'aldiwan'", f"source_poem_id = {sql_text(source_id)}", f"source_url = {sql_text(url)}", "source_version = 1", "collected_at = unixepoch()"]
    if valid_snapshot:
        sets.append(f"publication_source_hash = {sql_text(expected_hash)}")
    return PreparedBinding(SourceId(source_id), PoemId(poem_id), expected_hash, ", ".join(sets), where, bool(valid_snapshot))


def verify_after(baseline: dict, prepared: list[PreparedBinding]) -> None:
    after = one(COUNTS_SQL)
    if after != baseline:
        raise RuntimeError("Canonical count or foreign-key parity failed after binding")
    for binding in prepared:
        result = one(f"SELECT id, source_hash FROM poem WHERE source_name = 'aldiwan' AND source_poem_id = {sql_text(binding.source_id)}")
        if result != {"id": binding.poem_id, "source_hash": binding.source_hash}:
            raise RuntimeError(f"Source key did not bind uniquely for {binding.source_id}")
    print(json.dumps({"verified": True, "authors": after["authors"], "poems": after["poems"], "fkErrors": 0}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--archive-manifest", help="R2 manifest already verified by the disposable restore rehearsal")
    args = parser.parse_args()
    if args.execute and not args.archive_manifest:
        parser.error("--execute requires --archive-manifest from a passed restore rehearsal")
    info = json.loads(wrangler("d1", "info", "saqi-db", "--json"))
    if info.get("uuid") != DATABASE_ID or info.get("name") != "saqi-db":
        raise RuntimeError("Wrangler is not pointing at the approved production D1")
    archive = verify_archive(args.archive_manifest) if args.archive_manifest else None
    baseline = one(COUNTS_SQL)
    if baseline["fk_errors"] != 0:
        raise RuntimeError("Production D1 has foreign-key errors")
    if archive and (archive["counts"]["authors"] != baseline["authors"] or archive["counts"]["poems"] != baseline["poems"]):
        raise RuntimeError("Canonical counts changed since the verified archive")

    prepared = [prepare_binding(binding) for binding in EXCEPTIONS]

    for binding in prepared:
        if args.execute:
            metadata = query(f"UPDATE poem SET {binding.sets} WHERE {binding.where}").metadata
            if metadata.get("changes") != 1:
                raise RuntimeError(f"Compare-and-swap changed {metadata.get('changes')} rows for source {binding.source_id}; stop")
        print(json.dumps({"sourceId": binding.source_id, "poemId": binding.poem_id, "sourceHash": binding.source_hash, "preserveSnapshot": binding.preserve_snapshot, "executed": args.execute}))

    if args.execute:
        verify_after(baseline, prepared)


if __name__ == "__main__":
    main()
