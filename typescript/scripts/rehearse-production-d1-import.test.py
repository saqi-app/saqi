import gzip
import importlib.util
import io
import pathlib
import sqlite3
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).with_name("rehearse-production-d1-import.py")
SPEC = importlib.util.spec_from_file_location("d1_import_rehearsal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class D1ImportRehearsalTest(unittest.TestCase):
    def test_near_expiry_waits_before_wrangler_refreshes(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            config = home / "Library/Preferences/.wrangler/config/default.toml"
            config.parent.mkdir(parents=True)
            config.write_text('expiration_time = "1970-01-01T00:05:00+00:00"')
            clock = [100.0]
            def advance(seconds):
                clock[0] += seconds
            with patch.dict(MODULE.os.environ, {}, clear=True), \
                 patch.object(MODULE.pathlib.Path, "home", return_value=home), \
                 patch.object(MODULE.time, "time", side_effect=lambda: clock[0]), \
                 patch.object(MODULE.time, "sleep", side_effect=advance) as sleep:
                MODULE.wait_for_oauth_window()
                self.assertEqual(sleep.call_count, 7)
                self.assertEqual(clock[0], 302.0)
                self.assertTrue(all(call.args[0] <= 30 for call in sleep.call_args_list))

    def test_disposable_client_refuses_production_database(self):
        with self.assertRaisesRegex(RuntimeError, "Refusing to query production"):
            MODULE.d1_query(MODULE.PRODUCTION_DATABASE_ID, "SELECT 1")

    def test_disposable_client_retries_transient_error(self):
        unavailable = urllib.error.HTTPError("https://api.cloudflare.com", 503, "unavailable", {}, None)
        response = io.BytesIO(b'{"success":true,"result":[{"success":true,"results":[{"ok":1}]}]}')
        with patch.object(MODULE, "wrangler", return_value='{"token":"test"}'), \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=[unavailable, response]) as open_url, \
             patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(MODULE.d1_query("disposable", "SELECT 1"), [{"ok": 1}])
            self.assertEqual(open_url.call_count, 2)
            sleep.assert_called_once_with(0.5)

    def test_disposable_client_does_not_retry_bad_query(self):
        bad_query = urllib.error.HTTPError("https://api.cloudflare.com", 400, "bad query", {}, None)
        with patch.object(MODULE, "wrangler", return_value='{"token":"test"}'), \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=bad_query) as open_url, \
             patch.object(MODULE.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                MODULE.d1_query("disposable", "SELECT 1")
            self.assertEqual(open_url.call_count, 1)
            sleep.assert_not_called()

    def test_oversized_publication_is_inserted_with_a_bound_value(self):
        publication = '{"english":"' + "x" * 53_000 + ";\n" + "y" * 53_000 + '"}'
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            with sqlite3.connect(original) as connection:
                connection.execute('CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID')
                connection.execute("CREATE TABLE poem(id TEXT PRIMARY KEY, title TEXT, publication_json TEXT)")
                connection.execute(
                    "INSERT INTO poem VALUES (?, ?, ?)", ("poem-1", "Arabic's title", publication)
                )
                dump = "\n".join(connection.iterdump()).encode()
            part = directory / "part-0001"
            part.write_bytes(gzip.compress(dump, mtime=0))
            plan = MODULE.portable_import_plan(original, directory)
            oversized = [step for step in plan if isinstance(step, MODULE.BoundInsert)]
            self.assertEqual(len(oversized), 1)
            self.assertEqual(oversized[0].row_id, "poem-1")
            self.assertIn(publication, oversized[0].params)
            self.assertTrue(all(publication.encode() not in step.read_bytes() for step in plan if isinstance(step, pathlib.Path)))
            target = directory / "target.sqlite3"
            with sqlite3.connect(target) as connection:
                for step in plan:
                    if isinstance(step, pathlib.Path):
                        connection.executescript(step.read_text())
                    else:
                        connection.execute(step.sql, step.params)
                self.assertEqual(
                    connection.execute("SELECT title, publication_json FROM poem").fetchone(),
                    ("Arabic's title", publication),
                )
                self.assertIsNone(
                    connection.execute("SELECT name FROM sqlite_master WHERE name = '_cf_KV'").fetchone()
                )

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
            with self.assertRaisesRegex(RuntimeError, "reviewed bound-import rule"):
                MODULE.portable_import_plan(original, directory)

    def test_oversized_artifact_stays_before_its_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            with sqlite3.connect(original) as connection:
                connection.execute("CREATE TABLE model_enrichment_artifact(id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
                connection.execute("CREATE TABLE model_enrichment_validation(id TEXT PRIMARY KEY, artifact_id TEXT REFERENCES model_enrichment_artifact(id))")
                connection.execute("INSERT INTO model_enrichment_artifact VALUES (?, ?)", ("artifact-1", "x" * 110_000))
                connection.execute("INSERT INTO model_enrichment_validation VALUES ('validation-1', 'artifact-1')")
                dump = "\n".join(connection.iterdump()).encode()
            part = directory / "part-0001"
            part.write_bytes(gzip.compress(dump, mtime=0))
            plan = MODULE.portable_import_plan(original, directory)
            self.assertEqual([step.table for step in plan if isinstance(step, MODULE.BoundInsert)], ["model_enrichment_artifact"])
            target = directory / "target.sqlite3"
            with sqlite3.connect(target) as connection:
                connection.execute("PRAGMA foreign_keys = ON")
                for step in plan:
                    if isinstance(step, pathlib.Path):
                        connection.executescript(step.read_text())
                    else:
                        connection.execute(step.sql, step.params)
                self.assertEqual(connection.execute("SELECT count(*) FROM model_enrichment_validation").fetchone()[0], 1)
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_bounded_batches_restore_cycles_before_triggers(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            with sqlite3.connect(original) as source:
                source.executescript("""
                    CREATE TABLE poem(id TEXT PRIMARY KEY, active_source_revision_id TEXT REFERENCES revision(id));
                    CREATE TABLE revision(id TEXT PRIMARY KEY, poem_id TEXT REFERENCES poem(id));
                    INSERT INTO poem VALUES ('p', 'r');
                    INSERT INTO revision VALUES ('r', 'p');
                    CREATE TRIGGER immutable BEFORE UPDATE ON poem BEGIN SELECT RAISE(ABORT, 'immutable'); END;
                """)
            with patch.object(MODULE, "MAX_IMPORT_BYTES", 300):
                plan = MODULE.portable_import_plan(original, directory)
            with sqlite3.connect(directory / "copy.sqlite3") as target:
                target.execute("PRAGMA foreign_keys=ON")
                for step in plan:
                    self.assertLessEqual(step.stat().st_size, 300)
                    target.executescript("BEGIN;" + step.read_text() + "COMMIT;")
                self.assertEqual(target.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(target.execute("SELECT id,active_source_revision_id FROM poem").fetchall(), [('p', 'r')])
                with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                    target.execute("UPDATE poem SET active_source_revision_id=NULL")

    def test_write_never_retries_ambiguous_response(self):
        with patch.object(MODULE, "wrangler", return_value='{"token":"test"}'), \
             patch.object(MODULE.urllib.request, "urlopen", side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                MODULE.d1_query("disposable", "INSERT INTO poem VALUES (?)", ["p"], retry=False)
            request.assert_called_once()

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

            self.assertEqual(MODULE.compare_copies(original, target), {"author": 1, "poem": 1})
            with sqlite3.connect(target) as connection:
                connection.execute("UPDATE poem SET publication_json = 'Changed'")
            with self.assertRaisesRegex(RuntimeError, "differs from archive"):
                MODULE.compare_copies(original, target)

    def test_bulk_parity_rejects_missing_trigger_and_extra_row(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            original = directory / "original.sqlite3"
            target = directory / "target.sqlite3"
            with sqlite3.connect(original) as source:
                source.executescript("""
                    CREATE TABLE poem(id TEXT PRIMARY KEY);
                    CREATE TRIGGER immutable BEFORE UPDATE ON poem BEGIN SELECT RAISE(ABORT, 'immutable'); END;
                    INSERT INTO poem VALUES ('a');
                """)
                with sqlite3.connect(target) as copy:
                    source.backup(copy)
            with sqlite3.connect(target) as copy:
                copy.execute("INSERT INTO poem VALUES ('b')")
            with self.assertRaisesRegex(RuntimeError, "differs from archive in poem"):
                MODULE.compare_copies(original, target)
            with sqlite3.connect(target) as copy:
                copy.execute("DELETE FROM poem WHERE id='b'")
                copy.execute("DROP TRIGGER immutable")
            with self.assertRaisesRegex(RuntimeError, "schema differs"):
                MODULE.compare_copies(original, target)

    def test_bulk_export_refuses_production_name(self):
        with self.assertRaisesRegex(RuntimeError, "non-disposable"):
            MODULE.compare_export(pathlib.Path("unused"), "saqi-db")


if __name__ == "__main__":
    unittest.main()
