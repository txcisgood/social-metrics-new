import test from 'node:test';
import assert from 'node:assert/strict';
import {describeError} from '../edge-extension/lib/errors.mjs';

const coded = (code, message = '') => Object.assign(new Error(message), {code});
const visible = description => [description.title, description.message, description.action].join('\n');

test('template download failure gives guidance without claiming collection results already exist', () => {
  const info = describeError(new Error('PRIVATE_EXCEPTION'), {stage: 'template'});
  assert.equal(info.code, 'TEMPLATE_EXPORT_FAILED'); assert.match(info.title, /账号模板下载失败/);
  assert.match(info.action, /下载权限/); assert.doesNotMatch(visible(info), /PRIVATE_EXCEPTION|当前页面中的结果仍然保留/);
});

test('incomplete scan reasons give specific safe next steps and reject arbitrary reason strings', () => {
  const info = describeError({...coded('PAGE_INCOMPLETE'), stopReason: 'recent_boundary'});
  assert.match(info.message, /较早/); assert.match(info.action, /继续检查更多内容/);
  for (const stopReason of ['__proto__', 'constructor', 'PRIVATE_CAPTION']) {
    const result = describeError({...coded('PAGE_INCOMPLETE'), stopReason});
    assert.equal(result.code, 'PAGE_INCOMPLETE'); assert.doesNotMatch(visible(result), /PRIVATE_CAPTION|__proto__|constructor/);
  }
});

test('unknown exceptions always use fixed Chinese guidance without original text', () => {
  const expected = {
    code: 'UNKNOWN_ERROR', title: '操作未完成',
    message: '插件遇到了未预料的问题，本次操作未完成。', action: '请复制诊断日志并反馈，以便定位问题。',
  };
  for (const error of [undefined, null, 42, new Error('Cannot read properties of undefined'),
    'Uncaught ReferenceError: privateVariable is not defined', {message: 'SENSITIVE_TOKEN', code: 'SENSITIVE_CODE'},
    coded('INTERNAL_FAILURE', 'network failure with private token'), coded('UNKNOWN_ERROR', '登录栈中包含私密参数')]) {
    assert.deepEqual(describeError(error), expected);
  }
});

test('raw HTML, JavaScript, stack traces, URLs and tokens never enter visible fields', () => {
  const raw = '<script>alert("PRIVATE_SECRET")</script>\nTypeError: undefined\n at parseFile (chrome-extension://secret/app.mjs:33:9)\nhttps://api.example/?key=PRIVATE_SECRET';
  const error = Object.assign(new Error(raw), {stack: raw});
  for (const context of [{}, {stage: 'import'}, {stage: 'export'}, {stage: 'clipboard'}, {platform: 'instagram'}]) {
    const description = describeError(error, context);
    for (const forbidden of ['PRIVATE_SECRET', '<script>', 'TypeError', 'chrome-extension:', 'parseFile', 'api.example', 'app.mjs:']) {
      assert.ok(!JSON.stringify(description).includes(forbidden));
    }
    for (const key of ['title', 'message', 'action']) assert.match(description[key], /[\u4e00-\u9fff]/);
  }
});

test('malformed exception objects cannot break error presentation', () => {
  const error = Object.defineProperties({}, {
    code: {get() { throw new Error('code getter'); }},
    message: {get() { throw new Error('message getter'); }},
    name: {get() { throw new Error('name getter'); }},
  });
  assert.equal(describeError(error).code, 'UNKNOWN_ERROR');
});

test('rate limits distinguish Instagram from YouTube and do not echo raw service errors', () => {
  const error = coded('RATE_LIMIT', 'Rate limit: PRIVATE_SECRET');
  const instagram = describeError(error, {platform: 'instagram'});
  const youtube = describeError(error, {platform: 'youtube'});
  assert.equal(instagram.code, 'IG_RATE_LIMIT');
  assert.match(instagram.action, /暂停/);
  assert.equal(youtube.code, 'YT_QUOTA');
  assert.match(youtube.action, /配额/);
  assert.ok(!visible(instagram).includes('PRIVATE_SECRET'));
  assert.ok(!visible(youtube).includes('PRIVATE_SECRET'));
  assert.equal(describeError(error).code, 'RATE_LIMIT');
});

test('platform context wins over an unrelated brand in raw error text', () => {
  assert.equal(describeError(coded('RATE_LIMIT', 'YouTube error'), {platform: 'instagram'}).code, 'IG_RATE_LIMIT');
  assert.equal(describeError(coded('AUTH', 'Instagram login error'), {platform: 'youtube'}).code, 'YT_API_KEY');
  assert.equal(describeError(coded('RATE_LIMIT', 'YouTube 配额用尽')).code, 'YT_QUOTA');
});

test('authentication distinguishes browser login from YouTube API keys', () => {
  assert.equal(describeError(coded('AUTH'), {platform: 'instagram'}).code, 'LOGIN_REQUIRED');
  assert.match(describeError(coded('AUTH'), {platform: 'instagram'}).action, /标签页完成登录或验证/);
  assert.equal(describeError(coded('AUTH'), {platform: 'youtube'}).code, 'YT_API_KEY');
  assert.match(describeError(coded('AUTH'), {platform: 'youtube'}).action, /YouTube Data API/);
  assert.equal(describeError(new Error('Instagram challenge_required')).code, 'LOGIN_REQUIRED');
  assert.equal(describeError(new Error('请在 YouTube API 密钥中填写你自己的 API Key')).code, 'YT_API_KEY');
});

test('API and KEY in a secret or exception identifier do not imply authentication failure', () => {
  for (const message of ['OFFLINE_GLOBAL_FAILURE private-key=OFFLINE_SECRET_API_KEY_9281_DO_NOT_LOG',
    'TypeError in YouTube API Key handler', 'SOME_API_KEY_PRIVATE_TOKEN', 'Unexpected API_KEY_STATE']) {
    for (const platform of ['', 'instagram', 'youtube']) {
      const result = describeError(new Error(message), {platform});
      assert.equal(result.code, 'UNKNOWN_ERROR');
      assert.ok(!visible(result).includes(message));
    }
  }
  for (const message of ['缺少 YouTube API Key', 'YouTube API key not valid', 'API Key 无效',
    '请在 YouTube API 密钥中填写你自己的 API Key']) {
    assert.equal(describeError(new Error(message)).code, 'YT_API_KEY');
  }
});

test('private-account and missing-video messages explain permissions without claiming no posts', () => {
  const privateAccount = describeError(coded('FETCH_ERROR', '这是私密账号，当前登录账号无法确认其发布内容。'), {platform: 'instagram'});
  assert.equal(privateAccount.code, 'ACCESS_DENIED');
  assert.match(privateAccount.action, /能看到/);
  const deleted = describeError(new Error('视频详情不可用，可能已删除或转为私密，请手动核对'), {platform: 'youtube'});
  assert.equal(deleted.code, 'CONTENT_UNAVAILABLE');
  assert.match(deleted.message, /私密/);
  assert.ok(!visible(privateAccount).includes('没有发布'));
});

test('pagination limit and broken cursor have different recovery instructions', () => {
  const limit = describeError(coded('FETCH_ERROR', 'Instagram 已达到最大分页数，目标日期尚未查全；请增大分页上限。'));
  assert.equal(limit.code, 'PAGINATION_LIMIT');
  assert.match(limit.action, /增大分页上限/);
  const cursor = describeError(new Error('YouTube 分页游标重复，目标日期未查全'));
  assert.equal(cursor.code, 'PAGINATION_INVALID');
  assert.match(cursor.action, /诊断日志/);
});

test('pagination and delay input errors retain precise safe constraints', () => {
  const page = describeError(new Error('分页上限必须在 1 至 50 之间'));
  assert.equal(page.code, 'INVALID_INPUT');
  assert.match(page.message, /1 至 50/);
  const delay = describeError(new Error('请求间隔需满足：3 ≤ 最短间隔 ≤ 最长间隔 ≤ 120 秒'));
  assert.equal(delay.code, 'INVALID_INPUT');
  assert.match(delay.message, /3 秒/);
  assert.match(delay.message, /120 秒/);
});

test('network and timeout explanations take precedence over incidental mentions of API keys', () => {
  const network = describeError(new Error('YouTube 网络或数据错误，请检查网络和密钥设置'), {platform: 'youtube'});
  assert.equal(network.code, 'NETWORK_ERROR');
  assert.match(network.action, /网络/);
  const timeout = describeError(coded('TAB', 'Instagram 请求超时，请检查网络'), {platform: 'instagram'});
  assert.equal(timeout.code, 'NETWORK_TIMEOUT');
  assert.equal(describeError(new Error('Failed to fetch https://secret.example/?token=PRIVATE')).code, 'NETWORK_ERROR');
});

test('selected-tab errors do not become misleading login prompts', () => {
  const selection = describeError(new Error('请先选择已登录的 Instagram 标签页'));
  assert.equal(selection.code, 'TAB_REQUIRED');
  assert.match(selection.action, /刷新标签页/);
  const unavailable = describeError(coded('TAB', '所选 Instagram 标签页已关闭、跳转或需要登录，请检查后重新采集'));
  assert.equal(unavailable.code, 'TAB_UNAVAILABLE');
  assert.match(unavailable.action, /访问该网站/);
});

test('cancellation and interrupted recovery preserve their user-visible meaning', () => {
  const cancelled = describeError(coded('CANCELLED', 'Abort at unknown stack'));
  assert.equal(cancelled.code, 'CANCELLED');
  assert.match(cancelled.message, /用户已停止/);
  const interrupted = describeError(coded('INTERRUPTED', 'SECRET_CONTEXT'));
  assert.equal(interrupted.code, 'INTERRUPTED');
  assert.match(interrupted.message, /上次任务/);
  assert.match(interrupted.action, /手动采集/);
  assert.ok(!visible(interrupted).includes('SECRET_CONTEXT'));
});

test('import context hides unexpected parser English and overrides unrelated raw service clues', () => {
  for (const raw of ['Unsupported ZIP compression: PRIVATE_PATH', 'Cannot read properties of undefined (reading SheetNames)',
    'rateLimitExceeded YouTube PRIVATE_SECRET', '<html>login_required PRIVATE_SECRET</html>']) {
    const description = describeError(new Error(raw), {stage: 'import', platform: 'instagram'});
    assert.equal(description.code, 'INVALID_FILE');
    assert.match(description.title, /导入失败/);
    assert.ok(!visible(description).includes(raw));
    assert.ok(!visible(description).includes('PRIVATE_'));
  }
});

const fileCases = [
  ['账号文件不能超过 10 MB', 'FILE_TOO_LARGE', /10 MB/, /拆/],
  ['工作表范围过大，请整理到 50000 行、512 列以内。', 'FILE_TOO_LARGE', /行列/, /空白行列/],
  ['文件是空的。', 'EMPTY_FILE', /为空/, /模板/],
  ['CSV 编码无法识别，请另存为 UTF-8 后重试。', 'FILE_ENCODING', /编码/, /UTF-8/],
  ['不支持 .xls 老格式，请先另存为 .xlsx。', 'INVALID_FILE', /\.xls/, /\.xlsx/],
  ['请选择 .xlsx、.xlsm、.csv 或 .tsv 账号表。', 'INVALID_FILE', /\.xlsx/, /转换格式/],
  ['没有识别到主页链接列，请使用表头', 'MISSING_HEADERS', /未识别/, /主页链接/],
  ['没有可用账号', 'NO_ACCOUNTS', /没有可用账号/, /平台筛选/],
  ['找不到选中的工作表。', 'INVALID_FILE', /没有找到/, /重新选择/],
  ['Excel 组件尚未加载，请重新打开插件页面。', 'COMPONENT_UNAVAILABLE', /无法读取/, /重新打开/],
];
for (const [message, code, expectedMessage, expectedAction] of fileCases) {
  test(`file error maps safely: ${code} / ${message.slice(0, 14)}`, () => {
    const result = describeError(new Error(message), {stage: 'import'});
    assert.equal(result.code, code);
    assert.match(result.message, expectedMessage);
    assert.match(result.action, expectedAction);
  });
}

test('missing input account list is presented as a preparation step', () => {
  const result = describeError(new Error('请先导入账号文件，或点击“使用示例”；确认文件中包含所选平台'));
  assert.equal(result.code, 'NO_ACCOUNTS');
  assert.match(result.action, /工作表和平台筛选/);
});

test('dates, timezone and account-count validations provide fixed instructions', () => {
  for (const message of ['请选择有效的目标日期', '采集日期必须是有效的 YYYY-MM-DD 日期。', '判定时区无效，请选择有效的 IANA 时区。',
    '最近天数必须在 1 至 366 之间', '每次最多采集 500 个账号，请拆分账号表']) {
    const result = describeError(new Error(message));
    assert.equal(result.code, 'INVALID_INPUT');
    assert.ok(result.action.length > 5);
  }
});

test('task locks and browser compatibility are actionable and distinct', () => {
  assert.equal(describeError(new Error('另一个插件工作页正在采集，请回到该页面查看或停止')).code, 'TASK_RUNNING');
  assert.equal(describeError(new Error('当前 Edge 不支持任务锁，请更新浏览器')).code, 'BROWSER_UNSUPPORTED');
  assert.equal(describeError(new Error('请通过 Edge 扩展打开工作台')).code, 'EXTENSION_REQUIRED');
});

test('clearing results or logs reports a held task lock before storage-stage fallback', () => {
  for (const message of ['另一个工作页正在采集，不能清空其恢复记录', '另一个工作页正在采集，不能清空其诊断日志']) {
    const result = describeError(new Error(message), {stage: 'storage'});
    assert.equal(result.code, 'TASK_RUNNING');
    assert.match(result.action, /正在运行的工作页/);
    assert.ok(!visible(result).includes('空间不足'));
  }
  assert.equal(describeError(coded('TASK_RUNNING'), {stage: 'storage'}).code, 'TASK_RUNNING');
});

test('storage quota uses storage guidance even with YouTube context', () => {
  const result = describeError(Object.assign(new Error('Quota exceeded PRIVATE_SECRET'), {name: 'QuotaExceededError'}), {platform: 'youtube'});
  assert.equal(result.code, 'STORAGE_UNAVAILABLE');
  assert.match(result.action, /先导出/);
  assert.ok(!visible(result).includes('PRIVATE_SECRET'));
  assert.equal(describeError(new Error('Unknown native exception'), {stage: 'storage'}).code, 'STORAGE_UNAVAILABLE');
});

test('clipboard context gives download or manual-copy alternatives', () => {
  const result = describeError(new Error('NotAllowedError: Permissions policy PRIVATE'), {stage: 'clipboard'});
  assert.equal(result.code, 'CLIPBOARD_UNAVAILABLE');
  assert.match(result.action, /下载诊断日志/);
  assert.match(result.action, /手动复制/);
  assert.ok(!visible(result).includes('NotAllowedError'));
});

test('export context retains current results and suppresses native download exceptions', () => {
  const result = describeError(new Error('SecurityError at blob:PRIVATE_DOWNLOAD'), {stage: 'export'});
  assert.equal(result.code, 'EXPORT_FAILED');
  assert.match(result.message, /结果仍然保留/);
  assert.match(result.action, /下载权限/);
  assert.ok(!visible(result).includes('PRIVATE_DOWNLOAD'));
});

test('known invalid URLs get platform-specific repair instructions', () => {
  const instagram = describeError(coded('BAD_URL', 'SECRET_URL'), {platform: 'instagram'});
  assert.equal(instagram.code, 'INVALID_URL');
  assert.match(instagram.action, /账号主页链接/);
  const youtube = describeError(new Error('请将旧式 /c/ 链接换为 /@用户名 或 /channel/UC... 主页链接'), {platform: 'youtube'});
  assert.equal(youtube.code, 'INVALID_URL');
  assert.match(youtube.action, /\/@用户名/);
});

test('changed data structures and unknown collector failures remain separate', () => {
  for (const message of ['Instagram 返回了未知的数据结构。', 'Instagram 返回了网页或无效 JSON，无法确认采集结果。',
    'Instagram 内容缺少有效链接或发布时间，无法确认采集完整性。', 'YouTube 上传列表结构异常，无法确认是否有发布']) {
    assert.equal(describeError(coded('FETCH_ERROR', message)).code, 'INVALID_DATA');
  }
  assert.equal(describeError(coded('INVALID_DATA', 'PRIVATE')).code, 'INVALID_DATA');
  const failure = describeError(coded('FETCH_ERROR', 'PRIVATE_UNRECOGNIZED_BODY'));
  assert.equal(failure.code, 'FETCH_FAILED');
  assert.ok(!visible(failure).includes('PRIVATE_UNRECOGNIZED_BODY'));
});
