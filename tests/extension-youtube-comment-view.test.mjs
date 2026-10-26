import test from 'node:test';
import assert from 'node:assert/strict';
import {orderComments} from '../extension/lib/youtube-comment-view.mjs';

test('comment reading order puts replies after their root and preserves orphan replies without mutating results', () => {
  const comments = [{id: 'b', parent_id: 'a'}, {id: 'd', parent_id: 'missing'}, {id: 'a'}, {id: 'c'}, {id: 'e', parent_id: 'a'}];
  const before = structuredClone(comments);
  assert.deepEqual(orderComments(comments).map(comment => comment.id), ['a', 'b', 'e', 'c', 'd']);
  assert.deepEqual(comments, before);
});

test('large comment lists retain every root and reply in reading order', () => {
  const comments = Array.from({length: 10000}, (_, i) => ({id: String(i), parent_id: i % 2 ? String(i - 1) : ''})).reverse();
  const ordered = orderComments(comments);
  assert.equal(ordered.length, comments.length);
  assert.equal(new Set(ordered.map(comment => comment.id)).size, 10000);
  for (let i = 0; i < ordered.length; i += 2) assert.equal(ordered[i + 1].parent_id, ordered[i].id);
});
