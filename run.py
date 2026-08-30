#!/usr/bin/env python3
"""社媒动态采集 —— 入口。

用法示例：
  python3 run.py --input accounts.xlsx                     # 抓今天
  python3 run.py --input accounts.xlsx --date 2026-08-28    # 抓指定某天
  python3 run.py --input accounts.xlsx --days 3             # 抓最近 3 天（含今天）
  python3 run.py --input accounts.xlsx --tz America/Los_Angeles   # 按创作者当地时间判定"当天"
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from smetrics.loader import load_accounts
from smetrics.models import FetchOptions, PostMetric, STATUS_FAILED, date_label
from smetrics.http import QuotaExceeded, FetchError
from smetrics.platforms.instagram import NeedSession
from smetrics.platforms.facebook import NeedLogin
from smetrics import writer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "config.json")
CACHE_PATH = os.path.join(HERE, ".cache", "channel_ids.json")
IG_ID_CACHE = os.path.join(HERE, ".cache", "ig_user_ids.json")
SUPPORTED = {"youtube", "instagram", "facebook"}


def main():
    args = parse_args()
    cfg = load_config(args.config)
    tz_name = args.tz or cfg.get("timezone") or "Asia/Shanghai"
    tz = ZoneInfo(tz_name)
    target_dates = resolve_dates(args, tz)

    accounts, warnings = load_accounts(args.input)
    if args.platform:
        accounts = [a for a in accounts if a.platform == args.platform]

    todo = [a for a in accounts if a.platform in SUPPORTED]
    skipped = [a for a in accounts if a.platform not in SUPPORTED]
    for a in skipped:
        warnings.append(f"第 {a.row_no} 行「{a.name}」是 {a.platform}，当前版本还没接入，已跳过")

    if not todo:
        print("没有可采集的账号。当前版本支持 YouTube、Instagram 和 Facebook。")
        if warnings:
            print("\n".join("  ! " + w for w in warnings))
        return 1

    # 同平台连续跑，避免浏览器实例反复启停
    order = {"youtube": 0, "instagram": 1, "facebook": 2}
    todo.sort(key=lambda a: (order.get(a.platform, 9), a.row_no))

    options = FetchOptions(target_dates=target_dates, tz_name=tz_name,
                           scan_pages=args.scan_pages, check_shorts=not args.no_shorts_check)

    fetchers = build_fetchers(args, cfg, todo)
    results, t0 = [], time.time()
    give_up_platforms = set()

    print(f"目标日期 {date_label(target_dates)}（{tz_name}），待采集 {len(todo)} 个账号\n")
    for i, account in enumerate(todo, start=1):
        label = f"[{i}/{len(todo)}] {account.name}"
        if account.platform in give_up_platforms:
            results.append(failed_row(account, options, tz, "该平台本次已中止（见上方提示）"))
            continue
        try:
            rows = fetchers[account.platform].fetch(account, options)
            results.extend(rows)
            hit = [r for r in rows if r.status == "OK"]
            if hit:
                print(f"{label} → 当天 {len(hit)} 条，点赞 {hit[0].like_count}，评论 {hit[0].comment_count}")
            else:
                print(f"{label} → 当天无发布")
        except QuotaExceeded as e:
            print(f"\n[中止] {e}")
            print("已采集到的部分结果仍会写入文件。")
            results.append(failed_row(account, options, tz, str(e)))
            break
        except NeedSession as e:
            # 这是单账号级别的限制（年龄限制、私密等），其余账号匿名照样能抓，不中止平台
            print(f"{label} → 需要 sessionid 才能抓（其余账号继续）")
            results.append(failed_row(account, options, tz, str(e)))
        except NeedLogin as e:
            print(f"{label} → 需要 Facebook 登录 cookie 才能抓（其余账号继续）")
            results.append(failed_row(account, options, tz, str(e)))
        except (FetchError, Exception) as e:
            msg = str(e) or type(e).__name__
            print(f"{label} → 失败：{msg}")
            results.append(failed_row(account, options, tz, msg))
        if args.delay:
            time.sleep(args.delay)

    for f in fetchers.values():
        try:
            f.close()
        except Exception:
            pass

    api_calls = 0
    for f in fetchers.values():
        http = getattr(f, "http", None)
        api_calls += getattr(http, "api_calls", 0) if http else getattr(f, "api_calls", 0)
    run_meta = {
        "目标日期": date_label(target_dates),
        "判定时区": tz_name,
        "输入文件": args.input,
        "账号数": len(todo),
        "API 请求次数": api_calls,
        "耗时": f"{time.time() - t0:.1f} 秒",
        "运行时间": datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S"),
    }

    out_dir = args.out or os.path.join(HERE, "results")
    xlsx_path, jsonl_path = writer.default_out_paths(out_dir, date_label(target_dates))
    writer.write_excel(results, xlsx_path, run_meta)
    writer.write_jsonl(results, jsonl_path)
    writer.print_summary(results, warnings, run_meta)
    print(f"\n结果已写入：\n  {xlsx_path}\n  {jsonl_path}")

    if not args.no_fill_back:
        if args.input.lower().endswith((".xlsx", ".xlsm")):
            from smetrics.filler import fill_back
            filled_path, fill_notes = fill_back(args.input, results, out_dir, target_dates)
            print(f"\n已回填原表结构（原文件未改动）：\n  {filled_path}")
            for n in fill_notes:
                print("  · " + n)
        else:
            print("\n输入是 csv，跳过回填原表（回填只支持 xlsx）")
    return 0


def build_fetchers(args, cfg, todo) -> dict:
    """按需构建：没有 YouTube 账号就不要求 API Key，没有 IG 账号就不启动浏览器。"""
    platforms = {a.platform for a in todo}
    fetchers = {}

    if "youtube" in platforms:
        from smetrics.platforms.youtube import YouTubeFetcher
        api_key = args.api_key or os.environ.get("YOUTUBE_API_KEY") or cfg.get("youtube_api_key", "")
        if not api_key:
            sys.exit("缺少 YouTube API Key。三种给法任选：\n"
                     "  1) 复制 config.example.json 为 config.json 并填入 youtube_api_key\n"
                     "  2) export YOUTUBE_API_KEY=xxx\n"
                     "  3) python3 run.py --api-key xxx --input ...")
        fetchers["youtube"] = YouTubeFetcher(api_key, cache_path=CACHE_PATH, timeout=args.timeout)

    if "instagram" in platforms:
        from smetrics.platforms.instagram import InstagramFetcher
        fetchers["instagram"] = InstagramFetcher(
            sessionid=os.environ.get("INSTAGRAM_SESSIONID") or cfg.get("instagram_sessionid", ""),
            cache_path=IG_ID_CACHE,
            min_delay=args.ig_min_delay if args.ig_min_delay is not None else cfg.get("ig_min_delay", 2.5),
            max_delay=args.ig_max_delay if args.ig_max_delay is not None else cfg.get("ig_max_delay", 5.0),
            use_browser=args.use_browser,
            timeout=args.timeout,
        )

    if "facebook" in platforms:
        from smetrics.platforms.facebook import FacebookFetcher
        fetchers["facebook"] = FacebookFetcher(
            min_delay=args.fb_min_delay if args.fb_min_delay is not None else cfg.get("fb_min_delay", 5.0),
            max_delay=args.fb_max_delay if args.fb_max_delay is not None else cfg.get("fb_max_delay", 10.0),
        )

    return fetchers


def resolve_dates(args, tz) -> list:
    today = datetime.now(tz).date()
    yesterday = today - timedelta(days=1)
    keywords = {"today": today, "今天": today,
                "yesterday": yesterday, "昨天": yesterday}
    if args.date:
        out = []
        for token in args.date.split(","):
            token = token.strip()
            if not token:
                continue
            hit = keywords.get(token.lower())
            out.append(hit.strftime("%Y-%m-%d") if hit else token)
        return sorted(set(out))
    if args.days and args.days > 1:
        return [(today - timedelta(days=n)).strftime("%Y-%m-%d") for n in range(args.days - 1, -1, -1)]
    return [today.strftime("%Y-%m-%d")]


def failed_row(account, options, tz, error: str) -> PostMetric:
    return PostMetric(
        row_no=account.row_no, account_name=account.name, platform=account.platform,
        profile_url=account.url, target_date=date_label(options.target_dates),
        status=STATUS_FAILED, error=error,
        fetched_at=datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S"))


def load_config(path: str) -> dict:
    path = path or DEFAULT_CONFIG
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_args():
    p = argparse.ArgumentParser(description="抓取合作伙伴社媒账号当天发布内容的点赞与评论数")
    p.add_argument("--input", "-i", required=True, help="账号表格路径（.xlsx / .csv）")
    p.add_argument("--date", help="目标日期 YYYY-MM-DD，可逗号分隔多个；也支持 today / yesterday；默认今天")
    p.add_argument("--days", type=int, default=1, help="抓最近 N 天（含今天），与 --date 二选一")
    p.add_argument("--tz", help="判定「当天」用的时区，默认 Asia/Shanghai")
    p.add_argument("--out", help="结果输出目录，默认 ./results")
    p.add_argument("--api-key", help="YouTube API Key")
    p.add_argument("--config", help="配置文件路径，默认 ./config.json")
    p.add_argument("--platform", choices=["youtube", "instagram", "facebook"], help="只跑指定平台")
    p.add_argument("--scan-pages", type=int, default=3, help="时间线最多翻几页，每页 50 条，默认 3")
    p.add_argument("--no-shorts-check", action="store_true", help="跳过 Shorts 精确判定（更快）")
    p.add_argument("--no-fill-back", action="store_true",
                   help="不回填原表，只输出独立结果文件（默认会额外产出一份回填好的原表副本）")
    p.add_argument("--delay", type=float, default=0, help="每个账号之间额外等待秒数")
    p.add_argument("--use-browser", action="store_true",
                   help="允许在必要时借浏览器解析 Instagram user id（日常不需要）")
    p.add_argument("--ig-min-delay", type=float, help="Instagram 每个账号之间最短间隔秒数，默认 2.5")
    p.add_argument("--ig-max-delay", type=float, help="Instagram 每个账号之间最长间隔秒数，默认 5")
    p.add_argument("--fb-min-delay", type=float, help="Facebook 每个账号之间最短间隔秒数，默认 5")
    p.add_argument("--fb-max-delay", type=float, help="Facebook 每个账号之间最长间隔秒数，默认 10")
    p.add_argument("--timeout", type=int, default=20, help="单次请求超时秒数")
    return p.parse_args()


if __name__ == "__main__":
    sys.exit(main())
