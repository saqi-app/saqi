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
            self.record(8, "Published def (cache purge pending)"),
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

    def test_explicit_publication_repair_counts_without_a_second_paid_generation(self):
        repaired = self.record(1, "Published abc (cache purge pending)")
        repaired["_SYSTEMD_UNIT"] = "saqi-publication-repair.service"
        records = [self.record(30, "Translating abc: 184 Arabic lines (gpt-6.1-sol)"), repaired]
        report = health.summarize(records, self.now, "inactive", "inactive", "inactive")
        self.assertEqual(report["publishedLast20Minutes"], 1)
        self.assertEqual(report["arabicLinesPublishedLastHour"], 184)
        self.assertEqual(report["publishedLast24Hours"], 1)

    def test_login_handoff_pause_is_maintenance_and_does_not_raise_a_timer_alarm(self):
        report = health.summarize([self.record(30, "Translating abc: 270 Arabic lines (gpt-6.1-sol)")], self.now, "activating", "inactive", "activating")
        self.assertEqual(report["status"], "maintenance")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["currentPoem"]["elapsedMinutes"], 30)

    def test_long_running_poems_and_failed_service_need_attention(self):
        report = health.summarize([self.record(61, "Translating abc: 270 Arabic lines (gpt-6.1-sol)"), self.record(5, "saqi-translate.service: Failed with result 'exit-code'.")], self.now, "activating", "inactive", "inactive")
        self.assertEqual(report["status"], "attention")
        self.assertEqual(len(report["issues"]), 3)

    def test_pool_reports_concurrent_poems_without_flagging_the_disabled_legacy_timer(self):
        snapshot = {"checkedAt": self.now.isoformat(), "concurrency": 10, "activePoems": [
            {"worker": 1, "poemId": "abc", "arabicLines": 64, "startedAt": (self.now - timedelta(minutes=12)).isoformat()},
            {"worker": 2, "poemId": "def", "arabicLines": 4, "startedAt": (self.now - timedelta(minutes=1)).isoformat()},
        ]}
        report = health.summarize([], self.now, "inactive", "inactive", "inactive", "active", snapshot)
        self.assertEqual(report["status"], "busy")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["poolConcurrency"], 10)
        self.assertEqual(len(report["activePoolPoems"]), 2)
        self.assertEqual(report["activePoolPoems"][0]["elapsedMinutes"], 12)



    def test_cache_failure_reports_attention_without_hiding_active_inference(self):
        invocation = {"worker": 1, "poemId": "abc", "arabicLines": 32, "startedAt": (self.now - timedelta(minutes=3)).isoformat()}
        snapshot = {"checkedAt": self.now.isoformat(), "concurrency": 40, "activePoems": [invocation], "pausedWorkers": [], "cacheMaintenanceError": "RIG_API_HTTP_503"}
        report = health.summarize([], self.now, "inactive", "inactive", "inactive", "active", snapshot)
        self.assertEqual(report["status"], "attention")
        self.assertEqual(report["issues"], ["public cache maintenance requires recovery; inspect pending purges"])
        self.assertEqual(report["cacheMaintenanceError"], "RIG_API_HTTP_503")
        self.assertEqual(report["activePoolPoems"], [{**invocation, "elapsedMinutes": 3}])


    def test_draining_pool_reports_inflight_paid_work_as_maintenance(self):
        invocation = {"worker": 1, "poemId": "abc", "arabicLines": 32, "model": "gpt-6.1-sol", "reasoningEffort": "xhigh", "serviceTier": "priority", "startedAt": (self.now - timedelta(minutes=3)).isoformat()}
        snapshot = {"checkedAt": self.now.isoformat(), "concurrency": 20, "stopping": True, "activePoems": [invocation], "pausedWorkers": []}
        report = health.summarize([], self.now, "inactive", "inactive", "inactive", "deactivating", snapshot)
        self.assertEqual(report["status"], "maintenance")
        self.assertEqual(report["issues"], [])
        self.assertTrue(report["poolDraining"])
        self.assertEqual(report["activePoolPoems"], [{**invocation, "elapsedMinutes": 3}])


if __name__ == "__main__":
    unittest.main()
