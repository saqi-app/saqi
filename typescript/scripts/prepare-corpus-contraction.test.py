import contextlib
import importlib.util
import io
import pathlib
import sqlite3
import string
import unittest

SPEC = importlib.util.spec_from_file_location(
    "copy_helper", pathlib.Path(__file__).with_name("prepare-corpus-contraction.py")
)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class BoundedCopyTest(unittest.TestCase):
    def test_interrupted_copy_resumes_without_losing_canonical_or_invocation_values(self):
        with contextlib.closing(sqlite3.connect(":memory:")) as database:
            columns = ["id"] + ["col_" + letter for letter in string.ascii_lowercase] + ["checkpoint"]
            definition = "id TEXT PRIMARY KEY," + ",".join(name + " TEXT" for name in columns[1:])
            for table in ("poem", "_poem_next"):
                database.execute("CREATE TABLE " + table + "(" + definition + ")")
            expected = [
                (f"poem{number:04}",) + tuple(
                    None if index % 3 == 0 else f"قصيدة 'quoted' {number}/{index}"
                    for index in range(26)
                ) + ('{"status":"unknown","attempt":"preserve-me"}',)
                for number in range(1_234)
            ]
            database.executemany("INSERT INTO poem VALUES (" + ",".join("?" for _ in columns) + ")", expected)
            database.commit()
            writes = 0
            interrupted = False

            def query(sql, params=None):
                nonlocal writes, interrupted
                cursor = database.execute(sql, params or [])
                result = [dict(zip([item[0] for item in cursor.description], row)) for row in cursor.fetchall()] if cursor.description else []
                database.commit()
                if sql.startswith("INSERT"):
                    writes += 1
                    if writes == 2 and not interrupted:
                        interrupted = True
                        raise RuntimeError("simulated lost response after committed copy batch")
                return result

            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "simulated lost response"):
                    HELPER.copy_poems(query)
                self.assertEqual(database.execute("SELECT count(*) FROM _poem_next").fetchone()[0], 1_000)
                self.assertEqual(HELPER.copy_poems(query), 1_234)
                self.assertEqual(HELPER.copy_poems(query), 1_234)
            names = ",".join(columns)
            self.assertEqual(database.execute("SELECT " + names + " FROM poem ORDER BY id").fetchall(), expected)
            self.assertEqual(database.execute("SELECT " + names + " FROM _poem_next ORDER BY id").fetchall(), expected)

    def test_completed_swap_needs_no_local_checkpoint(self):
        self.assertEqual(HELPER.copy_poems(lambda sql: []), 0)


if __name__ == "__main__":
    unittest.main()
