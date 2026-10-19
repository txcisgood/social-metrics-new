// Diagnostics deliberately have a narrower data model than collection results.
// No browser APIs, request bodies, headers, account lists, or credentials belong here.
const REDACTED = '[已脱敏]';
const OMITTED = '[已省略]';
const ERROR_TEXT_OMITTED = '原始错误文本已省略，请结合错误代码与堆栈排查';
const SCHEMA_VERSION = 1;
const RUN_ID = /^SM-\d{14}-[a-f0-9]{12}$/;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'DOMException', 'AbortError', 'SecurityError', 'NotAllowedError', 'NetworkError',
  'TimeoutError', 'InvalidStateError', 'DataError', 'OperationError', 'NotFoundError', 'QuotaExceededError',
  'FetchError', 'RateLimitError', 'AuthError', 'BrowserError']);
const STACK_MODULES = new Set(['app.mjs', 'bootstrap.js', 'background.mjs', 'lib/diagnostics.mjs',
  'lib/diagnostic-store.mjs', 'lib/errors.mjs', 'lib/transport.mjs', 'lib/jobs.mjs',
  'lib/youtube.mjs', 'lib/workbook.mjs', 'lib/instagram-page.mjs', 'lib/instagram-page-reader.mjs',
  'lib/instagram-page-snapshot.mjs', 'lib/instagram-page-observer.mjs', 'vendor/xlsx.full.min.js']);
const CONTAINERS = new Set(['error', 'errors', 'cause', 'details', 'options', 'settings', 'counts', 'summary', 'meta']);
const ALLOWED_KEYS = new Set([
  ...CONTAINERS, 'name', 'message', 'stack', 'code', 'errorname', 'errormessage', 'errorstack', 'errorcode',
  'rowno', 'platform', 'platforms', 'stage', 'endpoint', 'status', 'statuscode', 'httpstatus', 'httpstatuscode',
  'duration', 'durationms', 'elapsed', 'elapsedms', 'attempt', 'retries', 'retrycount', 'requestcount',
  'count', 'warningcount', 'postcount', 'index', 'total', 'pending', 'pendingcount', 'completed', 'completedcount', 'accountcount',
  'okaccounts', 'nopostaccounts', 'failedaccounts', 'completedaccounts', 'posts', 'pages', 'page', 'pagecount',
  'maxpages', 'maxposts', 'mindelay', 'maxdelay', 'days', 'datemode', 'targetdate', 'targetdates', 'timezone',
  'targetmonth', 'quarteryear', 'quarter', 'startdate', 'enddate',
  'inputformat', 'fileextension', 'filesize', 'bytes', 'size', 'transport', 'method', 'tabid', 'frameid',
  'cancelled', 'aborted', 'hasresults', 'reason', 'component', 'action', 'checkpoint', 'online', 'state',
  'runid', 'entryid', 'diagnosticid', 'requestid', 'correlationid', 'version', 'browser',
  'scanmode', 'detailcount', 'waitms', 'readms', 'igoperationcount', 'ytrequestcount',
]);
const ARRAY_KEYS = new Set(['errors', 'targetdates', 'platforms']);
const FORBIDDEN_KEY = /cookie|authorization|token|password|passwd|passphrase|secret|apikey|sessionid|csrf|credential|^(?:headers?|body|request|response|payload|data|raw|rawresponse|html)$/i;
const KEY_PATTERN = '(?:api[ _-]?key|key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|token|client[ _-]?secret|secret|password|passwd|passphrase|session[ _-]?id|csrf[ _-]?token|authorization|proxy[ _-]?authorization|cookies?|set[ _-]?cookie|ds_user_id|ig_did|ig_nrcb|username|account[ _-]?name|profile[ _-]?url|post[ _-]?title|caption|file[ _-]?name|input[ _-]?name|(?:request|response)[ _-]?(?:body|headers?)|body|headers?)';
const TEXT_INTRO = [
  '社媒采集 · 诊断日志',
  '本日志只记录运行参数、阶段、状态和脱敏后的技术错误详情。',
  '不收集请求/响应正文、帖子正文、账号名称、Cookie 或 API 密钥；复制给他人前请检查错误详情。',
  '日志仅用于排查问题；省略或截断的内容不会自动上传。',
  '',
].join('\n');

const normalizedKey = key => String(key).toLowerCase().replace(/[\s_-]/g, '');
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function randomId() {
  let random;
  if (globalThis.crypto?.randomUUID) random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  else random = Array.from({length: 12}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return random;
}

function makeRunId() { return `SM-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomId()}`; }

function knownStackFrames(value) {
  if (typeof value !== 'string' || value.length > 200000) return '[本扩展堆栈不可用]';
  const frames = [];
  const pattern = /(?:^|[/\\\s(@[])((?:lib|vendor)\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)\.(mjs|cjs|js):(\d{1,9})(?::(\d{1,9}))?(?=[)\s]|$)/g;
  for (const line of value.split(/\r?\n/)) {
    // Only the fixed module path and numeric location survive. In particular,
    // error messages and function names can contain accounts or post content.
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line))) {
      const module = `${match[1]}.${match[2]}`;
      if (STACK_MODULES.has(module)) frames.push(`at ${module}:${match[3]}${match[4] ? `:${match[4]}` : ''}`);
      if (frames.length >= 30) break;
    }
    if (frames.length >= 30) break;
  }
  return frames.length ? [...new Set(frames)].join('\n') : '[本扩展堆栈不可用]';
}

function ownProperties(value) {
  try { return Object.getOwnPropertyDescriptors(value); } catch { return {}; }
}

function safeString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function codeLocation(path) {
  const cleaned = path.replace(/[?#].*$/, '');
  const basename = cleaned.split(/[\\/]/).pop();
  return /^[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|py)(?::\d+){0,2}$/.test(basename || '')
    ? `[本地文件]/${basename}` : '[本地路径已省略]';
}

function redactNamedValues(text) {
  const pattern = new RegExp(`(?:["'])?${KEY_PATTERN}(?:["'])?\\s*[:=]\\s*`, 'gi');
  let output = '', copiedUntil = 0, match;
  while ((match = pattern.exec(text))) {
    const start = pattern.lastIndex;
    let end = start;
    const first = text[start];
    if (first === '"' || first === "'") {
      end++;
      for (; end < text.length; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === first) { end++; break; }
      }
    } else if (first === '{' || first === '[') {
      let nesting = 0, quote = '';
      for (; end < text.length; end++) {
        const character = text[end];
        if (quote) {
          if (character === '\\') end++;
          else if (character === quote) quote = '';
        } else if (character === '"' || character === "'") quote = character;
        else if (character === '{' || character === '[') nesting++;
        else if ((character === '}' || character === ']') && --nesting === 0) { end++; break; }
      }
    } else {
      while (end < text.length && !/[\s,;}&\]]/.test(text[end])) end++;
    }
    output += text.slice(copiedUntil, start) + REDACTED;
    copiedUntil = Math.min(end, text.length);
    pattern.lastIndex = Math.max(copiedUntil, start + 1);
  }
  return output + text.slice(copiedUntil);
}

/**
 * Limits apply to the readable JSON as well as the number of entries. Values
 * below 512 characters are rounded up because the versioned envelope itself
 * must remain readable. Snapshots are detached copies, never live state.
 */
export function createDiagnostics({version, browser, platform, maxEntries = 500, maxChars = 200000, secrets = []} = {}) {
  const entryLimit = boundedInteger(maxEntries, 500, 1, 5000);
  const charLimit = boundedInteger(maxChars, 200000, 512, 1000000);
  const jsonBudget = charLimit - TEXT_INTRO.length;
  const knownSecrets = new Set();
  const writerId = randomId();
  let sequence = 0;
  let state = {
    schemaVersion: SCHEMA_VERSION, id: makeRunId(), createdAt: new Date().toISOString(),
    environment: {}, context: {}, entries: [], dropped: 0,
  };

  function rememberSecret(value) {
    if (typeof value !== 'string' || !value || knownSecrets.has(value)) return false;
    // Very long strings cannot enter a log field (see redact). Keep only a
    // bounded number of explicit credentials, with no copy in the snapshot.
    if (value.length > 200000 || knownSecrets.size >= 1000) return false;
    knownSecrets.add(value);
    return true;
  }

  if (Array.isArray(secrets)) secrets.forEach(rememberSecret);

  function redact(value, limit = 4000) {
    let result = safeString(value);
    // Never truncate before redaction: a truncated credential can otherwise
    // leak as a nonmatching prefix. Oversized inputs are omitted entirely.
    if (result.length > 200000) return '[文本过长，已省略]';
    for (const secret of knownSecrets) {
      result = result.split(secret).join(REDACTED);
      let encoded = secret;
      for (let level = 0; level < 2; level++) {
        try { encoded = encodeURIComponent(encoded); } catch { break; }
        if (encoded !== secret) {
          result = result.replace(new RegExp(escapeRegExp(encoded), 'gi'), REDACTED);
          result = result.replace(new RegExp(escapeRegExp(encoded.replace(/%20/gi, '+')), 'gi'), REDACTED);
        }
      }
    }
    // Mask complete header values before decoding, because percent-encoded
    // whitespace inside a token must not split it into an unredacted tail.
    result = result.replace(/\bBearer[\s+]+[^\s,"';)}\]]+/gi, `Bearer ${REDACTED}`);
    // Decode percent escapes before the generic rules, including encoded query
    // keys and JSON field names. Malformed encodings stay literal, then URLs are
    // removed wholesale below. A second pass catches double encoding.
    for (let level = 0; level < 2; level++) {
      result = result.replace(/(?:%[0-9a-f]{2})+/gi, value => {
        try { return decodeURIComponent(value); } catch { return value; }
      });
    }
    result = result.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    result = result.replace(/\\+["']/g, value => value.at(-1));
    for (const secret of knownSecrets) result = result.split(secret).join(REDACTED);
    result = result.replace(/\bAIza[A-Za-z0-9_-]{8,}/g, REDACTED);
    result = result.replace(/\bBearer[\s+]+[^\s,"';)}\]]+/gi, `Bearer ${REDACTED}`);
    result = result.replace(/([?&]key\s*=\s*)[^\s,;&}\]]+/gi, (_, prefix) => `${prefix}${REDACTED}`);
    result = result.replace(/\b(?:set[ _-]?)?cookie\s*:\s*[^\r\n]*/gi, `Cookie: ${REDACTED}`);
    result = result.replace(/\b(?:proxy[ _-]?)?authorization\s*[:=]\s*[^\r\n]*/gi, `Authorization: ${REDACTED}`);
    // Cover JSON, header-like text, bare query parameters, and escaped JSON.
    result = redactNamedValues(result);
    result = result.replace(/\b(?:sessionid|csrftoken|ds_user_id|ig_did|ig_nrcb|rur|mid)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,}\]]+)/gi, match => `${match.slice(0, match.indexOf('=') + 1)}${REDACTED}`);
    result = result.replace(/(?:chrome|edge|moz)-extension:\/\/[^/\s]+\/[^\s<>"')]+/gi, url => {
      const path = url.replace(/^[^:]+:\/\/[^/]+\//, '');
      return /^[A-Za-z0-9_./-]+\.(?:mjs|cjs|js)(?::\d+){0,2}$/.test(path)
        ? `[扩展]/${path}` : '[扩展文件]';
    });
    result = result.replace(/file:\/\/[^\s<>"')]+/gi, codeLocation);
    result = result.replace(/\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi, '[URL已省略]');
    result = result.replace(/\b(?:www\.)?(?:instagram\.com|instagr\.am|youtube\.com|youtu\.be|(?:www\.)?googleapis\.com)(?:\/[^\s<>"']*)?/gi, '[URL已省略]');
    result = result.replace(/(?:\b[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|Volumes|mnt)\/)[^\s<>"')]+/g, codeLocation);
    result = result.replace(/\b[^\s<>"'/\\]+\.(?:xlsx?|xlsm|csv|tsv)\b/gi, '[输入文件已省略]');
    // @handles can occur in otherwise useful API error messages.
    result = result.replace(/(^|[\s('"=])@[A-Za-z0-9_.]{1,30}/g, (_, prefix) => `${prefix}[账号已省略]`);
    return result.length > limit ? `${result.slice(0, Math.max(0, limit - 8))}…[已截断]` : result;
  }

  function endpointLabel(value) {
    const label = safeString(value);
    if (/^[a-z][a-z0-9_.:-]{0,79}$/i.test(label)) return redact(label, 80);
    if (/\/api\/v1\/users\/web_profile_info\//.test(label)) return 'instagram.web_profile_info';
    if (/\/api\/v1\/users\/[^/]+\/usernameinfo\//.test(label)) return 'instagram.usernameinfo';
    if (/\/api\/v1\/feed\/user\/[^/]+\//.test(label)) return 'instagram.feed';
    return '[endpoint 已省略]';
  }

  function sanitize(value, key = 'details', depth = 0, seen = new WeakSet(), counter = {n: 0, chars: 0}, errorScope = false) {
    const normalized = normalizedKey(key);
    errorScope ||= ['error', 'errors', 'cause'].includes(normalized) || value instanceof Error
      || (typeof DOMException !== 'undefined' && value instanceof DOMException);
    if (depth > 7 || ++counter.n > 600) return OMITTED;
    if (value == null) return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      if ((errorScope && ['message', 'cause', 'error'].includes(normalized)) || normalized === 'errormessage') return ERROR_TEXT_OMITTED;
      if (normalized === 'stack' || normalized === 'errorstack') return knownStackFrames(value);
      if (normalized === 'endpoint') return endpointLabel(value);
      if (normalized === 'name' || normalized === 'errorname') return ERROR_NAMES.has(value) ? value : (errorScope ? 'Error' : undefined);
      if (counter.chars >= 30000) return undefined;
      const clean = redact(value, Math.min(4000, 30000 - counter.chars));
      counter.chars += clean.length;
      return clean;
    }
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return '[循环引用已省略]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (!ARRAY_KEYS.has(normalized)) return undefined;
        return value.slice(0, 100).map(item => sanitize(item, normalized === 'errors' ? 'error' : key, depth + 1, seen, counter, errorScope)).filter(item => item !== undefined);
      }
      if (!CONTAINERS.has(normalized) && normalized !== 'context' && normalized !== 'environment') return undefined;
      const result = {};
      const properties = ownProperties(value);
      if (value instanceof Error || (typeof DOMException !== 'undefined' && value instanceof DOMException)) {
        // V8 implements even an assigned Error.stack as a lazy native accessor.
        // Read only this Error-specific field; arbitrary object getters remain
        // excluded from the metadata schema.
        for (const field of ['name', 'message', 'stack', 'code']) {
          if (Object.hasOwn(properties[field] || {}, 'value')) continue;
          try { properties[field] = {value: value[field]}; } catch { /* Broken native fields are omitted. */ }
        }
      }
      for (const [field, descriptor] of Object.entries(properties).slice(0, 200)) {
        const normalizedField = normalizedKey(field);
        if (!Object.hasOwn(descriptor, 'value') || !ALLOWED_KEYS.has(normalizedField) || FORBIDDEN_KEY.test(normalizedField)) continue;
        const clean = sanitize(descriptor.value, field, depth + 1, seen, counter, errorScope);
        if (clean !== undefined) result[field] = clean;
      }
      return result;
    } finally { seen.delete(value); }
  }

  function cleanEnvironment(value) {
    const properties = ownProperties(value || {});
    const result = {};
    for (const key of ['version', 'browser', 'platform']) {
      const raw = properties[key]?.value;
      if (typeof raw === 'string' || typeof raw === 'number') result[key] = redact(raw, key === 'browser' ? 500 : 120);
    }
    return result;
  }

  function fit() {
    // A single context object must not crowd out the actual error entries.
    const contextBudget = Math.min(16000, Math.floor(jsonBudget / 4));
    while (JSON.stringify(state.context).length > contextBudget) {
      const keys = Object.keys(state.context);
      if (!keys.length) break;
      const largest = keys.sort((a, b) => JSON.stringify(state.context[b]).length - JSON.stringify(state.context[a]).length)[0];
      delete state.context[largest];
    }
    const removeOne = () => {
      const firstOrdinary = state.entries.findIndex(entry => entry.level !== 'error');
      state.entries.splice(firstOrdinary < 0 ? 0 : firstOrdinary, 1);
      state.dropped++;
    };
    while (state.entries.length > entryLimit) removeOne();
    // Compute weights once; repeatedly serializing every entry while trimming a
    // large restored snapshot would make recovery quadratic in log text size.
    const weights = state.entries.map(entry => {
      const serialized = JSON.stringify(entry, null, 2);
      return serialized.length + serialized.split('\n').length * 6 + 2;
    });
    let estimatedSize = JSON.stringify({...state, entries: []}, null, 2).length + weights.reduce((sum, size) => sum + size, 0) + 8;
    while (estimatedSize > jsonBudget && state.entries.length) {
      const firstOrdinary = state.entries.findIndex(entry => entry.level !== 'error');
      const index = firstOrdinary < 0 ? 0 : firstOrdinary;
      estimatedSize -= weights[index];
      weights.splice(index, 1); state.entries.splice(index, 1); state.dropped++;
    }
    if (JSON.stringify(state, null, 2).length > jsonBudget) state.context = {};
    if (JSON.stringify(state, null, 2).length > jsonBudget) state.environment = {};
  }

  function entryId() { return `${state.id}-E${String(++sequence).padStart(6, '0')}-${writerId}`; }

  function cleanEvent(event) {
    const value = redact(event, 80);
    return /^[a-z][a-z0-9._:-]{0,79}$/i.test(value) ? value : 'diagnostic.event';
  }

  function snapshot() { return JSON.parse(JSON.stringify(state)); }

  function record(level, event, details = {}) {
    const id = entryId();
    const clean = sanitize(details);
    state.entries.push({
      id, at: new Date().toISOString(), level: level === 'warning' ? 'warn' : LEVELS.has(level) ? level : 'info',
      event: cleanEvent(event), details: clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : {message: redact(clean)},
    });
    fit();
    return id;
  }

  function setContext(context) {
    const clean = sanitize(context, 'context');
    if (clean && typeof clean === 'object' && !Array.isArray(clean)) state.context = {...state.context, ...clean};
    fit();
  }

  function addSecret(value) {
    if (!rememberSecret(value)) return;
    // Credentials can become known after a log was recorded, for example when
    // a user supplies a key before retrying. Scrub existing state immediately.
    state.environment = cleanEnvironment(state.environment);
    state.context = sanitize(state.context, 'context');
    state.entries = state.entries.map(entry => ({...entry, event: cleanEvent(entry.event), details: sanitize(entry.details)}));
    fit();
  }

  function restore(saved) {
    const fields = ownProperties(saved);
    const get = key => fields[key]?.value;
    if (get('schemaVersion') !== SCHEMA_VERSION || !RUN_ID.test(get('id') || '') || !Array.isArray(get('entries'))
      || typeof get('createdAt') !== 'string' || !Number.isFinite(Date.parse(get('createdAt')))) return false;
    const cleanContext = sanitize(get('context') || {}, 'context');
    const restored = {
      schemaVersion: SCHEMA_VERSION, id: get('id'), createdAt: new Date(get('createdAt')).toISOString(),
      environment: cleanEnvironment(get('environment')), context: cleanContext && typeof cleanContext === 'object' && !Array.isArray(cleanContext) ? cleanContext : {},
      entries: [], dropped: boundedInteger(get('dropped'), 0, 0, 1000000000),
    };
    const ids = new Set();
    let nextSequence = 0;
    const source = get('entries');
    // A hostile saved object must not turn restoring into unbounded work.
    const start = Math.max(0, source.length - 5000);
    restored.dropped += start;
    for (let index = start; index < source.length; index++) {
      const item = ownProperties(Object.getOwnPropertyDescriptor(source, String(index))?.value);
      const value = key => item[key]?.value;
      if (typeof value('at') !== 'string' || !Number.isFinite(Date.parse(value('at'))) || !(LEVELS.has(value('level')) || value('level') === 'warning')) {
        restored.dropped++; continue;
      }
      const idMatch = typeof value('id') === 'string' && value('id').match(new RegExp(`^${escapeRegExp(restored.id)}-E(\\d{1,10})(?:-[a-f0-9]{12})?$`));
      const originalSequence = idMatch && Number(idMatch[1]);
      if (originalSequence && originalSequence <= 1000000000) nextSequence = Math.max(nextSequence, originalSequence);
      let id = originalSequence && originalSequence <= 1000000000 && !ids.has(value('id')) ? value('id') : null;
      if (!id) {
        do { id = `${restored.id}-E${String(++nextSequence).padStart(6, '0')}-${writerId}`; } while (ids.has(id));
      }
      ids.add(id);
      const details = sanitize(value('details') || {});
      restored.entries.push({id, at: new Date(value('at')).toISOString(), level: value('level') === 'warning' ? 'warn' : value('level'), event: cleanEvent(value('event')),
        details: details && typeof details === 'object' && !Array.isArray(details) ? details : {message: redact(details)}});
    }
    state = restored;
    sequence = nextSequence;
    fit();
    return true;
  }

  state.environment = cleanEnvironment({version, browser, platform});
  fit();
  return {get id() { return state.id; }, record, setContext, addSecret, restore, snapshot,
    text: () => `${TEXT_INTRO}${JSON.stringify(state, null, 2)}`};
}
