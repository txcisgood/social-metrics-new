"""YouTube 采集器 —— 走官方 Data API v3。

每个频道的配额消耗：
  channels.list      1 单位（频道 ID 会缓存，第二次跑就不消耗）
  playlistItems.list 1 单位 / 页（默认最多 3 页）
  videos.list        1 单位 / 每 50 条视频
所以稳定态下约 2~3 单位/账号，免费额度 10000/天，几十个账号完全够用。

刻意没用 search.list：它一次 100 单位，而且索引有延迟，当天刚发的视频经常搜不到。
uploads 播放列表是频道自带的，实时性最好。
"""

import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from .base import BaseFetcher
from ..http import HttpClient, FetchError
from ..models import PostMetric, STATUS_OK, STATUS_NO_POST, date_label

API = "https://www.googleapis.com/youtube/v3"
CHANNEL_ID_RE = re.compile(r"UC[A-Za-z0-9_\-]{22}")
# 这些路径段不是频道标识，解析时要剥掉
TRAILING_SEGMENTS = {"videos", "featured", "shorts", "streams", "playlists",
                     "community", "about", "live", "podcasts", "releases", "search"}


class YouTubeFetcher(BaseFetcher):
    platform = "youtube"
    display_name = "YouTube"

    def __init__(self, api_key: str, cache_path: str = None, timeout: int = 20):
        if not api_key:
            raise ValueError("缺少 YouTube API Key")
        self.api_key = api_key
        self.http = HttpClient(timeout=timeout)
        self.cache_path = cache_path
        self._cache = _load_cache(cache_path)

    # ---------- 主流程 ----------

    def fetch(self, account, options) -> list:
        tz = ZoneInfo(options.tz_name)
        channel_id, resolve_note = self._resolve_channel_id(account.url)
        uploads_playlist, subscribers = self._channel_info(channel_id)

        window_start, window_end = _window(options.target_dates, tz)
        items = self._scan_playlist(uploads_playlist, window_start, options.scan_pages)

        hits = []
        for it in items:
            published = it["published_utc"]
            local_date = published.astimezone(tz).strftime("%Y-%m-%d")
            if local_date in options.target_dates:
                hits.append(it)

        base = dict(
            row_no=account.row_no,
            account_name=account.name,
            platform=self.platform,
            profile_url=account.url,
            target_date=date_label(options.target_dates),
            channel_id=channel_id,
            follower_count=subscribers,
            fetched_at=datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S"),
        )
        note = " ".join(x for x in [account.note, resolve_note] if x)

        if not hits:
            latest_hint = ""
            if items:
                newest = items[0]["published_utc"].astimezone(tz)
                latest_hint = f"最近一条发布于 {newest.strftime('%Y-%m-%d %H:%M')}"
            return [PostMetric(status=STATUS_NO_POST, error="", post_title="",
                               extra={"提示": latest_hint}, **base)]

        stats = self._video_stats([h["video_id"] for h in hits])
        results = []
        for h in hits:
            v = stats.get(h["video_id"], {})
            sn = v.get("snippet", {})
            st = v.get("statistics", {})
            cd = v.get("contentDetails", {})
            live = v.get("liveStreamingDetails")
            published = h["published_utc"]

            results.append(PostMetric(
                status=STATUS_OK,
                post_title=sn.get("title") or h.get("title", ""),
                post_url=f"https://www.youtube.com/watch?v={h['video_id']}",
                published_local=published.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S"),
                published_utc=published.strftime("%Y-%m-%d %H:%M:%S UTC"),
                post_type=self._classify(h["video_id"], cd, live, options.check_shorts),
                view_count=_num(st.get("viewCount"), "未公开"),
                like_count=_num(st.get("likeCount"), "未公开（创作者已隐藏）"),
                comment_count=_num(st.get("commentCount"), "已关闭评论"),
                error="",
                extra={"备注": note, "时长": _pretty_duration(cd.get("duration")),
                       "描述摘要": _summarize(sn.get("description"))},
                **base,
            ))
        return results

    # ---------- 频道链接解析 ----------

    def _resolve_channel_id(self, url: str) -> tuple:
        """支持 /channel/UCxxx、/@handle、/user/name、/c/name、单个视频链接、裸用户名。"""
        cached = self._cache.get(url)
        if cached:
            return cached, ""

        parsed = urlparse(url)
        segments = [s for s in parsed.path.split("/") if s]
        while segments and segments[-1].lower() in TRAILING_SEGMENTS:
            segments.pop()

        host = parsed.netloc.lower()
        note = ""
        channel_id = ""

        # 1) 直接就是频道 ID
        if len(segments) >= 2 and segments[0].lower() == "channel":
            channel_id = segments[1]
            if not CHANNEL_ID_RE.fullmatch(channel_id):
                raise FetchError(f"频道 ID 格式不对：{channel_id}")

        # 2) 视频链接 → 反查所属频道
        elif "youtu.be" in host and segments:
            channel_id = self._channel_of_video(segments[0])
            note = "链接是单个视频，已换成它所属频道"
        elif segments and segments[0].lower() in ("watch", "shorts", "live", "embed"):
            vid = parse_qs(parsed.query).get("v", [None])[0] if segments[0].lower() == "watch" else (
                segments[1] if len(segments) > 1 else None)
            if not vid:
                raise FetchError("视频链接里找不到视频 ID")
            channel_id = self._channel_of_video(vid)
            note = "链接是单个视频，已换成它所属频道"

        # 3) @handle
        elif segments and segments[0].startswith("@"):
            channel_id = self._channel_by_param("forHandle", segments[0]) or self._scrape_channel_id(url)

        # 4) 老式 /user/xxx
        elif len(segments) >= 2 and segments[0].lower() == "user":
            channel_id = (self._channel_by_param("forUsername", segments[1])
                          or self._channel_by_param("forHandle", "@" + segments[1])
                          or self._scrape_channel_id(url))

        # 5) /c/xxx 自定义域名 —— API 无对应参数，抓网页拿 channelId
        elif len(segments) >= 2 and segments[0].lower() == "c":
            channel_id = (self._channel_by_param("forHandle", "@" + segments[1])
                          or self._scrape_channel_id(url))
            note = "自定义链接，已通过网页解析出频道 ID"

        # 6) 裸用户名 youtube.com/SomeName
        elif len(segments) == 1:
            channel_id = (self._channel_by_param("forHandle", "@" + segments[0])
                          or self._channel_by_param("forUsername", segments[0])
                          or self._scrape_channel_id(url))

        if not channel_id:
            raise FetchError("无法解析出频道 ID，请确认链接是频道主页而不是播放列表/搜索结果页")

        self._cache[url] = channel_id
        _save_cache(self.cache_path, self._cache)
        return channel_id, note

    def _channel_by_param(self, param: str, value: str) -> str:
        try:
            data = self.http.get_json(f"{API}/channels", {
                "part": "id", param: value, "key": self.api_key})
        except FetchError:
            return ""
        items = data.get("items") or []
        return items[0]["id"] if items else ""

    def _channel_of_video(self, video_id: str) -> str:
        data = self.http.get_json(f"{API}/videos", {
            "part": "snippet", "id": video_id, "key": self.api_key})
        items = data.get("items") or []
        if not items:
            raise FetchError(f"视频 {video_id} 不存在或已下架")
        return items[0]["snippet"]["channelId"]

    def _scrape_channel_id(self, url: str) -> str:
        """不消耗 API 配额的兜底：从频道主页 HTML 里抠出 channelId。"""
        try:
            code, html = self.http.get_text(url)
        except FetchError:
            return ""
        if code != 200:
            return ""
        m = re.search(r'"(?:channelId|externalId)"\s*:\s*"(UC[\w\-]{22})"', html)
        if m:
            return m.group(1)
        m = CHANNEL_ID_RE.search(html)
        return m.group(0) if m else ""

    # ---------- 时间线扫描 ----------

    def _channel_info(self, channel_id: str) -> tuple:
        """一次请求同时拿 uploads 播放列表和订阅数。订阅数每天在变，所以不缓存。"""
        data = self.http.get_json(f"{API}/channels", {
            "part": "contentDetails,statistics", "id": channel_id, "key": self.api_key})
        items = data.get("items") or []
        if not items:
            raise FetchError(f"频道 {channel_id} 查不到（可能已注销或被封）")
        playlist = items[0]["contentDetails"]["relatedPlaylists"].get("uploads")
        if not playlist:
            raise FetchError("该频道没有公开的上传列表")
        stats = items[0].get("statistics", {})
        if stats.get("hiddenSubscriberCount"):
            subs = "未公开（创作者已隐藏）"
        else:
            subs = _num(stats.get("subscriberCount"), "未公开")
        return playlist, subs

    def _scan_playlist(self, playlist_id: str, window_start, max_pages: int) -> list:
        """从新到旧扫，连续遇到 3 条早于窗口起点的就停。留 3 条余量是因为
        偶尔会有旧视频被改成公开而插到列表前面。"""
        results, page_token, older_streak = [], None, 0
        for _ in range(max(1, max_pages)):
            params = {"part": "contentDetails,snippet", "playlistId": playlist_id,
                      "maxResults": 50, "key": self.api_key}
            if page_token:
                params["pageToken"] = page_token
            data = self.http.get_json(f"{API}/playlistItems", params)

            for it in data.get("items", []):
                cd = it.get("contentDetails", {})
                vid = cd.get("videoId")
                raw = cd.get("videoPublishedAt") or it.get("snippet", {}).get("publishedAt")
                if not vid or not raw:
                    continue  # 私有或已删除的视频没有发布时间
                published = _parse_iso(raw)
                results.append({"video_id": vid, "published_utc": published,
                                "title": it.get("snippet", {}).get("title", "")})
                older_streak = older_streak + 1 if published < window_start else 0

            if older_streak >= 3:
                break
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        results.sort(key=lambda x: x["published_utc"], reverse=True)
        return results

    def _video_stats(self, video_ids: list) -> dict:
        out = {}
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i + 50]
            data = self.http.get_json(f"{API}/videos", {
                "part": "snippet,statistics,contentDetails,liveStreamingDetails",
                "id": ",".join(batch), "key": self.api_key})
            for v in data.get("items", []):
                out[v["id"]] = v
        return out

    def _classify(self, video_id: str, content_details: dict, live: dict, check_shorts: bool) -> str:
        if live:
            if live.get("actualEndTime"):
                return "直播回放"
            if live.get("actualStartTime"):
                return "正在直播"
            return "直播预告"

        seconds = _duration_seconds(content_details.get("duration"))
        # Shorts 上限是 3 分钟，先按时长粗筛，再用一次不耗配额的请求确认
        if seconds is not None and seconds <= 180:
            if not check_shorts:
                return "疑似 Shorts"
            code = self.http.head_status(f"https://www.youtube.com/shorts/{video_id}")
            if code == 200:
                return "Shorts"
            if code in (303, 302, 301):
                return "长视频"
            return "疑似 Shorts"
        return "长视频"


# ---------- 工具函数 ----------

def _window(target_dates: list, tz) -> tuple:
    start = datetime.strptime(target_dates[0], "%Y-%m-%d").replace(tzinfo=tz)
    end = datetime.strptime(target_dates[-1], "%Y-%m-%d").replace(tzinfo=tz) + timedelta(days=1)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def _num(value, missing_text: str):
    if value is None:
        return missing_text
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _duration_seconds(iso: str):
    if not iso:
        return None
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m:
        return None
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def _pretty_duration(iso: str) -> str:
    sec = _duration_seconds(iso)
    if sec is None:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _summarize(text: str, limit: int = 300) -> str:
    if not text:
        return ""
    flat = re.sub(r"\s+", " ", text).strip()
    return flat[:limit] + ("…" if len(flat) > limit else "")


def _load_cache(path: str) -> dict:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(path: str, data: dict):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception:
        pass
