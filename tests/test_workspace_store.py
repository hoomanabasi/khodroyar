import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from workspace_store import WorkspaceStore


class WorkspaceStoreTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "workspace.sqlite3"
        self.store = WorkspaceStore(self.path)
        self.search = {"city": "تهران", "model": "Peugeot 206 2"}

    def test_alerts_are_deduplicated_and_private_after_restart(self):
        watch_id = self.store.save_watch("alice", "پایش ۲۰۶", self.search)
        self.assertEqual(
            self.store.save_watch("alice", "پایش دوباره", self.search), watch_id
        )
        self.assertIsNone(self.store.claim_watch(900, "bob", watch_id))
        match = {"token": "wa123456", "price": 800_000_000}
        for _ in range(2):
            watch = self.store.claim_watch(900, "alice", watch_id)
            self.store.finish_watch(watch, [match], "2026-11-26T12:00:00Z")

        reopened = WorkspaceStore(self.path)
        self.assertEqual(reopened.watches("alice")[0]["unread"], 1)
        self.assertEqual(reopened.alerts("alice")[0]["ad"], match)
        self.assertFalse(reopened.alerts("bob"))
        reopened.mark_seen("bob")
        self.assertEqual(reopened.watches("alice")[0]["unread"], 1)
        reopened.mark_seen("alice")
        self.assertEqual(reopened.watches("alice")[0]["unread"], 0)
        self.assertTrue(reopened.delete_watch("alice", watch_id))
        self.assertFalse(reopened.alerts("alice"))

    def test_expired_claim_cannot_overwrite_new_cursor(self):
        watch_id = self.store.save_watch("alice", "پایش ۲۰۶", self.search)
        with patch("workspace_store.time.time", return_value=500):
            older = self.store.claim_watch(900, "alice", watch_id)
            self.assertIsNone(self.store.claim_watch(900, "alice", watch_id))
        with patch("workspace_store.time.time", return_value=565):
            newer = self.store.claim_watch(900, "alice", watch_id)
            self.store.finish_watch(newer, [], "2026-11-26T12:00:00Z")
            self.store.finish_watch(
                older, [{"token": "wa123456"}], "2026-11-26T11:00:00Z"
            )

        self.assertEqual(
            self.store.watches("alice")[0]["cursor"], "2026-11-26T12:00:00Z"
        )
        self.assertFalse(self.store.alerts("alice"))

    def test_daily_point_and_private_tracking(self):
        self.store.tracking("alice", self.search, True)
        self.assertEqual(self.store.due_trends(), [self.search])
        self.assertFalse(self.store.tracked("bob"))
        for median in (780_000_000, 810_000_000):
            self.store.record(
                self.search, {"stats": {"price": {"n": 22, "median": median}}}
            )
        history = self.store.history(self.search)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["median"], 810_000_000)
        self.assertEqual(self.store.due_trends(), [])
