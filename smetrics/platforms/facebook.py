"""Facebook 采集器 —— 接管已登录的 Edge/Chrome。

## 为什么必须借助浏览器

2026 年的 Facebook 拒绝所有匿名 HTTP 请求（实测）：
- www 桌面版纯 requests 直接 400（TLS 指纹被识破）；
- mbasic 轻量版匿名 302 到登录页，连 datr 设备 cookie 都绕不过去；
- mbasic 现在对所有带 cookie 的 UA 都会重定向到 www 版。

唯一可行的路：让用户用自己已登录的 Edge 打开一次 Facebook 主页，然后程序接管那个
标签页（CDP），从页面内嵌的 JSON 里提取数据。cookie 不需要导出，登录态直接复用。

## 使用方式

1. 在 PyCharm 终端或外部 shell 执行 `./start_edge_debug.sh` 启动带调试端口的 Edge
   （你的真实 Profile，登录态保留）。
2. Edge 启动后**手动在标签页里打开一个 Facebook 主页**（如你的账号时间线），
   让 Facebook 发一次请求确认登录有效（这一步会把首页 cookie 写盘）。
3. 跑 run.py。程序会自动从 9222 端口找到一个已经打开过 Facebook 的标签页 attach 上去。
4. 跑完用 `pkill -x "Microsoft Edge"` 关闭调试实例，再正常启动 Edge。

## 数据口径

- Likes 列填的是 reactions 总数（含赞/爱心/哈哈等全部表情）；
- 评论数来自帖子 JSON 的 `comments.total_count`，与前台显示一致；
- 帖子文本取自 JSON `message.text`，最可靠。

## 时间戳

每条帖子的 `creation_time` 是 Unix 秒（UTC），按用户时区转换判定「当天」。
"""

import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .base import BaseFetcher
from ..http import FetchError
from ..models import PostMetric, STATUS_OK, STATUS_NO_POST, date_label

# ---- CDP 调试端口探测 ----
DEBUG_PORT = 9222


class NeedLogin(Exception):
    """未找到可用的已登录浏览器标签页。"""


class FacebookFetcher(BaseFetcher):
    platform = "facebook"
    display_name = "Facebook"

    def __init__(self, min_delay: float = 5.0, max_delay: float = 10.0,
                 quiet: bool = False, **_):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.quiet = quiet
        self.api_calls = 0
        self._last_call = 0.0
        self._announced = False

    # ---------- 主流程 ----------

    def fetch(self, account, options) -> list:
        self._announce()
        tz = ZoneInfo(options.tz_name)
        target = account.url

        sys.path = _ensure_path()
        from smetrics.cdp import PageSession

        # 1. 找到一个已打开过 Facebook 的标签页，attach 上去复用登录态
        targets = _list_targets()
        fb_tgt = _pick_facebook_target(targets)
        if fb_tgt is None:
            raise NeedLogin(
                "未在 9222 端口找到已登录的 Facebook 标签页。"
                "请先执行 ./start_edge_debug.sh，然后在 Edge 里手动打开一次 Facebook 主页，"
                "确保登录有效后再跑。")

        page = PageSession(fb_tgt["webSocketDebuggerUrl"], quiet=True)
        try:
            page.wait_ready(timeout=40)
            page.navigate(target, timeout=60)
            page.wait_ready(timeout=60)
            time.sleep(6)  # 等 React 渲染
            html = page.evaluate("document.documentElement.outerHTML",
                                 await_promise=False, timeout=30)
        except Exception as e:
            page.close()
            raise FetchError(f"Edge 标签页通信失败：{type(e).__name__}: {e}")

        self.api_calls += 1
        # 检测是否被踢到登录页
        cur_url = page.current_url() if hasattr(page, "current_url") else ""
        if "login" in (cur_url or "").lower() or "/checkpoint/" in (cur_url or "").lower():
            page.close()
            raise NeedLogin(
                "Edge 当前标签页被 Facebook 重定向到登录页，登录态可能已失效。"
                "请在 Edge 里重新登录 Facebook 后再跑。")

        posts, followers = _parse_page(html)
        page.close()

        if not posts:
            # 主页能打开但一条内容都没解析到（个人页时间线对非好友隐藏 / Edge 用户不是好友）
            # 绝不能当成"当天无发布"，避免静默错误数据
            raise FetchError(
                "主页能打开但没解析到任何帖子。可能是："
                "1) Edge 登录账号与该主页不是好友，时间线对非好友隐藏；"
                "2) Facebook 改了 HTML 结构（解析器需要更新）。"
                "请手动打开链接确认：" + target)

        self._throttle()

        posts.sort(key=lambda p: p["ts"], reverse=True)
        target_dates = set(options.target_dates)
        hits = [p for p in posts
                if datetime.fromtimestamp(p["ts"], timezone.utc)
                .astimezone(tz).strftime("%Y-%m-%d") in target_dates]

        base = dict(
            row_no=account.row_no,
            account_name=account.name,
            platform=self.platform,
            profile_url=account.url,
            target_date=date_label(options.target_dates),
            channel_id=_page_key(target),
            follower_count=followers if followers is not None else "未公开",
            fetched_at=datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S"),
        )
        note = account.note

        if not hits:
            latest = posts[0]
            local = datetime.fromtimestamp(latest["ts"], timezone.utc).astimezone(tz)
            hint = f"最近一条发布于 {local.strftime('%Y-%m-%d %H:%M')}"
            return [PostMetric(status=STATUS_NO_POST,
                               extra={"提示": hint, "备注": note}, **base)]

        results = []
        for p in hits:
            published = datetime.fromtimestamp(p["ts"], timezone.utc)
            extra_note = (note + " 点赞数为 reactions 总数（含全部表情）").strip()
            results.append(PostMetric(
                status=STATUS_OK,
                post_title=p["title"] or "（无文字）",
                post_url=p["url"],
                published_local=published.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S"),
                published_utc=published.strftime("%Y-%m-%d %H:%M:%S UTC"),
                post_type=p["type"],
                view_count="",
                like_count=p.get("reactions"),
                comment_count=p.get("comments"),
                error="",
                extra={"备注": extra_note, "时长": ""},
                **base,
            ))
        return results

    # ---------- 辅助 ----------

    def _announce(self) -> None:
        if self._announced or self.quiet:
            return
        print("  Facebook：接管已登录 Edge（9222 端口）")
        self._announced = True

    def _throttle(self) -> None:
        elapsed = time.time() - self._last_call
        wait = random_uniform(self.min_delay, self.max_delay) - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def close(self):
        pass


# ---------- 标签页查找 ----------

def _ensure_path():
    import os, sys
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    return sys.path


def _list_targets() -> list:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return []


def _pick_facebook_target(targets: list):
    """挑一个 page 类型的 facebook.com 标签页，优先带正确域名的。"""
    candidates = [t for t in targets
                  if t.get("type") == "page"
                  and t.get("webSocketDebuggerUrl")
                  and "facebook.com" in (t.get("url") or "")]
    # 优先挑 url 是 m.facebook 或 www 的（已经登录态），跳过 about:blank
    return candidates[0] if candidates else None


# ---------- 解析 ----------

def _parse_page(html: str) -> tuple:
    """从 www.facebook.com 主页 HTML 里提取帖子和粉丝数。

    帖子数据来自页面内嵌的 JSON：
    {"post_id":"...","creation_time":1756380000,
     "message":{"text":"..."},
     "reaction_count":{"count":N},
     "comments":{"total_count":N},
     "share_count":{"count":N}}
    """
    posts = []
    # 帖子对象：含 creation_time 的 JSON 块（post_id 可能在它前面很近的位置）。
    # block 取到下一个 "post_id" 出现为止，避免吃到下一条帖子的 reaction。
    for m in re.finditer(
            r'\{\s*"post_id"\s*:\s*"(\d{15,18})"[^}]{0,20000}?"creation_time"\s*:\s*(\d{9,11})',
            html):
        post_id = m.group(1)
        ts_val = int(m.group(2))
        block = html[m.start(): m.start() + 25000]
        next_pid = re.search(r'\{"post_id"\s*:\s*"\d{15,18}"', block[200:])
        if next_pid:
            block = block[:200 + next_pid.start()]
        if post_id in {p["post_id"] for p in posts}:
            continue
        text = _extract_message(block)
        reactions = _extract_int(block, r'"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)')
        comments = _extract_int(block, r'"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)')
        shares = _extract_int(block, r'"share_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)')
        posts.append({
            "post_id": post_id,
            "ts": ts_val,
            "title": text[:300],
            "url": _build_post_url(post_id),
            "type": _guess_type(text, shares),
            "reactions": reactions,
            "comments": comments,
            "shares": shares,
        })

    # 粉丝数：取最近一次出现的 follower_count
    followers = None
    fb_matches = list(re.finditer(r'"follower_count"\s*:\s*(\d+)', html))
    if fb_matches:
        followers = int(fb_matches[0].group(1))

    return posts, followers


def _extract_message(block: str) -> str:
    m = re.search(r'"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
    return m.group(1).encode().decode("unicode_escape", errors="ignore") if m else ""


def _extract_int(block: str, pattern: str):
    m = re.search(pattern, block)
    return int(m.group(1)) if m else None


def _build_post_url(post_id: str) -> str:
    return f"https://www.facebook.com/{post_id}"


def _guess_type(text: str, shares) -> str:
    if shares:
        return "帖子（含转发）"
    return "帖子"


def _page_key(url: str) -> str:
    """账号标识：从链接里抽数字 id 或 vanity 名。"""
    from urllib.parse import urlparse, parse_qs
    u = urlparse(url.strip())
    if u.path.rstrip("/").endswith("/profile.php"):
        return (parse_qs(u.query).get("id") or [""])[0]
    segments = [s for s in u.path.split("/") if s]
    return segments[0] if segments else ""


def random_uniform(a: float, b: float) -> float:
    import random
    return random.uniform(a, b)