"""统一数据结构。所有平台采集器都必须返回 PostMetric 列表。"""

from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional, Any


# 状态枚举
STATUS_OK = "OK"              # 当天有发布，数据已拿到
STATUS_NO_POST = "NO_POST"    # 账号正常，但目标日期没有发布
STATUS_FAILED = "FAILED"      # 抓取失败，需人工核对


@dataclass
class AccountRow:
    """输入表格的一行。"""
    row_no: int
    name: str
    url: str
    platform: str                 # 归一化后的平台标识：youtube / instagram
    raw_platform: str = ""        # 表格里原始写的平台名，用于提示不一致
    note: str = ""                # 归一化阶段产生的提示


@dataclass
class PostMetric:
    """一条作品的采集结果。当天无发布或失败时也产生一行，用 status 区分。"""
    row_no: int
    account_name: str
    platform: str
    profile_url: str
    target_date: str = ""              # 目标日期（本地时区）YYYY-MM-DD
    status: str = STATUS_OK
    post_title: str = ""
    post_url: str = ""
    published_local: str = ""          # 发布时间，已换算到配置时区
    published_utc: str = ""            # 发布时间原始 UTC
    post_type: str = ""                # 长视频 / Shorts / 直播回放 / 直播预告
    view_count: Any = ""
    like_count: Any = ""
    comment_count: Any = ""
    follower_count: Any = ""           # 账号粉丝/订阅数，与作品无关，同账号多行时重复
    channel_id: str = ""
    fetched_at: str = ""
    error: str = ""                    # 失败原因，人可读
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class FetchOptions:
    """一次运行的参数，传给各平台采集器。"""
    target_dates: list             # ["2026-08-29", ...] 本地时区日期，升序
    tz_name: str = "Asia/Shanghai"
    scan_pages: int = 3            # 时间线最多翻几页（每页 50 条）
    check_shorts: bool = True      # 是否额外探测 Shorts（不消耗 API 配额）
    timeout: int = 20


def date_label(dates: list) -> str:
    """把连续的多天压成「起~止」区间，单日原样返回，不连续的用逗号连接。"""
    if not dates:
        return ""
    if len(dates) == 1:
        return dates[0]
    ds = sorted(dates)
    try:
        parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in ds]
    except ValueError:
        return ",".join(ds)
    continuous = all((parsed[i + 1] - parsed[i]).days == 1 for i in range(len(parsed) - 1))
    return f"{ds[0]}~{ds[-1]}" if continuous else ",".join(ds)
