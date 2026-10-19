/* Offline persistence integration: a disposable browser profile, no collection
 * or external requests. Uses the same browser overrides as the full smoke test. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const KEY = 'OFFLINE_SAVED_YOUTUBE_KEY_DO_NOT_LOG';
const STORE = 'metrics.preferences.v1';

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'social-metrics-preferences-test-'));
  const extensionPath = path.resolve(__dirname, '../extension');
  const cdpMode = process.env.EXTENSION_LOAD_MODE === 'cdp';
  const errors = [], externalRequests = [];
  let context, lastPage;
  async function launch(colorScheme = 'dark') {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE || process.env.EDGE_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(cdpMode ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]),
        '--no-first-run', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND'],
      viewport: {width: 1440, height: 1050},
      colorScheme,
    });
    await context.route('**/*', route => {
      if (route.request().url().startsWith('chrome-extension:')) return route.continue();
      externalRequests.push(new URL(route.request().url()).protocol);
      return route.abort();
    });
    if (cdpMode) {
      const cdp = await context.browser().newBrowserCDPSession();
      try { await cdp.send('Extensions.loadUnpacked', {path: extensionPath}); }
      finally { await cdp.detach(); }
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    return `chrome-extension://${new URL(worker.url()).host}/index.html`;
  }
  async function open(url) {
    const page = await context.newPage();
    lastPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(() => import('./app.mjs').then(() => true));
    return page;
  }
  async function stored(page) {
    return page.evaluate(async key => (await chrome.storage.local.get(key))[key], STORE);
  }
  async function waitSettings(page, expected) {
    await waitStored(page, value => Object.entries(expected).every(([field, setting]) => value?.settings?.[field] === setting));
  }
  async function waitKey(page, expected) {
    await waitStored(page, value => value?.youtubeKey === expected);
  }
  async function waitStored(page, predicate) {
    // Poll resolved storage reads; a Promise is itself truthy in a browser
    // waitForFunction predicate, even before a queued write has completed.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (predicate(await stored(page))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for persisted preference state');
  }
  async function showKey(page) {
    await page.locator('#youtubeSection').evaluate(element => { element.open = true; });
  }
  async function appearanceState(page) {
    return page.evaluate(() => ({theme: document.documentElement.dataset.theme,
      themeMode: document.documentElement.dataset.themeMode, style: document.documentElement.dataset.style}));
  }
  try {
    let url = await launch();
    let page = await open(url);
    await page.locator('#platformSelect').selectOption('all');
    await showKey(page);
    assert.equal(await page.locator('#rememberYoutubeKey').isChecked(), true);
    await page.locator('#youtubeKey').fill(KEY);
    await page.locator('#dateMode').selectOption('quarter');
    await page.locator('#quarterYear').fill('2024');
    await page.locator('#quarter').selectOption('1');
    await page.locator('#timeZone').selectOption('UTC');
    await page.getByText('高级设置', {exact: true}).click();
    await page.locator('#maxPages').fill('9');
    await page.locator('#maxPosts').fill('55');
    await page.locator('#scanMode').selectOption('complete');
    await page.locator('#minDelay').fill('4');
    await page.locator('#maxDelay').fill('6');
    await page.locator('#platformSelect').selectOption('youtube');
    await page.locator('#themeMode').selectOption('system');
    await page.locator('#interfaceStyle').selectOption('classic');
    const expected = {platformSelect: 'youtube', dateMode: 'quarter', quarterYear: 2024, quarter: 1, timeZone: 'UTC',
      maxPages: 9, maxPosts: 55, scanMode: 'complete', minDelay: 4, maxDelay: 6, themeMode: 'system', interfaceStyle: 'classic'};
    await waitSettings(page, expected);
    await waitKey(page, KEY);
    assert.deepEqual(await appearanceState(page), {theme: 'dark', themeMode: 'system', style: 'classic'});
    assert.equal(await page.locator('#youtubeKey').inputValue(), KEY, 'Changing appearance must leave the current key input intact');

    // Older result provenance must not overwrite more recent preferences.
    await page.evaluate(async () => chrome.storage.session.set({lastRun: {results: [], meta: {}, running: false,
      options: {dateMode: 'date', targetDate: '2020-01-01', timeZone: 'Europe/London'}}}));
    await page.reload();
    await page.evaluate(() => import('./app.mjs').then(() => true));
    for (const [field, value] of Object.entries(expected)) assert.equal(await page.locator('#' + field).inputValue(), String(value));
    assert.deepEqual(await appearanceState(page), {theme: 'dark', themeMode: 'system', style: 'classic'});
    assert.equal(await page.locator('#youtubeKey').inputValue(), KEY);
    assert.equal(await page.locator('#datePreview').textContent(), '2024-01-01 至 2024-03-31 · 共 91 天');
    const session = await page.evaluate(() => chrome.storage.session.get(null));
    assert.ok(!JSON.stringify(session).includes(KEY));

    // Real browser exit clears session storage but retains the local settings.
    const version = context.browser().version();
    await context.close(); context = undefined;
    // The chosen system mode, not its old resolved dark color, must persist.
    url = await launch('light');
    page = await open(url);
    for (const [field, value] of Object.entries(expected)) assert.equal(await page.locator('#' + field).inputValue(), String(value));
    assert.deepEqual(await appearanceState(page), {theme: 'light', themeMode: 'system', style: 'classic'});
    assert.equal(await page.locator('#youtubeKey').inputValue(), KEY);
    await showKey(page);
    await page.screenshot({path: path.join(os.tmpdir(), 'social-metrics-preferences.png'), fullPage: true});

    // Reloaded secrets are registered before any diagnostics are recorded.
    await page.evaluate(secret => {
      const error = new Error('offline failure ' + secret);
      window.dispatchEvent(new ErrorEvent('error', {error, message: error.message}));
    }, KEY);
    await page.locator('#diagnosticsDetails').evaluate(element => { element.open = true; });
    await page.waitForFunction(() => document.querySelector('#diagnosticText').value.includes('operation.failed'));
    assert.ok(!(await page.locator('#diagnosticText').inputValue()).includes(KEY));
    await page.locator('#clearLogs').click();
    await page.waitForFunction(() => document.querySelector('#logFeedback').textContent.includes('已清空旧诊断日志'));
    assert.equal((await stored(page)).youtubeKey, KEY, 'Clearing diagnostics must not clear saved preferences');

    // A stale second worktab changing an unrelated preference cannot bring a
    // cleared secret back. Clear also removes it from the current input.
    const second = await open(url);
    assert.equal(await second.locator('#youtubeKey').inputValue(), KEY);
    await page.locator('#clearYoutubeKey').click();
    await waitKey(page, undefined);
    assert.equal(await page.locator('#youtubeKey').inputValue(), '');
    assert.equal(await page.locator('#rememberYoutubeKey').isChecked(), false);
    await second.locator('#themeMode').selectOption('dark');
    await second.locator('#interfaceStyle').selectOption('tech');
    await waitSettings(second, {themeMode: 'dark', interfaceStyle: 'tech'});
    assert.equal((await stored(second)).youtubeKey, undefined, 'An appearance edit in a stale worktab must not restore a cleared key');
    assert.equal(await second.locator('#youtubeKey').inputValue(), KEY, 'Appearance edits must not modify the existing input');
    await second.locator('#quarter').selectOption('2');
    await waitSettings(second, {quarter: 2});
    assert.equal((await stored(second)).youtubeKey, undefined);
    await second.close();
    await page.reload();
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(await page.locator('#youtubeKey').inputValue(), '');
    assert.equal(await page.locator('#quarter').inputValue(), '2');
    assert.deepEqual(await appearanceState(page), {theme: 'dark', themeMode: 'dark', style: 'tech'});
    await showKey(page);

    // Opting out keeps the typed key available on this page, never on reopen.
    await page.locator('#youtubeKey').fill(KEY);
    await page.locator('#youtubeKey').blur();
    assert.equal((await stored(page)).youtubeKey, undefined);
    await page.locator('#rememberYoutubeKey').check();
    await waitKey(page, KEY);
    await page.locator('#rememberYoutubeKey').uncheck();
    await waitKey(page, undefined);
    assert.equal(await page.locator('#youtubeKey').inputValue(), KEY);
    await page.reload();
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(await page.locator('#youtubeKey').inputValue(), '');
    assert.equal(await page.locator('#rememberYoutubeKey').isChecked(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'Settings changes must not request any remote service');
    console.log(`PASS ${version}: configuration, appearance and key survive reload and browser restart; restored system mode follows the new system color; stale result dates do not overwrite settings; appearance edits cannot restore a cleared key; clear/opt-out and cross-tab clearing are durable; diagnostics/session exclude key; zero collection or external requests.`);
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) console.error('Persistence test state:', await lastPage.evaluate(async key => {
      const stored = (await chrome.storage.local.get(key))[key];
      return {settings: stored?.settings, remembersKey: stored?.rememberYoutubeKey, hasStoredKey: Boolean(stored?.youtubeKey),
        platform: document.querySelector('#platformSelect').value, hasInputKey: Boolean(document.querySelector('#youtubeKey').value),
        checkbox: document.querySelector('#rememberYoutubeKey').checked,
        feedback: document.querySelector('#preferencesFeedback').textContent};
    }, STORE).catch(() => null));
    throw error;
  } finally {
    await context?.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
