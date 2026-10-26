import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseYouTubeVideoURL, parseVideoInputs, channelInput} from '../extension/lib/youtube-input.mjs';
import {collectYouTubeComments} from '../extension/lib/youtube-comments.mjs';
import {collectYouTubeTarget, createVideoLookup} from '../extension/lib/youtube-collection.mjs';
import {KEYWORD_FILTERS} from '../extension/lib/youtube-search.mjs';
import {collectYouTube} from '../extension/lib/youtube.mjs';
import {runAccounts} from '../extension/lib/jobs.mjs';
import {createYouTubeRequest} from '../extension/lib/transport.mjs';
import {createVideoTemplate, loadVideoAccounts, readWorkbook, createResultsWorkbook, createVideoResultsWorkbook, summarize} from '../extension/lib/workbook.mjs';
import {sanitizeSettings} from '../extension/lib/preferences.mjs';

globalThis.XLSX = createRequire(import.meta.url)('../extension/vendor/xlsx.full.min.js');
const id = i => String(i).padStart(11, '0');
const channelId = 'UC' + 'A'.repeat(22), timestamp = '2026-10-20T12:00:00Z';
const opts = {targetDates: ['2026-10-20'], timeZone: 'UTC', youtubeLimit: 100, youtubeRange: 'dates'};
const target = mode => ({row_no: 1, name: 'fixture', url: mode === 'videos' ? `https://youtu.be/${id(1)}` : `https://www.youtube.com/channel/${channelId}`,
  platform: 'youtube', youtubeMode: mode, query: 'fixture query'});
const video = (value, publishedAt = timestamp) => ({id: value, snippet: {title: '视频标题', description: '独立简介\n第二行', publishedAt, channelId, channelTitle: '测试频道'}, statistics: {viewCount: '20', likeCount: '3', commentCount: '300'}, contentDetails: {duration: 'PT5M'}});

test('channel and keyword limits accept 1–100 and reject all larger or invalid values before API calls', async () => {
  for (const mode of ['channel', 'keyword']) for (const limit of [0, 101, 1000, 1.5, NaN]) {
    await assert.rejects(collectYouTubeTarget(target(mode), {...opts, youtubeLimit: limit}, () => assert.fail('invalid limit made an API request')),
      error => error.code === 'YT_INPUT');
  }
  assert.deepEqual(sanitizeSettings({youtubeLimit: 100}), {youtubeLimit: 100});
  assert.deepEqual(sanitizeSettings({youtubeLimit: 1}), {youtubeLimit: 1});
  assert.deepEqual(sanitizeSettings({youtubeLimit: 1000}), {});
});

test('channel and keyword collection stop at 100 videos without fetching a third list page', async () => {
  for (const mode of ['channel', 'keyword']) {
    let pages = 0;
    const rows = await collectYouTubeTarget(target(mode), opts, async (endpoint, params) => {
      if (endpoint === 'channels') return {items: [{id: channelId, contentDetails: {relatedPlaylists: {uploads: 'UU_fixture'}}, statistics: {subscriberCount: '3'}}]};
      if (endpoint === 'videos') return {items: params.id.split(',').map(value => video(value))};
      assert.ok(['search', 'playlistItems'].includes(endpoint));
      assert.ok(++pages <= 2, 'must not fetch beyond 100 videos');
      const items = Array.from({length: 50}, (_, i) => {
        const value = id((pages - 1) * 50 + i + 1);
        return mode === 'keyword' ? {id: {videoId: value}, snippet: {title: 'video', publishedAt: timestamp}}
          : {contentDetails: {videoId: value, videoPublishedAt: timestamp}, snippet: {title: 'video'}};
      });
      return {items, nextPageToken: 'page-' + pages};
    });
    assert.equal(rows.filter(row => row.status === 'OK').length, 100);
    assert.equal(rows.at(-1).error_code, 'YT_INCOMPLETE'); assert.equal(pages, 2);
  }
});
const comment = (value, parentId = '') => ({id: value, snippet: {authorDisplayName: '用户 ' + value, textDisplay: '内容 ' + value, publishedAt: timestamp, ...(parentId ? {parentId} : {}), likeCount: 2}});
const thread = (value, count = 0, replies = []) => ({snippet: {topLevelComment: comment(value), totalReplyCount: count}, replies: {comments: replies}});
const channel = () => ({items: [{id: channelId, snippet: {title: '频道'}, contentDetails: {relatedPlaylists: {uploads: 'UU-fixture'}}, statistics: {subscriberCount: '20'}}]});
const playlistItem = (value, published = timestamp) => ({contentDetails: {videoId: value, videoPublishedAt: published}, snippet: {title: '列表标题'}});
const err = code => Object.assign(new Error('fixture failure'), {code});

test('video URLs normalize formats and reject channel links, deceptive hosts, credentials and invalid IDs', () => {
  for (const url of [`youtube.com/watch?v=${id(1)}&list=ignored`, `http://youtu.be/${id(1)}?t=5`, `https://m.youtube.com/shorts/${id(1)}`, `https://youtube.com/live/${id(1)}`, `https://youtube.com/embed/${id(1)}`]) {
    assert.deepEqual(parseYouTubeVideoURL(url), {id: id(1), url: `https://www.youtube.com/watch?v=${id(1)}`});
  }
  for (const url of ['https://youtube.com/@channel', 'https://youtube.com/playlist?list=test', 'https://youtube.com.evil.example/watch?v=00000000001', 'https://user:password@youtube.com/watch?v=00000000001', 'https://youtube.com:8080/watch?v=00000000001', 'javascript:alert(1)', 'https://youtu.be/short']) assert.throws(() => parseYouTubeVideoURL(url));
  assert.throws(() => channelInput(`https://youtube.com/watch?v=${id(1)}`));
  assert.equal(channelInput('youtube.com/@creator/videos'), 'https://youtube.com/@creator/videos');
});

test('pasted and uploaded videos preserve rows, accept hyperlinks, and deduplicate equivalent URLs', () => {
  const parsed = parseVideoInputs(`\nhttps://youtu.be/${id(1)}\nhttps://youtube.com/watch?v=${id(1)}\ninvalid\nhttps://youtube.com/shorts/${id(2)}`);
  assert.deepEqual(parsed.accounts.map(a => a.row_no), [2, 5]); assert.equal(parsed.warnings.length, 2);
  const wb = createVideoTemplate(); assert.equal(loadVideoAccounts(wb).accounts.length, 0);
  wb.Sheets['视频清单'].A2 = {t: 's', v: '视频链接', l: {Target: `https://youtu.be/${id(1)}`}};
  wb.Sheets['视频清单'].B2 = {t: 's', v: '=literal note'};
  const actual = loadVideoAccounts(readWorkbook(XLSX.write(wb, {type: 'array', bookType: 'xlsx'}), 'filled.xlsx'));
  assert.equal(actual.accounts[0].url, `https://www.youtube.com/watch?v=${id(1)}`); assert.equal(actual.accounts[0].note, '=literal note');
  const csv = readWorkbook(new TextEncoder().encode(`视频链接\nhttps://youtu.be/${id(1)}\nhttps://youtube.com/shorts/${id(1)}\n`), 'input.csv');
  assert.equal(loadVideoAccounts(csv).accounts.length, 1); assert.equal(loadVideoAccounts(csv).warnings.length, 1);
});

test('video mode reads only the requested video, separate description and 300 comments across three pages', async () => {
  const calls = [], saved = [];
  const rows = await collectYouTubeTarget(target('videos'), {...opts, onCheckpoint: rows => saved.push(structuredClone(rows))}, async (endpoint, params) => {
    calls.push(endpoint);
    if (endpoint === 'videos') { assert.equal(params.id, id(1)); return {items: [video(id(1))]}; }
    assert.equal(endpoint, 'commentThreads'); assert.equal(params.textFormat, 'plainText');
    const page = Number(params.pageToken || 0);
    return {items: Array.from({length: 100}, (_, i) => thread('root-' + (page * 100 + i))), ...(page < 2 ? {nextPageToken: String(page + 1)} : {})};
  });
  assert.equal(rows[0].post_description, '独立简介\n第二行'); assert.equal(rows[0].post_title, '视频标题');
  assert.equal(rows[0].comments.length, 300); assert.equal(rows[0].comments_status, 'COMPLETE');
  assert.equal(calls.length, 4); assert.ok(saved.some(rows => rows[0].comments.length === 100));
});

test('partial embedded replies are completed with every page and deduplicated by comment ID', async () => {
  const replies = Array.from({length: 205}, (_, i) => comment('reply-' + i, 'root')); let requests = 0;
  const comments = await collectYouTubeComments(id(1), async (endpoint, params) => {
    if (endpoint === 'commentThreads') return {items: [thread('root', 205, replies.slice(0, 1))]};
    assert.equal(params.parentId, 'root'); requests++; const page = Number(params.pageToken || 0);
    return {items: replies.slice(page * 100, (page + 1) * 100), ...(page < 2 ? {nextPageToken: String(page + 1)} : {})};
  });
  assert.equal(comments.length, 206); assert.equal(requests, 3); assert.ok(comments.slice(1).every(c => c.parent_id === 'root'));
});

test('fully embedded replies need no extra request and fewer replies than reported means incomplete', async () => {
  let calls = 0;
  const complete = await collectYouTubeComments(id(1), async () => { calls++; return {items: [thread('root', 1, [comment('reply', 'root')])]}; });
  assert.equal(calls, 1); assert.equal(complete.length, 2);
  await assert.rejects(collectYouTubeComments(id(1), async endpoint => endpoint === 'commentThreads' ? {items: [thread('root', 2)]} : {items: [comment('reply', 'root')]}), e => e.code === 'YT_COMMENTS_INCOMPLETE' && e.partialComments.length === 2);
});

test('repeated comment cursors, protection limits and foreign-parent replies cannot appear complete', async () => {
  await assert.rejects(collectYouTubeComments(id(1), async () => ({items: [thread('root')], nextPageToken: 'repeat'})), /游标重复/);
  await assert.rejects(collectYouTubeComments(id(1), async () => ({items: [thread('a'), thread('b')]}), {maxComments: 1}), e => e.partialComments.length === 1);
  await assert.rejects(collectYouTubeComments(id(1), async endpoint => endpoint === 'commentThreads' ? {items: [thread('a', 1)]} : {items: [comment('b', 'foreign')]}), /所属主评论/);
});

test('cancellation retains video and fetched comments without scheduling the next page', async () => {
  const controller = new AbortController(); let calls = 0;
  const rows = await runAccounts([target('videos')], opts, {youtube: (a, o) => collectYouTubeTarget(a, {...o, signal: controller.signal,
    onCheckpoint: rows => { if (rows[0]?.comments?.length) controller.abort(); }}, async endpoint => {
      calls++; return endpoint === 'videos' ? {items: [video(id(1))]} : {items: [thread('root')], nextPageToken: 'p2'};
    })}, {signal: controller.signal});
  assert.equal(calls, 2); assert.equal(rows[0].status, 'OK'); assert.equal(rows[0].comments.length, 1);
  assert.equal(rows[0].comments_status, 'PARTIAL'); assert.equal(rows.at(-1).error_code, 'CANCELLED');
});

test('closed comments do not discard video data or suppress subsequent videos', async () => {
  const accounts = [target('videos'), {...target('videos'), row_no: 2, url: `https://youtu.be/${id(2)}`}];
  const rows = await runAccounts(accounts, opts, {youtube: (a, o) => collectYouTubeTarget(a, o, async (endpoint, params) => {
    if (endpoint === 'videos') return {items: [video(params.id)]};
    if (params.videoId === id(1)) throw err('YT_COMMENTS_DISABLED'); return {items: []};
  })});
  assert.deepEqual(rows.map(row => row.comments_status), ['DISABLED', 'COMPLETE']); assert.ok(rows.every(row => row.status === 'OK'));
});

test('transport distinguishes closed comments from permission, key and quota failures', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let reason = 'commentsDisabled';
  globalThis.fetch = async url => { assert.equal(new URL(url).searchParams.get('key'), 'test-key'); return {ok: false, status: 403, json: async () => ({error: {errors: [{reason}]}})}; };
  const request = createYouTubeRequest('test-key');
  await assert.rejects(request('commentThreads', {}), e => e.code === 'YT_COMMENTS_DISABLED');
  reason = 'forbidden'; await assert.rejects(request('comments', {}), e => e.code === 'YT_COMMENTS_UNAVAILABLE');
  reason = 'quotaExceeded'; await assert.rejects(request('comments', {}), e => e.code === 'RATE_LIMIT');
  reason = 'keyInvalid'; await assert.rejects(request('search', {}), e => e.code === 'AUTH');
});

test('50-video lookup batching preserves the first batch when the second batch hits quota', async () => {
  const accounts = Array.from({length: 51}, (_, i) => ({...target('videos'), row_no: i + 1, url: `https://youtu.be/${id(i + 1)}`})); let batches = 0;
  const request = async (endpoint, params) => {
    if (endpoint === 'commentThreads') return {items: []}; assert.equal(endpoint, 'videos');
    if (++batches === 2) throw err('RATE_LIMIT'); return {items: params.id.split(',').map(value => video(value))};
  };
  const videoLookup = createVideoLookup(accounts, request);
  const rows = await runAccounts(accounts, opts, {youtube: (a, o) => collectYouTubeTarget(a, {...o, videoLookup}, request)});
  assert.equal(batches, 2); assert.equal(rows.filter(r => r.status === 'OK').length, 50); assert.equal(rows.at(-1).error_code, 'YT_QUOTA');
});

test('legacy collector also retains successful detail batches on a later quota failure', async () => {
  let pages = 0, batches = 0; const account = {...target('channel')}; delete account.youtubeMode;
  const rows = await runAccounts([account], {...opts, maxPages: 3}, {youtube: (a, o) => collectYouTube(a, o, async (endpoint, params) => {
    if (endpoint === 'channels') return channel();
    if (endpoint === 'playlistItems') return ++pages === 1 ? {items: Array.from({length: 50}, (_, i) => playlistItem(id(i + 1))), nextPageToken: 'p2'} : {items: [playlistItem(id(51))]};
    if (++batches === 2) throw err('RATE_LIMIT'); return {items: params.id.split(',').map(value => video(value))};
  })});
  assert.equal(rows.filter(r => r.status === 'OK').length, 50);
});

test('all-date channels reach the final page instead of treating three old videos as complete', async () => {
  let pages = 0;
  const rows = await collectYouTubeTarget(target('channel'), {...opts, youtubeRange: 'all', targetDates: []}, async (endpoint, params) => {
    if (endpoint === 'channels') return channel();
    if (endpoint === 'playlistItems') return ++pages === 1 ? {items: [1, 2, 3].map(i => playlistItem(id(i), '2020-01-01T00:00:00Z')), nextPageToken: 'p2'} : {items: [playlistItem(id(4))]};
    return {items: params.id.split(',').map(value => video(value))};
  });
  assert.equal(pages, 2); assert.equal(rows.length, 4); assert.ok(rows.every(r => r.status === 'OK'));
});

test('channel caps retain data, mark partial completion and share the run budget across targets', async () => {
  const budget = {remaining: 1};
  const request = async (endpoint, params) => endpoint === 'channels' ? channel() : endpoint === 'playlistItems' ? {items: [playlistItem(id(1)), playlistItem(id(2))]} : {items: params.id.split(',').map(value => video(value))};
  const rows = await collectYouTubeTarget(target('channel'), {...opts, videoBudget: budget}, request);
  assert.equal(rows.filter(r => r.status === 'OK').length, 1); assert.equal(rows.at(-1).error_code, 'YT_INCOMPLETE'); assert.equal(budget.remaining, 0);
  assert.equal(createResultsWorkbook(rows).Sheets['采集结果'].F3.v, '待核对');
  await assert.rejects(collectYouTubeTarget(target('channel'), {...opts, videoBudget: budget}, () => assert.fail('budget exhausted')), e => e.code === 'YT_INCOMPLETE');
});

for (const filter of ['all', 'recent', 'live']) test(`keyword ${filter} maps to API filters without date bounds or comment requests`, async () => {
  const rows = await collectYouTubeTarget(target('keyword'), {...opts, youtubeSearchFilter: filter}, async (endpoint, params) => {
    if (endpoint === 'search') {
      assert.equal(params.q, 'fixture query'); assert.equal(params.type, 'video');
      assert.equal(params.publishedAfter, undefined); assert.equal(params.publishedBefore, undefined);
      assert.equal(params.order, filter === 'recent' ? 'date' : 'relevance');
      assert.equal(params.eventType, filter === 'live' ? 'live' : undefined);
      return {items: [{id: {videoId: id(1)}, snippet: {publishedAt: '2020-01-01T00:00:00Z'}}]};
    }
    assert.equal(endpoint, 'videos'); assert.equal(params.id, id(1)); return {items: [video(id(1), '2020-01-01T00:00:00Z')]};
  });
  assert.equal(rows.length, 1); assert.equal(rows[0].source_query, 'fixture query'); assert.equal(rows[0].comments, undefined);
  assert.equal(rows[0].target_date, '关键词搜索（不限日期）');
  assert.deepEqual(sanitizeSettings({youtubeSearchFilter: filter}), {youtubeSearchFilter: filter});
});

test('unsupported keyword filters fail before API calls and cannot enter saved settings', async () => {
  assert.deepEqual(Object.keys(KEYWORD_FILTERS), ['all', 'recent', 'live']);
  for (const filter of ['shorts', 'watched', 'unwatched', '__proto__']) {
    await assert.rejects(collectYouTubeTarget(target('keyword'), {...opts, youtubeSearchFilter: filter}, () => assert.fail('unsupported filter made a request')),
      error => error.code === 'YT_INPUT');
    assert.deepEqual(sanitizeSettings({youtubeSearchFilter: filter}), {});
  }
});

test('failed keyword details still export discovered titles and video links', async () => {
  const rows = await runAccounts([target('keyword')], opts, {youtube: (a, o) => collectYouTubeTarget(a, o, async endpoint => {
    if (endpoint === 'search') return {items: [{id: {videoId: id(1)}, snippet: {publishedAt: timestamp, title: '已发现标题'}}]}; throw err('RATE_LIMIT');
  })});
  assert.equal(rows[0].post_title, '已发现标题'); assert.equal(rows[0].post_url, `https://www.youtube.com/watch?v=${id(1)}`); assert.equal(rows[0].error_code, 'YT_DETAIL_PENDING');
});

test('Excel separates descriptions, groups replies and keeps user text literal', () => {
  const rows = [{row_no: 1, platform: 'youtube', status: 'OK', post_url: `https://youtu.be/${id(1)}`, post_title: '=标题', post_description: '=简介\n换行', comments_status: 'PARTIAL', comments: [
    {id: 'a', parent_id: '', author: '=用户名', text: '=主评论', type: '主评论'}, {id: 'b', parent_id: 'a', author: '回复用户', text: '@对方 回复', type: '回复'}]}];
  const generated = createVideoResultsWorkbook(rows);
  const wb = readWorkbook(XLSX.write(generated, {type: 'array', bookType: 'xlsx'}), 'results.xlsx');
  assert.deepEqual(wb.SheetNames, ['采集结果', '评论详情', '待人工核对', '本次运行信息']);
  assert.equal(generated.Sheets['采集结果']['!cols'].length, 25);
  assert.equal(wb.Sheets['采集结果']['!autofilter'].ref, 'A1:Y2');
  assert.equal(wb.Sheets['采集结果'].G2.v, '=标题');
  assert.equal(wb.Sheets['采集结果'].R2.v, '=简介\n换行'); assert.equal(wb.Sheets['评论详情'].C2.v, '=用户名'); assert.equal(wb.Sheets['评论详情'].C2.f, undefined);
  assert.equal(wb.Sheets['评论详情'].F3.v, '=主评论'); assert.equal(wb.Sheets['评论详情'].J3.v, 'a'); assert.equal(summarize(rows).failedAccounts, 1);
});

test('video URL reports retain description and comment headers when no comments are available', () => {
  for (const rows of [[], [{platform: 'youtube', status: 'OK', comments_status: 'DISABLED'}]]) {
    const wb = createVideoResultsWorkbook(rows);
    assert.equal(wb.Sheets['采集结果'].R1.v, '视频简介');
    assert.equal(wb.Sheets['评论详情'].D1.v, '评论内容');
    assert.equal(wb.Sheets['评论详情']['!ref'], 'A1:K1');
  }
});
