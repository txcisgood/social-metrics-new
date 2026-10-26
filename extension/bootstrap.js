/* This independent entry still works if the main ES module cannot load. */
(() => {
  const pending = [];
  window.__metricsBootErrors = pending;
  let fallback = null;
  const el = id => document.getElementById(id);
  const safeFailure = (error, code = 'STARTUP_FAILED') => {
    fallback = {schemaVersion: 1, code, at: new Date().toISOString(),
      version: globalThis.chrome?.runtime?.getManifest?.().version || 'unknown',
      name: ['Error', 'SyntaxError', 'TypeError', 'ReferenceError'].includes(error?.name) ? error.name : 'Error',
      stage: 'startup', source: 'app.mjs'};
    el('startButton').disabled = true;
    el('statusText').textContent = '插件未能启动';
    el('problemPanel').hidden = false;
    el('problemTitle').textContent = '插件没有加载完整';
    el('problemMessage').textContent = '采集功能还没有准备好，暂时无法开始任务。';
    el('problemAction').textContent = '请在扩展管理页重新加载插件，再关闭并重新打开工作台。如果仍有问题，请展开“问题排查”复制诊断日志反馈。';
    el('problemCode').textContent = `问题编号：${code}`;
    el('diagnosticText').value = '插件启动诊断（不含账号和登录信息）\n' + JSON.stringify(fallback, null, 2);
    const key = document.body.dataset.module === 'youtube' ? 'metrics.youtubeBootError' : 'metrics.bootError';
    globalThis.chrome?.storage?.local?.set({[key]: fallback}).catch(() => {});
  };
  const report = (error, stage) => {
    if (window.__metricsReportError) window.__metricsReportError(error, stage);
    else pending.push({error, stage});
  };
  window.addEventListener('error', event => {
    if (event.target?.tagName === 'SCRIPT') report(new Error('插件脚本资源未能加载'), 'startup');
    else report(event.error || new Error('页面脚本运行异常'), 'runtime');
  }, true);
  window.addEventListener('unhandledrejection', event => {
    event.preventDefault(); report(event.reason instanceof Error ? event.reason : new Error('未处理的异步操作异常'), 'runtime');
  });
  el('dismissProblem').addEventListener('click', () => { el('problemPanel').hidden = true; });
  document.querySelector('a[href="#troubleshooting"]').addEventListener('click', () => {
    el('troubleshooting').open = true;
  });
  el('copyLogs').addEventListener('click', async () => {
    if (!fallback) return;
    try { await navigator.clipboard.writeText(el('diagnosticText').value); el('logFeedback').textContent = '诊断日志已复制，可以粘贴反馈。'; }
    catch { el('diagnosticsDetails').open = true; el('diagnosticText').focus(); el('diagnosticText').select(); el('logFeedback').textContent = '无法自动复制，请按 ⌘C / Ctrl+C，或下载日志。'; }
  });
  el('downloadLogs').addEventListener('click', () => {
    if (!fallback) return;
    try {
      const url = URL.createObjectURL(new Blob([el('diagnosticText').value], {type: 'text/plain;charset=utf-8'}));
      const a = document.createElement('a'); a.href = url; a.download = '社媒采集-启动诊断.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      el('logFeedback').textContent = '已发起日志下载，请检查浏览器下载列表。';
    } catch { el('logFeedback').textContent = '下载未能开始，请展开日志后手动复制。'; el('diagnosticsDetails').open = true; }
  });
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      if (!window.XLSX) throw new Error('Excel 组件未能加载');
      await import('./app.mjs');
      if (window.__metricsReportError) {
        for (const item of pending.splice(0)) window.__metricsReportError(item.error, item.stage);
      }
    } catch (error) { safeFailure(error); }
  }, {once: true});
})();
