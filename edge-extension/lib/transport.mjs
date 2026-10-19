export function usableInstagramTab(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://www.instagram.com' &&
      !/^\/(accounts\/(login|signup|password|onetap)|challenge|checkpoint)(\/|$)/.test(u.pathname);
  } catch { return false; }
}

export function allowedInstagramPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const u = new URL(path, 'https://www.instagram.com');
  return u.origin === 'https://www.instagram.com' && !u.hash && (
    u.pathname === '/api/v1/users/web_profile_info/' ||
    /^\/api\/v1\/users\/[A-Za-z0-9_.]+\/usernameinfo\/$/.test(u.pathname) ||
    /^\/api\/v1\/feed\/user\/[0-9]+\/$/.test(u.pathname));
}

export function cancelled() {
  return Object.assign(new Error('用户已停止本次采集'), {code: 'CANCELLED'});
}

export function checkCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

export function delay(ms, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}

// Serialized by executeScript. It must not reference module-level bindings.
export async function instagramPageGet(path, timeout = 30000) {
  if (location.origin !== 'https://www.instagram.com' ||
      /^\/(accounts\/(login|signup|password|onetap)|challenge|checkpoint)(\/|$)/.test(location.pathname)) {
    return {error: '请在所选 Instagram 标签页完成登录或验证，再重新采集', code: 'AUTH'};
  }
  const u = new URL(path, location.origin);
  if (!path.startsWith('/') || path.startsWith('//') || u.origin !== location.origin || u.hash || !(
    u.pathname === '/api/v1/users/web_profile_info/' ||
    /^\/api\/v1\/users\/[A-Za-z0-9_.]+\/usernameinfo\/$/.test(u.pathname) ||
    /^\/api\/v1\/feed\/user\/[0-9]+\/$/.test(u.pathname))) {
    return {error: '不支持的 Instagram 请求地址', code: 'BAD_URL'};
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(u.href, {
      method: 'GET', credentials: 'same-origin', redirect: 'error',
      headers: {'x-ig-app-id': '936619743392459'}, signal: controller.signal
    });
    const text = await response.text();
    if (text.length > 8000000) return {error: 'Instagram 返回内容过大，已停止读取', code: 'INVALID_DATA'};
    return {status: response.status, text};
  } catch (e) {
    return {error: e.name === 'AbortError' ? 'Instagram 请求超时，请检查网络' :
      'Instagram 请求失败或被转到登录验证页，请在所选标签页检查', code: 'TAB'};
  } finally { clearTimeout(timer); }
}

function diagnosticEmitter(callback, platform) {
  return (event, details) => {
    try { callback(event, {platform, stage: 'request', ...details}); }
    catch { /* Diagnostic failures must not affect requests. */ }
  };
}

function instagramEndpoint(path) {
  return path.includes('/web_profile_info/') ? 'web_profile_info'
    : path.includes('/usernameinfo/') ? 'usernameinfo' : path.includes('/feed/user/') ? 'feed' : 'unknown';
}

function observeRequest(request, emit, endpointName) {
  let sequence = 0;
  return async (...args) => {
    const requestId = ++sequence, endpoint = endpointName(args[0]), start = Date.now();
    const observation = {requestId, startedAt: start};
    emit('request.started', {requestId, endpoint});
    try {
      const result = await request(observation, ...args);
      const status = observation.status ?? result?.status;
      emit('request.completed', {requestId, endpoint, durationMs: Date.now() - start,
        ...(Number.isInteger(status) ? {status} : {})});
      return result;
    } catch (error) {
      emit('request.failed', {requestId, endpoint, durationMs: Date.now() - start, error,
        ...(Number.isInteger(observation.status) ? {status: observation.status} : {})});
      throw error;
    }
  };
}

export function createInstagramRequest(tabId, {minDelay = 8, maxDelay = 12, signal, onRequest = () => {}, onDiagnostic = () => {}} = {}) {
  let last = 0;
  const emit = diagnosticEmitter(onDiagnostic, 'instagram');
  return observeRequest(async (_observation, path) => {
    if (!allowedInstagramPath(path)) throw new Error('不支持的 Instagram 请求地址');
    checkCancelled(signal);
    const wait = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
    if (last) await delay(Math.max(0, wait - (Date.now() - last)), signal);
    checkCancelled(signal);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    checkCancelled(signal);
    if (!tab || !usableInstagramTab(tab.url)) {
      throw Object.assign(new Error('所选 Instagram 标签页已关闭、跳转或需要登录，请检查后重新采集'), {code: 'TAB'});
    }
    last = Date.now();
    onRequest();
    let items;
    try {
      items = await chrome.scripting.executeScript({
        target: {tabId}, world: 'ISOLATED', func: instagramPageGet, args: [path, 30000]
      });
    } catch (error) {
      emit('browser.injection_failed', {endpoint: instagramEndpoint(path), error});
      throw Object.assign(new Error('无法读取 Instagram 标签页，请刷新页面并检查插件的网站访问权限'), {code: 'TAB'});
    }
    checkCancelled(signal);
    const result = items?.[0]?.result;
    if (!result || result.error || !Number.isInteger(result.status)) {
      throw Object.assign(new Error(result?.error || 'Instagram 标签页返回无效数据'), {code: result?.code || 'TAB'});
    }
    return result;
  }, emit, instagramEndpoint);
}

export function createYouTubeRequest(apiKey, {signal, onRequest = () => {}, onDiagnostic = () => {}} = {}) {
  const emit = diagnosticEmitter(onDiagnostic, 'youtube');
  return observeRequest(async (observation, endpoint, params) => {
    checkCancelled(signal);
    if (!['channels', 'playlistItems', 'videos'].includes(endpoint)) throw new Error('不支持的 YouTube 请求');
    if (!apiKey.trim()) throw Object.assign(new Error('请填写 YouTube Data API Key'), {code: 'AUTH'});
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.search = new URLSearchParams({...params, key: apiKey.trim()});
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, 30000);
    onRequest();
    try {
      const r = await fetch(url, {signal: controller.signal, credentials: 'omit', redirect: 'error'});
      observation.status = r.status;
      emit('request.response', {endpoint, status: r.status, requestId: observation.requestId, durationMs: Date.now() - observation.startedAt});
      if (r.status === 429) throw Object.assign(new Error('YouTube 已限流，本轮停止该平台'), {code: 'RATE_LIMIT'});
      let data;
      try { data = await r.json(); }
      catch {
        if ([401, 403].includes(r.status)) throw Object.assign(new Error(`YouTube API 拒绝访问（HTTP ${r.status}），请核对密钥及权限`), {code: 'AUTH'});
        throw new Error('YouTube 返回了无效数据');
      }
      if (!r.ok || data.error) {
        const reasons = (data.error?.errors || []).map(e => e.reason);
        if (r.status === 429 || reasons.some(v => /quota|rateLimit|dailyLimit/i.test(v))) {
          throw Object.assign(new Error('YouTube 配额耗尽或限流，本轮停止该平台'), {code: 'RATE_LIMIT'});
        }
        if ([400, 401, 403].includes(r.status)) {
          throw Object.assign(new Error(`YouTube API 请求被拒绝（HTTP ${r.status}），请核对密钥、API启用状态及密钥限制`), {code: 'AUTH'});
        }
        throw new Error(`YouTube 请求失败（HTTP ${r.status}）`);
      }
      return data;
    } catch (e) {
      emit('request.transport_error', {endpoint, error: e});
      checkCancelled(signal);
      if (e.code) throw e;
      if (e.name === 'AbortError') throw new Error('YouTube 请求超时，请检查网络');
      // Never include a fetch URL, which contains the API key, in errors or logs.
      throw new Error('YouTube 网络或数据错误，请检查网络和密钥设置');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }, emit, endpoint => ['channels', 'playlistItems', 'videos'].includes(endpoint) ? endpoint : 'unknown');
}
