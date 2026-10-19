import assert from 'node:assert/strict';
import test from 'node:test';
import {createDiagnostics} from '../edge-extension/lib/diagnostics.mjs';
import {persistDiagnostics, latestDiagnostics, clearStoredDiagnostics} from '../edge-extension/lib/diagnostic-store.mjs';

const PREFIX = 'metrics.diagnostics.';

function environment(t, initial = {}) {
  const descriptors = Object.fromEntries(['chrome', 'navigator', 'Date'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const NativeDate = Date;
  let now = NativeDate.parse('2026-10-19T09:00:00.000Z');
  const records = structuredClone(initial);
  const failures = {};
  const lockNames = [];
  const queues = new Map();
  const storage = {
    async get(keys) {
      if (failures.get) throw failures.get;
      if (keys == null) return structuredClone(records);
      const requested = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(requested.filter(key => Object.hasOwn(records, key)).map(key => [key, records[key]])));
    },
    async set(values) {
      if (failures.set) throw failures.set;
      Object.assign(records, structuredClone(values));
    },
    async remove(keys) {
      if (failures.remove) throw failures.remove;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key];
    },
  };
  const locks = {
    request(name, callback) {
      lockNames.push(name);
      const previous = queues.get(name) || Promise.resolve();
      const operation = previous.then(() => callback({name}));
      queues.set(name, operation.catch(() => {}));
      return operation;
    },
  };
  class Clock extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  Object.defineProperty(globalThis, 'chrome', {value: {storage: {local: storage}}, configurable: true});
  Object.defineProperty(globalThis, 'navigator', {value: {locks}, configurable: true});
  Object.defineProperty(globalThis, 'Date', {value: Clock, configurable: true});
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {records, failures, lockNames, advance(ms = 1000) { now += ms; },
    saved() { return Object.entries(records).filter(([key]) => key.startsWith(PREFIX)).map(([, value]) => structuredClone(value)); }};
}

test('concurrent worktabs append to the same restored run without overwriting either writer', async t => {
  const env = environment(t);
  const original = createDiagnostics({version: '0.2.0'});
  original.record('info', 'run.started', {accountCount: 2});
  const writerA = createDiagnostics(), writerB = createDiagnostics();
  assert.equal(writerA.restore(original.snapshot()), true);
  assert.equal(writerB.restore(original.snapshot()), true);
  const a = writerA.record('info', 'writer.a', {row_no: 2, status: 200});
  const b = writerB.record('error', 'writer.b', {row_no: 3, status: 429});
  assert.notEqual(a, b, 'restored writers must allocate distinct IDs for new entries');
  await Promise.all([persistDiagnostics(writerA.snapshot()), persistDiagnostics(writerB.snapshot())]);
  const saved = await latestDiagnostics();
  assert.equal(saved.id, original.id);
  assert.equal(saved.entries.length, 3);
  assert.deepEqual(new Set(saved.entries.map(entry => entry.event)), new Set(['run.started', 'writer.a', 'writer.b']));
  assert.ok(env.lockNames.every(name => name === 'social-metrics-log-storage'));
});

test('repeated snapshots deduplicate shared entry IDs and remain detached from caller changes', async t => {
  environment(t);
  const diagnostic = createDiagnostics();
  diagnostic.record('info', 'request.started', {requestId: 1});
  diagnostic.record('info', 'request.completed', {requestId: 1, status: 200});
  const snapshot = diagnostic.snapshot();
  await persistDiagnostics(snapshot);
  await persistDiagnostics(snapshot);
  await persistDiagnostics(structuredClone(snapshot));
  snapshot.entries[0].details.requestId = 999;
  const saved = await latestDiagnostics();
  assert.equal(saved.entries.length, 2);
  assert.equal(new Set(saved.entries.map(entry => entry.id)).size, 2);
  assert.equal(saved.entries[0].details.requestId, 1);
});

test('merged stored runs enforce the default 500 entry bound', async t => {
  environment(t);
  const diagnostic = createDiagnostics({maxEntries: 1000, maxChars: 1000000});
  for (let i = 0; i < 700; i++) diagnostic.record('info', 'request.completed', {requestId: i, status: 200});
  assert.equal(diagnostic.snapshot().entries.length, 700);
  await persistDiagnostics(diagnostic.snapshot());
  const saved = await latestDiagnostics();
  assert.equal(saved.entries.length, 500);
  assert.ok(saved.dropped >= 200);
  assert.ok(JSON.stringify(saved, null, 2).length <= 200000);
});

test('large entries are bounded to 200000 readable characters when persisted', async t => {
  environment(t);
  const diagnostic = createDiagnostics({maxEntries: 1000, maxChars: 1000000});
  const stack = 'TypeError: omitted\n' + Array.from({length: 80}, (_, i) =>
    `    at handler (chrome-extension://test-extension/lib/transport.mjs:${100 + i}:5)`).join('\n');
  for (let i = 0; i < 400; i++) diagnostic.record('error', 'request.failed', {
    requestId: i, row_no: i + 1, status: 500, endpoint: 'web_profile_info', platform: 'instagram',
    durationMs: 1000, count: 400, pages: 5, minDelay: 8, maxDelay: 12,
    error: {name: 'TypeError', code: 'INVALID_DATA', stack},
  });
  const before = diagnostic.snapshot();
  assert.ok(JSON.stringify(before, null, 2).length > 200000, 'fixture must exceed the persisted text budget');
  await persistDiagnostics(before);
  const saved = await latestDiagnostics();
  assert.ok(saved.entries.length < before.entries.length);
  assert.ok(saved.entries.length <= 500);
  assert.ok(JSON.stringify(saved, null, 2).length <= 200000);
  const restored = createDiagnostics();
  assert.equal(restored.restore(saved), true);
  assert.ok(restored.text().length <= 200000);
});

test('storage keeps the latest three runs and leaves unrelated extension data intact', async t => {
  const env = environment(t, {'unrelated.setting': {enabled: true}});
  const ids = [];
  for (let i = 0; i < 5; i++) {
    env.advance();
    const diagnostic = createDiagnostics();
    diagnostic.record('info', 'run.started', {accountCount: i + 1});
    ids.push(diagnostic.id);
    await persistDiagnostics(diagnostic.snapshot());
  }
  assert.deepEqual(new Set(env.saved().map(run => run.id)), new Set(ids.slice(-3)));
  assert.equal((await latestDiagnostics()).id, ids.at(-1));
  assert.deepEqual(env.records['unrelated.setting'], {enabled: true});
});

test('clearing logs prevents an old idle worktab from resurrecting them but permits a new run', async t => {
  const env = environment(t, {'unrelated.setting': 'keep', 'metrics.bootError': {code: 'STARTUP_FAILED'}});
  const stale = createDiagnostics();
  stale.record('error', 'request.failed', {status: 429});
  await persistDiagnostics(stale.snapshot());
  env.advance();
  await clearStoredDiagnostics();
  assert.equal(await latestDiagnostics(), null);
  assert.equal(env.records['metrics.bootError'], undefined);
  assert.equal(env.records['unrelated.setting'], 'keep');
  env.advance();
  stale.record('info', 'workspace.opened', {stage: 'startup'});
  await persistDiagnostics(stale.snapshot());
  assert.equal(await latestDiagnostics(), null, 'new events must not resurrect a cleared old run');
  const fresh = createDiagnostics();
  fresh.record('info', 'run.started', {accountCount: 1});
  await persistDiagnostics(fresh.snapshot());
  assert.equal((await latestDiagnostics()).id, fresh.id);
  assert.equal(env.saved().length, 1);
});

test('same-millisecond clears reject cleared run IDs while allowing genuinely new run IDs', async t => {
  environment(t);
  const stale = createDiagnostics();
  stale.record('info', 'run.started', {accountCount: 1});
  await persistDiagnostics(stale.snapshot());
  await clearStoredDiagnostics();
  stale.record('error', 'request.failed', {status: 500});
  await persistDiagnostics(stale.snapshot());
  assert.equal(await latestDiagnostics(), null, 'cleared run must not revive when timestamps are equal');
  const fresh = createDiagnostics();
  fresh.record('info', 'workspace.opened', {stage: 'startup'});
  assert.equal(fresh.snapshot().createdAt, stale.snapshot().createdAt);
  await persistDiagnostics(fresh.snapshot());
  assert.equal((await latestDiagnostics()).id, fresh.id, 'new run created in the same millisecond is permitted');
  await clearStoredDiagnostics();
  await persistDiagnostics(stale.snapshot());
  await persistDiagnostics(fresh.snapshot());
  assert.equal(await latestDiagnostics(), null, 'another clear must retain already-cleared boundary IDs');
});

test('legacy string tombstones still block old and boundary-time logs', async t => {
  const env = environment(t, {'metrics.diagnosticsClearedAt': '2026-10-19T09:00:00.000Z'});
  const boundary = createDiagnostics();
  boundary.record('info', 'workspace.opened', {stage: 'startup'});
  await persistDiagnostics(boundary.snapshot());
  assert.equal(await latestDiagnostics(), null);
  env.advance(1);
  const fresh = createDiagnostics();
  fresh.record('info', 'workspace.opened', {stage: 'startup'});
  await persistDiagnostics(fresh.snapshot());
  assert.equal((await latestDiagnostics()).id, fresh.id);
});

test('a malformed prior entries value does not prevent saving a valid replacement', async t => {
  const env = environment(t);
  const diagnostic = createDiagnostics();
  diagnostic.record('info', 'request.completed', {status: 200});
  env.records[PREFIX + diagnostic.id] = {...diagnostic.snapshot(), entries: {broken: true}, savedAt: new Date().toISOString()};
  await persistDiagnostics(diagnostic.snapshot());
  const saved = await latestDiagnostics();
  assert.equal(saved.id, diagnostic.id);
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].details.status, 200);
});

test('latest diagnostics skips corrupt snapshots and restores the newest usable run', async t => {
  const env = environment(t);
  const valid = createDiagnostics();
  valid.record('error', 'request.failed', {status: 429});
  await persistDiagnostics(valid.snapshot());
  env.advance();
  const corrupt = createDiagnostics();
  corrupt.record('info', 'workspace.opened', {stage: 'startup'});
  env.records[PREFIX + corrupt.id] = {...corrupt.snapshot(), entries: {broken: true}, savedAt: new Date().toISOString()};
  env.records[PREFIX + 'invalid-null'] = null;
  assert.equal((await latestDiagnostics()).id, valid.id);
  env.records[PREFIX + corrupt.id].entries = [null, 'bad entry'];
  assert.equal((await latestDiagnostics()).id, valid.id, 'a snapshot containing no valid entries is unusable');
  const fresh = createDiagnostics();
  fresh.record('info', 'run.started', {accountCount: 1});
  await persistDiagnostics(fresh.snapshot());
  assert.equal((await latestDiagnostics()).id, fresh.id, 'corrupt neighbours must not break a later save');
});

test('looking up a run ID never returns a newer unrelated run', async t => {
  const env = environment(t);
  const first = createDiagnostics();
  first.record('error', 'request.failed', {platform: 'instagram', status: 429});
  await persistDiagnostics(first.snapshot());
  env.advance();
  const second = createDiagnostics();
  second.record('info', 'workspace.opened', {stage: 'startup'});
  await persistDiagnostics(second.snapshot());
  assert.equal((await latestDiagnostics()).id, second.id);
  assert.equal((await latestDiagnostics(first.id)).id, first.id);
  assert.equal((await latestDiagnostics(first.id)).entries[0].details.status, 429);
  assert.equal(await latestDiagnostics(createDiagnostics().id), null);
  assert.equal(await latestDiagnostics('not-a-run-id'), null);
  env.records[PREFIX + first.id].entries = {corrupt: true};
  assert.equal(await latestDiagnostics(first.id), null, 'corrupt requested run must not fall back to another run');
  assert.equal((await latestDiagnostics()).id, second.id);
});

test('cleared ID history remains bounded and overflow cannot revive an omitted boundary run', async t => {
  const env = environment(t);
  let oldest;
  for (let i = 0; i < 270; i++) {
    const diagnostic = createDiagnostics();
    diagnostic.record('info', 'workspace.opened', {stage: 'startup'});
    oldest ||= diagnostic;
    // Seed already-existing history to exercise one atomic clear at a fixed time.
    env.records[PREFIX + diagnostic.id] = {...diagnostic.snapshot(), savedAt: new Date().toISOString()};
  }
  await clearStoredDiagnostics();
  const boundary = env.records['metrics.diagnosticsClearedAt'];
  assert.equal(boundary.runIds.length, 256);
  assert.equal(boundary.inclusive, true);
  assert.ok(!boundary.runIds.includes(oldest.id));
  await persistDiagnostics(oldest.snapshot());
  assert.equal(await latestDiagnostics(), null);
  env.advance(1);
  const fresh = createDiagnostics();
  fresh.record('info', 'workspace.opened', {stage: 'startup'});
  await persistDiagnostics(fresh.snapshot());
  assert.equal((await latestDiagnostics()).id, fresh.id);
});

test('read and write storage failures reject so the app can switch to its in-memory fallback', async t => {
  const env = environment(t);
  const diagnostic = createDiagnostics();
  diagnostic.record('info', 'run.started', {accountCount: 1});
  const readFailure = new Error('mock read failure');
  env.failures.get = readFailure;
  await assert.rejects(persistDiagnostics(diagnostic.snapshot()), error => error === readFailure);
  await assert.rejects(latestDiagnostics(), error => error === readFailure);
  delete env.failures.get;
  const writeFailure = new Error('mock write failure');
  env.failures.set = writeFailure;
  await assert.rejects(persistDiagnostics(diagnostic.snapshot()), error => error === writeFailure);
  delete env.failures.set;
  await persistDiagnostics(diagnostic.snapshot());
  assert.equal((await latestDiagnostics()).id, diagnostic.id, 'a failed queued write must not poison the storage lock');
});

test('pruning and clear failures reject instead of claiming history was removed', async t => {
  const env = environment(t);
  for (let i = 0; i < 3; i++) {
    env.advance();
    const diagnostic = createDiagnostics();
    diagnostic.record('info', 'run.started', {count: i});
    await persistDiagnostics(diagnostic.snapshot());
  }
  env.advance();
  const fourth = createDiagnostics();
  fourth.record('info', 'run.started', {count: 4});
  const removeFailure = new Error('mock removal failure');
  env.failures.remove = removeFailure;
  await assert.rejects(persistDiagnostics(fourth.snapshot()), error => error === removeFailure);
  await assert.rejects(clearStoredDiagnostics(), error => error === removeFailure);
  delete env.failures.remove;
  await clearStoredDiagnostics();
  assert.equal(await latestDiagnostics(), null);
});
