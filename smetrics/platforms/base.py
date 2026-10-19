"""平台采集器基类。新增 新平台 时继承它即可，主流程不用改。"""

from ..models import AccountRow, FetchOptions, PostMetric


class BaseFetcher:
    platform = ""
    display_name = ""

    def fetch(self, account: AccountRow, options: FetchOptions) -> list:
        """返回 PostMetric 列表。

        约定：
        - 目标日期内有 N 条作品 → 返回 N 行 status=OK
        - 目标日期内没有作品     → 返回 1 行 status=NO_POST
        - 抓取失败              → 抛 FetchError，由主流程记成 FAILED
        """
        raise NotImplementedError

    def close(self):
        pass
