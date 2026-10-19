import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

from smetrics.http import FetchError, RateLimited
from smetrics.models import AccountRow, FetchOptions
from smetrics.platforms.instagram import InstagramFetcher, NeedSession


ACCOUNT = AccountRow(2, "test", "https://www.instagram.com/test/", "instagram")
OPTIONS = FetchOptions(["2026-08-29"], tz_name="UTC", scan_pages=3)


class InstagramHttpErrorTests(unittest.TestCase):
    def setUp(self):
        self.fetcher = InstagramFetcher(sessionid="test-session", min_delay=0,
                                        max_delay=0, quiet=True)
        self.addCleanup(self.fetcher.close)

    def response(self, status, payload=None):
        return Mock(status_code=status, json=Mock(return_value=payload or {}))

    def test_warmup_rate_limit_stops_before_profile_request(self):
        self.fetcher.session.get = Mock(return_value=self.response(429))
        self.fetcher._load_user = Mock()
        with self.assertRaises(RateLimited):
            self.fetcher.fetch(ACCOUNT, OPTIONS)
        self.fetcher.session.get.assert_called_once()
        self.fetcher._load_user.assert_not_called()
        self.assertFalse(self.fetcher._warmed)

    def test_followers_rate_limit_prevents_html_fallback(self):
        self.fetcher.session.get = Mock(return_value=self.response(429))
        with self.assertRaises(RateLimited):
            self.fetcher._followers("test")
        self.fetcher.session.get.assert_called_once()

    def test_followers_html_rate_limit_is_propagated(self):
        self.fetcher.session.get = Mock(side_effect=[self.response(404), self.response(429)])
        with self.assertRaises(RateLimited):
            self.fetcher._followers("test")
        self.assertEqual(self.fetcher.session.get.call_count, 2)

    def test_user_id_rate_limit_prevents_browser_fallback(self):
        self.fetcher.use_browser = True
        self.fetcher.session.get = Mock(return_value=self.response(429))
        self.fetcher._resolve_user_id_via_browser = Mock()
        with self.assertRaises(RateLimited):
            self.fetcher._resolve_user_id("test")
        self.fetcher.session.get.assert_called_once()
        self.fetcher._resolve_user_id_via_browser.assert_not_called()

    def test_legacy_browser_user_id_rate_limit_is_not_swallowed(self):
        self.fetcher._page = Mock()
        self.fetcher._page.evaluate.return_value = {"status": 429, "user_id": ""}
        with self.assertRaises(RateLimited):
            self.fetcher._resolve_user_id_via_browser("test")

    def test_legacy_browser_user_id_still_resolves(self):
        self.fetcher._page = Mock()
        self.fetcher._page.evaluate.return_value = {"status": 200, "user_id": "123"}
        self.assertEqual(self.fetcher._resolve_user_id_via_browser("test"), "123")

    def test_expired_profile_session_uses_current_transport_hint(self):
        for transport in ("http", "browser"):
            for status in (401, 403):
                with self.subTest(transport=transport, status=status):
                    self.fetcher.transport = transport
                    self.fetcher.session.get = Mock(return_value=self.response(status))
                    self.fetcher._feed = Mock()
                    with self.assertRaises(NeedSession) as raised:
                        self.fetcher._load_user("test")
                    hint = str(raised.exception)
                    if transport == "browser":
                        self.assertIn("独立 Edge", hint)
                        self.assertIn("重新登录", hint)
                        self.assertNotIn("复制 sessionid 的值", hint)
                    else:
                        self.assertIn("复制 sessionid 的值", hint)
                    self.fetcher._feed.assert_not_called()
                    self.fetcher.session.get.assert_called_once()

    def test_expired_feed_session_gives_browser_login_hint(self):
        self.fetcher.transport = "browser"
        self.fetcher._web_profile_info = Mock(return_value=(400, None))
        self.fetcher._resolve_user_id = Mock(return_value="123")
        for status in (401, 403):
            with self.subTest(status=status):
                self.fetcher.session.get = Mock(return_value=self.response(status))
                with self.assertRaisesRegex(NeedSession, "独立 Edge"):
                    self.fetcher._load_user("test")
                self.fetcher.session.get.assert_called_once()

    def test_expired_pagination_session_gives_browser_login_hint(self):
        self.fetcher.transport = "browser"
        self.fetcher._resolve_user_id = Mock(return_value="123")
        page = {"source": "feed", "has_more": True, "next_cursor": "next",
                "posts": [{"shortcode": "a", "ts": datetime(
                    2026, 8, 29, tzinfo=timezone.utc).timestamp()}]}
        for status in (401, 403):
            with self.subTest(status=status):
                self.fetcher._feed = Mock(return_value=(status, None))
                with self.assertRaisesRegex(NeedSession, "独立 Edge"):
                    self.fetcher._complete_timeline("test", page, OPTIONS)

    def test_login_html_is_failure_and_never_no_post(self):
        self.fetcher._warmup = Mock()
        self.fetcher._resolve_user_id = Mock(return_value="123")
        for transport in ("http", "browser"):
            with self.subTest(transport=transport):
                self.fetcher.transport = transport
                response = self.response(200)
                response.text = "<html><body>Please log in to Instagram</body></html>"
                response.json.side_effect = ValueError("not JSON")
                self.fetcher.session.get = Mock(return_value=response)
                with self.assertRaises(FetchError):
                    self.fetcher.fetch(ACCOUNT, OPTIONS)

    def test_private_empty_profile_is_failure_and_never_no_post(self):
        self.fetcher._warmup = Mock()
        self.fetcher.session.get = Mock(return_value=self.response(200, {"data": {"user": {
            "is_private": True, "edge_owner_to_timeline_media": {
                "count": 0, "edges": [], "page_info": {"has_next_page": False}}
        }}}))
        with self.assertRaisesRegex(FetchError, "私密账号"):
            self.fetcher.fetch(ACCOUNT, OPTIONS)


if __name__ == "__main__":
    unittest.main()
