import test from 'node:test';
import assert from 'node:assert/strict';
import {formatVideoDuration, exportFileTag} from '../extension/lib/format.mjs';

test('video duration notation becomes familiar elapsed time without wrapping hours at 24', () => {
  for (const [raw, expected] of [['PT16S', '00:16'], ['PT15M2S', '15:02'], ['PT14M30S', '14:30'],
    ['PT27M21S', '27:21'], ['PT1H2M3S', '1:02:03'], ['PT1H', '1:00:00'], ['P1D', '24:00:00'],
    ['P1DT2H3M4S', '26:03:04'], ['PT0S', '00:00'], ['PT1.9S', '00:01']]) {
    assert.equal(formatVideoDuration(raw), expected, raw);
  }
});

test('empty, unavailable and already formatted durations are preserved instead of inventing a zero', () => {
  for (const value of [undefined, null, '', 25, '未公开或不可用', '15:02', 'PT', 'P1DT', 'P1M', 'PT-1S', 'PT1e9S']) {
    assert.equal(formatVideoDuration(value), value);
  }
});

test('export filenames use local calendar and clock values with safe readable separators', () => {
  assert.equal(exportFileTag(new Date(2026, 9, 27, 0, 8, 38)), '社媒采集-2026-10-27 00时08分38秒');
  assert.equal(exportFileTag(new Date(2026, 11, 31, 23, 59, 59)), '社媒采集-2026-12-31 23时59分59秒');
  assert.throws(() => exportFileTag(new Date('invalid')), /时间无效/);
});
