"""结果输出：Excel（结果 + 待人工核对两个 sheet）、jsonl 原始留档、控制台汇总。"""

import json
import os
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

from .models import STATUS_OK, STATUS_NO_POST, STATUS_FAILED

HEADERS = ["行号", "账号名", "平台", "主页链接", "目标日期", "当天有无发布",
           "作品标题", "作品链接", "发布时间(本地)", "类型", "时长",
           "粉丝数", "播放", "点赞", "评论", "抓取时间", "备注"]

STATUS_TEXT = {STATUS_OK: "有", STATUS_NO_POST: "无", STATUS_FAILED: "抓取失败"}
PLATFORM_TEXT = {"youtube": "YouTube", "instagram": "Instagram", "facebook": "Facebook"}

HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
OK_FILL = PatternFill("solid", fgColor="E2EFDA")
NONE_FILL = PatternFill("solid", fgColor="FFF2CC")
FAIL_FILL = PatternFill("solid", fgColor="FCE4E4")


def write_excel(results: list, out_path: str, run_meta: dict) -> str:
    wb = Workbook()
    ws = wb.active
    ws.title = "采集结果"
    _write_header(ws, HEADERS)

    for r in results:
        note = r.extra.get("备注") or r.extra.get("提示") or ""
        if r.status == STATUS_FAILED and r.error:
            note = r.error
        elif r.status == STATUS_NO_POST and r.extra.get("提示"):
            note = r.extra["提示"]

        ws.append([
            r.row_no,
            r.account_name,
            PLATFORM_TEXT.get(r.platform, r.platform),
            r.profile_url,
            r.target_date,
            STATUS_TEXT.get(r.status, r.status),
            r.post_title,
            r.post_url,
            r.published_local,
            r.post_type,
            r.extra.get("时长", ""),
            r.follower_count,
            r.view_count,
            r.like_count,
            r.comment_count,
            r.fetched_at,
            note,
        ])
        row = ws.max_row
        fill = {STATUS_OK: OK_FILL, STATUS_NO_POST: NONE_FILL}.get(r.status, FAIL_FILL)
        ws.cell(row=row, column=6).fill = fill
        _linkify(ws.cell(row=row, column=4))
        _linkify(ws.cell(row=row, column=8))

    _finish_sheet(ws, [6, 22, 11, 38, 20, 13, 46, 40, 19, 11, 9, 12, 11, 11, 11, 19, 34])

    failed = [r for r in results if r.status == STATUS_FAILED]
    if failed:
        ws2 = wb.create_sheet("待人工核对")
        _write_header(ws2, ["行号", "账号名", "平台", "主页链接", "失败原因", "建议"])
        for r in failed:
            ws2.append([r.row_no, r.account_name, PLATFORM_TEXT.get(r.platform, r.platform),
                        r.profile_url, r.error, _suggest(r.error)])
            _linkify(ws2.cell(row=ws2.max_row, column=4))
        _finish_sheet(ws2, [6, 22, 11, 38, 50, 42])

    ws3 = wb.create_sheet("本次运行信息")
    ws3.append(["项目", "值"])
    _write_header(ws3, ["项目", "值"], overwrite=True)
    for k, v in run_meta.items():
        ws3.append([k, str(v)])
    _finish_sheet(ws3, [26, 70])

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    wb.save(out_path)
    return out_path


def write_jsonl(results: list, out_path: str) -> str:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r.to_dict(), ensure_ascii=False) + "\n")
    return out_path


def print_summary(results: list, warnings: list, run_meta: dict):
    ok = [r for r in results if r.status == STATUS_OK]
    none_ = [r for r in results if r.status == STATUS_NO_POST]
    failed = [r for r in results if r.status == STATUS_FAILED]

    print("\n" + "=" * 62)
    print(f"目标日期：{run_meta.get('目标日期')}   时区：{run_meta.get('判定时区')}")
    print(f"账号数：{run_meta.get('账号数')}   API 请求数：{run_meta.get('API 请求次数')}")
    print(f"当天有发布：{len({r.account_name for r in ok})} 个账号 / 共 {len(ok)} 条作品")
    print(f"当天无发布：{len(none_)} 个账号")
    print(f"抓取失败　：{len(failed)} 个账号")
    print("=" * 62)

    for r in ok:
        print(f"  ● {r.account_name} | {r.post_type} | 点赞 {r.like_count} | 评论 {r.comment_count}")
        print(f"    {r.post_title[:60]}")
    for r in failed:
        print(f"  ✗ {r.account_name}：{r.error}")
    for w in warnings:
        print(f"  ! {w}")


def default_out_paths(out_dir: str, tag: str) -> tuple:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.join(out_dir, f"社媒动态-{tag}-{stamp}")
    return base + ".xlsx", base + ".jsonl"


def _write_header(ws, headers, overwrite=False):
    if overwrite:
        for i, h in enumerate(headers, start=1):
            ws.cell(row=1, column=i, value=h)
    else:
        ws.append(headers)
    for i in range(1, len(headers) + 1):
        c = ws.cell(row=1, column=i)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = HEADER_FILL
        c.alignment = Alignment(horizontal="center", vertical="center")


def _finish_sheet(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    if ws.max_row > 1:
        ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"
    ws.row_dimensions[1].height = 22


def _linkify(cell):
    val = str(cell.value or "")
    if val.startswith("http"):
        cell.hyperlink = val
        cell.font = Font(color="0563C1", underline="single")


def _suggest(error: str) -> str:
    e = error or ""
    if "配额" in e:
        return "等次日配额重置，或换一个 API Key"
    if "无法解析出频道" in e:
        return "把链接换成频道主页（youtube.com/@xxx 或 /channel/UCxxx）"
    if "查不到" in e or "不存在" in e:
        return "确认账号是否改名或已注销，手动打开链接看一眼"
    if "网络" in e or "超时" in e.lower():
        return "网络抖动，重跑一次通常就好"
    return "手动打开主页链接确认"
