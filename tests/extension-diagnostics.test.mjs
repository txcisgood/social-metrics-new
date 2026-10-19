import assert from 'node:assert/strict';
import test from 'node:test';
import {createDiagnostics} from '../edge-extension/lib/diagnostics.mjs';
const OMITTED_ERROR = '原始错误文本已省略，请结合错误代码与堆栈排查';

test('each run and each entry have distinct IDs and a versioned detached snapshot', () => {
  const a = createDiagnostics({version: '0.2.0', browser: 'Edge/130', platform: 'macOS'});
  const b = createDiagnostics();
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^SM-\d{14}-[a-f0-9]{12}$/);
  const first = a.record('info', 'run.started', {accountCount: 2});
  const second = a.record('error', 'account.failed', {row_no: 2, status: 429});
  assert.notEqual(first, second);
  assert.ok(first.startsWith(a.id));
  const snapshot = a.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.environment, {version: '0.2.0', browser: 'Edge/130', platform: 'macOS'});
  snapshot.entries[0].details.accountCount = 999;
  snapshot.environment.browser = 'changed';
  assert.equal(a.snapshot().entries[0].details.accountCount, 2);
  assert.equal(a.snapshot().environment.browser, 'Edge/130');
});

test('nested credential, payload, account, post and filename fields never enter snapshots', () => {
  const diagnostics = createDiagnostics();
  const details = {
    row_no: 5, platform: 'instagram', stage: 'profile',
    account_name: 'Private Person', profile_url: 'https://instagram.com/private/', post_title: 'private caption',
    inputName: 'private-list.xlsx', filename: 'private.csv', url: 'https://example.com/private',
    headers: {Cookie: 'do-not-log'}, request: {body: 'private request'}, response: {body: 'private response'},
    password: 'root-secret', access_token: 'access-secret', api_key: 'api-secret',
    options: {days: 7, timeZone: 'Europe/London', apiKey: 'nested-api', token: 'nested-token'},
    error: {name: 'TypeError', message: 'Readable failure', stack: 'TypeError: Readable failure',
      cause: {message: 'Nested failure', authorization: 'Bearer nested-auth', responseBody: 'private body'}},
  };
  const original = structuredClone(details);
  diagnostics.record('error', 'request.failed', details);
  diagnostics.setContext({targetDates: ['2026-10-19'], inputFormat: 'xlsx', accountCount: 3, accounts: ['Private Person'], cookies: 'context-secret'});
  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.entries[0].details, {
    row_no: 5, platform: 'instagram', stage: 'profile', options: {days: 7, timeZone: 'Europe/London'},
    error: {name: 'TypeError', message: OMITTED_ERROR, stack: '[本扩展堆栈不可用]', cause: {message: OMITTED_ERROR}},
  });
  assert.deepEqual(snapshot.context, {targetDates: ['2026-10-19'], inputFormat: 'xlsx', accountCount: 3});
  assert.deepEqual(details, original);
  assert.doesNotMatch(diagnostics.text(), /Private Person|private caption|private-list|context-secret|nested-api|nested-token|nested-auth|private body/);
});

test('Errors retain type, code and known module positions while omitting raw messages', () => {
  const diagnostics = createDiagnostics();
  const cause = new Error('Network unavailable');
  const error = new TypeError('Cannot read properties of undefined', {cause});
  error.code = 'INVALID_DATA';
  error.stack = 'TypeError: Cannot read properties of undefined\n at parse (chrome-extension://abcdefghijkl/lib/instagram.mjs:51:9)\n at file:///Users/real-user/private-project/edge-extension/app.mjs:88:3';
  const originalStack = error.stack;
  diagnostics.record('error', 'parse.failed', {error});
  const actual = diagnostics.snapshot().entries[0].details.error;
  assert.equal(actual.name, 'TypeError');
  assert.equal(actual.message, OMITTED_ERROR);
  assert.equal(actual.code, 'INVALID_DATA');
  assert.equal(actual.cause.message, OMITTED_ERROR);
  assert.match(actual.stack, /lib\/instagram\.mjs:51:9/);
  assert.match(actual.stack, /app\.mjs:88:3/);
  assert.doesNotMatch(actual.stack, /abcdefghijkl|real-user|private-project/);
  assert.equal(error.stack, originalStack);
});

test('explicit secrets are redacted raw, encoded, double encoded and after percent decoding', () => {
  const secret = 'S e+c/r?et=1&x';
  const diagnostics = createDiagnostics({secrets: [secret]});
  const fullyEncoded = [...new TextEncoder().encode(secret)].map(value => `%${value.toString(16).padStart(2, '0')}`).join('');
  diagnostics.record('error', 'secrets.test', {message: [secret, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret)),
    encodeURIComponent(secret).replace(/%20/g, '+'), fullyEncoded].join(' | ')});
  const message = diagnostics.snapshot().entries[0].details.message;
  assert.doesNotMatch(message, /S e|e\+c|r\?et|%53|%2520/i);
  assert.equal((message.match(/已脱敏/g) || []).length, 5);
});

test('free text masks Google keys, Bearer, sensitive JSON, escaped JSON, cookies and query credentials', () => {
  const diagnostics = createDiagnostics();
  const examples = [
    ['Google rejected AIzaSySAMPLE_ONLY_123456789012345678901', 'AIzaSySAMPLE'],
    ['Authorization: Bearer plainBearerCredential', 'plainBearerCredential'],
    ['Authorization: Basic basicCredential==', 'basicCredential'],
    ['Retry with Bearer encoded%20bearerCredential', 'bearerCredential'],
    ['{"api_key":"jsonApiCredential","password":"jsonPassword","sessionid":"jsonSession"}', 'jsonApiCredential|jsonPassword|jsonSession'],
    ['{"token":["firstCredential","secondCredential"],"status":429}', 'firstCredential|secondCredential'],
    ['{"headers":{"cookie":"nestedCookie","custom":"privateHeader"}}', 'nestedCookie|privateHeader'],
    ['{\\"access_token\\":\\"escapedCredential\\"}', 'escapedCredential'],
    ['Cookie: sessionid=cookieCredential; csrftoken=cookieCsrf; anything=cookieOther', 'cookieCredential|cookieCsrf|cookieOther'],
    ['sessionid=bareSession; csrftoken=bareCsrf; ds_user_id=privateId', 'bareSession|bareCsrf|privateId'],
    ['?key=queryKey&access_token=queryAccess&sessionid=querySession&password=queryPassword', 'queryKey|queryAccess|querySession|queryPassword'],
    ['%22api_key%22%3A%22encodedJsonCredential%22', 'encodedJsonCredential'],
    ['https://userInfo:passwordInfo@example.com/private?key=queryCredential HTTP 429', 'userInfo|passwordInfo|queryCredential|example.com'],
  ];
  for (const [message, forbidden] of examples) {
    diagnostics.record('error', 'redaction.test', {message});
    const actual = diagnostics.snapshot().entries.at(-1).details.message;
    assert.doesNotMatch(actual, new RegExp(forbidden), `${message} -> ${actual}`);
  }
  assert.match(diagnostics.snapshot().entries.at(-1).details.message, /HTTP 429/);
});

test('local paths, handles and full URLs are removed while endpoint labels remain useful', () => {
  const diagnostics = createDiagnostics();
  diagnostics.record('error', 'paths.test', {
    endpoint: '/api/v1/feed/user/123456789/?max_id=privateCursor',
    message: 'Cannot open /Users/alice/clients/private-list.xlsx or C:\\Users\\Alice\\secrets\\private.csv; failed @private_handle on https://instagram.com/private_handle/?data=hidden',
    details: {endpoint: 'web_profile_info', message: 'web_profile_info returned HTTP 403'},
  });
  const entry = diagnostics.snapshot().entries[0];
  assert.equal(entry.details.endpoint, 'instagram.feed');
  assert.equal(entry.details.details.endpoint, 'web_profile_info');
  assert.match(entry.details.details.message, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(entry), /123456789|privateCursor|alice|Alice|private-list|private\.csv|private_handle|hidden/);
});

test('adding a newly known secret also scrubs previous entries, context and environment', () => {
  const secret = 'a-newly-known-credential';
  const diagnostics = createDiagnostics({browser: `Edge ${secret}`});
  diagnostics.record('error', 'before.secret', {message: `unexpected ${secret}`});
  diagnostics.setContext({stage: secret});
  diagnostics.addSecret(secret);
  diagnostics.record('error', 'after.secret', {message: secret});
  assert.doesNotMatch(diagnostics.text(), /a-newly-known-credential/);
});

test('restore validates schema, re-sanitizes saved content, preserves run ID and assigns unique entry IDs', () => {
  const source = createDiagnostics();
  source.record('error', 'run.failed', {message: 'initial failure'});
  const saved = source.snapshot();
  saved.environment.cookie = 'environmentCookie';
  saved.environment.browser = 'Edge api_key=environmentKey';
  saved.context = {days: 7, access_token: 'contextToken'};
  saved.entries[0].details = {account_name: 'Restored Person', headers: {Cookie: 'savedCookie'},
    error: {name: 'Error', message: 'password=restoredPassword key=futureSecret'}, options: {apiKey: 'savedKey'}};
  saved.entries.push({...structuredClone(saved.entries[0]), id: saved.entries[0].id});
  const before = structuredClone(saved);
  const target = createDiagnostics({secrets: ['futureSecret']});
  assert.equal(target.restore(saved), true);
  assert.equal(target.id, saved.id);
  const restored = target.snapshot();
  assert.equal(new Set(restored.entries.map(entry => entry.id)).size, 2);
  const id = target.record('info', 'restored.next');
  assert.ok(!restored.entries.some(entry => entry.id === id));
  assert.doesNotMatch(target.text(), /environmentCookie|environmentKey|contextToken|Restored Person|savedCookie|restoredPassword|futureSecret|savedKey/);
  assert.deepEqual(saved, before);
  const good = target.snapshot();
  assert.equal(target.restore({...saved, schemaVersion: 999}), false);
  assert.equal(target.restore({...saved, id: 'https://evil.example/?token=bad'}), false);
  assert.equal(target.restore({...saved, entries: null}), false);
  assert.deepEqual(target.snapshot(), good);
});

test('entry and size limits retain recent errors, count discarded entries and bound readable output', () => {
  const diagnostics = createDiagnostics({maxEntries: 3, maxChars: 3500});
  diagnostics.record('error', 'important.error', {message: 'Keep useful error'});
  for (let index = 0; index < 12; index++) diagnostics.record('info', 'request.finished', {index, message: 'Detail '.repeat(40)});
  let snapshot = diagnostics.snapshot();
  assert.ok(snapshot.entries.length <= 3);
  assert.ok(snapshot.entries.some(entry => entry.event === 'important.error'));
  assert.ok(snapshot.dropped >= 10);
  assert.ok(diagnostics.text().length <= 3500);
  diagnostics.record('error', 'huge.error', {stack: 'Long stack '.repeat(10000)});
  assert.ok(diagnostics.text().length <= 3500);
  diagnostics.setContext({reason: 'Very large context '.repeat(4000)});
  assert.ok(diagnostics.text().length <= 3500);
  const smaller = createDiagnostics({maxEntries: 1, maxChars: 1200});
  assert.equal(smaller.restore(diagnostics.snapshot()), true);
  snapshot = smaller.snapshot();
  assert.ok(snapshot.entries.length <= 1);
  assert.ok(smaller.text().length <= 1200);
});

test('cycles and getters do not break recording and input objects stay untouched', () => {
  const diagnostics = createDiagnostics();
  const details = {stage: 'parse', error: {name: 'Error', message: 'Failure'}};
  details.error.cause = details.error;
  Object.defineProperty(details, 'password', {enumerable: true, get() { throw new Error('must not read credentials'); }});
  Object.defineProperty(details, 'message', {enumerable: true, get() { throw new Error('must not execute getters'); }});
  assert.doesNotThrow(() => diagnostics.record('error', 'cyclic.error', details));
  const actual = diagnostics.snapshot().entries[0].details;
  assert.equal(actual.error.cause, '[循环引用已省略]');
  assert.equal(actual.message, undefined);
  assert.equal(details.error.cause, details.error);
});

test('unknown metadata and account-shaped values under permissive count fields are not serialized', () => {
  const diagnostics = createDiagnostics();
  diagnostics.record('info', 'metadata.test', {name: 'Private Person', custom: 'private metadata',
    posts: [{title: 'secret post'}], count: {message: 'not a count'}, endpoint: 'https://example.com/private?password=secret'});
  assert.deepEqual(diagnostics.snapshot().entries[0].details, {endpoint: '[endpoint 已省略]'});
  assert.match(diagnostics.text(), /诊断日志/);
  assert.match(diagnostics.text(), /复制给他人前请检查错误详情/);
});

test('unknown error text, function names and stack headers cannot reveal names or captions', () => {
  const diagnostics = createDiagnostics();
  const error = new Error('Alice Example posted Confidential caption without a field label');
  error.stack = 'Error: Alice Example posted Confidential caption\n'
    + ' at privateDynamicFunction_Alice (chrome-extension://extension-id/lib/instagram.mjs:12:4)\n'
    + ' at captionFromPrivatePost (chrome-extension://extension-id/private-custom-file.mjs:9:1)\n'
    + ' at failedCall (file:///Users/alice/private/app.mjs:55:3)\n'
    + ' at maliciousName (chrome-extension://extension-id/bootstrap.js:9:1)';
  diagnostics.record('error', 'unhandled.error', {error, code: 'UNKNOWN_ERROR', status: 500});
  const details = diagnostics.snapshot().entries[0].details;
  assert.equal(details.error.message, OMITTED_ERROR);
  assert.equal(details.error.stack, 'at lib/instagram.mjs:12:4\nat app.mjs:55:3\nat bootstrap.js:9:1');
  assert.equal(details.code, 'UNKNOWN_ERROR');
  assert.equal(details.status, 500);
  assert.doesNotMatch(diagnostics.text(), /Alice|Confidential caption|privateDynamic|captionFrom|private-custom|extension-id|maliciousName/);
  const saved = diagnostics.snapshot();
  saved.entries[0].details.error.message = 'Restored private person and caption';
  saved.entries[0].details.error.stack = error.stack;
  const restored = createDiagnostics();
  assert.equal(restored.restore(saved), true);
  assert.doesNotMatch(restored.text(), /Restored private|Alice|Confidential caption|privateDynamic/);
  assert.equal(restored.snapshot().entries[0].details.error.stack, details.error.stack);
});

test('DOMException keeps its native name and warning normalizes to warn', () => {
  const diagnostics = createDiagnostics();
  diagnostics.record('warning', 'clipboard.failed', {error: new DOMException('private clipboard value', 'NotAllowedError')});
  const entry = diagnostics.snapshot().entries[0];
  assert.equal(entry.level, 'warn');
  assert.equal(entry.details.error.name, 'NotAllowedError');
  assert.equal(entry.details.error.message, OMITTED_ERROR);
  assert.doesNotMatch(diagnostics.text(), /private clipboard value/);
});

test('two writers restoring the same run generate different entry IDs and old IDs remain supported', () => {
  const source = createDiagnostics();
  source.record('info', 'run.started');
  const saved = source.snapshot();
  saved.entries[0].id = `${saved.id}-E000001`; // Before writer suffixes were added.
  const left = createDiagnostics();
  const right = createDiagnostics();
  assert.equal(left.restore(saved), true);
  assert.equal(right.restore(saved), true);
  const a = left.record('info', 'left.finished');
  const b = right.record('info', 'right.finished');
  assert.notEqual(a, b);
  assert.equal(left.id, right.id);
  assert.equal(left.snapshot().entries[0].id, saved.entries[0].id);
  const combined = left.snapshot();
  combined.entries.push(right.snapshot().entries.at(-1));
  const merged = createDiagnostics();
  assert.equal(merged.restore(combined), true);
  assert.deepEqual(merged.snapshot().entries.map(entry => entry.id), [saved.entries[0].id, a, b]);
});

test('restoring hostile context types, bad entries and accessor fields remains bounded and safe', () => {
  const diagnostics = createDiagnostics({maxEntries: 2, maxChars: 1800});
  const saved = diagnostics.snapshot();
  saved.context = 'x'.repeat(10000);
  saved.entries = [null, {at: 'invalid date', level: 'error'}, {at: saved.createdAt, level: 'warning', event: 'restored.warning', details: {error: {message: 'private value'}}}];
  Object.defineProperty(saved.entries, '3', {get() { throw new Error('must not run saved entry getter'); }});
  assert.doesNotThrow(() => diagnostics.restore(saved));
  assert.deepEqual(diagnostics.snapshot().context, {});
  assert.equal(diagnostics.snapshot().dropped, 3);
  assert.equal(diagnostics.snapshot().entries[0].level, 'warn');
  assert.ok(diagnostics.text().length <= 1800);
  assert.doesNotMatch(diagnostics.text(), /private value/);
});
