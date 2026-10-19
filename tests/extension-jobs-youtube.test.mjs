import test from 'node:test';
import assert from 'node:assert/strict';
import {localDate, resolveDates, runAccounts} from '../edge-extension/lib/jobs.mjs';
import {collectYouTube, videoType} from '../edge-extension/lib/youtube.mjs';
import {
  allowedInstagramPath, usableInstagramTab, createInstagramRequest, instagramPageGet,
  createYouTubeRequest, delay,
} from '../edge-extension/lib/transport.mjs';

const OPTIONS = {targetDates: ['2026-08-29'], timeZone: 'Europe/London', maxPages: 3};
const CHANNEL_ID = 'UC' + 'A'.repeat(22);
const YT = {row_no: 2, name: 'Test channel', url: `https://www.youtube.com/channel/${CHANNEL_ID}`, platform: 'youtube'};
const IG_PATH = '/api/v1/users/web_profile_info/?username=test';
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

test('Instagram transport only permits the three read-only API path families', () => {
  for (const path of [IG_PATH, '/api/v1/users/test.creator/usernameinfo/', '/api/v1/feed/user/123/?count=50&max_id=a%2Bb']) assert.equal(allowedInstagramPath(path), true);
  for (const path of ['https://www.instagram.com/api/v1/users/web_profile_info/', '//evil.example/path', '/api/v1/media/123/like/', '/api/v1/users/test/usernameinfo/#fragment', '/direct/', '/api/v1/feed/user/not-an-id/']) assert.equal(allowedInstagramPath(path), false);
  assert.equal(usableInstagramTab('https://www.instagram.com/test/'), true);
  for (const url of ['https://fakeinstagram.com/', 'http://www.instagram.com/', 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com/challenge/123/', 'https://www.instagram.com/checkpoint/', 'https://www.instagram.com/accounts/password/reset/']) assert.equal(usableInstagramTab(url), false);
});

test('in-page transport uses same-origin GET and never reads document.cookie', async t => {
  globalValue(t, 'location', {origin: 'https://www.instagram.com', pathname: '/test/'});
  globalValue(t, 'document', Object.defineProperty({}, 'cookie', {get() { throw new Error('Cookie access forbidden'); }}));
  let calls = 0;
  globalValue(t, 'fetch', async (url, options) => {
    calls += 1;
    assert.equal(url, `https://www.instagram.com${IG_PATH}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, {'x-ig-app-id': '936619743392459'});
    assert.equal(options.body, undefined);
    return {status: 200, text: async () => '{"status":"ok"}'};
  });
  assert.deepEqual(await instagramPageGet(IG_PATH), {status: 200, text: '{"status":"ok"}'});
  assert.equal(calls, 1);
});

test('in-page transport refuses authentication pages and forbidden paths before fetch', async t => {
  let calls = 0;
  globalValue(t, 'fetch', async () => { calls += 1; throw new Error('must not request'); });
  globalValue(t, 'location', {origin: 'https://www.instagram.com', pathname: '/challenge/123/'});
  assert.equal((await instagramPageGet(IG_PATH)).code, 'AUTH');
  globalThis.location.pathname = '/test/';
  assert.equal((await instagramPageGet('/api/v1/media/123/like/')).code, 'BAD_URL');
  assert.equal(calls, 0);
});

test('Instagram request runs only in selected tab and returns 429 without retrying', async t => {
  let executes = 0;
  globalValue(t, 'chrome', {
    tabs: {get: async id => { assert.equal(id, 17); return {url: 'https://www.instagram.com/test/'}; }},
    scripting: {executeScript: async options => {
      executes += 1;
      assert.deepEqual(options.target, {tabId: 17});
      assert.equal(options.world, 'ISOLATED');
      assert.equal(options.func, instagramPageGet);
      assert.equal(options.args[0], IG_PATH);
      return [{result: {status: 429, text: 'Rate limited'}}];
    }},
  });
  const request = createInstagramRequest(17, {minDelay: 0, maxDelay: 0});
  assert.equal((await request(IG_PATH)).status, 429);
  assert.equal(executes, 1);
});

test('closed or login Instagram tabs prevent script injection', async t => {
  let executes = 0;
  globalValue(t, 'chrome', {tabs: {get: async () => ({url: 'https://www.instagram.com/accounts/login/'})},
    scripting: {executeScript: async () => { executes += 1; }}});
  await assert.rejects(createInstagramRequest(17)(IG_PATH), value => value.code === 'TAB');
  assert.equal(executes, 0);
});

test('cancellation while resolving selected tab prevents subsequent Instagram request', async t => {
  const controller = new AbortController();
  let executes = 0;
  globalValue(t, 'chrome', {
    tabs: {get: async () => { controller.abort(); return {url: 'https://www.instagram.com/test/'}; }},
    scripting: {executeScript: async () => { executes += 1; return [{result: {status: 200, text: '{}'}}]; }},
  });
  await assert.rejects(createInstagramRequest(17, {signal: controller.signal})(IG_PATH), value => value.code === 'CANCELLED');
  assert.equal(executes, 0);
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
  await assert.rejects(createYouTubeRequest('test-key')('search', {}), /不支持/);
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
