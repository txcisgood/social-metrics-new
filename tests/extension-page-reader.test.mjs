import assert from 'node:assert/strict';
import test from 'node:test';
import {createInstagramPageReader} from '../extension/lib/instagram-page-reader.mjs';
import {installInstagramPageObserver, readInstagramPageObserver} from '../extension/lib/instagram-page-observer.mjs';
import {instagramPageSnapshot} from '../extension/lib/instagram-page-snapshot.mjs';
import {createDiagnostics} from '../extension/lib/diagnostics.mjs';
import {collectInstagramPage} from '../extension/lib/instagram-page.mjs';

const SOURCE_ID = 17;
const WINDOW_ID = 6;
const PROFILE = 'private_creator_92';
const SHORTCODE = 'PRIVATE_POST_92';
const CAPTION = 'PRIVATE_CAPTION_SENTINEL_92';
const OPTIONS = {minDelay: 0, maxDelay: 0, timeoutMs: 100, pollMs: 1, profileSettleMs: 0, missingDateGraceMs: 5};
const savedGlobals = new WeakMap();

function globalValue(t, name, value) {
  if (!savedGlobals.has(t)) savedGlobals.set(t, new Map());
  const saved = savedGlobals.get(t);
  if (!saved.has(name)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    saved.set(name, before);
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    });
  }
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
}

function mockBrowser(t, hooks = {}) {
  let nextId = 100;
  const tabs = new Map([[SOURCE_ID, {id: SOURCE_ID, windowId: WINDOW_ID, url: 'https://www.instagram.com/', status: 'complete'}]]);
  const calls = {get: [], create: [], update: [], remove: [], inject: [], fetch: []};
  globalValue(t, 'fetch', async (...args) => {
    calls.fetch.push(args);
    throw new Error('Page reader must not make independent fetch requests');
  });
  globalValue(t, 'chrome', {
    tabs: {
      async get(id) {
        calls.get.push(id);
        await hooks.get?.(id, tabs);
        if (!tabs.has(id)) throw new Error('Tab is closed');
        return {...tabs.get(id)};
      },
      async create(properties) {
        calls.create.push({...properties});
        await hooks.create?.(properties, tabs);
        const tab = {id: nextId++, windowId: properties.windowId, url: properties.url, status: 'complete'};
        tabs.set(tab.id, tab);
        return {...tab};
      },
      async update(id, properties) {
        calls.update.push({id, ...properties});
        await hooks.update?.(id, properties, tabs);
        if (!tabs.has(id)) throw new Error('Tab is closed');
        const tab = {...tabs.get(id), ...properties, pendingUrl: undefined, status: 'complete'};
        tabs.set(id, tab);
        return {...tab};
      },
      async remove(id) { calls.remove.push(id); tabs.delete(id); },
    },
    scripting: {
      async executeScript(injection) {
        calls.inject.push(injection);
        if (injection.func === installInstagramPageObserver) return [{result: hooks.install ? await hooks.install(injection, tabs) : {installed: false}}];
        if (injection.func === readInstagramPageObserver) return [{result: await hooks.observed?.(injection, tabs)}];
        if (injection.func !== instagramPageSnapshot) return [{result: undefined}];
        const tab = tabs.get(injection.target.tabId);
        const expected = injection.args[0];
        const kind = expected.expectedShortcode ? 'post' : 'profile';
        const result = {
          url: tab.url, kind, state: 'ready',
          profile: {username: expected.expectedUsername, totalCount: 1},
          links: kind === 'profile' ? [{shortcode: SHORTCODE, url: `https://www.instagram.com/p/${SHORTCODE}/`}] : [],
          posts: kind === 'post' ? [{shortcode: expected.expectedShortcode, ts: 1792400000, caption: CAPTION}] : [],
          timeline: {complete: false},
        };
        return [{result: hooks.snapshot ? await hooks.snapshot(result, injection, tabs) : result}];
      },
    },
  });
  return {tabs, calls};
}

test('opens a dedicated inactive profile tab in the selected window without navigating the original', async t => {
  const {tabs, calls} = mockBrowser(t);
  let requests = 0;
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onRequest: () => requests++});
  const profile = await reader.openProfile(PROFILE);
  assert.equal(profile.kind, 'profile');
  assert.deepEqual(calls.create, [{windowId: WINDOW_ID, url: `https://www.instagram.com/${PROFILE}/`, active: false}]);
  assert.equal(tabs.get(SOURCE_ID).url, 'https://www.instagram.com/');
  assert.equal(calls.update.length, 0);
  assert.equal(requests, 1);
  assert.ok(calls.inject.every(value => value.target.tabId !== SOURCE_ID && value.world === (value.func === instagramPageSnapshot ? 'ISOLATED' : 'MAIN')));
  assert.equal(calls.fetch.length, 0);
  assert.doesNotMatch(JSON.stringify(calls.create), /api\/v1|graphql|web_profile_info|usernameinfo/);
});

test('reuses one owned tab per page kind and canonicalizes post navigation without tracking parameters', async t => {
  const {tabs, calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE);
  await reader.openProfile('second_creator');
  await reader.openPost(`https://www.instagram.com/${PROFILE}/reel/${SHORTCODE}/?tracking=private`, SHORTCODE);
  await reader.openPost('https://www.instagram.com/p/NEXT_POST/?utm_source=private', 'NEXT_POST');
  assert.equal(calls.create.length, 2);
  assert.deepEqual(calls.update, [
    {id: 100, url: 'https://www.instagram.com/second_creator/'},
    {id: 101, url: 'https://www.instagram.com/p/NEXT_POST/'},
  ]);
  assert.equal(calls.create[1].url, `https://www.instagram.com/p/${SHORTCODE}/`);
  assert.equal(tabs.get(SOURCE_ID).url, 'https://www.instagram.com/');
  assert.equal(calls.fetch.length, 0);
  assert.doesNotMatch(JSON.stringify([...calls.create, ...calls.update]), /api\/v1|graphql|tracking|utm_source/);
  await reader.close();
  assert.deepEqual(calls.remove, [100, 101]);
  assert.ok(tabs.has(SOURCE_ID));
  await reader.close();
  assert.deepEqual(calls.remove, [100, 101], 'cleanup is idempotent');
});

test('invalid profile or post locations cannot create tabs', async t => {
  const {calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await assert.rejects(reader.openProfile('../accounts/login'), {code: 'BAD_URL'});
  await assert.rejects(reader.openPost(`https://example.com/p/${SHORTCODE}/`, SHORTCODE), {code: 'BAD_URL'});
  await assert.rejects(reader.openPost(`https://www.instagram.com/p/${SHORTCODE}/`, 'OTHER'), {code: 'BAD_URL'});
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.inject.length, 0);
});

test('an unavailable selected tab prevents opening collection tabs', async t => {
  const {tabs, calls} = mockBrowser(t);
  tabs.delete(SOURCE_ID);
  await assert.rejects(createInstagramPageReader(SOURCE_ID, OPTIONS).openProfile(PROFILE), {code: 'TAB'});
  assert.equal(calls.create.length, 0);
});

test('keeps an in-page login prompt open even when its URL still matches the profile', async t => {
  const {tabs, calls} = mockBrowser(t, {snapshot: result => ({...result, state: 'login'})});
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await assert.rejects(reader.openProfile(PROFILE), {code: 'AUTH'});
  await reader.close();
  assert.deepEqual(calls.remove, []);
  assert.ok(tabs.has(100));
});

test('pre-cancellation prevents navigation and cleanup never removes the selected tab', async t => {
  const {tabs, calls} = mockBrowser(t);
  const controller = new AbortController();
  controller.abort();
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, signal: controller.signal});
  await assert.rejects(reader.openProfile(PROFILE), {code: 'CANCELLED'});
  await reader.close();
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.remove.length, 0);
  assert.ok(tabs.has(SOURCE_ID));
});

test('cancellation during source lookup prevents the first navigation', async t => {
  const controller = new AbortController();
  const {calls} = mockBrowser(t, {get(id) { if (id === SOURCE_ID) controller.abort(); }});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, signal: controller.signal});
  await assert.rejects(reader.openProfile(PROFILE), {code: 'CANCELLED'});
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
});

test('cancellation after tab creation retains ownership for cleanup and prevents subsequent navigation', async t => {
  const {tabs, calls} = mockBrowser(t);
  const controller = new AbortController();
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, signal: controller.signal, onRequest: () => controller.abort()});
  await assert.rejects(reader.openProfile(PROFILE), {code: 'CANCELLED'});
  await assert.rejects(reader.openProfile('second_creator'), {code: 'CANCELLED'});
  await assert.rejects(reader.openPost(`https://www.instagram.com/p/${SHORTCODE}/`, SHORTCODE), {code: 'CANCELLED'});
  assert.equal(calls.create.length, 1);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.inject.length, 0);
  await reader.close();
  assert.deepEqual(calls.remove, [100]);
  assert.ok(tabs.has(SOURCE_ID));
});

test('a tab manually navigated elsewhere is neither overwritten nor closed', async t => {
  const {tabs, calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE);
  tabs.get(100).url = 'https://www.instagram.com/different_creator/';
  await assert.rejects(reader.openProfile('next_creator'), {code: 'TAB'});
  await reader.close();
  assert.equal(calls.update.length, 0);
  assert.equal(calls.remove.length, 0);
  assert.ok(tabs.has(100));
});

test('a user navigation still in progress is neither overwritten nor closed while the old URL remains', async t => {
  const {tabs, calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE);
  Object.assign(tabs.get(100), {status: 'loading', pendingUrl: 'https://www.instagram.com/different_creator/'});
  await assert.rejects(reader.openProfile('next_creator'), {code: 'TAB'});
  await reader.close();
  assert.equal(calls.update.length, 0);
  assert.equal(calls.remove.length, 0);
  assert.ok(tabs.has(100));
});

test('cleanup preserves a repurposed tab with a pending navigation even without another read', async t => {
  const {tabs, calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE);
  Object.assign(tabs.get(100), {status: 'loading', pendingUrl: 'https://example.com/user-navigation'});
  await reader.close();
  assert.equal(calls.remove.length, 0);
  assert.ok(tabs.has(100));
});

test('login or challenge redirects produce AUTH and remain open for the user', async t => {
  const {tabs, calls} = mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE);
  tabs.get(100).url = 'https://www.instagram.com/challenge/';
  await assert.rejects(reader.openProfile('next_creator'), {code: 'AUTH'});
  await reader.close();
  assert.equal(calls.update.length, 0);
  assert.equal(calls.remove.length, 0);
  assert.ok(tabs.has(100));
});

test('snapshot login and restriction states produce distinct stop codes without retrying', async t => {
  for (const [state, code] of [['login', 'AUTH'], ['restricted', 'RATE_LIMIT'], ['unavailable', 'PAGE_UNAVAILABLE']]) {
    const {calls} = mockBrowser(t, {snapshot: value => ({...value, state})});
    const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
    await assert.rejects(reader.openProfile(PROFILE), {code});
    assert.equal(calls.create.length, 1);
    assert.equal(calls.inject.filter(value => value.func === instagramPageSnapshot).length, 1);
    assert.equal(calls.fetch.length, 0);
  }
});

test('private profiles and confirmed empty profiles return promptly for collector decisions', async t => {
  for (const state of ['private', 'ready']) {
    const {calls} = mockBrowser(t, {snapshot: value => ({...value, state, links: [], posts: [], profile: {totalCount: 0}})});
    const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
    const snapshot = await reader.openProfile(PROFILE);
    assert.equal(snapshot.state, state);
    assert.equal(calls.inject.filter(value => value.func === instagramPageSnapshot).length, 1);
  }
});

test('a login redirect between tab inspection and snapshot still reports AUTH', async t => {
  mockBrowser(t, {snapshot: value => ({...value, url: 'https://www.instagram.com/accounts/login/', state: 'login'})});
  await assert.rejects(createInstagramPageReader(SOURCE_ID, OPTIONS).openProfile(PROFILE), {code: 'AUTH'});
});

test('scrolling uses the owned profile DOM and returns newly visible links without API requests', async t => {
  let snapshots = 0, requests = 0;
  const {calls} = mockBrowser(t, {snapshot(value) {
    snapshots++;
    return snapshots < 3 ? value : {...value, links: [...value.links, {shortcode: 'MORE_POST', url: 'https://www.instagram.com/p/MORE_POST/'}]};
  }});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, timeoutMs: 1000, onRequest: () => requests++});
  await reader.openProfile(PROFILE);
  const result = await reader.scrollProfile();
  assert.equal(result.links.length, 2);
  assert.equal(requests, 2);
  const scrolls = calls.inject.filter(value => value.func.toString().includes('window.scrollTo'));
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].target.tabId, 100);
  assert.match(scrolls[0].func.toString(), /scrollTo/);
  assert.doesNotMatch(scrolls[0].func.toString(), /fetch|XMLHttpRequest|api\/v1|graphql/);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.create.length, 1);
});

test('cancellation before scrolling does not touch the profile DOM', async t => {
  const {calls} = mockBrowser(t);
  const controller = new AbortController();
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, signal: controller.signal});
  await reader.openProfile(PROFILE);
  const before = calls.inject.length;
  controller.abort();
  await assert.rejects(reader.scrollProfile(), {code: 'CANCELLED'});
  assert.equal(calls.inject.length, before);
  assert.equal(calls.update.length, 0);
});

test('an unresolved loading page fails with a bounded timeout without creating another tab', async t => {
  const {calls} = mockBrowser(t, {snapshot: value => ({...value, state: 'loading', links: [], posts: []})});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, timeoutMs: 10});
  await assert.rejects(reader.openProfile(PROFILE), {code: 'NETWORK_TIMEOUT'});
  assert.equal(calls.create.length, 1);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test('ready but incomplete pages retain their snapshot so the collector can mark uncertainty', async t => {
  mockBrowser(t, {snapshot: value => ({...value, links: [], posts: [], profile: {totalCount: null}})});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, timeoutMs: 10});
  const result = await reader.openProfile(PROFILE);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.links, []);
  assert.equal(result.profile.totalCount, null);
});

test('snapshot diagnostics retain useful metadata without account names, post links, or content', async t => {
  const {calls} = mockBrowser(t);
  const diagnostics = createDiagnostics({version: 'test'}), events = [];
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onDiagnostic(event, details) {
    events.push({event, details});
    diagnostics.record(event.endsWith('failed') ? 'error' : 'info', event, details);
  }});
  await reader.openProfile(PROFILE);
  await reader.openPost(`https://www.instagram.com/p/${SHORTCODE}/`, SHORTCODE);
  assert.deepEqual(events.map(value => value.event), ['page.started', 'page.completed', 'page.started', 'page.completed']);
  assert.deepEqual(events.map(value => value.details.endpoint), ['profile', 'profile', 'post', 'post']);
  assert.deepEqual(events.map(value => value.details.requestId), [1, 1, 2, 2]);
  for (const {details} of events) {
    assert.equal(details.platform, 'instagram');
    assert.equal(details.stage, 'page');
    for (const key of ['url', 'username', 'caption', 'body', 'posts', 'links', 'response', 'cookies']) {
      assert.equal(Object.hasOwn(details, key), false, `${key} must not enter page diagnostic metadata`);
    }
  }
  const text = diagnostics.text();
  assert.doesNotMatch(text, new RegExp(`${PROFILE}|${SHORTCODE}|${CAPTION}|https:`));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${PROFILE}|${SHORTCODE}|${CAPTION}|https:`));
  assert.match(text, /durationMs/);
  assert.equal(calls.fetch.length, 0);
});

test('native tab failures are redacted by the diagnostic boundary before export', async t => {
  mockBrowser(t, {create() { throw new Error(`Failed for ${PROFILE} https://www.instagram.com/p/${SHORTCODE}/ ${CAPTION}`); }});
  const diagnostics = createDiagnostics({version: 'test'});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onDiagnostic(event, details) {
    diagnostics.record(event.endsWith('failed') ? 'error' : 'info', event, details);
  }});
  await assert.rejects(reader.openProfile(PROFILE));
  assert.match(diagnostics.text(), /page.failed/);
  assert.doesNotMatch(diagnostics.text(), new RegExp(`${PROFILE}|${SHORTCODE}|${CAPTION}|https:`));
});

test('a throwing diagnostic callback cannot alter successful reads or the actual stop reason', async t => {
  mockBrowser(t);
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onDiagnostic() { throw new Error('Broken logger'); }});
  assert.equal((await reader.openProfile(PROFILE)).state, 'ready');
  mockBrowser(t, {snapshot: value => ({...value, state: 'restricted'})});
  const limited = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onDiagnostic() { throw new Error('Broken logger'); }});
  await assert.rejects(limited.openProfile(PROFILE), {code: 'RATE_LIMIT'});
});

test('page-owned response fields complete a profile batch without opening any detail pages', async t => {
  const {calls} = mockBrowser(t, {install: () => ({installed: true}), observed: () => ({
    profile: {username: PROFILE, followers: 500, totalCount: 1, isPrivate: false},
    posts: [{shortcode: SHORTCODE, url: `https://www.instagram.com/p/${SHORTCODE}/`, owner: PROFILE,
      ts: 1792400000, caption: CAPTION, likes: 88, comments: 3, type: '图片', profileMember: true}],
    timeline: {complete: false},
  })});
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  const rows = await collectInstagramPage({name: PROFILE, row_no: 2, platform: 'instagram', url: `https://www.instagram.com/${PROFILE}/`},
    {targetDates: [new Date(1792400000000).toISOString().slice(0, 10)], timeZone: 'UTC'}, reader);
  assert.deepEqual(rows.map(row => row.status), ['OK']); assert.equal(rows[0].like_count, 88);
  assert.equal(rows[0].follower_count, 500); assert.equal(calls.create.length, 1); assert.equal(calls.update.length, 0);
  assert.ok(calls.inject.filter(call => call.world === 'MAIN').every(call => call.target.tabId === 100 && call.injectImmediately));
  assert.equal(calls.fetch.length, 0);
});

test('passive hook failure falls back to DOM data, while a captured restriction stops the reader', async t => {
  mockBrowser(t, {install() { throw new Error('Site prevented optional observer'); }});
  assert.equal((await createInstagramPageReader(SOURCE_ID, OPTIONS).openProfile(PROFILE)).state, 'ready');
  const {calls} = mockBrowser(t, {install: () => ({installed: true}), observed: () => ({profile: {username: PROFILE}, state: 'restricted'})});
  await assert.rejects(createInstagramPageReader(SOURCE_ID, OPTIONS).openProfile(PROFILE), {code: 'RATE_LIMIT'});
  assert.equal(calls.create.length, 1);
});

test('foreign observer scope cannot contribute profile fields or posts', async t => {
  mockBrowser(t, {install: () => ({installed: true}), observed: () => ({profile: {username: 'someone_else', totalCount: 0},
    posts: [{shortcode: 'FOREIGN', ts: 1792400000, owner: 'someone_else'}]})});
  const result = await createInstagramPageReader(SOURCE_ID, OPTIONS).openProfile(PROFILE);
  assert.equal(result.profile.totalCount, 1); assert.deepEqual(result.posts, []);
});

test('a ready post without a date returns after a short grace, not the full network timeout', async t => {
  mockBrowser(t, {snapshot: value => ({...value, posts: value.posts.map(post => ({...post, ts: null}))})});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, timeoutMs: 500, missingDateGraceMs: 5});
  await reader.openProfile(PROFILE);
  const start = Date.now(); const result = await reader.openPost(`https://www.instagram.com/p/${SHORTCODE}/`, SHORTCODE);
  assert.equal(result.posts[0].ts, null); assert.ok(Date.now() - start < 300);
});

test('same-sized virtualized grids with a new shortcode count as scroll progress', async t => {
  let n = 0;
  mockBrowser(t, {snapshot: value => ++n < 3 ? value : {...value, links: [{shortcode: 'REPLACED', url: 'https://www.instagram.com/p/REPLACED/'}]}});
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, timeoutMs: 1000});
  await reader.openProfile(PROFILE); const start = Date.now(); const result = await reader.scrollProfile();
  assert.equal(result.links[0].shortcode, 'REPLACED'); assert.ok(Date.now() - start < 700);
});

test('loading tabs expose usable data without waiting for every asset to finish', async t => {
  mockBrowser(t, {get(id, tabs) { if (id !== SOURCE_ID) tabs.get(id).status = 'loading'; }});
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  assert.equal((await reader.openProfile(PROFILE)).state, 'ready');
});

test('waiting progress and logs distinguish deliberate delay from page-reading time', async t => {
  mockBrowser(t); const events = [], progress = [];
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, minDelay: .02, maxDelay: .02,
    onProgress: event => progress.push(event), onDiagnostic: (event, details) => events.push({event, details})});
  await reader.openProfile(PROFILE); await reader.openPost(`https://www.instagram.com/p/${SHORTCODE}/`, SHORTCODE);
  assert.ok(progress.some(value => value.stage === 'waiting' && value.waitMs > 0 && value.kind === 'post'));
  const completed = events.filter(value => value.event === 'page.completed').at(-1).details;
  assert.ok(completed.waitMs > 0); assert.ok(completed.readMs >= 0); assert.ok(completed.durationMs >= completed.waitMs);
});

test('refreshing already loaded profile data adds no page operation or network request', async t => {
  const {calls} = mockBrowser(t); let operations = 0;
  const reader = createInstagramPageReader(SOURCE_ID, {...OPTIONS, onRequest: () => operations++});
  await reader.openProfile(PROFILE); const result = await reader.refreshProfile();
  assert.equal(result.kind, 'profile'); assert.equal(operations, 1);
  assert.equal(calls.create.length, 1); assert.equal(calls.update.length, 0); assert.equal(calls.fetch.length, 0);
});

test('lost injection permission during a cached profile read still halts the platform with TAB', async t => {
  let failed = false;
  mockBrowser(t, {snapshot: value => { if (failed) throw new Error('Permission revoked'); return value; }});
  const reader = createInstagramPageReader(SOURCE_ID, OPTIONS);
  await reader.openProfile(PROFILE); failed = true;
  await assert.rejects(reader.refreshProfile(), {code: 'TAB'});
});
