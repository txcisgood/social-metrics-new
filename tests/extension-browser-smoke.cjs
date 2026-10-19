/* Offline integration test: a fresh browser profile behind a mandatory local
 * fixture proxy; no real Instagram account or API key. Requires OpenSSL for
 * its temporary TLS certificate. Set PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE /
 * OPENSSL_EXECUTABLE when these are not on the normal development paths.
 * EDGE_EXECUTABLE remains supported. Official Chrome requires
 * EXTENSION_LOAD_MODE=cdp; the default flags mode remains suitable for Edge. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {execFileSync} = require('node:child_process');
const XLSX = require('../extension/vendor/xlsx.full.min.js');

const PRIVATE_KEY = 'OFFLINE_SECRET_API_KEY_9281_DO_NOT_LOG';
const PRIVATE_CAPTION = '=1+2 <script>PRIVATE_CAPTION_UNTRUSTED</script>';
const PRIVATE_NAMES = ['PRIVATE_ACCOUNT_ALPHA', 'PRIVATE_ACCOUNT_BETA', 'Robin Foxer'];
const OBSERVER_TIMEOUT = 'Passive fixture observer was not installed within 3 seconds';
const escapeHTML = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function profileHTML(username, mode) {
  if (mode === 'restricted') return '<html><head><title>Instagram</title></head><body><main><h2>Try again later</h2></main></body></html>';
  const codes = mode === 'detail-budget' ? ['TEST_POST', 'SECOND_POST'] : ['TEST_POST'];
  const total = mode === 'incomplete' ? 8 : codes.length;
  return `<html><head><title>Instagram offline profile</title></head><body><main>
    <header><h2>${escapeHTML(username)}</h2><ul><li><span>${total} posts</span></li>
    <li><a href="/${escapeHTML(username)}/followers/"><span title="500">500 followers</span></a></li></ul></header>
    <section>${codes.map(code => `<a href="/p/${code}/">Open fixture post</a>`).join('')}</section>
    </main>${mode === 'passive' ? `<script>
      // This case verifies a response that arrives after observation starts.
      // A fixed 400ms timer races the reader's 400ms polling across browsers.
      let attempts = 0;
      function loadFixtureData() {
        if (!window[Symbol.for('social-metrics.instagram.page-observer.v1')]) {
          if (attempts++ >= 60) throw new Error(${JSON.stringify(OBSERVER_TIMEOUT)});
          setTimeout(loadFixtureData, 50); return;
        }
        fetch('/graphql/query/?fixture=page-owned').then(r => r.json()).then(data => { window.fixtureData = data; });
      }
      setTimeout(loadFixtureData, 50);
    </script>` : ''}</body></html>`;
}

function postHTML(shortcode, timestamp) {
  return `<html><head><title>Instagram offline post</title></head><body><main><article>
    <header><a href="/team_foxer/">team_foxer</a></header><h1>${escapeHTML(PRIVATE_CAPTION)}</h1>
    <a href="/p/${shortcode}/"><time datetime="${timestamp}">Fixture publication date</time></a>
    <a href="/p/${shortcode}/liked_by/"><span>88 likes</span></a><button>View all 3 comments</button>
    </article></main></body></html>`;
}

function diagnosticJSON(text) {
  assert.match(text, /诊断日志/);
  const snapshot = JSON.parse(text.slice(text.indexOf('{')));
  assert.match(snapshot.id, /^SM-\d{14}-[a-f0-9]{12}$/);
  assert.ok(Array.isArray(snapshot.entries));
  return snapshot;
}

function assertPrivateDataAbsent(text) {
  for (const secret of [PRIVATE_KEY, PRIVATE_CAPTION, 'PRIVATE_CAPTION_UNTRUSTED', ...PRIVATE_NAMES]) {
    assert.ok(!text.includes(secret), `Diagnostic unexpectedly contained fixture private data: ${secret}`);
  }
}

async function savedResults(page) {
  return page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun?.results || []);
}

async function displayedDiagnostics(page) {
  await page.locator('#diagnosticsDetails').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.querySelector('#diagnosticText').value.includes('"schemaVersion"'));
  return page.locator('#diagnosticText').inputValue();
}

async function downloadedDiagnostics(page) {
  const downloading = page.waitForEvent('download');
  await page.locator('#downloadLogs').click();
  return fs.readFile(await (await downloading).path(), 'utf8');
}

async function waitForHeldRequest(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Offline fixture did not receive the held request')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

// Browser-context routing can miss the initial request of a tab created by
// chrome.tabs.create. A mandatory local proxy is the network boundary: it
// tunnels only Instagram to our own TLS fixture server and rejects every
// other destination, without resolving or connecting to an external host.
async function localFixtureProxy(directory, handler) {
  const keyPath = path.join(directory, 'fixture-key.pem'), certPath = path.join(directory, 'fixture-cert.pem');
  execFileSync(process.env.OPENSSL_EXECUTABLE || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=www.instagram.com'], {stdio: 'ignore'});
  const sockets = new Set();
  const remember = socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy()); // Browser cancellation can reset local fixture connections.
  };
  const fixture = https.createServer({key: await fs.readFile(keyPath), cert: await fs.readFile(certPath)}, (request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500); response.end('Offline fixture failed'); console.error(error);
    });
  });
  fixture.on('connection', remember);
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((_request, response) => { response.writeHead(403); response.end('Offline test only'); });
  proxy.on('connection', remember);
  proxy.on('connect', (request, socket, head) => {
    if (request.url !== 'www.instagram.com:443') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect(fixture.address().port, '127.0.0.1');
    remember(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {server: `http://127.0.0.1:${proxy.address().port}`, async close() {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => fixture.close(resolve))]);
  }};
}

(async () => {
  const extensionLoadMode = process.env.EXTENSION_LOAD_MODE || 'flags';
  assert.ok(['flags', 'cdp'].includes(extensionLoadMode), 'EXTENSION_LOAD_MODE must be flags or cdp');
  const extensionPath = path.resolve(__dirname, '../extension');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'social-metrics-extension-test-'));
  let context, fixtureProxy;
  const requests = [];
  const privateAPIRequests = [];
  const pageOwnedRequests = [];
  const fixtureErrors = [];
  let responseMode = 'ok';
  let fixtureTimestamp = new Date().toISOString();
  let releaseRequest;
  let heldRequestStarted;
  let navigationStarted;
  try {
    fixtureProxy = await localFixtureProxy(profile, async (request, response) => {
      const u = new URL(request.url, 'https://www.instagram.com');
      if (responseMode === 'passive' && u.pathname === '/graphql/query/' && u.searchParams.get('fixture') === 'page-owned') {
        pageOwnedRequests.push(u.pathname);
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(JSON.stringify({items: [{code: 'TEST_POST', user: {username: 'team_foxer'},
          taken_at: Math.floor(Date.parse(fixtureTimestamp) / 1000), like_count: 88, comment_count: 3, media_type: 1, caption: {text: PRIVATE_CAPTION}}]})); return;
      }
      if (/^\/(?:api|graphql|ajax)(?:\/|$)/.test(u.pathname)) {
        privateAPIRequests.push(u.pathname);
        response.writeHead(403); response.end('Private API requests are forbidden in this test'); return;
      }
      if (request.headers['sec-fetch-dest'] !== 'document') { response.writeHead(204); response.end(); return; }
      requests.push(u.pathname);
      navigationStarted?.();
      const parts = u.pathname.split('/').filter(Boolean);
      if (responseMode === 'hold' && parts.length === 1) await new Promise(resolve => { releaseRequest = resolve; heldRequestStarted?.(); });
      const body = ['p', 'reel'].includes(parts[0]) ? postHTML(parts[1], fixtureTimestamp) : profileHTML(parts[0] || 'team_foxer', responseMode);
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}); response.end(body);
    });
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      proxy: {server: fixtureProxy.server},
      ignoreHTTPSErrors: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      executablePath: process.env.BROWSER_EXECUTABLE || process.env.EDGE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : undefined),
      args: [...(extensionLoadMode === 'cdp' ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]), '--no-first-run', '--disable-background-networking',
        '--disable-quic', '--ignore-certificate-errors', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
      viewport: {width: 1440, height: 1050}
    });
    context.on('page', fixturePage => fixturePage.on('pageerror', error => {
      if (error.message === OBSERVER_TIMEOUT) fixtureErrors.push(error.message);
    }));
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname === 'www.instagram.com') return route.continue(); // Mandatory proxy serves only local fixtures.
      if (u.protocol === 'chrome-extension:') return route.continue();
      return route.abort();
    });
    if (extensionLoadMode === 'cdp') {
      // Playwright launches with a debugging pipe. This browser-level command
      // replaces flags removed from official Chrome; only this fresh fixture
      // profile enables the additional debugging capability.
      const cdp = await context.browser().newBrowserCDPSession();
      try { await cdp.send('Extensions.loadUnpacked', {path: extensionPath}); }
      finally { await cdp.detach(); }
    }
    console.log(`Browser: ${context.browser().version()}; extension loading: ${extensionLoadMode}`);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
    const id = new URL(worker.url()).host;
    const instagram = await context.newPage();
    await instagram.goto('https://www.instagram.com/team_foxer/');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.locator('#exportTitle').waitFor();
    // First-use templates need neither an account import, Instagram read nor
    // YouTube key. Verify the downloaded bytes, then import a filled copy.
    const beforeTemplates = requests.length;
    let instagramTemplate;
    for (const [platform, label] of [['instagram', 'Instagram'], ['youtube', 'YouTube'], ['all', '混合']]) {
      await page.locator('#platformSelect').selectOption(platform);
      assert.equal(await page.locator('#downloadTemplate').textContent(), `下载 ${label}模板`);
      const pendingTemplate = page.waitForEvent('download');
      await page.locator('#downloadTemplate').click();
      const template = await pendingTemplate;
      assert.equal(template.suggestedFilename(), `社媒采集-${label}账号模板.xlsx`);
      const bytes = await fs.readFile(await template.path());
      const wb = XLSX.read(bytes, {type: 'buffer'});
      assert.deepEqual(wb.SheetNames, ['账号清单', '填写说明']);
      assert.equal(wb.Sheets['账号清单'].B1.v, '主页链接（必填）');
      assert.ok(!wb.Sheets['账号清单'].B2?.v);
      assert.match(await page.locator('#templateFeedback').textContent(), /只需填写主页链接/);
      assert.equal(await page.locator('#inputFile').inputValue(), '');
      if (platform === 'instagram') instagramTemplate = {wb, bytes};
    }
    assert.equal(requests.length, beforeTemplates, 'Template exports cannot initiate collection');
    await page.locator('#inputFile').setInputFiles({name: 'empty-template.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: instagramTemplate.bytes});
    await page.locator('#warnings').getByText(/还没有填写主页链接/).waitFor();
    instagramTemplate.wb.Sheets['账号清单'].B2 = {t: 's', v: 'https://www.instagram.com/team_foxer/'};
    await page.locator('#inputFile').setInputFiles({name: 'filled-template.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(XLSX.write(instagramTemplate.wb, {type: 'buffer', bookType: 'xlsx'}))});
    await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('1 个可识别账号'));
    assert.equal(await page.locator('#sheetSelect').inputValue(), '账号清单');
    assert.equal(await page.locator('#warnings li').count(), 0);
    await page.locator('#platformSelect').selectOption('instagram');
    // The Instagram-only job must not request YouTube; the sentinel exercises
    // redaction if a later diagnostic happens to mention the entered key.
    await page.locator('#youtubeKey').evaluate((element, value) => { element.value = value; }, PRIVATE_KEY);
    await page.screenshot({path: path.join(os.tmpdir(), 'social-metrics-extension-empty.png'), fullPage: true});
    await page.locator('#sampleButton').click();
    await page.waitForFunction(() => document.querySelector('#tabSelect').value !== '');
    // The form previews calendar ranges without reading Instagram. Defaults
    // follow the selected timezone; a real run below uses the selected month.
    const current = await page.evaluate(() => {
      const parts = new Intl.DateTimeFormat('en-CA', {timeZone: document.querySelector('#timeZone').value,
        year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
      const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return {month: `${p.year}-${p.month}`, year: p.year, quarter: String(Math.ceil(Number(p.month) / 3))};
    });
    assert.equal(await page.locator('#targetMonth').inputValue(), current.month);
    assert.equal(await page.locator('#quarterYear').inputValue(), current.year);
    assert.equal(await page.locator('#quarter').inputValue(), current.quarter);
    const beforeDateSelection = requests.length;
    await page.locator('#dateMode').selectOption('month');
    assert.equal(await page.locator('#monthField').isVisible(), true);
    assert.equal(await page.locator('#daysField').isVisible(), false);
    await page.locator('#targetMonth').fill('2024-02');
    assert.equal(await page.locator('#datePreview').textContent(), '2024-02-01 至 2024-02-29 · 共 29 天');
    assert.equal(await page.locator('#datePreviewHint').isVisible(), false);
    await page.locator('#dateMode').selectOption('quarter');
    assert.equal(await page.locator('#monthField').isVisible(), false);
    assert.equal(await page.locator('#quarterField').isVisible(), true);
    await page.locator('#quarterYear').fill('2024');
    for (const [quarter, expected] of [
      ['1', '2024-01-01 至 2024-03-31 · 共 91 天'], ['2', '2024-04-01 至 2024-06-30 · 共 91 天'],
      ['3', '2024-07-01 至 2024-09-30 · 共 92 天'], ['4', '2024-10-01 至 2024-12-31 · 共 92 天'],
    ]) {
      await page.locator('#quarter').selectOption(quarter);
      assert.equal(await page.locator('#datePreview').textContent(), expected);
    }
    await page.locator('#quarterYear').fill('2099');
    assert.equal(await page.locator('#datePreview').textContent(), '2099-10-01 至 2099-12-31 · 共 92 天');
    assert.match(await page.locator('#datePreviewHint').textContent(), /尚未全部结束/);
    await page.locator('#dateMode').selectOption('range');
    assert.equal(await page.locator('#quarterField').isVisible(), false);
    assert.equal(await page.locator('#rangeField').isVisible(), true);
    await page.locator('#startDate').fill('2023-12-31');
    await page.locator('#endDate').fill('2024-01-01');
    assert.equal(await page.locator('#datePreview').textContent(), '2023-12-31 至 2024-01-01 · 共 2 天');
    await page.locator('#startDate').fill('2024-01-02');
    assert.equal(await page.locator('#datePreview').getAttribute('data-invalid'), 'true');
    assert.match(await page.locator('#datePreview').textContent(), /开始日期|起止日期/);
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#problemCode').textContent.includes('INVALID_INPUT'));
    assert.equal(requests.length, beforeDateSelection, 'Invalid date range must not start collection');
    assert.equal((await savedResults(page)).length, 0);
    assert.ok(!/Error:|at .*\.mjs/.test(await page.locator('#problemPanel').textContent()));
    await page.locator('#dateMode').selectOption('month');
    await page.locator('#targetMonth').fill(current.month);
    const selectedMonthLabel = (await page.locator('#datePreview').textContent()).split(' · ')[0];
    assert.equal(await page.locator('#maxPosts').inputValue(), '40');
    await page.getByText('高级设置', {exact: true}).click();
    await page.locator('#minDelay').fill('3');
    await page.locator('#maxDelay').fill('3');
    const beforeNormal = requests.length;
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集完成', null, {timeout: 20000});
    assert.equal((await savedResults(page)).length, 1);
    assert.equal(await page.locator('#resultBody').count(), 0, 'No result table is rendered');
    const normalRows = await savedResults(page);
    assert.equal(normalRows[0].status, 'OK');
    assert.ok(normalRows[0].post_title.includes(PRIVATE_CAPTION));
    assert.equal(normalRows[0].like_count, 88);
    assert.match(await page.locator('#summaryText').textContent(), /1 条内容/);
    assert.equal(await page.locator('#igOperationCount').textContent(), '2');
    assert.equal(await page.locator('#ytRequestCount').textContent(), '0');
    assert.match(await page.locator('#scanProgress').textContent(), /已开详情 1 条/);
    assert.deepEqual(requests.slice(beforeNormal), ['/team_foxer/', '/p/TEST_POST/']);
    assert.equal(instagram.url(), 'https://www.instagram.com/team_foxer/', 'the selected Instagram page must not be navigated');
    assert.deepEqual(privateAPIRequests, []);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportXlsx').click();
    const download = await downloadPromise;
    const file = await download.path();
    const result = XLSX.read(await fs.readFile(file), {type: 'buffer'});
    assert.equal(result.Sheets['采集结果'].G2.t, 's');
    assert.equal(result.Sheets['采集结果'].G2.f, undefined);
    assert.equal(result.Sheets['采集结果'].N2.v, 88);
    const monthSnapshot = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.equal(monthSnapshot.options.dateMode, 'month');
    assert.equal(monthSnapshot.options.targetDates[0], `${current.month}-01`);
    assert.equal(monthSnapshot.meta['目标日期'], selectedMonthLabel);
    const monthExportInfo = Object.fromEntries(XLSX.utils.sheet_to_json(result.Sheets['本次运行信息'], {header: 1}).slice(1));
    assert.equal(monthExportInfo['日期模式'], '按月');
    assert.equal(monthExportInfo['目标日期'], selectedMonthLabel);
    const priorRun = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    const priorFileInfo = await page.locator('#fileInfo').textContent();
    const extraTemplate = page.waitForEvent('download'); await page.locator('#downloadTemplate').click(); await extraTemplate;
    assert.deepEqual(await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun), priorRun);
    assert.equal(await page.locator('#fileInfo').textContent(), priorFileInfo, 'Downloading a template preserves imported input and prior results');
    await page.screenshot({path: path.join(os.tmpdir(), 'social-metrics-extension-results.png'), fullPage: true});

    // The normal site page loads one batch itself. Observing that response
    // supplies all fields without a second page navigation or extra API call.
    responseMode = 'passive';
    await page.locator('#dateMode').selectOption('quarter');
    await page.locator('#quarterYear').fill(current.year);
    await page.locator('#quarter').selectOption(current.quarter);
    const selectedQuarterLabel = (await page.locator('#datePreview').textContent()).split(' · ')[0];
    const beforePassive = requests.length;
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集中');
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集完成', null, {timeout: 20000});
    const passiveRows = await savedResults(page);
    assert.equal(passiveRows[0].status, 'OK'); assert.equal(passiveRows[0].like_count, 88);
    assert.deepEqual(fixtureErrors, [], 'Passive response fixture must observe the installed page reader before its own fetch');
    assert.deepEqual(requests.slice(beforePassive), ['/team_foxer/']);
    assert.deepEqual(pageOwnedRequests, ['/graphql/query/']);
    assert.equal(await page.locator('#igOperationCount').textContent(), '1');
    assert.match(await page.locator('#scanProgress').textContent(), /已开详情 0 条/);
    assert.deepEqual(privateAPIRequests, []);

    const quarterSnapshot = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.equal(quarterSnapshot.options.dateMode, 'quarter');
    assert.equal(quarterSnapshot.meta['日期模式'], '按季度');
    assert.equal(quarterSnapshot.meta['目标日期'], selectedQuarterLabel);
    assert.ok(quarterSnapshot.options.targetDates.length >= 90);
    // A historical cross-year selection filters the fixture by its publication
    // date, and survives reload without replacing it with today's defaults.
    fixtureTimestamp = '2024-01-01T12:00:00Z';
    await page.locator('#dateMode').selectOption('range');
    await page.locator('#startDate').fill('2023-12-31');
    await page.locator('#endDate').fill('2024-01-01');
    await page.locator('#timeZone').selectOption('UTC');
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集中');
    for (const selector of ['#dateMode', '#targetMonth', '#quarterYear', '#quarter', '#startDate', '#endDate', '#timeZone']) {
      assert.equal(await page.locator(selector).isDisabled(), true);
    }
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集完成', null, {timeout: 20000});
    const rangeSnapshot = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.deepEqual(rangeSnapshot.options.targetDates, ['2023-12-31', '2024-01-01']);
    assert.equal(rangeSnapshot.results[0].status, 'OK');
    assert.equal(rangeSnapshot.results[0].published_local, '2024-01-01 12:00:00');
    assert.equal(rangeSnapshot.meta['目标日期'], '2023-12-31 至 2024-01-01');
    const rangeJsonPending = page.waitForEvent('download');
    await page.locator('#exportJson').click();
    const rangeJson = JSON.parse(await fs.readFile(await (await rangeJsonPending).path(), 'utf8'));
    assert.equal(rangeJson.meta['日期模式'], '自定义起止日期');
    assert.equal(rangeJson.meta['目标日期'], '2023-12-31 至 2024-01-01');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '已恢复上次结果');
    assert.equal(await page.locator('#dateMode').inputValue(), 'range');
    assert.equal(await page.locator('#startDate').inputValue(), '2023-12-31');
    assert.equal(await page.locator('#endDate').inputValue(), '2024-01-01');
    assert.equal(await page.locator('#timeZone').inputValue(), 'UTC');
    assert.equal(await page.locator('#datePreview').textContent(), '2023-12-31 至 2024-01-01 · 共 2 天');
    await page.locator('#sampleButton').click();
    await page.locator('#dateMode').selectOption('days');
    fixtureTimestamp = new Date().toISOString();
    await page.getByText('高级设置', {exact: true}).click();
    await page.locator('#minDelay').fill('3');
    await page.locator('#maxDelay').fill('3');

    // A page batch cap keeps confirmed posts and reports unknown coverage.
    responseMode = 'incomplete';
    await page.locator('#maxPages').fill('1');
    const beforeIncomplete = requests.length;
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集中');
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '完成，存在待核对项', null, {timeout: 20000});
    assert.equal((await savedResults(page)).length, 2);
    assert.match(await page.locator('#problemCode').textContent(), /PAGE_INCOMPLETE/);
    assert.equal((await savedResults(page))[0].status, 'OK');
    assert.equal((await savedResults(page))[1].status, 'FAILED');
    assert.deepEqual(requests.slice(beforeIncomplete), ['/team_foxer/', '/p/TEST_POST/']);

    // The separate detail cap must not silently turn unread posts into no-post.
    responseMode = 'detail-budget';
    await page.locator('#maxPosts').fill('1');
    const beforeDetailCap = requests.length;
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '采集中');
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '完成，存在待核对项', null, {timeout: 20000});
    assert.equal((await savedResults(page)).length, 2);
    assert.match(await page.locator('#problemCode').textContent(), /PAGE_INCOMPLETE/);
    assert.deepEqual(requests.slice(beforeDetailCap), ['/team_foxer/', '/p/TEST_POST/']);
    await page.locator('#maxPosts').fill('40');
    await page.locator('#maxPages').fill('5');

    // Importing the next input must not rewrite the previous result's provenance.
    const csv = Buffer.from(`账号名,主页链接,平台\n${PRIVATE_NAMES[0]},https://www.instagram.com/team_foxer/,Instagram\n${PRIVATE_NAMES[1]},https://www.instagram.com/test_second/,Instagram\n`);
    await page.locator('#inputFile').setInputFiles({name: 'B.csv', mimeType: 'text/csv', buffer: csv});
    await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('B.csv'));
    const jsonDownloadPromise = page.waitForEvent('download');
    await page.locator('#exportJson').click();
    const jsonDownload = await jsonDownloadPromise;
    const exported = JSON.parse(await fs.readFile(await jsonDownload.path(), 'utf8'));
    assert.equal(exported.meta.inputName, '内置单账号示例');

    // A restriction visible on a normally loaded page stops the platform. The
    // second account remains explicitly unrequested and no private API is used.
    responseMode = 'restricted';
    const beforeRate = requests.length;
    const restrictionStarted = new Promise(resolve => { navigationStarted = resolve; });
    await page.locator('#startButton').click();
    await waitForHeldRequest(restrictionStarted);
    navigationStarted = undefined;
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '完成，存在待核对项');
    assert.equal((await savedResults(page)).length, 2);
    assert.equal(requests.length - beforeRate, 1);
    await page.locator('#problemPanel').waitFor({state: 'visible'});
    assert.match(await page.locator('#problemCode').textContent(), /IG_RATE_LIMIT/);
    assert.match(await page.locator('#problemTitle').textContent(), /Instagram 暂时限制采集/);
    assert.match(await page.locator('#problemAction').textContent(), /暂停|稍后|恢复/);
    assert.equal((await savedResults(page))[0].status, 'FAILED');
    assert.equal((await savedResults(page))[1].skipped, true);
    assert.match(await page.locator('#summaryText').textContent(), /其中 1 个因平台暂停未采集/);
    await page.screenshot({path: path.join(os.tmpdir(), 'social-metrics-extension-error.png'), fullPage: true});

    // Diagnostic downloads retain page operations and the recognized stop code,
    // never account/post content or invented HTTP statuses.
    const rateText = await downloadedDiagnostics(page);
    const rateLog = diagnosticJSON(rateText);
    assert.ok(rateLog.entries.some(entry => entry.event === 'run.started'));
    assert.ok(rateLog.entries.some(entry => entry.event === 'run.finished'));
    assert.equal(rateLog.entries.filter(entry => entry.event === 'account.failed').length, 1);
    assert.equal(rateLog.entries.filter(entry => entry.event === 'account.completed' && entry.details.status === 'SKIPPED').length, 1);
    assert.ok(rateLog.entries.some(entry => entry.event === 'page.failed' && entry.details.endpoint === 'profile' && entry.details.error?.code === 'RATE_LIMIT'));
    assert.ok(!rateLog.entries.some(entry => entry.details.endpoint === 'web_profile_info'));
    assert.deepEqual(privateAPIRequests, []);
    assertPrivateDataAbsent(rateText);

    // Clipboard rejection falls back to selected, manually copyable text.
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: async () => { throw new DOMException('Offline clipboard permission denied', 'NotAllowedError'); }
    }));
    await page.locator('#copyLogs').click();
    await page.waitForFunction(() => document.querySelector('#logFeedback').textContent.includes('无法自动复制'));
    assert.match(await page.locator('#logFeedback').textContent(), /下载诊断日志/);
    const selection = await page.locator('#diagnosticText').evaluate(element => ({
      start: element.selectionStart, end: element.selectionEnd, length: element.value.length,
    }));
    assert.equal(selection.start, 0);
    assert.equal(selection.end, selection.length);
    assert.ok(selection.length > 100);
    assertPrivateDataAbsent(await page.locator('#diagnosticText').inputValue());

    // Successful copy uses the same sanitized text as the diagnostic download.
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: async text => { window.__offlineCopiedDiagnostics = text; }
    }));
    await page.locator('#copyLogs').click();
    await page.waitForFunction(() => document.querySelector('#logFeedback').textContent.includes('诊断日志已复制'));
    const copied = await page.evaluate(() => window.__offlineCopiedDiagnostics);
    assertPrivateDataAbsent(copied);
    assert.equal(diagnosticJSON(copied).id, rateLog.id);

    // The global error listener must present fixed Chinese guidance while
    // retaining a useful, sanitized technical error in the separate log.
    await page.evaluate(secret => {
      const error = new Error(`OFFLINE_GLOBAL_FAILURE private-key=${secret}`);
      error.stack = `${error.message}\n    at offlineFixture (chrome-extension://${chrome.runtime.id}/app.mjs:174:12)`;
      window.dispatchEvent(new ErrorEvent('error', {error, message: error.message}));
    }, PRIVATE_KEY);
    await page.waitForFunction(() => document.querySelector('#problemCode').textContent.includes('UNKNOWN_ERROR'));
    const visibleProblem = await page.locator('#problemPanel').textContent();
    assert.match(visibleProblem, /操作未完成|未预料的问题/);
    assert.match(visibleProblem, /诊断日志/);
    assert.ok(!visibleProblem.includes('OFFLINE_GLOBAL_FAILURE'));
    assert.ok(!visibleProblem.includes(PRIVATE_KEY));
    const errorText = await downloadedDiagnostics(page);
    const errorLog = diagnosticJSON(errorText);
    assertPrivateDataAbsent(errorText);
    const globalError = errorLog.entries.find(entry => entry.event === 'operation.failed' && entry.details.code === 'UNKNOWN_ERROR');
    assert.ok(globalError);
    assert.match(globalError.details.error.message, /原始错误文本已省略/);
    assert.match(globalError.details.error.stack, /app\.mjs:174:12/);
    assert.ok(!errorText.includes('OFFLINE_GLOBAL_FAILURE'));

    // Reload restores the run log and page restriction, not merely result rows.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '已恢复上次结果');
    assert.equal((await savedResults(page)).length, 2);
    const restoredRateText = await displayedDiagnostics(page);
    const restoredRateLog = diagnosticJSON(restoredRateText);
    assert.equal(restoredRateLog.id, rateLog.id);
    assert.ok(restoredRateLog.entries.some(entry => entry.event === 'page.failed' && entry.details.error?.code === 'RATE_LIMIT'));
    assertPrivateDataAbsent(restoredRateText);
    await page.locator('#inputFile').setInputFiles({name: 'B.csv', mimeType: 'text/csv', buffer: csv});
    await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('B.csv'));

    // A second worktab cannot clear the active job's recovery snapshot.
    responseMode = 'hold';
    const requestHeld = new Promise(resolve => { heldRequestStarted = resolve; });
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.querySelector('#requestCount').textContent === '1');
    await waitForHeldRequest(requestHeld);
    // Appearance and explanations remain usable while a real collector is
    // waiting on the local fixture, without restarting or changing its options.
    const runningBeforeAppearance = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    await page.locator('#themeMode').selectOption('light');
    await page.locator('#interfaceStyle').selectOption('classic');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('body').getAttribute('data-state'), 'running');
    assert.equal(await page.locator('#maxPages').isDisabled(), true);
    const advanced = page.getByText('高级设置', {exact: true});
    if (!await advanced.evaluate(element => element.parentElement.open)) await advanced.click();
    const runningHelp = page.locator('[aria-controls="maxPagesExplanation"]');
    assert.equal(await runningHelp.isEnabled(), true);
    await runningHelp.click();
    await page.locator('#maxPagesExplanation').waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    const runningAfterAppearance = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.deepEqual(runningAfterAppearance.options, runningBeforeAppearance.options);
    assert.deepEqual(runningAfterAppearance.results, runningBeforeAppearance.results);
    assert.equal(runningAfterAppearance.running, true);
    assert.equal(await page.locator('#requestCount').textContent(), '1');
    await page.locator('#interfaceStyle').selectOption('tech');
    await page.locator('#themeMode').selectOption('dark');
    const second = await context.newPage();
    await second.goto(`chrome-extension://${id}/index.html`);
    await second.locator('#warnings').getByText(/另一个工作页正在采集/).waitFor();
    await second.locator('#clearButton').click();
    await second.waitForFunction(() => document.querySelector('#problemCode').textContent.includes('TASK_RUNNING'));
    assert.match(await second.locator('#problemAction').textContent(), /正在运行的工作页/);
    const resultLockCode = await second.locator('#problemCode').textContent();
    await second.locator('#clearLogs').click();
    await second.waitForFunction(previous => {
      const code = document.querySelector('#problemCode').textContent;
      return code !== previous && code.includes('TASK_RUNNING');
    }, resultLockCode);
    const snapshot = await second.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.pending.length, 2);
    await page.locator('#stopButton').click();
    releaseRequest();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '已停止');
    assert.equal((await savedResults(page)).length, 2);
    const completedRun = diagnosticJSON(await displayedDiagnostics(page));
    const secondRun = diagnosticJSON(await displayedDiagnostics(second));
    assert.notEqual(completedRun.id, secondRun.id);
    // An unrelated page can produce a newer error log after this job finishes.
    // Restoring this job must still pick its own run's latest persisted log.
    await second.evaluate(() => {
      const error = new Error('OFFLINE_UNRELATED_WORKTAB');
      window.dispatchEvent(new ErrorEvent('error', {error, message: error.message}));
    });
    await second.waitForFunction(async runId => {
      const key = 'metrics.diagnostics.' + runId;
      return (await chrome.storage.local.get(key))[key]?.entries.some(entry => entry.event === 'operation.failed' && entry.details.code === 'UNKNOWN_ERROR');
    }, secondRun.id);
    await second.close();

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#statusText').textContent === '已恢复上次结果');
    assert.equal((await savedResults(page)).length, 2);
    assert.equal(diagnosticJSON(await displayedDiagnostics(page)).id, completedRun.id);
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({path: path.join(os.tmpdir(), 'social-metrics-extension-mobile.png')});

    // Clearing diagnostic logs starts a fresh bounded run without clearing
    // results; clearing results later must leave the new log available.
    const beforeClearLogs = diagnosticJSON(await displayedDiagnostics(page));
    await page.locator('#clearLogs').click();
    await page.waitForFunction(() => document.querySelector('#logFeedback').textContent.includes('已清空旧诊断日志'));
    assert.equal((await savedResults(page)).length, 2);
    const clearedText = await displayedDiagnostics(page);
    const clearedLog = diagnosticJSON(clearedText);
    assert.notEqual(clearedLog.id, beforeClearLogs.id);
    assert.ok(clearedLog.entries.some(entry => entry.event === 'diagnostics.cleared'));
    assert.ok(!clearedText.includes(beforeClearLogs.id));
    await page.evaluate(() => {
      const error = new Error('OFFLINE_AFTER_LOG_CLEAR');
      error.stack = `${error.message}\n    at offlineFixture (chrome-extension://${chrome.runtime.id}/app.mjs:250:12)`;
      window.dispatchEvent(new ErrorEvent('error', {error, message: error.message}));
    });
    await page.waitForFunction(() => document.querySelector('#diagnosticText').value.includes('app.mjs:250:12'));
    await page.locator('#clearButton').click();
    await page.waitForFunction(() => document.querySelector('#progressText').textContent === '结果已清空');
    const preservedText = await displayedDiagnostics(page);
    const preservedLog = diagnosticJSON(preservedText);
    assert.equal(preservedLog.id, clearedLog.id);
    assert.ok(preservedLog.entries.some(entry => entry.event === 'operation.failed' && entry.details.code === 'UNKNOWN_ERROR'
      && entry.details.error?.stack?.includes('app.mjs:250:12')));
    assert.ok(!preservedText.includes('OFFLINE_AFTER_LOG_CLEAR'));
    const storedLastRun = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.equal(storedLastRun, undefined);

    // Exercise the independent bootstrap failure UI by removing its table
    // dependency immediately before its DOMContentLoaded handler imports app.
    // This avoids relying on interception of local chrome-extension resources.
    const bootPage = await context.newPage();
    await bootPage.addInitScript(() => window.addEventListener('DOMContentLoaded', () => { window.XLSX = undefined; }, {once: true}));
    await bootPage.goto(`chrome-extension://${id}/index.html`);
    await bootPage.waitForFunction(() => document.querySelector('#problemCode').textContent.includes('STARTUP_FAILED'));
    assert.equal(await bootPage.locator('#startButton').isDisabled(), true);
    assert.match(await bootPage.locator('#problemAction').textContent(), /重新加载插件/);
    const startupDownload = await downloadedDiagnostics(bootPage);
    assert.match(startupDownload, /插件启动诊断/);
    assert.match(startupDownload, /STARTUP_FAILED/);
    assertPrivateDataAbsent(startupDownload);
    await bootPage.close();
    assert.equal(instagram.url(), 'https://www.instagram.com/team_foxer/');
    assert.deepEqual(privateAPIRequests, []);
    assert.deepEqual(errors, []);
    console.log('PASS: calendar month/quarter/custom ranges, leap February, four-quarter boundaries, range validation before requests, selected-range collection/export/recovery, platform template downloads and filled-template import, empty-input guidance, input/result preservation, export-only UI, per-account progress and counters, DOM fallback, passive page-owned response reuse (2 navigations reduced to 1), dedicated tabs, page/detail limits, literal Excel/JSON export, provenance, restriction stop, safe error UI, sanitized diagnostics, reload, cross-tab locks, cancellation and bootstrap fallback. Zero extension-initiated Instagram API calls; site-owned fixture responses observed; no live network.');
    console.log(`Screenshots: ${os.tmpdir()}/social-metrics-extension-{empty,results,mobile}.png`);
  } catch (error) {
    const worktab = context?.pages().find(candidate => candidate.url().startsWith('chrome-extension:'));
    if (worktab) {
      const failure = await worktab.evaluate(() => ({
        status: document.querySelector('#statusText')?.textContent,
        progress: document.querySelector('#progressText')?.textContent,
        problem: document.querySelector('#problemPanel')?.textContent,
        log: document.querySelector('#logList')?.textContent,
      })).catch(() => null);
      console.error('Offline failure context:', JSON.stringify({failure, requests, privateAPIRequests}));
      await worktab.screenshot({path: path.join(os.tmpdir(), 'social-metrics-extension-failure.png'), fullPage: true}).catch(() => {});
    }
    throw error;
  } finally {
    releaseRequest?.();
    await context?.close();
    await fixtureProxy?.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
