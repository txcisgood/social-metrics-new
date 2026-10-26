import {checkCancelled} from './transport.mjs';

const failure = (message, stopReason = 'invalid_data') => Object.assign(new Error(message), {code: 'YT_COMMENTS_INCOMPLETE', stopReason});
export const COMMENT_STATUS = {COMPLETE: '已完成', RUNNING: '读取中', PARTIAL: '未完成，待核对',
  DISABLED: '评论已关闭', UNAVAILABLE: '评论不可访问', INTERRUPTED: '已中断，待核对'};

// API replies share a top-level parent. Never infer reply-to-reply links from @mentions.
export async function collectYouTubeComments(videoId, request, {signal, onProgress = async () => {}, maxComments = 10000, maxRequests = 300} = {}) {
  const comments = new Map(), roots = new Map();
  let requests = 0;
  const publish = () => onProgress([...comments.values()]);
  const put = (raw, rootId = '') => {
    if (!raw || typeof raw.id !== 'string' || !raw.id || !raw.snippet) throw failure('评论数据不完整，请核对。');
    if (!comments.has(raw.id) && comments.size >= maxComments) throw failure('达到单视频评论保护上限，评论尚未查全。', 'comment_limit');
    const s = raw.snippet;
    if (rootId && s.parentId && s.parentId !== rootId) throw failure('回复所属主评论与请求不一致。');
    comments.set(raw.id, {id: raw.id, parent_id: rootId || '', type: rootId ? '回复' : '主评论',
      author: typeof s.authorDisplayName === 'string' ? s.authorDisplayName : '用户不可用',
      author_channel_id: s.authorChannelId?.value || '', text: typeof s.textDisplay === 'string' ? s.textDisplay : '',
      published_at: s.publishedAt || '', updated_at: s.updatedAt || '', like_count: s.likeCount ?? ''});
  };
  const read = async (endpoint, params) => {
    checkCancelled(signal);
    if (++requests > maxRequests) throw failure('达到单视频评论请求保护上限，评论尚未查全。', 'request_limit');
    const data = await request(endpoint, {...params, maxResults: '100', textFormat: 'plainText'});
    if (!Array.isArray(data.items)) throw failure('评论列表结构异常，无法确认是否读取完整。');
    return data;
  };
  try {
    let pageToken;
    const cursors = new Set();
    do {
      const data = await read('commentThreads', {part: 'snippet,replies', videoId, order: 'time', ...(pageToken ? {pageToken} : {})});
      for (const thread of data.items) {
        const top = thread.snippet?.topLevelComment;
        put(top);
        const count = thread.snippet?.totalReplyCount;
        if (!Number.isSafeInteger(count) || count < 0) throw failure('评论回复数量不可确认。');
        const included = thread.replies?.comments || [];
        if (!Array.isArray(included)) throw failure('评论回复列表结构异常。');
        for (const reply of included) put(reply, top.id);
        const previous = roots.get(top.id);
        roots.set(top.id, {count: Math.max(count, previous?.count || 0)});
      }
      await publish();
      pageToken = data.nextPageToken;
      if (pageToken && cursors.has(pageToken)) throw failure('主评论分页游标重复，评论尚未查全。', 'cursor_repeat');
      if (pageToken) cursors.add(pageToken);
    } while (pageToken);
    for (const [rootId, {count}] of roots) {
      const countReplies = () => [...comments.values()].filter(c => c.parent_id === rootId).length;
      if (countReplies() === count) continue;
      let token;
      const replyCursors = new Set();
      do {
        const data = await read('comments', {part: 'snippet', parentId: rootId, ...(token ? {pageToken: token} : {})});
        for (const reply of data.items) put(reply, rootId);
        await publish();
        token = data.nextPageToken;
        if (token && replyCursors.has(token)) throw failure('回复分页游标重复，回复尚未查全。', 'cursor_repeat');
        if (token) replyCursors.add(token);
      } while (token);
      if (countReplies() < count) throw failure('实际返回的回复少于已报告数量，回复完整性待核对。', 'reply_missing');
    }
    checkCancelled(signal);
    return [...comments.values()];
  } catch (error) {
    error.partialComments = [...comments.values()];
    throw error;
  }
}
