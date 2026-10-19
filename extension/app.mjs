import {readWorkbook, loadAccounts, createResultsWorkbook, createAccountsTemplate, accountTemplateLabel, summarize} from './lib/workbook.mjs';
import {collectInstagramPage} from './lib/instagram-page.mjs';
import {createInstagramPageReader} from './lib/instagram-page-reader.mjs';
import {collectYouTube} from './lib/youtube.mjs';
import {usableInstagramTab, createYouTubeRequest} from './lib/transport.mjs';
import {resolveDates, dateRangeLabel, localDate, runAccounts, failedRow} from './lib/jobs.mjs';
import {describeError} from './lib/errors.mjs';
import {createDiagnostics} from './lib/diagnostics.mjs';
import {persistDiagnostics, latestDiagnostics, clearStoredDiagnostics} from './lib/diagnostic-store.mjs';

const $ = id => document.getElementById(id);
const extension = Boolean(globalThis.chrome?.runtime?.id);
let workbook, accounts = [], warnings = [], results = [], meta = {}, controller;
let inputName = '';
let busy = false, loading = false, requestCount = 0, storageWarned = false;
let activeAccount = null;
let igOperationCount = 0, ytRequestCount = 0, startedAt = 0, elapsedMs = 0, elapsedTimer;
let waitUntil = 0, phaseText = '等待导入账号';
let accountScan = {pages: 0, details: 0, discovered: 0, posts: 0};
let logTimer, logSaveChain = Promise.resolve(), logStorageFailed = false;
const diagnosticEnvironment = {
  version: extension ? chrome.runtime.getManifest().version : 'preview',
  browser: /Edg\/[\d.]+/.exec(navigator.userAgent)?.[0] || /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] || 'unknown',
  platform: navigator.userAgentData?.platform || navigator.platform || 'unknown'
};
let diagnostics = createDiagnostics(diagnosticEnvironment);
const dateFields = ['dateMode', 'days', 'targetDate', 'targetMonth', 'quarterYear', 'quarter', 'startDate', 'endDate', 'timeZone'];
const editedDateFields = new Set();
const dateModeLabels = {days: '最近几天', date: '指定一天', month: '按月', quarter: '按季度', range: '自定义起止日期'};

function dateOptionsFromForm() {
  return {dateMode: $('dateMode').value, days: Number($('days').value), targetDate: $('targetDate').value,
    targetMonth: $('targetMonth').value, quarterYear: Number($('quarterYear').value), quarter: Number($('quarter').value),
    startDate: $('startDate').value, endDate: $('endDate').value, timeZone: $('timeZone').value};
}

function updateDateDefaults() {
  const today = localDate(Date.now(), $('timeZone').value);
  const defaults = {targetDate: today, targetMonth: today.slice(0, 7), quarterYear: today.slice(0, 4),
    quarter: String(Math.ceil(Number(today.slice(5, 7)) / 3)), startDate: today, endDate: today};
  for (const [id, value] of Object.entries(defaults)) if (!editedDateFields.has(id)) $(id).value = value;
}

function renderDatePreview() {
  const preview = $('datePreview'), hint = $('datePreviewHint');
  hint.hidden = true; hint.textContent = '';
  try {
    const options = dateOptionsFromForm(), dates = resolveDates(options);
    preview.textContent = `${dateRangeLabel(dates)} · 共 ${dates.length} 天`;
    preview.dataset.invalid = 'false';
    if (dates.at(-1) >= localDate(Date.now(), options.timeZone)) {
      hint.textContent = '所选日期尚未全部结束，仅能读取目前已发布的内容；保留完整日期范围。';
      hint.hidden = false;
    }
  } catch (error) {
    const info = describeError(error, {stage: 'start'});
    preview.textContent = `${info.title}。${info.action}`;
    preview.dataset.invalid = 'true';
  }
}

function restoreDateOptions(options = {}) {
  for (const id of dateFields) {
    if (options[id] === undefined) continue;
    const element = $(id), value = String(options[id]);
    if (element.tagName === 'SELECT' && !Array.from(element.options).some(option => option.value === value)) continue;
    element.value = value; editedDateFields.add(id);
  }
  updateDateDefaults();
}

function refreshDiagnosticText() {
  if ($('diagnosticsDetails').open) $('diagnosticText').value = diagnostics.text();
}

function recordEvent(event, details = {}, level = 'info') {
  diagnostics.addSecret($('youtubeKey').value);
  const id = diagnostics.record(level, event, details);
  refreshDiagnosticText();
  clearTimeout(logTimer);
  if (!logStorageFailed) logTimer = setTimeout(() => { void flushDiagnostics(); }, 250);
  return id;
}

async function flushDiagnostics() {
  clearTimeout(logTimer);
  if (!extension || logStorageFailed) return;
  const snapshot = diagnostics.snapshot();
  logSaveChain = logSaveChain.then(() => persistDiagnostics(snapshot)).catch(error => {
    if (!logStorageFailed) {
      logStorageFailed = true;
      diagnostics.record('warning', 'diagnostics.storage_failed', {stage: 'storage', error});
      $('logFeedback').textContent = '日志暂时只能保留在本页，请先复制或下载，再关闭页面。';
      refreshDiagnosticText();
    }
  });
  await logSaveChain;
}

function presentProblem(info, id = '') {
  $('problemPanel').hidden = false;
  $('problemTitle').textContent = info.title;
  $('problemMessage').textContent = info.message;
  $('problemAction').textContent = info.action;
  $('problemCode').textContent = `问题编号：${info.code}${id ? ` · 记录 ${id}` : ''}。反馈时请附上诊断日志。`;
}

function log(message) {
  $('logList').querySelector('.log-placeholder')?.remove();
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('logList').append(item);
  while ($('logList').children.length > 300) $('logList').firstChild.remove();
}

function warn(message) {
  const item = document.createElement('li');
  item.textContent = message;
  $('warnings').append(item);
}

function showError(error, stage = 'runtime') {
  const info = describeError(error, {stage, platform: activeAccount?.platform || $('platformSelect').value});
  const id = recordEvent('operation.failed', {stage, error, code: info.code,
    ...(activeAccount ? {row_no: activeAccount.row_no, platform: activeAccount.platform} : {})}, 'error');
  if (!busy) $('statusText').textContent = '需要处理';
  presentProblem(info, id);
  log(`${info.title}。${info.action}`);
  void flushDiagnostics();
}

function guard(action, stage = 'runtime') {
  return async (...args) => { try { await action(...args); } catch (e) { showError(e, stage); } };
}

function renderTiming() {
  const seconds = Math.floor((busy && startedAt ? Date.now() - startedAt : elapsedMs) / 1000);
  $('elapsedText').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('progressText').textContent = busy && waitUntil > Date.now()
    ? `等待 ${Math.ceil((waitUntil - Date.now()) / 1000)} 秒后继续` : phaseText;
}

function setPhase(message) {
  waitUntil = 0; phaseText = message; renderTiming();
}

function renderOperations() {
  $('requestCount').textContent = String(requestCount);
  $('igOperationCount').textContent = String(igOperationCount);
  $('ytRequestCount').textContent = String(ytRequestCount);
}

function syncRunMetrics() {
  elapsedMs = startedAt ? Date.now() - startedAt : elapsedMs;
  meta['页面操作/API请求次数'] = requestCount;
  meta['Instagram页面操作次数'] = igOperationCount;
  meta['YouTube API请求次数'] = ytRequestCount;
  meta['耗时毫秒'] = elapsedMs;
}

function renderScan() {
  $('scanProgress').textContent = activeAccount?.platform === 'youtube' ? '正在读取频道内容和视频指标'
    : `主页 ${accountScan.pages} 批 · 发现 ${accountScan.discovered} 条 · 已开详情 ${accountScan.details} 条 · 目标日期帖子 ${accountScan.posts} 条`;
}

function beginAccount(account) {
  activeAccount = account;
  accountScan = {pages: 0, details: 0, discovered: 0, posts: 0};
  $('accountProgress').textContent = `当前账号：${account.name}`;
  renderScan(); setPhase(account.platform === 'instagram' ? '准备读取主页' : '正在读取 YouTube 频道');
}

function collectionProgress(progress = {}) {
  if (!busy || !activeAccount) return;
  for (const key of ['pages', 'details', 'discovered', 'posts']) {
    if (Number.isSafeInteger(progress[key]) && progress[key] >= 0) accountScan[key] = progress[key];
  }
  renderScan();
}

function readerProgress(value) {
  if (!busy) return;
  const progress = typeof value === 'string' ? {stage: value} : value || {};
  const kind = progress.kind || progress.stage;
  const description = ({profile: '正在读取主页', post: '正在读取帖子详情', profile_scroll: '正在向下检查主页'})[kind] || '正在检查页面内容';
  if (progress.stage === 'waiting' && Number.isFinite(progress.waitMs) && progress.waitMs > 0) {
    waitUntil = Date.now() + progress.waitMs; phaseText = description; renderTiming();
  } else setPhase(description);
}

function renderControls() {
  document.querySelectorAll('.settings-panel input, .settings-panel select, .settings-panel button').forEach(el => { el.disabled = busy || loading; });
  $('startButton').disabled = busy || loading || !extension;
  $('stopButton').disabled = !busy || controller?.signal.aborted;
  $('clearButton').disabled = busy;
  $('clearLogs').disabled = busy;
  $('exportXlsx').disabled = !results.length || busy;
  $('exportJson').disabled = !results.length || busy;
  $('daysField').hidden = $('dateMode').value !== 'days';
  $('dateField').hidden = $('dateMode').value !== 'date';
  $('monthField').hidden = $('dateMode').value !== 'month';
  $('quarterField').hidden = $('dateMode').value !== 'quarter';
  $('rangeField').hidden = $('dateMode').value !== 'range';
  renderDatePreview();
  $('instagramSection').hidden = $('platformSelect').value === 'youtube';
  $('youtubeSection').hidden = $('platformSelect').value === 'instagram';
  $('scanModeField').hidden = $('platformSelect').value === 'youtube';
  $('downloadTemplate').textContent = `下载 ${accountTemplateLabel($('platformSelect').value)}模板`;
  $('scanModeHelp').textContent = $('scanMode').value === 'complete'
    ? '继续向下检查，直到内容读完或达到设置的上限，耗时会更长。'
    : '优先读取目标日期附近的帖子。更早的内容会尽快跳过，未能确认的范围会标记待核对。';
}

// Recognize checkpoints produced before the explicit skipped flag was added.
const wasSkipped = row => row.status === 'FAILED' && (row.skipped === true || row.error?.startsWith('该平台本轮已停止。'));

function renderResults() {
  const s = summarize(results);
  const skippedCount = results.filter(wasSkipped).length;
  $('summaryText').textContent = results.length
    ? `有发布 ${s.okAccounts} 个账号 / ${s.posts} 条内容；无发布 ${s.noPostAccounts} 个账号；待核对 ${s.failedAccounts} 个账号${skippedCount ? `（其中 ${skippedCount} 个因平台暂停未采集）` : ''}`
    : '尚未开始采集';
  $('exportStatus').textContent = busy ? '正在采集。完成或点击停止后，即可下载已取得的结果。'
    : results.length ? `已保留 ${s.posts} 条帖子${s.failedAccounts ? `，${s.failedAccounts} 个账号有待核对项` : ''}。可以下载 Excel 查看。`
      : '从一个账号开始。采集完成或停止后，可下载已取得的结果。';
  renderControls();
}

function applySheet() {
  ({accounts, warnings} = loadAccounts(workbook, $('sheetSelect').value));
  if (!accounts.length && !warnings.length) warnings.push('这张表还没有填写主页链接。请填好账号后保存，再重新导入。');
  $('warnings').replaceChildren(); warnings.forEach(warn);
  $('fileInfo').textContent = `${inputName || '账号文件'}：读取到 ${accounts.length} 个可识别账号。`;
  $('progressText').textContent = `已载入 ${accounts.length} 个账号，按所选平台采集`;
  recordEvent('input.loaded', {stage: 'import', accountCount: accounts.length, warningCount: warnings.length});
}

async function refreshTabs() {
  const previous = $('tabSelect').value;
  $('tabSelect').replaceChildren(new Option('请选择已登录的 Instagram 标签页', ''));
  if (!extension) { $('tabStatus').textContent = '请在 Edge 或 Chrome 中加载此扩展后打开工作台。'; return; }
  const tabs = (await chrome.tabs.query({url: 'https://www.instagram.com/*'})).filter(t => usableInstagramTab(t.url));
  for (const tab of tabs) $('tabSelect').add(new Option(`${tab.title || 'Instagram'}（标签 ${tab.id}）`, String(tab.id)));
  if (tabs.some(t => String(t.id) === previous)) $('tabSelect').value = previous;
  else if (tabs.length === 1) $('tabSelect').value = String(tabs[0].id);
  $('tabStatus').textContent = tabs.length ? '请选择已完成登录的页面。登录是否有效，以实际读取结果为准。' : '未找到可用页面。请在当前浏览器的同一用户配置中打开 Instagram、登录，再刷新标签页。';
  recordEvent('tabs.checked', {stage: 'tabs', count: tabs.length});
}

async function saveSnapshot(snapshot) {
  if (!extension) return;
  try { await chrome.storage.session.set({lastRun: {...snapshot, diagnostics: diagnostics.snapshot()}}); }
  catch (error) {
    if (!storageWarned) {
      warn('临时保存结果失败，请保持工作页开启，完成后立即导出。'); storageWarned = true;
      recordEvent('results.storage_failed', {stage: 'storage', error}, 'warning');
    }
  }
}

function optionsFromForm() {
  const settings = {...dateOptionsFromForm(), maxPages: Number($('maxPages').value), maxPosts: Number($('maxPosts').value),
    minDelay: Number($('minDelay').value), maxDelay: Number($('maxDelay').value), scanMode: $('scanMode').value};
  if (!Number.isInteger(settings.maxPages) || settings.maxPages < 1 || settings.maxPages > 50) throw new Error('分页上限必须在 1 至 50 之间');
  if (!Number.isInteger(settings.maxPosts) || settings.maxPosts < 1 || settings.maxPosts > 500) throw new Error('每账号详情访问上限必须在 1 至 500 之间');
  if (!Number.isFinite(settings.minDelay) || !Number.isFinite(settings.maxDelay) || settings.minDelay < 3 || settings.maxDelay < settings.minDelay || settings.maxDelay > 120) {
    throw new Error('请求间隔需满足：3 ≤ 最短间隔 ≤ 最长间隔 ≤ 120 秒');
  }
  return {...settings, targetDates: resolveDates(settings)};
}

async function startJob() {
  if (busy || loading) return;
  if (!extension) throw new Error('请通过浏览器扩展图标打开工作台');
  if (!navigator.locks) throw new Error('当前浏览器不支持任务锁，请更新浏览器');
  const options = optionsFromForm();
  const selected = accounts.filter(a => $('platformSelect').value === 'all' || a.platform === $('platformSelect').value);
  if (!selected.length) throw new Error('请先导入账号文件，或点击“使用示例”；确认文件中包含所选平台');
  if (selected.length > 500) throw new Error('每次最多采集 500 个账号，请拆分账号表');
  const hasIG = selected.some(a => a.platform === 'instagram'), hasYT = selected.some(a => a.platform === 'youtube');
  const tabId = Number($('tabSelect').value), apiKey = $('youtubeKey').value.trim();
  if (hasIG && (!$('tabSelect').value || !Number.isInteger(tabId))) throw new Error('请先选择已登录的 Instagram 标签页');
  if (hasYT && !apiKey) { $('youtubeSection').open = true; throw new Error('请在 YouTube API 密钥中填写你自己的 API Key'); }
  await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('另一个插件工作页正在采集，请回到该页面查看或停止');
    await flushDiagnostics();
    diagnostics = createDiagnostics({...diagnosticEnvironment, secrets: [apiKey]});
    diagnostics.setContext({...options, startDate: options.targetDates[0], endDate: options.targetDates.at(-1),
      accountCount: selected.length, platform: $('platformSelect').value});
    logStorageFailed = false;
    busy = true; controller = new AbortController(); results = []; requestCount = 0; storageWarned = false;
    igOperationCount = 0; ytRequestCount = 0; startedAt = Date.now(); elapsedMs = 0; waitUntil = 0;
    $('legacyCounter').hidden = true;
    renderOperations();
    elapsedTimer = setInterval(renderTiming, 250);
    let pending = selected.slice(), igReader;
    try {
      $('problemPanel').hidden = true; $('logFeedback').textContent = '';
      $('warnings').replaceChildren(); warnings.forEach(warn); $('logList').replaceChildren();
      $('progressBar').value = 0; $('progressBar').max = selected.length;
      $('requestCount').textContent = '0'; $('statusText').textContent = '采集中';
      setPhase(`准备读取 ${selected[0].name}（共 ${selected.length} 个账号）`);
      meta = {inputName: inputName || '账号文件', '日期模式': dateModeLabels[options.dateMode],
        '目标日期': dateRangeLabel(options.targetDates), '日期天数': options.targetDates.length, '判定时区': options.timeZone,
        '账号数': selected.length, '分页上限': options.maxPages, '详情访问上限': options.maxPosts,
        'Instagram采集方式': options.scanMode === 'recent' ? '按日期快速检查' : '继续检查更多内容', '开始时间': new Date().toISOString(),
        '说明': 'Instagram 读取正常网页；页面操作次数不等于网络请求次数。未查全会另列待核对项。YouTube Shorts 仅按时长提示，需手动核对。'};
      const onRequest = platform => { requestCount++; if (platform === 'instagram') igOperationCount++; else ytRequestCount++; renderOperations(); };
      const onDiagnostic = (event, details) => recordEvent(event,
        {...details, ...(activeAccount ? {row_no: activeAccount.row_no, platform: activeAccount.platform} : {})},
        event.endsWith('failed') || event.endsWith('error') || details.status >= 400 ? 'warning' : 'info');
      igReader = createInstagramPageReader(tabId, {...options, signal: controller.signal,
        onRequest: () => onRequest('instagram'), onDiagnostic, onProgress: readerProgress});
      const ytRequest = createYouTubeRequest(apiKey, {signal: controller.signal, onRequest: () => onRequest('youtube'), onDiagnostic});
      renderResults();
      log(`开始采集 ${selected.length} 个账号；${dateModeLabels[options.dateMode]} ${dateRangeLabel(options.targetDates)}（共 ${options.targetDates.length} 天，${options.timeZone}）`);
      recordEvent('run.started', {stage: 'collect', accountCount: selected.length});
      await saveSnapshot({results, pending: selected, options, meta, running: true});
      results = await runAccounts(selected, options, {
        instagram: (a, o) => { beginAccount(a); return collectInstagramPage(a, {...o, signal: controller.signal,
          onProgress: collectionProgress, onDiagnostic}, igReader); },
        youtube: (a, o) => { beginAccount(a); return collectYouTube(a, o, ytRequest); }
      }, {signal: controller.signal,
        onError: (error, account) => recordEvent('account.failed', {stage: 'collect', platform: account.platform, row_no: account.row_no,
          error, code: describeError(error, {platform: account.platform, stage: 'collect'}).code}, error.code === 'CANCELLED' ? 'info' : 'error'),
        onAccount: async event => {
          results = event.results;
          pending = event.pending;
          syncRunMetrics();
          const skipped = event.rows.every(wasSkipped);
          const state = skipped ? '未采集' : event.rows.some(r => r.status === 'FAILED')
            ? event.rows.some(r => r.status === 'OK') ? '已采集，完整性待核对' : '待核对'
            : event.rows.some(r => r.status === 'OK') ? '有发布' : '无发布';
          const failure = event.rows.find(r => r.status === 'FAILED');
          log(`${event.index}/${event.total} ${event.account.name}：${state}${failure ? `。${failure.error_title}；${failure.error_action}` : ''}`);
          recordEvent('account.completed', {stage: 'collect', row_no: event.account.row_no, platform: event.account.platform,
            index: event.index, total: event.total, status: skipped ? 'SKIPPED' : failure ? 'FAILED' : 'OK', postCount: event.rows.filter(r => r.status === 'OK').length});
          if (failure && !wasSkipped(failure) && failure.error_code !== 'CANCELLED') presentProblem({code: failure.error_code, title: failure.error_title,
            message: '有账号尚未完成采集。请下载 Excel，在“待人工核对”中查看原因；已读到的帖子会保留。', action: failure.error_action}, failure.error_id);
          $('progressBar').value = event.index;
          setPhase(`${event.index} / ${event.total} 个账号已处理${event.pending[0] ? `；接下来：${event.pending[0].name}` : ''}`);
          renderResults();
          await saveSnapshot({results, pending: event.pending, options, meta, running: true});
          activeAccount = null;
      }});
      const s = summarize(results);
      $('statusText').textContent = controller.signal.aborted ? '已停止' : s.failedAccounts ? '完成，存在待核对项' : '采集完成';
    } catch (error) {
      // Even an unexpected renderer/progress failure must leave every account accounted for.
      showError(error, 'collect');
      results.push(...pending.map(a => failedRow(a, options, Object.assign(new Error('任务意外中断，账号尚未完成'), {code: 'INTERRUPTED'}))));
      pending = [];
      $('statusText').textContent = '任务已中断，请查看提示';
    } finally {
      await igReader?.close();
      syncRunMetrics(); clearInterval(elapsedTimer);
      busy = false; activeAccount = null; startedAt = 0; waitUntil = 0; meta['结束时间'] = new Date().toISOString(); renderTiming();
      recordEvent('run.finished', {stage: 'collect', count: requestCount, pendingCount: pending.length,
        igOperationCount, ytRequestCount, elapsedMs,
        status: controller.signal.aborted ? 'cancelled' : results.some(r => r.status === 'FAILED') ? 'needs_review' : 'completed'});
      await saveSnapshot({results, pending, options, meta, running: false});
      await flushDiagnostics();
      renderResults();
      log('本轮结束。请导出结果，并与页面核对内容和指标。');
    }
  });
}

function download(data, mime, filename) {
  const url = URL.createObjectURL(new Blob([data], {type: mime}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const fileTag = () => `社媒采集-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

$('downloadTemplate').addEventListener('click', guard(() => {
  const platform = $('platformSelect').value;
  $('templateFeedback').textContent = '';
  download(XLSX.write(createAccountsTemplate(platform), {bookType: 'xlsx', type: 'array'}),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `社媒采集-${accountTemplateLabel(platform)}账号模板.xlsx`);
  $('templateFeedback').textContent = '已发起模板下载。只需填写主页链接，账号名和平台可以选填。';
  recordEvent('template.export_requested', {stage: 'template', platform, inputFormat: 'xlsx'});
}, 'template'));
$('platformSelect').addEventListener('change', () => { $('templateFeedback').textContent = ''; });

$('inputFile').addEventListener('change', guard(async event => {
  const file = event.target.files[0]; if (!file) return;
  loading = true; accounts = []; workbook = undefined; renderControls();
  try {
    const suffix = file.name.includes('.') ? file.name.split('.').at(-1).toLowerCase() : '';
    recordEvent('input.selected', {stage: 'import', inputFormat: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(suffix) ? suffix : 'unknown', fileSize: file.size});
    if (file.size > 10 * 1024 * 1024) throw new Error('账号文件不能超过 10 MB');
    workbook = readWorkbook(await file.arrayBuffer(), file.name);
    inputName = file.name;
    $('sheetSelect').replaceChildren(...workbook.SheetNames.map(name => new Option(name, name)));
    $('sheetField').hidden = workbook.SheetNames.length <= 1;
    applySheet();
  } finally { loading = false; renderControls(); }
}, 'import'));
$('sheetSelect').addEventListener('change', guard(applySheet, 'import'));
$('sampleButton').addEventListener('click', guard(() => {
  workbook = undefined;
  accounts = [{row_no: 2, name: 'Robin Foxer', url: 'https://www.instagram.com/team_foxer/', platform: 'instagram', note: ''}];
  warnings = []; inputName = '内置单账号示例';
  recordEvent('input.sample_selected', {stage: 'import', platform: 'instagram', accountCount: 1});
  $('inputFile').value = ''; $('sheetField').hidden = true; $('platformSelect').value = 'instagram';
  $('fileInfo').textContent = '已选择示例账号 @team_foxer（1 个 Instagram 账号）。';
  $('warnings').replaceChildren(); $('progressText').textContent = '示例已就绪，选择登录标签页后开始'; renderControls();
}));
$('refreshTabs').addEventListener('click', guard(refreshTabs, 'tabs'));
['platformSelect', 'scanMode'].forEach(id => $(id).addEventListener('change', renderControls));
for (const id of dateFields) $(id).addEventListener('input', () => {
  editedDateFields.add(id);
  if (id === 'timeZone') updateDateDefaults();
  renderControls();
});
$('startButton').addEventListener('click', guard(startJob, 'start'));
$('stopButton').addEventListener('click', () => {
  controller?.abort(); $('statusText').textContent = '正在停止'; renderControls();
  setPhase('正在停止并保留已读取的结果');
  log('已请求停止，正在保留已读取的结果并关闭专用采集标签页。停止后可下载 Excel。');
  recordEvent('run.stop_requested', {stage: 'collect'});
});
$('exportXlsx').addEventListener('click', guard(() => {
  download(XLSX.write(createResultsWorkbook(results, meta), {bookType: 'xlsx', type: 'array'}),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${fileTag()}.xlsx`);
  recordEvent('results.export_requested', {stage: 'export', inputFormat: 'xlsx', count: results.length});
}, 'export'));
$('exportJson').addEventListener('click', guard(() => {
  download(JSON.stringify({meta, results}, null, 2), 'application/json;charset=utf-8', `${fileTag()}.json`);
  recordEvent('results.export_requested', {stage: 'export', inputFormat: 'json', count: results.length});
}, 'export'));
$('clearButton').addEventListener('click', guard(async () => {
  if (busy) return;
  const clear = async () => {
    results = []; meta = {}; requestCount = 0; igOperationCount = 0; ytRequestCount = 0; startedAt = 0; elapsedMs = 0;
    if (extension) await chrome.storage.session.remove('lastRun');
    $('logList').replaceChildren(); $('statusText').textContent = '准备就绪'; $('progressBar').value = 0;
    $('accountProgress').textContent = '当前账号：—'; accountScan = {pages: 0, details: 0, discovered: 0, posts: 0}; renderScan();
    $('legacyCounter').hidden = true; setPhase('结果已清空'); renderOperations(); renderResults();
  };
  if (!extension) return clear();
  await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('另一个工作页正在采集，不能清空其恢复记录');
    await clear();
  });
}, 'storage'));

$('diagnosticsDetails').addEventListener('toggle', refreshDiagnosticText);
$('copyLogs').addEventListener('click', async () => {
  recordEvent('diagnostics.copy_requested', {stage: 'clipboard'});
  try {
    await navigator.clipboard.writeText(diagnostics.text());
    $('logFeedback').textContent = '诊断日志已复制，可以直接粘贴反馈。';
  } catch (error) {
    recordEvent('diagnostics.copy_failed', {stage: 'clipboard', error}, 'warning');
    $('diagnosticsDetails').open = true;
    $('diagnosticText').value = diagnostics.text();
    $('diagnosticText').focus(); $('diagnosticText').select();
    $('logFeedback').textContent = '无法自动复制。日志已选中，请按 ⌘C / Ctrl+C，或点击“下载诊断日志”。';
  }
});
$('downloadLogs').addEventListener('click', () => {
  recordEvent('diagnostics.download_requested', {stage: 'export'});
  try {
    download(diagnostics.text(), 'text/plain;charset=utf-8', `社媒采集-诊断-${diagnostics.id}.txt`);
    $('logFeedback').textContent = '已发起日志下载，请在浏览器下载列表中查看。';
  } catch (error) {
    recordEvent('diagnostics.download_failed', {stage: 'export', error}, 'warning');
    $('diagnosticsDetails').open = true; refreshDiagnosticText();
    $('logFeedback').textContent = '下载未能开始，请点击“复制诊断日志”，或在下方手动复制。';
  }
});
$('clearLogs').addEventListener('click', guard(async () => {
  if (busy) return;
  const clear = async () => {
    clearTimeout(logTimer); await logSaveChain;
    await clearStoredDiagnostics();
    if (extension) {
      const {lastRun} = await chrome.storage.session.get('lastRun');
      if (lastRun) { delete lastRun.diagnostics; await chrome.storage.session.set({lastRun}); }
    }
    diagnostics = createDiagnostics(diagnosticEnvironment); logStorageFailed = false;
    $('logList').replaceChildren(); $('diagnosticText').value = '';
    $('logFeedback').textContent = '已清空旧诊断日志，从现在开始记录。采集结果仍保留。';
    recordEvent('diagnostics.cleared', {stage: 'storage'});
  };
  if (!extension) return clear();
  await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('另一个工作页正在采集，不能清空其诊断日志');
    await clear();
  });
}, 'storage'));
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.__metricsReportError = showError;

async function init() {
  loading = true;
  try {
    updateDateDefaults();
    if (extension && navigator.locks) {
      // A second open tab must not convert the first tab's active task to interrupted.
      await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
        if (!lock) { warn('另一个工作页正在采集，请回到该页面；本页不能同时发起任务。'); return; }
        let saved;
        try { saved = (await chrome.storage.session.get('lastRun')).lastRun; }
        catch (error) { showError(error, 'storage'); }
        try {
          // Export/copy/runtime errors can be newer than the result checkpoint.
          const localLog = await latestDiagnostics(saved?.diagnostics?.id);
          const stamp = snapshot => snapshot?.savedAt || snapshot?.entries?.at(-1)?.at || snapshot?.createdAt || '';
          const previous = [saved?.diagnostics, localLog].filter(Boolean).sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
          if (previous && diagnostics.restore(previous)) {
            $('logFeedback').textContent = '已恢复上次诊断日志，可直接复制或下载。';
          }
          const stored = await chrome.storage.local.get('metrics.bootError');
          if (stored['metrics.bootError']) {
            recordEvent('startup.previous_failure', {stage: 'startup', error: stored['metrics.bootError']}, 'error');
            await chrome.storage.local.remove('metrics.bootError');
          }
        } catch (error) { showError(error, 'storage'); }
        if (saved?.results) {
          results = saved.results; meta = saved.meta || {};
          restoreDateOptions(saved.options);
          if (saved.running) {
            recordEvent('run.recovered_interrupted', {stage: 'restore', pendingCount: saved.pending?.length || 0}, 'warning');
            results.push(...(saved.pending || []).map(a => failedRow(a, saved.options,
              Object.assign(new Error('上次任务因工作页关闭、刷新或中断而未完成'), {code: 'INTERRUPTED'}))));
            meta['说明'] = `${meta['说明'] || ''} 上次运行中断。`;
            await saveSnapshot({...saved, results, meta, pending: [], running: false});
            warn('已恢复中断前的结果；未完成账号标为待核对，不会自动重试。');
          }
          $('statusText').textContent = '已恢复上次结果';
          requestCount = Number(meta['页面操作/API请求次数'] ?? meta['请求次数'] ?? 0) || 0;
          igOperationCount = Number(meta['Instagram页面操作次数']) || 0; ytRequestCount = Number(meta['YouTube API请求次数']) || 0;
          elapsedMs = Number(meta['耗时毫秒']) || 0;
          $('legacyCounter').hidden = Object.hasOwn(meta, 'Instagram页面操作次数') || !requestCount;
          setPhase('可以先导出结果；开始新采集前重新导入账号表'); renderOperations();
        }
      });
    }
    recordEvent('workspace.opened', {stage: 'startup'});
    await refreshTabs();
  } finally { loading = false; renderResults(); }
}
await guard(init, 'startup')();
