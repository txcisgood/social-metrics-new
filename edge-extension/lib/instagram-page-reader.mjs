import {instagramPageSnapshot} from './instagram-page-snapshot.mjs';
import {installInstagramPageObserver, readInstagramPageObserver} from './instagram-page-observer.mjs';
import {checkCancelled, delay, usableInstagramTab} from './transport.mjs';

const error = (message, code) => Object.assign(new Error(message), {code});
const postCode = url => {
  try { return new URL(url).pathname.match(/^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/)?.[1] || ''; }
  catch { return ''; }
};

// Every data read comes from a normally loaded page. This module never calls
// Instagram's private API or reads/copies authentication cookies.
export function createInstagramPageReader(sourceTabId, {
  signal, minDelay = 3, maxDelay = 5, onRequest = () => {}, onDiagnostic = () => {}, onProgress = () => {},
  timeoutMs = 25000, pollMs = 400, missingDateGraceMs = 2000, profileSettleMs = 800,
} = {}) {
  const owned = new Map();
  let windowId, lastVisit = 0, sequence = 0, username = '';
  const emit = (event, details) => {
    try { onDiagnostic(event, {platform: 'instagram', stage: 'page', ...details}); } catch { /* Diagnostics do not control collection. */ }
  };
  const progress = value => { try { onProgress(value); } catch { /* UI cannot cancel a read. */ } };
  const counted = kind => { try { onRequest(); } catch { /* UI cannot cancel a read. */ } progress(kind); };
  const matches = (url, expected) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://www.instagram.com') return false;
      return expected.kind === 'post' ? postCode(url) === expected.shortcode
        : parsed.pathname.replace(/\/$/, '').toLowerCase() === `/${expected.username.toLowerCase()}`;
    } catch { return false; }
  };
  async function sourceWindow() {
    if (windowId !== undefined) return windowId;
    const source = await chrome.tabs.get(sourceTabId).catch(() => null);
    checkCancelled(signal);
    if (!source || !usableInstagramTab(source.url)) throw error('所选 Instagram 标签页不可用，请重新选择', 'TAB');
    windowId = source.windowId;
    return windowId;
  }
  async function checkedTab(entry, allowPending = false) {
    checkCancelled(signal);
    const tab = await chrome.tabs.get(entry.id).catch(() => null);
    checkCancelled(signal);
    if (!tab) throw error('用于采集的 Instagram 标签页已关闭', 'TAB');
    if ([tab.url, tab.pendingUrl].some(url => /^https:\/\/www\.instagram\.com\/(?:accounts\/(?:login|onetap)|challenge|checkpoint)(?:\/|\?|$)/.test(url || ''))) {
      throw error('Instagram 页面要求登录或账号验证，请在采集标签页完成', 'AUTH');
    }
    if ((tab.pendingUrl && !matches(tab.pendingUrl, entry))
        || (!matches(tab.url, entry) && !(allowPending && tab.pendingUrl && matches(tab.pendingUrl, entry)))) {
      throw error('用于采集的标签页已跳转，请停止后重新开始', 'TAB');
    }
    return tab;
  }
  async function throttle(kind, timing) {
    checkCancelled(signal);
    const waitMs = lastVisit ? Math.max(0, (minDelay + Math.random() * (maxDelay - minDelay)) * 1000 - (Date.now() - lastVisit)) : 0;
    if (waitMs > 0) {
      progress({stage: 'waiting', kind, waitMs});
      const start = Date.now();
      try { await delay(waitMs, signal); } finally { timing.waitMs += Date.now() - start; }
    }
    checkCancelled(signal);
    lastVisit = Date.now();
  }
  const scope = entry => ({expectedUsername: entry.username, expectedShortcode: entry.shortcode || ''});
  async function observe(entry) {
    // Early best-effort injection catches page-owned responses while the DOM loads.
    // It is scoped to the two disposable tabs, never the user's original tab.
    if (entry.observed || entry.observerAttempts >= 3) return;
    entry.observerAttempts = (entry.observerAttempts || 0) + 1;
    try {
      const value = await chrome.scripting.executeScript({target: {tabId: entry.id}, world: 'MAIN', injectImmediately: true,
        func: installInstagramPageObserver, args: [scope(entry)]});
      entry.observed = value?.[0]?.result?.installed === true;
    } catch { /* A navigation race or site policy still leaves the DOM fallback. */ }
    checkCancelled(signal);
  }
  async function snapshot(entry) {
    await checkedTab(entry);
    let injection;
    try {
      injection = await chrome.scripting.executeScript({target: {tabId: entry.id}, world: 'ISOLATED', injectImmediately: true,
        func: instagramPageSnapshot, args: [scope(entry)]});
    } catch {
      checkCancelled(signal);
      throw Object.assign(error('无法读取 Instagram 页面，请检查扩展的网站访问权限', 'TAB'), {injectionFailure: true});
    }
    checkCancelled(signal);
    const data = injection?.[0]?.result;
    if (data && /^https:\/\/www\.instagram\.com\//.test(data.url || '') && data.state === 'login') {
      entry.keepOpen = true;
      throw error('请在采集标签页完成 Instagram 登录或账号验证', 'AUTH');
    }
    if (!data || !matches(data.url, entry)) throw error('Instagram 页面与当前采集目标不一致', 'TAB');
    if (data.state === 'restricted') throw error('Instagram 页面提示暂时限制访问，本轮已暂停', 'RATE_LIMIT');
    if (data.state === 'unavailable') throw error('Instagram 页面内容暂不可用', 'PAGE_UNAVAILABLE');
    if (entry.observed) {
      let observed;
      try {
        observed = (await chrome.scripting.executeScript({target: {tabId: entry.id}, world: 'MAIN', injectImmediately: true,
          func: readInstagramPageObserver, args: [scope(entry)]}))?.[0]?.result;
      } catch { /* Passive observation is optional. */ }
      checkCancelled(signal);
      await checkedTab(entry);
      if (observed?.profile?.username?.toLowerCase() === entry.username.toLowerCase()) {
        if (observed.state === 'restricted') throw error('Instagram 页面提示暂时限制访问，本轮已暂停', 'RATE_LIMIT');
        for (const key of ['followers', 'totalCount', 'isPrivate']) {
          if (observed.profile[key] !== null && observed.profile[key] !== undefined) data.profile[key] = observed.profile[key];
        }
        const posts = new Map((data.posts || []).map(post => [post.shortcode, post]));
        for (const post of observed.posts || []) {
          if (entry.kind === 'post' ? post.shortcode !== entry.shortcode
            : post.owner?.toLowerCase() !== entry.username.toLowerCase() && post.profileMember !== true) continue;
          const before = posts.get(post.shortcode) || {};
          const merged = {...before, ...post, pinned: before.pinned || post.pinned,
            profileMember: before.profileMember || post.profileMember, caption: post.caption || before.caption || ''};
          for (const key of ['ts', 'likes', 'comments', 'views']) merged[key] = post[key] ?? before[key] ?? null;
          posts.set(post.shortcode, merged);
        }
        data.posts = [...posts.values()];
        // Responses supplement fields, never prove that the whole profile was read.
        if (data.state === 'loading' && data.posts.length) data.state = 'ready';
      }
    }
    return data;
  }
  async function loaded(entry) {
    const until = Date.now() + timeoutMs;
    let latest, readySince = 0;
    while (Date.now() < until) {
      const tab = await checkedTab(entry, true);
      if (matches(tab.url, entry)) {
        await observe(entry);
        try { latest = await snapshot(entry); }
        catch (cause) {
          if (!cause.injectionFailure || tab.status === 'complete') throw cause;
          await delay(pollMs, signal); continue;
        }
        if (latest.state === 'private') return latest;
        if (latest.state === 'ready') {
          readySince ||= Date.now();
          if (entry.kind === 'profile') {
            if (latest.profile?.totalCount === 0 || latest.posts?.some(post => post.ts)
                || (latest.links?.length && Date.now() - readySince >= profileSettleMs)) return latest;
          } else if (latest.posts?.some(post => post.shortcode === entry.shortcode && post.ts)
              || Date.now() - readySince >= missingDateGraceMs) return latest;
        } else readySince = 0;
      }
      await delay(pollMs, signal);
    }
    if (latest?.state === 'ready') return latest; // Collector records incompleteness explicitly.
    throw error('Instagram 页面加载超时，请在浏览器中检查页面', 'NETWORK_TIMEOUT');
  }
  async function operation(endpoint, action) {
    const requestId = ++sequence, start = Date.now(), timing = {waitMs: 0};
    emit('page.started', {endpoint, requestId});
    try {
      const result = await action(timing);
      emit('page.completed', {endpoint, requestId, durationMs: Date.now() - start, postCount: result.posts?.length || 0,
        ...timing, readMs: Math.max(0, Date.now() - start - timing.waitMs), count: result.links?.length || 0, state: result.state});
      return result;
    } catch (cause) {
      emit('page.failed', {endpoint, requestId, durationMs: Date.now() - start, ...timing, error: cause});
      throw cause;
    }
  }
  async function navigate(kind, url, expected) {
    return operation(kind, async timing => {
      await sourceWindow();
      await throttle(kind, timing);
      let previous = owned.get(kind);
      if (previous) await checkedTab(previous);
      let tab;
      try {
        if (previous) tab = await chrome.tabs.update(previous.id, {url});
        else tab = await chrome.tabs.create({windowId, url, active: false});
      } catch {
        checkCancelled(signal);
        throw error('无法打开用于采集的 Instagram 标签页', 'TAB');
      }
      const entry = {id: tab.id, kind, username, ...expected};
      owned.set(kind, entry);
      counted(kind);
      checkCancelled(signal);
      return loaded(entry);
    });
  }
  return {
    async openProfile(value) {
      if (!/^[A-Za-z0-9_.]{1,30}$/.test(value)) throw error('Instagram 主页链接格式无效', 'BAD_URL');
      username = value;
      return navigate('profile', `https://www.instagram.com/${encodeURIComponent(value)}/`, {username: value});
    },
    async openPost(url, shortcode) {
      if (!/^[A-Za-z0-9_-]+$/.test(shortcode) || !matches(url, {kind: 'post', shortcode})) throw error('Instagram 帖子链接无效', 'BAD_URL');
      // Keep only the canonical read-only post location, without tracking query parameters.
      return navigate('post', `https://www.instagram.com/p/${shortcode}/`, {shortcode});
    },
    async refreshProfile() {
      const entry = owned.get('profile');
      if (!entry) throw error('尚未打开 Instagram 主页', 'TAB');
      // Reread only the loaded page/cache. No navigation, scrolling or request.
      return snapshot(entry);
    },
    async scrollProfile() {
      return operation('profile_scroll', async timing => {
        const entry = owned.get('profile');
        if (!entry) throw error('尚未打开 Instagram 主页', 'TAB');
        await throttle('profile_scroll', timing);
        const before = await snapshot(entry);
        const known = new Map([...(before.links || []), ...(before.posts || [])].map(post => [post.shortcode, post.ts]));
        await chrome.scripting.executeScript({target: {tabId: entry.id}, world: 'ISOLATED', func: () => {
          window.scrollTo({top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'instant'});
        }});
        counted('profile_scroll');
        const until = Date.now() + Math.min(timeoutMs, 3000);
        let latest = before;
        do {
          await delay(Math.max(200, pollMs), signal);
          latest = await snapshot(entry);
          if (latest.timeline?.complete || [...(latest.links || []), ...(latest.posts || [])].some(post =>
            !known.has(post.shortcode) || (post.ts && post.ts !== known.get(post.shortcode)))) break;
        } while (Date.now() < until);
        return latest;
      });
    },
    async close() {
      // Never close a tab the user has repurposed or a login/challenge page.
      for (const entry of owned.values()) {
        if (entry.keepOpen) continue;
        const tab = await chrome.tabs.get(entry.id).catch(() => null);
        if (tab && matches(tab.url, entry) && (!tab.pendingUrl || matches(tab.pendingUrl, entry))) {
          await chrome.tabs.remove(entry.id).catch(() => {});
        }
      }
      owned.clear();
    },
  };
}
