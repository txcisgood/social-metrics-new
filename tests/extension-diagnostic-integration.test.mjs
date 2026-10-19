import assert from 'node:assert/strict';
import test from 'node:test';
import {createDiagnostics} from '../edge-extension/lib/diagnostics.mjs';
import {createInstagramRequest, createYouTubeRequest} from '../edge-extension/lib/transport.mjs';
import {runAccounts} from '../edge-extension/lib/jobs.mjs';

const OPTIONS = {targetDates: ['2026-10-19'], timeZone: 'Europe/London', maxPages: 3};
const SECRET = 'integration-private-key-91/+=&';
const PRIVATE_SENTINEL = 'PRIVATE_ACCOUNT_OR_POST_SENTINEL';

test('performance diagnostics retain scan mode, wait and read times, and platform counters without payloads', () => {
  const log = createDiagnostics({version: 'test'});
  log.setContext({scanMode: 'recent', minDelay: 3, maxDelay: 5});
  log.record('info', 'page.completed', {waitMs: 2000, readMs: 800, caption: PRIVATE_SENTINEL});
  log.record('info', 'scan.completed', {detailCount: 2, pageCount: 1, reason: 'recent_boundary'});
  log.record('info', 'run.finished', {igOperationCount: 3, ytRequestCount: 0, elapsedMs: 2800});
  const snapshot = log.snapshot();
  assert.equal(snapshot.context.scanMode, 'recent'); assert.equal(snapshot.entries[0].details.waitMs, 2000);
  assert.equal(snapshot.entries[0].details.readMs, 800); assert.equal(snapshot.entries[1].details.detailCount, 2);
  assert.equal(snapshot.entries[2].details.igOperationCount, 3); assert.doesNotMatch(log.text(), new RegExp(PRIVATE_SENTINEL));
});
const account = (row_no, platform) => ({row_no, platform, name: `Account ${row_no}`, url: `https://www.${platform}.com/example/`, note: ''});

function globalValue(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

function recorder() {
  const diagnostics = createDiagnostics({version: 'integration-test', secrets: [SECRET]});
  const events = [];
  return {diagnostics, events, onDiagnostic(event, details) {
    events.push({event, details});
    diagnostics.record(event.includes('failed') || event.includes('error') ? 'error' : 'info', event, details);
  }};
}

function assertMetadataIsNarrow(events) {
  for (const {details} of events) {
    for (const key of ['url', 'path', 'params', 'body', 'headers', 'response', 'request', 'key', 'apiKey', 'api_key']) {
      assert.equal(Object.hasOwn(details, key), false, `${key} must not enter request metadata`);
    }
    assert.equal(details.stage, 'request');
    assert.ok(['instagram', 'youtube'].includes(details.platform));
    assert.match(details.endpoint, /^[A-Za-z_]+$/);
  }
}

function assertCompleted(events, expectedStatuses) {
  const starts = events.filter(event => event.event === 'request.started');
  const completions = events.filter(event => event.event === 'request.completed');
  assert.equal(completions.length, expectedStatuses.length);
  assert.equal(starts.length, expectedStatuses.length);
  assert.equal(new Set(starts.map(event => event.details.requestId)).size, starts.length);
  completions.forEach(({details}, index) => {
    assert.equal(details.requestId, starts[index].details.requestId);
    assert.equal(details.endpoint, starts[index].details.endpoint);
    assert.equal(details.status, expectedStatuses[index], 'completed requests must retain HTTP status alongside their request ID');
    assert.ok(Number.isFinite(details.durationMs) && details.durationMs >= 0);
  });
}

test('Instagram diagnostics correlate endpoint, status and duration without paths, usernames or bodies', async t => {
  const log = recorder();
  const body = JSON.stringify({caption: PRIVATE_SENTINEL, api_key: SECRET});
  let requestIndex = 0;
  globalValue(t, 'chrome', {
    tabs: {get: async () => ({url: 'https://www.instagram.com/'})},
    scripting: {executeScript: async () => [{result: {status: ++requestIndex === 3 ? 429 : 200, text: body}}]},
  });
  const request = createInstagramRequest(10, {minDelay: 0, maxDelay: 0, onDiagnostic: log.onDiagnostic});
  assert.equal((await request(`/api/v1/users/web_profile_info/?username=${PRIVATE_SENTINEL}`)).text, body);
  await request(`/api/v1/users/${PRIVATE_SENTINEL}/usernameinfo/`);
  await request(`/api/v1/feed/user/123456789/?count=50&max_id=${encodeURIComponent(SECRET)}`);
  assertCompleted(log.events, [200, 200, 429]);
  assert.deepEqual(log.events.filter(event => event.event === 'request.started').map(event => event.details.endpoint), ['web_profile_info', 'usernameinfo', 'feed']);
  assertMetadataIsNarrow(log.events);
  assert.doesNotMatch(log.diagnostics.text(), /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key|123456789|caption|https:\/\//);
});

test('YouTube diagnostics correlate HTTP status with completion ID and never log request parameters or data', async t => {
  const log = recorder();
  const data = {items: [{snippet: {title: PRIVATE_SENTINEL}}]};
  const fetched = [];
  globalValue(t, 'fetch', async url => {
    fetched.push(new URL(url));
    return {status: 200, ok: true, json: async () => data};
  });
  const request = createYouTubeRequest(SECRET, {onDiagnostic: log.onDiagnostic});
  assert.equal(await request('channels', {forHandle: PRIVATE_SENTINEL, part: 'snippet'}), data);
  await request('videos', {id: PRIVATE_SENTINEL, pageToken: 'privateCursorValue'});
  assert.equal(fetched[0].searchParams.get('key'), SECRET, 'the key is needed by Google, but must not enter diagnostics');
  assertCompleted(log.events, [200, 200]);
  assertMetadataIsNarrow(log.events);
  assert.doesNotMatch(log.diagnostics.text(), /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key|privateCursorValue|https:\/\//);
});

test('YouTube HTTP failure diagnostics retain its status and the same request ID without reading rate-limit bodies', async t => {
  const log = recorder();
  globalValue(t, 'fetch', async () => ({status: 429, ok: false, json: async () => { throw new Error('must not read a rate-limit body'); }}));
  await assert.rejects(createYouTubeRequest(SECRET, {onDiagnostic: log.onDiagnostic})('channels', {forHandle: PRIVATE_SENTINEL}), error => error.code === 'RATE_LIMIT');
  const start = log.events.find(event => event.event === 'request.started');
  const failure = log.events.find(event => event.event === 'request.failed');
  assert.equal(failure.details.requestId, start.details.requestId);
  assert.equal(failure.details.endpoint, 'channels');
  assert.equal(failure.details.status, 429, 'the failed terminal event must connect the HTTP status to the request ID');
  assert.ok(Number.isFinite(failure.details.durationMs));
  assertMetadataIsNarrow(log.events);
  assert.doesNotMatch(log.diagnostics.text(), /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key/);
});

test('native transport errors are sanitized by the actual diagnostics boundary before export', async t => {
  const log = recorder();
  const nativeError = new TypeError(`Failed to fetch https://user:${SECRET}@www.googleapis.com/?key=${encodeURIComponent(SECRET)} ${PRIVATE_SENTINEL}`);
  nativeError.stack = `${nativeError.message}\n at ${PRIVATE_SENTINEL} (chrome-extension://extension-id/lib/transport.mjs:75:3)`;
  globalValue(t, 'fetch', async () => { throw nativeError; });
  await assert.rejects(createYouTubeRequest(SECRET, {onDiagnostic: log.onDiagnostic})('channels', {forHandle: PRIVATE_SENTINEL}));
  globalValue(t, 'chrome', {
    tabs: {get: async () => ({url: 'https://www.instagram.com/'})},
    scripting: {executeScript: async () => { throw nativeError; }},
  });
  await assert.rejects(createInstagramRequest(10, {onDiagnostic: log.onDiagnostic})('/api/v1/users/web_profile_info/?username=example'));
  assert.ok(log.events.some(event => event.details.error === nativeError), 'the internal callback may receive Error objects; the diagnostics module is the sanitization boundary');
  assertMetadataIsNarrow(log.events);
  const exported = log.diagnostics.text();
  assert.doesNotMatch(exported, /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key|googleapis\.com|https:\/\//);
  assert.match(exported, /transport\.mjs:75:3/);
});

test('throwing diagnostic callbacks cannot break either successful transport', async t => {
  let callbackCalls = 0;
  const onDiagnostic = () => { callbackCalls++; throw new Error('diagnostic-only failure'); };
  globalValue(t, 'chrome', {
    tabs: {get: async () => ({url: 'https://www.instagram.com/'})},
    scripting: {executeScript: async () => [{result: {status: 200, text: '{}'}}]},
  });
  globalValue(t, 'fetch', async () => ({status: 200, ok: true, json: async () => ({items: []})}));
  assert.deepEqual(await createInstagramRequest(10, {onDiagnostic})('/api/v1/users/web_profile_info/?username=example'), {status: 200, text: '{}'});
  assert.deepEqual(await createYouTubeRequest(SECRET, {onDiagnostic})('channels', {}), {items: []});
  assert.ok(callbackCalls >= 4);
});

test('failed rows link to the recorded diagnostic without exposing raw exception text in user fields', async () => {
  const diagnostics = createDiagnostics({secrets: [SECRET]});
  const raw = new TypeError(`Unexpected ${PRIVATE_SENTINEL} key=${SECRET}`);
  raw.stack = `${raw.message}\n at unsafeName (chrome-extension://extension-id/lib/instagram.mjs:41:2)`;
  let recordedId;
  const [row] = await runAccounts([account(2, 'instagram')], OPTIONS, {instagram: async () => { throw raw; }}, {
    onError(error, source) {
      assert.equal(error, raw);
      recordedId = diagnostics.record('error', 'account.failed', {row_no: source.row_no, platform: source.platform, error});
      return recordedId;
    },
  });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.error_id, recordedId);
  assert.equal(diagnostics.snapshot().entries[0].id, row.error_id);
  for (const field of ['error', 'error_title', 'error_action', 'error_code']) {
    assert.ok(row[field]);
    assert.doesNotMatch(row[field], /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key|Unexpected|TypeError/);
  }
  assert.doesNotMatch(diagnostics.text(), /PRIVATE_ACCOUNT_OR_POST_SENTINEL|integration-private-key/);
});

test('collector-returned partial failures get diagnostic IDs and safe user messages without changing valid rows', async () => {
  const logged = [];
  const successful = {row_no: 2, platform: 'youtube', status: 'OK', post_url: 'https://www.youtube.com/watch?v=good'};
  const rows = await runAccounts([account(2, 'youtube')], OPTIONS, {youtube: async () => [successful,
    {row_no: 2, platform: 'youtube', status: 'FAILED', post_url: 'https://www.youtube.com/watch?v=gone', error: PRIVATE_SENTINEL},
  ]}, {onError(error, source) { logged.push({error, source}); return 'linked-partial-failure-id'; }});
  assert.equal(rows[0], successful);
  assert.equal(rows[1].error_id, 'linked-partial-failure-id');
  assert.equal(rows[1].post_url, 'https://www.youtube.com/watch?v=gone');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].error.message, PRIVATE_SENTINEL);
  assert.doesNotMatch(rows[1].error, /PRIVATE_ACCOUNT_OR_POST_SENTINEL/);
});

test('rate-limit skipped rows link to the original diagnostic and other platforms continue', async () => {
  const diagnostics = createDiagnostics();
  const called = [], logged = [];
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'youtube'), account(4, 'instagram')], OPTIONS, {
    instagram: async source => { called.push(source.row_no); throw Object.assign(new Error(PRIVATE_SENTINEL), {code: 'RATE_LIMIT'}); },
    youtube: async source => { called.push(source.row_no); return [{row_no: source.row_no, platform: source.platform, status: 'NO_POST'}]; },
  }, {onError(error, source) {
    const id = diagnostics.record('error', 'account.failed', {row_no: source.row_no, platform: source.platform, error});
    logged.push(id); return id;
  }});
  assert.deepEqual(called, [2, 3]);
  assert.equal(logged.length, 1);
  assert.equal(rows[0].error_id, logged[0]);
  assert.equal(rows[2].error_id, logged[0]);
  assert.equal(rows[1].status, 'NO_POST');
  assert.equal(rows[0].skipped, false);
  assert.equal(rows[0].error_code, 'IG_RATE_LIMIT');
  assert.notEqual(rows[0].error_title, '未采集（该平台已暂停）');
  assert.equal(rows[2].status, 'FAILED');
  assert.equal(rows[2].skipped, true);
  assert.equal(rows[2].error_code, rows[0].error_code);
  assert.equal(rows[2].error_title, '未采集（该平台已暂停）');
  assert.match(rows[2].error_action, /本账号未发送采集请求/);
  assert.ok(rows[2].error_action.endsWith(rows[0].error_action));
  assert.match(rows[2].error, /本轮已停止/);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_ACCOUNT_OR_POST_SENTINEL/);
  assert.doesNotMatch(diagnostics.text(), /PRIVATE_ACCOUNT_OR_POST_SENTINEL/);
});

test('authentication and tab stops identify later accounts as unrequested', async () => {
  for (const code of ['AUTH', 'TAB']) {
    const called = [];
    const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram')], OPTIONS, {
      instagram: async source => {
        called.push(source.row_no);
        throw Object.assign(new Error('Platform stopped'), {code});
      },
    }, {onError: () => 'original-failure'});
    assert.deepEqual(called, [2]);
    assert.equal(rows[0].skipped, false);
    assert.equal(rows[1].skipped, true);
    assert.equal(rows[1].error_code, rows[0].error_code);
    assert.equal(rows[1].error_id, 'original-failure');
    assert.equal(rows[1].error_title, '未采集（该平台已暂停）');
  }
});

test('user cancellation stays distinct from a prior platform stop for pending accounts', async () => {
  const controller = new AbortController();
  const called = [];
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram')], OPTIONS, {
    instagram: async source => {
      called.push(source.row_no);
      throw Object.assign(new Error('Limited'), {code: 'RATE_LIMIT'});
    },
  }, {signal: controller.signal, onAccount: async event => {
    if (event.index === 1) controller.abort();
  }});
  assert.deepEqual(called, [2]);
  assert.equal(rows[0].error_code, 'IG_RATE_LIMIT');
  assert.equal(rows[1].status, 'FAILED');
  assert.equal(rows[1].skipped, false);
  assert.equal(rows[1].error_code, 'CANCELLED');
  assert.equal(rows[1].error_title, '采集已停止');
  assert.doesNotMatch(rows[1].error_action, /平台停止|未发送采集请求/);
});

test('a failed diagnostic writer cannot abort the account loop or replace its collection error', async () => {
  const called = [];
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram')], OPTIONS, {
    instagram: async source => {
      called.push(source.row_no);
      if (source.row_no === 2) throw new Error('collection failure');
      return [{row_no: source.row_no, platform: source.platform, status: 'NO_POST'}];
    },
  }, {onError() { throw new Error('diagnostic writer failure'); }});
  assert.deepEqual(called, [2, 3]);
  assert.deepEqual(rows.map(row => row.status), ['FAILED', 'NO_POST']);
  assert.doesNotMatch(rows[0].error, /diagnostic writer failure/);
});

test('a failing diagnostic writer still halts rate-limited platforms and permits other platforms', async () => {
  const called = [];
  let logAttempts = 0;
  const rows = await runAccounts([account(2, 'instagram'), account(3, 'instagram'), account(4, 'youtube')], OPTIONS, {
    instagram: async source => {
      called.push(source.row_no);
      throw Object.assign(new Error(PRIVATE_SENTINEL), {code: 'RATE_LIMIT'});
    },
    youtube: async source => {
      called.push(source.row_no);
      return [{row_no: source.row_no, platform: source.platform, status: 'NO_POST'}];
    },
  }, {onError() { logAttempts++; throw new Error('diagnostic writer failure'); }});
  assert.deepEqual(called, [2, 4]);
  assert.equal(logAttempts, 1);
  assert.deepEqual(rows.map(row => row.status), ['FAILED', 'FAILED', 'NO_POST']);
  assert.equal(rows[0].error_code, 'IG_RATE_LIMIT');
  assert.equal(rows[1].error_code, 'IG_RATE_LIMIT');
  assert.equal(rows[0].error_id, '');
  assert.equal(rows[1].error_id, '');
  assert.match(rows[1].error, /本轮已停止/);
  assert.doesNotMatch(JSON.stringify(rows), /diagnostic writer failure|PRIVATE_ACCOUNT_OR_POST_SENTINEL/);
});
