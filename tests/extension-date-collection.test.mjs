import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDates} from '../extension/lib/jobs.mjs';
import {collectInstagramPage} from '../extension/lib/instagram-page.mjs';
import {collectYouTube} from '../extension/lib/youtube.mjs';

const CHANNEL_ID = 'UC' + 'A'.repeat(22);
const INSTAGRAM = {row_no: 2, name: 'Calendar fixture', platform: 'instagram', url: 'https://www.instagram.com/calendar.fixture/'};
const YOUTUBE = {row_no: 3, name: 'Calendar fixture', platform: 'youtube', url: `https://www.youtube.com/channel/${CHANNEL_ID}`};
const IDS = ['AFTER000001', 'LAST0000001', 'MIDDLE00001', 'FIRST000001', 'BEFORE00001'];
const SELECTED_IDS = ['LAST0000001', 'MIDDLE00001', 'FIRST000001'];

// Timestamps and expected local times are explicit fixtures, not calculated by
// the date-selection or collector helpers under test. Each list is complete and
// has one publication immediately outside either selected calendar boundary.
const CASES = [
  {
    name: 'London Q1 includes both boundaries across the spring clock change',
    selection: {dateMode: 'quarter', quarterYear: 2026, quarter: 1, timeZone: 'Europe/London'},
    dayCount: 90, label: '2026-01-01 至 2026-03-31',
    timestamps: ['2026-03-31T23:00:00Z', '2026-03-31T22:59:59Z', '2026-03-29T01:30:00Z',
      '2026-01-01T00:00:00Z', '2025-12-31T23:59:59Z'],
    localTimes: ['2026-03-31 23:59:59', '2026-03-29 02:30:00', '2026-01-01 00:00:00'],
  },
  {
    name: 'London leap-year Q1 retains February 29 and the full 91-day quarter',
    selection: {dateMode: 'quarter', quarterYear: 2024, quarter: 1, timeZone: 'Europe/London'},
    dayCount: 91, label: '2024-01-01 至 2024-03-31',
    timestamps: ['2024-03-31T23:00:00Z', '2024-03-31T22:59:59Z', '2024-02-29T12:00:00Z',
      '2024-01-01T00:00:00Z', '2023-12-31T23:59:59Z'],
    localTimes: ['2024-03-31 23:59:59', '2024-02-29 12:00:00', '2024-01-01 00:00:00'],
  },
  {
    name: 'London August selects local midnight even when its UTC date is July',
    selection: {dateMode: 'month', targetMonth: '2026-08', timeZone: 'Europe/London'},
    dayCount: 31, label: '2026-08-01 至 2026-08-31',
    timestamps: ['2026-08-31T23:00:00Z', '2026-08-31T22:59:59Z', '2026-08-15T12:00:00Z',
      '2026-07-31T23:00:00Z', '2026-07-31T22:59:59Z'],
    localTimes: ['2026-08-31 23:59:59', '2026-08-15 13:00:00', '2026-08-01 00:00:00'],
  },
  {
    name: 'Shanghai custom range crosses the year and includes its last second',
    selection: {dateMode: 'range', startDate: '2026-12-31', endDate: '2027-01-01', timeZone: 'Asia/Shanghai'},
    dayCount: 2, label: '2026-12-31 至 2027-01-01',
    timestamps: ['2027-01-01T16:00:00Z', '2027-01-01T15:59:59Z', '2026-12-31T16:00:00Z',
      '2026-12-30T16:00:00Z', '2026-12-30T15:59:59Z'],
    localTimes: ['2027-01-01 23:59:59', '2027-01-01 00:00:00', '2026-12-31 00:00:00'],
  },
];

function optionsFor(fixture) {
  // The full Q1/month/custom range is selected even before its final day.
  const targetDates = resolveDates(fixture.selection, new Date('2024-01-15T12:00:00Z'));
  assert.equal(targetDates.length, fixture.dayCount);
  return {targetDates, timeZone: fixture.selection.timeZone, maxPages: 1, maxPosts: 5};
}

function instagramReader(fixture) {
  const calls = [];
  const posts = fixture.timestamps.map((time, index) => ({
    shortcode: IDS[index], url: `https://www.instagram.com/p/${IDS[index]}/`,
    ts: Date.parse(time) / 1000, caption: IDS[index], type: '图片', likes: 0, comments: 0,
    owner: 'calendar.fixture', source: 'embedded', pinned: false,
  }));
  return {
    calls,
    async openProfile(username) {
      calls.push('profile');
      assert.equal(username, 'calendar.fixture');
      return {
        url: INSTAGRAM.url, kind: 'profile', state: 'ready', source: 'embedded',
        profile: {username: 'calendar.fixture', followers: 10, totalCount: posts.length, isPrivate: false},
        posts, links: posts.map(({shortcode, url}) => ({shortcode, url})), timeline: {complete: true},
      };
    },
    async scrollProfile() { assert.fail('A complete profile must not need another page'); },
    async openPost() { assert.fail('Complete dates and metrics must not need detail requests'); },
  };
}

function youtubeRequest(fixture) {
  const calls = [];
  return {
    calls,
    async request(endpoint, params) {
      calls.push(endpoint);
      if (endpoint === 'channels') {
        assert.equal(params.id, CHANNEL_ID);
        return {items: [{id: CHANNEL_ID, contentDetails: {relatedPlaylists: {uploads: 'UU_FIXTURE'}},
          statistics: {subscriberCount: '10'}}]};
      }
      if (endpoint === 'playlistItems') {
        assert.equal(params.playlistId, 'UU_FIXTURE');
        assert.equal(params.pageToken, undefined);
        return {items: fixture.timestamps.map((time, index) => ({
          contentDetails: {videoId: IDS[index], videoPublishedAt: time},
          // Deliberately unrelated: collection must use video publication time.
          snippet: {title: IDS[index], publishedAt: '2027-06-01T12:00:00Z'},
        }))};
      }
      assert.equal(endpoint, 'videos');
      // Out-of-range videos must be filtered before spending a detail request.
      assert.deepEqual(params.id.split(','), SELECTED_IDS);
      return {items: SELECTED_IDS.map(id => ({id, snippet: {title: id},
        statistics: {viewCount: '0', likeCount: '0', commentCount: '0'}, contentDetails: {duration: 'PT5M'}}))};
    },
  };
}

function assertSelectedRows(rows, fixture, platform) {
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.status), ['OK', 'OK', 'OK']);
  assert.deepEqual(rows.map(row => row.post_title), SELECTED_IDS);
  assert.deepEqual(rows.map(row => row.published_local), fixture.localTimes);
  assert.ok(rows.every(row => row.target_date === fixture.label && row.platform === platform));
  assert.ok(rows.every(row => row.like_count === 0 && row.comment_count === 0));
}

for (const fixture of CASES) {
  test(`Instagram resolved-date collection: ${fixture.name}`, async () => {
    const reader = instagramReader(fixture);
    const rows = await collectInstagramPage(INSTAGRAM, optionsFor(fixture), reader);
    assertSelectedRows(rows, fixture, 'instagram');
    assert.deepEqual(rows.map(row => row.post_url), SELECTED_IDS.map(id => `https://www.instagram.com/p/${id}/`));
    assert.deepEqual(reader.calls, ['profile']);
  });

  test(`YouTube resolved-date collection: ${fixture.name}`, async () => {
    const {request, calls} = youtubeRequest(fixture);
    const rows = await collectYouTube(YOUTUBE, optionsFor(fixture), request);
    assertSelectedRows(rows, fixture, 'youtube');
    assert.deepEqual(rows.map(row => row.post_url), SELECTED_IDS.map(id => `https://www.youtube.com/watch?v=${id}`));
    assert.deepEqual(calls, ['channels', 'playlistItems', 'videos']);
  });
}
