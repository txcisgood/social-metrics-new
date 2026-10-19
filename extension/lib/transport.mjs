export function usableInstagramTab(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://www.instagram.com' &&
      !/^\/(accounts\/(login|signup|password|onetap)|challenge|checkpoint)(\/|$)/.test(u.pathname);
  } catch { return false; }
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

function diagnosticEmitter(callback, platform) {
  return (event, details) => {
    try { callback(event, {platform, stage: 'request', ...details}); }
    catch { /* Diagnostic failures must not affect requests. */ }
  };
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
