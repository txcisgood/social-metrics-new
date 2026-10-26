import {COMMENT_STATUS} from './youtube-comments.mjs';
import {parseYouTubeVideoURL} from './youtube-input.mjs';

const PAGE_SIZE = 50;

export function orderComments(comments) {
  const replies = new Map(), roots = new Set(comments.filter(c => !c.parent_id).map(c => c.id));
  for (const comment of comments) if (comment.parent_id) {
    if (!replies.has(comment.parent_id)) replies.set(comment.parent_id, []);
    replies.get(comment.parent_id).push(comment);
  }
  return comments.filter(c => !c.parent_id).flatMap(root => [root, ...(replies.get(root.id) || [])])
    .concat(comments.filter(c => c.parent_id && !roots.has(c.parent_id)));
}

// This view only reads the completed/restored result. Toggling and pagination
// must never initiate API requests or change collected/exported comments.
export function createYouTubeCommentView(panel) {
  const document = panel.ownerDocument, content = panel.querySelector('[data-comment-content]');
  let visible = false, rows = [], meta = {}, busy = false, renderedRows, renderedBusy;
  const positions = new Map();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function render() {
    panel.hidden = !visible;
    if (!visible) { content.replaceChildren(); renderedRows = undefined; return; }
    if (rows === renderedRows && busy === renderedBusy) return;
    renderedRows = rows; renderedBusy = busy;
    content.replaceChildren();
    let message;
    if (busy) message = '正在采集视频和评论。完成或停止后，可在这里查看已取得的内容。';
    else if (!rows.length) message = '采集视频后，可在这里查看每条评论的用户名、内容和回复。';
    else if (meta['采集模式'] !== '视频 URL（含评论）') message = '当前结果未采集评论详情。使用视频 URL 模式采集后可在这里查看。';
    if (message) { content.append(element('p', 'comment-empty', message)); return; }
    const videos = rows.filter(row => Array.isArray(row.comments));
    if (!videos.length) {
      content.append(element('p', 'comment-empty', '本轮未取得评论详情。可在导出报表中查看采集状态与待核对原因。'));
      return;
    }
    videos.forEach((row, index) => {
      const key = row.post_url || String(row.row_no), comments = orderComments(row.comments);
      const byId = new Map(comments.map(c => [c.id, c]));
      const state = positions.get(key) || {page: 0, open: index === 0};
      positions.set(key, state);
      const pages = Math.max(1, Math.ceil(comments.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages - 1);
      const group = element('details', 'comment-video'); group.open = state.open;
      const summary = element('summary', 'comment-video-summary');
      summary.append(element('span', 'comment-video-title', row.post_title || row.video_id || '视频'));
      summary.append(element('span', 'comment-video-count', `${comments.length.toLocaleString('zh-CN')} 条 · ${COMMENT_STATUS[row.comments_status] || '状态待核对'}`));
      group.append(summary);
      const body = element('div', 'comment-video-body'); group.append(body);
      let mounted = false;
      function mount() {
        if (mounted) return;
        mounted = true;
        try {
          const link = element('a', 'comment-video-link', '打开视频');
          link.href = parseYouTubeVideoURL(row.post_url).url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          body.append(link);
        } catch { /* Invalid restored URLs stay plain text. */ }
        if (row.comments_status !== 'COMPLETE') {
          body.append(element('p', 'comment-notice', row.comments_error || COMMENT_STATUS[row.comments_status] || '评论完整性待核对。'));
        }
        if (!comments.length) {
          body.append(element('p', 'comment-empty', row.comments_status === 'COMPLETE' ? '本次未返回可访问的公开评论。' : '暂无已取得的评论内容。'));
          return;
        }
        const list = element('ol', 'comment-list');
        const navigation = element('nav', 'comment-pagination'); navigation.setAttribute('aria-label', '评论分页');
        const previous = element('button', 'button button-secondary', '上一页'); previous.type = 'button';
        const next = element('button', 'button button-secondary', '下一页'); next.type = 'button';
        const status = element('span', 'comment-page-status'); status.setAttribute('role', 'status');
        navigation.append(previous, status, next); body.append(list, navigation);
        let formatter;
        try { formatter = new Intl.DateTimeFormat('zh-CN', {timeZone: meta['判定时区'] || 'UTC', dateStyle: 'medium', timeStyle: 'short'}); } catch { /* Use raw timestamps. */ }
        function showPage() {
          list.start = state.page * PAGE_SIZE + 1;
          list.replaceChildren(...comments.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).map(comment => {
            const item = element('li', `comment-item${comment.parent_id ? ' comment-reply' : ''}`);
            const heading = element('div', 'comment-item-heading');
            const author = element('bdi', 'comment-author', comment.author || '用户不可用');
            const kind = element('span', 'comment-kind', comment.parent_id ? '回复' : '主评论');
            heading.append(author, kind); item.append(heading);
            if (comment.parent_id) {
              const parent = byId.get(comment.parent_id);
              item.append(element('p', 'comment-parent', parent ? `所属主评论：${parent.author || '用户不可用'}` : '所属主评论尚未读取'));
            }
            const text = element('p', 'comment-text', comment.text || '（无文字内容）'); text.dir = 'auto'; item.append(text);
            const timestamp = Date.parse(comment.published_at);
            const time = Number.isFinite(timestamp) && formatter ? formatter.format(timestamp) : comment.published_at || '时间不可用';
            item.append(element('p', 'comment-item-meta', `${time}${comment.like_count !== '' && comment.like_count != null ? ` · 赞 ${comment.like_count}` : ''}`));
            return item;
          }));
          previous.disabled = state.page === 0; next.disabled = state.page === pages - 1;
          status.textContent = `第 ${state.page + 1} / ${pages} 页 · 共 ${comments.length.toLocaleString('zh-CN')} 条`;
        }
        const move = (delta, button) => {
          state.page += delta; showPage();
          // A disabled boundary button cannot retain keyboard focus.
          (button.disabled ? delta > 0 ? previous : next : button).focus({preventScroll: true});
          group.scrollIntoView({block: 'start'});
        };
        previous.addEventListener('click', () => move(-1, previous));
        next.addEventListener('click', () => move(1, next));
        showPage();
      }
      group.addEventListener('toggle', () => { state.open = group.open; if (group.open) mount(); });
      if (group.open) mount();
      content.append(group);
    });
  }
  return {
    setVisible(value) { if (visible !== value) { visible = value; render(); } },
    update(results, runMeta, running) {
      if (results !== rows) positions.clear();
      rows = results; meta = runMeta; busy = running;
      if (!visible) { renderedRows = undefined; return; }
      render();
    },
  };
}
