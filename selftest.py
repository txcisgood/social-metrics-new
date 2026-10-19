#!/usr/bin/env python3
"""离线自测：不需要 API Key，用构造的 API 响应验证核心逻辑。
跑法：python3 selftest.py
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from smetrics.loader import load_accounts, _infer_platform, _clean_url
from smetrics.models import AccountRow, FetchOptions
from smetrics.platforms.youtube import (YouTubeFetcher, _duration_seconds,
                                        _pretty_duration, _window, _parse_iso)
from smetrics import writer

HERE = os.path.dirname(os.path.abspath(__file__))
PASS, FAIL = "  ✓", "  ✗"
failures = []


def check(desc, cond, detail=""):
    if cond:
        print(f"{PASS} {desc}")
    else:
        print(f"{FAIL} {desc}  {detail}")
        failures.append(desc)


# ---------------- 1. 平台识别 ----------------
print("\n[1] 链接 → 平台识别")
cases = [
    ("https://www.youtube.com/@MrBeast", "youtube"),
    ("youtube.com/channel/UCK8sQmJBp8GCxrOtXWBpyEA", "youtube"),
    ("https://youtu.be/dQw4w9WgXcQ", "youtube"),
    ("https://m.youtube.com/c/Google/videos", "youtube"),
    ("https://www.instagram.com/natgeo/", "instagram"),
    ("https://web.facebook.com/natgeo", "facebook"),
    ("https://fb.watch/abc123/", "facebook"),
    ("https://example.com/abc", ""),
]
for raw, expect in cases:
    got = _infer_platform(_clean_url(raw))
    check(f"{raw[:46]:46} → {got or '(识别不出)'}", got == expect, f"期望 {expect}")


# ---------------- 2. 表格解析 ----------------
print("\n[2] 表格解析（含表头乱序、缺表头、平台填错、脏数据）")
import csv as _csv
tmp_csv = os.path.join(HERE, ".selftest_input.csv")
with open(tmp_csv, "w", encoding="utf-8", newline="") as f:
    w = _csv.writer(f)
    w.writerow(["平台", "Profile URL", "合作伙伴"])          # 列顺序打乱
    w.writerow(["youtube", "https://www.youtube.com/@mkbhd", "MKBHD"])
    w.writerow(["抖音", "https://www.youtube.com/@MrBeast", "野兽先生"])  # 平台填错
    w.writerow(["", "", ""])                                  # 空行
    w.writerow(["ins", " instagram.com/natgeo/ ", "国家地理"])  # 带空格 + 无协议
    w.writerow(["youtube", "", "缺链接的账号"])                # 缺链接
accounts, warns = load_accounts(tmp_csv)
check("识别出 3 个有效账号", len(accounts) == 3, f"实际 {len(accounts)}")
check("列顺序打乱也能对上（第一个是 MKBHD）",
      accounts and accounts[0].name == "MKBHD", accounts[0].name if accounts else "")
check("平台填错时以链接为准（野兽先生 → youtube）",
      len(accounts) > 1 and accounts[1].platform == "youtube")
check("平台不一致有提示", len(accounts) > 1 and "已按链接为准" in accounts[1].note)
check("缺链接的行进入 warnings", any("缺少链接" in w for w in warns), str(warns))
check("无协议链接自动补 https", len(accounts) > 2 and accounts[2].url.startswith("https://"))
os.remove(tmp_csv)


# ---------------- 3. 时长与日期窗口 ----------------
print("\n[3] 时长解析与日期窗口")
check("PT1H2M3S = 3723 秒", _duration_seconds("PT1H2M3S") == 3723)
check("PT58S = 58 秒（Shorts 区间）", _duration_seconds("PT58S") == 58)
check("PT2M30S 格式化为 2:30", _pretty_duration("PT2M30S") == "2:30")
check("PT1H0M5S 格式化为 1:00:05", _pretty_duration("PT1H0M5S") == "1:00:05")

from zoneinfo import ZoneInfo
tz = ZoneInfo("Asia/Shanghai")
start, end = _window(["2026-08-29"], tz)
check("8/29 东八区窗口起点 = 8/28 16:00 UTC",
      start.strftime("%Y-%m-%d %H:%M") == "2026-08-28 16:00", start.isoformat())
check("窗口跨度 24 小时", (end - start) == timedelta(days=1))


# ---------------- 4. 用假接口跑通完整采集逻辑 ----------------
print("\n[4] 完整采集逻辑（注入伪造的 API 响应）")

TARGET = "2026-08-29"
# 构造三条视频：当天的 Shorts、当天的长视频、前一天的（应被过滤）
def utc(s):
    return s

PLAYLIST_ITEMS = {
    "items": [
        {"contentDetails": {"videoId": "vidShort", "videoPublishedAt": "2026-08-29T02:15:00Z"},
         "snippet": {"title": "今天的 Shorts"}},
        {"contentDetails": {"videoId": "vidLong", "videoPublishedAt": "2026-08-28T23:40:00Z"},
         "snippet": {"title": "今天早上的长视频"}},   # UTC 8/28 23:40 = 东八区 8/29 07:40
        {"contentDetails": {"videoId": "vidOld", "videoPublishedAt": "2026-08-27T10:00:00Z"},
         "snippet": {"title": "前天的视频"}},
        {"contentDetails": {"videoId": "vidOld2", "videoPublishedAt": "2026-08-26T10:00:00Z"},
         "snippet": {"title": "更早"}},
        {"contentDetails": {"videoId": "vidOld3", "videoPublishedAt": "2026-08-25T10:00:00Z"},
         "snippet": {"title": "更早2"}},
    ]
}
VIDEOS = {
    "items": [
        {"id": "vidShort",
         "snippet": {"title": "今天的 Shorts"},
         "statistics": {"viewCount": "12345", "likeCount": "678", "commentCount": "90"},
         "contentDetails": {"duration": "PT45S"}},
        {"id": "vidLong",
         "snippet": {"title": "今天早上的长视频"},
         "statistics": {"viewCount": "999", "commentCount": "12"},   # 点赞被隐藏
         "contentDetails": {"duration": "PT15M20S"}},
    ]
}


class FakeHttp:
    api_calls = 0
    hidden_subs = False

    def get_json(self, url, params=None, count_as_api=True):
        self.api_calls += 1
        if "/channels" in url:
            stats = {"hiddenSubscriberCount": True} if self.hidden_subs else {
                "subscriberCount": "1230000", "hiddenSubscriberCount": False}
            return {"items": [{"id": "UCfakefakefakefakefake1",
                               "statistics": stats,
                               "contentDetails": {"relatedPlaylists": {"uploads": "UUfakefakefakefakefake1"}}}]}
        if "/playlistItems" in url:
            return PLAYLIST_ITEMS
        if "/videos" in url:
            ids = (params or {}).get("id", "").split(",")
            return {"items": [v for v in VIDEOS["items"] if v["id"] in ids]}
        raise AssertionError("没预料到的请求 " + url)

    def head_status(self, url):
        return 200 if "vidShort" in url else 303

    def get_text(self, url, allow_redirects=True):
        return 200, ""


f = YouTubeFetcher("FAKE_KEY", cache_path=None)
f.http = FakeHttp()
account = AccountRow(row_no=2, name="测试频道",
                     url="https://www.youtube.com/channel/UCK8sQmJBp8GCxrOtXWBpyEA",
                     platform="youtube")
opts = FetchOptions(target_dates=[TARGET], tz_name="Asia/Shanghai")
rows = f.fetch(account, opts)

check("当天命中 2 条（正确排除了前天的）", len(rows) == 2, f"实际 {len(rows)}")
titles = [r.post_title for r in rows]
check("跨时区边界视频被正确算进当天（UTC 8/28 23:40 → 东八区 8/29）",
      "今天早上的长视频" in titles, str(titles))
short_row = next((r for r in rows if r.post_title == "今天的 Shorts"), None)
check("Shorts 被正确识别", short_row and short_row.post_type == "Shorts",
      short_row.post_type if short_row else "")
check("点赞数正确读出 678", short_row and short_row.like_count == 678)
check("评论数正确读出 90", short_row and short_row.comment_count == 90)
long_row = next((r for r in rows if r.post_title == "今天早上的长视频"), None)
check("长视频被识别为长视频", long_row and long_row.post_type == "长视频")
check("点赞被创作者隐藏时给出可读提示",
      long_row and "未公开" in str(long_row.like_count), str(long_row.like_count) if long_row else "")
check("本地时间换算正确（07:40）",
      long_row and long_row.published_local.endswith("07:40:00"),
      long_row.published_local if long_row else "")

# 当天无发布的场景
opts2 = FetchOptions(target_dates=["2026-08-20"], tz_name="Asia/Shanghai")
rows2 = f.fetch(account, opts2)
check("当天无发布时返回 1 行 NO_POST", len(rows2) == 1 and rows2[0].status == "NO_POST")
check("NO_POST 行带上「最近一条发布于」提示",
      "最近一条发布于" in (rows2[0].extra.get("提示") or ""), str(rows2[0].extra))


# ---------------- 5. Excel 输出 ----------------
print("\n[5] Excel 输出")
from smetrics.models import PostMetric, STATUS_FAILED
rows_all = rows + rows2 + [PostMetric(
    row_no=9, account_name="打不开的账号", platform="youtube",
    profile_url="https://www.youtube.com/@nonexistent_xyz", target_date=TARGET,
    status=STATUS_FAILED, error="频道 UCxxx 查不到（可能已注销或被封）",
    fetched_at="2026-08-29 12:00:00")]
import tempfile
_test_output = tempfile.TemporaryDirectory(prefix="smetrics-test-")
out_dir = _test_output.name
xlsx, jsonl = writer.default_out_paths(out_dir, "自测")
writer.write_excel(rows_all, xlsx, {"目标日期": TARGET, "判定时区": "Asia/Shanghai",
                                    "账号数": 2, "API 请求次数": f.http.api_calls})
writer.write_jsonl(rows_all, jsonl)
check("Excel 已生成", os.path.exists(xlsx))
check("jsonl 已生成", os.path.exists(jsonl))

from openpyxl import load_workbook
wb = load_workbook(xlsx)
check("含「采集结果」sheet", "采集结果" in wb.sheetnames, str(wb.sheetnames))
check("失败账号单独进「待人工核对」sheet", "待人工核对" in wb.sheetnames)
ws = wb["采集结果"]
check("结果行数 = 4（2 条命中 + 1 条无发布 + 1 条失败）", ws.max_row == 5, f"实际 {ws.max_row - 1}")
check("待人工核对里给了处理建议",
      "手动打开" in str(wb["待人工核对"].cell(row=2, column=6).value)
      or "确认账号" in str(wb["待人工核对"].cell(row=2, column=6).value),
      str(wb["待人工核对"].cell(row=2, column=6).value))


# ---------------- 6. 粉丝数 ----------------
print("\n[6] 粉丝数（Fans 列所需）")
check("订阅数被正确读出 1230000", rows[0].follower_count == 1230000, str(rows[0].follower_count))
check("当天无发布的行也带粉丝数", rows2[0].follower_count == 1230000, str(rows2[0].follower_count))
f.http.hidden_subs = True
rows_hidden = f.fetch(account, opts)
check("创作者隐藏订阅数时给可读提示",
      "未公开" in str(rows_hidden[0].follower_count), str(rows_hidden[0].follower_count))
f.http.hidden_subs = False


# ---------------- 7. 回填原表 ----------------
print("\n[7] 回填原表（用真实的网红list文件）")
REAL = os.path.join(HERE, "网红list.xlsx")
if not os.path.exists(REAL):
    print("  - 跳过：找不到真实表格文件")
else:
    import hashlib
    def md5(p):
        return hashlib.md5(open(p, "rb").read()).hexdigest()
    before = md5(REAL)

    from smetrics.filler import fill_back
    fake_results = [
        PostMetric(row_no=3, account_name="Robin Foxer", platform="youtube",
                   profile_url="https://www.youtube.com/@TeamFoxer", target_date=TARGET,
                   status="OK", post_title="Test Video A", post_url="https://youtu.be/aaa",
                   published_local="2026-08-29 10:00:00", post_type="长视频",
                   view_count=5000, like_count=321, comment_count=45,
                   follower_count=98765, fetched_at="2026-08-29 12:00:00", extra={}),
        # 同一行当天发了两条，验证换行合并
        PostMetric(row_no=3, account_name="Robin Foxer", platform="youtube",
                   profile_url="https://www.youtube.com/@TeamFoxer", target_date=TARGET,
                   status="OK", post_title="Test Video B", post_url="https://youtu.be/bbb",
                   published_local="2026-08-29 18:00:00", post_type="Shorts",
                   view_count=800, like_count=60, comment_count=7,
                   follower_count=98765, fetched_at="2026-08-29 12:00:00", extra={}),
        PostMetric(row_no=6, account_name="Sarah Miles Shooting", platform="youtube",
                   profile_url="https://www.youtube.com/@sarahmilesshooting", target_date=TARGET,
                   status="NO_POST", follower_count=12345, fetched_at="2026-08-29 12:00:00",
                   extra={"提示": "最近一条发布于 2026-08-25 09:00"}),
        PostMetric(row_no=22, account_name="Richard", platform="youtube",
                   profile_url="https://www.youtube.com/c/richardbirchett", target_date=TARGET,
                   status=STATUS_FAILED, error="频道查不到", fetched_at="2026-08-29 12:00:00"),
    ]
    filled_path, fill_notes = fill_back(REAL, fake_results, out_dir, [TARGET])

    check("原文件没有被改动（md5 一致）", md5(REAL) == before)
    check("回填副本已生成", os.path.exists(filled_path))

    fwb = load_workbook(filled_path)
    fws = fwb.active
    # 原表列：A网红 B链接 C Platform D Fans E Post F Post Date G Post Link H Views I Likes J Comments
    check("Likes 列写入 321（第 3 行第一条）",
          "321" in str(fws.cell(row=3, column=9).value), str(fws.cell(row=3, column=9).value))
    check("Comments 列写入 45", "45" in str(fws.cell(row=3, column=10).value),
          str(fws.cell(row=3, column=10).value))
    check("Fans 列写入 98765", str(fws.cell(row=3, column=4).value) == "98765",
          str(fws.cell(row=3, column=4).value))
    check("一天多条时同格换行合并",
          "Test Video A" in str(fws.cell(row=3, column=5).value)
          and "Test Video B" in str(fws.cell(row=3, column=5).value),
          str(fws.cell(row=3, column=5).value))
    check("Platform 列被补成 YouTube", str(fws.cell(row=3, column=3).value) == "YouTube",
          str(fws.cell(row=3, column=3).value))
    check("当天无发布的行写了提示文案",
          "当天无发布" in str(fws.cell(row=6, column=5).value), str(fws.cell(row=6, column=5).value))
    check("失败的行写了失败原因",
          "抓取失败" in str(fws.cell(row=22, column=5).value), str(fws.cell(row=22, column=5).value))
    check("未采集的 Instagram 行保持留空（第 4 行）",
          fws.cell(row=4, column=9).value in (None, ""), str(fws.cell(row=4, column=9).value))
    check("追加了「采集记录」sheet", "采集记录" in fwb.sheetnames, str(fwb.sheetnames))
    print("  回填样例：" + filled_path)


# ---------------- 8. Instagram 解析逻辑（伪造接口响应，不碰浏览器）----------------
print("\n[8] Instagram 解析逻辑")
from smetrics.platforms.instagram import (InstagramFetcher, _extract_username,
                                          _caption, _post_type, _count)

for raw, expect in [
    ("https://www.instagram.com/team_foxer/", "team_foxer"),
    ("https://www.instagram.com/alischwind?igsh=MWxsc3cwYTNmd3BscA%3D%3D", "alischwind"),
    ("https://www.instagram.com/lucyhallshooting/?hl=en", "lucyhallshooting"),
    ("https://www.instagram.com/paulbrowning.photography/ ".strip(), "paulbrowning.photography"),
    ("https://www.instagram.com/p/Cxyz123/", ""),          # 单条帖子链接，取不到用户名
]:
    got = _extract_username(raw)
    check(f"用户名解析 {raw[:52]:52} → {got or '(空)'}", got == expect, f"期望 {expect}")

# 用假的 requests 会话驱动，验证三条路径与各种异常
import calendar
def ts(y, m, d, hh, mm):
    return calendar.timegm((y, m, d, hh, mm, 0, 0, 0, 0))


def wpi_payload(private=False):
    """web_profile_info 的响应结构：当天 1 条 Reels + 1 条图文轮播，另有一条前天的。"""
    def node(code, t, **kw):
        base = {"shortcode": code, "taken_at_timestamp": t,
                "edge_liked_by": {"count": kw.get("likes", 0)},
                "edge_media_to_comment": {"count": kw.get("comments", 0)},
                "edge_media_to_caption": {"edges": ([{"node": {"text": kw["cap"]}}] if kw.get("cap") else [])}}
        base.update({k: v for k, v in kw.items() if k in ("product_type", "__typename",
                                                          "is_video", "video_play_count")})
        return {"node": base}
    return {"data": {"user": {
        "id": "555000", "is_private": private,
        "edge_followed_by": {"count": 45231},
        "edge_owner_to_timeline_media": {"page_info": {"has_next_page": False}, "edges": [
            node("AAA", ts(2026, 8, 29, 9, 30), product_type="clips", __typename="GraphVideo",
                 is_video=True, video_play_count=20345, likes=1502, comments=88,
                 cap="Out on the hill today\n\n#stalking #highlands"),
            node("BBB", ts(2026, 8, 29, 2, 10), __typename="GraphSidecar",
                 likes=640, comments=12, cap="Carousel post"),
            node("CCC", ts(2026, 8, 27, 12, 0), __typename="GraphImage", likes=99, comments=1),
        ]}}}}


FEED_PAYLOAD = {"more_available": False, "items": [
    {"code": "FFF", "taken_at": ts(2026, 8, 29, 11, 0), "media_type": 2,
     "product_type": "clips", "play_count": 2272, "like_count": 71, "comment_count": 8,
     "caption": {"text": "Fallback reel"}},
]}


class FakeResp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text if text else (json.dumps(payload) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class FakeSession:
    """按 URL 特征返回预设响应，并记录调用顺序。"""
    def __init__(self, routes):
        self.routes = routes
        self.calls = []
        self.headers = {}
        self.cookies = type("C", (), {"set": lambda *a, **k: None})()

    def get(self, url, **kw):
        self.calls.append(url)
        for key, resp in self.routes:
            if key in url:
                return resp() if callable(resp) else resp
        return FakeResp(200, None, text="")

    def close(self):
        pass


def make_ig(routes, sessionid=""):
    f = InstagramFetcher(sessionid=sessionid, cache_path=None, min_delay=0, max_delay=0)
    f.session = FakeSession(routes)
    f._warmed = True
    f.quiet = True
    return f


ig_account = AccountRow(row_no=4, name="Niall Rowantree",
                        url="https://www.instagram.com/highland_stalker/", platform="instagram")
day = FetchOptions(target_dates=["2026-08-29"], tz_name="Asia/Shanghai")

# 主路径
ig = make_ig([("web_profile_info", FakeResp(200, wpi_payload()))])
rows = ig.fetch(ig_account, day)
check("主路径命中当天 2 条（排除前天）", len(rows) == 2, f"实际 {len(rows)}")
check("粉丝数读出 45231", rows[0].follower_count == 45231, str(rows[0].follower_count))
reel = next((r for r in rows if r.post_url.endswith("/p/AAA/")), None)
check("Reels 类型识别正确", reel and reel.post_type == "Reels", reel.post_type if reel else "")
check("Reels 点赞 1502 评论 88", reel and reel.like_count == 1502 and reel.comment_count == 88)
check("Reels 播放量 20345", reel and reel.view_count == 20345)
check("文案换行被压成单行",
      reel and "\n" not in reel.post_title and "Out on the hill" in reel.post_title)
sidecar = next((r for r in rows if r.post_url.endswith("/p/BBB/")), None)
check("图文轮播识别正确", sidecar and sidecar.post_type == "图文轮播")
check("图片帖播放量留空", sidecar and sidecar.view_count == "")
check("主路径只发一次请求", len(ig.session.calls) == 1, str(ig.session.calls))

# 当天无发布
ig2 = make_ig([("web_profile_info", FakeResp(200, wpi_payload()))])
rows2 = ig2.fetch(ig_account, FetchOptions(target_dates=["2026-08-20"], tz_name="Asia/Shanghai"))
check("当天无发布返回 NO_POST", len(rows2) == 1 and rows2[0].status == "NO_POST")
check("NO_POST 带最近发布时间提示", "最近一条发布于" in (rows2[0].extra.get("提示") or ""))

# 主接口 400 → 走 feed 兜底（user id 命中种子缓存）
seed_account = AccountRow(row_no=31, name="Ali Schiwind",
                          url="https://www.instagram.com/alischwind?igsh=x", platform="instagram")
ig3 = make_ig([("web_profile_info", FakeResp(400, None, text='{"message":"Asset ... deleted"}')),
               ("/api/v1/feed/user/", FakeResp(200, FEED_PAYLOAD)),
               ("instagram.com/alischwind/", FakeResp(200, None,
                text='<meta property="og:description" content="39K Followers, 3,083 Following">'))])
rows3 = ig3.fetch(seed_account, day)
check("主接口 400 时自动走 feed 兜底", len(rows3) == 1 and rows3[0].status == "OK", str(len(rows3)))
check("兜底路径点赞 71 评论 8", rows3[0].like_count == 71 and rows3[0].comment_count == 8)
check("兜底路径用到了种子里的 user id",
      any("/api/v1/feed/user/194799910/" in c for c in ig3.session.calls), str(ig3.session.calls))
check("备注标明数据来自兜底", "兜底" in (rows3[0].extra.get("备注") or ""), str(rows3[0].extra))
check("匿名兜底时粉丝数标为未公开并说明原因",
      rows3[0].follower_count == "未公开" and "sessionid" in (rows3[0].extra.get("备注") or ""),
      f"{rows3[0].follower_count} / {rows3[0].extra.get('备注')}")

# 带 sessionid 时兜底路径能拿到粉丝数：usernameinfo 优先，失败则退到主页 og 缩写值
ig3b = make_ig([("web_profile_info", FakeResp(400, None, text="{}")),
                ("/api/v1/feed/user/", FakeResp(200, FEED_PAYLOAD)),
                ("usernameinfo", FakeResp(200, {"user": {"follower_count": 7861}}))],
               sessionid="fake-session")
rows3b = ig3b.fetch(seed_account, day)
check("带 sessionid 时兜底路径拿到精确粉丝数 7861",
      rows3b[0].follower_count == 7861, str(rows3b[0].follower_count))

ig3c = make_ig([("web_profile_info", FakeResp(400, None, text="{}")),
                ("/api/v1/feed/user/", FakeResp(200, FEED_PAYLOAD)),
                ("usernameinfo", FakeResp(403, None, text="login_required")),
                ("instagram.com/alischwind/", FakeResp(200, None,
                 text='<meta property="og:description" content="39K Followers, 3,083 Following">'))],
               sessionid="fake-session")
rows3c = ig3c.fetch(seed_account, day)
check("usernameinfo 失败时退到主页缩写值 39K → 39000",
      rows3c[0].follower_count == 39000, str(rows3c[0].follower_count))
check("近似粉丝数在备注里说明", "近似值" in (rows3c[0].extra.get("备注") or ""),
      str(rows3c[0].extra.get("备注")))

# 缩写解析
from smetrics.platforms.instagram import _parse_abbrev
for text, expect_val, expect_approx in [("5,269 Followers", 5269, False), ("39K Followers", 39000, True),
                                        ("1.2M Followers", 1200000, True), ("3.9万 位粉丝", 39000, True)]:
    got, approx = _parse_abbrev(text)
    check(f"粉丝数缩写解析 {text:18} → {got}", got == expect_val and approx == expect_approx,
          f"期望 {expect_val}/{expect_approx}")

# 年龄限制：匿名读不到，且没有 sessionid → 必须给出可操作指引，不能误报成当天无发布
from smetrics.platforms.instagram import NeedSession
age_account = AccountRow(row_no=9, name="Nicole Moore",
                         url="https://www.instagram.com/shootinggirl_with_an_afro/", platform="instagram")
ig4 = make_ig([("web_profile_info", FakeResp(200, {"data": {"user": None}})),
               ("/api/v1/feed/user/", FakeResp(200, {"items": []}))])
try:
    ig4.fetch(age_account, day)
    check("匿名读不到内容时给出 sessionid 指引", False, "没有抛异常")
except NeedSession as e:
    check("匿名读不到内容时给出 sessionid 指引", "sessionid" in str(e), str(e)[:80])
except Exception as e:
    check("匿名读不到内容时给出 sessionid 指引", False, f"抛了 {type(e).__name__}: {e}")

# 限流与私密
ig5 = make_ig([("web_profile_info", FakeResp(429, None))])
try:
    ig5.fetch(ig_account, day)
    check("429 提示被限流", False, "没有抛异常")
except Exception as e:
    check("429 提示被限流", "限流" in str(e), str(e)[:60])

priv_payload = {"data": {"user": {"id": "9", "is_private": True,
                                  "edge_followed_by": {"count": 12},
                                  "edge_owner_to_timeline_media": {"page_info": {"has_next_page": False}, "edges": []}}}}
ig6 = make_ig([("web_profile_info", FakeResp(200, priv_payload))])
try:
    ig6.fetch(ig_account, day)
    check("私密账号给出明确报错", False, "没有抛异常")
except Exception as e:
    check("私密账号给出明确报错", "私密账号" in str(e), str(e)[:60])


print("\n" + "=" * 60)
if failures:
    print(f"失败 {len(failures)} 项：")
    for x in failures:
        print("  - " + x)
    sys.exit(1)
print("全部通过。")
print(f"自测生成的样例文件：{xlsx}")
