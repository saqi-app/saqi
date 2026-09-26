import gzip
import importlib.util
import io
import pathlib
import sqlite3
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).with_name("rehearse-production-d1-import.py")
SPEC = importlib.util.spec_from_file_location("d1_import_rehearsal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class D1ImportRehearsalTest(unittest.TestCase):
    def test_disposable_client_refuses_production_database(self):
        with self.assertRaisesRegex(RuntimeError, "Refusing to query production"):
            MODULE.d1_query(MODULE.PRODUCTION_DATABASE_ID, "SELECT 1")

    def test_disposable_client_retries_transient_error(self):
        unavailable = urllib.error.HTTPError("https://api.cloudflare.com", 503, "unavailable", {}, None)
        response = io.BytesIO(b'{"success":true,"result":[{"success":true,"results":[{"ok":1}]}]}')
        with patch.object(MODULE, "TOKEN", {"value": "test", "expires": time.monotonic() + 100}), \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=[unavailable, response]) as open_url, \
             patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(MODULE.d1_query("disposable", "SELECT 1"), [{"ok": 1}])
            self.assertEqual(open_url.call_count, 2)
            sleep.assert_called_once_with(0.5)

    def test_disposable_client_does_not_retry_bad_query(self):
        bad_query = urllib.error.HTTPError("https://api.cloudflare.com", 400, "bad query", {}, None)
        with patch.object(MODULE, "TOKEN", {"value": "test", "expires": time.monotonic() + 100}), \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=bad_query) as open_url, \
             patch.object(MODULE.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                MODULE.d1_query("disposable", "SELECT 1")
            self.assertEqual(open_url.call_count, 1)
            sleep.assert_not_called()

    def test_oversized_publication_is_restored_with_a_bound_value(self):
        publication = '{"english":"' + "x" * 53_000 + ";\n" + "y" * 53_000 + '"}'
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            with sqlite3.connect(original) as connection:
                connection.execute("CREATE TABLE poem(id TEXT PRIMARY KEY, title TEXT, publication_json TEXT)")
                connection.execute(
                    "INSERT INTO poem VALUES (?, ?, ?)", ("poem-1", "Arabic's title", publication)
                )
                dump = "\n".join(connection.iterdump()).encode()
            part = directory / "part-0001"
            part.write_bytes(gzip.compress(dump, mtime=0))
            portable = directory / "portable.sql"
            oversized = MODULE.portable_sql([part], original, portable)
            self.assertEqual(len(oversized), 1)
            self.assertEqual(oversized[0].poem_id, "poem-1")
            self.assertEqual(oversized[0].publication, publication)
            self.assertNotIn(publication.encode(), portable.read_bytes())
            target = directory / "target.sqlite3"
            with sqlite3.connect(target) as connection:
                connection.executescript(portable.read_text())
                self.assertIsNone(
                    connection.execute("SELECT publication_json FROM poem").fetchone()[0]
                )
                connection.execute(
                    "UPDATE poem SET publication_json = ? WHERE id = ?", (publication, "poem-1")
                )
                self.assertEqual(
                    connection.execute("SELECT title, publication_json FROM poem").fetchone(),
                    ("Arabic's title", publication),
                )

    def test_identifies_an_export_insert_with_explicit_columns(self):
        sql = 'INSERT INTO "poem" ("id","publication_json") VALUES(\'poem-1\',\'x\');'
        self.assertEqual(MODULE.INSERT_POEM.match(sql).group("id"), "poem-1")

    def test_oversized_other_table_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            with sqlite3.connect(original) as connection:
                connection.execute("CREATE TABLE poem(id TEXT PRIMARY KEY, publication_json TEXT)")
                connection.execute("CREATE TABLE author(id TEXT PRIMARY KEY, biography TEXT)")
                connection.execute("INSERT INTO author VALUES (?, ?)", ("author-1", "a" * 110_000))
                dump = "\n".join(connection.iterdump()).encode()
            part = directory / "part-0001"
            part.write_bytes(gzip.compress(dump, mtime=0))
            with self.assertRaisesRegex(RuntimeError, "Oversized non-poem"):
                MODULE.portable_sql([part], original, directory / "portable.sql")

    def test_compares_every_column_and_foreign_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            target = directory / "target.sqlite3"
            with sqlite3.connect(original) as source:
                source.execute("CREATE TABLE author(id TEXT PRIMARY KEY, name TEXT)")
                source.execute("CREATE TABLE poem(id TEXT PRIMARY KEY, author_id TEXT REFERENCES author(id), publication_json TEXT)")
                source.execute("INSERT INTO author VALUES ('a', 'Poet')")
                source.execute("INSERT INTO poem VALUES ('p', 'a', 'English')")
                source.commit()
                with sqlite3.connect(target) as copy:
                    source.backup(copy)

            def query(_database_id, sql, params=None):
                with sqlite3.connect(target) as connection:
                    connection.row_factory = sqlite3.Row
                    return [dict(row) for row in connection.execute(sql, params or [])]

            with patch.object(MODULE, "d1_query", side_effect=query):
                self.assertEqual(MODULE.compare_rows(original, "disposable"), {"author": 1, "poem": 1})
                with sqlite3.connect(target) as connection:
                    connection.execute("UPDATE poem SET publication_json = 'Changed'")
                with self.assertRaisesRegex(RuntimeError, "differs from archive"):
                    MODULE.compare_rows(original, "disposable")


if __name__ == "__main__":
    unittest.main()
