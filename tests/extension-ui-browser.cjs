/* Offline visual/layout regression for the workbench. All data is synthetic;
 * a disposable browser profile and blocked networking keep real jobs untouched. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const executablePath = process.env.BROWSER_EXECUTABLE || process.env.EDGE_EXECUTABLE
  || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const browserLabel = executablePath.includes('Google Chrome') ? 'chrome' : 'edge';
const previewDirectory = path.resolve(__dirname, '../outputs/ui-preview');
const dateOptions = {dateMode: 'quarter', quarterYear: 2024, quarter: 1, timeZone: 'UTC',
  targetDates: ['2024-01-01', '2024-03-31'], maxPages: 5, maxPosts: 40, scanMode: 'recent', minDelay: 3, maxDelay: 5};
const firstAccount = {row_no: 2, platform: 'instagram', account_name: '示例创作者',
  profile_url: 'https://www.instagram.com/example_creator/'};
const reviewRows = [
  {...firstAccount, status: 'OK', post_id: 'ui-fixture-1', title: '示例内容一', published_at: '2024-03-12T08:00:00Z'},
  {...firstAccount, status: 'OK', post_id: 'ui-fixture-2', title: '示例内容二', published_at: '2024-03-14T08:00:00Z'},
  {...firstAccount, status: 'FAILED', error_code: 'PAGE_INCOMPLETE', error_title: '完整性待核对', error: '已取得的帖子保留，请核对主页。'},
  {row_no: 3, platform: 'instagram', account_name: '示例待采集账号', status: 'FAILED', skipped: true,
    error_code: 'IG_RATE_LIMIT', error: '该平台本轮已停止。此账号未发送采集请求。'},
  {row_no: 4, platform: 'instagram', account_name: '示例中断账号', status: 'FAILED',
    error_code: 'INTERRUPTED', error: '任务中断，此账号尚未完成。'},
];

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'social-metrics-ui-test-'));
  const extensionPath = path.resolve(__dirname, '../extension');
  const cdpMode = process.env.EXTENSION_LOAD_MODE === 'cdp';
  const errors = [], externalRequests = [];
  let context, page;
  await fs.mkdir(previewDirectory, {recursive: true});

  async function initialized() {
    await page.evaluate(() => import('./app.mjs').then(() => true));
    await page.waitForFunction(() => document.body.dataset.state && !document.querySelector('#platformSelect').disabled);
  }

  async function painted() {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }

  async function screenshot(name) {
    const viewport = page.viewportSize();
    const options = {path: path.join(previewDirectory, `${browserLabel}-${name}.png`), animations: 'disabled'};
    if (viewport.width > 900) {
      await painted();
      return page.screenshot({...options, fullPage: true});
    }
    // Some headless Chromium builds repeat the first painted tile when
    // fullPage captures a narrow document beyond the compositor viewport.
    // Mobile has ordinary document flow, so paint its full height in an actual
    // viewport instead. Responsive assertions still use the normal 844px
    // viewport; separate scrolled viewport captures verify its real behavior.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    try {
      await page.setViewportSize({width: viewport.width, height: Math.max(viewport.height, height)});
      await page.evaluate(() => window.scrollTo(0, 0));
      await painted();
      await page.screenshot({...options, fullPage: false});
    } finally {
      await page.setViewportSize(viewport);
      await painted();
    }
  }

  async function viewportScreenshot(name, selector) {
    await page.locator(selector).evaluate(element => element.scrollIntoView({block: 'start', behavior: 'instant'}));
    await painted();
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds.y >= -1 && bounds.y < page.viewportSize().height, `${selector} must appear in the real mobile viewport`);
    await page.screenshot({path: path.join(previewDirectory, `${browserLabel}-${name}.png`),
      fullPage: false, animations: 'disabled'});
  }

  async function noHorizontalOverflow(label) {
    const layout = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return {width, scrollWidth: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll('body *')].filter(element => {
          if (!element.getClientRects().length) return false;
          const bounds = element.getBoundingClientRect();
          return bounds.right > width + 1 || bounds.left < -1;
        }).slice(0, 8).map(element => element.id || element.className || element.tagName)};
    });
    assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
  }

  async function assertMetrics(expected) {
    const actual = await page.evaluate(() => Object.fromEntries(
      ['metricPosts', 'metricAccounts', 'metricReview', 'accountTotalHint', 'progressPercent']
        .map(id => [id, document.getElementById(id).textContent])));
    assert.deepEqual(actual, expected);
  }

  async function appearance(themeMode, style, effectiveTheme) {
    await page.locator('#themeMode').selectOption(themeMode);
    await page.locator('#interfaceStyle').selectOption(style);
    await page.waitForFunction(expected => {
      const {dataset} = document.documentElement;
      return dataset.theme === expected.theme && dataset.themeMode === expected.mode && dataset.style === expected.style;
    }, {theme: effectiveTheme, mode: themeMode, style});
    assert.equal(await page.locator('#themeMode').inputValue(), themeMode);
    assert.equal(await page.locator('#interfaceStyle').inputValue(), style);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), effectiveTheme);
  }

  async function waitSavedAppearance(themeMode, interfaceStyle) {
    const deadline = Date.now() + 10000;
    do {
      const saved = await page.evaluate(async () =>
        (await chrome.storage.local.get('metrics.preferences.v1'))['metrics.preferences.v1']?.settings);
      if (saved?.themeMode === themeMode && saved.interfaceStyle === interfaceStyle) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error('Appearance choices were not persisted');
  }

  async function retainedCollection() {
    return page.evaluate(async () => ({
      inputs: Object.fromEntries(['platformSelect', 'dateMode', 'quarterYear', 'quarter', 'timeZone', 'maxPages', 'maxPosts']
        .map(id => [id, document.getElementById(id).value])),
      labels: Object.fromEntries(['statusText', 'inputSummary', 'fileInfo', 'datePreview', 'progressText',
        'metricPosts', 'metricAccounts', 'metricReview', 'accountTotalHint', 'progressPercent']
        .map(id => [id, document.getElementById(id).textContent])),
      result: (await chrome.storage.session.get('lastRun')).lastRun,
      exportEnabled: !document.getElementById('exportXlsx').disabled,
    }));
  }

  async function assertHelpWithinViewport(popover, label) {
    const bounds = await popover.boundingBox(), viewport = page.viewportSize();
    assert.ok(bounds, `${label}: help must be displayed`);
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1,
      `${label}: help must fit horizontally in ${viewport.width}px`);
    assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1,
      `${label}: help must fit vertically in ${viewport.height}px`);
    await noHorizontalOverflow(label);
  }

  async function verifyHelp(index, label) {
    const trigger = page.locator('[data-help-trigger]').nth(index);
    const controlledId = await trigger.getAttribute('aria-controls');
    assert.ok(controlledId, `${label}: help button must name its explanation`);
    assert.equal(await trigger.evaluate(element => element.tagName), 'BUTTON');
    assert.ok(await trigger.getAttribute('aria-label'), `${label}: info button needs a meaningful accessible name`);
    const popover = page.locator(`#${controlledId}`);
    assert.equal(await popover.count(), 1);
    await page.locator('h1').click();
    await trigger.hover();
    await popover.waitFor({state: 'visible'});
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await assertHelpWithinViewport(popover, `${label} hover`);
    await popover.hover();
    assert.equal(await popover.isVisible(), true, `${label}: pointer can move onto the explanation`);
    await page.mouse.move(1, 1);
    await popover.waitFor({state: 'hidden'});

    // Keyboard users receive the same help, and Escape dismisses it without
    // moving focus away from the button they reached.
    await trigger.focus();
    await popover.waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);

    // A click pins the explanation for touch users and users who want to read
    // it slowly. Another click, an outside click, and Escape each dismiss it.
    await page.locator('h1').click();
    await trigger.click();
    await page.mouse.move(1, 1);
    await popover.waitFor({state: 'visible'});
    await trigger.click();
    await popover.waitFor({state: 'hidden'});
    await trigger.click();
    await popover.waitFor({state: 'visible'});
    await page.locator('h1').click();
    await popover.waitFor({state: 'hidden'});
    await trigger.click();
    await popover.waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
  }

  async function restoreRun(rows) {
    await page.evaluate(async snapshot => chrome.storage.session.set({lastRun: snapshot}), {
      results: rows, pending: [], running: false, options: dateOptions,
      meta: {'账号数': 3, 'Instagram页面操作次数': 9, 'YouTube API请求次数': 0, '耗时毫秒': 65000},
    });
    await page.reload();
    await initialized();
    assert.equal(await page.locator('#statusText').textContent(), '已恢复上次结果');
  }

  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath, ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(cdpMode ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]),
        '--no-first-run', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND'],
      viewport: {width: 1440, height: 1000},
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
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await initialized();

    // The default screen is usable, with no result table or invented numbers.
    assert.equal(await page.locator('body').getAttribute('data-state'), 'idle');
    await assertMetrics({metricPosts: '0', metricAccounts: '0', metricReview: '0',
      accountTotalHint: '等待导入账号', progressPercent: '0%'});
    assert.equal(await page.locator('#resultBody').count(), 0);
    for (const id of ['startButton', 'stopButton', 'exportXlsx', 'copyLogs', 'downloadLogs', 'problemPanel',
      'preferencesFeedback', 'youtubeKey', 'rememberYoutubeKey', 'clearYoutubeKey']) {
      assert.equal(await page.locator(`#${id}`).count(), 1, `${id} must remain a unique control`);
    }
    assert.equal(await page.locator('#exportXlsx').isDisabled(), true);
    assert.equal(await page.locator('#copyLogs').isEnabled(), true);
    assert.equal(await page.locator('#youtubeSection').evaluate(element => element.tagName), 'DETAILS');
    assert.equal(await page.locator('#diagnosticsDetails').evaluate(element => element.tagName), 'DETAILS');
    assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/);
    assert.equal(await page.locator('#themeMode').inputValue(), 'dark');
    assert.equal(await page.locator('#interfaceStyle').inputValue(), 'tech');
    assert.equal(await page.locator('html').getAttribute('data-theme-mode'), 'dark');
    assert.equal(await page.locator('html').getAttribute('data-style'), 'tech');
    assert.equal(await page.locator('[aria-current="step"]').count(), 1);
    assert.equal(await page.locator('#workflowSetup').getAttribute('aria-current'), 'step');
    await noHorizontalOverflow('Desktop empty');
    await screenshot('desktop-empty');

    // Real keyboard navigation reaches native controls with a visible outline.
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.skip-link').evaluate(element => element === document.activeElement), true);
    assert.ok((await page.locator('.skip-link').boundingBox()).y >= 0);
    let buttonFocus;
    for (let index = 0; index < 30; index++) {
      await page.keyboard.press('Tab');
      buttonFocus = await page.evaluate(() => {
        const element = document.activeElement, style = getComputedStyle(element);
        return {tag: element.tagName, focusVisible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth)};
      });
      if (buttonFocus.tag === 'BUTTON') break;
    }
    assert.equal(buttonFocus.tag, 'BUTTON', 'A native action must be reachable by keyboard');
    assert.equal(buttonFocus.focusVisible, true);
    assert.notEqual(buttonFocus.outlineStyle, 'none');
    assert.ok(buttonFocus.outlineWidth >= 2, 'Keyboard focus must remain visually distinguishable');

    // Scrolling long settings never hides the start/stop controls on desktop.
    await page.getByText('高级设置', {exact: true}).click();
    const desktopStart = await page.locator('#startButton').boundingBox();
    const scroll = await page.locator('.settings-scroll').evaluate(element => {
      const style = getComputedStyle(element);
      const before = {height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: style.overflowY};
      element.scrollTop = element.scrollHeight;
      return {...before, scrollTop: element.scrollTop};
    });
    assert.match(scroll.overflowY, /auto|scroll/);
    assert.ok(scroll.scrollHeight > scroll.height && scroll.scrollTop > 0, 'Long desktop settings must scroll internally');
    for (const id of ['startButton', 'stopButton']) {
      const bounds = await page.locator(`#${id}`).boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1001, `${id} must stay inside the desktop viewport`);
    }
    assert.ok(Math.abs((await page.locator('#startButton').boundingBox()).y - desktopStart.y) <= 1);
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.getByText('高级设置', {exact: true}).click();

    // Selecting an input changes readiness, not collected-content metrics.
    await page.locator('#sampleButton').click();
    await page.locator('#dateMode').selectOption('quarter');
    await page.locator('#quarterYear').fill('2024');
    await page.locator('#quarter').selectOption('1');
    await page.locator('#timeZone').selectOption('UTC');
    const savedBy = Date.now() + 10000;
    let savedSettings;
    do {
      savedSettings = await page.evaluate(async () =>
        (await chrome.storage.local.get('metrics.preferences.v1'))['metrics.preferences.v1']?.settings);
      if (savedSettings?.quarterYear === 2024 && savedSettings.quarter === 1 && savedSettings.timeZone === 'UTC') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < savedBy);
    assert.equal(savedSettings?.quarterYear, 2024);
    assert.equal(savedSettings?.quarter, 1);
    assert.equal(savedSettings?.timeZone, 'UTC');
    assert.equal(await page.locator('body').getAttribute('data-state'), 'ready');
    await assertMetrics({metricPosts: '0', metricAccounts: '0', metricReview: '0',
      accountTotalHint: '共 1 个账号', progressPercent: '0%'});
    await noHorizontalOverflow('Desktop ready');
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
    await screenshot('desktop-ready');

    // One account can have both posts and a review row. It counts once; skipped
    // and interrupted placeholders retain review visibility without progress.
    await restoreRun(reviewRows);
    assert.equal(await page.locator('body').getAttribute('data-state'), 'review');
    const expectedReview = {metricPosts: '2', metricAccounts: '1', metricReview: '3',
      accountTotalHint: '共 3 个账号', progressPercent: '33%'};
    await assertMetrics(expectedReview);
    assert.equal(await page.locator('#exportXlsx').isEnabled(), true);
    assert.equal(await page.locator('#workflowExport').getAttribute('aria-current'), 'step');
    assert.equal(await page.locator('#workflowCollect').getAttribute('data-status'), 'review');
    assert.equal(await page.locator('[aria-current="step"]').count(), 1);
    assert.equal(await page.locator('#datePreview').textContent(), '2024-01-01 至 2024-03-31 · 共 91 天');
    const restoredProgress = await page.locator('#progressText').textContent();
    await page.locator('#sampleButton').click();
    await assertMetrics(expectedReview);
    assert.equal(await page.locator('#progressText').textContent(), restoredProgress,
      'Loading a sample for the next run must preserve the retained run progress');
    assert.match(await page.locator('#inputSummary').textContent(), /已选 1 个账号/);
    await page.evaluate(() => window.__metricsReportError(Object.assign(new Error('Synthetic UI review fixture'),
      {code: 'PAGE_INCOMPLETE'}), 'collect'));
    assert.equal(await page.locator('#problemPanel').isVisible(), true);
    assert.match(await page.locator('#problemAction').textContent(), /导出|核对/);
    assert.ok(!/Error:|at .*\.mjs/.test(await page.locator('#problemPanel').textContent()));
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
    await noHorizontalOverflow('Desktop review');
    await screenshot('desktop-review');

    // Appearance choices affect presentation only. All six combinations keep
    // the next input, collection settings and retained result snapshot intact.
    const retained = await retainedCollection();
    await page.emulateMedia({colorScheme: 'light'});
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Explicit dark must ignore the OS');
    for (const style of ['tech', 'classic']) {
      for (const mode of ['dark', 'light', 'system']) {
        const effectiveTheme = mode === 'system' ? 'light' : mode;
        await appearance(mode, style, effectiveTheme);
        await noHorizontalOverflow(`Desktop ${style}/${mode}`);
        assert.deepEqual(await retainedCollection(), retained, `${style}/${mode} must retain collection state`);
        if (mode !== 'system') await screenshot(`desktop-${style}-${mode}`);
      }
    }
    await page.emulateMedia({colorScheme: 'dark'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('#themeMode').inputValue(), 'system');
    await page.emulateMedia({colorScheme: 'light'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await appearance('light', 'classic', 'light');
    await page.emulateMedia({colorScheme: 'dark'});
    await painted();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Explicit light must ignore the OS');
    await appearance('system', 'classic', 'dark');
    await waitSavedAppearance('system', 'classic');
    await page.reload();
    await initialized();
    assert.equal(await page.locator('#themeMode').inputValue(), 'system');
    assert.equal(await page.locator('#interfaceStyle').inputValue(), 'classic');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await assertMetrics(expectedReview);
    assert.equal(await page.locator('#datePreview').textContent(), '2024-01-01 至 2024-03-31 · 共 91 天');
    assert.equal(await page.locator('#exportXlsx').isEnabled(), true);

    await appearance('dark', 'tech', 'dark');
    await page.getByText('高级设置', {exact: true}).click();
    const helpCount = await page.locator('[data-help-trigger]').count();
    assert.ok(helpCount >= 4, 'Each advanced setting needs its own explanation');
    for (let index = 0; index < helpCount; index++) await verifyHelp(index, `Desktop help ${index + 1}`);
    await page.getByText('高级设置', {exact: true}).click();
    await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });

    for (const width of [390, 320]) {
      await page.setViewportSize({width, height: 844});
      await page.evaluate(() => window.scrollTo(0, 0));
      const mobile = await page.evaluate(() => {
        const panel = document.querySelector('.settings-panel'), scroll = document.querySelector('.settings-scroll');
        const controls = document.querySelector('.run-controls'), workspace = document.querySelector('#workspace');
        return {panelPosition: getComputedStyle(panel).position, scrollOverflow: getComputedStyle(scroll).overflowY,
          scrollHeight: scroll.scrollHeight, height: scroll.clientHeight,
          controlsBottom: controls.getBoundingClientRect().bottom, workspaceTop: workspace.getBoundingClientRect().top,
          documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight};
      });
      assert.ok(!['fixed', 'sticky'].includes(mobile.panelPosition), `Mobile ${width}: settings must follow document flow`);
      assert.ok(!['auto', 'scroll'].includes(mobile.scrollOverflow) || mobile.scrollHeight <= mobile.height + 1,
        `Mobile ${width}: no nested settings scrollbar`);
      assert.ok(mobile.controlsBottom <= mobile.workspaceTop + 1, `Mobile ${width}: controls must not overlay workspace`);
      assert.ok(mobile.documentHeight > mobile.viewportHeight);
      await noHorizontalOverflow(`Mobile ${width}`);
      await screenshot(`mobile-${width}`);
      await viewportScreenshot(`mobile-${width}-progress`, '#workspace');
      await viewportScreenshot(`mobile-${width}-export`, '.export-panel');
    }

    // Compact tooltips remain readable within a real 320px viewport in both
    // design styles, including the last field near the end of the settings.
    for (const style of ['tech', 'classic']) {
      await appearance(style === 'tech' ? 'dark' : 'light', style, style === 'tech' ? 'dark' : 'light');
      await page.getByText('高级设置', {exact: true}).click();
      await verifyHelp(0, `Mobile ${style} first help`);
      await verifyHelp(helpCount - 1, `Mobile ${style} last help`);
      const lastTrigger = page.locator('[data-help-trigger]').last();
      await lastTrigger.click();
      const popover = page.locator(`#${await lastTrigger.getAttribute('aria-controls')}`);
      await popover.waitFor({state: 'visible'});
      await assertHelpWithinViewport(popover, `Mobile ${style} pinned help`);
      await painted();
      await page.screenshot({path: path.join(previewDirectory, `${browserLabel}-mobile-320-${style}-help.png`),
        fullPage: false, animations: 'disabled'});
      await page.keyboard.press('Escape');
      await page.getByText('高级设置', {exact: true}).click();
      await noHorizontalOverflow(`Mobile ${style}`);
    }

    await page.setViewportSize({width: 1440, height: 1000});
    await appearance('dark', 'tech', 'dark');
    await waitSavedAppearance('dark', 'tech');
    await restoreRun(reviewRows.map(row => row.error_code === 'INTERRUPTED' ? {...row, error_code: 'CANCELLED'} : row));
    assert.equal(await page.locator('body').getAttribute('data-state'), 'stopped');
    await assertMetrics(expectedReview);
    assert.equal(await page.locator('#workflowCollect').getAttribute('data-status'), 'review');
    assert.match(await page.locator('#progressBar').getAttribute('aria-valuetext'), /采集已停止/);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'UI rendering and local fixtures must not contact any remote service');
    console.log(`PASS ${context.browser().version()}: six appearance combinations, system color changes and reload persistence, accessible hover/focus/click help, fixed desktop actions, 390/320px layout, preserved deduplicated results, and zero collection/network requests. Previews: ${previewDirectory}`);
  } catch (error) {
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
