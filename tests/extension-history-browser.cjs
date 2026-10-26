/* Real extension IndexedDB in a disposable browser profile. No platform calls. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('../extension/vendor/xlsx.full.min.js');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'social-metrics-history-'));
  const extensionPath = path.resolve(__dirname, '../extension'), cdp = process.env.EXTENSION_LOAD_MODE === 'cdp';
  let context, page, root;
  const errors = [], external = [];
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ignoreDefaultArgs: ['--disable-extensions'], viewport: {width: 1440, height: 1050},
      args: [...(cdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]),
        '--no-first-run', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      external.push(url.origin); return route.abort();
    });
    if (cdp) {
      const session = await context.browser().newBrowserCDPSession();
      try { await session.send('Extensions.loadUnpacked', {path: extensionPath}); } finally { await session.detach(); }
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    root = `chrome-extension://${new URL(worker.url()).host}`;
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(root + '/index.html'); await page.evaluate(() => import('./app.mjs').then(() => true));
  }
  async function historyOpen(count) {
    if (!await page.locator('#historyPanel').evaluate(element => element.open)) await page.locator('.history-summary').click();
    await page.waitForFunction(expected => document.querySelectorAll('.history-entry').length === expected, count);
  }
  async function download(type) {
    const pending = page.waitForEvent('download');
    await page.locator(`[data-history-action="${type}"]`).first().click();
    const file = await pending;
    return {name: file.suggestedFilename(), bytes: await fs.readFile(await file.path())};
  }
  try {
    await launch();
    assert.equal(await page.locator('[data-history-count]').textContent(), '0 / 5');
    const seeded = await page.evaluate(async () => {
      const {createHistoryStore} = await import('./lib/history.mjs');
      const accounts = createHistoryStore(), videos = createHistoryStore({module: 'youtube'});
      const comments = Array.from({length: 600}, (_, i) => ({id: 'comment-' + i, author: '用户' + i, text: '评论'.repeat(1000), type: '主评论'}));
      const run = (n, youtube) => ({id: 'run-' + n,
        meta: {inputName: '<原始文件>.xlsx', 账号数: 1, 结束时间: `2026-10-${String(20 + n).padStart(2, '0')}T12:00:00Z`,
          ...(youtube ? {采集模式: '视频 URL（含评论）'} : {})},
        results: [{row_no: 1, platform: youtube ? 'youtube' : 'instagram', status: 'OK', post_title: '历史视频',
          post_url: 'https://www.youtube.com/watch?v=00000000001', post_description: '历史简介', extra: {时长: 'PT15M2S'},
          ...(youtube ? {comments, comments_status: 'COMPLETE'} : {})}], youtubeKey: 'DO_NOT_STORE_KEY', diagnostics: {key: 'DO_NOT_STORE_KEY'}});
      // Concurrent writes, same IDs in different modules, and more than five
      // records exercise transactional pruning and module isolation.
      await Promise.all(Array.from({length: 7}, (_, i) => accounts.save(run(i, false))));
      await Promise.all(Array.from({length: 7}, (_, i) => videos.save(run(i, true))));
      await videos.save(run(6, true));
      const originalPut = IDBObjectStore.prototype.put;
      let rejected = false;
      try {
        IDBObjectStore.prototype.put = function(value, ...args) {
          if (this.name === 'summaries' && value.id === 'quota-failure') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          return originalPut.call(this, value, ...args);
        };
        try { await videos.save({...run(6, true), id: 'quota-failure'}); } catch { rejected = true; }
      } finally { IDBObjectStore.prototype.put = originalPut; }
      const list = await videos.list(), full = await videos.read('run-6');
      return {accountIds: (await accounts.list()).map(row => row.id), videoIds: list.map(row => row.id),
        removed: await videos.read('run-0'), summaryBytes: JSON.stringify(list).length,
        payloadBytes: new Blob([JSON.stringify(full)]).size * list.length,
        comments: full.results[0].comments.length, keySaved: JSON.stringify(full).includes('DO_NOT_STORE_KEY'),
        rejected, rolledBack: await videos.read('quota-failure') === undefined};
    });
    assert.deepEqual(seeded.accountIds, ['run-6', 'run-5', 'run-4', 'run-3', 'run-2']);
    assert.deepEqual(seeded.videoIds, seeded.accountIds); assert.equal(seeded.removed, undefined);
    assert.equal(seeded.comments, 600); assert.equal(seeded.keySaved, false);
    assert.equal(seeded.rejected, true); assert.equal(seeded.rolledBack, true);
    assert.ok(seeded.summaryBytes < 10000); assert.ok(seeded.payloadBytes > 10 * 1024 * 1024);
    await historyOpen(5);
    assert.equal(await page.locator('.history-source').first().textContent(), '<原始文件>.xlsx');
    assert.equal(await page.locator('#historyPanel img').count(), 0);
    // Current form choices cannot relabel a historical Instagram result.
    await page.locator('#platformSelect').selectOption('youtube', {force: true});
    let file = await download('xlsx'); assert.match(file.name, /^社媒采集-Instagram-/);
    assert.equal(XLSX.read(file.bytes, {type: 'buffer'}).Sheets['评论详情'], undefined);
    await page.locator('#clearButton').click(); assert.equal(await page.locator('.history-entry').count(), 5);
    await page.goto(root + '/youtube.html'); await page.evaluate(() => import('./app.mjs').then(() => true));
    await historyOpen(5); file = await download('xlsx'); assert.match(file.name, /^社媒采集-YouTube-/);
    const workbook = XLSX.read(file.bytes, {type: 'buffer'});
    assert.equal(workbook.Sheets['采集结果'].K2.v, '15:02');
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['评论详情']).length, 600);
    file = await download('json'); assert.match(file.name, /^社媒采集-YouTube-/);
    assert.equal(JSON.parse(file.bytes.toString()).results[0].comments.length, 600);
    const output = path.resolve(__dirname, '../outputs/history-preview'); await fs.mkdir(output, {recursive: true});
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({width, height: 1050});
      await page.locator('#historyPanel').evaluate(element => element.scrollIntoView());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const size = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(size.scroll <= size.width + 1, `${width}px history overflow`);
      if (width !== 390) await page.screenshot({path: path.join(output, `${cdp ? 'chrome' : 'edge'}-${width}.png`), fullPage: false});
    }
    await context.close(); context = null;
    await launch(); await historyOpen(5);
    assert.equal(await page.locator('#metricPosts').textContent(), '0', 'History does not silently replace current results');
    await page.locator('[data-history-action="remove"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.history-entry').length === 4);
    const deletedStayedDeleted = await page.evaluate(async () => {
      const {createHistoryStore} = await import('./lib/history.mjs');
      const store = createHistoryStore();
      await store.save({id: 'run-6', results: [{row_no: 1, platform: 'instagram', status: 'OK'}]});
      return (await store.read('run-6')) === undefined && (await store.list()).length === 4;
    });
    assert.equal(deletedStayedDeleted, true, 'Restoring a session must not resurrect deleted history');
    await page.goto(root + '/youtube.html'); await page.evaluate(() => import('./app.mjs').then(() => true));
    await historyOpen(5);
    const restored = await page.evaluate(async () => {
      const {createHistoryStore} = await import('./lib/history.mjs');
      return (await createHistoryStore({module: 'youtube'}).read('run-6')).results[0].comments.length;
    });
    assert.equal(restored, 600); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`PASS ${context.browser().version()}: five histories per module, atomic concurrent retention, stable IDs, separate summaries/full payloads above 10 MB, full comments, platform-tagged Excel/JSON, deletion and clear isolation, real browser restart, literal source names, 320/390px. No external requests.`);
  } finally { await context?.close(); await fs.rm(profile, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
