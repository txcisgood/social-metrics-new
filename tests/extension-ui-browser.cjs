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
    await page.locator('#themeMode').selectOption(themeMode, {force: true});
    await page.locator('#interfaceStyle').selectOption(style, {force: true});
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

  async function selectControls(id) {
    const native = page.locator(`#${id}`), control = page.locator(`.select-control[data-select-id="${id}"]`);
    const trigger = control.locator('.select-trigger');
    assert.equal(await trigger.getAttribute('role'), 'combobox');
    const listbox = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
    assert.equal(await listbox.getAttribute('role'), 'listbox');
    const popover = page.locator('.select-popover').filter({has: listbox});
    assert.equal(await popover.count(), 1);
    return {native, trigger, listbox, popover};
  }

  async function chooseFromMenu(id, value) {
    const select = await selectControls(id);
    await select.trigger.click();
    await select.popover.waitFor({state: 'visible'});
    await select.listbox.locator(`[role="option"][data-value="${value}"]`).click();
    await select.popover.waitFor({state: 'hidden'});
    assert.equal(await select.native.inputValue(), value);
    assert.equal(await select.trigger.getAttribute('aria-expanded'), 'false');
    return select;
  }

  async function screenshotSelect(id, name) {
    const {trigger, popover} = await selectControls(id);
    await trigger.click();
    await popover.waitFor({state: 'visible'});
    await assertHelpWithinViewport(popover, name);
    if (id === 'themeMode') assert.ok((await popover.boundingBox()).width >= 199,
      'Compact header controls need a readable menu at least 200px wide');
    await painted();
    await page.screenshot({path: path.join(previewDirectory, `${browserLabel}-${name}.png`),
      fullPage: false, animations: 'disabled'});
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
  }

  async function verifySelectUI() {
    assert.equal(await page.locator('.select-control').count(), await page.locator('select').count(),
      'Every native select must have one consistent visual control');
    const theme = await selectControls('themeMode');
    assert.equal(await theme.native.getAttribute('aria-hidden'), 'true');
    assert.equal(await theme.native.getAttribute('tabindex'), '-1');
    assert.equal(await theme.trigger.getAttribute('title'), await theme.native.evaluate(element => element.selectedOptions[0].label));
    assert.equal(await page.getByRole('combobox', {name: '颜色模式', exact: true}).count(), 1,
      'The visible select needs its label without a duplicate native combobox');
    await page.locator('label').filter({hasText: /^颜色模式$/}).click();
    assert.equal(await theme.trigger.evaluate(element => element === document.activeElement), true);
    assert.equal(await theme.popover.isVisible(), false, 'Clicking a label focuses the control without opening it');

    await page.evaluate(() => {
      window.__selectTestChanges = {input: 0, change: 0};
      for (const event of ['input', 'change']) document.getElementById('themeMode')
        .addEventListener(event, () => window.__selectTestChanges[event]++);
    });
    await chooseFromMenu('themeMode', 'light');
    assert.deepEqual(await page.evaluate(() => window.__selectTestChanges), {input: 1, change: 1},
      'One pointer choice must dispatch exactly one input/change pair');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');

    // Keyboard selection uses a highlighted option while focus stays on the
    // combobox. Navigation alone must not overwrite the saved selection.
    await theme.trigger.focus();
    await page.keyboard.press('Space');
    await theme.popover.waitFor({state: 'visible'});
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    const active = await theme.trigger.getAttribute('aria-activedescendant');
    assert.equal(await page.locator(`#${active}`).getAttribute('data-value'), 'light');
    assert.equal(await theme.trigger.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await theme.popover.waitFor({state: 'hidden'});
    assert.equal(await theme.native.inputValue(), 'light');

    await page.keyboard.press('Enter');
    await theme.popover.waitFor({state: 'visible'});
    await page.keyboard.press('End');
    assert.equal(await theme.native.inputValue(), 'light');
    await page.keyboard.press('Space');
    await theme.popover.waitFor({state: 'hidden'});
    assert.equal(await theme.native.inputValue(), 'system');

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    assert.equal(await theme.native.inputValue(), 'light');
    await theme.trigger.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    await theme.popover.waitFor({state: 'hidden'});
    assert.equal(await theme.native.inputValue(), 'light', 'Escape must cancel the pending choice');
    assert.equal(await theme.trigger.evaluate(element => element === document.activeElement), true);
    await theme.trigger.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await theme.popover.waitFor({state: 'hidden'});
    assert.equal(await theme.trigger.evaluate(element => element === document.activeElement), false,
      'Tab must move to the next control without trapping keyboard users');
    assert.equal(await theme.native.inputValue(), 'light');
    await theme.trigger.click();
    await page.keyboard.press('End');
    await page.locator('h1').click();
    await theme.popover.waitFor({state: 'hidden'});
    assert.equal(await theme.native.inputValue(), 'light');

    const platform = await selectControls('platformSelect');
    await platform.trigger.click();
    await page.keyboard.press('y');
    await page.keyboard.press('Enter');
    assert.equal(await platform.native.inputValue(), 'youtube', 'Typeahead must select a matching platform');
    await chooseFromMenu('platformSelect', 'instagram');

    // Native changes still drive the collection code. The enhanced control
    // must mirror programmatic disable/enable and asynchronously loaded tabs.
    await theme.native.evaluate(element => { element.disabled = true; });
    await page.waitForFunction(() => document.querySelector('.select-control[data-select-id="themeMode"] .select-trigger').disabled);
    await theme.trigger.click({force: true});
    assert.equal(await theme.popover.isVisible(), false);
    await theme.native.evaluate(element => { element.disabled = false; });
    await page.waitForFunction(() => !document.querySelector('.select-control[data-select-id="themeMode"] .select-trigger').disabled);

    const tabs = await selectControls('tabSelect');
    const originalTabs = await tabs.native.evaluate(element => ({html: element.innerHTML, value: element.value}));
    await tabs.native.evaluate(element => {
      element.replaceChildren(new Option('请选择 Instagram 标签页', ''),
        new Option('示例 Instagram 标签页 A', 'offline-tab-a'));
    });
    await tabs.trigger.click();
    await tabs.popover.waitFor({state: 'visible'});
    await tabs.native.evaluate(element => element.append(new Option('示例 Instagram 标签页 B · 新加载的页面', 'offline-tab-b')));
    await tabs.listbox.locator('[role="option"][data-value="offline-tab-b"]').waitFor({state: 'visible'});
    await tabs.listbox.locator('[role="option"][data-value="offline-tab-b"]').click();
    assert.equal(await tabs.native.inputValue(), 'offline-tab-b');
    assert.match(await tabs.trigger.textContent(), /标签页 B/);
    await tabs.native.evaluate((element, original) => {
      element.innerHTML = original.html;
      element.value = original.value;
      element.dispatchEvent(new Event('change', {bubbles: true}));
    }, originalTabs);
    await chooseFromMenu('themeMode', 'dark');
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

    // Real keyboard navigation distinguishes keyboard focus from the focus
    // left behind by a mouse click, which must not pin the explanation.
    await trigger.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await popover.waitFor({state: 'visible'});
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    assert.equal(await popover.isVisible(), true, `${label}: keyboard focus keeps help available`);
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);

    // A mouse click may leave focus on the button, but moving away still
    // dismisses the explanation. The pointer can also move onto its text.
    await page.locator('h1').click();
    await trigger.click();
    await popover.waitFor({state: 'visible'});
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await page.mouse.move(1, 1);
    await popover.waitFor({state: 'hidden'});
    await trigger.click();
    await popover.waitFor({state: 'visible'});
    await popover.hover();
    await page.waitForTimeout(300);
    assert.equal(await popover.isVisible(), true, `${label}: clicked help remains readable while hovered`);
    await page.mouse.move(1, 1);
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

  async function verifyHelpTransitions() {
    const triggers = page.locator('[data-help-trigger]'), first = triggers.first(), second = triggers.nth(1);
    const firstId = await first.getAttribute('aria-controls'), secondId = await second.getAttribute('aria-controls');
    const firstPanel = page.locator(`#${firstId}`), secondPanel = page.locator(`#${secondId}`);
    await page.locator('h1').click();
    await first.hover();
    await firstPanel.waitFor({state: 'visible'});
    const size = await first.evaluate(element => {
      const circle = getComputedStyle(element, '::before');
      return {hit: element.getBoundingClientRect().width, circle: parseFloat(circle.width), font: parseFloat(getComputedStyle(element).fontSize)};
    });
    assert.ok(size.hit >= 24 && size.circle <= 16 && size.font <= 12,
      'The smaller info glyph must retain its usable hit target');
    assert.match(await firstPanel.evaluate(element => getComputedStyle(element).animationName), /help-appear/);
    assert.ok(await firstPanel.evaluate(element => getComputedStyle(element).animationDuration.split(',').some(value => parseFloat(value) > 0)));
    const bounds = await firstPanel.boundingBox();
    await page.mouse.move(1, 1);
    await page.waitForFunction(id => document.getElementById(id).classList.contains('is-closing'), firstId);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 25);
    await page.waitForFunction(id => !document.getElementById(id).classList.contains('is-closing'), firstId);
    await page.waitForTimeout(300);
    assert.equal(await firstPanel.isVisible(), true, 'Reentering during fade-out must cancel the pending close');

    await page.mouse.move(1, 1);
    await second.hover();
    await secondPanel.waitFor({state: 'visible'});
    await firstPanel.waitFor({state: 'hidden'});
    await page.waitForTimeout(300);
    assert.equal(await secondPanel.isVisible(), true, 'An old close timer must not dismiss a newly hovered explanation');
    assert.equal(await page.locator('.setting-help-popover:popover-open').count(), 1);
    await page.keyboard.press('Escape');

    await page.emulateMedia({reducedMotion: 'reduce'});
    await first.hover();
    await firstPanel.waitFor({state: 'visible'});
    const reduced = await firstPanel.evaluate(element => {
      const style = getComputedStyle(element);
      return {animation: style.animationDuration, transition: style.transitionDuration};
    });
    assert.ok([reduced.animation, reduced.transition].every(value => value.split(',').every(duration => parseFloat(duration) === 0)),
      'Reduced-motion preferences must suppress the tooltip animation');
    await page.mouse.move(1, 1);
    await firstPanel.waitFor({state: 'hidden'});
    await page.emulateMedia({reducedMotion: 'no-preference'});
  }

  async function verifyTouchHelp() {
    // CDP dispatches trusted touch/pointer events in this disposable profile;
    // it does not alter the user's browser or merely call a JavaScript handler.
    const cdp = await context.newCDPSession(page);
    const trigger = page.locator('[data-help-trigger]').first();
    const popover = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    };
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
      await trigger.scrollIntoViewIfNeeded();
      await painted();
      const bounds = await trigger.boundingBox(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await tap(x, y);
      await popover.waitFor({state: 'visible'});
      await page.waitForTimeout(350);
      assert.equal(await popover.isVisible(), true, 'Touch help must remain available after the finger leaves');
      await tap(x, y);
      await popover.waitFor({state: 'hidden'});
      await tap(x, y);
      await popover.waitFor({state: 'visible'});
      await tap(2, 2);
      await popover.waitFor({state: 'hidden'});
    } finally {
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: false});
      await cdp.detach();
    }
  }

  async function verifyIcons() {
    const iconState = await page.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const dimensions = async entries => Promise.all(Object.entries(entries).map(async ([size, path]) => {
        const image = new Image();
        image.src = chrome.runtime.getURL(path);
        await image.decode();
        return {size: Number(size), width: image.naturalWidth, height: image.naturalHeight};
      }));
      const brand = document.querySelector('.brand-mark');
      await brand.decode();
      const favicon = new Image();
      favicon.src = document.querySelector('link[rel="icon"]').href;
      await favicon.decode();
      return {extension: await dimensions(manifest.icons), action: await dimensions(manifest.action.default_icon),
        brand: {width: brand.naturalWidth, height: brand.naturalHeight}, favicon: favicon.naturalWidth};
    });
    assert.deepEqual(iconState.extension.map(icon => icon.size).sort((a, b) => a - b), [16, 32, 48, 128]);
    assert.ok(iconState.action.length > 0);
    for (const icon of [...iconState.extension, ...iconState.action]) {
      assert.equal(icon.width, icon.size); assert.equal(icon.height, icon.size);
    }
    assert.ok(iconState.brand.width > 0 && iconState.brand.height > 0);
    assert.equal(iconState.favicon, 32);
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
    await verifyIcons();

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
    assert.equal(await page.locator('#troubleshooting').evaluate(element => element.open), false);
    assert.equal(await page.locator('#copyLogs').isVisible(), false);
    assert.equal(await page.locator('#logList').isVisible(), false);
    assert.ok((await page.locator('#troubleshooting').boundingBox()).height <= 56,
      'Collapsed troubleshooting must occupy a single compact row');
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

    // Troubleshooting is secondary, keyboard accessible, and reachable from
    // navigation. Opening it does not change the primary collection controls.
    await page.locator('.activity-summary').focus(); await page.keyboard.press('Space');
    await page.locator('#copyLogs').waitFor({state: 'visible'});
    assert.equal(await page.locator('#troubleshooting').evaluate(element => element.open), true);
    assert.equal(await page.locator('#startButton').isEnabled(), true);
    await screenshot('diagnostics-expanded');
    await page.locator('.activity-summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#copyLogs').isVisible(), false);
    await page.locator('a[href="#troubleshooting"]').click();
    assert.equal(await page.locator('#troubleshooting').evaluate(element => element.open), true);
    await page.locator('.activity-summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));

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

    await verifySelectUI();

    // Selecting an input changes readiness, not collected-content metrics.
    await page.locator('#sampleButton').click();
    await page.locator('#dateMode').selectOption('quarter', {force: true});
    await page.locator('#quarterYear').fill('2024');
    await page.locator('#quarter').selectOption('1', {force: true});
    await page.locator('#timeZone').selectOption('UTC', {force: true});
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
    assert.equal(await page.locator('#troubleshooting').evaluate(element => element.open), false,
      'Important errors remain visible without expanding technical logs');
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
        if (mode !== 'system') {
          await screenshot(`desktop-${style}-${mode}`);
          if (style === 'tech' && mode === 'light') await screenshotSelect('themeMode', 'desktop-tech-light-select-theme');
          await screenshotSelect('dateMode', `desktop-${style}-${mode}-select`);
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
        }
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
    await verifyHelpTransitions();
    await verifyTouchHelp();
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
      await screenshotSelect('dateMode', `mobile-320-${style}-select`);
      await page.getByText('高级设置', {exact: true}).click();
      await verifyHelp(0, `Mobile ${style} first help`);
      await verifyHelp(helpCount - 1, `Mobile ${style} last help`);
      const lastTrigger = page.locator('[data-help-trigger]').last();
      await page.locator('h1').click();
      await lastTrigger.hover();
      const popover = page.locator(`#${await lastTrigger.getAttribute('aria-controls')}`);
      await popover.waitFor({state: 'visible'});
      await assertHelpWithinViewport(popover, `Mobile ${style} hover help`);
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

    // Import status is part of the picker itself, with a recognizable file
    // shape, full filename and count. Long names stay readable on mobile.
    const upload = {name: '2026年十月份Instagram合作博主账号采集清单.csv', mimeType: 'text/csv',
      buffer: Buffer.from('账号名,主页链接\n测试博主,https://www.instagram.com/example_creator/\n')};
    await page.locator('#inputFile').setInputFiles(upload);
    await page.waitForFunction(() => document.getElementById('filePicker').dataset.state === 'ready');
    assert.equal(await page.locator('#filePickerTitle').textContent(), upload.name);
    assert.match(await page.locator('#filePickerDescription').textContent(), /已导入 1 个账号/);
    assert.equal(await page.locator('#selectedFileIcon').isVisible(), true);
    assert.equal(await page.locator('#uploadFileIcon').isVisible(), false);
    const retainedResult = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    for (const [theme, style] of [['dark', 'tech'], ['light', 'classic']]) {
      await appearance(theme, style, theme);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({width, height: 1000});
        await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
        await noHorizontalOverflow(`Uploaded file ${style} ${width}`);
        await viewportScreenshot(`uploaded-file-${style}-${width}`, '#filePicker');
      }
    }
    await page.locator('#inputFile').setInputFiles({name: 'empty.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.alloc(0)});
    await page.waitForFunction(() => document.getElementById('filePicker').dataset.state === 'error');
    assert.match(await page.locator('#filePickerDescription').textContent(), /读取失败/);
    assert.equal(await page.locator('#filePickerTitle').textContent(), 'empty.xlsx');
    assert.deepEqual(await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun), retainedResult,
      'A failed next input must retain the previous result');
    await page.locator('#inputFile').setInputFiles(upload);
    await page.waitForFunction(() => document.getElementById('filePicker').dataset.state === 'ready');
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'UI rendering and local fixtures must not contact any remote service');
    console.log(`PASS ${context.browser().version()}: themed selects, six persisted appearance combinations, animated help with mouse exit/keyboard/touch/reentry/reduced motion, decoded extension/action/header/favicon icons, 390/320px layout, preserved results, and zero collection/network requests. Previews: ${previewDirectory}`);
  } catch (error) {
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
