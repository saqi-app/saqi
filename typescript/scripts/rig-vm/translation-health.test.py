from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("translation_health", Path(__file__).with_name("translation-health.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class TranslationHealthTests(unittest.TestCase):
    now = datetime(2026, 10, 6, 14, tzinfo=timezone.utc)

    def record(self, minutes_ago, message):
        return {"__REALTIME_TIMESTAMP": str(int((self.now - timedelta(minutes=minutes_ago)).timestamp() * 1_000_000)), "MESSAGE": message}

    def test_reports_unique_completions_lines_and_latency_in_the_correct_windows(self):
        records = [
            self.record(40, "Translating abc: 10 Arabic lines (gpt-6.1-sol)"),
            self.record(35, "Published abc"),
            self.record(10, "Translating def: 20 Arabic lines (gpt-6.1-sol)"),
            self.record(8, "Published def"),
            self.record(8, "Published def"),
            self.record(7, "unrelated private diagnostic"),
        ]
        report = health.summarize(records, self.now, "inactive", "active", "inactive")
        self.assertEqual(report["publishedLast20Minutes"], 1)
        self.assertEqual(report["publishedLastHour"], 2)
        self.assertEqual(report["arabicLinesPublishedLastHour"], 30)
        self.assertEqual(report["medianGenerationAndPublicationSecondsLastHour"], 210)
        self.assertEqual(report["status"], "idle")
        self.assertNotIn("private", str(report))

    def test_login_handoff_pause_is_maintenance_and_does_not_raise_a_timer_alarm(self):
        report = health.summarize([self.record(30, "Translating abc: 270 Arabic lines (gpt-6.1-sol)")], self.now, "activating", "inactive", "activating")
        self.assertEqual(report["status"], "maintenance")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["currentPoem"]["elapsedMinutes"], 30)

    def test_long_running_poems_and_failed_service_need_attention(self):
        report = health.summarize([self.record(61, "Translating abc: 270 Arabic lines (gpt-6.1-sol)"), self.record(5, "saqi-translate.service: Failed with result 'exit-code'.")], self.now, "activating", "inactive", "inactive")
        self.assertEqual(report["status"], "attention")
        self.assertEqual(len(report["issues"]), 3)


if __name__ == "__main__":
    unittest.main()
