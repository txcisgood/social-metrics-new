import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installInstagramPageObserver, readInstagramPageObserver} from '../extension/lib/instagram-page-observer.mjs';

const scope = {expectedUsername: 'creator'};
const item = (code = 'A', extra = {}) => ({code, user: {username: 'creator'}, taken_at: 1792400000,
  like_count: 88, comment_count: 3, caption: {text: 'PRIVATE_CAPTION'}, media_type: 1, ...extra});
const response = (body, path = '/graphql/query/', status = 200) => {
  const value = new Response(typeof body === 'string' ? body : JSON.stringify(body), {status});
  Object.defineProperty(value, 'url', {value: `https://www.instagram.com${path}`});
  return value;
};
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 3)); };

function browser() {
  const calls = [], queue = [];
  class XHR extends EventTarget {
    send(...args) { calls.push({type: 'xhr', args, receiver: this}); return 'original return'; }
  }
  const context = vm.createContext({URL, Response, TextDecoder, TextEncoder, Uint8Array, Symbol,
    location: {protocol: 'https:', hostname: 'www.instagram.com', origin: 'https://www.instagram.com',
      href: 'https://www.instagram.com/creator/', pathname: '/creator/'},
    XMLHttpRequest: XHR,
    fetch: function (...args) { calls.push({type: 'fetch', args, receiver: this}); return queue.shift(); }});
  vm.runInContext('window = globalThis', context);
  const invoke = (fn, args = scope) => {
    context.args = args;
    return JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(args)`, context)));
  };
  return {context, calls, queue, XHR, install: args => invoke(installInstagramPageObserver, args),
    read: args => invoke(readInstagramPageObserver, args)};
}

test('passive observer preserves the page fetch promise and makes zero additional requests', async () => {
  const b = browser(); b.install();
  const original = response({items: [item()], cookie: 'PRIVATE_COOKIE'});
  const pending = Promise.resolve(original); b.queue.push(pending);
  const options = {method: 'POST', body: 'PRIVATE_REQUEST_BODY'};
  const receiver = {};
  const result = b.context.fetch.call(receiver, '/graphql/query/', options);
  assert.equal(result, pending);
  await settle();
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].receiver, receiver);
  assert.equal(b.calls[0].args[1], options);
  assert.equal((await original.json()).items[0].like_count, 88, 'original response remains consumable');
  const read = b.read();
  assert.equal(read.posts[0].likes, 88); assert.equal(read.posts[0].comments, 3);
  assert.equal(read.posts[0].profileMember, true); assert.equal(read.timeline.complete, false);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_COOKIE|PRIVATE_REQUEST_BODY/);
});

test('only media for the expected owner or coauthor is accepted and unknown counters remain null', async () => {
  const b = browser(); b.install();
  b.queue.push(Promise.resolve(response({items: [item('OTHER', {user: {username: 'unrelated'}}),
    item('COLLAB', {user: {username: 'other'}, coauthor_producers: [{username: 'creator'}], like_count: undefined,
      comment_count: undefined, play_count: -1})]})));
  await b.context.fetch('/graphql/query/'); await settle();
  const posts = b.read().posts;
  assert.equal(posts.length, 1); assert.equal(posts[0].shortcode, 'COLLAB');
  assert.equal(posts[0].likes, null); assert.equal(posts[0].comments, null); assert.equal(posts[0].views, null);
});

test('unrelated and cross-origin response locations are ignored', async () => {
  const b = browser(); b.install();
  for (const url of ['https://www.instagram.com/api/v1/direct_v2/inbox/', 'https://example.com/graphql/query/']) {
    const value = new Response(JSON.stringify({items: [item()]})); Object.defineProperty(value, 'url', {value: url});
    b.queue.push(Promise.resolve(value)); await b.context.fetch(url);
  }
  await settle(); assert.deepEqual(b.read().posts, []);
});

test('same scope installation is idempotent and does not duplicate response handling', async () => {
  const b = browser(); b.install(); const fetch = b.context.fetch;
  assert.equal(b.install().reused, true); assert.equal(b.context.fetch, fetch);
  b.queue.push(Promise.resolve(response({items: [item()]}))); await b.context.fetch('/graphql/query/');
  await settle(); assert.equal(b.calls.length, 1); assert.equal(b.read().posts.length, 1);
});

test('in-flight old-scope responses cannot populate a newly selected profile', async () => {
  const b = browser(); b.install(); let resolve;
  b.queue.push(new Promise(done => { resolve = done; })); const pending = b.context.fetch('/graphql/query/');
  b.context.location.pathname = '/second/'; b.context.location.href = 'https://www.instagram.com/second/';
  b.install({expectedUsername: 'second'}); resolve(response({items: [item()]})); await pending; await settle();
  assert.deepEqual(b.read({expectedUsername: 'second'}).posts, []);
  assert.deepEqual(b.read().posts, []);
});

test('429 from a page-owned media request is observed without retrying it', async () => {
  const b = browser(); b.install(); b.queue.push(Promise.resolve(response('', '/graphql/query/', 429)));
  await b.context.fetch('/graphql/query/'); await settle();
  assert.equal(b.read().state, 'restricted'); assert.equal(b.calls.length, 1);
});

test('large and malformed JSON are ignored without changing the original request result', async () => {
  const b = browser(); b.install();
  for (const body of ['{bad json', JSON.stringify({padding: 'x'.repeat(2 * 1024 * 1024), items: [item()]})]) {
    const value = response(body); b.queue.push(Promise.resolve(value));
    assert.equal(await b.context.fetch('/graphql/query/'), value);
  }
  await settle(); assert.deepEqual(b.read().posts, []);
});

test('normal XHR response is read after load without altering send arguments or return value', () => {
  const b = browser(); b.install(); const xhr = new b.XHR();
  Object.assign(xhr, {responseURL: 'https://www.instagram.com/api/v1/feed/user/1/', status: 200,
    responseType: 'json', response: {items: [item()], user: {username: 'creator', follower_count: 500, media_count: 1}}});
  assert.equal(xhr.send('PRIVATE_BODY'), 'original return'); xhr.dispatchEvent(new Event('load'));
  assert.equal(b.calls.length, 1); assert.deepEqual(b.calls[0].args, ['PRIVATE_BODY']);
  assert.equal(b.read().profile.followers, 500); assert.equal(b.read().posts.length, 1);
});

test('exact post scope permits the requested collaboration without capturing other creators posts', async () => {
  const b = browser(); b.context.location.pathname = '/p/COLLAB/';
  const args = {...scope, expectedShortcode: 'COLLAB'}; b.install(args);
  b.queue.push(Promise.resolve(response({items: [item('COLLAB', {user: {username: 'other'}}), item('OTHER', {user: {username: 'other'}})]})));
  await b.context.fetch('/graphql/query/'); await settle();
  assert.deepEqual(b.read(args).posts.map(post => post.shortcode), ['COLLAB']);
});

test('cache is bounded to 200 posts with bounded captions and detached reads', async () => {
  const b = browser(); b.install(); b.queue.push(Promise.resolve(response({items: Array.from({length: 220}, (_, i) => item(`A${i}`, {caption: {text: 'x'.repeat(4000)}}))})));
  await b.context.fetch('/graphql/query/'); await settle(); const read = b.read();
  assert.equal(read.posts.length, 200); assert.equal(read.posts[0].caption.length, 3000);
  read.posts[0].likes = 999; assert.equal(b.read().posts[0].likes, 88);
});
