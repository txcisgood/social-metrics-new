import assert from 'node:assert/strict';
import test from 'node:test';
import {createPreferencesStore, PREFERENCES_KEY, sanitizeSettings} from '../extension/lib/preferences.mjs';
import {createDiagnostics} from '../extension/lib/diagnostics.mjs';

function environment(initial = {}) {
  const records = structuredClone(initial), access = [], calls = [], failures = {};
  const storage = {
    async setAccessLevel(options) { access.push(options); if (failures.protection) throw failures.protection; },
    async get(key) { if (failures.get) throw failures.get; return structuredClone({[key]: records[key]}); },
    async set(values) {
      calls.push(structuredClone(values));
      if (failures.set) throw failures.set;
      await Promise.resolve(); Object.assign(records, structuredClone(values));
    },
  };
  let queue = Promise.resolve();
  const locks = {request(name, action) {
    assert.equal(name, 'social-metrics-preferences');
    const operation = queue.then(action); queue = operation.catch(() => {}); return operation;
  }};
  return {records, access, calls, failures, store: () => createPreferencesStore({storage, locks}),
    saved: () => structuredClone(records[PREFERENCES_KEY])};
}

test('configuration and opted-in key survive a new store/browser session; unrelated data survives', async () => {
  const env = environment({'metrics.diagnostics.some-run': {keep: true}, lastRun: {keep: true}});
  const settings = {platformSelect: 'youtube', dateMode: 'quarter', quarter: 2, quarterYear: 2025,
    timeZone: 'Asia/Shanghai', maxPages: 12, maxPosts: 80, minDelay: 5, maxDelay: 8, scanMode: 'complete'};
  await env.store().update({settings, youtubeKey: '  FAKE_KEY_FOR_TESTS  '});
  const recovered = await env.store().load();
  assert.deepEqual(recovered, {schemaVersion: 1, settings, rememberYoutubeKey: true, youtubeKey: 'FAKE_KEY_FOR_TESTS'});
  assert.deepEqual(env.records['metrics.diagnostics.some-run'], {keep: true});
  assert.deepEqual(env.records.lastRun, {keep: true});
  assert.ok(env.access.every(value => value.accessLevel === 'TRUSTED_CONTEXTS'));
});

test('storage allowlist drops tab IDs, account data, diagnostics and secret-bearing settings', async () => {
  const env = environment();
  await env.store().update({settings: {platformSelect: 'all', apiKey: 'NEVER_COPY', youtubeKey: 'NEVER_COPY',
    tabId: 42, file: {name: 'private.xlsx'}, accounts: ['private-account'], results: ['private-result'], diagnostics: ['private-log']},
    cookie: 'NEVER_COPY', results: ['private-result']});
  assert.deepEqual(env.saved(), {schemaVersion: 1, settings: {platformSelect: 'all'}, rememberYoutubeKey: true});
  assert.ok(!JSON.stringify(env.records).includes('NEVER_COPY'));
});

test('appearance is persisted independently and legacy or corrupted settings remain compatible', async () => {
  const env = environment({[PREFERENCES_KEY]: {schemaVersion: 1,
    settings: {platformSelect: 'youtube', days: 14}, rememberYoutubeKey: true, youtubeKey: 'EXISTING_TEST_KEY'}});
  assert.deepEqual((await env.store().load()).settings, {platformSelect: 'youtube', days: 14});
  await env.store().update({settings: {themeMode: 'system', interfaceStyle: 'classic'}});
  const restored = await env.store().load();
  assert.deepEqual(restored.settings, {platformSelect: 'youtube', days: 14, themeMode: 'system', interfaceStyle: 'classic'});
  assert.equal(restored.youtubeKey, 'EXISTING_TEST_KEY');
  await env.store().update({settings: {themeMode: 'light'}});
  assert.equal((await env.store().load()).settings.interfaceStyle, 'classic');
  assert.deepEqual(sanitizeSettings({themeMode: 'auto', interfaceStyle: '<script>', days: 7}), {days: 7});
});

test('load rejects incompatible records and invalid fields rather than trusting corrupted configuration', async () => {
  for (const malformed of [null, [], 'broken', {schemaVersion: 9, youtubeKey: 'UNKNOWN_SCHEMA_KEY'}]) {
    const env = environment({[PREFERENCES_KEY]: malformed});
    assert.equal(await env.store().load(), null);
  }
  const env = environment({[PREFERENCES_KEY]: {schemaVersion: 1, rememberYoutubeKey: 'true', youtubeKey: 'NOT_OPTED_IN',
    settings: {platformSelect: 'facebook', dateMode: 'quarter', quarter: 8, quarterYear: 2026.1,
      days: '7', maxPages: -1, maxPosts: 501, minDelay: 10, maxDelay: 3,
      timeZone: 'bad-zone', targetDate: '2026-02-30', targetMonth: '2026-13',
      startDate: '2026-12-31', endDate: '2026-01-01'}}});
  assert.deepEqual(await env.store().load(), {schemaVersion: 1, settings: {dateMode: 'quarter'}, rememberYoutubeKey: false});
  assert.deepEqual(sanitizeSettings({targetDate: '2024-02-29', targetMonth: '0001-01', quarterYear: 1, minDelay: 3.5}),
    {quarterYear: 1, minDelay: 3.5, targetDate: '2024-02-29', targetMonth: '0001-01'});
  assert.deepEqual(sanitizeSettings({targetDate: '0000-01-01', startDate: '2020-01-01', endDate: '2026-01-01'}), {});
});

test('disabling key storage deletes the key but preserves configuration; typing cannot silently opt back in', async () => {
  const env = environment(), store = env.store();
  await store.update({settings: {platformSelect: 'youtube'}, youtubeKey: 'OLD_KEY'});
  await store.update({rememberYoutubeKey: false});
  assert.equal(Object.hasOwn(env.saved(), 'youtubeKey'), false);
  await store.update({youtubeKey: 'SESSION_ONLY_KEY'});
  assert.equal(Object.hasOwn(env.saved(), 'youtubeKey'), false);
  assert.equal(env.saved().settings.platformSelect, 'youtube');
  await store.update({rememberYoutubeKey: true, youtubeKey: 'NEW_KEY'});
  assert.equal((await env.store().load()).youtubeKey, 'NEW_KEY');
});

test('immediate queued edits followed by clear cannot resurrect a saved key', async () => {
  const env = environment(), store = env.store();
  await Promise.all([
    store.update({youtubeKey: 'F'}), store.update({youtubeKey: 'FA'}), store.update({youtubeKey: 'FAKE_KEY'}),
    store.update({rememberYoutubeKey: false, youtubeKey: ''}), store.update({settings: {days: 30}}),
  ]);
  await store.flush();
  assert.deepEqual(env.saved(), {schemaVersion: 1, settings: {days: 30}, rememberYoutubeKey: false});
});

test('worktabs merge independent patches and stale unrelated edits cannot resurrect a cleared key', async () => {
  const env = environment(), first = env.store(), second = env.store();
  await first.update({youtubeKey: 'KEY_TO_CLEAR', settings: {days: 7}});
  await second.load();
  await Promise.all([first.update({settings: {platformSelect: 'youtube'}}), second.update({settings: {days: 30}})]);
  assert.deepEqual(env.saved().settings, {platformSelect: 'youtube', days: 30});
  await first.update({rememberYoutubeKey: false, youtubeKey: ''});
  await second.update({settings: {scanMode: 'complete'}});
  await second.update({youtubeKey: 'STALE_TYPED_KEY'});
  assert.equal(env.saved().rememberYoutubeKey, false);
  assert.equal(Object.hasOwn(env.saved(), 'youtubeKey'), false);
});

test('queued patches are detached from caller mutation and storage errors do not poison later saves', async () => {
  const env = environment(), store = env.store();
  const patch = {settings: {days: 14}, youtubeKey: 'ORIGINAL_KEY'};
  const pending = store.update(patch);
  patch.settings.days = 20; patch.youtubeKey = 'CHANGED_KEY';
  await pending;
  assert.equal(env.saved().settings.days, 14);
  assert.equal(env.saved().youtubeKey, 'ORIGINAL_KEY');
  env.failures.set = new Error('write unavailable');
  await assert.rejects(store.update({rememberYoutubeKey: false}), /write unavailable/);
  assert.equal(env.saved().youtubeKey, 'ORIGINAL_KEY', 'failure must not claim the key was cleared');
  delete env.failures.set;
  await store.update({rememberYoutubeKey: false});
  assert.equal(Object.hasOwn(env.saved(), 'youtubeKey'), false);
  env.failures.get = new Error('read unavailable');
  await assert.rejects(store.load(), /read unavailable/);
});

test('trusted-context restriction errors are retryable and reject before reading or writing a key', async () => {
  const env = environment(), store = env.store();
  env.failures.protection = new Error('restriction unavailable');
  await assert.rejects(store.update({youtubeKey: 'KEY'}), /restriction unavailable/);
  assert.equal(env.calls.length, 0);
  delete env.failures.protection;
  await store.update({youtubeKey: 'KEY'});
  assert.equal(env.saved().youtubeKey, 'KEY');
  await assert.rejects(createPreferencesStore({storage: null}).load(), /PREFERENCES_STORAGE_UNAVAILABLE/);
});

test('a restored saved key can sanitize old diagnostic entries before they are exposed again', async () => {
  const env = environment();
  await env.store().update({youtubeKey: 'PERSISTED_PRIVATE_TEST_KEY'});
  const restored = await env.store().load();
  const previous = createDiagnostics();
  previous.record('error', 'request.PERSISTED_PRIVATE_TEST_KEY', {stage: 'collect'});
  const current = createDiagnostics();
  current.addSecret(restored.youtubeKey);
  assert.equal(current.restore(previous.snapshot()), true);
  assert.ok(!current.text().includes(restored.youtubeKey));
});
