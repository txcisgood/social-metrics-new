"""Read-only Instagram HTTP transport through an already-open CDP tab.

No browser launch, navigation, cookie export, or HTTP fallback occurs here.
Only an explicitly configured loopback debugging endpoint is accepted.
"""
import json
import re
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler

from .cdp import BrowserError, PageSession
from .http import FetchError

BASE = 'https://www.instagram.com'
AUTH_PATH = re.compile(r'^/(accounts/(?:login|signup|password|onetap)|challenge|checkpoint)(/|$)')


def is_instagram_page(url):
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    return parsed.scheme == 'https' and parsed.netloc == 'www.instagram.com'


def is_usable_instagram_page(url):
    return is_instagram_page(url) and not AUTH_PATH.match(urlsplit(url).path)


def allowed_url(url):
    if not is_instagram_page(url):
        return False
    path = urlsplit(url).path
    return bool(
        re.fullmatch(r'/api/v1/users/web_profile_info/', path)
        or re.fullmatch(r'/api/v1/feed/user/[0-9]+/', path)
        or re.fullmatch(r'/api/v1/users/[A-Za-z0-9_.]+/usernameinfo/', path)
        or re.fullmatch(r'/[A-Za-z0-9_.]+/', path)
        or path == '/')


class BrowserResponse:
    def __init__(self, data):
        self.status_code = data['status']
        self.text = data.get('text', '')

    def json(self):
        return json.loads(self.text)


class InstagramBrowserSession:
    """Small requests.Session-compatible read-only adapter, attached lazily."""
    def __init__(self, port=9222):
        if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
            raise ValueError('浏览器调试端口必须在 1024 至 65535 之间')
        self.port = port
        self.page = None
        self.headers = {}

    def prepare(self):
        if self.page is not None:
            return
        # Do not send local debugging requests through a system HTTP proxy.
        opener = build_opener(ProxyHandler({}))
        try:
            with opener.open(Request(f'http://127.0.0.1:{self.port}/json/list'), timeout=5) as r:
                targets = json.load(r)
        except Exception:
            raise FetchError(
                f'无法连接本机浏览器调试端口 {self.port}。请先以独立配置启动 Edge 调试实例，'
                '在其中登录 Instagram；仅打开普通 Edge 不会自动开启调试端口') from None
        if not isinstance(targets, list):
            raise FetchError('浏览器调试端口返回了无效的标签页列表')
        needs_login = False
        connection_failed = False
        for target in targets:
            if not isinstance(target, dict) or target.get('type') != 'page':
                continue
            target_url = target.get('url', '')
            if not is_instagram_page(target_url):
                continue
            if not is_usable_instagram_page(target_url):
                needs_login = True
                continue
            ws_url = target.get('webSocketDebuggerUrl')
            if not isinstance(ws_url, str):
                continue
            try:
                ws = urlsplit(ws_url)
                valid_ws = (ws.scheme == 'ws' and ws.hostname in ('127.0.0.1', 'localhost', '::1')
                            and ws.port == self.port and not ws.username and not ws.password)
            except ValueError:
                continue
            if not valid_ws:
                continue
            if not ws.path.startswith('/devtools/page/'):
                continue
            page = None
            try:
                page = PageSession(ws_url, quiet=True)
                # A tab may have navigated or closed since /json/list was read.
                # Inspect it without navigating, and keep looking if it is stale.
                current_url = page.current_url()
                if not is_usable_instagram_page(current_url):
                    needs_login |= is_instagram_page(current_url)
                    page.close()
                    continue
            except BrowserError:
                connection_failed = True
                if page is not None:
                    page.close()
                continue
            self.page = page
            return
        if needs_login:
            raise FetchError('请先在独立浏览器中完成 Instagram 登录或账号验证，并保持首页打开')
        if connection_failed:
            raise FetchError('无法连接 Instagram 标签页，请确认独立浏览器及首页仍然打开')
        raise FetchError('调试浏览器中没有 https://www.instagram.com 标签页，请先打开并登录 Instagram')

    def get(self, url, headers=None, timeout=25, **kwargs):
        if not allowed_url(url):
            raise FetchError('浏览器采集只允许读取 Instagram 主页和账号数据接口')
        self.prepare()
        # Cookies remain in the browser. Only the app id and GET method are used;
        # callers cannot pass credentials, arbitrary scripts, or arbitrary headers.
        script = r'''(async () => {
          const url = %s;
          if (location.origin !== 'https://www.instagram.com') {
            return {error: 'Instagram 标签页已离开本站，请重新打开主页'};
          }
          if (/^\/(accounts\/(?:login|signup|password|onetap)|challenge|checkpoint)(\/|$)/.test(location.pathname)) {
            return {error: '请先在浏览器中完成 Instagram 登录或账号验证'};
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), %d);
          try {
            const response = await fetch(url, {
              method: 'GET', credentials: 'same-origin', redirect: 'error',
              headers: {'x-ig-app-id': '936619743392459'}, signal: controller.signal
            });
            const text = await response.text();
            if (text.length > 8000000) return {error: 'Instagram 返回内容过大，请减少分页数量'};
            return {status: response.status, text};
          } catch (error) {
            return {error: error.name === 'AbortError' ? '浏览器请求超时' : '浏览器请求失败或被重定向到登录验证'};
          } finally { clearTimeout(timer); }
        })()''' % (json.dumps(url), max(1, int(timeout)) * 1000)
        try:
            result = self.page.evaluate(script, await_promise=True, timeout=timeout + 5)
        except BrowserError:
            raise FetchError('浏览器调试连接中断，请确认 Instagram 标签页仍然打开') from None
        if not isinstance(result, dict) or result.get('error'):
            raise FetchError(result.get('error', '浏览器返回了无效数据') if isinstance(result, dict)
                             else '浏览器返回了无效数据')
        if not isinstance(result.get('status'), int):
            raise FetchError('浏览器返回数据缺少 HTTP 状态码')
        return BrowserResponse(result)

    def close(self):
        if self.page:
            self.page.close()
            self.page = None
