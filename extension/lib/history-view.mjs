const STATUS = {completed: '已完成', review: '有待核对', stopped: '已停止', interrupted: '已中断'};

export function createHistoryView(panel, {onDownload, onRemove, onError}) {
  const document = panel.ownerDocument, list = panel.querySelector('[data-history-list]');
  let entries = [], busy = false;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function render() {
    panel.querySelector('[data-history-count]').textContent = `${entries.length} / 5`;
    list.replaceChildren();
    if (!entries.length) {
      list.append(element('li', 'history-empty', '暂无历史记录。采集结束后，会在本机保留最近 5 次采集结果。'));
      return;
    }
    for (const entry of entries) {
      const item = element('li', 'history-entry'); item.dataset.historyId = entry.id;
      const info = element('div', 'history-info');
      const title = `${entry.platform} · ${entry.mode}${entry.filter ? ` · ${entry.filter}` : ''}`;
      info.append(element('strong', 'history-entry-title', title));
      const time = element('time', 'history-time', new Intl.DateTimeFormat('sv-SE', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(new Date(entry.completedAt))); time.dateTime = entry.completedAt;
      info.append(time);
      info.append(element('p', 'history-entry-meta', `${entry.targetCount} 个目标 · ${entry.postCount} 条内容${entry.commentCount ? ` · ${entry.commentCount} 条评论` : ''} · ${STATUS[entry.status] || '待核对'}`));
      if (entry.source) info.append(element('p', 'history-source', entry.source));
      const actions = element('div', 'history-actions');
      for (const [action, label] of [['xlsx', '下载 Excel'], ['json', 'JSON'], ['remove', '删除']]) {
        const button = element('button', 'button button-quiet', label); button.type = 'button';
        button.dataset.historyAction = action; button.disabled = busy;
        button.setAttribute('aria-label', `${label}：${title}，${time.textContent}`);
        button.addEventListener('click', async () => {
          if (busy) return;
          button.disabled = true;
          try { await (action === 'remove' ? onRemove(entry.id) : onDownload(entry.id, action)); }
          catch (error) { onError(error); }
          finally { if (button.isConnected) button.disabled = busy; }
        });
        actions.append(button);
      }
      item.append(info, actions); list.append(item);
    }
  }
  return {
    update(value) { entries = value; render(); },
    unavailable() {
      panel.querySelector('[data-history-count]').textContent = '— / 5';
      list.replaceChildren(element('li', 'history-empty', '暂时无法读取历史记录，请重新打开工作台后重试。'));
    },
    setBusy(value) { busy = value; panel.querySelectorAll('button').forEach(button => { button.disabled = busy; }); },
  };
}
