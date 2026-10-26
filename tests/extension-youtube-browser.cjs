/* Isolated end-to-end coverage of the YouTube workbench. Every API response is
 * supplied locally by Playwright; no real key, account or external request. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('../extension/vendor/xlsx.full.min.js');

const KEY = 'FIXTURE_YOUTUBE_KEY_NOT_FOR_LOGS', DESCRIPTION = 'PRIVATE_VIDEO_DESCRIPTION\n简介第二行';
const id = n => String(n).padStart(11, '0'), CHANNEL = 'UC' + 'A'.repeat(22);
const time = '2026-10-20T12:00:00Z';
const video = value => ({id: value, snippet: {title: '测试视频 ' + value, description: DESCRIPTION, publishedAt: time, channelId: CHANNEL, channelTitle: '测试频道'}, contentDetails: {duration: 'PT5M'}, statistics: {viewCount: '12', likeCount: '2', commentCount: '300'}});
const comment = (value, parentId) => ({id: value, snippet: {authorDisplayName: 'PRIVATE_USER_' + value, textDisplay: 'PRIVATE_COMMENT_' + value, publishedAt: time, likeCount: 1, ...(parentId ? {parentId} : {})}});
function assertOriginalReport(workbook) {
  assert.deepEqual(workbook.SheetNames, ['采集结果', '待人工核对', '本次运行信息']);
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets['采集结果'], {header: 1})[0], [
    '行号', '账号名', '平台', '主页链接', '目标日期', '期间有无发布', '作品标题', '作品链接',
    '发布时间(本地)', '类型', '时长', '粉丝数', '播放', '点赞', '评论', '抓取时间', '备注',
  ]);
  assert.equal(workbook.Sheets['采集结果'].R1, undefined);
}

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'social-metrics-youtube-'));
  const extensionPath = path.resolve(__dirname, '../extension');
  const cdpMode = process.env.EXTENSION_LOAD_MODE === 'cdp';
  let context, page, mode = 'normal', holdStarted, release, liveResult = false;
  const calls = [], errors = [], external = [];
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [...(cdpMode ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]),
        '--no-first-run', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND'],
      viewport: {width: 1440, height: 1050},
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin !== 'https://www.googleapis.com') { external.push(url.origin); return route.abort(); }
      const endpoint = url.pathname.split('/').at(-1), p = Object.fromEntries(url.searchParams);
      calls.push({endpoint, params: {...p, key: undefined}}); assert.equal(p.key, KEY);
      let body;
      if (endpoint === 'videos') body = {items: p.id.split(',').map(value => {
        const item = video(value);
        if (value === id(3) && liveResult) item.liveStreamingDetails = {actualStartTime: time};
        return item;
      })};
      else if (endpoint === 'channels') body = {items: [{id: CHANNEL, snippet: {title: '测试频道'}, contentDetails: {relatedPlaylists: {uploads: 'UU-test'}}, statistics: {subscriberCount: '42'}}]};
      else if (endpoint === 'playlistItems') body = {items: [{contentDetails: {videoId: id(p.pageToken ? 2 : 1), videoPublishedAt: time}, snippet: {title: '列表视频'}}], ...(!p.pageToken ? {nextPageToken: 'second'} : {})};
      else if (endpoint === 'search') { liveResult = p.eventType === 'live'; body = {items: [{id: {videoId: id(3)}, snippet: {title: '关键词结果', publishedAt: time}}]}; }
      else if (endpoint === 'commentThreads') {
        if (mode === 'disabled') return route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({error: {errors: [{reason: 'commentsDisabled'}]}})});
        if (mode === 'hold' && p.pageToken) { holdStarted(); await new Promise(resolve => { release = resolve; }); }
        const pageIndex = Number(p.pageToken || 0), count = pageIndex === 2 ? 98 : 100;
        body = {items: Array.from({length: count}, (_, i) => {
          const n = pageIndex * 100 + i;
          return {snippet: {topLevelComment: comment('root-' + n), totalReplyCount: n === 0 ? 2 : 0}, ...(n === 0 ? {replies: {comments: [comment('reply-1', 'root-0')]}} : {})};
        }), ...(pageIndex < 2 ? {nextPageToken: String(pageIndex + 1)} : {})};
      } else if (endpoint === 'comments') body = {items: [comment('reply-1', 'root-0'), comment('reply-2', 'root-0')]};
      else throw new Error('Unexpected endpoint ' + endpoint);
      await route.fulfill({contentType: 'application/json', body: JSON.stringify(body)}).catch(error => { if (mode !== 'hold') throw error; });
    });
    if (cdpMode) {
      const cdp = await context.browser().newBrowserCDPSession();
      try { await cdp.send('Extensions.loadUnpacked', {path: extensionPath}); } finally { await cdp.detach(); }
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    let downloadCount = 0; page.on('download', () => { downloadCount++; });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await page.evaluate(() => import('./app.mjs').then(() => true));
    await page.waitForFunction(() => !document.getElementById('platformSelect').disabled);
    const choose = (id, value) => page.locator('#' + id).selectOption(value, {force: true});
    const saved = () => page.evaluate(async () => (await chrome.storage.session.get('youtubeLastRun')).youtubeLastRun);
    const finished = () => page.waitForFunction(() => !document.getElementById('startButton').disabled && document.getElementById('exportXlsx').disabled === false);
    async function startAndExport() {
      const downloading = page.waitForEvent('download'); await page.locator('#startButton').click();
      const download = await downloading; await finished();
      assert.match(download.suggestedFilename(), /^社媒采集-YouTube-\d{4}-\d{2}-\d{2} \d{2}时\d{2}分\d{2}秒\.xlsx$/);
      return XLSX.read(await fs.readFile(await download.path()), {type: 'buffer'});
    }
    async function exportSavedResults() {
      const downloading = page.waitForEvent('download'); await page.locator('#exportXlsx').click();
      return XLSX.read(await fs.readFile(await (await downloading).path()), {type: 'buffer'});
    }
    // The original YouTube homepage Excel workflow remains an independent module.
    await choose('platformSelect', 'youtube');
    assert.equal(await page.locator('#tableInput').isVisible(), true);
    assert.equal(await page.locator('#youtubeModes').isVisible(), false);
    assert.match(await page.locator('#filePickerTitle').textContent(), /主页表格/);
    await page.locator('#youtubeSection').evaluate(el => { el.open = true; }); await page.locator('#youtubeKey').fill(KEY);
    await choose('dateMode', 'range'); await page.locator('#startDate').fill('2026-10-20'); await page.locator('#endDate').fill('2026-10-20'); await choose('timeZone', 'Asia/Shanghai');
    await page.locator('#inputFile').setInputFiles({name: 'homepages.csv', mimeType: 'text/csv', buffer: Buffer.from(`账号名,主页链接\n频道,https://youtube.com/channel/${CHANNEL}\n`)});
    await page.waitForFunction(() => document.getElementById('fileInfo').textContent.includes('1 个可识别账号'));
    await page.locator('#startButton').click(); await finished();
    const legacySnapshot = await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun);
    assert.equal(legacySnapshot.results.filter(row => row.status === 'OK').length, 2);
    assert.equal(legacySnapshot.meta['采集模式'], undefined);
    assert.equal(await page.locator('[data-history-count]').textContent(), '1 / 5');
    assertOriginalReport(await exportSavedResults());
    await page.locator('#moduleYouTubeLink').click(); await page.waitForURL('**/youtube.html');
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(await page.locator('#platformField').isVisible(), false);
    assert.equal(await page.locator('#showCommentDetails').isChecked(), false);
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), false);
    assert.equal(await page.locator('#youtubeKey').inputValue(), KEY);
    assert.equal(await page.locator('#exportXlsx').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('[data-history-count]').textContent === '0 / 5');
    calls.length = 0;
    await choose('youtubeMode', 'videos');
    await page.locator('#youtubeSection').evaluate(el => { el.open = true; }); await page.locator('#youtubeKey').fill(KEY);
    await page.locator('#videoUrls').fill(`https://youtu.be/${id(1)}\nhttps://youtube.com/shorts/${id(1)}`);
    assert.equal(await page.locator('#dateFilterFields').isVisible(), false);
    let wb = await startAndExport(), snapshot = await saved();
    assert.equal(snapshot.results.length, 1); assert.equal(snapshot.results[0].comments.length, 300);
    assert.equal(snapshot.results[0].comments_status, 'COMPLETE');
    assert.equal(wb.Sheets['采集结果'].R2.v, DESCRIPTION);
    assert.equal(wb.Sheets['采集结果'].K2.v, '05:00');
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['评论详情']).length, 300);
    assert.equal(await page.locator('[data-history-count]').textContent(), '1 / 5');
    const beforeViewing = calls.length;
    await page.locator('label[for="showCommentDetails"]').click();
    assert.equal(await page.locator('#showCommentDetails').isChecked(), true);
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), true);
    assert.equal(await page.locator('.comment-item').count(), 50);
    assert.equal(await page.locator('.comment-author').first().textContent(), 'PRIVATE_USER_root-0');
    assert.equal(await page.locator('.comment-text').first().textContent(), 'PRIVATE_COMMENT_root-0');
    assert.deepEqual(await page.locator('.comment-kind').allTextContents().then(values => values.slice(0, 3)), ['主评论', '回复', '回复']);
    assert.match(await page.locator('.comment-parent').first().textContent(), /PRIVATE_USER_root-0/);
    const nextComments = page.getByRole('button', {name: '下一页', exact: true});
    for (let i = 0; i < 5; i++) await nextComments.click();
    assert.equal(await nextComments.isDisabled(), true);
    assert.match(await page.locator('.comment-page-status').textContent(), /第 6 \/ 6 页/);
    assert.equal(await page.locator('.comment-author').last().textContent(), 'PRIVATE_USER_root-297');
    await page.locator('#showCommentDetails').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), false);
    assert.equal(await page.locator('.comment-item').count(), 0);
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), true);
    assert.match(await page.locator('.comment-page-status').textContent(), /第 6 \/ 6 页/);
    assert.equal(calls.length, beforeViewing, 'Comment display and pagination reuse collected data');
    // Switching the next task's form cannot change the saved result's template.
    await choose('youtubeMode', 'channel');
    const savedUrlReport = await exportSavedResults();
    assert.equal(savedUrlReport.Sheets['采集结果'].R2.v, DESCRIPTION);
    assert.equal(XLSX.utils.sheet_to_json(savedUrlReport.Sheets['评论详情']).length, 300);
    await choose('youtubeMode', 'videos');
    assert.ok(calls.some(c => c.endpoint === 'comments')); assert.equal(calls.some(c => c.endpoint === 'channels'), false);
    const beforeCap = calls.length;
    await page.locator('#videoUrls').fill(Array.from({length: 101}, (_, i) => `https://youtu.be/${id(i + 1)}`).join('\n'));
    await page.locator('#startButton').click();
    await page.waitForFunction(() => document.getElementById('problemTitle').textContent.includes('采集设置'));
    assert.equal(calls.length, beforeCap); assert.equal((await saved()).results[0].comments.length, 300);
    await page.locator('#videoUrls').fill(`https://youtu.be/${id(1)}`);
    const successCalls = calls.length;
    await choose('videoInputSource', 'file');
    const downloading = page.waitForEvent('download'); await page.locator('#downloadTemplate').click();
    const template = XLSX.read(await fs.readFile(await (await downloading).path()), {type: 'buffer'});
    assert.equal(template.SheetNames[0], '视频清单'); assert.equal(calls.length, successCalls);
    await page.locator('#inputFile').setInputFiles({name: 'videos.csv', mimeType: 'text/csv', buffer: Buffer.from(`视频链接,备注\nhttps://youtu.be/${id(2)},测试备注\n`)});
    await page.waitForFunction(() => document.getElementById('fileInfo').textContent.includes('1 条视频链接'));
    template.Sheets['视频清单'].A2 = {t: 's', v: `https://youtu.be/${id(2)}`};
    await page.locator('#inputFile').setInputFiles({name: 'videos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(XLSX.write(template, {type: 'buffer', bookType: 'xlsx'}))});
    await page.waitForFunction(() => document.getElementById('filePicker').dataset.state === 'ready' && document.getElementById('filePickerTitle').textContent === 'videos.xlsx');
    assert.match(await page.locator('#filePickerDescription').textContent(), /已导入 1 条视频链接/);
    assert.equal(await page.locator('#selectedFileIcon').isVisible(), true);
    assert.equal(await page.locator('#sheetSelect, #sheetField').count(), 0);
    mode = 'disabled'; wb = await startAndExport(); snapshot = await saved();
    assert.equal(snapshot.results[0].comments_status, 'DISABLED'); assert.equal(snapshot.results[0].status, 'OK');
    assert.ok(wb.Sheets['评论详情']);
    mode = 'normal'; await choose('youtubeMode', 'channel');
    await page.locator('#channelUrl').fill(`https://youtube.com/channel/${CHANNEL}`); await choose('youtubeRange', 'all');
    const beforeChannel = calls.length; wb = await startAndExport(); snapshot = await saved();
    assert.equal(snapshot.results.filter(r => r.status === 'OK').length, 2);
    assert.equal(calls.slice(beforeChannel).filter(c => c.endpoint === 'playlistItems').length, 2);
    assert.equal(calls.slice(beforeChannel).some(c => c.endpoint === 'commentThreads'), false);
    assert.equal(wb.Sheets['评论详情'], undefined);
    assertOriginalReport(wb);
    assert.equal(await page.locator('#showCommentDetails').isVisible(), false);
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), false);
    assert.equal(snapshot.meta.inputName, '频道主页输入');
    await page.locator('#youtubeLimit').fill('1'); await startAndExport(); snapshot = await saved();
    assert.equal(snapshot.results.filter(r => r.status === 'OK').length, 1);
    assert.equal(snapshot.results.at(-1).error_code, 'YT_INCOMPLETE');
    await page.locator('#youtubeLimit').fill('100');
    const beforeInvalidLimit = calls.length;
    for (const value of ['0', '101']) {
      await page.locator('#youtubeLimit').fill(value); await page.locator('#startButton').click();
      await page.waitForFunction(() => document.getElementById('problemTitle').textContent.includes('采集设置'));
      assert.equal(calls.length, beforeInvalidLimit);
    }
    assert.equal(await page.locator('#youtubeLimit').getAttribute('max'), '100');
    await page.locator('#youtubeLimit').fill('100');
    await choose('youtubeRange', 'dates');
    await choose('dateMode', 'range'); await page.locator('#startDate').fill('2026-10-20'); await page.locator('#endDate').fill('2026-10-20'); await choose('timeZone', 'UTC');
    await page.locator('#endDate').fill('2026-10-19');
    await choose('youtubeMode', 'keyword'); await page.locator('#youtubeKeyword').fill('PRIVATE_SEARCH_QUERY');
    assert.equal(await page.locator('#timeSection').isVisible(), false);
    assert.deepEqual(await page.locator('[data-keyword-filter]').allTextContents(), ['全部视频', '最近上传', '直播']);
    for (const filter of ['all', 'recent', 'live']) {
      const button = page.locator(`[data-keyword-filter="${filter}"]`);
      await button.focus(); await page.keyboard.press('Space');
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      wb = await startAndExport(); snapshot = await saved(); assert.equal(snapshot.results[0].video_id, id(3));
      assertOriginalReport(wb);
      const search = calls.findLast(c => c.endpoint === 'search');
      assert.equal(search.params.type, 'video'); assert.equal(search.params.publishedAfter, undefined); assert.equal(search.params.publishedBefore, undefined);
      assert.equal(search.params.order, filter === 'recent' ? 'date' : 'relevance');
      assert.equal(search.params.eventType, filter === 'live' ? 'live' : undefined);
      assert.deepEqual(snapshot.options.targetDates, []);
      assert.equal(snapshot.meta['日期模式'], '不限发布日期');
      assert.equal(wb.Sheets['采集结果'].J2.v, filter === 'live' ? '正在直播' : '长视频');
    }
    const keywordOutput = path.resolve(__dirname, '../outputs/youtube-preview'); await fs.mkdir(keywordOutput, {recursive: true});
    for (const width of [1440, 320]) {
      await page.setViewportSize({width, height: 1050});
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
      await page.locator('#youtubeKeywordInput').evaluate(element => element.scrollIntoView({block: 'start'}));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const size = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(size.scroll <= size.width + 1, `${width}px keyword overflow`);
      await page.screenshot({path: path.join(keywordOutput, `${cdpMode ? 'chrome' : 'edge'}-keyword-${width}.png`), fullPage: false});
    }
    await page.setViewportSize({width: 1440, height: 1050});
    await choose('youtubeMode', 'videos');
    assertOriginalReport(await exportSavedResults());
    // Holding a second comment page exercises the real AbortController path.
    await choose('youtubeMode', 'videos'); await choose('videoInputSource', 'text'); mode = 'hold';
    const held = new Promise(resolve => { holdStarted = resolve; });
    await page.locator('#startButton').click(); await held;
    await page.locator('#stopButton').click(); release(); await finished(); snapshot = await saved();
    assert.equal(snapshot.results[0].comments.length, 101); assert.equal(snapshot.results[0].comments_status, 'PARTIAL');
    assert.equal(snapshot.results.at(-1).error_code, 'CANCELLED');
    const beforeReload = calls.length, downloadsBeforeReload = downloadCount;
    // Simulate closing while the comment checkpoint is still RUNNING. This is
    // the same saved payload written by onCheckpoint before the target ends.
    await page.evaluate(async () => {
      const {youtubeLastRun: lastRun} = await chrome.storage.session.get('youtubeLastRun');
      lastRun.results = lastRun.results.filter(row => row.status === 'OK');
      lastRun.results[0].comments_status = 'RUNNING'; lastRun.running = true;
      lastRun.pending = [{row_no: 1, name: 'video', url: 'https://www.youtube.com/watch?v=00000000001', platform: 'youtube', youtubeMode: 'videos'}];
      await chrome.storage.session.set({youtubeLastRun: lastRun});
    });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('platformSelect').disabled);
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(calls.length, beforeReload); assert.equal((await saved()).results[0].comments.length, 101);
    assert.equal(await page.locator('#platformSelect').inputValue(), 'youtube');
    assert.equal(await page.locator('#youtubeMode').inputValue(), 'videos');
    assert.equal((await saved()).results[0].comments_status, 'INTERRUPTED');
    assert.equal(await page.locator('#youtubeSearchFilter').inputValue(), 'live');
    assert.equal(await page.locator('#showCommentDetails').isChecked(), true);
    assert.equal(await page.locator('#commentDetailsPanel').isVisible(), true);
    assert.equal(await page.locator('.comment-item').count(), 50);
    assert.match(await page.locator('.comment-notice').textContent(), /中断/);
    assert.equal(downloadCount, downloadsBeforeReload);
    assert.equal(await page.locator('#troubleshooting').evaluate(element => element.open), false);
    assert.equal(await page.locator('#copyLogs').isVisible(), false);
    assert.ok((await page.locator('#troubleshooting').boundingBox()).height <= 56);
    await page.locator('.activity-summary').click();
    await page.locator('#diagnosticsDetails').evaluate(el => { el.open = true; });
    await page.waitForFunction(() => document.getElementById('diagnosticText').value.includes('schemaVersion'));
    const diagnostic = await page.locator('#diagnosticText').inputValue();
    for (const secret of [KEY, DESCRIPTION, 'PRIVATE_USER_', 'PRIVATE_COMMENT_', 'PRIVATE_SEARCH_QUERY']) assert.equal(diagnostic.includes(secret), false);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({width, height: 1050});
      const size = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(size.scroll <= size.width + 1, `${width}px overflow`);
    }
    const output = path.resolve(__dirname, '../outputs/youtube-preview'); await fs.mkdir(output, {recursive: true});
    await page.setViewportSize({width: 1440, height: 760});
    const actions = await page.locator('.run-controls').boundingBox();
    assert.ok(actions && actions.y >= 0 && actions.y + actions.height <= 760, 'Module navigation must not push desktop actions off screen');
    await page.setViewportSize({width: 1440, height: 1050});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path: path.join(output, cdpMode ? 'chrome-youtube.png' : 'edge-youtube.png'), fullPage: false});
    const beforeSwitch = calls.length;
    await page.locator('#moduleAccountsLink').click(); await page.waitForURL('**/index.html');
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(await page.locator('#platformSelect').inputValue(), 'youtube');
    assert.equal(await page.locator('#timeZone').inputValue(), 'Asia/Shanghai');
    assert.equal(await page.locator('#tableInput').isVisible(), true); assert.equal(await page.locator('#youtubeModes').isVisible(), false);
    assert.equal(await page.locator('#showCommentDetails, #commentDetailsPanel').count(), 0);
    assert.deepEqual(await page.evaluate(async () => (await chrome.storage.session.get('lastRun')).lastRun.results), legacySnapshot.results);
    await page.locator('#clearButton').click(); await page.waitForFunction(() => document.getElementById('exportXlsx').disabled);
    assert.equal((await saved()).results[0].comments.length, 101, 'Clearing account results must retain video comments');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path: path.join(output, cdpMode ? 'chrome-accounts.png' : 'edge-accounts.png'), fullPage: false});
    await page.locator('#moduleYouTubeLink').click(); await page.waitForURL('**/youtube.html');
    await page.evaluate(() => import('./app.mjs').then(() => true));
    assert.equal(await page.locator('#youtubeMode').inputValue(), 'videos'); assert.equal(await page.locator('#timeZone').inputValue(), 'UTC');
    assert.equal(await page.locator('#metricPosts').textContent(), '1');
    assert.equal(calls.length, beforeSwitch, 'Switching modules only restores their own results');
    assert.equal(await page.locator('#showCommentDetails').isChecked(), true);
    // Restored multiple videos, untrusted text and a partial reply have no HTML
    // side effects, no API requests and no effect on their Excel/JSON payload.
    await page.evaluate(async () => {
      const {youtubeLastRun: run} = await chrome.storage.session.get('youtubeLastRun');
      const row = run.results[0];
      row.comments[0].author = 'PRIVATE_USER_<img src=x onerror=alert(1)>';
      row.comments[0].text = 'PRIVATE_COMMENT_<script>alert(1)</script>\n' + '长评论'.repeat(200);
      run.results = [row, {...row, video_id: '00000000002', post_url: 'https://www.youtube.com/watch?v=00000000002',
        post_title: '第二条视频', comments: [], comments_status: 'DISABLED', comments_error: '视频已关闭评论。'}];
      await chrome.storage.session.set({youtubeLastRun: run});
    });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('platformSelect').disabled);
    await page.waitForFunction(() => document.querySelectorAll('.comment-video').length === 2);
    assert.equal(await page.locator('.comment-video').count(), 2);
    assert.equal(await page.locator('.comment-item').count(), 50);
    assert.match(await page.locator('.comment-author').first().textContent(), /<img/);
    assert.match(await page.locator('.comment-text').first().textContent(), /<script>/);
    assert.equal(await page.locator('#commentDetailsPanel img, #commentDetailsPanel script').count(), 0);
    await page.locator('.comment-video-summary').nth(1).click();
    await page.locator('.comment-video').nth(1).locator('.comment-notice').waitFor();
    assert.match(await page.locator('.comment-notice').last().textContent(), /关闭评论/);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({width, height: 1050});
      await page.locator('#commentDetailsPanel').evaluate(element => element.scrollIntoView());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const size = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(size.scroll <= size.width + 1, `${width}px comments overflow`);
      if (width !== 390) await page.screenshot({path: path.join(output, `${cdpMode ? 'chrome' : 'edge'}-comments-${width}.png`), fullPage: false});
    }
    await page.setViewportSize({width: 1440, height: 1050});
    for (const style of ['tech', 'classic']) {
      await choose('interfaceStyle', style); await choose('themeMode', 'light');
      await page.locator('#commentDetailsPanel').evaluate(element => element.scrollIntoView());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({path: path.join(output, `${cdpMode ? 'chrome' : 'edge'}-comments-${style}-light.png`), fullPage: false});
    }
    assert.equal(calls.length, beforeSwitch, 'Viewing restored comments does not fetch again');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`PASS ${context.browser().version()}: default-off comment switch, keyboard control, 300 comments across all pages, grouped replies, safe text, multi-video lazy panels, interrupted/disabled states, saved visibility, no refetch, dark/light tech/classic and 320/390px; independent modules, legacy 17-column exports, URL text/CSV/XLSX, automatic Excel, caps, channel/keyword, cancellation/privacy. No live API requests.`);
  } finally { release?.(); await context?.close(); await fs.rm(profile, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
