import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFor, migrateYouTubeResults} from '../extension/lib/workspace.mjs';
import {createPreferencesStore, PREFERENCES_KEY, sanitizeSettings} from '../extension/lib/preferences.mjs';
import {createDiagnosticStore} from '../extension/lib/diagnostic-store.mjs';
import {createDiagnostics} from '../extension/lib/diagnostics.mjs';

function memory(initial = {}) {
  const records = structuredClone(initial), removed = [];
  return {records, removed, storage: {
    async get(keys) {
      if (keys === null) return structuredClone(records);
      return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])));
    },
    async set(value) { Object.assign(records, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { removed.push(key); delete records[key]; } },
    async setAccessLevel() {},
  }};
}
function serialLocks() {
  let queue = Promise.resolve();
  return {request(_name, callback) { const next = queue.then(callback); queue = next.catch(() => {}); return next; }};
}

test('account and YouTube pages have different result stores; unknown pages default to accounts', () => {
  assert.equal(workspaceFor('accounts').resultKey, 'lastRun');
  assert.equal(workspaceFor('youtube').resultKey, 'youtubeLastRun');
  assert.equal(workspaceFor('youtube').youtube, true);
  assert.equal(workspaceFor('unknown').youtube, false);
});

test('migration leaves existing account results untouched and moves only interim video runs', async () => {
  const account = {results: [{status: 'OK'}], meta: {inputName: 'account.xlsx'}};
  const old = memory({lastRun: account}); await migrateYouTubeResults(old.storage);
  assert.deepEqual(old.records, {lastRun: account});
  const video = {results: [{post_title: 'video'}], meta: {'采集模式': '视频 URL（含评论）'}};
  const combined = memory({lastRun: video}); await migrateYouTubeResults(combined.storage);
  assert.deepEqual(combined.records, {youtubeLastRun: video});
  await migrateYouTubeResults(combined.storage);
  assert.deepEqual(combined.removed, ['lastRun']);
});

test('migration cannot overwrite newer video results or remove source data on a write failure', async () => {
  const old = {meta: {'采集模式': '关键词搜索'}}, newer = {results: ['new']};
  const store = memory({lastRun: old, youtubeLastRun: newer});
  await migrateYouTubeResults(store.storage);
  assert.deepEqual(store.records, {lastRun: old, youtubeLastRun: newer});
  const failed = memory({lastRun: old}); failed.storage.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(migrateYouTubeResults(failed.storage), /storage failed/);
  assert.deepEqual(failed.records.lastRun, old); assert.deepEqual(failed.removed, []);
});

test('modules persist independent dates and modes while sharing the saved key', async () => {
  const {storage, records} = memory(), locks = serialLocks();
  const accounts = createPreferencesStore({storage, locks}), videos = createPreferencesStore({storage, locks, module: 'youtube'});
  await accounts.update({settings: {platformSelect: 'youtube', days: 7, timeZone: 'Asia/Shanghai'}, youtubeKey: 'KEY'});
  assert.equal((await videos.load()).youtubeKey, 'KEY');
  assert.deepEqual((await videos.load()).settings, {});
  await Promise.all([accounts.update({settings: {days: 14}}), videos.update({settings: {platformSelect: 'instagram', youtubeMode: 'keyword', days: 30, timeZone: 'UTC'}})]);
  assert.equal((await accounts.load()).settings.days, 14);
  assert.equal((await accounts.load()).settings.timeZone, 'Asia/Shanghai');
  assert.deepEqual((await videos.load()).settings, {youtubeMode: 'keyword', days: 30, timeZone: 'UTC'});
  assert.equal(records[PREFERENCES_KEY].youtubeKey, 'KEY');
});

test('clearing the key from either module survives stale settings and key edits in the other', async () => {
  const {storage} = memory(), locks = serialLocks();
  const accounts = createPreferencesStore({storage, locks}), videos = createPreferencesStore({storage, locks, module: 'youtube'});
  await accounts.update({youtubeKey: 'TO_CLEAR', settings: {platformSelect: 'all'}});
  await videos.load();
  await accounts.update({rememberYoutubeKey: false, youtubeKey: ''});
  await videos.update({settings: {youtubeMode: 'videos'}, youtubeKey: 'STALE_KEY'});
  assert.equal((await videos.load()).youtubeKey, undefined); assert.equal((await accounts.load()).youtubeKey, undefined);
  assert.equal((await accounts.load()).settings.platformSelect, 'all');
});

test('comment visibility stores booleans independently of account settings and rejects string values', async () => {
  const {storage} = memory(), locks = serialLocks();
  const accounts = createPreferencesStore({storage, locks}), videos = createPreferencesStore({storage, locks, module: 'youtube'});
  await accounts.update({settings: {days: 7}});
  await videos.update({settings: {showCommentDetails: true}});
  assert.equal((await videos.load()).settings.showCommentDetails, true);
  assert.equal((await accounts.load()).settings.showCommentDetails, undefined);
  await videos.update({settings: {showCommentDetails: false}});
  assert.equal((await videos.load()).settings.showCommentDetails, false);
  assert.deepEqual(sanitizeSettings({showCommentDetails: 'false'}), {});
});

test('module diagnostics are restored and cleared independently', async t => {
  const {storage, records} = memory();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {configurable: true, value: {storage: {local: storage}}});
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'chrome', descriptor) : delete globalThis.chrome);
  const accounts = createDiagnosticStore(), videos = createDiagnosticStore({module: 'youtube'});
  const oldLog = createDiagnostics(); oldLog.record('info', 'account.event', {stage: 'collect'});
  const videoLog = createDiagnostics(); videoLog.record('info', 'video.event', {stage: 'collect'});
  await accounts.persistDiagnostics(oldLog.snapshot()); await videos.persistDiagnostics(videoLog.snapshot());
  assert.equal((await accounts.latestDiagnostics()).id, oldLog.id); assert.equal((await videos.latestDiagnostics()).id, videoLog.id);
  await videos.clearStoredDiagnostics();
  assert.equal(await videos.latestDiagnostics(), null); assert.equal((await accounts.latestDiagnostics()).id, oldLog.id);
  assert.ok(records['metrics.diagnostics.' + oldLog.id]);
});
