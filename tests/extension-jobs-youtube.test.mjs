import test from 'node:test';
import assert from 'node:assert/strict';
import {dateRangeLabel, localDate, resolveDates, runAccounts} from '../extension/lib/jobs.mjs';
import {collectYouTube, videoType} from '../extension/lib/youtube.mjs';
import {
  usableInstagramTab,
  createYouTubeRequest, delay,
} from '../extension/lib/transport.mjs';

const OPTIONS = {targetDates: ['2026-08-29'], timeZone: 'Europe/London', maxPages: 3};
const CHANNEL_ID = 'UC' + 'A'.repeat(22);
const YT = {row_no: 2, name: 'Test channel', url: `https://www.youtube.com/channel/${CHANNEL_ID}`, platform: 'youtube'};
const account = (row_no, platform) => ({row_no, platform, name: `Account ${row_no}`, url: `https://${platform}.com/test`});
const error = (code, message = code) => Object.assign(new Error(message), {code});

test('job normalization preserves the actual quick-scan stop reason in exports and user guidance', async () => {
  const a = account(2, 'instagram');
  const rows = await runAccounts([a], OPTIONS, {instagram: async () => [{row_no: 2, status: 'FAILED',
    error_code: 'PAGE_INCOMPLETE', stop_reason: 'recent_boundary', extra: {'停止原因': 'recent_boundary'}}]});
  assert.equal(rows[0].stop_reason, 'recent_boundary'); assert.equal(rows[0].extra['停止原因'], 'recent_boundary');
  assert.match(rows[0].error_action, /继续检查更多内容/);
});

function globalValue(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

function channel(statistics = {subscriberCount: '1234'}) {
  return {items: [{id: CHANNEL_ID, contentDetails: {relatedPlaylists: {uploads: 'UU_TEST'}}, statistics}]};
}

function item(id, published = '2026-08-29T12:00:00Z') {
  return {contentDetails: {videoId: id, videoPublishedAt: published}, snippet: {title: `Video ${id}`}};
}

function detail(id, statistics = {viewCount: '123', likeCount: '4', commentCount: '5'}, extras = {}) {
  return {id, snippet: {title: `Detailed ${id}`}, statistics, contentDetails: {duration: 'PT45S'}, ...extras};
}

function api(responses) {
  const calls = [];
  const request = async (endpoint, params) => {
    const response = responses[calls.length];
    assert.ok(response, `Unexpected ${endpoint} request`);
    calls.push({endpoint, params});
    assert.equal(endpoint, response.endpoint);
    if (response.check) response.check(params);
    if (response.error) throw response.error;
    return response.body;
  };
  return {request, calls};
}

test('runAccounts rate limit stops only that platform and records every account', async () => {
  const accounts = [account(2, 'instagram'), account(3, 'youtube'), account(4, 'instagram'), account(5, 'youtube')];
  const calls = [], progress = [];
  const rows = await runAccounts(accounts, OPTIONS, {
    instagram: async a => { calls.push(a.row_no); throw error('RATE_LIMIT', '限流'); },
    youtube: async a => { calls.push(a.row_no); return [{row_no: a.row_no, status: 'NO_POST'}]; },
  }, {onAccount: async event => progress.push({index: event.index, pending: event.pending.length, rows: event.results.length})});
  assert.deepEqual(calls, [2, 3, 5]);
  assert.deepEqual(rows.map(row => row.row_no), [2, 3, 4, 5]);
  assert.deepEqual(rows.map(row => row.status), ['FAILED', 'NO_POST', 'FAILED', 'NO_POST']);
  assert.match(rows[2].error, /本轮已停止/);
  assert.deepEqual(progress, [
    {index: 1, pending: 3, rows: 1}, {index: 2, pending: 2, rows: 2},
    {index: 3, pending: 1, rows: 3}, {index: 4, pending: 0, rows: 4},
  ]);
});

test('runAccounts authentication or closed-tab errors prevent subsequent same-platform retries', async () => {
  for (const code of ['AUTH', 'TAB']) {
    let calls = 0;
    const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram')], OPTIONS, {
      instagram: async () => { calls += 1; throw error(code); },
    });
    assert.equal(calls, 1);
    assert.deepEqual(rows.map(row => row.status), ['FAILED', 'FAILED']);
  }
});

test('ordinary account errors are not retried and do not suppress other accounts', async () => {
  const calls = [];
  const rows = await runAccounts([account(2, 'youtube'), account(3, 'youtube')], OPTIONS, {
    youtube: async a => { calls.push(a.row_no); if (a.row_no === 2) throw new Error('Missing channel'); return [{row_no: a.row_no, status: 'OK'}]; },
  });
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual(rows.map(row => row.status), ['FAILED', 'OK']);
});

test('cancellation before the job retains failed rows without any collector request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'youtube')], OPTIONS, {
    instagram: async () => { calls += 1; }, youtube: async () => { calls += 1; },
  }, {signal: controller.signal});
  assert.equal(calls, 0);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'FAILED' && /用户已停止/.test(row.error)));
});

test('mid-job cancellation retains the current and all pending accounts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const collect = async () => { calls += 1; controller.abort(); throw error('CANCELLED', '用户已停止'); };
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram'), account(4, 'youtube')], OPTIONS,
    {instagram: collect, youtube: collect}, {signal: controller.signal});
  assert.equal(calls, 1);
  assert.deepEqual(rows.map(row => row.row_no), [2, 3, 4]);
  assert.ok(rows.every(row => row.status === 'FAILED'));
});

test('empty collector results cannot silently drop an account', async () => {
  const rows = await runAccounts([account(2, 'instagram')], OPTIONS, {instagram: async () => []});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'FAILED');
});

test('page collection keeps matching partial posts when cancelled, rate limited or logged out', async () => {
  for (const code of ['CANCELLED', 'RATE_LIMIT', 'AUTH', 'TAB']) {
    const accounts = [account(2, 'instagram'), account(3, 'instagram')];
    const controller = new AbortController();
    let calls = 0;
    const partial = {...accounts[0], profile_url: accounts[0].url, status: 'OK', post_url: 'https://www.instagram.com/p/KNOWN/'};
    const rows = await runAccounts(accounts, OPTIONS, {instagram: async () => {
      calls++;
      if (code === 'CANCELLED') controller.abort();
      throw Object.assign(error(code), {partialRows: [partial, {...partial, row_no: 99}, {...partial, status: 'NO_POST'}]});
    }}, {signal: controller.signal});
    assert.equal(calls, 1);
    assert.deepEqual(rows.map(row => row.status), ['OK', 'FAILED', 'FAILED']);
    assert.equal(rows[0].post_url, partial.post_url);
    assert.equal(rows[2].row_no, 3);
  }
});

test('incomplete page coverage retains diagnostics and does not halt later accounts', async () => {
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram')], OPTIONS, {instagram: async a => [
    {row_no: a.row_no, status: 'FAILED', error_code: 'PAGE_INCOMPLETE', error: 'Not complete', extra: {'已访问详情数': 4}},
  ]});
  assert.deepEqual(rows.map(row => row.error_code), ['PAGE_INCOMPLETE', 'PAGE_INCOMPLETE']);
  assert.ok(rows.every(row => !row.skipped && row.extra['已访问详情数'] === 4));
  assert.ok(rows.every(row => row.error_title.includes('完整性待核对')));
});

test('local dates and recent-date windows follow the selected timezone, including DST', () => {
  assert.equal(localDate('2026-10-19T16:30:00Z', 'Asia/Shanghai'), '2026-10-20');
  assert.equal(localDate('2026-10-19T16:30:00Z', 'Europe/London'), '2026-10-19');
  assert.equal(localDate('2026-10-19T00:30:00Z', 'America/Los_Angeles'), '2026-10-18');
  assert.deepEqual(resolveDates({dateMode: 'days', days: 3, timeZone: 'Europe/London'}, new Date('2026-03-30T00:15:00Z')),
    ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.deepEqual(resolveDates({dateMode: 'days', days: 2, timeZone: 'Asia/Shanghai'}, new Date('2026-10-19T16:30:00Z')),
    ['2026-10-19', '2026-10-20']);
});

test('invalid explicit dates and recent-day limits fail', () => {
  for (const targetDate of ['2026-02-30', '2026-2-1', 'not-a-date']) {
    assert.throws(() => resolveDates({dateMode: 'date', targetDate, timeZone: 'UTC'}));
  }
  for (const days of [0, -1, 367, 1.5]) assert.throws(() => resolveDates({dateMode: 'days', days, timeZone: 'UTC'}));
});

test('month selections include the complete month and handle Gregorian leap-year rules', () => {
  for (const [targetMonth, length, end] of [
    ['2026-01', 31, '2026-01-31'], ['2026-04', 30, '2026-04-30'],
    ['2024-02', 29, '2024-02-29'], ['2026-02', 28, '2026-02-28'],
    ['1900-02', 28, '1900-02-28'], ['2000-02', 29, '2000-02-29'],
  ]) {
    const dates = resolveDates({dateMode: 'month', targetMonth, timeZone: 'Asia/Shanghai'}, new Date('2026-01-10T00:00:00Z'));
    assert.equal(dates.length, length);
    assert.equal(dates[0], `${targetMonth}-01`);
    assert.equal(dates.at(-1), end);
    assert.equal(new Set(dates).size, length);
  }
});

test('all four quarters use inclusive calendar boundaries and are not truncated at today', () => {
  for (const [quarter, first, last, length] of [
    [1, '2026-01-01', '2026-03-31', 90], [2, '2026-04-01', '2026-06-30', 91],
    [3, '2026-07-01', '2026-09-30', 92], [4, '2026-10-01', '2026-12-31', 92],
  ]) {
    const dates = resolveDates({dateMode: 'quarter', quarterYear: 2026, quarter, timeZone: 'Europe/London'}, new Date('2026-10-20T00:00:00Z'));
    assert.equal(dates[0], first); assert.equal(dates.at(-1), last); assert.equal(dates.length, length);
    assert.equal(new Set(dates).size, length);
  }
  const leapQuarter = resolveDates({dateMode: 'quarter', quarterYear: 2024, quarter: 1, timeZone: 'UTC'});
  assert.equal(leapQuarter.length, 91); assert.ok(leapQuarter.includes('2024-02-29'));
});

test('custom ranges include both endpoints, allow one day and cross year boundaries', () => {
  assert.deepEqual(resolveDates({dateMode: 'range', startDate: '2026-12-30', endDate: '2027-01-02', timeZone: 'UTC'}),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(resolveDates({dateMode: 'range', startDate: '2024-02-29', endDate: '2024-02-29', timeZone: 'UTC'}), ['2024-02-29']);
  const leapYear = resolveDates({dateMode: 'range', startDate: '2024-01-01', endDate: '2024-12-31', timeZone: 'UTC'});
  assert.equal(leapYear.length, 366); assert.ok(leapYear.includes('2024-02-29'));
  assert.throws(() => resolveDates({dateMode: 'range', startDate: '2024-01-01', endDate: '2025-01-01', timeZone: 'UTC'}),
    value => value.code === 'DATE_RANGE_TOO_LONG');
  assert.throws(() => resolveDates({dateMode: 'range', startDate: '2026-04-01', endDate: '2026-03-31', timeZone: 'UTC'}),
    value => value.code === 'DATE_RANGE_REVERSED');
});

test('range and recent-day enumeration never skips or duplicates dates at DST changes', () => {
  for (const timeZone of ['Europe/London', 'America/New_York', 'Australia/Sydney']) {
    const dates = resolveDates({dateMode: 'range', startDate: '2026-03-28', endDate: '2026-03-30', timeZone});
    assert.deepEqual(dates, ['2026-03-28', '2026-03-29', '2026-03-30']);
  }
  assert.deepEqual(resolveDates({dateMode: 'days', days: 3, timeZone: 'Europe/London'}, new Date('2026-10-26T12:00:00Z')),
    ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(resolveDates({dateMode: 'days', days: 3, timeZone: 'America/New_York'}, new Date('2026-03-09T12:00:00Z')),
    ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(resolveDates({dateMode: 'days', days: 3, timeZone: 'Pacific/Kiritimati'}, new Date('2026-12-31T16:00:00Z')),
    ['2026-12-30', '2026-12-31', '2027-01-01']);
});

test('malformed months, quarters, years, and unknown date modes fail before collecting', () => {
  for (const targetMonth of ['', '2026-00', '2026-13', '2026-1', '0000-01', '10000-01', '2026-02-01', null, 202601]) {
    assert.throws(() => resolveDates({dateMode: 'month', targetMonth, timeZone: 'UTC'}), value => value.code === 'INVALID_MONTH');
  }
  for (const quarterYear of [0, 10000, 2026.5, '2026', null, NaN]) {
    assert.throws(() => resolveDates({dateMode: 'quarter', quarterYear, quarter: 1, timeZone: 'UTC'}), value => value.code === 'INVALID_QUARTER_YEAR');
  }
  for (const quarter of [0, 5, 1.5, '1', null, NaN]) {
    assert.throws(() => resolveDates({dateMode: 'quarter', quarterYear: 2026, quarter, timeZone: 'UTC'}), value => value.code === 'INVALID_QUARTER');
  }
  for (const dateMode of [undefined, '', 'week', '__proto__']) {
    assert.throws(() => resolveDates({dateMode, days: 7, timeZone: 'UTC'}), value => value.code === 'INVALID_DATE_MODE');
  }
});

test('range endpoints reject rolled-over dates and malformed inputs separately', () => {
  for (const invalid of ['2026-02-29', '2024-02-30', '2026-04-31', '2026-00-10', '0000-01-01', '', null, '2026-1-01']) {
    assert.throws(() => resolveDates({dateMode: 'range', startDate: invalid, endDate: '2026-12-31', timeZone: 'UTC'}),
      value => value.code === 'INVALID_RANGE_START');
    assert.throws(() => resolveDates({dateMode: 'range', startDate: '2026-01-01', endDate: invalid, timeZone: 'UTC'}),
      value => value.code === 'INVALID_RANGE_END');
  }
  for (const timeZone of ['Invalid/Zone', '', null, undefined]) {
    assert.throws(() => resolveDates({dateMode: 'date', targetDate: '2026-01-01', timeZone}), value => value.code === 'INVALID_TIME_ZONE');
  }
});

test('calendar construction retains four-digit years and does not apply Date.UTC century conversion', () => {
  const dates = resolveDates({dateMode: 'month', targetMonth: '0099-12', timeZone: 'UTC'});
  assert.equal(dates[0], '0099-12-01'); assert.equal(dates.at(-1), '0099-12-31');
  const finalQuarter = resolveDates({dateMode: 'quarter', quarterYear: 9999, quarter: 4, timeZone: 'UTC'});
  assert.equal(finalQuarter.at(-1), '9999-12-31');
});

test('export date labels compact consecutive dates without filling gaps or mutating inputs', () => {
  assert.equal(dateRangeLabel([]), '');
  assert.equal(dateRangeLabel(['2026-10-20']), '2026-10-20');
  const dates = ['2027-01-01', '2026-12-31', '2027-01-04', '2026-12-31', '2027-01-03'];
  const before = [...dates];
  assert.equal(dateRangeLabel(dates), '2026-12-31 至 2027-01-01,2027-01-03 至 2027-01-04');
  assert.deepEqual(dates, before);
  assert.equal(dateRangeLabel(resolveDates({dateMode: 'quarter', quarterYear: 2026, quarter: 1, timeZone: 'UTC'})),
    '2026-01-01 至 2026-03-31');
});

test('failed account rows preserve the full selected range with a concise export label', async () => {
  const targetDates = resolveDates({dateMode: 'quarter', quarterYear: 2026, quarter: 4, timeZone: 'UTC'});
  const rows = await runAccounts([account(2, 'youtube')], {...OPTIONS, targetDates}, {
    youtube: async () => { throw new Error('Unknown failure'); },
  });
  assert.equal(rows[0].target_date, '2026-10-01 至 2026-12-31');
});

test('YouTube page cap fails instead of returning partial rows or NO_POST', async () => {
  for (const published of ['2026-08-29T12:00:00Z', '2026-08-30T12:00:00Z']) {
    const {request, calls} = api([
      {endpoint: 'channels', body: channel()},
      {endpoint: 'playlistItems', body: {items: [item('A', published)], nextPageToken: 'next'}},
    ]);
    await assert.rejects(collectYouTube(YT, {...OPTIONS, maxPages: 1}, request), /分页上限/);
    assert.equal(calls.length, 2);
  }
});

test('YouTube repeated cursors fail without requesting the same page again', async () => {
  const {request, calls} = api([
    {endpoint: 'channels', body: channel()},
    {endpoint: 'playlistItems', body: {items: [item('A')], nextPageToken: 'repeat'}},
    {endpoint: 'playlistItems', body: {items: [item('B')], nextPageToken: 'repeat'}},
  ]);
  await assert.rejects(collectYouTube(YT, OPTIONS, request), /游标重复/);
  assert.equal(calls.length, 3);
});

test('YouTube only returns NO_POST after reaching a terminal page', async () => {
  const {request, calls} = api([
    {endpoint: 'channels', body: channel()},
    {endpoint: 'playlistItems', body: {items: [item('NEW', '2026-08-30T12:00:00Z')], nextPageToken: 'older'}},
    {endpoint: 'playlistItems', check: params => assert.equal(params.pageToken, 'older'), body: {items: [item('OLD', '2026-08-28T12:00:00Z')]}},
  ]);
  const rows = await collectYouTube(YT, OPTIONS, request);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'NO_POST');
  assert.equal(calls.length, 3);
});

test('YouTube three chronological older videos establish coverage without another page', async () => {
  const {request, calls} = api([
    {endpoint: 'channels', body: channel()},
    {endpoint: 'playlistItems', body: {items: [item('A', '2026-08-28T12:00:00Z'), item('B', '2026-08-27T12:00:00Z'), item('C', '2026-08-26T12:00:00Z')], nextPageToken: 'unused'}},
  ]);
  assert.equal((await collectYouTube(YT, OPTIONS, request))[0].status, 'NO_POST');
  assert.equal(calls.length, 2);
});

test('YouTube deduplicates pages and records unavailable details as partial failures', async () => {
  const {request} = api([
    {endpoint: 'channels', body: channel()},
    {endpoint: 'playlistItems', body: {items: [item('A')], nextPageToken: 'next'}},
    {endpoint: 'playlistItems', body: {items: [item('A'), item('GONE')]}},
    {endpoint: 'videos', check: params => assert.deepEqual(params.id.split(',').sort(), ['A', 'GONE']), body: {items: [detail('A')]}},
  ]);
  const rows = await collectYouTube(YT, OPTIONS, request);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.post_url.endsWith('=A')).status, 'OK');
  assert.equal(rows.find(row => row.post_url.endsWith('=GONE')).status, 'FAILED');
});

test('YouTube metrics retain zero and missing fields remain unavailable', async () => {
  const {request} = api([
    {endpoint: 'channels', body: channel({hiddenSubscriberCount: true})},
    {endpoint: 'playlistItems', body: {items: [item('A')]}},
    {endpoint: 'videos', body: {items: [detail('A', {viewCount: '0'})]}},
  ]);
  const [row] = await collectYouTube(YT, OPTIONS, request);
  assert.equal(row.view_count, 0);
  assert.equal(row.like_count, '未公开或不可用');
  assert.equal(row.comment_count, '未公开或不可用');
  assert.equal(row.follower_count, '未公开');
  assert.match(row.post_type, /疑似 Shorts/);
});

test('YouTube publication filtering uses local date and ignores playlist insertion time', async () => {
  const {request} = api([
    {endpoint: 'channels', body: channel()},
    {endpoint: 'playlistItems', body: {items: [
      item('MIDNIGHT', '2026-08-28T23:15:00Z'), item('AFTER', '2026-08-29T23:15:00Z'),
      {contentDetails: {videoId: 'PRIVATE'}, snippet: {publishedAt: '2026-08-29T12:00:00Z'}},
    ]}},
    {endpoint: 'videos', check: params => assert.equal(params.id, 'MIDNIGHT'), body: {items: [detail('MIDNIGHT')]}},
  ]);
  const rows = await collectYouTube(YT, OPTIONS, request);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].published_local, '2026-08-29 00:15:00');
});

test('YouTube unknown playlist response fails rather than treating missing items as empty', async () => {
  const {request} = api([{endpoint: 'channels', body: channel()}, {endpoint: 'playlistItems', body: {}}]);
  await assert.rejects(collectYouTube(YT, OPTIONS, request), /结构异常/);
});

test('duration alone never confirms Shorts, and live status takes precedence', () => {
  for (const duration of ['PT1S', 'PT45S', 'PT3M']) assert.match(videoType({duration}), /疑似 Shorts/);
  assert.equal(videoType({duration: 'PT3M1S'}), '长视频');
  assert.equal(videoType({duration: 'unknown'}), '视频（类型未确认）');
  assert.equal(videoType({duration: 'PT30S'}, {actualStartTime: '2026-08-29'}), '正在直播');
  assert.equal(videoType({}, {actualEndTime: '2026-08-29'}), '直播回放');
});

test('Instagram tab selection accepts HTTPS profiles and excludes authentication pages', () => {
  assert.equal(usableInstagramTab('https://www.instagram.com/test/'), true);
  for (const url of ['https://fakeinstagram.com/', 'http://www.instagram.com/', 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com/challenge/123/', 'https://www.instagram.com/checkpoint/', 'https://www.instagram.com/accounts/password/reset/']) assert.equal(usableInstagramTab(url), false);
});

test('abort interrupts throttling delay', async () => {
  const controller = new AbortController();
  const waiting = delay(60000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, value => value.code === 'CANCELLED');
});

test('YouTube transport sends key only to Google with omitted credentials', async t => {
  globalValue(t, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/youtube/v3/channels');
    assert.equal(url.searchParams.get('key'), 'test-key');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return {ok: true, status: 200, json: async () => ({items: []})};
  });
  assert.deepEqual(await createYouTubeRequest(' test-key ')('channels', {part: 'id'}), {items: []});
});

test('YouTube transport rejects unknown endpoints and missing keys before fetch', async t => {
  let calls = 0;
  globalValue(t, 'fetch', async () => { calls += 1; });
  await assert.rejects(createYouTubeRequest('test-key')('unknownEndpoint', {}), /不支持/);
  await assert.rejects(createYouTubeRequest(' ')('channels', {}), value => value.code === 'AUTH');
  assert.equal(calls, 0);
});

test('YouTube quota errors stop platform without retries and do not expose API key', async t => {
  let calls = 0;
  globalValue(t, 'fetch', async () => {
    calls += 1;
    return {ok: false, status: 403, json: async () => ({error: {errors: [{reason: 'quotaExceeded'}], message: 'test-key'}})};
  });
  await assert.rejects(createYouTubeRequest('test-key')('channels', {}), value => value.code === 'RATE_LIMIT' && !value.message.includes('test-key'));
  assert.equal(calls, 1);
});

test('non-JSON HTTP 429 still produces YouTube platform rate-limit stop', async t => {
  let calls = 0;
  globalValue(t, 'fetch', async () => {
    calls += 1;
    return {ok: false, status: 429, json: async () => { throw new SyntaxError('HTML instead of JSON'); }};
  });
  await assert.rejects(createYouTubeRequest('test-key')('channels', {}), value => value.code === 'RATE_LIMIT');
  assert.equal(calls, 1);
});

test('non-JSON 401 or 403 still produces YouTube authentication stop', async t => {
  let currentStatus;
  globalValue(t, 'fetch', async () => ({
    ok: false, status: currentStatus, json: async () => { throw new SyntaxError('Empty access-denied response'); },
  }));
  for (const status of [401, 403]) {
    currentStatus = status;
    await assert.rejects(createYouTubeRequest('test-key')('channels', {}), value => value.code === 'AUTH');
  }
});

test('network errors cannot leak the API key in error text', async t => {
  globalValue(t, 'fetch', async url => { throw new Error(`Fetch failed: ${url}`); });
  await assert.rejects(createYouTubeRequest('PRIVATE_TEST_KEY')('channels', {}), value => !value.message.includes('PRIVATE_TEST_KEY') && !value.message.includes('googleapis.com'));
});

test('YouTube pre-cancellation prevents network access', async t => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalValue(t, 'fetch', async () => { calls += 1; });
  await assert.rejects(createYouTubeRequest('test-key', {signal: controller.signal})('channels', {}), value => value.code === 'CANCELLED');
  assert.equal(calls, 0);
});
