import {readWorkbook, loadAccounts, loadVideoAccounts, createVideoTemplate, createResultsWorkbook, createVideoResultsWorkbook, createAccountsTemplate, accountTemplateLabel, summarize} from './lib/workbook.mjs';
import {createYouTubeCommentView} from './lib/youtube-comment-view.mjs';
import {exportFileTag, collectionPlatform} from './lib/format.mjs';
import {createHistoryStore} from './lib/history.mjs';
import {createHistoryView} from './lib/history-view.mjs';
import {KEYWORD_FILTERS} from './lib/youtube-search.mjs';
import {collectInstagramPage} from './lib/instagram-page.mjs';
import {createInstagramPageReader} from './lib/instagram-page-reader.mjs';
import {collectYouTube} from './lib/youtube.mjs';
import {collectYouTubeTarget, createVideoLookup} from './lib/youtube-collection.mjs';
import {parseVideoInputs, channelInput} from './lib/youtube-input.mjs';
import {usableInstagramTab, createYouTubeRequest} from './lib/transport.mjs';
import {resolveDates, dateRangeLabel, localDate, runAccounts, failedRow} from './lib/jobs.mjs';
import {describeError} from './lib/errors.mjs';
import {createDiagnostics} from './lib/diagnostics.mjs';
import {createDiagnosticStore} from './lib/diagnostic-store.mjs';
import {workspaceFor, migrateYouTubeResults} from './lib/workspace.mjs';
import {createPreferencesStore, PREFERENCE_FIELDS} from './lib/preferences.mjs';
import {APPEARANCE_CHOICES, createAppearanceController} from './lib/appearance.mjs';
import {initSettingHelp} from './lib/help.mjs';
import {initSelectControls} from './lib/select.mjs';

const $ = id => document.getElementById(id);
const workspace = workspaceFor(document.body.dataset.module);
const RESULT_KEY = workspace.resultKey;
const commentView = workspace.youtube ? createYouTubeCommentView($('commentDetailsPanel')) : null;
const historyStore = createHistoryStore({module: workspace.module});
const historyView = createHistoryView($('historyPanel'), {
  onDownload: downloadHistoricalResult,
  onRemove: async id => { await historyStore.remove(id); await refreshHistory(); historyMessage('已删除这条历史记录。'); },
  onError: error => {
    historyMessage(error.code === 'HISTORY_MISSING' ? '这条历史记录已被清理，列表已更新。' : '历史记录操作未完成，请重试；当前结果仍可下载。', true);
    recordEvent('history.operation_failed', {stage: 'storage', error}, 'warning');
  },
});
const {persistDiagnostics, latestDiagnostics, clearStoredDiagnostics} = createDiagnosticStore({module: workspace.module});
const appearance = createAppearanceController();
const selectControls = initSelectControls();
initSettingHelp();
const editedAppearanceFields = new Set();
function applyAppearance() {
  appearance.update({themeMode: $('themeMode').value, interfaceStyle: $('interfaceStyle').value});
}
const extension = Boolean(globalThis.chrome?.runtime?.id);
let workbook, accounts = [], warnings = [], results = [], meta = {}, controller;
let inputName = '';
let selectedFile = null;
let currentRunId = '';
let workbookKind = 'accounts';
let busy = false, loading = false, requestCount = 0, storageWarned = false;
let activeAccount = null;
let igOperationCount = 0, ytRequestCount = 0, startedAt = 0, elapsedMs = 0, elapsedTimer;
let waitUntil = 0, phaseText = '等待导入账号';
let accountScan = {pages: 0, details: 0, discovered: 0, posts: 0};
let logTimer, logSaveChain = Promise.resolve(), logStorageFailed = false;
const preferences = createPreferencesStore({module: workspace.module});
let preferenceRevision = 0, preferenceStorageFailed = false;
const diagnosticEnvironment = {
  version: extension ? chrome.runtime.getManifest().version : 'preview',
  browser: /Edg\/[\d.]+/.exec(navigator.userAgent)?.[0] || /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] || 'unknown',
  platform: navigator.userAgentData?.platform || navigator.platform || 'unknown'
};
let diagnostics = createDiagnostics(diagnosticEnvironment);
const dateFields = ['dateMode', 'days', 'targetDate', 'targetMonth', 'quarterYear', 'quarter', 'startDate', 'endDate', 'timeZone'];
const editedDateFields = new Set();
const dateModeLabels = {days: '最近几天', date: '指定一天', month: '按月', quarter: '按季度', range: '自定义起止日期'};

const youtubeModule = () => workspace.youtube;
const videoFileMode = () => youtubeModule() && $('youtubeMode').value === 'videos';
const ignoreDates = () => youtubeModule() && ($('youtubeMode').value === 'videos'
  || $('youtubeMode').value === 'keyword'
  || ($('youtubeMode').value === 'channel' && $('youtubeRange').value === 'all'));
function selectedTargets() {
  const platform = $('platformSelect').value;
  if (!workspace.youtube) return accounts.filter(a => a.youtubeMode !== 'videos' && (platform === 'all' || a.platform === platform));
  const mode = $('youtubeMode').value;
  if (mode === 'videos') return $('videoInputSource').value === 'text' ? parseVideoInputs($('videoUrls').value).accounts
    : workbookKind === 'videos' ? accounts.filter(a => a.platform === 'youtube' && a.youtubeMode === 'videos') : [];
  if (mode === 'keyword') {
    const query = $('youtubeKeyword').value.trim();
    return query ? [{row_no: 1, name: '关键词搜索', url: '', query, platform: 'youtube', youtubeMode: 'keyword'}] : [];
  }
  if ($('channelUrl').value.trim()) return [{row_no: 1, name: '频道视频', url: channelInput($('channelUrl').value), platform: 'youtube', youtubeMode: 'channel'}];
  return [];
}

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

function restorePreferences(saved) {
  if (!saved) return;
  for (const id of PREFERENCE_FIELDS) {
    if (saved.settings[id] === undefined || editedAppearanceFields.has(id)) continue;
    const element = $(id); if (!element) continue;
    if (element.type === 'checkbox') element.checked = saved.settings[id];
    else element.value = String(saved.settings[id]);
    if (dateFields.includes(id)) editedDateFields.add(id);
  }
  applyAppearance();
  selectControls.refresh();
  $('rememberYoutubeKey').checked = saved.rememberYoutubeKey;
  $('youtubeKey').value = saved.youtubeKey || '';
  diagnostics.addSecret($('youtubeKey').value);
  $('preferencesFeedback').textContent = workspace.youtube ? '已恢复本模块配置。视频链接或关键词需重新填写。' : '已恢复上次配置。账号文件需重新选择。';
  renderKeyPreference(saved);
}

function renderKeyPreference(saved) {
  $('rememberYoutubeKey').checked = saved.rememberYoutubeKey;
  $('youtubeKeyFeedback').textContent = saved.youtubeKey ? '密钥已保存在当前浏览器，下次会自动填入。'
    : saved.rememberYoutubeKey ? '填写后自动保存在本机。' : '密钥仅供当前页面使用，关闭后需要重新填写。';
}

function preferenceFailure(reading = false) {
  $('preferencesFeedback').textContent = reading ? '暂时无法读取上次配置。可先填写后采集，重新打开工作页可重试读取。'
    : '配置暂未保存成功。可继续采集；请保留本页，并重新操作未保存的设置。';
  $('preferencesFeedback').dataset.error = 'true';
  $('youtubeKeyFeedback').textContent = reading ? '暂时无法恢复已保存的密钥，可在本页重新填写。'
    : '本机保存或清除尚未成功，请重试；当前输入仍可用于采集。';
  if (!preferenceStorageFailed) {
    preferenceStorageFailed = true;
    // Storage exceptions may contain provider details. Do not log the failed
    // preference object or its key, even when diagnostics are unavailable.
    recordEvent('preferences.storage_failed', {stage: 'storage'}, 'warning');
  }
}

async function savePreferences(patch) {
  if (!extension) return;
  diagnostics.addSecret($('youtubeKey').value);
  const revision = ++preferenceRevision;
  $('preferencesFeedback').textContent = '正在保存配置…';
  $('preferencesFeedback').dataset.error = 'false';
  try {
    const saved = await preferences.update(patch);
    preferenceStorageFailed = false;
    if (revision !== preferenceRevision) return;
    $('preferencesFeedback').textContent = '配置已保存在当前浏览器，下次打开会自动恢复。';
    renderKeyPreference(saved);
  } catch {
    if (revision === preferenceRevision) preferenceFailure();
  }
}

function settingChanged(id) {
  const isAppearance = Object.hasOwn(APPEARANCE_CHOICES, id);
  if (isAppearance) {
    editedAppearanceFields.add(id);
    applyAppearance();
  }
  if (loading && !isAppearance) return;
  const incomplete = message => {
    preferenceRevision++;
    $('preferencesFeedback').textContent = message;
    $('preferencesFeedback').dataset.error = 'true';
  };
  let settings;
  if (dateFields.includes(id)) {
    settings = dateOptionsFromForm();
    try { resolveDates(settings); }
    catch { incomplete('请补全有效的日期范围，随后会自动保存。'); return; }
  } else if (id === 'minDelay' || id === 'maxDelay') {
    settings = {minDelay: Number($('minDelay').value), maxDelay: Number($('maxDelay').value)};
    if (settings.minDelay < 3 || settings.maxDelay > 120 || settings.minDelay > settings.maxDelay ||
        !Number.isFinite(settings.minDelay) || !Number.isFinite(settings.maxDelay)) {
      incomplete('请补全有效的操作间隔，随后会自动保存。'); return;
    }
  } else {
    const element = $(id);
    if (!element.checkValidity() || !element.value) {
      incomplete('请补全有效的设置，随后会自动保存。'); return;
    }
    settings = {[id]: element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value};
  }
  void savePreferences({settings});
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
  if (workspace.youtube) { $('scanProgress').textContent = busy ? '正在读取视频数据与公开指标' : '视频数量与评论读取进度将在采集时显示'; return; }
  $('scanProgress').textContent = activeAccount?.platform === 'youtube' ? '正在读取频道内容和视频指标'
    : `主页 ${accountScan.pages} 批 · 发现 ${accountScan.discovered} 条 · 已开详情 ${accountScan.details} 条 · 目标日期帖子 ${accountScan.posts} 条`;
}

function beginAccount(account) {
  activeAccount = account;
  accountScan = {pages: 0, details: 0, discovered: 0, posts: 0};
  $('accountProgress').textContent = `当前${account.youtubeMode ? '目标' : '账号'}：${account.name}`;
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

function renderFilePicker() {
  const picker = $('filePicker'), hasFile = Boolean(selectedFile);
  const state = selectedFile?.state || 'empty';
  picker.dataset.state = state;
  $('uploadFileIcon').toggleAttribute('hidden', hasFile);
  $('selectedFileIcon').toggleAttribute('hidden', !hasFile);
  $('filePickerTitle').textContent = selectedFile?.name || (videoFileMode() ? '选择视频链接表格' : '选择用户主页表格');
  const description = $('filePickerDescription');
  if (!hasFile) description.textContent = 'Excel、CSV 或 TSV · 最大 10 MB';
  else if (state === 'loading') description.textContent = '正在读取表格…';
  else if (state === 'error') description.textContent = '读取失败，请重新选择文件';
  else if (state === 'review') description.textContent = '未识别到可采集数据，请检查第一张表';
  else {
    const size = selectedFile.size < 1024 * 1024 ? `${Math.max(1, Math.round(selectedFile.size / 1024))} KB`
      : `${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB`;
    description.textContent = `已导入 ${accounts.length} ${workbookKind === 'videos' ? '条视频链接' : '个账号'} · ${size}`;
  }
  $('filePickerAction').hidden = !hasFile || state === 'loading';
  $('fileInfo').classList.toggle('sr-only', hasFile);
}

function renderControls() {
  historyView.setBusy(busy || loading);
  if (workspace.youtube) $('platformSelect').value = 'youtube';
  document.querySelectorAll('.settings-panel input, .settings-panel textarea, .settings-panel select, .settings-panel button:not([data-help-trigger])').forEach(el => { el.disabled = loading || (busy && !el.hasAttribute('data-presentation-control')); });
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
  const yt = youtubeModule(), mode = $('youtubeMode').value, videos = yt && mode === 'videos';
  commentView?.setVisible(videos && $('showCommentDetails').checked);
  $('platformField').hidden = yt;
  $('sampleButton').hidden = yt;
  $('inputTitle').textContent = yt ? '采集目标' : '平台与账号';
  $('youtubeModes').hidden = !yt;
  $('youtubeVideoInput').hidden = !videos;
  $('youtubeChannelInput').hidden = !yt || mode !== 'channel';
  $('youtubeKeywordInput').hidden = !yt || mode !== 'keyword';
  $('timeSection').hidden = yt && mode === 'keyword';
  const filter = $('youtubeSearchFilter').value;
  document.querySelectorAll('[data-keyword-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.keywordFilter === filter)));
  $('keywordFilterHelp').textContent = (KEYWORD_FILTERS[filter] || KEYWORD_FILTERS.all).help;
  $('youtubeLimitField').hidden = videos;
  $('videoTextField').hidden = $('videoInputSource').value !== 'text';
  $('tableInput').hidden = yt && (!videos || $('videoInputSource').value !== 'file');
  renderFilePicker();
  $('downloadTemplate').textContent = videos ? '下载视频 URL 模板' : `下载 ${accountTemplateLabel($('platformSelect').value)}模板`;
  $('dateFilterFields').hidden = ignoreDates();
  $('datePreviewBox').hidden = ignoreDates();
  $('dateTitle').textContent = ignoreDates() ? '时间显示（不限发布日期）' : '时间范围';
  $('pageLimitField').hidden = yt;
  $('collectionAdvanced').hidden = yt;
  $('scanModeHelp').textContent = $('scanMode').value === 'complete'
    ? '继续向下检查，直到内容读完或达到设置的上限，耗时会更长。'
    : '优先读取目标日期附近的帖子。更早的内容会尽快跳过，未能确认的范围会标记待核对。';
  if ($('instagramAdvanced')) $('instagramAdvanced').hidden = $('platformSelect').value === 'youtube';
  renderWorkspaceState();
  selectControls.refresh();
}

// Recognize checkpoints produced before the explicit skipped flag was added.
const wasSkipped = row => row.status === 'FAILED' && (row.skipped === true || row.error?.startsWith('该平台本轮已停止。'));

function renderWorkspaceState() {
  const platform = $('platformSelect').value;
  let selected = [];
  try { selected = selectedTargets(); } catch { /* Input validation happens before requests. */ }
  const summary = summarize(results);
  const accountKey = row => JSON.stringify([row.platform, row.row_no]);
  const represented = new Set(results.map(accountKey));
  // Pending accounts receive diagnostic rows on cancellation/recovery. They
  // belong in the review count, but must not inflate collection progress.
  const processed = new Set(results.filter(row => row.status === 'OK' || row.status === 'NO_POST' ||
    (row.status === 'FAILED' && !wasSkipped(row) && !['CANCELLED', 'INTERRUPTED'].includes(row.error_code))).map(accountKey));
  const hasRun = busy || results.length > 0;
  const targetLabel = workspace.youtube ? '目标' : '账号';
  const savedTotal = Number(meta['账号数']);
  const total = hasRun ? Math.max(Number.isSafeInteger(savedTotal) && savedTotal > 0 ? savedTotal : 0, represented.size)
    : selected.length;
  const stopped = hasRun && (controller?.signal.aborted || results.some(row => row.error_code === 'CANCELLED'));
  const state = busy ? 'running' : results.length ? stopped ? 'stopped' : summary.failedAccounts ? 'review' : 'complete'
    : selected.length ? 'ready' : 'idle';
  const text = (id, value) => { if ($(id)) $(id).textContent = value; };
  document.body.dataset.state = state;
  document.body.dataset.platform = platform;
  text('metricPosts', String(summary.posts));
  text('metricAccounts', String(processed.size));
  text('metricReview', String(summary.failedAccounts));
  text('accountTotalHint', total ? `共 ${total} 个${targetLabel}` : targetLabel === '账号' ? '等待导入账号' : '等待准备采集目标');
  text('metricAccountLabel', `已处理${targetLabel}`);
  text('metricReviewLabel', `待核对${targetLabel}`);
  text('progressPercent', `${total ? Math.min(100, Math.floor(processed.size / total * 100)) : 0}%`);
  text('progressStage', busy ? stopped ? '正在停止' : '正在采集' : state === 'complete' ? '结果已就绪'
    : ['review', 'stopped'].includes(state) ? '请核对结果' : '待开始');
  text('inputSummary', workspace.youtube ? busy ? `本轮采集 ${total} 个目标` : selected.length ? `已准备 ${selected.length} 个采集目标` : '填写频道、关键词或导入视频链接'
    : busy ? `本轮采集 ${total} 个账号` : selected.length ? `已选 ${selected.length} 个账号，准备开始采集`
    : accounts.length ? '当前文件没有所选平台的账号' : workbook ? '当前工作表暂无可采集账号' : '尚未导入账号');
  if (!busy && results.length) {
    setPhase(state === 'stopped' ? `采集已停止，已处理 ${processed.size} / ${total} 个${targetLabel}；已读结果可导出`
      : state === 'review' ? `本轮已结束，已处理 ${processed.size} / ${total} 个${targetLabel}；${summary.failedAccounts} 个${targetLabel}待核对`
        : `采集已完成，${processed.size} 个${targetLabel}的结果可导出`);
  }
  // Keep the denominator tied to the retained run when a new input is loaded.
  // The selected-file summary above independently describes the next run.
  $('progressBar').max = total || 1;
  $('progressBar').value = processed.size;
  $('progressBar').setAttribute('aria-valuetext', `${processed.size} / ${total} 个${targetLabel}已处理${stopped ? '，采集已停止' : ''}`);
  const currentStep = busy ? 'workflowCollect' : results.length ? 'workflowExport' : 'workflowSetup';
  const stepIds = ['workflowSetup', 'workflowCollect', 'workflowExport'];
  for (const [index, id] of stepIds.entries()) {
    const element = $(id);
    if (!element) continue;
    element.dataset.status = id === 'workflowCollect' && ['review', 'stopped'].includes(state) ? 'review'
      : index < stepIds.indexOf(currentStep) ? 'complete' : id === currentStep ? 'current' : 'pending';
    if (id === currentStep) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  }
}

function renderResults() {
  commentView?.update(results, meta, busy);
  const s = summarize(results);
  const unit = meta['采集模式'] ? '目标' : '账号';
  const skippedCount = results.filter(wasSkipped).length;
  $('summaryText').textContent = results.length
    ? `有结果 ${s.okAccounts} 个${unit} / ${s.posts} 条内容；无结果 ${s.noPostAccounts} 个${unit}；待核对 ${s.failedAccounts} 个${unit}${skippedCount ? `（其中 ${skippedCount} 个因平台暂停未采集）` : ''}`
    : '尚未开始采集';
  $('exportStatus').textContent = busy ? workspace.youtube ? '正在采集视频。完成后自动下载 Excel，停止后可手动导出已有结果。' : '正在采集。完成或点击停止后，即可下载已取得的结果。'
    : results.length ? `已保留 ${s.posts} 条内容${s.failedAccounts ? `，${s.failedAccounts} 个${unit}有待核对项` : ''}。可以下载 Excel 查看。`
      : workspace.youtube ? '填写视频链接、频道主页或关键词，完成后自动生成 Excel。' : '从一个账号开始。采集完成或停止后，可下载已取得的结果。';
  renderControls();
}

function applyFirstSheet() {
  ({accounts, warnings} = (workbookKind === 'videos' ? loadVideoAccounts : loadAccounts)(workbook));
  if (!accounts.length && !warnings.length) warnings.push(workbookKind === 'videos' ? '这张表还没有填写视频链接。请填好后重新导入。' : '这张表还没有填写主页链接。请填好账号后保存，再重新导入。');
  $('warnings').replaceChildren(); warnings.forEach(warn);
  $('fileInfo').textContent = `${inputName || '输入文件'}：读取到 ${accounts.length} ${workbookKind === 'videos' ? '条视频链接' : '个可识别账号'}。`;
  if (selectedFile) selectedFile.state = accounts.length ? 'ready' : 'review';
  if (!results.length) setPhase(`已载入 ${accounts.length} 个账号，按所选平台采集`);
  recordEvent('input.loaded', {stage: 'import', accountCount: accounts.length, warningCount: warnings.length});
  renderControls();
}

async function refreshTabs() {
  const previous = $('tabSelect').value;
  $('tabSelect').replaceChildren(new Option('请选择已登录的 Instagram 标签页', ''));
  selectControls.refresh();
  try {
    if (!extension) { $('tabStatus').textContent = '请在 Edge 或 Chrome 中加载此扩展后打开工作台。'; return; }
    const tabs = (await chrome.tabs.query({url: 'https://www.instagram.com/*'})).filter(t => usableInstagramTab(t.url));
    for (const tab of tabs) $('tabSelect').add(new Option(`${tab.title || 'Instagram'}（标签 ${tab.id}）`, String(tab.id)));
    if (tabs.some(t => String(t.id) === previous)) $('tabSelect').value = previous;
    else if (tabs.length === 1) $('tabSelect').value = String(tabs[0].id);
    $('tabStatus').textContent = tabs.length ? '请选择已完成登录的页面。登录是否有效，以实际读取结果为准。' : '未找到可用页面。请在当前浏览器的同一用户配置中打开 Instagram、登录，再刷新标签页。';
    recordEvent('tabs.checked', {stage: 'tabs', count: tabs.length});
  } finally { selectControls.refresh(); }
}

async function saveSnapshot(snapshot) {
  if (!extension) return;
  try { await chrome.storage.session.set({[RESULT_KEY]: {...snapshot, runId: snapshot.runId || currentRunId, diagnostics: diagnostics.snapshot()}}); }
  catch (error) {
    if (!storageWarned) {
      warn('临时保存结果失败，请保持工作页开启，完成后立即导出。'); storageWarned = true;
      recordEvent('results.storage_failed', {stage: 'storage', error}, 'warning');
    }
  }
}

function historyMessage(text = '', failed = false) {
  $('historyFeedback').textContent = text;
  $('historyFeedback').hidden = !text;
  $('historyFeedback').dataset.error = String(failed);
}
async function refreshHistory() {
  if (!extension) { historyView.update([]); return; }
  try { historyView.update(await historyStore.list()); }
  catch (error) {
    historyView.unavailable();
    historyMessage('暂时无法读取历史记录，请重新打开工作台后重试。', true);
    recordEvent('history.read_failed', {stage: 'storage', error}, 'warning');
  }
}
async function archiveRun(status, onlyIfMissing = false) {
  if (!extension || !results.length || !currentRunId) return;
  try {
    if (onlyIfMissing && (await historyStore.list()).some(record => record.id === currentRunId)) return;
    await historyStore.save({id: currentRunId, meta, results, status});
    historyMessage(); await refreshHistory();
  } catch (error) {
    historyMessage('本次历史记录保存失败，请先下载当前结果。已有历史记录仍保留。', true);
    recordEvent('history.save_failed', {stage: 'storage', error}, 'warning');
  }
}

function optionsFromForm() {
  const settings = {...dateOptionsFromForm(), maxPages: Number($('maxPages').value), maxPosts: Number($('maxPosts').value),
    minDelay: Number($('minDelay').value), maxDelay: Number($('maxDelay').value), scanMode: $('scanMode').value};
  if (!youtubeModule() && (!Number.isInteger(settings.maxPages) || settings.maxPages < 1 || settings.maxPages > 50)) throw new Error('分页上限必须在 1 至 50 之间');
  if (!youtubeModule() && (!Number.isInteger(settings.maxPosts) || settings.maxPosts < 1 || settings.maxPosts > 500)) throw new Error('每账号详情访问上限必须在 1 至 500 之间');
  if (!youtubeModule() && (!Number.isFinite(settings.minDelay) || !Number.isFinite(settings.maxDelay) || settings.minDelay < 3 || settings.maxDelay < settings.minDelay || settings.maxDelay > 120)) {
    throw new Error('请求间隔需满足：3 ≤ 最短间隔 ≤ 最长间隔 ≤ 120 秒');
  }
  const youtubeSettings = {youtubeMode: $('youtubeMode').value, youtubeRange: $('youtubeRange').value,
    youtubeSearchFilter: $('youtubeSearchFilter').value,
    youtubeLimit: videoFileMode() ? 100 : Number($('youtubeLimit').value)};
  if (youtubeModule() && youtubeSettings.youtubeMode === 'keyword' && !Object.hasOwn(KEYWORD_FILTERS, youtubeSettings.youtubeSearchFilter)) {
    throw Object.assign(new Error('请选择有效的关键词筛选标签'), {code: 'YT_INPUT'});
  }
  if (youtubeModule() && (!Number.isInteger(youtubeSettings.youtubeLimit) || youtubeSettings.youtubeLimit < 1 || youtubeSettings.youtubeLimit > 100)) throw Object.assign(new Error('视频上限需为 1–100 的整数'), {code: 'YT_INPUT'});
  // URL, keyword and all-date channel modes do not inherit hidden date errors.
  const targetDates = ignoreDates() ? (localDate(Date.now(), settings.timeZone), []) : resolveDates(settings);
  return {...settings, ...youtubeSettings, targetDates};
}

async function startJob() {
  if (busy || loading) return;
  if (!extension) throw new Error('请通过浏览器扩展图标打开工作台');
  if (!navigator.locks) throw new Error('当前浏览器不支持任务锁，请更新浏览器');
  const options = optionsFromForm();
  const selected = selectedTargets();
  const runWarnings = videoFileMode() && $('videoInputSource').value === 'text' ? parseVideoInputs($('videoUrls').value).warnings
    : youtubeModule() && (options.youtubeMode === 'keyword' || $('channelUrl').value.trim()) ? [] : warnings;
  if (youtubeModule() && !selected.length) throw Object.assign(new Error('请填写当前模式的采集目标'), {code: 'YT_INPUT'});
  if (youtubeModule() && options.youtubeMode === 'videos' && selected.length > 100) throw Object.assign(new Error('每轮最多 100 条视频 URL'), {code: 'YT_INPUT'});
  if (!selected.length) throw new Error('请先导入账号文件，或点击“使用示例”；确认文件中包含所选平台');
  if (selected.length > 500) throw new Error('每次最多采集 500 个账号，请拆分账号表');
  const hasIG = selected.some(a => a.platform === 'instagram'), hasYT = selected.some(a => a.platform === 'youtube');
  const tabId = Number($('tabSelect').value), apiKey = $('youtubeKey').value.trim();
  if (hasIG && (!$('tabSelect').value || !Number.isInteger(tabId))) throw new Error('请先选择已登录的 Instagram 标签页');
  if (hasYT && !apiKey) { $('youtubeSection').open = true; throw new Error('请在 YouTube API 密钥中填写你自己的 API Key'); }
  await preferences.flush();
  await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('另一个插件工作页正在采集，请回到该页面查看或停止');
    await flushDiagnostics();
    diagnostics = createDiagnostics({...diagnosticEnvironment, secrets: [apiKey]});
    diagnostics.setContext({...options, startDate: options.targetDates[0], endDate: options.targetDates.at(-1),
      accountCount: selected.length, platform: $('platformSelect').value});
    logStorageFailed = false;
    busy = true; controller = new AbortController(); results = []; requestCount = 0; storageWarned = false;
    currentRunId = crypto.randomUUID();
    igOperationCount = 0; ytRequestCount = 0; startedAt = Date.now(); elapsedMs = 0; waitUntil = 0;
    $('legacyCounter').hidden = true;
    renderOperations();
    elapsedTimer = setInterval(renderTiming, 250);
    let pending = selected.slice(), igReader;
    try {
      $('problemPanel').hidden = true; $('logFeedback').textContent = '';
      $('warnings').replaceChildren(); runWarnings.forEach(warn); $('logList').replaceChildren();
      $('progressBar').value = 0; $('progressBar').max = selected.length;
      $('requestCount').textContent = '0'; $('statusText').textContent = '采集中';
      setPhase(`准备读取 ${selected[0].name}（共 ${selected.length} 个账号）`);
      meta = {inputName: inputName || '账号文件', '日期模式': dateModeLabels[options.dateMode],
        '采集平台': collectionPlatform(selected),
        '目标日期': dateRangeLabel(options.targetDates), '日期天数': options.targetDates.length, '判定时区': options.timeZone,
        '账号数': selected.length, '分页上限': options.maxPages, '详情访问上限': options.maxPosts,
        'Instagram采集方式': options.scanMode === 'recent' ? '按日期快速检查' : '继续检查更多内容', '开始时间': new Date().toISOString(),
        '说明': 'Instagram 读取正常网页；页面操作次数不等于网络请求次数。未查全会另列待核对项。YouTube Shorts 仅按时长提示，需手动核对。'};
      if (youtubeModule()) {
        meta['采集模式'] = ({videos: '视频 URL（含评论）', channel: '频道视频', keyword: '关键词搜索'})[options.youtubeMode];
        meta['目标日期'] = ignoreDates() ? options.youtubeMode === 'videos' ? '指定视频（不限日期）'
          : options.youtubeMode === 'keyword' ? '关键词搜索（不限日期）' : '全部公开视频' : dateRangeLabel(options.targetDates);
        if (ignoreDates()) meta['日期模式'] = '不限发布日期';
        meta.inputName = options.youtubeMode === 'keyword' ? '关键词输入' : options.youtubeMode === 'channel' && $('channelUrl').value.trim()
          ? '频道主页输入' : videoFileMode() && $('videoInputSource').value === 'text' ? '视频链接输入' : inputName;
        meta['分页上限'] = 50;
        delete meta['详情访问上限']; delete meta['Instagram采集方式'];
        meta['说明'] = '使用 YouTube Data API；返回范围受接口可访问性、数量上限与搜索索引影响。Shorts 仅按时长提示，需核对。';
        meta['视频数量上限'] = options.youtubeMode === 'videos' ? 100 : options.youtubeLimit;
        meta['评论说明'] = options.youtubeMode === 'videos' ? '读取 API 可访问的主评论和回复；回复归属主评论，不推断多级回复关系。单视频保护上限 10000 条 / 300 次请求。' : '本模式不采评论详情。';
        if (options.youtubeMode === 'keyword') {
          meta['搜索关键词'] = selected[0].query;
          meta['搜索筛选'] = KEYWORD_FILTERS[options.youtubeSearchFilter].label;
        }
      }
      const onRequest = platform => { requestCount++; if (platform === 'instagram') igOperationCount++; else ytRequestCount++; renderOperations(); };
      const onDiagnostic = (event, details) => recordEvent(event,
        {...details, ...(activeAccount ? {row_no: activeAccount.row_no, platform: activeAccount.platform} : {})},
        event.endsWith('failed') || event.endsWith('error') || details.status >= 400 ? 'warning' : 'info');
      igReader = createInstagramPageReader(tabId, {...options, signal: controller.signal,
        onRequest: () => onRequest('instagram'), onDiagnostic, onProgress: readerProgress});
      const ytRequest = createYouTubeRequest(apiKey, {signal: controller.signal, onRequest: () => onRequest('youtube'), onDiagnostic});
      const videoLookup = createVideoLookup(selected, ytRequest);
      const videoBudget = {remaining: options.youtubeLimit};
      renderResults();
      log(youtubeModule() ? `开始${meta['采集模式']}采集，${selected.length} 个目标；${meta['目标日期']}（${options.timeZone}）`
        : `开始采集 ${selected.length} 个账号；${dateModeLabels[options.dateMode]} ${dateRangeLabel(options.targetDates)}（共 ${options.targetDates.length} 天，${options.timeZone}）`);
      recordEvent('run.started', {stage: 'collect', accountCount: selected.length});
      await saveSnapshot({results, pending: selected, options, meta, running: true});
      results = await runAccounts(selected, options, {
        instagram: (a, o) => { beginAccount(a); return collectInstagramPage(a, {...o, signal: controller.signal,
          onProgress: collectionProgress, onDiagnostic}, igReader); },
        youtube: (a, o) => {
          beginAccount(a);
          if (!a.youtubeMode) return collectYouTube(a, o, ytRequest);
          return collectYouTubeTarget(a, {...o, signal: controller.signal, videoLookup, videoBudget,
            onProgress: progress => {
              $('scanProgress').textContent = `已发现 ${progress.discovered} 条视频 · 已读 ${progress.posts} 条 · 已读评论 ${progress.comments} 条`;
              setPhase(progress.stage === 'comments' ? '正在读取评论和回复' : '正在读取视频数据');
            },
            onCheckpoint: async currentRows => {
              syncRunMetrics();
              $('metricPosts').textContent = String(summarize([...results, ...currentRows]).posts);
              await saveSnapshot({results: [...results, ...currentRows], pending, options, meta, running: true});
            }}, ytRequest);
        }
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
          setPhase(`已整理 ${event.index} / ${event.total} 个账号的结果${event.pending[0] ? `；接下来：${event.pending[0].name}` : ''}`);
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
      const outcome = controller.signal.aborted ? 'stopped' : summarize(results).failedAccounts ? 'review' : 'completed';
      await saveSnapshot({results, pending, options, meta, running: false, outcome});
      await archiveRun(outcome);
      await flushDiagnostics();
      renderResults();
      log('本轮结束。请导出结果，并与页面核对内容和指标。');
      if (youtubeModule() && results.length && !controller.signal.aborted) {
        try { exportExcel(); $('exportStatus').textContent += ' 已发起 Excel 自动下载；若浏览器拦截，可点击下载按钮。'; }
        catch (error) { showError(error, 'export'); }
      }
    }
  });
}

function download(data, mime, filename) {
  const url = URL.createObjectURL(new Blob([data], {type: mime}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const fileTag = () => exportFileTag(new Date(), collectionPlatform(results, meta));
function resultWorkbook(rows, runMeta, module = workspace.module) {
  return (module === 'youtube' && runMeta['采集模式'] === '视频 URL（含评论）'
    ? createVideoResultsWorkbook : createResultsWorkbook)(rows, runMeta);
}
function exportExcel() {
  // Use the completed/restored run's mode, not the form's next-run selection.
  download(XLSX.write(resultWorkbook(results, meta), {bookType: 'xlsx', type: 'array'}),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${fileTag()}.xlsx`);
  recordEvent('results.export_requested', {stage: 'export', inputFormat: 'xlsx', count: results.length});
}
async function downloadHistoricalResult(id, type) {
  const record = await historyStore.read(id);
  if (!record) { await refreshHistory(); throw Object.assign(new Error('历史记录已被清理'), {code: 'HISTORY_MISSING'}); }
  const name = exportFileTag(new Date(record.completedAt), record.platform);
  if (type === 'xlsx') download(XLSX.write(resultWorkbook(record.results, record.meta, record.module), {bookType: 'xlsx', type: 'array'}),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${name}.xlsx`);
  else download(JSON.stringify({meta: record.meta, results: record.results}, null, 2), 'application/json;charset=utf-8', `${name}.json`);
  historyMessage('已发起历史结果下载。');
  recordEvent('history.export_requested', {stage: 'export', inputFormat: type, count: record.results.length});
}
$('historyPanel').addEventListener('toggle', () => { if ($('historyPanel').open) void refreshHistory(); });

$('downloadTemplate').addEventListener('click', guard(() => {
  const platform = $('platformSelect').value;
  $('templateFeedback').textContent = '';
  const videos = videoFileMode();
  download(XLSX.write(videos ? createVideoTemplate() : createAccountsTemplate(platform), {bookType: 'xlsx', type: 'array'}),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', videos ? '社媒采集-视频URL模板.xlsx' : `社媒采集-${accountTemplateLabel(platform)}账号模板.xlsx`);
  $('templateFeedback').textContent = videos ? '已发起视频模板下载。每行填写一个视频链接即可。' : '已发起模板下载。只需填写主页链接，账号名和平台可以选填。';
  recordEvent('template.export_requested', {stage: 'template', platform, inputFormat: 'xlsx'});
}, 'template'));
$('platformSelect').addEventListener('change', () => { $('templateFeedback').textContent = ''; });

$('inputFile').addEventListener('change', guard(async event => {
  const file = event.target.files[0]; if (!file) return;
  selectedFile = {name: file.name, size: file.size, state: 'loading'};
  inputName = file.name;
  $('fileInfo').textContent = `正在读取 ${file.name}…`;
  loading = true; accounts = []; workbook = undefined; renderControls();
  try {
    const suffix = file.name.includes('.') ? file.name.split('.').at(-1).toLowerCase() : '';
    recordEvent('input.selected', {stage: 'import', inputFormat: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(suffix) ? suffix : 'unknown', fileSize: file.size});
    if (file.size > 10 * 1024 * 1024) throw new Error('账号文件不能超过 10 MB');
    workbook = readWorkbook(await file.arrayBuffer(), file.name);
    workbookKind = videoFileMode() ? 'videos' : 'accounts';
    applyFirstSheet();
  } catch (error) {
    selectedFile.state = 'error';
    $('fileInfo').textContent = `${file.name}：读取失败，请重新选择文件。`;
    throw error;
  } finally { loading = false; renderControls(); }
}, 'import'));
$('sampleButton').addEventListener('click', guard(() => {
  selectedFile = null;
  workbook = undefined;
  workbookKind = 'accounts';
  accounts = [{row_no: 2, name: 'Robin Foxer', url: 'https://www.instagram.com/team_foxer/', platform: 'instagram', note: ''}];
  warnings = []; inputName = '内置单账号示例';
  recordEvent('input.sample_selected', {stage: 'import', platform: 'instagram', accountCount: 1});
  $('inputFile').value = ''; $('platformSelect').value = 'instagram';
  settingChanged('platformSelect');
  $('fileInfo').textContent = '已选择示例账号 @team_foxer（1 个 Instagram 账号）。';
  $('warnings').replaceChildren();
  if (!results.length) setPhase('示例已就绪，选择登录标签页后开始');
  renderControls();
}));
$('refreshTabs').addEventListener('click', guard(refreshTabs, 'tabs'));
['platformSelect', 'scanMode', 'youtubeMode', 'videoInputSource', 'youtubeRange'].forEach(id => $(id).addEventListener('change', renderControls));
for (const id of ['videoUrls', 'channelUrl', 'youtubeKeyword']) $(id).addEventListener('input', renderControls);
document.querySelectorAll('[data-keyword-filter]').forEach(button => button.addEventListener('click', () => {
  $('youtubeSearchFilter').value = button.dataset.keywordFilter;
  settingChanged('youtubeSearchFilter'); renderControls();
}));
for (const id of dateFields) $(id).addEventListener('input', () => {
  editedDateFields.add(id);
  if (id === 'timeZone') updateDateDefaults();
  renderControls();
});
for (const id of PREFERENCE_FIELDS) {
  const element = $(id);
  if (!element) continue;
  element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', () => settingChanged(id));
}
$('showCommentDetails')?.addEventListener('change', renderControls);
$('youtubeKey').addEventListener('input', () => {
  diagnostics.addSecret($('youtubeKey').value);
  void savePreferences({youtubeKey: $('youtubeKey').value});
});
$('rememberYoutubeKey').addEventListener('change', () => {
  void savePreferences({rememberYoutubeKey: $('rememberYoutubeKey').checked, youtubeKey: $('youtubeKey').value});
});
$('clearYoutubeKey').addEventListener('click', () => {
  diagnostics.addSecret($('youtubeKey').value);
  $('youtubeKey').value = ''; $('rememberYoutubeKey').checked = false;
  void savePreferences({rememberYoutubeKey: false, youtubeKey: ''});
});
$('startButton').addEventListener('click', guard(startJob, 'start'));
$('stopButton').addEventListener('click', () => {
  controller?.abort(); $('statusText').textContent = '正在停止'; renderControls();
  setPhase('正在停止并保留已读取的结果');
  log('已请求停止，正在保留已读取的结果并关闭专用采集标签页。停止后可下载 Excel。');
  recordEvent('run.stop_requested', {stage: 'collect'});
});
$('exportXlsx').addEventListener('click', guard(() => {
  exportExcel();
}, 'export'));
$('exportJson').addEventListener('click', guard(() => {
  download(JSON.stringify({meta, results}, null, 2), 'application/json;charset=utf-8', `${fileTag()}.json`);
  recordEvent('results.export_requested', {stage: 'export', inputFormat: 'json', count: results.length});
}, 'export'));
$('clearButton').addEventListener('click', guard(async () => {
  if (busy) return;
  const clear = async () => {
    results = []; meta = {}; requestCount = 0; igOperationCount = 0; ytRequestCount = 0; startedAt = 0; elapsedMs = 0;
    if (extension) await chrome.storage.session.remove(RESULT_KEY);
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
      const lastRun = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY];
      if (lastRun) { delete lastRun.diagnostics; await chrome.storage.session.set({[RESULT_KEY]: lastRun}); }
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
    renderControls();
    let savedPreferences;
    if (extension) {
      try { savedPreferences = await preferences.load(); restorePreferences(savedPreferences); }
      catch { preferenceFailure(true); }
      await refreshHistory();
    }
    if (extension && navigator.locks) {
      // A second open tab must not convert the first tab's active task to interrupted.
      await navigator.locks.request('social-metrics-collection', {ifAvailable: true}, async lock => {
        if (!lock) { warn('另一个工作页正在采集，请回到该页面；本页不能同时发起任务。'); return; }
        let saved;
        try {
          await migrateYouTubeResults(chrome.storage.session);
          saved = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY];
          if (!workspace.youtube && saved?.meta?.['采集模式']) saved = undefined;
        }
        catch (error) { showError(error, 'storage'); }
        try {
          // Export/copy/runtime errors can be newer than the result checkpoint.
          const localLog = await latestDiagnostics(saved?.diagnostics?.id);
          const stamp = snapshot => snapshot?.savedAt || snapshot?.entries?.at(-1)?.at || snapshot?.createdAt || '';
          const previous = [saved?.diagnostics, localLog].filter(Boolean).sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
          if (previous && diagnostics.restore(previous)) {
            $('logFeedback').textContent = '已恢复上次诊断日志，可直接复制或下载。';
          }
          const stored = await chrome.storage.local.get(workspace.bootErrorKey);
          if (stored[workspace.bootErrorKey]) {
            recordEvent('startup.previous_failure', {stage: 'startup', error: stored[workspace.bootErrorKey]}, 'error');
            await chrome.storage.local.remove(workspace.bootErrorKey);
          }
        } catch (error) { showError(error, 'storage'); }
        if (saved?.results) {
          results = saved.results; meta = saved.meta || {};
          currentRunId = saved.runId || saved.diagnostics?.id || `legacy-${meta['开始时间'] || meta['结束时间'] || meta.inputName || 'previous'}`;
          for (const row of results) if (row.comments_status === 'RUNNING') {
            row.comments_status = 'INTERRUPTED'; row.comments_error = '上次读取中断，已取得的评论保留，尚未确认全部回复。';
          }
          restoreDateOptions({...saved.options, ...savedPreferences?.settings});
          if (saved.running) {
            recordEvent('run.recovered_interrupted', {stage: 'restore', pendingCount: saved.pending?.length || 0}, 'warning');
            results.push(...(saved.pending || []).map(a => failedRow(a, saved.options,
              Object.assign(new Error('上次任务因工作页关闭、刷新或中断而未完成'), {code: 'INTERRUPTED'}))));
            meta['说明'] = `${meta['说明'] || ''} 上次运行中断。`;
            await saveSnapshot({...saved, results, meta, pending: [], running: false, outcome: 'interrupted'});
            warn('已恢复中断前的结果；未完成账号标为待核对，不会自动重试。');
          }
          $('statusText').textContent = '已恢复上次结果';
          requestCount = Number(meta['页面操作/API请求次数'] ?? meta['请求次数'] ?? 0) || 0;
          igOperationCount = Number(meta['Instagram页面操作次数']) || 0; ytRequestCount = Number(meta['YouTube API请求次数']) || 0;
          elapsedMs = Number(meta['耗时毫秒']) || 0;
          $('legacyCounter').hidden = Object.hasOwn(meta, 'Instagram页面操作次数') || !requestCount;
          setPhase(workspace.youtube ? '可以先导出结果；开始新采集前重新填写视频采集目标' : '可以先导出结果；开始新采集前重新导入账号表'); renderOperations();
          await archiveRun(saved.running ? 'interrupted' : saved.outcome || (summarize(results).failedAccounts ? 'review' : 'completed'), !saved.running);
        }
      });
    }
    recordEvent('workspace.opened', {stage: 'startup'});
    await refreshTabs();
  } finally { loading = false; renderResults(); }
}
await guard(init, 'startup')();
