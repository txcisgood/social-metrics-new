import contextlib
import io
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

import run
from smetrics.http import FetchError, QuotaExceeded
from smetrics.loader import _infer_platform
from smetrics.models import AccountRow, FetchOptions, PostMetric
from smetrics.platforms.instagram import InstagramFetcher, NeedSession
from smetrics.platforms.youtube import YouTubeFetcher

DAY = FetchOptions(['2026-08-29'], tz_name='UTC', scan_pages=3)
ACCOUNT = AccountRow(2, 'test', 'https://www.instagram.com/test/', 'instagram')


def post(code, day=29, pinned=False):
    return dict(shortcode=code, ts=datetime(2026, 8, day, tzinfo=timezone.utc).timestamp(), pinned=pinned)


def page(posts, more=True, cursor=None, source='feed'):
    return dict(posts=posts, has_more=more, next_cursor=cursor, source=source)


class InstagramRegressionTests(unittest.TestCase):
    def setUp(self):
        self.f = InstagramFetcher(min_delay=0, max_delay=0, quiet=True)
        self.addCleanup(self.f.close)
        self.f._resolve_user_id = Mock(return_value='123')

    def test_pagination_deduplicates_and_keeps_profile_followers(self):
        first = page([post('A')], source='profile')
        first['followers'] = 42
        self.f._feed = Mock(side_effect=[
            (200, page([post('A'), post('B')], cursor='next')),
            (200, page([post('B'), post('C', 28)], more=False)),
        ])
        result = self.f._complete_timeline('test', first, DAY)
        self.assertEqual([p['shortcode'] for p in result['posts']], ['A', 'B', 'C'])
        self.assertEqual(result['followers'], 42)
        self.assertEqual(self.f._feed.call_args.args[2], 'next')

    def test_pinned_old_post_does_not_stop_pagination(self):
        self.f._feed = Mock(return_value=(200, page([post('B')], more=False)))
        result = self.f._complete_timeline('test', page([post('old', 20, True), post('A')], cursor='x'), DAY)
        self.assertEqual(len(result['posts']), 3)
        self.f._feed.assert_called_once()

    def test_page_cap_never_becomes_no_post(self):
        with self.assertRaisesRegex(FetchError, '上限'):
            self.f._complete_timeline('test', page([post('new', 30)], cursor='x'),
                                      FetchOptions(['2026-08-29'], scan_pages=1))

    def test_missing_cursor_fails(self):
        with self.assertRaisesRegex(FetchError, '游标'):
            self.f._complete_timeline('test', page([post('A')]), DAY)

    def test_repeated_cursor_fails(self):
        self.f._feed = Mock(return_value=(200, page([post('B')], cursor='x')))
        with self.assertRaisesRegex(FetchError, '游标'):
            self.f._complete_timeline('test', page([post('A')], cursor='x'), DAY)

    def test_pagination_http_errors(self):
        for status in (429, 403, 500):
            with self.subTest(status=status):
                self.f._feed = Mock(return_value=(status, None))
                with self.assertRaises((FetchError, NeedSession)):
                    self.f._complete_timeline('test', page([post('A')], cursor='x'), DAY)

    def test_confirmed_empty_public_account(self):
        self.f._warmup = Mock()
        empty = dict(page([], more=False, source='profile'), total_count=0, is_private=False)
        self.f._web_profile_info = Mock(return_value=(200, empty))
        rows = self.f.fetch(ACCOUNT, DAY)
        self.assertEqual(rows[0].status, 'NO_POST')

    def test_malformed_post_fails(self):
        with self.assertRaisesRegex(FetchError, '缺少'):
            self.f._complete_timeline('test', page([dict(shortcode='', ts=1)], more=False), DAY)

    def test_invalid_delays(self):
        with self.assertRaises(ValueError):
            InstagramFetcher(min_delay=10, max_delay=2)

    def test_feed_preserves_cursor_and_pagination_metadata(self):
        from urllib.parse import urlparse, parse_qs
        self.f.session.get = Mock(return_value=Mock(status_code=200, json=Mock(return_value={
            'items': [{'code': 'A', 'taken_at': post('A')['ts'], 'media_type': 2}],
            'more_available': True, 'next_max_id': 'next',
        })))
        status, result = self.f._feed('test', '123', 'a+b/c=', include_followers=False)
        self.assertEqual(status, 200)
        self.assertEqual(result['next_cursor'], 'next')
        self.assertTrue(result['has_more'])
        self.assertEqual(parse_qs(urlparse(self.f.session.get.call_args.args[0]).query)['max_id'], ['a+b/c='])


class YouTubeRegressionTests(unittest.TestCase):
    def setUp(self):
        self.f = YouTubeFetcher('fake')
        self.addCleanup(self.f.close)
        self.f.http.get_json = Mock()
        self.start = datetime(2026, 8, 29, tzinfo=timezone.utc)

    def item(self, vid, timestamp='2026-08-29T12:00:00Z'):
        return {'contentDetails': {'videoId': vid, 'videoPublishedAt': timestamp}}

    def test_page_cap_fails(self):
        self.f.http.get_json.return_value = {'items': [self.item('a')], 'nextPageToken': 'n'}
        with self.assertRaisesRegex(FetchError, '上限'):
            self.f._scan_playlist('p', self.start, 1)

    def test_multiple_pages_deduplicate(self):
        self.f.http.get_json.side_effect = [
            {'items': [self.item('a')], 'nextPageToken': 'n'},
            {'items': [self.item('a'), self.item('b')]},
        ]
        self.assertEqual(len(self.f._scan_playlist('p', self.start, 2)), 2)
        self.assertEqual(self.f.http.get_json.call_args.args[1]['pageToken'], 'n')

    def test_playlist_insertion_date_is_not_publish_date(self):
        self.f.http.get_json.return_value = {'items': [
            {'contentDetails': {'videoId': 'private'}, 'snippet': {'publishedAt': '2026-08-29T12:00:00Z'}}]}
        self.assertEqual(self.f._scan_playlist('p', self.start, 1), [])

    def test_missing_video_details_is_failure(self):
        self.f._resolve_channel_id = Mock(return_value=('channel', ''))
        self.f._channel_info = Mock(return_value=('uploads', 10))
        self.f._scan_playlist = Mock(return_value=[dict(video_id='gone', published_utc=self.start)])
        self.f._video_stats = Mock(return_value={})
        rows = self.f.fetch(AccountRow(2, 'yt', 'https://youtube.com/@test', 'youtube'), DAY)
        self.assertEqual(rows[0].status, 'FAILED')

    def test_dst_window(self):
        from smetrics.platforms.youtube import _window
        from zoneinfo import ZoneInfo
        start, end = _window(['2026-03-29'], ZoneInfo('Europe/London'))
        self.assertEqual((end-start).total_seconds(), 23*3600)


class RunnerRegressionTests(unittest.TestCase):
    def test_quota_stops_only_youtube_and_records_all_accounts(self):
        accounts = [AccountRow(i, str(i), 'https://example.com', p)
                    for i, p in enumerate(['youtube', 'youtube', 'instagram'], 2)]
        yt, ig = Mock(), Mock()
        yt.fetch.side_effect = QuotaExceeded('quota')
        yt.http.api_calls = ig.http.api_calls = 0
        ig.fetch.return_value = [PostMetric(4, '4', 'instagram', 'url', status='NO_POST')]
        with tempfile.TemporaryDirectory() as out:
            args = SimpleNamespace(config=None, tz='UTC', date='2026-08-29', days=1,
                input='unused.csv', platform=None, scan_pages=3, no_shorts_check=True,
                delay=0, out=out, no_fill_back=True)
            with patch.object(run, 'parse_args', return_value=args), \
                 patch.object(run, 'load_config', return_value={}), \
                 patch.object(run, 'load_accounts', return_value=(accounts, [])), \
                 patch.object(run, 'build_fetchers', return_value={'youtube': yt, 'instagram': ig}), \
                 patch.object(run.writer, 'write_excel') as excel, \
                 patch.object(run.writer, 'write_jsonl'), \
                 patch.object(run.writer, 'print_summary'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(run.main(), 2)
            self.assertEqual([r.status for r in excel.call_args.args[0]], ['FAILED', 'FAILED', 'NO_POST'])
            yt.fetch.assert_called_once()
            ig.fetch.assert_called_once()
            yt.close.assert_called_once()

    def test_rate_limit_is_platform_stop_signal(self):
        from smetrics.http import RateLimited
        f = InstagramFetcher(min_delay=0, max_delay=0, quiet=True)
        self.addCleanup(f.close)
        f._web_profile_info = Mock(return_value=(429, None))
        with self.assertRaises(RateLimited):
            f._load_user('test')

    def test_facebook_not_supported(self):
        self.assertEqual(run.SUPPORTED, {'youtube', 'instagram'})

    def test_missing_key_does_not_abort_fetcher_construction(self):
        args = SimpleNamespace(api_key=None, timeout=10)
        account = AccountRow(2, 'yt', 'url', 'youtube')
        with patch.dict('os.environ', {}, clear=True):
            fetchers = run.build_fetchers(args, {}, [account])
        with self.assertRaisesRegex(FetchError, 'API Key'):
            fetchers['youtube'].fetch(account, DAY)

    def test_unrelated_domain_not_classified_by_path(self):
        self.assertEqual(_infer_platform('https://example.com/instagram.com/test'), '')
        self.assertEqual(_infer_platform('https://fakeinstagram.com/test'), '')

    def test_invalid_dates(self):
        for date in ('2026-02-30', ',,', '2026-1-1'):
            with self.subTest(date=date), self.assertRaises(ValueError):
                run.resolve_dates(SimpleNamespace(date=date, days=1), timezone.utc)


if __name__ == '__main__':
    unittest.main()
