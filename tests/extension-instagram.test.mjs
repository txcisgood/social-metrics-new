import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInstagram, RateLimitError, AuthError, FetchError} from '../edge-extension/lib/instagram.mjs';

const ACCOUNT = {row_no: 2, name: 'Example creator', url: 'https://www.instagram.com/test.creator/', platform: 'instagram', note: ''};
const OPTIONS = {targetDates: ['2026-08-29'], timeZone: 'Europe/London', maxPages: 5};
const timestamp = value => Date.parse(value) / 1000;

// Fixtures retain Instagram's profile GraphQL and feed JSON field shapes.
function profilePost(code = 'PROFILE_A', time = '2026-08-29T12:00:00Z', extras = {}) {
  return {
    __typename: 'GraphVideo', id: '12345678901234567', shortcode: code,
    taken_at_timestamp: timestamp(time), is_video: true, product_type: 'clips',
    video_play_count: 1800, edge_liked_by: {count: 50}, edge_media_to_comment: {count: 3},
    edge_media_to_caption: {edges: [{node: {text: 'A real-shaped fixture caption'}}]}, ...extras,
  };
}

function profile(posts = [profilePost()], {more = false, count = posts.length, user = {}} = {}) {
  return {status: 'ok', data: {user: {
    id: '1234567890', username: 'test.creator', is_private: false, edge_followed_by: {count: 1200},
    edge_owner_to_timeline_media: {
      count, page_info: {has_next_page: more, end_cursor: 'GRAPHQL_CURSOR_MUST_NOT_BE_REUSED'},
      edges: posts.map(node => ({node})),
    }, ...user,
  }}};
}

function feedPost(code = 'FEED_B', time = '2026-08-29T11:00:00Z', extras = {}) {
  return {
    pk: '22345678901234567', code, taken_at: timestamp(time), media_type: 2, product_type: 'clips',
    play_count: 2450, like_count: 81, comment_count: 9, caption: {text: 'Feed caption'}, ...extras,
  };
}

function feed(items = [feedPost()], more = false, cursor = null) {
  return {status: 'ok', items, more_available: more, next_max_id: cursor};
}

function requests(responses) {
  const calls = [];
  const request = async path => {
    const response = responses[calls.length];
    assert.ok(response, `Unexpected request: ${path}`);
    calls.push(path);
    if (response.path) assert.match(path, response.path);
    if (response.error) throw response.error;
    return {status: response.status ?? 200, text: response.text ?? JSON.stringify(response.body)};
  };
  return {request, calls};
}

test('profile fixture returns PostMetric fields, timezone dates and actual zero counts', async () => {
  const {request, calls} = requests([{body: profile([
    profilePost('MIDNIGHT', '2026-08-28T23:15:00Z', {
      video_play_count: 0, video_view_count: 99, edge_liked_by: {count: 0}, edge_media_to_comment: {count: 0},
    }),
    profilePost('NEXT_DAY', '2026-08-29T23:15:00Z'),
  ])}]);
  const rows = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(calls.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].post_url, 'https://www.instagram.com/p/MIDNIGHT/');
  assert.equal(rows[0].published_local, '2026-08-29 00:15:00');
  assert.equal(rows[0].published_utc, '2026-08-28 23:15:00 UTC');
  assert.equal(rows[0].view_count, 0);
  assert.equal(rows[0].like_count, 0);
  assert.equal(rows[0].comment_count, 0);
  assert.equal(rows[0].follower_count, 1200);
  assert.equal(rows[0].post_type, 'Reels');
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'row_no', 'account_name', 'platform', 'profile_url', 'target_date', 'status', 'post_title', 'post_url',
    'published_local', 'published_utc', 'post_type', 'view_count', 'like_count', 'comment_count',
    'follower_count', 'channel_id', 'fetched_at', 'error', 'extra',
  ].sort());
});

test('London DST spring boundary uses local calendar date', async () => {
  const {request} = requests([{body: profile([
    profilePost('BEFORE', '2026-03-28T23:30:00Z'),
    profilePost('CHANGE', '2026-03-29T01:30:00Z'),
    profilePost('AFTER', '2026-03-29T23:15:00Z'),
  ])}]);
  const rows = await collectInstagram(ACCOUNT, {...OPTIONS, targetDates: ['2026-03-29']}, request);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].published_local, '2026-03-29 02:30:00');
});

test('400 profile fallback resolves username ID and parses feed fixture', async () => {
  const {request, calls} = requests([
    {status: 400, body: {status: 'fail', message: 'profile information unavailable'}},
    {path: /\/users\/test\.creator\/usernameinfo\/$/, body: {status: 'ok', user: {
      pk: 987654321, username: 'test.creator', is_private: false, follower_count: 333, media_count: 1,
    }}},
    {path: /\/feed\/user\/987654321\/\?count=50$/, body: feed([feedPost('CAROUSEL', undefined, {
      media_type: 8, product_type: 'carousel_container', play_count: undefined, like_count: -1,
      comment_count: undefined, caption: null,
    })])},
  ]);
  const [row] = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(calls.length, 3);
  assert.equal(row.status, 'OK');
  assert.equal(row.follower_count, 333);
  assert.equal(row.post_type, '图文轮播');
  assert.equal(row.post_title, '（无文字）');
  assert.equal(row.view_count, '');
  assert.equal(row.like_count, '未公开或不可用');
  assert.equal(row.comment_count, '未公开或不可用');
});

test('profile ID avoids user lookup; feed starts at page one and encoded cursors deduplicate', async () => {
  const {request, calls} = requests([
    {body: profile([profilePost('A')], {more: true, count: 20})},
    {path: /\/1234567890\/\?count=50$/, body: feed([
      feedPost('A', '2026-08-29T12:00:00Z', {like_count: undefined, caption: null, product_type: undefined}),
      feedPost('B'),
    ], true, 'a+b/==')},
    {path: /max_id=a%2Bb%2F%3D%3D$/, body: feed([
      feedPost('B'), feedPost('OLD', '2026-08-28T12:00:00Z'),
    ], true, 'unused')},
  ]);
  const rows = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(calls.length, 3);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.post_url.endsWith('/A/')).like_count, 50);
  assert.equal(rows.find(row => row.post_url.endsWith('/A/')).post_type, 'Reels');
  assert.equal(rows[0].follower_count, 1200);
  assert.ok(calls.every(path => !path.includes('GRAPHQL_CURSOR') && !path.includes('usernameinfo')));
});

test('old pinned profile posts do not establish date coverage', async () => {
  const {request, calls} = requests([
    {body: profile([
      profilePost('PIN', '2026-01-01T12:00:00Z', {pinned_for_users: [{id: '1234567890'}]}),
      profilePost('A'),
    ], {more: true, count: 20})},
    {body: feed([feedPost('B')], false)},
  ]);
  const rows = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 2);
});

test('out-of-order unpinned page does not stop at an isolated old post', async () => {
  const {request, calls} = requests([
    {body: profile([profilePost('OLD', '2026-01-01T12:00:00Z'), profilePost('A')], {more: true})},
    {body: feed([feedPost('B')], false)},
  ]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request)).length, 2);
  assert.equal(calls.length, 2);
});

test('confirmed public zero-post profile can return NO_POST', async () => {
  const {request, calls} = requests([{body: profile([])}]);
  const [row] = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(row.status, 'NO_POST');
  assert.equal(calls.length, 1);
});

test('private empty profile fails instead of NO_POST', async () => {
  const {request, calls} = requests([{body: profile([], {user: {is_private: true}})}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /私密账号/);
  assert.equal(calls.length, 1);
});

test('empty profile with positive count is not confirmed absence', async () => {
  const {request} = requests([{body: profile([], {count: 10})}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /无法确认/);
});

test('empty feed without public zero-post metadata is not confirmed absence', async () => {
  const {request} = requests([
    {status: 400, body: {}}, {body: {user: {pk: '999'}}}, {body: feed([])},
  ]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /无法确认/);
});

test('empty feed with confirmed public zero-post metadata returns NO_POST', async () => {
  const {request} = requests([
    {status: 400, body: {}}, {body: {user: {pk: '999', is_private: false, media_count: 0}}},
    {body: feed([])},
  ]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request))[0].status, 'NO_POST');
});

test('feed may end with an empty terminal page after posts were collected', async () => {
  const {request} = requests([
    {body: profile([profilePost('A')], {more: true})},
    {body: feed([feedPost('B')], true, 'next')},
    {body: feed([], false)},
  ]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request)).length, 2);
});

test('missing feed pagination state without date coverage fails', async () => {
  const {request} = requests([
    {body: profile([profilePost('A')], {more: true})},
    {body: {status: 'ok', items: [feedPost('B')]}},
  ]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /游标/);
});

test('missing pagination state is acceptable when chronological old posts prove coverage', async () => {
  const body = profile([profilePost('OLD', '2026-08-28T12:00:00Z', {pinned_for_users: []})]);
  delete body.data.user.edge_owner_to_timeline_media.page_info;
  const {request} = requests([{body}]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request))[0].status, 'NO_POST');
});

test('missing profile pagination state does not discard in-window posts during feed fallback', async () => {
  const body = profile([profilePost('A')]);
  delete body.data.user.edge_owner_to_timeline_media.page_info;
  const {request} = requests([{body}, {body: feed([feedPost('B')], false)}]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request)).length, 2);
});

test('page limit raises before returning partial OK rows or NO_POST', async () => {
  for (const time of ['2026-08-29T12:00:00Z', '2026-08-30T12:00:00Z']) {
    const {request, calls} = requests([{body: profile([profilePost('NEW', time)], {more: true})}]);
    await assert.rejects(collectInstagram(ACCOUNT, {...OPTIONS, maxPages: 1}, request), /最大分页数/);
    assert.equal(calls.length, 1);
  }
});

test('repeated feed cursor fails without requesting a repeated page', async () => {
  const {request, calls} = requests([
    {body: profile([profilePost('A')], {more: true})},
    {body: feed([feedPost('B')], true, 'repeated')},
    {body: feed([feedPost('C')], true, 'repeated')},
  ]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /游标/);
  assert.equal(calls.length, 3);
});

test('missing shortcode or timestamp never produces an apparently complete result', async () => {
  for (const bad of [{shortcode: ''}, {taken_at_timestamp: null}, {taken_at_timestamp: '2026-08-29'}, {taken_at_timestamp: -1}]) {
    const {request} = requests([{body: profile([profilePost('BAD', undefined, bad)])}]);
    await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /链接或发布时间/);
  }
});

test('unknown profile/feed structures fail instead of NO_POST', async () => {
  const malformedProfile = profile();
  malformedProfile.data.user.edge_owner_to_timeline_media.edges = null;
  const first = requests([{body: malformedProfile}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, first.request), /结构未知/);
  const second = requests([{body: profile([profilePost()], {more: true})}, {body: {status: 'ok'}}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, second.request), /结构未知/);
});

test('profile ID is reused when profile timeline is unavailable', async () => {
  const {request, calls} = requests([
    {body: {status: 'ok', data: {user: {id: '123', username: 'test.creator', edge_followed_by: {count: 400}}}}},
    {path: /\/feed\/user\/123\/\?count=50$/, body: feed()},
  ]);
  assert.equal((await collectInstagram(ACCOUNT, OPTIONS, request))[0].follower_count, 400);
  assert.equal(calls.length, 2);
});

test('429 at profile, identity lookup or feed throws platform stop error immediately', async () => {
  const sequences = [
    [{status: 429, text: '<html>Too many requests</html>'}],
    [{status: 400, body: {}}, {status: 429, body: {}}],
    [{body: profile([profilePost()], {more: true})}, {status: 429, body: {}}],
  ];
  for (const sequence of sequences) {
    const {request, calls} = requests(sequence);
    await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), error => error instanceof RateLimitError && error.code === 'RATE_LIMIT');
    assert.equal(calls.length, sequence.length);
  }
});

test('401/403 and login/challenge JSON throw AUTH rather than trying more endpoints', async () => {
  const responses = [
    {status: 401, body: {}}, {status: 403, text: ''},
    {body: {status: 'fail', message: 'login_required'}},
    {body: {status: 'fail', message: 'challenge_required', challenge: {url: '/challenge/'}}},
    {status: 400, body: {message: 'checkpoint_required'}},
    {text: '<html><form action="/accounts/login/">Password</form></html>'},
  ];
  for (const response of responses) {
    const {request, calls} = requests([response]);
    await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), error => error instanceof AuthError && error.code === 'AUTH');
    assert.equal(calls.length, 1);
  }
});

test('authentication failures in ID lookup and pagination stop immediately', async () => {
  const sequences = [
    [{status: 400, body: {}}, {status: 403, body: {}}],
    [{body: profile([profilePost()], {more: true})}, {body: {status: 'fail', message: 'login_required'}}],
  ];
  for (const sequence of sequences) {
    const {request, calls} = requests(sequence);
    await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), AuthError);
    assert.equal(calls.length, sequence.length);
  }
});

test('JSON rate-limit response stops the platform even with HTTP 200', async () => {
  const {request} = requests([{body: {status: 'fail', message: 'Please wait a few minutes before you try again.'}}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), RateLimitError);
});

test('missing metrics stay missing instead of being turned into zero', async () => {
  const body = profile([profilePost('MISSING', undefined, {
    video_play_count: undefined, edge_liked_by: undefined, edge_media_to_comment: undefined,
  })], {user: {edge_followed_by: null}});
  const {request} = requests([{body}]);
  const [row] = await collectInstagram(ACCOUNT, OPTIONS, request);
  assert.equal(row.like_count, '未公开或不可用');
  assert.equal(row.comment_count, '未公开或不可用');
  assert.equal(row.view_count, '');
  assert.equal(row.follower_count, '未公开或不可用');
});

test('wrong account identity fails before producing rows', async () => {
  const {request} = requests([{body: profile([profilePost()], {user: {username: 'someone.else'}})}]);
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, request), /账号.*不一致/);
});

test('cancellation from request propagates unchanged', async () => {
  const cancelled = new Error('User cancelled');
  cancelled.code = 'CANCELLED';
  await assert.rejects(collectInstagram(ACCOUNT, OPTIONS, async () => { throw cancelled; }), error => error === cancelled);
});

test('bad input is rejected before any request', async () => {
  let calls = 0;
  const request = async () => { calls += 1; throw new Error('must not request'); };
  for (const url of ['https://fakeinstagram.com/test/', 'https://www.instagram.com/p/ABC/', 'https://www.instagram.com/accounts/login/', 'not a url']) {
    await assert.rejects(collectInstagram({...ACCOUNT, url}, OPTIONS, request), FetchError);
  }
  for (const options of [{...OPTIONS, targetDates: []}, {...OPTIONS, targetDates: ['2026-02-30']}, {...OPTIONS, maxPages: 0}, {...OPTIONS, timeZone: 'invalid/timezone'}]) {
    await assert.rejects(collectInstagram(ACCOUNT, options, request), FetchError);
  }
  assert.equal(calls, 0);
});

test('unsorted non-contiguous dates retain each selected local day', async () => {
  const {request} = requests([{body: profile([
    profilePost('DAY_29'), profilePost('DAY_27', '2026-08-27T12:00:00Z'),
    profilePost('DAY_28', '2026-08-28T12:00:00Z'),
  ])}]);
  const rows = await collectInstagram(ACCOUNT, {...OPTIONS, targetDates: ['2026-08-29', '2026-08-27', '2026-08-29']}, request);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.target_date === '2026-08-27,2026-08-29'));
});
