"""读取账号表格（.xlsx / .xls / .csv），自动识别列，并把 URL 归一化成平台标识。"""

import csv
import os
import re
from urllib.parse import urlparse

from .models import AccountRow


# 列名别名。命中任意一个即认为是该列，大小写与空格不敏感。
COLUMN_ALIASES = {
    "name": ["账号名", "账号", "账号名称", "名称", "昵称", "博主", "合作伙伴", "partner",
             "name", "account", "account name", "username", "handle", "channel"],
    "url": ["链接", "主页链接", "主页", "地址", "网址", "url", "link", "profile",
            "profile url", "homepage", "channel url"],
    "platform": ["平台", "渠道", "来源", "platform", "channel type", "source", "site"],
}

PLATFORM_PATTERNS = [
    ("youtube", [r"youtube\.com", r"youtu\.be", r"youtube-nocookie\.com"]),
    ("instagram", [r"instagram\.com", r"instagr\.am"]),
    ("facebook", [r"facebook\.com", r"fb\.com", r"fb\.watch", r"m\.facebook\.com"]),
]

PLATFORM_NAME_HINTS = {
    "youtube": ["youtube", "yt", "油管", "优兔"],
    "instagram": ["instagram", "ins", "ig", "insta"],
    "facebook": ["facebook", "fb", "脸书"],
    # 下面这些不是采集目标，只用于判断「表格填的平台和链接不一致」
    "tiktok": ["tiktok", "tt", "抖音国际版"],
    "douyin": ["douyin", "抖音"],
    "xiaohongshu": ["xiaohongshu", "小红书", "xhs", "red"],
    "weibo": ["weibo", "微博"],
    "bilibili": ["bilibili", "b站", "哔哩哔哩"],
    "kuaishou": ["kuaishou", "快手"],
    "twitter": ["twitter", "x.com", "推特"],
}


def load_accounts(path: str) -> tuple:
    """返回 (accounts, warnings)。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".txt", ".tsv"):
        rows = _read_csv(path)
    elif ext in (".xlsx", ".xlsm"):
        rows = _read_xlsx(path)
    else:
        raise ValueError(f"不支持的文件格式 {ext}，请用 .xlsx 或 .csv（.xls 老格式请先另存为 .xlsx）")

    if not rows:
        raise ValueError("表格是空的")

    idx, header_used = _detect_columns(rows[0])
    data_rows = rows[1:] if header_used else rows

    accounts, warnings = [], []
    for offset, row in enumerate(data_rows):
        excel_row_no = offset + (2 if header_used else 1)
        name = _cell(row, idx.get("name"))
        url = _cell(row, idx.get("url"))
        raw_platform = _cell(row, idx.get("platform"))

        if not name and not url:
            continue  # 空行直接跳过

        if not url:
            warnings.append(f"第 {excel_row_no} 行「{name or '(无名)'}」缺少链接，已跳过")
            continue

        url = _clean_url(url)
        platform = _infer_platform(url)
        note = ""

        if not platform:
            platform = _platform_from_text(raw_platform)
            if platform:
                note = "链接无法识别平台，按表格里填写的平台处理"
            else:
                warnings.append(f"第 {excel_row_no} 行「{name}」的链接无法识别平台：{url}")
                continue
        else:
            declared = _platform_from_text(raw_platform)
            # 识别不出来的（比如列说明文字「什么平台」）直接忽略，只在确实是另一个平台时才提示
            if declared and declared != platform:
                note = f"表格填的是「{raw_platform}」，但链接是 {platform}，已按链接为准"

        accounts.append(AccountRow(
            row_no=excel_row_no,
            name=name or _guess_name_from_url(url),
            url=url,
            platform=platform,
            raw_platform=raw_platform,
            note=note,
        ))

    return accounts, warnings


def _read_xlsx(path: str) -> list:
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = []
    for r in ws.iter_rows(values_only=True):
        if r is None:
            continue
        rows.append(["" if c is None else str(c).strip() for c in r])
    wb.close()
    # 去掉尾部全空行
    while rows and not any(rows[-1]):
        rows.pop()
    return rows


def _read_csv(path: str) -> list:
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                sample = f.read(4096)
                f.seek(0)
                try:
                    dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
                except Exception:
                    dialect = csv.excel
                return [[c.strip() for c in row] for row in csv.reader(f, dialect) if any(c.strip() for c in row)]
        except UnicodeDecodeError:
            continue
    raise ValueError("CSV 编码无法识别，请另存为 UTF-8")


def _detect_columns(first_row: list) -> tuple:
    """尝试把首行当表头。识别不出来就按位置 0=名称 1=链接 2=平台。"""
    normalized = [_norm(c) for c in first_row]
    idx = {}
    for key, aliases in COLUMN_ALIASES.items():
        for i, cell in enumerate(normalized):
            if not cell:
                continue
            if any(cell == _norm(a) or _norm(a) in cell for a in aliases):
                idx.setdefault(key, i)
                break

    looks_like_header = "url" in idx or "name" in idx
    # 首行本身就含链接说明没有表头
    if any(("http" in c or "youtube.com" in c) for c in normalized):
        looks_like_header = False

    if not looks_like_header:
        idx = {"name": 0, "url": 1, "platform": 2}
        return idx, False

    idx.setdefault("name", 0)
    if "url" not in idx:
        # 表头里没有明显的链接列，退化为按位置猜
        idx["url"] = 1
    idx.setdefault("platform", 2)
    return idx, True


def _norm(s) -> str:
    return re.sub(r"[\s_\-（）()]+", "", str(s or "")).lower()


def _cell(row: list, i) -> str:
    if i is None or i >= len(row):
        return ""
    return str(row[i]).strip()


def _clean_url(url: str) -> str:
    url = url.strip().strip("<>\"'，,、")
    if url.startswith("//"):
        url = "https:" + url
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url


def _infer_platform(url: str) -> str:
    host = (urlparse(url).netloc or "").lower()
    target = host + urlparse(url).path.lower()
    for platform, patterns in PLATFORM_PATTERNS:
        if any(re.search(p, target) for p in patterns):
            return platform
    return ""


def _platform_from_text(text: str) -> str:
    t = _norm(text)
    if not t:
        return ""
    for platform, hints in PLATFORM_NAME_HINTS.items():
        if any(_norm(h) == t or _norm(h) in t for h in hints):
            return platform
    return ""


def _guess_name_from_url(url: str) -> str:
    path = urlparse(url).path.strip("/")
    return path.split("/")[-1] if path else url
