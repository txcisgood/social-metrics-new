/** Observe only requests the Instagram page makes itself. This function is injected in MAIN. */
export function installInstagramPageObserver({expectedUsername, expectedShortcode = ''} = {}) {
  const KEY = Symbol.for('social-metrics.instagram.page-observer.v1');
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_NODES = 50000;
  const MAX_POSTS = 200;
  const usernamePattern = /^[A-Za-z0-9_.]{1,30}$/;
  const shortcodePattern = /^[A-Za-z0-9_-]{1,100}$/;
  const username = typeof expectedUsername === 'string' && usernamePattern.test(expectedUsername) ? expectedUsername : '';
  const shortcode = typeof expectedShortcode === 'string' && shortcodePattern.test(expectedShortcode) ? expectedShortcode : '';
  if (!username || (expectedShortcode && !shortcode)) return {installed: false, reason: 'scope'};
  const scope = {username, shortcode};
  function pageMatches(target) {
    if (location.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(location.hostname)) return false;
    const parts = location.pathname.split('/').filter(Boolean);
    if (!target.shortcode) return parts.length === 1 && parts[0].toLowerCase() === target.username.toLowerCase();
    const index = parts.length === 2 ? 0 : parts.length === 3 ? 1 : -1;
    return index >= 0 && ['p', 'reel', 'tv'].includes(parts[index]) && parts[index + 1] === target.shortcode;
  }
  if (!pageMatches(scope)) return {installed: false, reason: 'page'};
  const existing = window[KEY];
  if (existing?.version === 1 && typeof existing.reset === 'function') {
    existing.reset(scope);
    return {installed: true, reused: true};
  }
  const state = {version: 1, generation: 0, scope: null, profile: null, posts: [], restricted: false};
  state.reset = target => {
    if (state.scope?.username.toLowerCase() === target.username.toLowerCase() && state.scope.shortcode === target.shortcode) return;
    state.generation += 1;
    state.scope = {username: target.username, shortcode: target.shortcode};
    state.profile = {username: target.username, followers: null, totalCount: null, isPrivate: null};
    state.posts = [];
    state.restricted = false;
  };
  state.reset(scope);
  const validGeneration = generation => generation === state.generation && pageMatches(state.scope);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = value => {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const firstCount = (...values) => {
    for (const value of values) { const number = exact(value); if (number !== null) return number; }
    return null;
  };
  const safeUsername = value => typeof value === 'string' && usernamePattern.test(value) ? value : '';
  const sameUser = value => safeUsername(value).toLowerCase() === state.scope.username.toLowerCase();
  function allowedURL(value) {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return false;
      return /^\/api\/v1\/(?:users\/|feed\/user\/|media\/)/.test(url.pathname)
        || /^\/(?:graphql\/query|api\/graphql)\/?$/.test(url.pathname);
    } catch { return false; }
  }
  function normalize(raw) {
    const code = typeof raw.shortcode === 'string' ? raw.shortcode : raw.code;
    if (!shortcodePattern.test(code || '')) return null;
    const owner = safeUsername(raw.owner?.username) || safeUsername(raw.user?.username);
    const member = sameUser(owner) || (Array.isArray(raw.coauthor_producers)
      && raw.coauthor_producers.slice(0, 100).some(user => sameUser(user?.username)));
    if (!member && code !== state.scope.shortcode) return null;
    const seconds = exact(raw.taken_at_timestamp ?? raw.taken_at);
    const caption = raw.caption?.text ?? raw.edge_media_to_caption?.edges?.[0]?.node?.text
      ?? (typeof raw.caption === 'string' ? raw.caption : '');
    const type = raw.product_type === 'clips' ? 'Reels'
      : raw.media_type === 8 || raw.__typename === 'GraphSidecar' ? '图文轮播'
        : raw.media_type === 2 || raw.is_video === true || raw.__typename === 'GraphVideo' ? '视频' : '图片';
    const post = {shortcode: code, url: `https://www.instagram.com/${type === 'Reels' ? 'reel' : 'p'}/${code}/`,
      ts: seconds !== null && seconds > 0 && seconds <= 8640000000000 ? seconds : null,
      caption: typeof caption === 'string' ? caption.slice(0, 3000) : '', type,
      likes: firstCount(raw.like_count, raw.edge_liked_by?.count, raw.edge_media_preview_like?.count),
      comments: firstCount(raw.comment_count, raw.edge_media_to_comment?.count, raw.edge_media_to_parent_comment?.count),
      views: firstCount(raw.play_count, raw.ig_play_count, raw.video_play_count, raw.video_view_count, raw.view_count),
      owner, pinned: raw.is_pinned === true || raw.is_pinned === 1
        || (Array.isArray(raw.pinned_for_users) && raw.pinned_for_users.length > 0), source: 'embedded'};
    if (member && !state.scope.shortcode) post.profileMember = true;
    return post;
  }
  function accept(payload, generation, budget = MAX_NODES) {
    if (!validGeneration(generation)) return;
    const stack = [payload];
    let nodes = 0;
    while (stack.length && nodes < budget && validGeneration(generation)) {
      const raw = stack.pop(); nodes += 1;
      if (!raw || typeof raw !== 'object') continue;
      if (Array.isArray(raw)) {
        for (let index = Math.min(raw.length, budget - nodes - stack.length) - 1; index >= 0; index -= 1) stack.push(raw[index]);
        continue;
      }
      if (sameUser(raw.username)) {
        state.profile.followers = firstCount(raw.follower_count, raw.edge_followed_by?.count, state.profile.followers);
        state.profile.totalCount = firstCount(raw.media_count, raw.edge_owner_to_timeline_media?.count, state.profile.totalCount);
        if (typeof raw.is_private === 'boolean') state.profile.isPrivate = raw.is_private;
      }
      const post = normalize(raw);
      if (post) {
        const index = state.posts.findIndex(item => item.shortcode === post.shortcode);
        if (index >= 0) {
          const previous = state.posts[index];
          for (const key of ['ts', 'likes', 'comments', 'views']) post[key] = post[key] ?? previous[key];
          post.caption ||= previous.caption;
          post.owner ||= previous.owner;
          post.pinned ||= previous.pinned;
          if (previous.type === 'Reels') post.type = 'Reels';
          if (previous.profileMember === true) post.profileMember = true;
          state.posts[index] = post;
        } else if (state.posts.length < MAX_POSTS) state.posts.push(post);
      }
      const keys = Object.keys(raw);
      for (let index = keys.length - 1; index >= 0 && stack.length < budget - nodes; index -= 1) {
        const child = raw[keys[index]];
        if (child && typeof child === 'object') stack.push(child);
      }
    }
  }
  async function inspectFetch(response, generation) {
    if (!validGeneration(generation) || !allowedURL(response?.url)) return;
    if (response.status === 429) { state.restricted = true; return; }
    if (response.status < 200 || response.status >= 300 || typeof response.clone !== 'function') return;
    let reader;
    try {
      reader = response.clone().body?.getReader();
      if (!reader) return;
      const chunks = []; let bytes = 0;
      while (true) {
        if (!validGeneration(generation)) { void reader.cancel().catch(() => {}); return; }
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > MAX_BYTES) { void reader.cancel().catch(() => {}); return; }
        chunks.push(value);
      }
      if (!validGeneration(generation)) return;
      const data = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      const payload = JSON.parse(new TextDecoder().decode(data));
      accept(payload, generation);
    } catch { /* Observation must never reject or alter the page's request. */ }
    finally { try { reader?.releaseLock(); } catch { /* A cancelled stream can already be unlocked. */ } }
  }
  function inspectXHR(xhr, generation) {
    try {
      if (!validGeneration(generation) || !allowedURL(xhr.responseURL)) return;
      if (xhr.status === 429) { state.restricted = true; return; }
      if (xhr.status < 200 || xhr.status >= 300) return;
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        const value = xhr.responseText;
        if (typeof value !== 'string' || value.length > MAX_BYTES || new TextEncoder().encode(value).byteLength > MAX_BYTES) return;
        accept(JSON.parse(value), generation);
      } else if (xhr.responseType === 'json') {
        // The browser already parsed this response. Validate size conservatively
        // without JSON.stringify on an unbounded object or executing accessors.
        const payload = xhr.response; const stack = [payload]; const seen = new Set();
        let nodes = 0; let bytes = 0;
        while (stack.length) {
          const value = stack.pop(); nodes += 1;
          if (nodes >= MAX_NODES / 2) return;
          if (typeof value === 'string') bytes += value.length * 6 + 2;
          else if (value && typeof value === 'object') {
            if (seen.has(value)) return;
            seen.add(value); bytes += 2;
            for (const key of Object.keys(value)) {
              const descriptor = Object.getOwnPropertyDescriptor(value, key);
              if (!descriptor || !('value' in descriptor)) return;
              bytes += key.length * 6 + 4;
              if (stack.length + nodes >= MAX_NODES / 2) return;
              stack.push(descriptor.value);
            }
          } else bytes += 32;
          if (bytes > MAX_BYTES) return;
        }
        accept(payload, generation, MAX_NODES - nodes);
      }
    } catch { /* Ignore unsupported response types and page navigation races. */ }
  }
  if (typeof window.fetch === 'function') {
    const original = window.fetch;
    state.fetchWrapper = function (...args) {
      const generation = state.generation;
      const pending = Reflect.apply(original, this, args);
      try { Promise.resolve(pending).then(response => inspectFetch(response, generation), () => {}).catch(() => {}); } catch { /* Keep original promise. */ }
      return pending;
    };
    window.fetch = state.fetchWrapper;
  }
  const prototype = window.XMLHttpRequest?.prototype;
  if (prototype && typeof prototype.send === 'function') {
    const original = prototype.send;
    state.sendWrapper = function (...args) {
      const generation = state.generation;
      const listener = () => inspectXHR(this, generation);
      try { this.addEventListener('load', listener, {once: true}); } catch { /* Native send still runs. */ }
      try { return Reflect.apply(original, this, args); }
      catch (error) { try { this.removeEventListener('load', listener); } catch { /* Preserve original error. */ } throw error; }
    };
    prototype.send = state.sendWrapper;
  }
  Object.defineProperty(window, KEY, {value: state, configurable: true});
  return {installed: true, reused: false};
}

/** Independent serializable reader: export a detached, bounded whitelist only. */
export function readInstagramPageObserver({expectedUsername, expectedShortcode = ''} = {}) {
  const usernamePattern = /^[A-Za-z0-9_.]{1,30}$/;
  const codePattern = /^[A-Za-z0-9_-]{1,100}$/;
  const username = typeof expectedUsername === 'string' && usernamePattern.test(expectedUsername) ? expectedUsername : '';
  const shortcode = typeof expectedShortcode === 'string' && codePattern.test(expectedShortcode) ? expectedShortcode : '';
  const empty = {profile: {username, followers: null, totalCount: null, isPrivate: null}, posts: [], timeline: {complete: false}};
  try {
    const state = window[Symbol.for('social-metrics.instagram.page-observer.v1')];
    if (!username || state?.version !== 1 || state.scope?.username.toLowerCase() !== username.toLowerCase() || state.scope.shortcode !== shortcode) return empty;
    const parts = location.pathname.split('/').filter(Boolean);
    const index = parts.length === 2 ? 0 : parts.length === 3 ? 1 : -1;
    if (location.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(location.hostname)
        || (shortcode ? index < 0 || !['p', 'reel', 'tv'].includes(parts[index]) || parts[index + 1] !== shortcode
          : parts.length !== 1 || parts[0].toLowerCase() !== username.toLowerCase())) return empty;
    const exact = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    empty.profile.followers = exact(state.profile?.followers);
    empty.profile.totalCount = exact(state.profile?.totalCount);
    empty.profile.isPrivate = typeof state.profile?.isPrivate === 'boolean' ? state.profile.isPrivate : null;
    for (const raw of (Array.isArray(state.posts) ? state.posts.slice(0, 200) : [])) {
      if (!raw || typeof raw.shortcode !== 'string' || !codePattern.test(raw.shortcode)) continue;
      const owner = typeof raw.owner === 'string' && usernamePattern.test(raw.owner) ? raw.owner : '';
      if (raw.shortcode !== shortcode && owner.toLowerCase() !== username.toLowerCase() && raw.profileMember !== true) continue;
      const type = ['Reels', '图文轮播', '视频', '图片'].includes(raw.type) ? raw.type : '图片';
      const post = {shortcode: raw.shortcode, url: `https://www.instagram.com/${type === 'Reels' ? 'reel' : 'p'}/${raw.shortcode}/`,
        ts: exact(raw.ts) !== null && raw.ts > 0 && raw.ts <= 8640000000000 ? raw.ts : null,
        caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 3000) : '', type,
        likes: exact(raw.likes), comments: exact(raw.comments), views: exact(raw.views), owner,
        pinned: raw.pinned === true, source: 'embedded'};
      if (!shortcode && raw.profileMember === true) post.profileMember = true;
      empty.posts.push(post);
    }
    if (state.restricted === true) empty.state = 'restricted';
  } catch { /* The page may replace observer state; never expose it wholesale. */ }
  return empty;
}
