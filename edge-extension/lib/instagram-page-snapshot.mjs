/** Runs in the page's DOM world. Keep every helper inside this serializable function. */
export function instagramPageSnapshot({expectedUsername = '', expectedShortcode = ''} = {}) {
  const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
  const MAX_NODES = 100000;
  const MAX_POSTS = 1000;
  const usernamePattern = /^[A-Za-z0-9_.]{1,30}$/;
  const codePattern = /^[A-Za-z0-9_-]{1,100}$/;
  const reserved = new Set(['accounts', 'challenge', 'checkpoint', 'direct', 'explore', 'stories', 'reels', 'p', 'reel', 'tv']);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const userName = value => typeof value === 'string' && usernamePattern.test(value) ? value : '';
  const lower = value => String(value || '').toLowerCase();
  const exact = value => {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const firstCount = (...values) => {
    for (const value of values) { const result = exact(value); if (result !== null) return result; }
    return null;
  };
  const text = element => typeof element?.textContent === 'string' ? element.textContent.trim() : '';
  const all = (element, selector, max = 10000) => Array.from(element?.querySelectorAll?.(selector) || []).slice(0, max);
  const one = (element, selector) => element?.querySelector?.(selector) || null;
  const attr = (element, name) => element?.getAttribute?.(name) || '';
  function route(value) {
    try {
      const parsed = new URL(value, location.href);
      if (!['www.instagram.com', 'instagram.com'].includes(parsed.hostname) || parsed.protocol !== 'https:') return null;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 1 && usernamePattern.test(parts[0]) && !reserved.has(lower(parts[0]))) {
        return {kind: 'profile', username: parts[0], shortcode: '', url: `https://www.instagram.com/${parts[0]}/`};
      }
      const position = parts.length === 2 ? 0 : parts.length === 3 && usernamePattern.test(parts[0]) ? 1 : -1;
      if (position >= 0 && ['p', 'reel', 'tv'].includes(parts[position]) && codePattern.test(parts[position + 1])) {
        return {kind: 'post', username: position ? parts[0] : '', shortcode: parts[position + 1],
          type: parts[position] === 'reel' ? 'Reels' : '',
          url: `https://www.instagram.com/${parts[position]}/${parts[position + 1]}/`};
      }
      return {kind: 'other', username: '', shortcode: '', url: `https://www.instagram.com${parsed.pathname}`};
    } catch { return null; }
  }
  const current = route(location.href) || {kind: 'other', username: '', shortcode: '', url: ''};
  const targetUser = userName(expectedUsername) || current.username;
  const targetCode = codePattern.test(expectedShortcode) ? expectedShortcode : current.shortcode;
  const result = {url: current.url, kind: current.kind, state: 'loading',
    profile: {username: current.kind === 'profile' ? current.username : targetUser, followers: null, totalCount: null, isPrivate: null},
    posts: [], links: [], timeline: {complete: false}, source: 'dom'};
  function visible(element) {
    for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
      if (node.hidden || attr(node, 'aria-hidden') === 'true') return false;
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
    }
    return true;
  }
  const main = one(document, 'main') || one(document, '[role="main"]') || document.body || document;
  const loginRoute = /^\/(?:accounts\/(?:login|onetap)|challenge|checkpoint)(?:\/|$)/i.test(location.pathname);
  const loginForm = one(document, 'input[name="password"]') && one(document, 'input[name="username"]');
  if (loginRoute || (loginForm && visible(loginForm))) { result.state = 'login'; return result; }
  if ((expectedUsername && current.kind === 'profile' && lower(current.username) !== lower(expectedUsername))
      || (expectedShortcode && current.kind === 'post' && current.shortcode !== expectedShortcode)) return result;

  function numericText(value) {
    const trimmed = String(value || '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/.test(trimmed)) return null;
    return exact(trimmed.replace(/[, \u00a0\u202f]/g, ''));
  }
  function labelledCount(value, labels) {
    const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
    const match = cleaned.match(new RegExp(`^(?:${labels})\\s*[:：]?\\s*([\\d, \\u00a0\\u202f]+)$`, 'i'))
      || cleaned.match(new RegExp(`^([\\d, \\u00a0\\u202f]+)\\s*(?:${labels})$`, 'i'));
    return match ? numericText(match[1]) : null;
  }
  function pinned(element) {
    return all(element, '[aria-label], [title]', 100).some(node => /^(?:pinned|pinned post|置顶|已置顶)$/i.test(attr(node, 'aria-label') || attr(node, 'title')));
  }
  const links = new Map();
  if (current.kind === 'profile') {
    for (const anchor of all(main, 'a[href]')) {
      const item = route(attr(anchor, 'href'));
      if (item?.kind !== 'post' || !visible(anchor) || anchor.closest?.('header, nav, aside')) continue;
      const existing = links.get(item.shortcode);
      if (!existing && links.size >= MAX_POSTS) break;
      links.set(item.shortcode, {shortcode: item.shortcode, url: item.url, pinned: !!existing?.pinned || pinned(anchor)});
    }
    const header = one(main, 'header') || main;
    const followerLink = all(header, 'a[href]', 500).find(anchor => /\/followers\/?(?:\?|$)/.test(attr(anchor, 'href')));
    if (followerLink) {
      for (const node of [followerLink, ...all(followerLink, '[title]', 50)]) {
        result.profile.followers = numericText(attr(node, 'title')) ?? labelledCount(text(node), 'followers?|粉丝|位粉丝|人关注');
        if (result.profile.followers !== null) break;
      }
    }
    for (const node of all(header, 'li, span, div', 2000)) {
      if (!visible(node)) continue;
      const content = text(node);
      if (content.length > 100) continue;
      if (result.profile.totalCount === null) result.profile.totalCount = labelledCount(content, 'posts?|帖子|篇帖子|篇贴文|贴文');
      if (result.profile.followers === null) result.profile.followers = labelledCount(content, 'followers?|粉丝|位粉丝');
    }
  }

  const posts = new Map();
  function timestamp(value) {
    const number = exact(value);
    return number !== null && number > 0 && number <= 8640000000000 ? number : null;
  }
  function isoTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
  }
  function putPost(item) {
    if (!item || !codePattern.test(item.shortcode) || (!posts.has(item.shortcode) && posts.size >= MAX_POSTS)) return;
    item.pinned ||= !!links.get(item.shortcode)?.pinned;
    const previous = posts.get(item.shortcode);
    if (previous) {
      for (const key of ['ts', 'likes', 'comments', 'views']) item[key] = item[key] ?? previous[key];
      item.caption ||= previous.caption;
      item.owner ||= previous.owner;
      if (previous.type === 'Reels') item.type = 'Reels';
      item.pinned ||= previous.pinned;
      if (previous.profileMember === true) item.profileMember = true;
      if (previous.source === 'embedded') item.source = 'embedded';
    }
    posts.set(item.shortcode, item);
  }
  function normalize(raw) {
    if (!object(raw)) return null;
    const code = typeof raw.shortcode === 'string' ? raw.shortcode : raw.code;
    if (!codePattern.test(code || '')) return null;
    const caption = raw.caption?.text ?? raw.edge_media_to_caption?.edges?.[0]?.node?.text ?? (typeof raw.caption === 'string' ? raw.caption : '');
    const type = raw.product_type === 'clips' ? 'Reels'
      : raw.media_type === 8 || raw.__typename === 'GraphSidecar' ? '图文轮播'
        : raw.media_type === 2 || raw.is_video === true || raw.__typename === 'GraphVideo' ? '视频' : '图片';
    return {shortcode: code, url: `https://www.instagram.com/${type === 'Reels' ? 'reel' : 'p'}/${code}/`,
      ts: timestamp(raw.taken_at_timestamp ?? raw.taken_at), caption: typeof caption === 'string' ? caption.slice(0, 3000) : '', type,
      likes: firstCount(raw.like_count, raw.edge_liked_by?.count, raw.edge_media_preview_like?.count),
      comments: firstCount(raw.comment_count, raw.edge_media_to_comment?.count, raw.edge_media_to_parent_comment?.count),
      views: firstCount(raw.play_count, raw.ig_play_count, raw.video_play_count, raw.video_view_count, raw.view_count),
      owner: userName(raw.owner?.username) || userName(raw.user?.username),
      pinned: raw.is_pinned === true || raw.is_pinned === 1 || (Array.isArray(raw.pinned_for_users) && raw.pinned_for_users.length > 0), source: 'embedded'};
  }
  function updateProfile(raw) {
    if (!object(raw) || !targetUser || lower(raw.username) !== lower(targetUser)) return false;
    result.profile.username = userName(raw.username);
    result.profile.followers = firstCount(raw.follower_count, raw.edge_followed_by?.count, result.profile.followers);
    result.profile.totalCount = firstCount(raw.media_count, raw.edge_owner_to_timeline_media?.count, result.profile.totalCount);
    if (typeof raw.is_private === 'boolean') result.profile.isPrivate = raw.is_private;
    result.source = 'embedded';
    return true;
  }
  function timeline(raw, trusted) {
    if (!object(raw) || !Array.isArray(raw.edges)) return;
    let accepted = 0;
    let rejected = 0;
    for (const edge of raw.edges.slice(0, MAX_POSTS)) {
      const item = normalize(edge?.node);
      const coauthors = edge?.node?.coauthor_producers;
      if (item && (trusted || lower(item.owner) === lower(targetUser) || links.has(item.shortcode)
          || (Array.isArray(coauthors) && coauthors.some(user => lower(user?.username) === lower(targetUser))))) {
        item.profileMember = true;
        putPost(item); accepted += 1;
      } else rejected += 1;
    }
    // A partial or unrelated connection never proves a profile is complete.
    if ((trusted || accepted > 0) && !rejected && raw.edges.length <= MAX_POSTS && raw.page_info?.has_next_page === false) result.timeline.complete = true;
    if (accepted) result.source = 'embedded';
  }
  let bytes = 0;
  let nodes = 0;
  for (const script of all(document, 'script[type="application/json"], script[type="application/ld+json"]', 2000)) {
    const value = text(script);
    if (!value || value.length > MAX_SCRIPT_BYTES - bytes) continue;
    const scriptBytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(value).byteLength : value.length * 3;
    if (scriptBytes > MAX_SCRIPT_BYTES - bytes) continue;
    bytes += scriptBytes;
    let parsed;
    try { parsed = JSON.parse(value); } catch { continue; }
    const stack = [parsed];
    while (stack.length && nodes < MAX_NODES) {
      const raw = stack.pop(); nodes += 1;
      if (!raw || typeof raw !== 'object') continue;
      if (Array.isArray(raw)) {
        for (let index = Math.min(raw.length, MAX_NODES - nodes) - 1; index >= 0; index -= 1) stack.push(raw[index]);
        continue;
      }
      const matched = updateProfile(raw);
      if (current.kind === 'profile' && matched) timeline(raw.edge_owner_to_timeline_media, true);
      if (current.kind === 'post') {
        const item = normalize(raw);
        if (item?.shortcode === targetCode) { putPost(item); result.source = 'embedded'; }
        if (['SocialMediaPosting', 'ImageObject', 'VideoObject', 'Article'].includes(raw['@type'])) {
          const canonical = route(raw.url || raw.mainEntityOfPage?.['@id'] || raw.mainEntityOfPage || '');
          if (canonical?.shortcode === targetCode) {
            const counts = {likes: null, comments: null, views: null};
            const interactions = Array.isArray(raw.interactionStatistic) ? raw.interactionStatistic : [raw.interactionStatistic];
            for (const interaction of interactions) {
              const kind = String(interaction?.interactionType?.['@type'] || interaction?.interactionType || '');
              if (/LikeAction$/.test(kind)) counts.likes = exact(interaction?.userInteractionCount);
              if (/CommentAction$/.test(kind)) counts.comments = exact(interaction?.userInteractionCount);
              if (/WatchAction$|ViewAction$/.test(kind)) counts.views = exact(interaction?.userInteractionCount);
            }
            putPost({shortcode: targetCode, url: canonical.url, ts: isoTimestamp(raw.datePublished || raw.uploadDate),
              caption: String(raw.articleBody || raw.caption || '').slice(0, 3000), type: canonical.type || (raw['@type'] === 'VideoObject' ? '视频' : '图片'),
              ...counts, owner: '', pinned: false, source: 'embedded'});
            result.source = 'embedded';
          }
        }
      }
      const entries = Object.entries(raw);
      for (let index = entries.length - 1; index >= 0 && stack.length < MAX_NODES - nodes; index -= 1) {
        const [key, child] = entries[index];
        if (current.kind === 'profile' && /^xdt_.*(?:feed__user_timeline|user_timeline).*connection$/.test(key)) timeline(child, false);
        if (child && typeof child === 'object') stack.push(child);
      }
    }
    if (nodes >= MAX_NODES) break;
  }

  if (current.kind === 'post') {
    const dialogs = all(document, '[role="dialog"]', 20).filter(visible);
    const article = dialogs.find(node => one(node, 'time[datetime]')) || one(main, 'article') || main;
    const times = all(article, 'time[datetime]', 50);
    const time = times.find(node => {
      if (node.closest?.('li, ol, ul, [role="listitem"], [role="list"]')) return false;
      const parent = node.closest?.('a[href]');
      return parent && route(attr(parent, 'href'))?.shortcode === targetCode;
    });
    const ts = isoTimestamp(attr(time, 'datetime'));
    const caption = text(one(article, 'h1')).slice(0, 3000);
    let likes = null; let comments = null; let views = null;
    for (const node of all(article, 'a, button, [role="button"], span', 5000)) {
      if (!visible(node) || node.closest?.('li, ol, ul, [role="listitem"], [role="list"], h1')) continue;
      const content = text(node);
      if (content.length > 100) continue;
      // Comment likes and arbitrary caption spans are not post engagement totals.
      const control = node.closest?.('a, button, [role="button"]');
      if (control) {
        if (likes === null) likes = labelledCount(content, 'likes?|次赞|赞|个赞|位用户赞了');
        if (comments === null) comments = labelledCount(content, 'comments?|条评论|則留言|则留言');
        if (views === null) views = labelledCount(content, 'views?|plays?|次播放|次观看');
      }
      if (comments === null) {
        const match = content.match(/^(?:View all|查看全部|查看所有)\s*([\d, \u00a0\u202f]+)\s*(?:comments|条评论|則留言|则留言)$/i);
        if (match) comments = numericText(match[1]);
      }
      if (likes === null && /\/liked_by\/?(?:\?|$)/.test(attr(node, 'href'))) likes = numericText(content);
    }
    // A route alone is not a loaded post; retain unknown fields until the post actually renders.
    if (ts !== null || caption || posts.has(targetCode)) {
      const ownerLink = all(one(article, 'header') || article, 'a[href]', 100).map(anchor => route(attr(anchor, 'href'))).find(item => item?.kind === 'profile');
      putPost({shortcode: targetCode, url: current.url, ts, caption, type: current.type || (one(article, 'video') ? '视频' : '图片'),
        likes, comments, views, owner: ownerLink?.username || current.username || '', pinned: false, source: 'dom'});
    }
  }

  // Inspect dedicated UI messages, never caption/comment text when classifying page errors.
  const messages = all(document, '[role="alert"], [role="dialog"], main h2, main h3, [role="main"] h2, [role="main"] h3', 100)
    .filter(visible).filter(node => !node.closest?.('article') && !one(node, 'article, h1, time[datetime]'))
    .map(text).filter(value => value.length <= 600);
  let visiblyLocked = false;
  for (const message of messages) {
    if (/^(?:This account is private|This Account is Private|此账户是私密账户|这是私密账户|此账号为私密账号|这是一个私密账户|此帐号不公开)[.!。]?$/i.test(message)) {
      result.profile.isPrivate = true;
      visiblyLocked = true;
    }
    if (/^(?:Try again later|Please wait a few minutes before you try again|稍后重试|请稍后再试|操作过于频繁|We restrict certain activity)(?:[.!。\s]|$)/i.test(message)) result.state = 'restricted';
    if (/^(?:Sorry, this page isn't available|Sorry, this page is not available|Page isn't available|抱歉，此页面无法访问|无法访问此页面|此页面无法显示)(?:[.!。\s]|$)/i.test(message)) result.state = 'unavailable';
  }
  result.posts = [...posts.values()];
  result.links = [...links.values()];
  if (current.kind === 'post') result.source = result.posts.some(item => item.source === 'embedded') ? 'embedded' : 'dom';
  if (visiblyLocked && result.state === 'loading' && !posts.size && !links.size) result.state = 'private';
  if (result.profile.isPrivate === true) result.timeline.complete = false;
  if (current.kind === 'profile' && result.profile.isPrivate === false && result.profile.totalCount !== null
      && new Set([...links.keys(), ...posts.keys()]).size >= result.profile.totalCount) result.timeline.complete = true;
  if (result.state === 'loading' && (posts.size || links.size || (current.kind === 'profile' && result.profile.totalCount === 0 && result.profile.isPrivate === false))) result.state = 'ready';
  return result;
}
