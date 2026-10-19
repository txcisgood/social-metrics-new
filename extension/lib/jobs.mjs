import {describeError} from './errors.mjs';

export function localDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const DAY_MS = 86400000;
const inputError = (code, message) => Object.assign(new Error(message), {code});
const validYear = value => Number.isInteger(value) && value >= 1 && value <= 9999;
const monthDays = (year, month) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
const calendarDate = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [year, month, day] = value.split('-').map(Number);
  if (!validYear(year) || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) return NaN;
  return Date.parse(`${value}T00:00:00Z`) / DAY_MS;
}

function dateInterval(start, end) {
  if (start > end) throw inputError('DATE_RANGE_REVERSED', '开始日期不能晚于结束日期');
  const length = end - start + 1;
  if (length > 366) throw inputError('DATE_RANGE_TOO_LONG', '日期范围最多包含 366 天（含开始和结束日期）');
  // These are calendar-day indexes, not local instants: a DST transition must
  // never skip or repeat a selected day.
  return Array.from({length}, (_, i) => new Date((start + i) * DAY_MS).toISOString().slice(0, 10));
}

export function resolveDates({dateMode, days, targetDate, timeZone, targetMonth, quarterYear, quarter, startDate, endDate}, now = new Date()) {
  let today;
  try {
    if (typeof timeZone !== 'string' || !timeZone.trim()) throw new Error();
    today = localDate(now, timeZone);
  } catch {
    throw inputError('INVALID_TIME_ZONE', '判定时区无效，请选择有效的 IANA 时区。');
  }
  if (dateMode === 'days') {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw inputError('INVALID_DAYS', '最近天数必须在 1 至 366 之间');
    const end = calendarDay(today);
    return dateInterval(end - days + 1, end);
  }
  if (dateMode === 'date') {
    if (!Number.isFinite(calendarDay(targetDate))) throw inputError('INVALID_DATE', '请选择有效的目标日期');
    return [targetDate];
  }
  if (dateMode === 'month') {
    const match = typeof targetMonth === 'string' && /^(\d{4})-(\d{2})$/.exec(targetMonth);
    const year = match ? Number(match[1]) : NaN, month = match ? Number(match[2]) : NaN;
    if (!validYear(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw inputError('INVALID_MONTH', '请选择有效的月份（YYYY-MM）');
    }
    return dateInterval(calendarDay(calendarDate(year, month, 1)), calendarDay(calendarDate(year, month, monthDays(year, month))));
  }
  if (dateMode === 'quarter') {
    if (!validYear(quarterYear)) throw inputError('INVALID_QUARTER_YEAR', '季度年份必须是 1 至 9999 之间的整数');
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw inputError('INVALID_QUARTER', '请选择第一至第四季度');
    const firstMonth = (quarter - 1) * 3 + 1, lastMonth = firstMonth + 2;
    return dateInterval(calendarDay(calendarDate(quarterYear, firstMonth, 1)),
      calendarDay(calendarDate(quarterYear, lastMonth, monthDays(quarterYear, lastMonth))));
  }
  if (dateMode === 'range') {
    const start = calendarDay(startDate), end = calendarDay(endDate);
    if (!Number.isFinite(start)) throw inputError('INVALID_RANGE_START', '请选择有效的开始日期');
    if (!Number.isFinite(end)) throw inputError('INVALID_RANGE_END', '请选择有效的结束日期');
    return dateInterval(start, end);
  }
  throw inputError('INVALID_DATE_MODE', '请选择支持的日期范围类型');
}

/** Compact export label without implying that missing dates were selected. */
export function dateRangeLabel(targetDates) {
  const dates = [...new Set(targetDates)].sort();
  const ranges = [];
  for (let i = 0; i < dates.length;) {
    const first = dates[i];
    let last = first;
    while (i + 1 < dates.length && calendarDay(dates[i + 1]) === calendarDay(last) + 1) last = dates[++i];
    ranges.push(first === last ? first : `${first} 至 ${last}`);
    i += 1;
  }
  return ranges.join(',');
}

export function failedRow(account, options, reason, {id = '', skipped = false} = {}) {
  const error = reason instanceof Error ? reason : new Error(String(reason || ''));
  const friendly = describeError(error, {platform: account.platform, stage: 'collect'});
  const title = skipped ? '未采集（该平台已暂停）' : friendly.title;
  const action = skipped ? `前面的同平台账号触发了平台停止，本账号未发送采集请求。${friendly.action}` : friendly.action;
  return {row_no: account.row_no, account_name: account.name, platform: account.platform,
    profile_url: account.url, target_date: dateRangeLabel(options.targetDates), status: 'FAILED', skipped,
    error: skipped ? `该平台本轮已停止。${title}：${action}` : `${title}：${friendly.message} ${action}`,
    error_title: title, error_action: action, error_code: friendly.code, error_id: id,
    fetched_at: new Date().toISOString(), extra: {备注: account.note || ''}};
}

// The whole job runs in the extension tab. Each pending account is retained on
// rate limits, cancellation or interrupted-tab recovery, never mislabeled NO_POST.
export async function runAccounts(accounts, options, collectors, {signal, onAccount = async () => {}, onError = () => ''} = {}) {
  const halted = new Map();
  const results = [];
  const reportError = (error, account) => {
    try { return onError(error, account) || ''; }
    catch { return ''; } // A diagnostic failure must not discard collection results.
  };
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    let rows;
    if (signal?.aborted) rows = [failedRow(account, options, Object.assign(new Error('用户已停止；此账号未完成采集'), {code: 'CANCELLED'}))];
    else if (halted.has(account.platform)) {
      const {error, id} = halted.get(account.platform);
      rows = [failedRow(account, options, error, {id, skipped: true})];
    }
    else {
      try {
        const collect = collectors[account.platform];
        if (!collect) throw new Error('当前平台不支持采集');
        rows = await collect(account, options);
        if (!Array.isArray(rows) || !rows.length) throw new Error('采集未返回有效结果');
        rows = rows.map(row => {
          if (row.status !== 'FAILED') return row;
          const error = Object.assign(new Error(row.error || '内容详情无法读取'), {code: row.error_code, stopReason: row.stop_reason});
          const id = reportError(error, account);
          return {...row, ...failedRow(account, options, error, {id}), extra: row.extra || {备注: account.note || ''}};
        });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        const id = reportError(error, account);
        const partial = Array.isArray(error.partialRows) ? error.partialRows.filter(row => row?.status === 'OK'
          && row.row_no === account.row_no && row.platform === account.platform && row.profile_url === account.url) : [];
        rows = [...partial, failedRow(account, options, error, {id})];
        if (['RATE_LIMIT', 'AUTH', 'TAB'].includes(error.code)) halted.set(account.platform, {error, id});
      }
    }
    results.push(...rows);
    await onAccount({account, rows, results, index: i + 1, total: accounts.length, pending: accounts.slice(i + 1)});
  }
  return results;
}
