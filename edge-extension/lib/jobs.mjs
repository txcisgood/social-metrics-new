import {describeError} from './errors.mjs';

export function localDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function resolveDates({dateMode, days, targetDate, timeZone}, now = new Date()) {
  const today = localDate(now, timeZone); // Also validates the timezone.
  if (dateMode === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '') ||
        !Number.isFinite(Date.parse(targetDate)) || new Date(targetDate).toISOString().slice(0, 10) !== targetDate) {
      throw new Error('请选择有效的目标日期');
    }
    return [targetDate];
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('最近天数必须在 1 至 366 之间');
  return Array.from({length: days}, (_, i) => new Date(Date.parse(today) - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
}

export function failedRow(account, options, reason, {id = '', skipped = false} = {}) {
  const error = reason instanceof Error ? reason : new Error(String(reason || ''));
  const friendly = describeError(error, {platform: account.platform, stage: 'collect'});
  const title = skipped ? '未采集（该平台已暂停）' : friendly.title;
  const action = skipped ? `前面的同平台账号触发了平台停止，本账号未发送采集请求。${friendly.action}` : friendly.action;
  return {row_no: account.row_no, account_name: account.name, platform: account.platform,
    profile_url: account.url, target_date: options.targetDates.join(','), status: 'FAILED', skipped,
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
