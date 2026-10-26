import {localDate, dateRangeLabel} from './jobs.mjs';

const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const TRAILING = new Set(['videos', 'featured', 'shorts', 'streams', 'playlists', 'community', 'about', 'live', 'podcasts', 'releases', 'search']);
const number = value => value !== undefined && value !== null && /^\d+$/.test(String(value)) ? Number(value) : '未公开或不可用';
const localTime = (value, timeZone) => new Intl.DateTimeFormat('sv-SE', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(value));

export function videoType(details, live) {
  if (live) return live.actualEndTime ? '直播回放' : live.actualStartTime ? '正在直播' : '直播预告';
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(details?.duration || '');
  if (!m) return '视频（类型未确认）';
  const seconds = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  // Data API has no authoritative Shorts field. Do not classify by duration alone.
  return seconds <= 180 ? '疑似 Shorts（需核对）' : '长视频';
}

export async function resolveChannel(url, request) {
  const u = new URL(url);
  if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname) || !['https:', 'http:'].includes(u.protocol)) {
    throw new Error('请使用 YouTube 频道主页或视频链接');
  }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  while (parts.length > 1 && TRAILING.has(parts.at(-1))) parts.pop();
  if (parts[0] === 'channel') {
    if (!CHANNEL.test(parts[1] || '')) throw new Error('YouTube 频道 ID 格式错误');
    return parts[1];
  }
  let video;
  if (u.hostname === 'youtu.be') video = parts[0];
  else if (parts[0] === 'watch') video = u.searchParams.get('v');
  else if (['shorts', 'live', 'embed'].includes(parts[0])) video = parts[1];
  if (video) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(video)) throw new Error('YouTube 视频 ID 格式错误');
    const data = await request('videos', {part: 'snippet', id: video});
    const id = data.items?.[0]?.snippet?.channelId;
    if (!CHANNEL.test(id || '')) throw new Error('视频所属频道不可用，请改用频道主页链接');
    return id;
  }
  const queries = [];
  if (parts[0]?.startsWith('@')) queries.push({forHandle: parts[0]});
  else if (parts[0] === 'user' && parts[1]) queries.push({forUsername: parts[1]}, {forHandle: '@' + parts[1]});
  else if (parts[0] === 'c') throw new Error('请将旧式 /c/ 链接换为 /@用户名 或 /channel/UC... 主页链接');
  else if (parts.length === 1 && !TRAILING.has(parts[0])) queries.push({forHandle: '@' + parts[0]}, {forUsername: parts[0]});
  for (const query of queries) {
    const data = await request('channels', {part: 'id', ...query});
    const id = data.items?.[0]?.id;
    if (CHANNEL.test(id || '')) return id;
  }
  throw new Error('无法解析频道，请使用 /@用户名 或 /channel/UC... 主页链接');
}

export async function collectYouTube(account, options, request) {
  const id = await resolveChannel(account.url, request);
  const channel = (await request('channels', {part: 'contentDetails,statistics', id})).items?.[0];
  const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error('该频道没有可读取的上传列表');
  const base = {row_no: account.row_no, account_name: account.name, platform: 'youtube', profile_url: account.url,
    target_date: dateRangeLabel(options.targetDates), channel_id: id,
    follower_count: channel.statistics?.hiddenSubscriberCount ? '未公开' : number(channel.statistics?.subscriberCount),
    fetched_at: localTime(Date.now(), options.timeZone), extra: {备注: account.note || ''}};
  const start = [...options.targetDates].sort()[0];
  let pageToken, covered = false, older = 0;
  const posts = new Map(), cursors = new Set();
  for (let page = 0; page < options.maxPages; page++) {
    const data = await request('playlistItems', {part: 'contentDetails,snippet', playlistId, maxResults: '50', ...(pageToken ? {pageToken} : {})});
    if (!Array.isArray(data.items)) throw new Error('YouTube 上传列表结构异常，无法确认是否有发布');
    for (const item of data.items) {
      const videoId = item.contentDetails?.videoId, published = item.contentDetails?.videoPublishedAt;
      // Playlist-added time is not publication time. Private/deleted entries may lack both.
      if (!videoId || !published) continue;
      if (!Number.isFinite(Date.parse(published))) throw new Error('YouTube 发布时间无效');
      const date = localDate(published, options.timeZone);
      older = date < start ? older + 1 : 0;
      posts.set(videoId, {videoId, published, date, title: item.snippet?.title || ''});
    }
    if (!data.nextPageToken || older >= 3) { covered = true; break; }
    if (cursors.has(data.nextPageToken)) throw new Error('YouTube 分页游标重复，目标日期未查全');
    cursors.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  if (!covered) throw new Error('YouTube 达到分页上限，尚未覆盖目标日期，请增大上限');
  const hits = [...posts.values()].filter(p => options.targetDates.includes(p.date)).sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  if (!hits.length) return [{...base, status: 'NO_POST', extra: {...base.extra, 提示: '已扫描公开上传列表，目标日期无公开发布'}}];
  const details = new Map();
  try {
    for (let i = 0; i < hits.length; i += 50) {
      const data = await request('videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: hits.slice(i, i + 50).map(p => p.videoId).join(',')});
      if (!Array.isArray(data.items)) throw new Error('YouTube 视频详情结构异常');
      for (const item of data.items) details.set(item.id, item);
    }
  } catch (error) {
    error.partialRows = hits.filter(p => details.has(p.videoId)).map(p => youTubeVideoRow(base, details.get(p.videoId), p, options));
    throw error;
  }
  return hits.map(p => {
    const v = details.get(p.videoId), post_url = `https://www.youtube.com/watch?v=${p.videoId}`;
    if (!v) return {...base, post_url, status: 'FAILED', error: '视频详情不可用，可能已删除或转为私密，请手动核对'};
    return youTubeVideoRow(base, v, p, options);
  });
}

export function youTubeVideoRow(base, video, fallback, options) {
  const published = video.snippet?.publishedAt || fallback.published;
  if (!Number.isFinite(Date.parse(published))) throw Object.assign(new Error('YouTube 发布时间无效'), {code: 'INVALID_DATA'});
  return {...base, status: 'OK', video_id: video.id, post_url: `https://www.youtube.com/watch?v=${video.id}`,
    post_title: video.snippet?.title || fallback.title || '', post_description: video.snippet?.description || '',
    channel_id: video.snippet?.channelId || base.channel_id || '', channel_title: video.snippet?.channelTitle || '',
    published_local: localTime(published, options.timeZone), published_utc: new Date(published).toISOString(),
    post_type: videoType(video.contentDetails, video.liveStreamingDetails), view_count: number(video.statistics?.viewCount),
    like_count: number(video.statistics?.likeCount), comment_count: number(video.statistics?.commentCount),
    detail_status: '已完成',
    extra: {...base.extra, 时长: video.contentDetails?.duration || '', 备注: [base.extra?.备注, '短视频类型仅按时长提示，需核对 Shorts'].filter(Boolean).join('；')}};
}
