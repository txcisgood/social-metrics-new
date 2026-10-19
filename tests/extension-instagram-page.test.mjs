import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInstagramPage} from '../edge-extension/lib/instagram-page.mjs';

const ACCOUNT = {row_no: 2, name: 'Creator', url: 'https://www.instagram.com/test.creator/', platform: 'instagram', note: '备注'};
const OPTIONS = {targetDates: ['2026-08-29'], timeZone: 'Europe/London', maxPages: 2, maxPosts: 40};
const ts = value => Date.parse(value) / 1000;
function post(shortcode = 'A', time = '2026-08-29T10:00:00Z', extra = {}) {
  return {shortcode, url: `https://www.instagram.com/p/${shortcode}/`, ts: time ? ts(time) : null,
    caption: 'Visible caption', type: '图片', likes: 10, comments: 2, views: null, owner: 'test.creator', pinned: false, source: 'embedded', ...extra};
}
function link(shortcode, extra = {}) { return {shortcode, url: `https://www.instagram.com/p/${shortcode}/`, pinned: false, ...extra}; }
function profile(posts = [post()], extra = {}) {
  return {url: ACCOUNT.url, kind: 'profile', state: 'ready', source: 'embedded',
    profile: {username: 'test.creator', followers: 1200, totalCount: posts.length, isPrivate: false},
    posts, links: posts.map(item => link(item.shortcode)), timeline: {complete: true}, ...extra};
}
function detail(item, extra = {}) { return {url: item.url, kind: 'post', state: 'ready', posts: [item], links: [], ...extra}; }
function reader(profiles, details = {}) {
  const calls = [];
  let index = 0;
  const next = () => {
    const value = profiles[index++];
    assert.ok(value, 'Unexpected profile read');
    if (value instanceof Error) throw value;
    return value;
  };
  return {calls,
    async openProfile(username) { calls.push(['profile', username]); return next(); },
    async scrollProfile() { calls.push(['scroll']); return next(); },
    async openPost(url, shortcode) {
      calls.push(['post', shortcode, url]);
      const result = details[shortcode];
      assert.ok(result, `Unexpected detail: ${shortcode}`);
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result() : result;
    }};
}
const codeError = code => Object.assign(new Error('Fixture failure'), {code});

test('page collector returns exact public metrics and timezone-compatible PostMetric rows', async () => {
  const r = reader([profile([post('A', '2026-08-28T23:30:00Z', {likes: 0, comments: 0, views: 0})])]);
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'OK'); assert.equal(row.published_local, '2026-08-29 00:30:00');
  assert.equal(row.published_utc, '2026-08-28 23:30:00 UTC');
  assert.equal(row.like_count, 0); assert.equal(row.comment_count, 0); assert.equal(row.view_count, 0);
  assert.equal(row.follower_count, 1200); assert.equal(row.post_url, 'https://www.instagram.com/p/A/');
  assert.deepEqual(r.calls, [['profile', 'test.creator']]);
});

test('grid links require detail timestamps before becoming posts', async () => {
  const r = reader([profile([], {links: [link('A')], profile: {username: 'test.creator', totalCount: 1, isPrivate: false}})], {A: detail(post())});
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.deepEqual(rows.map(row => row.status), ['OK']);
  assert.equal(r.calls.filter(call => call[0] === 'post').length, 1);
});

test('unresolved grid timestamps are incomplete even with explicit timeline end', async () => {
  const r = reader([profile([], {links: [link('A')], profile: {username: 'test.creator', totalCount: 1, isPrivate: false}})], {
    A: detail(post('A', null, {likes: null, comments: null}))
  });
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'FAILED'); assert.equal(row.error_code, 'PAGE_INCOMPLETE');
});

test('old pinned and out-of-order posts never imply date coverage', async () => {
  const first = profile([post('PIN', '2026-01-01T12:00:00Z', {pinned: true}), post('OLD', '2026-08-01T12:00:00Z')], {
    timeline: {complete: false}, profile: {username: 'test.creator', totalCount: 20, isPrivate: false}});
  const last = profile([post('A'), post('OLDER', '2025-01-01T12:00:00Z'), post('B', '2026-08-29T11:00:00Z')], {
    timeline: {complete: false}, profile: {username: 'test.creator', totalCount: 20, isPrivate: false}});
  const r = reader([first, last]);
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'OK', 'FAILED']);
  assert.equal(rows.at(-1).error_code, 'PAGE_INCOMPLETE');
  assert.equal(r.calls.filter(call => call[0] === 'scroll').length, 1);
});

test('duplicate and virtualized grid snapshots deduplicate while preserving richer metrics', async () => {
  const first = profile([post('A')], {timeline: {complete: false}, profile: {username: 'test.creator', totalCount: 2}});
  const second = profile([post('B')], {links: [link('A'), link('B')], profile: {username: 'test.creator', totalCount: 2}, timeline: {complete: false}});
  const r = reader([first, second]);
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'OK'));
  assert.equal(rows.find(row => row.post_url.endsWith('/A/')).like_count, 10);
  assert.equal(r.calls.filter(call => call[0] === 'post').length, 0);
});

test('no growth and no matches is incomplete, never NO_POST', async () => {
  const p = profile([post('OLD', '2026-08-01T12:00:00Z')], {timeline: {complete: false}, profile: {username: 'test.creator', totalCount: null}});
  const r = reader([p, p]);
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'FAILED'); assert.equal(row.error_code, 'PAGE_INCOMPLETE');
});

test('verified complete old timeline can return NO_POST without opening old metrics', async () => {
  const r = reader([profile([post('OLD', '2026-08-01T12:00:00Z', {likes: null, comments: null})])]);
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'NO_POST'); assert.equal(r.calls.length, 1);
});

test('known public zero-post profile is the only empty NO_POST case', async () => {
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, reader([profile([])]));
  assert.equal(row.status, 'NO_POST');
  for (const extra of [
    {profile: {username: 'test.creator', totalCount: null, isPrivate: false}},
    {profile: {username: 'test.creator', totalCount: 0, isPrivate: null}},
  ]) {
    const rows = await collectInstagramPage(ACCOUNT, OPTIONS, reader([profile([], extra)]));
    assert.equal(rows[0].status, 'FAILED');
  }
});

test('explicit private page without visible content stops immediately without pointless scrolling', async () => {
  const r = reader([profile([], {profile: {username: 'test.creator', totalCount: 0, isPrivate: true}, state: 'private'})]);
  await assert.rejects(collectInstagramPage(ACCOUNT, OPTIONS, r), error => {
    assert.equal(error.code, 'ACCESS_DENIED'); assert.deepEqual(error.partialRows, []); return true;
  });
  assert.equal(r.calls.length, 1);
});

test('visible private content is kept and incomplete coverage is explicit', async () => {
  const p = profile([post()], {state: 'private', timeline: {complete: false}, profile: {username: 'test.creator', totalCount: null, isPrivate: true}});
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, reader([p, p]));
  assert.deepEqual(rows.map(row => row.status), ['OK', 'FAILED']);
});

test('hidden and abbreviated metrics remain unavailable after a single detail attempt', async () => {
  const item = post('A', undefined, {likes: null, comments: '1.2K', views: -1, type: 'Reels'});
  const r = reader([profile([item])], {A: detail(item)});
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'OK');
  for (const key of ['like_count', 'comment_count', 'view_count']) assert.equal(row[key], '未公开或不可用');
  assert.equal(r.calls.filter(call => call[0] === 'post').length, 1);
});

test('a Reel grid permalink keeps its classification when detail loads the p alias', async () => {
  const r = reader([profile([], {links: [link('A', {url: 'https://www.instagram.com/reel/A/'})],
    profile: {username: 'test.creator', totalCount: 1, isPrivate: false}})], {A: detail(post('A', undefined, {type: '视频'}))});
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'OK'); assert.equal(row.post_type, 'Reels');
});

test('maxPosts bounds detail visits and preserves completed hits plus partial summary', async () => {
  const r = reader([profile([], {links: [link('A'), link('B')], profile: {username: 'test.creator', totalCount: 2, isPrivate: false}})], {A: detail(post())});
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPosts: 1}, r);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'FAILED']);
  assert.match(rows.at(-1).error, /详情访问上限/);
  assert.equal(r.calls.filter(call => call[0] === 'post').length, 1);
});

test('detail budget discovers unknown dates before improving hidden metrics', async () => {
  const r = reader([profile([post('KNOWN', undefined, {likes: null})], {
    links: [link('KNOWN'), link('UNKNOWN')], profile: {username: 'test.creator', totalCount: 2, isPrivate: false}
  })], {UNKNOWN: detail(post('UNKNOWN'))});
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPosts: 1}, r);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'OK'));
  assert.equal(rows.find(row => row.post_url.endsWith('/KNOWN/')).like_count, '未公开或不可用');
  assert.deepEqual(r.calls.filter(call => call[0] === 'post').map(call => call[1]), ['UNKNOWN']);
});

test('contradictory zero count with visible old posts cannot establish no publishing', async () => {
  const p = profile([post('OLD', '2026-08-01T12:00:00Z')], {
    profile: {username: 'test.creator', totalCount: 0, isPrivate: false}
  });
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, reader([p, p]));
  assert.equal(row.status, 'FAILED'); assert.equal(row.error_code, 'PAGE_INCOMPLETE');
});

test('cancel after successful detail retains the completed validated hit on the error', async () => {
  const controller = new AbortController();
  const r = reader([profile([], {links: [link('A'), link('B')], profile: {username: 'test.creator', totalCount: 2, isPrivate: false}})], {
    A: () => { controller.abort(); return detail(post()); }
  });
  await assert.rejects(collectInstagramPage(ACCOUNT, {...OPTIONS, signal: controller.signal}, r), error => {
    assert.equal(error.code, 'CANCELLED'); assert.equal(error.partialRows.length, 1);
    assert.equal(error.partialRows[0].post_url, 'https://www.instagram.com/p/A/'); return true;
  });
  assert.equal(r.calls.filter(call => call[0] === 'post').length, 1);
});

for (const code of ['AUTH', 'RATE_LIMIT', 'TAB', 'CANCELLED']) {
  test(`reader ${code} preserves already read hits without opening another page`, async () => {
    const r = reader([profile([post()], {timeline: {complete: false}, profile: {username: 'test.creator', totalCount: 2}}), codeError(code)]);
    await assert.rejects(collectInstagramPage(ACCOUNT, OPTIONS, r), error => {
      assert.equal(error.code, code); assert.equal(error.partialRows.length, 1);
      assert.equal(error.partialRows[0].status, 'OK'); return true;
    });
    assert.equal(r.calls.length, 2);
  });
}

test('wrong account identity and navigation are rejected', async () => {
  for (const p of [profile([post()], {profile: {username: 'someone.else'}}), profile([post()], {url: 'https://www.instagram.com/someone.else/'})]) {
    await assert.rejects(collectInstagramPage(ACCOUNT, OPTIONS, reader([p])), {code: 'INVALID_DATA'});
  }
});

test('wrong post shortcode or canonical URL is rejected', async () => {
  const initial = profile([], {links: [link('A')], profile: {username: 'test.creator', totalCount: 1, isPrivate: false}});
  for (const wrong of [detail(post('B')), detail(post('B'), {url: post().url})]) {
    await assert.rejects(collectInstagramPage(ACCOUNT, OPTIONS, reader([initial], {A: wrong})), {code: 'INVALID_DATA'});
  }
});

test('collaborative post with another primary owner is allowed when linked by profile grid', async () => {
  const item = post('A', undefined, {owner: 'collaborator', likes: null});
  const r = reader([profile([item])], {A: detail({...item, likes: 8})});
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'OK'); assert.equal(row.like_count, 8);
});

test('verified profile-timeline collaboration survives absent grid and a detail refresh', async () => {
  const item = post('A', undefined, {owner: 'collaborator', likes: null, profileMember: true});
  const r = reader([profile([item], {links: []})], {A: detail({...item, likes: 8, profileMember: false})});
  const [row] = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(row.status, 'OK'); assert.equal(row.like_count, 8);
});

test('unrelated embedded owner without a grid reference does not become a successful post', async () => {
  const p = profile([post('A', undefined, {owner: 'unrelated'})], {links: []});
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, reader([p, p]));
  assert.deepEqual(rows.map(row => row.status), ['FAILED']);
});

test('login and restriction page snapshots stop the platform through typed errors', async () => {
  for (const [state, code] of [['login', 'AUTH'], ['restricted', 'RATE_LIMIT'], ['unavailable', 'PAGE_UNAVAILABLE']]) {
    await assert.rejects(collectInstagramPage(ACCOUNT, OPTIONS, reader([profile([], {state})])), {code});
  }
});

test('invalid dates, post links, or bounds never trigger page navigation', async () => {
  for (const options of [{...OPTIONS, targetDates: ['2026-02-30']}, {...OPTIONS, maxPosts: 0}, {...OPTIONS, maxPages: 51}, {...OPTIONS, scanMode: 'unknown'}]) {
    const r = reader([]);
    await assert.rejects(collectInstagramPage(ACCOUNT, options, r)); assert.equal(r.calls.length, 0);
  }
  await assert.rejects(collectInstagramPage({...ACCOUNT, url: 'https://www.instagram.com/p/ABC/'}, OPTIONS, reader([])), {code: 'BAD_URL'});
});

const oldBoundary = () => [post('TARGET'), post('OLD1', '2026-08-28T12:00:00Z'),
  post('OLD2', '2026-08-27T12:00:00Z'), post('OLD3', '2026-08-26T12:00:00Z')];
const incompleteProfile = (items, extra = {}) => profile(items, {
  profile: {username: 'test.creator', totalCount: 100, isPrivate: false}, timeline: {complete: false}, ...extra
});

test('default recent mode needs one page and zero details for a known current batch and old boundary', async () => {
  const r = reader([incompleteProfile(oldBoundary())]);
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'FAILED']);
  assert.equal(rows.at(-1).stop_reason, 'recent_boundary');
  assert.equal(rows.at(-1).error_code, 'PAGE_INCOMPLETE');
  assert.deepEqual(r.calls, [['profile', 'test.creator']]);
  assert.ok(r.calls.length < 5, 'the previous pre-scroll strategy used all five incomplete profile batches before deciding');
});

test('current-batch details are read before any additional profile scroll', async () => {
  const r = reader([
    incompleteProfile([], {links: [link('A')]}),
    profile([post('B')], {profile: {username: 'test.creator', totalCount: 2, isPrivate: false}})
  ], {A: detail(post('A'))});
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'post', 'scroll']);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'OK']);
});

test('complete mode bypasses the recent heuristic and can prove the complete timeline', async () => {
  const initial = incompleteProfile(oldBoundary(), {profile: {username: 'test.creator', totalCount: 5, isPrivate: false}});
  const next = profile([post('FINAL', '2026-08-25T12:00:00Z')], {
    profile: {username: 'test.creator', totalCount: 5, isPrivate: false}, timeline: {complete: false}
  });
  const r = reader([initial, next]);
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, scanMode: 'complete'}, r);
  assert.deepEqual(rows.map(row => row.status), ['OK']);
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'scroll']);
});

test('one scroll without new shortcodes or dates stops rather than exhausting five pages', async () => {
  const initial = incompleteProfile([post('OLD', '2026-08-01T12:00:00Z')]);
  const changedMetricsOnly = incompleteProfile([post('OLD', '2026-08-01T12:00:00Z', {likes: 80})]);
  const r = reader([initial, changedMetricsOnly]);
  const [row] = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.equal(row.status, 'FAILED'); assert.equal(row.stop_reason, 'no_progress');
  assert.equal(row.extra['已读取主页批次'], 2);
  assert.equal(r.calls.length, 2);
});

test('a shortcode detail is attempted once even when hidden fields remain across later snapshots', async () => {
  const item = post('A', undefined, {likes: null, comments: null});
  const p = incompleteProfile([item]);
  const r = reader([p, p], {A: detail(item)});
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.equal(rows[0].like_count, '未公开或不可用');
  assert.equal(rows.at(-1).stop_reason, 'no_progress');
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'post', 'scroll']);
});

test('known dates outside the target range never trigger metric detail requests', async () => {
  const items = oldBoundary().slice(1).map(item => ({...item, likes: null, comments: null, views: null, type: 'Reels'}));
  const r = reader([incompleteProfile(items)]);
  const [row] = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.equal(row.stop_reason, 'recent_boundary'); assert.equal(row.status, 'FAILED');
  assert.deepEqual(r.calls.map(call => call[0]), ['profile']);
});

test('all unknown dates in the current batch are resolved before testing a recent boundary', async () => {
  const codes = ['OLD1', 'OLD2', 'OLD3', 'LATER_TARGET'];
  const p = incompleteProfile([], {links: codes.map(code => link(code))});
  const r = reader([p, p], {
    OLD1: detail(post('OLD1', '2026-08-28T12:00:00Z')),
    OLD2: detail(post('OLD2', '2026-08-27T12:00:00Z')),
    OLD3: detail(post('OLD3', '2026-08-26T12:00:00Z')),
    LATER_TARGET: detail(post('LATER_TARGET')),
  });
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.deepEqual(r.calls.slice(1, 5).map(call => call[1]), codes);
  assert.equal(rows[0].post_url, 'https://www.instagram.com/p/LATER_TARGET/');
  assert.equal(rows.at(-1).stop_reason, 'no_progress', 'out-of-order current batch cannot establish an old boundary');
});

test('later known target posts are not skipped after three older cards in the same batch', async () => {
  const items = [...oldBoundary().slice(1), post('LATER_TARGET')];
  const p = incompleteProfile(items), r = reader([p, p]);
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.equal(rows[0].post_url, 'https://www.instagram.com/p/LATER_TARGET/');
  assert.equal(rows.at(-1).stop_reason, 'no_progress');
  assert.equal(r.calls.length, 2);
});

test('three old pinned cards never establish a recent boundary or NO_POST', async () => {
  const items = oldBoundary().slice(1).map(item => ({...item, pinned: true}));
  const p = incompleteProfile(items), r = reader([p, p]);
  const [row] = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 5}, r);
  assert.equal(row.status, 'FAILED'); assert.equal(row.stop_reason, 'no_progress');
  assert.equal(r.calls.length, 2);
});

test('new date data without a new shortcode counts as useful profile progress', async () => {
  const initial = incompleteProfile([], {links: [link('A')]});
  const nowDated = incompleteProfile([post('A')]);
  const finished = profile([post('B')], {profile: {username: 'test.creator', totalCount: 2, isPrivate: false}});
  const r = reader([initial, nowDated, finished], {A: detail(post('A', null))});
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS, maxPages: 3}, r);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'OK']);
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'post', 'scroll', 'scroll']);
});

test('scan progress and terminal diagnostics use only bounded counters and fixed reasons', async () => {
  const events = [], progress = [];
  const r = reader([incompleteProfile(oldBoundary())]);
  await collectInstagramPage(ACCOUNT, {...OPTIONS,
    onProgress: event => progress.push(event), onDiagnostic: (event, data) => events.push({event, data})}, r);
  assert.deepEqual(progress.at(-1), {stage: 'scan', pages: 1, details: 0, discovered: 4, posts: 1, stopReason: 'recent_boundary'});
  assert.deepEqual(events, [{event: 'scan.completed', data: {pageCount: 1, detailCount: 0, postCount: 1, reason: 'recent_boundary'}}]);
  assert.doesNotMatch(JSON.stringify({progress, events}), /test\.creator|Visible caption|https:|Creator|shortcode/);
});

test('cancelled incremental reads retain prior detail hits and a final cancelled diagnostic', async () => {
  const controller = new AbortController(), events = [];
  const r = reader([incompleteProfile([], {links: [link('A'), link('B')]})], {
    A: () => { controller.abort(); return detail(post('A')); }
  });
  await assert.rejects(collectInstagramPage(ACCOUNT, {...OPTIONS, signal: controller.signal,
    onDiagnostic: (event, data) => events.push({event, data})}, r), error => {
    assert.equal(error.code, 'CANCELLED'); assert.equal(error.partialRows.length, 1); return true;
  });
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'post']);
  assert.deepEqual(events, [{event: 'scan.completed', data: {pageCount: 1, detailCount: 1, postCount: 1, reason: 'cancelled'}}]);
});

test('progress and diagnostic callback failures cannot change valid results', async () => {
  const rows = await collectInstagramPage(ACCOUNT, {...OPTIONS,
    onProgress() { throw new Error('render failed'); }, onDiagnostic() { throw new Error('log failed'); }}, reader([profile()]));
  assert.deepEqual(rows.map(row => row.status), ['OK']);
});

test('a late profile response saves the remaining detail visits after the first detail is read', async () => {
  const initial = profile([], {links: ['A', 'B', 'C'].map(code => link(code)),
    profile: {username: 'test.creator', totalCount: 3, isPrivate: false}});
  const r = reader([initial], {A: detail(post('A'))}); let refreshes = 0;
  r.refreshProfile = async () => { refreshes++; return profile([post('A'), post('B'), post('C')]); };
  const rows = await collectInstagramPage(ACCOUNT, OPTIONS, r);
  assert.equal(rows.filter(row => row.status === 'OK').length, 3);
  assert.deepEqual(r.calls.map(call => call[0]), ['profile', 'post']); assert.equal(refreshes, 1);
});
