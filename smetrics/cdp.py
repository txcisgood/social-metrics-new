"""通过 Chrome DevTools Protocol 控制一个独立的 Chrome 实例。

为什么要独立实例：用户日常那个 Chrome 一直开着，同一个 profile 目录不能被两个进程同时占用，
强行复用会导致启动失败或者要求用户退出浏览器。所以这里用一个专属的 user-data-dir，
用户在里面登录一次 Instagram / Facebook，登录态就长期留着，跟日常浏览器互不干扰。

为什么用 CDP 而不是 Playwright：只需要「在已登录的页面里执行一段 fetch」这一个能力，
CDP 的 Runtime.evaluate 就够了，省掉 Playwright 上百 MB 的驱动依赖。

Instagram / Facebook 的接口都要求登录态和一堆签名头，但只要请求是从站内页面发出的，
浏览器会自动带上 cookie 和正确的同源上下文，我们就不用自己算签名。
"""

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

import websocket


DEFAULT_PORT = 9222
DEFAULT_PROFILE = os.path.expanduser("~/.social-metrics/chrome-profile")
MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class BrowserError(Exception):
    pass


class NeedLogin(Exception):
    """需要用户在弹出的窗口里手动登录。"""


class ChromeSession:
    def __init__(self, port: int = DEFAULT_PORT, profile_dir: str = None,
                 chrome_path: str = None, headless: bool = False, quiet: bool = False):
        self.port = port
        self.profile_dir = profile_dir or DEFAULT_PROFILE
        self.chrome_path = chrome_path or _find_chrome()
        self.headless = headless
        self.quiet = quiet
        self.proc = None
        self._launched = False

    # ---------- 生命周期 ----------

    def start(self, start_url: str = "about:blank") -> None:
        if _port_open(self.port):
            # 已经有一个带调试端口的 Chrome 在跑，直接复用
            if not self.quiet:
                print(f"  复用已在 {self.port} 端口监听的 Chrome 实例")
            return

        if not self.chrome_path or not os.path.exists(self.chrome_path):
            raise BrowserError("找不到 Google Chrome，请在 config.json 里用 chrome_path 指定可执行文件路径")

        os.makedirs(self.profile_dir, exist_ok=True)
        args = [
            self.chrome_path,
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={self.profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--window-size=1280,900",
        ]
        if self.headless:
            args.append("--headless=new")
        args.append(start_url)

        if not self.quiet:
            print(f"  启动独立 Chrome 实例（profile: {self.profile_dir}）")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self._launched = True

        for _ in range(60):
            if _port_open(self.port):
                time.sleep(0.8)   # 端口通了之后再给它一点时间把 target 建好
                return
            if self.proc.poll() is not None:
                raise BrowserError("Chrome 启动后立刻退出了，检查 profile 目录权限")
            time.sleep(0.5)
        raise BrowserError(f"等了 30 秒，Chrome 的调试端口 {self.port} 还没起来")

    def close(self, keep_open: bool = True) -> None:
        """默认不关浏览器，方便用户下次复用登录态；只在明确要求时才结束进程。"""
        if keep_open or not self._launched or not self.proc:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass

    # ---------- 页面 ----------

    def open_page(self, url: str, reuse_host: str = None) -> "PageSession":
        """打开（或复用）一个页面。reuse_host 命中时复用已有标签页，避免开一堆窗口。"""
        target = None
        if reuse_host:
            for t in self._targets():
                if t.get("type") == "page" and reuse_host in (t.get("url") or ""):
                    target = t
                    break
        if target is None:
            target = self._new_target(url)

        page = PageSession(target["webSocketDebuggerUrl"], quiet=self.quiet)
        current = target.get("url") or ""
        if reuse_host and reuse_host in current:
            page.wait_ready()
            # 标签页可能在我们拿到列表之后又跳走了，落地校验一次
            if reuse_host not in page.current_url():
                page.navigate(url)
        else:
            page.navigate(url)
        return page

    def _targets(self) -> list:
        try:
            return json.loads(_http_get(f"http://127.0.0.1:{self.port}/json"))
        except Exception as e:
            raise BrowserError(f"读取 Chrome 标签页列表失败：{e}")

    def _new_target(self, url: str) -> dict:
        # 新版 Chrome 的 /json/new 只接受 PUT
        for method in ("PUT", "GET"):
            try:
                body = _http_get(f"http://127.0.0.1:{self.port}/json/new?{urllib.parse.quote(url, safe=':/?=&')}",
                                 method=method)
                t = json.loads(body)
                if t.get("webSocketDebuggerUrl"):
                    return t
            except Exception:
                continue
        # 兜底：复用第一个 page 类型的标签页
        for t in self._targets():
            if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                return t
        raise BrowserError("无法创建或找到可用的浏览器标签页")


class PageSession:
    def __init__(self, ws_url: str, quiet: bool = False):
        self.quiet = quiet
        try:
            self.ws = websocket.create_connection(ws_url, timeout=60,
                                                  suppress_origin=True, enable_multithread=True)
        except Exception as e:
            raise BrowserError(f"连接页面调试通道失败：{e}")
        self._id = 0

    def _send(self, method: str, params: dict = None, timeout: int = 60):
        self._id += 1
        msg_id = self._id
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(1, deadline - time.time()))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception as e:
                raise BrowserError(f"调试通道断开：{e}")
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if data.get("id") != msg_id:
                continue          # 事件消息，跳过
            if "error" in data:
                raise BrowserError(f"{method} 失败：{data['error'].get('message')}")
            return data.get("result", {})
        raise BrowserError(f"{method} 超时（{timeout}s）")

    def navigate(self, url: str, timeout: int = 45) -> None:
        self._send("Page.navigate", {"url": url}, timeout=timeout)
        self.wait_navigated(url, timeout=timeout)

    def wait_navigated(self, expect_url: str, timeout: int = 45) -> None:
        """Page.navigate 只是发起导航就返回，而旧文档的 readyState 本来就是 complete，
        所以必须盯住真实的 location.href 落到目标 origin，否则脚本会跑在旧文档里。"""
        expect_origin = _origin_of(expect_url)
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            try:
                last = self.evaluate("location.href", await_promise=False, timeout=10) or ""
                state = self.evaluate("document.readyState", await_promise=False, timeout=10)
                if not expect_origin:
                    if state == "complete":
                        return
                elif last.startswith(expect_origin) and state in ("interactive", "complete"):
                    return
            except BrowserError:
                pass
            time.sleep(0.5)
        raise BrowserError(f"导航到 {expect_url} 超时，当前停在 {last or '未知页面'}")

    def wait_ready(self, timeout: int = 45) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                state = self.evaluate("document.readyState", await_promise=False, timeout=10)
                if state in ("interactive", "complete"):
                    return
            except BrowserError:
                pass
            time.sleep(0.5)

    def evaluate(self, expression: str, await_promise: bool = True, timeout: int = 60):
        result = self._send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": await_promise,
            "returnByValue": True,
            "userGesture": True,
        }, timeout=timeout)
        if result.get("exceptionDetails"):
            desc = (result["exceptionDetails"].get("exception") or {}).get("description") \
                   or result["exceptionDetails"].get("text") or "页面内脚本报错"
            raise BrowserError(desc.split("\n")[0])
        return (result.get("result") or {}).get("value")

    def current_url(self) -> str:
        try:
            return self.evaluate("location.href", await_promise=False, timeout=10) or ""
        except BrowserError:
            return ""

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


# ---------- 工具 ----------

def _find_chrome() -> str:
    if os.path.exists(MAC_CHROME):
        return MAC_CHROME
    for name in ("google-chrome", "chromium", "chrome"):
        path = shutil.which(name)
        if path:
            return path
    return ""


def _origin_of(url: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme in ("http", "https") and parts.netloc:
            return f"{parts.scheme}://{parts.netloc}"
    except Exception:
        pass
    return ""


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _http_get(url: str, method: str = "GET") -> str:
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8", "replace")
