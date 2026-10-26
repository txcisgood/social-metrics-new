import {localDate, dateRangeLabel} from './jobs.mjs';
import {checkCancelled} from './transport.mjs';
import {resolveChannel, youTubeVideoRow} from './youtube.mjs';
import {parseYouTubeVideoURL} from './youtube-input.mjs';
import {collectYouTubeComments} from './youtube-comments.mjs';
import {keywordFilter} from './youtube-search.mjs';

const problem = (code, message) => Object.assign(new Error(message), {code});
const MODES = {videos: '视频 URL', channel: '频道', keyword: '关键词'};

// Batch explicit inputs without delaying completed videos until the next batch succeeds.
export function createVideoLookup(accounts, request) {
  const ids = accounts.filter(a => a.youtubeMode === 'videos').map(a => parseYouTubeVideoURL(a.url).id);
  const cache = new Map();
  return async id => {
    if (!cache.has(id)) {
      const index = ids.indexOf(id), batch = index < 0 ? [id] : ids.slice(index, index + 50);
      const data = await request('videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: batch.join(',')});
      if (!Array.isArray(data.items)) throw problem('INVALID_DATA', 'YouTube 视频详情结构异常');
      for (const key of batch) cache.set(key, null);
      for (const video of data.items) if (batch.includes(video.id)) cache.set(video.id, video);
    }
    return cache.get(id);
  };
}

export async function collectYouTubeTarget(account, options, request) {
  const mode = account.youtubeMode || 'channel', rows = [], seen = new Set(), cursors = new Set();
  const configuredLimit = options.youtubeLimit ?? 100, maxPages = 50;
  const maxVideos = Math.min(configuredLimit, options.videoBudget?.remaining ?? 100);
  if (!Object.hasOwn(MODES, mode) || !Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100) throw problem('YT_INPUT', '视频上限需为 1–100 的整数。');
  if (maxVideos < 1) throw problem('YT_INCOMPLETE', '本轮已达到视频数量上限，此目标未继续读取。');
  const dates = new Set(options.targetDates || []), filterDates = mode === 'channel' && options.youtubeRange !== 'all';
  const searchFilter = mode === 'keyword' ? keywordFilter(options.youtubeSearchFilter) : null;
  if (filterDates && !dates.size) throw problem('YT_INPUT', '请选择有效的发布时间范围。');
  const base = {row_no: account.row_no, account_name: account.name, platform: 'youtube', profile_url: account.url,
    source_mode: MODES[mode], source_query: mode === 'keyword' ? account.query : '',
    target_date: filterDates ? dateRangeLabel(options.targetDates) : mode === 'videos' ? '指定视频（不限日期）'
      : mode === 'keyword' ? '关键词搜索（不限日期）' : '全部公开视频',
    fetched_at: new Date().toISOString(), extra: {备注: account.note || ''}};
  const checkpoint = async () => { await options.onCheckpoint?.(rows.filter(Boolean)); };
  const progress = stage => options.onProgress?.({stage, posts: rows.filter(r => r?.status === 'OK').length,
    comments: rows.reduce((n, row) => n + (row?.comments?.length || 0), 0), discovered: seen.size});
  const inRange = published => {
    if (!Number.isFinite(Date.parse(published))) throw problem('INVALID_DATA', 'YouTube 发布时间无效');
    return !filterDates || dates.has(localDate(published, options.timeZone));
  };
  const pending = hit => ({...base, video_id: hit.videoId, post_url: `https://www.youtube.com/watch?v=${hit.videoId}`,
    post_title: hit.title || '', published_utc: hit.published || '', detail_status: '未完成', status: 'FAILED',
    error_code: 'YT_DETAIL_PENDING', error: '已发现视频，但详情尚未读取完成。请重新采集该视频。',
    error_title: '视频详情未完成', error_action: '保留已发现的视频链接，稍后重新采集。'});
  async function readDetails(hits) {
    const indexes = hits.map(hit => { rows.push(pending(hit)); return rows.length - 1; });
    await checkpoint();
    for (let start = 0; start < hits.length; start += 50) {
      checkCancelled(options.signal);
      const batch = hits.slice(start, start + 50);
      const data = await request('videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: batch.map(h => h.videoId).join(',')});
      if (!Array.isArray(data.items)) throw problem('INVALID_DATA', 'YouTube 视频详情结构异常');
      const details = new Map(data.items.map(v => [v.id, v]));
      for (let i = 0; i < batch.length; i++) {
        const hit = batch[i], video = details.get(hit.videoId), index = indexes[start + i];
        if (!video) { rows[index] = {...rows[index], error_code: 'YT_VIDEO_UNAVAILABLE', error: '视频详情不可用，可能已删除或设为私密。'}; continue; }
        if (!inRange(video.snippet?.publishedAt || hit.published)) { rows[index] = null; continue; }
        rows[index] = youTubeVideoRow(base, video, hit, options);
      }
      await checkpoint(); progress('details');
    }
  }
  try {
    checkCancelled(options.signal);
    if (mode === 'videos') {
      const {id} = parseYouTubeVideoURL(account.url);
      seen.add(id);
      const video = options.videoLookup ? await options.videoLookup(id)
        : (await request('videos', {part: 'snippet,statistics,contentDetails,liveStreamingDetails', id})).items?.find(v => v.id === id);
      if (!video) throw problem('YT_VIDEO_UNAVAILABLE', '视频详情不可用，可能已删除或设为私密。');
      const row = youTubeVideoRow(base, video, {}, options);
      row.follower_count = '未公开或不可用';
      row.comments = []; row.comments_status = 'RUNNING'; rows.push(row);
      await checkpoint();
      try {
        row.comments = await collectYouTubeComments(id, request, {signal: options.signal, onProgress: async comments => {
          row.comments = comments; progress('comments'); await checkpoint();
        }});
        row.comments_status = 'COMPLETE';
      } catch (error) {
        row.comments = error.partialComments || row.comments;
        row.comments_status = error.code === 'YT_COMMENTS_DISABLED' && !row.comments.length ? 'DISABLED' : error.code === 'YT_COMMENTS_UNAVAILABLE' ? 'UNAVAILABLE' : 'PARTIAL';
        row.comments_error = ({DISABLED: '视频已关闭评论。', UNAVAILABLE: '评论不可访问。', PARTIAL: '评论未读取完整，已取得的内容保留。'})[row.comments_status];
        row.comments_stop_reason = error.stopReason || error.code || 'unknown';
        const reasons = {comment_limit: '达到单视频 10000 条评论保护上限，评论尚未查全。',
          request_limit: '达到单视频 300 次评论请求保护上限，评论尚未查全。',
          cursor_repeat: '评论或回复分页游标重复，已停止，完整性待核对。',
          reply_missing: '实际取得的回复少于接口报告数量，完整性待核对。'};
        if (reasons[error.stopReason]) row.comments_error = reasons[error.stopReason];
        if (['RATE_LIMIT', 'AUTH', 'CANCELLED'].includes(error.code)) throw error;
      }
      await checkpoint(); progress('comments');
      return rows;
    }
    let playlistId, pageToken, complete = false;
    if (mode === 'channel') {
      const channelId = await resolveChannel(account.url, request);
      const channel = (await request('channels', {part: 'snippet,contentDetails,statistics', id: channelId})).items?.[0];
      playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) throw problem('CHANNEL_UNAVAILABLE', '该频道没有可读取的上传列表');
      base.channel_id = channelId; base.channel_title = channel.snippet?.title || '';
      base.follower_count = channel.statistics?.hiddenSubscriberCount ? '未公开' : channel.statistics?.subscriberCount ?? '未公开或不可用';
    }
    for (let page = 0; page < maxPages; page++) {
      checkCancelled(options.signal);
      const data = await request(mode === 'keyword' ? 'search' : 'playlistItems', mode === 'keyword'
        ? {part: 'snippet', type: 'video', q: account.query, maxResults: String(Math.min(50, maxVideos - seen.size)),
          ...searchFilter.parameters, ...(pageToken ? {pageToken} : {})}
        : {part: 'snippet,contentDetails', playlistId, maxResults: '50', ...(pageToken ? {pageToken} : {})});
      if (!Array.isArray(data.items)) throw problem('INVALID_DATA', 'YouTube 视频列表结构异常');
      const hits = [];
      let overflow = false;
      for (const item of data.items) {
        const videoId = mode === 'keyword' ? item.id?.videoId : item.contentDetails?.videoId;
        const published = mode === 'keyword' ? item.snippet?.publishedAt : item.contentDetails?.videoPublishedAt;
        if (!videoId || !published || seen.has(videoId)) continue;
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw problem('INVALID_DATA', 'YouTube 视频 ID 格式错误');
        if (!inRange(published)) continue;
        if (seen.size >= maxVideos) { overflow = true; break; }
        seen.add(videoId); hits.push({videoId, published, title: item.snippet?.title || ''});
        if (options.videoBudget) options.videoBudget.remaining--;
      }
      await readDetails(hits);
      // Compact out-of-range details after the page so checkpoint indexes remain stable.
      for (let i = rows.length - 1; i >= 0; i--) if (!rows[i]) rows.splice(i, 1);
      pageToken = data.nextPageToken;
      if (!pageToken && !overflow) { complete = true; break; }
      if (overflow || seen.size >= maxVideos) break;
      if (cursors.has(pageToken)) throw problem('YT_INCOMPLETE', '分页游标重复，结果尚未查全。');
      cursors.add(pageToken);
    }
    if (!complete) rows.push({...base, status: 'FAILED', error_code: 'YT_INCOMPLETE',
      error: mode === 'keyword' ? '已达到结果或分页上限，搜索可能还有更多结果。' : '已达到视频或分页上限，频道列表尚未读取完整。'});
    if (!rows.length) rows.push({...base, status: 'NO_POST', extra: {...base.extra, 提示: mode === 'keyword'
      ? '本次 API 搜索没有返回符合当前关键词与筛选标签的视频，不代表全网不存在匹配视频。' : '已遍历 API 可访问的上传列表，未发现符合条件的视频。'}});
    await checkpoint();
    return rows;
  } catch (error) {
    error.partialRows = rows.filter(Boolean);
    throw error;
  }
}
