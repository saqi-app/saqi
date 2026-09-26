import gzip
import importlib.util
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("rehearse-production-d1-restore.py")
SPEC = importlib.util.spec_from_file_location("restore_rehearsal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RestoreRehearsalTest(unittest.TestCase):
    def test_replays_verified_sql_and_rejects_count_drift(self):
        sql = b"""
        CREATE TABLE author(id TEXT PRIMARY KEY);
        CREATE TABLE poem(id TEXT PRIMARY KEY, author_id TEXT REFERENCES author(id), publication_json TEXT);
        INSERT INTO author VALUES ('author-1');
        INSERT INTO poem VALUES ('poem-1', 'author-1', '{"schemaVersion":2}');
        """
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            part = directory / "part-0001"
            part.write_bytes(gzip.compress(sql, mtime=0))
            database = directory / "restored.sqlite3"
            digest = MODULE.restore([part], database)
            self.assertEqual(digest.size, len(sql))
            self.assertEqual(len(digest.sha256), 64)
            manifest = {
                "counts": {"authors": 1, "poems": 1, "snapshots": 1, "fk_errors": 0}
            }
            self.assertEqual(MODULE.verify_restored(database, manifest), manifest["counts"])
            manifest["counts"]["poems"] = 2
            with self.assertRaisesRegex(RuntimeError, "count mismatch"):
                MODULE.verify_restored(database, manifest)

    def test_manifest_rejects_part_outside_archive_prefix(self):
        key = "saqi-corpus-archive/d1/test/manifest.json"
        manifest = {
            "format": "saqi.d1-sql-gzip-parts.v1",
            "database_id": MODULE.DATABASE_ID,
            "parts": [{"key": "saqi-corpus-archive/d1/elsewhere/corpus.sql.gz.part-0001", "bytes": 1, "sha256": "a" * 64}],
            "counts": {"authors": 1, "poems": 1, "snapshots": 0, "fk_errors": 0},
            "sql_bytes": 1,
            "sql_sha256": "b" * 64,
        }
        with self.assertRaisesRegex(ValueError, "part key"):
            MODULE.verify_manifest(manifest, key)


if __name__ == "__main__":
    unittest.main()
