"""带重试的 HTTP 客户端。区分「可重试」（限流/网络抖动/5xx）与「立刻放弃」（配额耗尽/key 无效）。"""

import time
import random
import requests


UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


class QuotaExceeded(Exception):
    """API 配额耗尽，继续跑没有意义，直接中止整轮。"""


class FetchError(Exception):
    """单个账号级别的失败，不影响其他账号。"""


class HttpClient:
    def __init__(self, timeout: int = 20, max_retry: int = 3):
        self.timeout = timeout
        self.max_retry = max_retry
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        self.api_calls = 0          # 统计真实请求数，便于估算配额

    def get_json(self, url: str, params: dict = None, count_as_api: bool = True) -> dict:
        last_err = None
        for attempt in range(self.max_retry):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if count_as_api:
                    self.api_calls += 1

                if resp.status_code == 200:
                    return resp.json()

                # 解析 Google API 的结构化错误
                reason, message = _parse_google_error(resp)

                if reason in ("quotaExceeded", "dailyLimitExceeded"):
                    raise QuotaExceeded(message or "YouTube API 当日配额已用尽")
                if reason in ("keyInvalid", "badRequest") and "API key" in (message or ""):
                    raise QuotaExceeded(f"API Key 无效或未启用 YouTube Data API v3：{message}")
                if resp.status_code == 404 or reason in ("notFound", "playlistNotFound", "channelNotFound"):
                    raise FetchError(message or "资源不存在（频道或播放列表找不到）")
                if resp.status_code == 403 and reason not in ("rateLimitExceeded", "userRateLimitExceeded"):
                    raise FetchError(message or "403 无权限访问该资源")

                # 429 / 5xx / rateLimit → 退避重试
                if resp.status_code == 429 or resp.status_code >= 500 or reason in (
                        "rateLimitExceeded", "userRateLimitExceeded", "backendError"):
                    last_err = FetchError(f"HTTP {resp.status_code} {message or ''}".strip())
                    _sleep_backoff(attempt)
                    continue

                raise FetchError(f"HTTP {resp.status_code} {message or resp.text[:200]}")

            except (requests.Timeout, requests.ConnectionError) as e:
                last_err = FetchError(f"网络异常：{type(e).__name__}")
                _sleep_backoff(attempt)
            except ValueError:
                last_err = FetchError("返回内容不是合法 JSON")
                _sleep_backoff(attempt)

        raise last_err or FetchError("请求失败且无明确原因")

    def get_text(self, url: str, allow_redirects: bool = True) -> tuple:
        """返回 (status_code, text)。用于不消耗 API 配额的网页兜底解析。"""
        try:
            resp = self.session.get(url, timeout=self.timeout, allow_redirects=allow_redirects)
            return resp.status_code, resp.text
        except Exception as e:
            raise FetchError(f"网页请求失败：{type(e).__name__}")

    def head_status(self, url: str) -> int:
        """只看状态码，不跟随跳转。用于判定 Shorts。"""
        try:
            resp = self.session.get(url, timeout=self.timeout, allow_redirects=False, stream=True)
            code = resp.status_code
            resp.close()
            return code
        except Exception:
            return -1


def _parse_google_error(resp) -> tuple:
    try:
        data = resp.json()
    except Exception:
        return "", resp.text[:200]
    err = data.get("error") or {}
    message = err.get("message", "")
    errors = err.get("errors") or []
    reason = errors[0].get("reason", "") if errors else err.get("status", "")
    return reason, message


def _sleep_backoff(attempt: int):
    time.sleep((2 ** attempt) + random.uniform(0, 0.6))
