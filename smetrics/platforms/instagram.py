"""Instagram 采集器 —— 纯 HTTP 为主，浏览器为可选兜底。

## 为什么不用浏览器

实测：纯 requests 匿名请求 web_profile_info，15 个账号里 12 个直接返回完整数据
（12 条作品 + 精确粉丝数）。浏览器不是必需的，登录也不是必需的。

## 三条路径，按成本从低到高

1. 主路径：GET web_profile_info。匿名可用，一次请求拿到粉丝数和前 12 条作品。
2. 兜底一：部分账号主接口恒返回 400（Instagram 服务端自己的 bug，错误信息是
   ig_business_category_subvertical 资产被删；换 UA、换 i.instagram.com 域名都一样）。
   这时改走 /api/v1/feed/user/{user_id}/，匿名同样可用。
   难点在于拿 user_id —— 匿名 HTML 里没有，能查 id 的接口都要求登录。
   但 user_id 永久不变，所以缓存一次就够了，缓存文件 .cache/ig_user_ids.json。
3. 兜底二：年龄限制的账号匿名读不到内容（接口返回空而不是报错，这点很坑）。
   这类账号需要登录态，在 config.json 里填一个 sessionid 即可，仍然不需要浏览器。

浏览器路径（--use-browser）只在一种场景下有价值：既没有 sessionid、又要为新账号
解析 user_id。日常跑不需要它。
"""

import json
import os
import random
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import requests

from .base import BaseFetcher
from ..http import FetchError
from ..models import PostMetric, STATUS_OK, STATUS_NO_POST, date_label

IG_APP_ID = "936619743392459"          # 网页版 Instagram 自己用的固定 app id
BASE = "https://www.instagram.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SKIP_SEGMENTS = {"p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct"}

# 已知会触发 Instagram 400 bug 的账号，user_id 是查证过的固定值，作为缓存种子
SEED_USER_IDS = {
    "alischwind": "194799910",
    "huntergatherercooking": "12853634038",
    "shootinggirl_with_an_afro": "48692393846",
}


class NeedSession(Exception):
    """需要 sessionid 才能继续，附带可操作的指引。"""


class InstagramFetcher(BaseFetcher):
    platform = "instagram"
    display_name = "Instagram"

    def __init__(self, sessionid: str = None, cache_path: str = None,
                 min_delay: float = 2.5, max_delay: float = 5.0,
                 use_browser: bool = False, timeout: int = 25, quiet: bool = False):
        self.sessionid = (sessionid or "").strip()
        self.cache_path = cache_path
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.use_browser = use_browser
        self.timeout = timeout
        self.quiet = quiet
        self.api_calls = 0
        self._last_call = 0.0
        self._browser = None
        self._page = None

        self._ids = dict(SEED_USER_IDS)
        self._ids.update(_load_cache(cache_path))

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "x-ig-app-id": IG_APP_ID,
        })
        if self.sessionid:
            self.session.cookies.set("sessionid", self.sessionid, domain=".instagram.com")
        self._warmed = False

    # ---------- 准备 ----------

    def _warmup(self) -> None:
        """先访问一次首页拿 csrftoken / mid，匿名请求也需要这些基础 cookie。"""
        if self._warmed:
            return
        try:
            self.session.get(BASE + "/", timeout=self.timeout)
            self.api_calls += 1
        except requests.RequestException:
            pass
        self._warmed = True
        if not self.quiet:
            mode = "已带 sessionid" if self.sessionid else "匿名"
            print(f"  Instagram：纯 HTTP 模式（{mode}）")

    # ---------- 主流程 ----------

    def fetch(self, account, options) -> list:
        self._warmup()
        tz = ZoneInfo(options.tz_name)
        username = _extract_username(account.url)
        if not username:
            raise FetchError("从链接里解析不出用户名，请确认是主页链接而不是某条帖子")

        user, via = self._load_user(username)

        base = dict(
            row_no=account.row_no,
            account_name=account.name,
            platform=self.platform,
            profile_url=account.url,
            target_date=date_label(options.target_dates),
            channel_id=username,
            follower_count=user.get("followers") if user.get("followers") is not None else "未公开",
            fetched_at=datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S"),
        )

        posts = sorted(
            ((datetime.fromtimestamp(p["ts"], timezone.utc), p) for p in user["posts"] if p.get("ts")),
            key=lambda x: x[0], reverse=True)
        hits = [(p, n) for p, n in posts
                if p.astimezone(tz).strftime("%Y-%m-%d") in options.target_dates]

        note = account.note
        if via != "主接口":
            note = (note + f" 数据来自{via}").strip()
        if user.get("followers_approx"):
            note = (note + " 粉丝数为主页展示的近似值").strip()
        elif user.get("followers") is None and via != "主接口" and not self.sessionid:
            note = (note + " 该账号粉丝数需配置 instagram_sessionid 才能获取").strip()
        if hits and len(hits) == len(posts) and len(posts) >= 12:
            note = (note + " 主页前 12 条全部命中，可能还有当天内容未取到").strip()

        if not hits:
            hint = ""
            if posts:
                hint = f"最近一条发布于 {posts[0][0].astimezone(tz).strftime('%Y-%m-%d %H:%M')}"
            return [PostMetric(status=STATUS_NO_POST, extra={"提示": hint, "备注": note}, **base)]

        results = []
        for published, node in hits:
            results.append(PostMetric(
                status=STATUS_OK,
                post_title=_caption(node),
                post_url=f"{BASE}/p/{node.get('shortcode', '')}/",
                published_local=published.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S"),
                published_utc=published.strftime("%Y-%m-%d %H:%M:%S UTC"),
                post_type=_post_type(node),
                view_count=node.get("views") if node.get("views") is not None else "",
                like_count=_count(node.get("likes"), "未公开（已隐藏点赞）"),
                comment_count=_count(node.get("comments"), "已关闭评论"),
                error="",
                extra={"备注": note, "时长": ""},
                **base,
            ))
        return results

    def _load_user(self, username: str) -> tuple:
        """依次尝试三条路径，返回 (归一化后的账号数据, 数据来源说明)。"""
        status, user = self._web_profile_info(username)

        if status == 429:
            raise FetchError("被 Instagram 限流了，等几分钟再跑，或把 --ig-min-delay 调大")
        if status in (401, 403) and not self.sessionid:
            raise NeedSession(_session_hint("主接口要求登录"))
        if status == 200 and user:
            # 私密账号返回的是 is_private=true 且作品为空，要先判掉再看作品
            if user.get("is_private") and not user["posts"]:
                raise FetchError("这是私密账号，需要用一个已关注它的账号的 sessionid 才能看到内容")
            if user["posts"]:
                return user, "主接口"

        # 主接口不可用或返回空 → 走 feed 接口
        user_id = self._resolve_user_id(username)
        if user_id:
            feed_status, feed_user = self._feed(username, user_id)
            if feed_status == 200 and feed_user and feed_user["posts"]:
                return feed_user, f"兜底 feed 接口（主接口返回 {status}）"
            if feed_status == 429:
                raise FetchError("被 Instagram 限流了，等几分钟再跑")
            if not self.sessionid:
                raise NeedSession(_session_hint(
                    f"@{username} 匿名读不到内容（很可能设了年龄限制）"))
            raise FetchError(
                f"主接口返回 {status}，feed 接口返回 {feed_status} 且没有内容，请手动打开主页确认")

        if not self.sessionid:
            raise NeedSession(_session_hint(
                f"@{username} 主接口返回 {status}，且匿名状态下拿不到它的 user id"))
        raise FetchError(f"主接口返回 {status}，且无法解析 user id，请手动打开主页确认")

    # ---------- 三个数据源 ----------

    def _web_profile_info(self, username: str) -> tuple:
        self._throttle()
        try:
            r = self.session.get(f"{BASE}/api/v1/users/web_profile_info/?username={username}",
                                 headers={"Referer": f"{BASE}/{username}/"}, timeout=self.timeout)
        except requests.RequestException as e:
            raise FetchError(f"网络异常：{type(e).__name__}")
        self.api_calls += 1

        if r.status_code != 200:
            return r.status_code, None
        try:
            raw_user = (r.json().get("data") or {}).get("user")
        except ValueError:
            return -1, None
        if not raw_user:
            return 200, None

        posts = []
        for edge in ((raw_user.get("edge_owner_to_timeline_media") or {}).get("edges") or []):
            n = edge.get("node") or {}
            posts.append({
                "shortcode": n.get("shortcode") or "",
                "ts": n.get("taken_at_timestamp"),
                "product_type": n.get("product_type") or "",
                "typename": n.get("__typename") or "",
                "is_video": bool(n.get("is_video")),
                "views": _first_num(n, ("video_play_count", "video_view_count")),
                "likes": (n.get("edge_liked_by") or {}).get("count"),
                "comments": (n.get("edge_media_to_comment") or {}).get("count"),
                "caption": _first_caption(n),
            })
        # user id 顺手缓存，以后这个账号万一开始报 400 就不用再查
        if raw_user.get("id"):
            self._remember_id(username, str(raw_user["id"]))

        return 200, {
            "is_private": bool(raw_user.get("is_private")),
            "followers": (raw_user.get("edge_followed_by") or {}).get("count"),
            "posts": posts,
        }

    def _feed(self, username: str, user_id: str) -> tuple:
        self._throttle()
        try:
            r = self.session.get(f"{BASE}/api/v1/feed/user/{user_id}/?count=12",
                                 headers={"Referer": f"{BASE}/{username}/"}, timeout=self.timeout)
        except requests.RequestException as e:
            raise FetchError(f"网络异常：{type(e).__name__}")
        self.api_calls += 1

        if r.status_code != 200:
            return r.status_code, None
        try:
            items = r.json().get("items") or []
        except ValueError:
            return -1, None

        posts = []
        for n in items:
            media_type = n.get("media_type")
            posts.append({
                "shortcode": n.get("code") or "",
                "ts": n.get("taken_at"),
                "product_type": n.get("product_type") or "",
                "typename": {2: "GraphVideo", 8: "GraphSidecar"}.get(media_type, "GraphImage"),
                "is_video": media_type == 2,
                "views": _first_num(n, ("play_count", "ig_play_count", "view_count")),
                "likes": n.get("like_count"),
                "comments": n.get("comment_count"),
                "caption": ((n.get("caption") or {}).get("text") or "")[:500],
            })
        followers, approx = self._followers(username)
        return 200, {"is_private": False, "followers": followers,
                     "followers_approx": approx, "posts": posts}

    def _followers(self, username: str) -> tuple:
        """feed 接口不带粉丝数。

        匿名下这条路走不通：主页 HTML 匿名返回时不含 og:description，feed 响应的 user
        对象也没有 follower_count（都实测过）。所以只在有 sessionid 时才去查，
        避免每个兜底账号白发一次 700KB 的主页请求。
        """
        if not self.sessionid:
            return None, False
        self._throttle()
        try:
            r = self.session.get(f"{BASE}/api/v1/users/{username}/usernameinfo/",
                                 headers={"Referer": f"{BASE}/{username}/"}, timeout=self.timeout)
            self.api_calls += 1
            if r.status_code == 200:
                count = (r.json().get("user") or {}).get("follower_count")
                if isinstance(count, int):
                    return count, False
        except (requests.RequestException, ValueError):
            pass

        # 退到主页 meta 里的展示值（可能是 39K 这种缩写）
        self._throttle()
        try:
            r = self.session.get(f"{BASE}/{username}/", timeout=self.timeout)
            self.api_calls += 1
        except requests.RequestException:
            return None, False
        if r.status_code != 200:
            return None, False
        exact = re.search(r'"edge_followed_by":\{"count":(\d+)\}', r.text) \
            or re.search(r'"follower_count":(\d+)', r.text)
        if exact:
            return int(exact.group(1)), False
        og = re.search(r'property="og:description" content="([^"]{0,80})', r.text)
        return _parse_abbrev(og.group(1)) if og else (None, False)

    # ---------- user id 解析 ----------

    def _resolve_user_id(self, username: str) -> str:
        key = username.lower()
        if key in self._ids:
            return self._ids[key]

        # 带 sessionid 时可以直接查，这是最省事的方式
        if self.sessionid:
            self._throttle()
            try:
                r = self.session.get(f"{BASE}/api/v1/users/{username}/usernameinfo/",
                                     headers={"Referer": f"{BASE}/{username}/"}, timeout=self.timeout)
                self.api_calls += 1
                if r.status_code == 200:
                    pk = (r.json().get("user") or {}).get("pk")
                    if pk:
                        self._remember_id(username, str(pk))
                        return str(pk)
            except (requests.RequestException, ValueError):
                pass

        if self.use_browser:
            uid = self._resolve_user_id_via_browser(username)
            if uid:
                self._remember_id(username, uid)
                return uid
        return ""

    def _resolve_user_id_via_browser(self, username: str) -> str:
        """可选路径：借浏览器渲染主页，从 HTML 里拿 profile_id。
        只在既没 sessionid、又是新账号首次遇到 400 时才需要。"""
        try:
            from ..cdp import ChromeSession
        except ImportError:
            return ""
        try:
            if self._page is None:
                self._browser = ChromeSession(quiet=self.quiet)
                self._browser.start(BASE + "/")
                self._page = self._browser.open_page(BASE + "/", reuse_host="instagram.com")
            probe = """
            (async () => {
              const t = await (await fetch(%s, {credentials: "include"})).text();
              const m = t.match(/"profile_id":"(\\d+)"/) || t.match(/profilePage_(\\d+)/);
              return m ? m[1] : "";
            })()
            """ % json.dumps(f"{BASE}/{username}/")
            return (self._page.evaluate(probe, await_promise=True, timeout=60) or "").strip()
        except Exception:
            return ""

    def _remember_id(self, username: str, user_id: str) -> None:
        key = username.lower()
        if self._ids.get(key) == user_id:
            return
        self._ids[key] = user_id
        _save_cache(self.cache_path, self._ids)

    # ---------- 杂项 ----------

    def _throttle(self) -> None:
        elapsed = time.time() - self._last_call
        wait = random.uniform(self.min_delay, self.max_delay) - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def close(self):
        try:
            self.session.close()
        except Exception:
            pass
        if self._page:
            self._page.close()
        if self._browser:
            self._browser.close(keep_open=True)


# ---------- 解析工具 ----------

def _session_hint(reason: str) -> str:
    return (f"{reason}。解决办法（不用装插件，也不用开浏览器跑）："
            "在任意浏览器里登录 Instagram → 开发者工具 → Application/存储 → Cookies → "
            "instagram.com → 复制 sessionid 的值 → 填进 config.json 的 instagram_sessionid。"
            "有效期通常几个月，过期再换一次。")


def _extract_username(url: str) -> str:
    segments = [s for s in urlparse(url).path.split("/") if s]
    if not segments or segments[0].lower() in SKIP_SEGMENTS:
        return ""
    return segments[0]


def _first_caption(node: dict) -> str:
    edges = ((node.get("edge_media_to_caption") or {}).get("edges") or [])
    if not edges:
        return ""
    return ((edges[0].get("node") or {}).get("text") or "")[:500]


def _first_num(node: dict, keys) -> object:
    for k in keys:
        v = node.get(k)
        if isinstance(v, int):
            return v
    return None


def _caption(node: dict) -> str:
    flat = " ".join((node.get("caption") or "").split())
    if not flat:
        return "（无文字）"
    return (flat[:300] + "…") if len(flat) > 300 else flat


def _post_type(node: dict) -> str:
    if node.get("product_type") == "clips":
        return "Reels"
    typename = node.get("typename") or ""
    if typename == "GraphSidecar":
        return "图文轮播"
    if typename == "GraphVideo" or node.get("is_video"):
        return "视频"
    return "图片"


def _count(value, missing_text: str):
    if value is None or (isinstance(value, int) and value < 0):
        return missing_text
    return value


def _parse_abbrev(text: str) -> tuple:
    """解析主页展示的粉丝数：5,269 / 39K / 1.2M / 3.9万。返回 (数值, 是否近似)。"""
    m = re.search(r"([\d.]+)\s*([KkMm])?", text.replace(",", ""))
    if not m:
        return None, False
    try:
        value = float(m.group(1))
    except ValueError:
        return None, False
    unit = (m.group(2) or "").upper()
    if unit == "K":
        return int(round(value * 1000)), True
    if unit == "M":
        return int(round(value * 1000000)), True
    if "万" in text:
        return int(round(value * 10000)), True
    return int(round(value)), False


def _load_cache(path: str) -> dict:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return {k.lower(): str(v) for k, v in json.load(f).items()}
    except Exception:
        return {}


def _save_cache(path: str, data: dict) -> None:
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
    except Exception:
        pass
