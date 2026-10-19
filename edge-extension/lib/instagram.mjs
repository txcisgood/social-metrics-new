/** Instagram collector; all browser access is supplied by request(path). */
export class RateLimitError extends Error {
  constructor(message = 'Instagram 已限流，请停止本轮采集，稍后重试。') {
    super(message);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT';
  }
}

export class AuthError extends Error {
  constructor(message = 'Instagram 登录已失效或需要验证，请在当前浏览器中完成登录或账号验证后重试。') {
    super(message);
    this.name = 'AuthError';
    this.code = 'AUTH';
  }
}

export class FetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchError';
    this.code = 'FETCH_ERROR';
  }
}

const MISSING = '未公开或不可用';
const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function usernameFromURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new FetchError('Instagram 主页链接格式不正确。'); }
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname)
      || url.port || url.username || url.password || segments.length !== 1
      || !/^[A-Za-z0-9_.]{1,30}$/.test(segments[0]) || RESERVED.has(segments[0].toLowerCase())) {
    throw new FetchError('请填写 Instagram 账号主页链接，不能使用帖子或登录页面链接。');
  }
  return segments[0];
}

function count(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function userID(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function firstCount(...values) {
  for (const value of values) {
    const number = count(value);
    if (number !== null) return number;
  }
  return null;
}

function dateFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { throw new FetchError('判定时区无效，请选择有效的 IANA 时区。'); }
}

function localTime(date, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function optionsFor(options) {
  if (!Array.isArray(options?.targetDates) || !options.targetDates.length) {
    throw new FetchError('请至少选择一个采集日期。');
  }
  const dates = [...new Set(options.targetDates)].sort();
  for (const date of dates) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new FetchError('采集日期必须是有效的 YYYY-MM-DD 日期。');
    }
  }
  const maxPages = options.maxPages ?? 5;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new FetchError('最大分页数必须是正整数。');
  return {dates, maxPages, formatter: dateFormatter(options.timeZone || 'Europe/London')};
}

function dateLabel(dates) {
  if (dates.length === 1) return dates[0];
  const consecutive = dates.slice(1).every((date, index) =>
    Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[index]}T00:00:00Z`) === 86400000);
  return consecutive ? `${dates[0]}~${dates.at(-1)}` : dates.join(',');
}

async function readJSON(request, path) {
  // request owns throttling, cancellation, and authenticated browser transport.
  const response = await request(path);
  if (!record(response) || !Number.isInteger(response.status) || typeof response.text !== 'string') {
    throw new FetchError('Instagram 请求返回了无效的响应结构。');
  }
  if (response.status === 429) throw new RateLimitError();
  if (response.status === 401 || response.status === 403) throw new AuthError();
  let payload;
  try { payload = JSON.parse(response.text); } catch {
    if (/<(?:html|form|!doctype)/i.test(response.text)
        && /(?:accounts\/login|log\s?in|sign\s?in|password|checkpoint|challenge)/i.test(response.text)) {
      throw new AuthError();
    }
    if (response.status !== 200) return {status: response.status, payload: null};
    throw new FetchError('Instagram 返回了网页或无效 JSON，无法确认采集结果。');
  }
  if (!record(payload)) throw new FetchError('Instagram 返回了未知的数据结构。');
  const message = [payload.message, payload.error_type].filter(value => typeof value === 'string').join(' ');
  if (payload.challenge || payload.checkpoint_url || payload.login_required === true
      || /(?:login[_ -]?required|challenge[_ -]?required|checkpoint[_ -]?required|consent[_ -]?required|not logged in|please log in)/i.test(message)) {
    throw new AuthError();
  }
  if (/(?:rate[_ -]?limit|too many requests|please wait a few minutes|feedback_required)/i.test(message)) {
    throw new RateLimitError();
  }
  if (response.status === 200 && payload.status === 'fail') {
    throw new FetchError('Instagram 返回失败状态，无法确认目标日期是否完整。');
  }
  return {status: response.status, payload};
}

function updateUser(metadata, raw, username) {
  if (!record(raw)) return;
  if (typeof raw.username === 'string' && raw.username.toLowerCase() !== username.toLowerCase()) {
    throw new FetchError('Instagram 返回的账号与请求账号不一致，已停止该账号采集。');
  }
  metadata.id = userID(raw.id) || userID(raw.pk) || metadata.id;
  const followers = firstCount(raw.edge_followed_by?.count, raw.follower_count);
  if (followers !== null) metadata.followers = followers;
  if (typeof raw.is_private === 'boolean') metadata.isPrivate = raw.is_private;
  const total = firstCount(raw.edge_owner_to_timeline_media?.count, raw.media_count);
  if (total !== null) metadata.totalCount = total;
}

function normalizePost(raw, source) {
  if (!record(raw)) throw new FetchError('Instagram 内容结构无效，无法确认采集完整性。');
  const shortcode = source === 'profile' ? raw.shortcode : raw.code;
  const ts = source === 'profile' ? raw.taken_at_timestamp : raw.taken_at;
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]+$/.test(shortcode)
      || !Number.isSafeInteger(ts) || ts <= 0 || !Number.isFinite(new Date(ts * 1000).getTime())) {
    throw new FetchError('Instagram 内容缺少有效链接或发布时间，无法确认采集完整性。');
  }
  const caption = source === 'profile'
    ? raw.edge_media_to_caption?.edges?.[0]?.node?.text : raw.caption?.text;
  const typename = source === 'profile' ? raw.__typename
    : ({2: 'GraphVideo', 8: 'GraphSidecar'})[raw.media_type];
  const type = raw.product_type === 'clips' ? 'Reels'
    : typename === 'GraphSidecar' ? '图文轮播'
      : (typename === 'GraphVideo' || raw.is_video === true || raw.media_type === 2) ? '视频' : '图片';
  return {
    shortcode, ts, type,
    pinned: raw.is_pinned === true || raw.is_pinned === 1
      || (Array.isArray(raw.pinned_for_users) && raw.pinned_for_users.length > 0),
    caption: typeof caption === 'string' ? caption : '',
    views: source === 'profile' ? firstCount(raw.video_play_count, raw.video_view_count)
      : firstCount(raw.play_count, raw.ig_play_count, raw.view_count),
    likes: source === 'profile' ? count(raw.edge_liked_by?.count) : count(raw.like_count),
    comments: source === 'profile' ? firstCount(raw.edge_media_to_comment?.count, raw.edge_media_to_parent_comment?.count)
      : count(raw.comment_count),
  };
}

function profilePage(raw) {
  const timeline = raw?.edge_owner_to_timeline_media;
  if (timeline === undefined || timeline === null) return null;
  if (!record(timeline) || !Array.isArray(timeline.edges)) {
    throw new FetchError('Instagram 主页内容列表结构未知，无法确认采集完整性。');
  }
  return {
    source: 'profile', posts: timeline.edges.map(edge => normalizePost(edge?.node, 'profile')),
    hasMore: typeof timeline.page_info?.has_next_page === 'boolean' ? timeline.page_info.has_next_page : null,
    cursor: null, // GraphQL end_cursor is deliberately not used for the feed API.
  };
}

function feedPage(payload) {
  if (!record(payload) || !Array.isArray(payload.items)) {
    throw new FetchError('Instagram feed 内容列表结构未知，无法确认采集完整性。');
  }
  const cursor = typeof payload.next_max_id === 'string' ? payload.next_max_id
    : Number.isSafeInteger(payload.next_max_id) ? String(payload.next_max_id) : null;
  return {
    source: 'feed', posts: payload.items.map(item => normalizePost(item, 'feed')),
    hasMore: typeof payload.more_available === 'boolean' ? payload.more_available : null,
    cursor: cursor || null,
  };
}

function mergePosts(collected, posts) {
  for (const post of posts) {
    const previous = collected.get(post.shortcode);
    if (!previous) collected.set(post.shortcode, post);
    else collected.set(post.shortcode, {
      ...post, caption: post.caption || previous.caption,
      views: post.views ?? previous.views, likes: post.likes ?? previous.likes,
      comments: post.comments ?? previous.comments,
      // A feed response may omit the profile's richer Reels classification.
      type: previous.type === 'Reels' ? previous.type : post.type,
    });
  }
}

function coversDates(page, collected, metadata, earliest, formatter) {
  if (!collected.size) {
    if (metadata.isPrivate === true) throw new FetchError('这是私密账号，当前登录账号无法确认其发布内容。');
    if (page.hasMore === false && metadata.isPrivate === false && metadata.totalCount === 0) return true;
    if (page.hasMore === false) throw new FetchError('Instagram 返回空列表，但无法确认该账号确实没有内容。');
    return false;
  }
  if (page.hasMore === false) return true;
  // Ignore pinned posts, and do not infer coverage from an out-of-order page.
  const normal = page.posts.filter(post => !post.pinned);
  return normal.length > 0 && normal.every((post, index) => !index || normal[index - 1].ts >= post.ts)
    && localTime(new Date(normal.at(-1).ts * 1000), formatter).slice(0, 10) < earliest;
}

/** Return PostMetric-compatible rows. Errors are propagated; they are never NO_POST. */
export async function collectInstagram(account, options, request) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  const username = usernameFromURL(account?.url);
  const {dates, maxPages, formatter} = optionsFor(options);
  const metadata = {id: null, followers: null, isPrivate: null, totalCount: null};
  const collected = new Map();
  const seenCursors = new Set();
  let pages = 0;
  let usedFeed = false;
  const profile = await readJSON(request, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  let page = null;
  if (profile.status === 200) {
    const raw = profile.payload?.data?.user;
    if (raw !== null && raw !== undefined && !record(raw)) throw new FetchError('Instagram 账号信息结构无效。');
    updateUser(metadata, raw, username);
    page = profilePage(raw);
  }
  if (page) pages += 1;
  while (true) {
    if (page) {
      mergePosts(collected, page.posts);
      if (coversDates(page, collected, metadata, dates[0], formatter)) break;
    }
    if (pages >= maxPages) throw new FetchError('Instagram 已达到最大分页数，目标日期尚未查全；请增大分页上限。');
    let cursor = null;
    if (page?.source === 'feed') {
      cursor = page.cursor;
      if (!cursor || seenCursors.has(cursor)) throw new FetchError('Instagram 分页游标缺失或重复，目标日期尚未查全。');
      seenCursors.add(cursor);
    }
    if (!metadata.id) {
      const identity = await readJSON(request, `/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`);
      if (identity.status !== 200 || !record(identity.payload?.user)) {
        throw new FetchError('无法获取 Instagram 账号 ID，请确认主页可访问且当前账号已登录。');
      }
      updateUser(metadata, identity.payload.user, username);
      if (!metadata.id) throw new FetchError('Instagram 账号信息缺少有效用户 ID，无法翻页。');
    }
    const path = `/api/v1/feed/user/${metadata.id}/?count=50${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ''}`;
    const feed = await readJSON(request, path);
    if (feed.status !== 200) throw new FetchError(`Instagram feed 请求失败（HTTP ${feed.status}），目标日期尚未查全。`);
    updateUser(metadata, feed.payload?.user, username);
    page = feedPage(feed.payload);
    pages += 1;
    usedFeed = true;
  }
  const posts = [...collected.values()].sort((a, b) => b.ts - a.ts);
  const hits = posts.filter(post => dates.includes(localTime(new Date(post.ts * 1000), formatter).slice(0, 10)));
  const note = [typeof account.note === 'string' ? account.note : '', usedFeed ? '数据来自 feed 分页接口' : ''].filter(Boolean).join(' ');
  const base = {
    row_no: account.row_no, account_name: account.name, platform: 'instagram', profile_url: account.url,
    target_date: dateLabel(dates), status: 'OK', post_title: '', post_url: '', published_local: '',
    published_utc: '', post_type: '', view_count: '', like_count: '', comment_count: '',
    follower_count: metadata.followers ?? MISSING, channel_id: username,
    fetched_at: localTime(new Date(), formatter), error: '', extra: {'备注': note, '时长': ''},
  };
  if (!hits.length) return [{...base, status: 'NO_POST', extra: {
    '备注': note, '提示': posts.length ? `最近一条发布于 ${localTime(new Date(posts[0].ts * 1000), formatter)}` : '',
  }}];
  return hits.map(post => {
    const date = new Date(post.ts * 1000);
    const caption = post.caption.replace(/\s+/g, ' ').trim();
    return {
      ...base, post_title: caption ? caption.slice(0, 300) + (caption.length > 300 ? '…' : '') : '（无文字）',
      post_url: `https://www.instagram.com/p/${post.shortcode}/`,
      published_local: localTime(date, formatter), published_utc: date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
      post_type: post.type, view_count: post.views ?? '', like_count: post.likes ?? MISSING,
      comment_count: post.comments ?? MISSING, extra: {...base.extra},
    };
  });
}
