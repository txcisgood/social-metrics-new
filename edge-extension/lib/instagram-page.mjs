/** Collect only data the normal Instagram pages have actually exposed. */
const MISSING = '未公开或不可用';
const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'legal']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), {code});
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? value : null;

function instagramURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(url.hostname)
        && !url.port && !url.username && !url.password) return url;
  } catch { /* A page URL must be a real, trusted Instagram URL. */ }
  throw failure('BAD_URL', '请检查 Instagram 主页链接。');
}

function usernameFromURL(value) {
  const parts = instagramURL(value).pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !/^[A-Za-z0-9_.]{1,30}$/.test(parts[0]) || RESERVED.has(parts[0].toLowerCase())) {
    throw failure('BAD_URL', '请填写 Instagram 账号主页链接。');
  }
  return parts[0];
}

function postURL(value, shortcode) {
  const url = instagramURL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !['p', 'reel', 'tv'].includes(parts[0]) || parts[1] !== shortcode) {
    throw failure('INVALID_DATA', 'Instagram 帖子链接与内容标识不一致。');
  }
  return `https://www.instagram.com/${parts[0]}/${shortcode}/`;
}

function settings(options) {
  if (!Array.isArray(options?.targetDates) || !options.targetDates.length) throw failure('INVALID_DATA', '请至少选择一个采集日期。');
  const dates = [...new Set(options.targetDates)].sort();
  for (const date of dates) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw failure('INVALID_DATA', '采集日期必须是有效的 YYYY-MM-DD 日期。');
    }
  }
  const maxPages = options.maxPages ?? 5, maxPosts = options.maxPosts ?? 40, scanMode = options.scanMode ?? 'recent';
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50) throw failure('INVALID_DATA', '最大分页数必须在 1 至 50 之间。');
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 1 || maxPosts > 500) throw failure('INVALID_DATA', '每账号详情访问上限必须在 1 至 500 之间。');
  if (!['recent', 'complete'].includes(scanMode)) throw failure('INVALID_DATA', '请选择有效的扫描模式。');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {timeZone: options.timeZone || 'Europe/London', calendar: 'gregory',
      numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'});
  } catch { throw failure('INVALID_DATA', '判定时区无效。'); }
  return {dates, maxPages, maxPosts, scanMode, formatter};
}

function localTime(date, formatter) {
  const p = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function dateLabel(dates) {
  if (dates.length === 1) return dates[0];
  return dates.slice(1).every((date, i) => Date.parse(date) - Date.parse(dates[i]) === 86400000)
    ? `${dates[0]}~${dates.at(-1)}` : dates.join(',');
}

function checkCancelled(signal) {
  if (signal?.aborted) throw failure('CANCELLED', '用户已停止本次采集。');
}

function checkState(snapshot, kind) {
  if (!record(snapshot)) throw failure('INVALID_DATA', 'Instagram 页面返回无效数据。');
  if (snapshot.state === 'login') throw failure('AUTH', '请在 Instagram 完成登录或验证。');
  if (snapshot.state === 'restricted') throw failure('RATE_LIMIT', 'Instagram 暂时限制页面访问。');
  if (snapshot.state === 'unavailable') throw failure('PAGE_UNAVAILABLE', 'Instagram 页面暂时无法访问。');
  if (snapshot.kind !== kind || !['ready', 'loading', 'private'].includes(snapshot.state)) {
    throw failure('INVALID_DATA', 'Instagram 页面内容结构暂时无法确认。');
  }
}

function normalizePost(raw) {
  if (!record(raw) || typeof raw.shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.shortcode)) {
    throw failure('INVALID_DATA', 'Instagram 内容缺少有效链接。');
  }
  const url = postURL(raw.url, raw.shortcode);
  return {shortcode: raw.shortcode, url, ts: timestamp(raw.ts),
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    type: new URL(url).pathname.startsWith('/reel/') ? 'Reels'
      : ['Reels', '视频', '图文轮播', '图片'].includes(raw.type) ? raw.type : MISSING,
    likes: count(raw.likes), comments: count(raw.comments), views: count(raw.views),
    owner: typeof raw.owner === 'string' ? raw.owner.toLowerCase() : null,
    // Produced only by the injected reader after matching this profile's
    // timeline or coauthor membership, never inferred from a bare post page.
    profileMember: raw.profileMember === true,
    pinned: raw.pinned === true, source: raw.source === 'embedded' ? 'embedded' : 'dom'};
}

function merge(previous, current) {
  if (!previous) return current;
  return {...previous, ...current, ts: current.ts ?? previous.ts, caption: current.caption || previous.caption,
    type: previous.type === 'Reels' || current.type === MISSING ? previous.type : current.type,
    likes: current.likes ?? previous.likes, comments: current.comments ?? previous.comments,
    views: current.views ?? previous.views, owner: current.owner ?? previous.owner,
    profileMember: previous.profileMember || current.profileMember,
    pinned: previous.pinned || current.pinned};
}

/** Reader owns normal page navigation, timing and browser permissions; never calls private APIs here. */
export async function collectInstagramPage(account, options, reader) {
  if (!reader || !['openProfile', 'scrollProfile', 'openPost'].every(key => typeof reader[key] === 'function')) {
    throw new TypeError('reader must provide openProfile, scrollProfile and openPost');
  }
  const username = usernameFromURL(account?.url);
  const {dates, maxPages, maxPosts, scanMode, formatter} = settings(options);
  const collected = new Map(), grid = new Set(), triedDetails = new Set(), dateCache = new Map(), targetDates = new Set(dates);
  const metadata = {followers: null, totalCount: null, isPrivate: null};
  let explicitComplete = false, uncertain = false, loading = false;
  let pageCount = 0, detailCount = 0, stopReason = '';
  const base = () => ({row_no: account.row_no, account_name: account.name, platform: 'instagram', profile_url: account.url,
    target_date: dateLabel(dates), status: 'OK', post_title: '', post_url: '', published_local: '', published_utc: '',
    post_type: '', view_count: '', like_count: '', comment_count: '', follower_count: metadata.followers ?? MISSING,
    channel_id: username, fetched_at: localTime(new Date(), formatter), error: '',
    extra: {'备注': [account.note || '', '数据来自 Instagram 正常页面；隐藏指标不计为零'].filter(Boolean).join(' '), '时长': ''}});
  const postDate = post => {
    if (post.ts === null) return null;
    if (!dateCache.has(post.ts)) dateCache.set(post.ts, localTime(new Date(post.ts * 1000), formatter).slice(0, 10));
    return dateCache.get(post.ts);
  };
  const isTarget = post => targetDates.has(postDate(post));
  const hitCount = () => [...collected.values()].filter(isTarget).length;
  const progress = () => {
    try { options.onProgress?.({stage: 'scan', pages: pageCount, details: detailCount,
      discovered: collected.size, posts: hitCount(), ...(stopReason ? {stopReason} : {})}); }
    catch { /* A progress renderer must not interrupt collection. */ }
  };
  const hits = () => [...collected.values()].filter(isTarget).sort((a, b) => b.ts - a.ts).map(post => {
    const date = new Date(post.ts * 1000), caption = post.caption.replace(/\s+/g, ' ').trim();
    return {...base(), post_title: caption ? caption.slice(0, 300) + (caption.length > 300 ? '…' : '') : '（无文字）',
      post_url: post.url, published_local: localTime(date, formatter),
      published_utc: date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC', post_type: post.type,
      like_count: post.likes ?? MISSING, comment_count: post.comments ?? MISSING, view_count: post.views ?? MISSING};
  });
  const listComplete = () => !loading && !uncertain && (metadata.totalCount === null || metadata.totalCount >= collected.size)
    && (explicitComplete || (metadata.totalCount !== null
    && metadata.totalCount === collected.size && (collected.size > 0 || metadata.isPrivate === false)));
  const datesComplete = () => listComplete() && [...collected.values()].every(post => post.ts !== null)
    && (collected.size > 0 || (metadata.totalCount === 0 && metadata.isPrivate === false));

  function absorbProfile(snapshot) {
    const batch = new Set();
    checkState(snapshot, 'profile');
    if (usernameFromURL(snapshot.url).toLowerCase() !== username.toLowerCase()
        || typeof snapshot.profile?.username !== 'string'
        || snapshot.profile.username.toLowerCase() !== username.toLowerCase()) {
      throw failure('INVALID_DATA', 'Instagram 返回的账号与请求账号不一致。');
    }
    loading = snapshot.state === 'loading';
    if (typeof snapshot.profile.isPrivate === 'boolean') metadata.isPrivate = snapshot.profile.isPrivate;
    if (snapshot.state === 'private') metadata.isPrivate = true;
    if (count(snapshot.profile.followers) !== null) metadata.followers = snapshot.profile.followers;
    if (count(snapshot.profile.totalCount) !== null) metadata.totalCount = snapshot.profile.totalCount;
    if (!Array.isArray(snapshot.posts) || !Array.isArray(snapshot.links)) throw failure('INVALID_DATA', 'Instagram 页面列表结构暂时无法确认。');
    if (snapshot.state === 'private' && !snapshot.posts.length && !snapshot.links.length) {
      throw failure('ACCESS_DENIED', '这是私密账号，当前登录账号看不到发布内容。');
    }
    // A grid reference proves a collaboration belongs to this profile even if another creator owns the post.
    for (const raw of snapshot.links) {
      const post = normalizePost(raw);
      grid.add(post.shortcode);
      collected.set(post.shortcode, merge(collected.get(post.shortcode), post));
      batch.add(post.shortcode);
    }
    for (const raw of snapshot.posts) {
      const post = normalizePost(raw);
      if (post.owner && post.owner !== username.toLowerCase() && !grid.has(post.shortcode) && !post.profileMember) { uncertain = true; continue; }
      collected.set(post.shortcode, merge(collected.get(post.shortcode), post));
      batch.add(post.shortcode);
    }
    explicitComplete ||= snapshot.timeline?.complete === true && !loading;
    return [...batch];
  }

  async function processBatch(codes) {
    // Finish the whole current batch before considering a recent-date boundary:
    // a later card may be newer, even after several old or pinned cards.
    const candidates = codes.map(code => collected.get(code)).sort((a, b) => Number(a.ts !== null) - Number(b.ts !== null));
    let refreshed = false;
    for (const original of candidates) {
      const candidate = collected.get(original.shortcode);
      checkCancelled(options.signal);
      if (triedDetails.has(candidate.shortcode)) continue;
      const missingMetrics = isTarget(candidate) && (candidate.likes === null || candidate.comments === null
        || (['Reels', '视频'].includes(candidate.type) && candidate.views === null));
      if (candidate.ts !== null && !missingMetrics) continue;
      if (detailCount >= maxPosts) break;
      triedDetails.add(candidate.shortcode);
      detailCount++;
      progress();
      const snapshot = await reader.openPost(candidate.url, candidate.shortcode);
      checkState(snapshot, 'post');
      postURL(snapshot.url, candidate.shortcode);
      if (!Array.isArray(snapshot.posts)) throw failure('INVALID_DATA', 'Instagram 帖子详情结构暂时无法确认。');
      const raw = snapshot.posts.find(post => post?.shortcode === candidate.shortcode);
      if (!raw) throw failure('INVALID_DATA', 'Instagram 帖子详情与请求内容不一致。');
      const post = normalizePost(raw);
      if (post.owner && post.owner !== username.toLowerCase() && !grid.has(post.shortcode) && !candidate.profileMember) {
        throw failure('INVALID_DATA', 'Instagram 帖子所属账号与请求账号不一致。');
      }
      collected.set(post.shortcode, merge(candidate, post));
      progress();
      checkCancelled(options.signal);
      // The profile can finish its own data request while we read the first
      // detail. Reuse that batch before opening the remaining individual posts.
      if (!refreshed && typeof reader.refreshProfile === 'function') {
        refreshed = true;
        const newCodes = absorbProfile(await reader.refreshProfile());
        const known = new Set(codes);
        for (const code of newCodes) {
          if (!known.has(code)) { known.add(code); codes.push(code); candidates.push(collected.get(code)); }
        }
        progress();
      }
    }
  }

  function recentBoundary(codes) {
    if (scanMode !== 'recent' || loading || uncertain) return false;
    const normal = codes.map(code => collected.get(code)).filter(post => !post.pinned);
    if (normal.length < 3 || normal.some(post => post.ts === null)) return false;
    // Monotonicity is checked across the batch, not just three convenient old
    // posts. This remains a speed heuristic, never evidence of completeness.
    if (!normal.every((post, i) => !i || normal[i - 1].ts >= post.ts)) return false;
    return normal.slice(-3).every(post => postDate(post) < dates[0]);
  }

  try {
    checkCancelled(options.signal);
    let snapshot = await reader.openProfile(username);
    let previous = null;
    while (true) {
      pageCount++;
      const batch = absorbProfile(snapshot);
      progress();
      checkCancelled(options.signal);
      await processBatch(batch);
      const grew = previous === null || [...collected.values()].some(post => !previous.has(post.shortcode)
        || (post.ts !== null && previous.get(post.shortcode) !== post.ts));
      if (datesComplete()) { stopReason = 'complete'; break; }
      if (detailCount >= maxPosts && [...collected.values()].some(post => post.ts === null && !triedDetails.has(post.shortcode))) {
        stopReason = 'detail_limit'; break;
      }
      if (listComplete()) { stopReason = 'date_unavailable'; break; }
      if (recentBoundary(batch)) { stopReason = 'recent_boundary'; break; }
      if (!grew) { stopReason = 'no_progress'; break; }
      if (pageCount >= maxPages) { stopReason = 'page_limit'; break; }
      previous = new Map([...collected.values()].map(post => [post.shortcode, post.ts]));
      checkCancelled(options.signal);
      snapshot = await reader.scrollProfile();
    }
    const rows = hits();
    if (!datesComplete()) {
      const reason = {
        detail_limit: '已达到每账号详情访问上限，仍有帖子的日期无法确认。',
        page_limit: '已达到主页读取批次上限，目标日期尚未查全。',
        date_unavailable: '页面列表已读取，但缺少有效日期或明确的空账号信息，无法确认目标日期。',
        recent_boundary: '当前批已出现连续较早帖子，最近模式已停止继续向历史扫描；完整性仍需核对。',
        no_progress: '继续滚动后没有出现新的帖子链接或有效日期，已停止空滚；目标日期仍未查全。',
      }[stopReason] || '已读取页面中可确认的内容，但尚不能证明目标日期已查全。';
      rows.push({...base(), status: 'FAILED', error_code: 'PAGE_INCOMPLETE', stop_reason: stopReason,
        error: reason, error_title: '目标日期还没有查完',
        error_action: '已读到的帖子会保留。请打开账号主页核对，或调整页面读取和详情访问上限后再试。',
        extra: {...base().extra, '覆盖情况': '未查全', '停止原因': stopReason, '已读取主页批次': pageCount, '已访问详情数': detailCount}});
    } else if (!rows.length) {
      rows.push({...base(), status: 'NO_POST', extra: {...base().extra, '覆盖情况': '已核对完整页面列表'}});
    }
    return rows;
  } catch (cause) {
    const error = cause instanceof Error ? cause : failure('INVALID_DATA', 'Instagram 页面读取未完成。');
    stopReason = error.code === 'CANCELLED' ? 'cancelled' : 'error';
    error.partialRows = hits();
    throw error;
  } finally {
    progress();
    try { options.onDiagnostic?.('scan.completed', {pageCount, detailCount, postCount: hitCount(), reason: stopReason}); }
    catch { /* Diagnostics must not alter the collection outcome. */ }
  }
}
