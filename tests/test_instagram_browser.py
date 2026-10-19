import json
import os
import unittest
from io import BytesIO
from unittest.mock import Mock, patch

from smetrics.cdp import BrowserError, PageSession
from smetrics.http import FetchError
from smetrics.instagram_browser import InstagramBrowserSession, allowed_url, is_instagram_page
from smetrics.platforms.instagram import InstagramFetcher


class BrowserTransportTests(unittest.TestCase):
    def test_target_host_is_exact(self):
        for url in ['https://www.instagram.com.evil.test/', 'https://evil.test/www.instagram.com',
                    'http://www.instagram.com/', 'https://user@www.instagram.com/']:
            self.assertFalse(is_instagram_page(url))
        self.assertTrue(is_instagram_page('https://www.instagram.com/team_foxer/'))

    def test_endpoint_allowlist(self):
        for url in ['https://www.instagram.com/api/v1/direct_v2/inbox/',
                    'https://www.instagram.com/api/v1/web/likes/1/like/',
                    'https://example.com/']:
            self.assertFalse(allowed_url(url))
        self.assertTrue(allowed_url('https://www.instagram.com/api/v1/feed/user/123/?max_id=a'))

    def test_fetch_is_browser_get_and_returns_status(self):
        session = InstagramBrowserSession()
        session.page = Mock()
        session.page.evaluate.return_value = {'status': 200, 'text': '{"data":{"user":null}}'}
        response = session.get('https://www.instagram.com/api/v1/users/web_profile_info/?username=test')
        self.assertEqual(response.json(), {'data': {'user': None}})
        script = session.page.evaluate.call_args.args[0]
        self.assertIn("method: 'GET'", script)
        self.assertIn("credentials: 'same-origin'", script)
        self.assertNotIn('document.cookie', script)
        session.close()

    def test_429_reaches_existing_rate_limit_handler(self):
        session = InstagramBrowserSession()
        session.page = Mock()
        session.page.evaluate.return_value = {'status': 429, 'text': '{}'}
        f = InstagramFetcher(transport='browser', min_delay=0, max_delay=0, quiet=True)
        f.session = session
        self.addCleanup(f.close)
        from smetrics.http import RateLimited
        with self.assertRaises(RateLimited):
            f._load_user('test')

    def test_login_or_closed_tab_failure_is_not_no_post(self):
        session = InstagramBrowserSession()
        session.page = Mock()
        for result in (None, {}, {'error': '请先登录'}):
            session.page.evaluate.return_value = result
            with self.assertRaises(FetchError):
                session.get('https://www.instagram.com/test/')

    def test_credentials_stay_in_browser(self):
        f = InstagramFetcher(sessionid='do-not-export', transport='browser')
        self.addCleanup(f.close)
        self.assertEqual(f.sessionid, '')
        self.assertTrue(f.has_session)
        self.assertIsInstance(f.session, InstagramBrowserSession)

    def test_browser_transport_cannot_launch_legacy_browser_fallback(self):
        f = InstagramFetcher(transport='browser', use_browser=True)
        self.addCleanup(f.close)
        self.assertFalse(f.use_browser)

    def test_prepare_does_not_launch_browser(self):
        session = InstagramBrowserSession()
        with patch('smetrics.instagram_browser.build_opener') as opener:
            opener.return_value.open.side_effect = OSError('offline')
            with self.assertRaisesRegex(FetchError, '调试端口'):
                session.prepare()

    def test_rejects_nonlocal_websocket(self):
        session = InstagramBrowserSession()
        targets = [{'type':'page', 'url':'https://www.instagram.com/',
                    'webSocketDebuggerUrl':'ws://external.test:9222/devtools/page/1'}]
        with patch('smetrics.instagram_browser.build_opener') as opener:
            opener.return_value.open.return_value = BytesIO(json.dumps(targets).encode())
            with self.assertRaisesRegex(FetchError, '没有'):
                session.prepare()

    def test_skips_login_and_verification_tabs_for_content_page(self):
        paths = ['/accounts/login/', '/accounts/signup/', '/accounts/password/reset/',
                 '/accounts/onetap/', '/challenge/123/', '/checkpoint/']
        targets = [{'type': 'page', 'url': 'https://www.instagram.com' + path,
                    'webSocketDebuggerUrl': f'ws://127.0.0.1:9222/devtools/page/{i}'}
                   for i, path in enumerate(paths)]
        home_ws = 'ws://127.0.0.1:9222/devtools/page/home'
        targets.append({'type': 'page', 'url': 'https://www.instagram.com/',
                        'webSocketDebuggerUrl': home_ws})
        with patch('smetrics.instagram_browser.build_opener') as opener, \
             patch('smetrics.instagram_browser.PageSession') as page_factory:
            opener.return_value.open.return_value = BytesIO(json.dumps(targets).encode())
            page_factory.return_value.current_url.return_value = 'https://www.instagram.com/'
            session = InstagramBrowserSession()
            session.prepare()
            page_factory.assert_called_once_with(home_ws, quiet=True)
            self.assertIs(session.page, page_factory.return_value)
            page_factory.return_value.navigate.assert_not_called()
            session.close()

    def test_only_login_tab_reports_login_instead_of_connecting(self):
        targets = [{'type': 'page', 'url': 'https://www.instagram.com/accounts/login/',
                    'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/login'}]
        with patch('smetrics.instagram_browser.build_opener') as opener, \
             patch('smetrics.instagram_browser.PageSession') as page_factory:
            opener.return_value.open.return_value = BytesIO(json.dumps(targets).encode())
            with self.assertRaisesRegex(FetchError, '完成 Instagram 登录'):
                InstagramBrowserSession().prepare()
            page_factory.assert_not_called()

    def test_tries_next_tab_when_first_closed_or_navigated(self):
        targets = [{'type': 'page', 'url': 'https://www.instagram.com/',
                    'webSocketDebuggerUrl': f'ws://127.0.0.1:9222/devtools/page/{i}'}
                   for i in range(2)]
        for first in [BrowserError('closed'), Mock()]:
            with self.subTest(first=type(first).__name__), \
                 patch('smetrics.instagram_browser.build_opener') as opener, \
                 patch('smetrics.instagram_browser.PageSession') as page_factory:
                if isinstance(first, Mock):
                    first.current_url.return_value = 'https://www.instagram.com/challenge/123/'
                good = Mock()
                good.current_url.return_value = 'https://www.instagram.com/'
                opener.return_value.open.return_value = BytesIO(json.dumps(targets).encode())
                page_factory.side_effect = [first, good]
                session = InstagramBrowserSession()
                session.prepare()
                self.assertIs(session.page, good)
                self.assertEqual(page_factory.call_count, 2)
                if isinstance(first, Mock):
                    first.close.assert_called_once()
                session.close()

    def test_browser_mode_warmup_does_not_issue_http(self):
        f = InstagramFetcher(transport='browser', quiet=True)
        self.addCleanup(f.close)
        f.session = Mock()
        f._warmup()
        f.session.prepare.assert_called_once()
        f.session.get.assert_not_called()


class LocalCdpTests(unittest.TestCase):
    def test_loopback_websocket_ignores_environment_proxy(self):
        from websocket._http import connect as connect_socket, proxy_info
        for host in ['127.0.0.1', 'localhost', '::1']:
            netloc = f'[{host}]' if ':' in host else host
            ws_url = f'ws://{netloc}:9222/devtools/page/test'
            with self.subTest(host=host), \
                 patch.dict(os.environ, {'http_proxy': 'http://proxy.example.test:8080'}, clear=True), \
                 patch('smetrics.cdp.socket.create_connection') as direct_connect, \
                 patch('smetrics.cdp.websocket.create_connection') as connect, \
                 patch('websocket._http._get_addrinfo_list') as resolve:
                page = PageSession(ws_url)
                direct_connect.assert_called_once_with((host, 9222), timeout=60)
                options = connect.call_args.kwargs
                self.assertIs(options['socket'], direct_connect.return_value)
                actual_socket, _ = connect_socket(ws_url, Mock(), proxy_info(**options), options['socket'])
                self.assertIs(actual_socket, direct_connect.return_value)
                resolve.assert_not_called()
                page.close()

    def test_closed_socket_send_is_reported_as_browser_error(self):
        import websocket
        with patch('smetrics.cdp.socket.create_connection'), \
             patch('smetrics.cdp.websocket.create_connection') as connect:
            connect.return_value.send.side_effect = websocket.WebSocketConnectionClosedException('closed')
            page = PageSession('ws://127.0.0.1:9222/devtools/page/test')
            with self.assertRaisesRegex(BrowserError, '调试通道断开'):
                page.evaluate('location.href')
            page.close()

    def test_failed_websocket_handshake_closes_direct_socket(self):
        with patch('smetrics.cdp.socket.create_connection') as direct_connect, \
             patch('smetrics.cdp.websocket.create_connection', side_effect=OSError('closed')):
            with self.assertRaises(BrowserError):
                PageSession('ws://127.0.0.1:9222/devtools/page/test')
            direct_connect.return_value.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
