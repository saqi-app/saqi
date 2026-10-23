import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class CatalogAuditTests(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.database.executescript("""
        CREATE TABLE author(id TEXT PRIMARY KEY, slug TEXT, name_arabic TEXT, name TEXT);
        CREATE TABLE poem(id TEXT PRIMARY KEY, author_id TEXT, slug TEXT, name_arabic TEXT,
          content_arabic TEXT, source_hash TEXT, publication_source_hash TEXT,
          publication_cache_dirty INTEGER, publication_json TEXT);
        INSERT INTO author VALUES ('a', 'poet-a', 'اسم خاص', NULL);
        """)
        self.queries = []

    def insert_poem(self, poem_id, title, lines, active):
        publication = json.dumps({"active": active, "fields": {"linesEnglish": ["private translated fixture text"]}})
        self.database.execute("INSERT INTO poem VALUES (?, 'a', ?, ?, ?, 'hash', 'hash', 1, ?)",
                              (poem_id, poem_id, title, json.dumps({"content": lines}), publication))

    def query(self, command, *, check, capture_output, text, timeout):
        self.assertEqual(command[:-1], ["yarn", "workspace", "@saqi/operations", "db:execute", "--remote", "--json", "--command"])
        self.assertTrue(check and capture_output and text)
        self.assertEqual(timeout, 40)
        self.queries.append(command[-1])
        cursor = self.database.execute(command[-1])
        rows = [dict(zip([column[0] for column in cursor.description], row)) for row in cursor]
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps([{"success": True, "results": rows}]))

    def audit(self):
        self.database.commit()
        self.database.execute("PRAGMA query_only=ON")
        before = self.database.total_changes
        with tempfile.TemporaryDirectory() as temporary:
            summary = Path(temporary) / "summary.md"
            output = io.StringIO()
            with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(summary)}), \
                 patch.object(subprocess, "run", side_effect=self.query), contextlib.redirect_stdout(output):
                runpy.run_path(str(Path(__file__).with_name("audit-translated-poem-totals.py")))
            self.assertNotIn("private translated fixture text", output.getvalue() + summary.read_text())
            self.assertNotIn("اسم خاص", output.getvalue() + summary.read_text())
            self.assertEqual(self.database.total_changes, before)
            self.assertEqual(len(self.queries), 17)
            return json.loads(output.getvalue().removeprefix("SAQI_TRANSLATION_TOTALS "))

    def test_all_ecmascript_whitespace_is_counted_without_exposing_or_changing_rows(self):
        whitespace = [*range(9, 14), 32, 160, 5760, *range(8192, 8203), 8232, 8233, 8239, 8287, 12288, 65279]
        for index, codepoint in enumerate(whitespace):
            self.insert_poem(f"legacy-{index}", chr(codepoint), [chr(codepoint)], False)
        self.database.execute("INSERT INTO author VALUES ('bad', ' poet-b', 'اسم خاص', NULL)")
        self.database.execute("INSERT INTO author VALUES ('optional', 'poet-c', 'اسم خاص', ?)", ("\u00a0",))
        report = self.audit()
        self.assertEqual(report["poems"], 25)
        self.assertEqual(report["poemsWithInvalidTrimIdentity"], 25)
        self.assertEqual(report["poemsWithoutMeaningfulArabic"], 25)
        self.assertEqual(report["authorsWithInvalidTrimIdentity"], 1)
        self.assertEqual(report["authors"], 3)
        self.assertEqual(report["translatedPoems"], 25)
        self.assertEqual(report["rigPublishedTranslatedPoems"], 0)

    def test_partition_boundaries_cover_non_uuid_ids_once_and_preserve_translation_totals(self):
        identities = [f"{prefix}-poem" for prefix in "0123456789abcdef"] + ["!legacy", "zlegacy", "شعر"]
        for identity in identities:
            self.insert_poem(identity, "بيت", ["  معنى\tداخل البيت  "], True)
        report = self.audit()
        for key in ["poems", "translatedPoems", "rigPublishedTranslatedPoems", "rigPublicationsWithCurrentSource", "rigPublicationsPendingCachePurge"]:
            self.assertEqual(report[key], len(identities), key)
        for key in ["poemsWithInvalidTrimIdentity", "poemsWithoutMeaningfulArabic", "authorsWithInvalidTrimIdentity"]:
            self.assertEqual(report[key], 0, key)

    def test_empty_corpus_returns_zero_counts(self):
        report = self.audit()
        self.assertEqual(report["poems"], 0)
        self.assertEqual(report["translatedPoems"], 0)
        self.assertEqual(report["poemsWithInvalidTrimIdentity"], 0)
        self.assertEqual(report["poemsWithoutMeaningfulArabic"], 0)

    def test_scalar_legacy_tracks_do_not_prevent_the_catalog_audit(self):
        for identity, tracks in [("legacy", ["legacy", 17, None]), ("mixed", ["legacy", {"lines": ["English"]}])]:
            self.insert_poem(identity, "بيت", ["معنى"], False)
            self.database.execute("UPDATE poem SET publication_json = ? WHERE id = ?",
                                  (json.dumps({"fields": {"modelEnrichments": tracks}}), identity))
        report = self.audit()
        self.assertEqual(report["poems"], 2)
        self.assertEqual(report["translatedPoems"], 1)
        self.assertEqual(report["poemsWithInvalidTrimIdentity"], 0)
        self.assertEqual(report["poemsWithoutMeaningfulArabic"], 0)

    def test_invalid_external_count_responses_fail_before_reporting(self):
        invalid = [[], [{"success": False}], [{"success": True, "results": []}],
                   [{"success": True, "results": [{"poems": "private text"}]}],
                   [{"success": True, "results": [{"poems": True}]}],
                   [{"success": True, "results": [{"rigSampleId": {"unexpected": "value"}}]}]]
        for response in invalid:
            with self.subTest(response=response), tempfile.TemporaryDirectory() as temporary:
                output = io.StringIO()
                result = subprocess.CompletedProcess([], 0, stdout=json.dumps(response))
                with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(Path(temporary) / "summary.md")}), \
                     patch.object(subprocess, "run", return_value=result), contextlib.redirect_stdout(output):
                    with self.assertRaisesRegex(RuntimeError, "Corpus count query"):
                        runpy.run_path(str(Path(__file__).with_name("audit-translated-poem-totals.py")))
                self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
