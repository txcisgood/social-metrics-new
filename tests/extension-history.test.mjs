import test from 'node:test';
import assert from 'node:assert/strict';
import {historyRecord, HISTORY_LIMIT} from '../extension/lib/history.mjs';
import {collectionPlatform, exportFileTag} from '../extension/lib/format.mjs';

test('history captures results and run metadata without options, credentials, diagnostics or upload objects', () => {
  const run = {id: 'run-1', meta: {inputName: 'accounts.xlsx', 账号数: 1, 结束时间: '2026-10-27T00:00:00Z'},
    results: [{row_no: 2, platform: 'youtube', status: 'OK', post_description: '简介', comments: [{id: 'a', author: '用户名', text: '评论'}]}],
    youtubeKey: 'NOT_SAVED', options: {apiKey: 'NOT_SAVED'}, diagnostics: {secret: 'NOT_SAVED'}, file: {raw: 'NOT_SAVED'}};
  const record = historyRecord(run, 'youtube');
  assert.equal(HISTORY_LIMIT, 5);
  assert.equal(record.platform, 'YouTube'); assert.equal(record.commentCount, 1); assert.equal(record.targetCount, 1);
  assert.deepEqual(record.results, run.results); assert.equal(record.meta.inputName, 'accounts.xlsx');
  assert.equal(JSON.stringify(record).includes('NOT_SAVED'), false);
  run.results[0].comments[0].text = '后来修改'; run.meta.inputName = '后来修改';
  assert.equal(record.results[0].comments[0].text, '评论'); assert.equal(record.meta.inputName, 'accounts.xlsx');
});

test('partial and interrupted histories retain a truthful status and deduplicate target identities', () => {
  const record = historyRecord({id: 'partial', status: 'stopped', results: [
    {platform: 'youtube', row_no: 1, status: 'OK', comments_status: 'PARTIAL', comments: [{id: 'a'}]},
    {platform: 'youtube', row_no: 1, status: 'FAILED'},
  ]});
  assert.equal(record.status, 'stopped'); assert.equal(record.targetCount, 1); assert.equal(record.reviewCount, 1);
  assert.equal(record.commentCount, 1);
  assert.throws(() => historyRecord({id: 'empty', results: []}), /格式无效/);
});

test('download platform labels come from saved runs and support mixed account results', () => {
  const date = new Date(2026, 9, 27, 12, 3, 4);
  assert.equal(collectionPlatform([{platform: 'instagram'}]), 'Instagram');
  assert.equal(collectionPlatform([{platform: 'youtube'}]), 'YouTube');
  assert.equal(collectionPlatform([{platform: 'instagram'}, {platform: 'youtube'}]), 'Instagram+YouTube');
  assert.equal(collectionPlatform([{platform: 'instagram'}], {采集平台: 'YouTube'}), 'YouTube');
  assert.equal(exportFileTag(date, 'Instagram'), '社媒采集-Instagram-2026-10-27 12时03分04秒');
  assert.equal(exportFileTag(date, 'YouTube'), '社媒采集-YouTube-2026-10-27 12时03分04秒');
  assert.equal(exportFileTag(date, 'Instagram+YouTube'), '社媒采集-Instagram+YouTube-2026-10-27 12时03分04秒');
});
