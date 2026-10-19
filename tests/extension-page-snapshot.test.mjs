import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {instagramPageSnapshot} from '../extension/lib/instagram-page-snapshot.mjs';

// Small DOM fixtures for the actual selector/ancestor/text contract used by the
// serializable function. No external DOM package or browser/network is required.
class Element {
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.attributes = attributes;
    this.children = children.map(child => typeof child === 'string' ? child : child);
    for (const child of this.children) if (child instanceof Element) child.parentElement = this;
    this.parentElement = null;
  }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  get hidden() { return 'hidden' in this.attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const match = selector.trim().match(/^([a-z\d-]+)?(?:\[([a-z\d-]+)(?:="([^"]*)")?\])?$/i);
    if (!match) throw new Error(`Unsupported fixture selector ${selector}`);
    return (!match[1] || this.tagName === match[1].toUpperCase())
      && (!match[2] || (match[3] === undefined ? match[2] in this.attributes : this.attributes[match[2]] === match[3]));
  }
  closest(selector) { for (let element = this; element; element = element.parentElement) if (element.matches(selector)) return element; return null; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim().split(/\s+(?![^\[]*\])/));
    const nodes = [];
    const visit = element => {
      for (const child of element.children) {
        if (!(child instanceof Element)) continue;
        if (selectors.some(parts => {
          if (!child.matches(parts.at(-1))) return false;
          let ancestor = child.parentElement;
          for (let index = parts.length - 2; index >= 0; index -= 1) {
            while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
            ancestor = ancestor.parentElement;
          }
          return true;
        })) nodes.push(child);
        visit(child);
      }
    };
    visit(this); return nodes;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const el = (tag, attributes, ...children) => new Element(tag, attributes || {}, children.flat());
const script = value => el('script', {type: 'application/json'}, JSON.stringify(value));
function snapshot({url = 'https://www.instagram.com/team_foxer/', body = [], data = [], options = {expectedUsername: 'team_foxer'}} = {}) {
  const document = el('html', {}, el('head', {}, ...data), el('body', {}, ...body));
  document.body = document.querySelector('body');
  const context = {document, location: new URL(url), URL, options,
    getComputedStyle: node => ({display: node.attributes.style === 'display:none' ? 'none' : 'block', visibility: 'visible'})};
  // toString + fresh VM also proves the injected function does not close over imports.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${instagramPageSnapshot.toString()})(options)`, context)));
}
const post = (shortcode, other = {}) => ({shortcode, taken_at_timestamp: 1720000000,
  owner: {username: 'team_foxer'}, edge_liked_by: {count: 12}, ...other});

test('reads real profile paths, exact counts, coauthor links and pinned cards', () => {
  const result = snapshot({body: [el('main', {}, el('header', {},
    el('div', {}, el('span', {}, '1572'), ' 帖子'),
    el('a', {href: '/team_foxer/followers/'}, el('span', {title: '3,244'}, '3,244'), '粉丝')),
  el('a', {href: '/team_foxer/p/OWN1/'}, el('svg', {'aria-label': 'Pinned post'})),
  el('a', {href: '/frosty_hunts/reel/COLLAB2/'}, 'Clip'),
  el('a', {href: '/p/OWN1/?img_index=2'}, 'duplicate'),
  el('a', {href: 'https://example.com/p/NOPE/'}, 'external'))]});
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.profile, {username: 'team_foxer', followers: 3244, totalCount: 1572, isPrivate: null});
  assert.deepEqual(result.links, [
    {shortcode: 'OWN1', url: 'https://www.instagram.com/p/OWN1/', pinned: true},
    {shortcode: 'COLLAB2', url: 'https://www.instagram.com/reel/COLLAB2/', pinned: false},
  ]);
  assert.equal(result.timeline.complete, false);
});

test('DOM post uses h1, exact time and exact labels without counting visible comments', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/DegMojjjUqh/?img_index=1', options: {expectedShortcode: 'DegMojjjUqh'},
    body: [el('main', {}, el('article', {}, el('header', {}, el('a', {href: '/team_foxer/'}, 'team_foxer'), el('a', {href: '/washwildfowler/'}, 'washwildfowler')),
      el('h1', {}, 'A caption'), el('button', {}, '88次赞'),
      el('a', {href: '/team_foxer/p/DegMojjjUqh/'}, el('time', {datetime: '2026-10-15T15:04:03.000Z'}, '4天前')),
      el('span', {}, '评论加载中'), el('span', {}, 'A visible comment')))]});
  assert.equal(result.state, 'ready');
  assert.equal(result.posts[0].likes, 88);
  assert.equal(result.posts[0].comments, null);
  assert.equal(result.posts[0].views, null);
  assert.equal(result.posts[0].owner, 'team_foxer');
  assert.equal(result.posts[0].caption, 'A caption');
  assert.equal(result.posts[0].ts, Date.parse('2026-10-15T15:04:03Z') / 1000);
});

test('abbreviated counters and relative dates remain unknown', () => {
  const profile = snapshot({body: [el('main', {}, el('header', {}, el('span', {}, '1.2K followers'), el('span', {}, '1.5万帖子')),
    el('a', {href: '/p/AA/'}, 'item'))]});
  assert.equal(profile.profile.followers, null); assert.equal(profile.profile.totalCount, null);
  const result = snapshot({url: 'https://www.instagram.com/team_foxer/reel/AA/', options: {expectedShortcode: 'AA'},
    body: [el('main', {}, el('h1', {}, 'Caption'), el('time', {}, '4 days ago'), el('span', {}, '1.2K likes'), el('span', {}, '2万次播放'))]});
  assert.equal(result.posts[0].ts, null); assert.equal(result.posts[0].likes, null); assert.equal(result.posts[0].views, null);
  assert.equal(result.posts[0].type, 'Reels');
});

test('embedded profile data is scoped to matching account and retains conservative completion', () => {
  const result = snapshot({data: [script({data: {user: {username: 'team_foxer', is_private: false, edge_followed_by: {count: 3244},
    edge_owner_to_timeline_media: {count: 2, edges: [{node: post('A')}, {node: post('B', {owner: {username: 'collab'}})}], page_info: {has_next_page: false}}}},
    recommended: {username: 'unrelated', edge_followed_by: {count: 999}, edge_owner_to_timeline_media: {edges: [{node: post('BAD')}], page_info: {has_next_page: false}}}})]});
  assert.deepEqual(result.posts.map(item => item.shortcode), ['A', 'B']);
  assert.equal(result.posts[1].owner, 'collab'); assert.equal(result.posts[1].profileMember, true);
  assert.equal(result.profile.followers, 3244); assert.equal(result.timeline.complete, true); assert.equal(result.source, 'embedded');
});

test('xdt timeline includes current owner or visible coauthor links, excludes unrelated data', () => {
  const result = snapshot({body: [el('main', {}, el('a', {href: '/collab/p/B/'}, 'item'))], data: [script({
    xdt_api__v1__feed__user_timeline_graphql_connection: {edges: [
      {node: {code: 'A', taken_at: 1720000000, user: {username: 'team_foxer'}, caption: {text: 'Hello'}, like_count: 3}},
      {node: {code: 'B', taken_at: 1720000000, user: {username: 'collab'}}},
      {node: {code: 'BAD', taken_at: 1720000000, user: {username: 'unrelated'}}}], page_info: {has_next_page: false}},
  })]});
  assert.deepEqual(result.posts.map(item => item.shortcode), ['A', 'B']);
  assert.equal(result.timeline.complete, false);
});

test('embedded post ignores other shortcodes and omits every unknown/sensitive key', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/A/', options: {expectedShortcode: 'A'}, data: [script({
    csrf_token: 'DO-NOT-LEAK', viewer: {username: 'viewer', token: 'SECRET'}, items: [post('OTHER'), post('A', {
      caption: {text: 'x'.repeat(4000)}, like_count: 123, comment_count: 4, play_count: 55, product_type: 'clips',
      cookie: 'NEVER-RETURN', authorization: 'TOKEN', internal: {text: 'PRIVATE'},
    })],
  })]});
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].caption.length, 3000);
  assert.equal(result.posts[0].likes, 123); assert.equal(result.posts[0].comments, 4); assert.equal(result.posts[0].views, 55);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|SECRET|NEVER-RETURN|TOKEN|PRIVATE|csrf_token|authorization/);
});

test('LD JSON accepts only matching post URL and explicit ISO dates/counts', () => {
  const result = snapshot({url: 'https://www.instagram.com/reel/AA/', options: {expectedShortcode: 'AA'}, data: [el('script', {type: 'application/ld+json'}, JSON.stringify({
    '@type': 'VideoObject', url: 'https://www.instagram.com/team_foxer/reel/AA/', uploadDate: '2026-10-15T15:04:03Z', caption: 'Clip',
    interactionStatistic: [{'@type': 'InteractionCounter', interactionType: {'@type': 'LikeAction'}, userInteractionCount: '1234'}],
  }))]});
  assert.equal(result.posts[0].likes, 1234); assert.equal(result.posts[0].type, 'Reels');
  assert.equal(result.posts[0].ts, Date.parse('2026-10-15T15:04:03Z') / 1000);
});

test('navigation mismatch never returns old page data', () => {
  const result = snapshot({url: 'https://www.instagram.com/someone_else/', body: [el('main', {}, el('a', {href: '/p/OLD/'}, 'old'))]});
  assert.equal(result.state, 'loading'); assert.deepEqual(result.links, []); assert.deepEqual(result.posts, []);
});

test('login, restriction, missing and private messages are distinct', () => {
  assert.equal(snapshot({url: 'https://www.instagram.com/accounts/login/'}).state, 'login');
  assert.equal(snapshot({body: [el('main', {}, el('input', {name: 'password'}), el('input', {name: 'username'}))]}).state, 'login');
  assert.equal(snapshot({body: [el('main', {}, el('h2', {}, 'Try again later'))]}).state, 'restricted');
  assert.equal(snapshot({body: [el('main', {}, el('h2', {}, "Sorry, this page isn't available."))]}).state, 'unavailable');
  assert.equal(snapshot({body: [el('main', {}, el('h2', {}, 'This account is private'))]}).state, 'private');
});

test('captions/comments and hidden error panels never trigger page restriction', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/AA/', options: {expectedShortcode: 'AA'}, body: [
    el('main', {}, el('article', {}, el('h1', {}, 'Try again later'), el('h2', {}, 'This account is private'),
      el('time', {datetime: '2026-10-15T15:04:03Z'}, '4 days ago'))),
    el('div', {role: 'dialog'}, el('h1', {}, 'Try again later')),
    el('div', {role: 'alert', hidden: ''}, 'Try again later'),
  ]});
  assert.equal(result.state, 'ready'); assert.equal(result.profile.isPrivate, null);
});

test('unknown pagination never proves completeness; complete DOM totals need known public status', () => {
  const unknown = snapshot({body: [el('main', {}, el('header', {}, el('span', {}, '1 post')), el('a', {href: '/p/A/'}, 'item'))]});
  assert.equal(unknown.timeline.complete, false);
  const known = snapshot({body: [el('main', {}, el('a', {href: '/p/A/'}, 'item'))], data: [script({username: 'team_foxer', is_private: false, media_count: 1})]});
  assert.equal(known.timeline.complete, true);
  const privateResult = snapshot({data: [script({username: 'team_foxer', is_private: true,
    edge_owner_to_timeline_media: {count: 0, edges: [], page_info: {has_next_page: false}}})]});
  assert.equal(privateResult.timeline.complete, false); assert.equal(privateResult.state, 'loading');
});

test('private metadata waits for hydration; only a visible lock reports private access', () => {
  const data = [script({username: 'team_foxer', is_private: true, media_count: 3})];
  assert.equal(snapshot({data}).state, 'loading');
  assert.equal(snapshot({data, body: [el('main', {}, el('h2', {}, 'This account is private'))]}).state, 'private');
  assert.equal(snapshot({data, body: [el('main', {}, el('h2', {}, 'Try again later'))]}).state, 'restricted');
  assert.equal(snapshot({data, body: [el('main', {}, el('h2', {}, 'This account is private'), el('h2', {}, 'Try again later'))]}).state, 'restricted');
  assert.equal(snapshot({data, body: [el('main', {}, el('h2', {}, 'This account is private'), el('h2', {}, "Sorry, this page isn't available."))]}).state, 'unavailable');
});

test('comment likes and timestamps cannot become post metrics', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/AA/', options: {expectedShortcode: 'AA'}, body: [el('main', {}, el('article', {},
    el('h1', {}, 'Caption'), el('ul', {}, el('li', {}, el('time', {datetime: '2026-10-19T00:00:00Z'}, 'comment time'), el('button', {}, '3 likes'))),
    el('time', {datetime: '2026-10-18T00:00:00Z'}, 'unattributed time'),
    el('a', {href: '/team_foxer/p/AA/'}, el('time', {datetime: '2026-10-15T15:04:03Z'}, 'post time'))))]});
  assert.equal(result.posts[0].likes, null);
  assert.equal(result.posts[0].comments, null);
  assert.equal(result.posts[0].ts, Date.parse('2026-10-15T15:04:03Z') / 1000);
  assert.equal(result.posts[0].profileMember, undefined);
});

test('unattributed time and caption count spans stay unknown', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/AA/', options: {expectedShortcode: 'AA'}, body: [el('main', {},
    el('h1', {}, 'Caption', el('span', {}, '3 likes')),
    el('span', {}, '9 likes'), el('time', {datetime: '2026-10-19T00:00:00Z'}, 'unattributed time'))]});
  assert.equal(result.posts[0].likes, null); assert.equal(result.posts[0].ts, null);
});

test('post source reflects actual post fields, not incidental embedded owner metadata', () => {
  const result = snapshot({url: 'https://www.instagram.com/p/AA/', options: {expectedUsername: 'team_foxer', expectedShortcode: 'AA'},
    body: [el('main', {}, el('h1', {}, 'Caption'))], data: [script({username: 'team_foxer', follower_count: 123})]});
  assert.equal(result.posts[0].source, 'dom'); assert.equal(result.source, 'dom');
});

test('profile navigation/header/aside post links are not grid membership', () => {
  const result = snapshot({body: [el('main', {}, el('nav', {}, el('a', {href: '/p/NAV/'}, 'navigation')),
    el('header', {}, el('a', {href: '/p/HEADER/'}, 'header')),
    el('aside', {}, el('a', {href: '/p/ASIDE/'}, 'recommended')),
    el('a', {href: '/p/GRID/'}, 'grid'))]});
  assert.deepEqual(result.links.map(item => item.shortcode), ['GRID']);
});

test('explicit empty public timeline is ready; truncated timeline never claims completion', () => {
  const empty = snapshot({data: [script({username: 'team_foxer', is_private: false, edge_owner_to_timeline_media: {
    count: 0, edges: [], page_info: {has_next_page: false}}})]});
  assert.equal(empty.state, 'ready'); assert.equal(empty.timeline.complete, true);
  const many = snapshot({data: [script({username: 'team_foxer', is_private: false, edge_owner_to_timeline_media: {
    count: 1001, edges: Array.from({length: 1001}, (_, index) => ({node: post(`P${index}`)})), page_info: {has_next_page: false}}})]});
  assert.equal(many.posts.length, 1000); assert.equal(many.timeline.complete, false);
});

test('oversized and malformed embedded scripts are skipped while DOM still works', () => {
  const result = snapshot({body: [el('main', {}, el('a', {href: '/p/A/'}, 'item'))], data: [
    el('script', {type: 'application/json'}, '{invalid'), script({padding: 'x'.repeat(8 * 1024 * 1024), user: {username: 'team_foxer', follower_count: 999}}),
  ]});
  assert.equal(result.state, 'ready'); assert.equal(result.profile.followers, null);
});

test('snapshot has no network, storage or cookie access', () => {
  const code = instagramPageSnapshot.toString();
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage|chrome\./);
});
