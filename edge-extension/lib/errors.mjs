/** Fixed user-facing copy. Raw errors belong only in diagnostic logs. */
const describe = (code, title, message, action) => ({code, title, message, action});

function field(error, name) {
  try { return typeof error?.[name] === 'string' ? error[name].slice(0, 4000) : ''; }
  catch { return ''; }
}

function importError(message) {
  if (/(?:文件|工作表).*(?:是空的|为空)|empty (?:file|sheet)/i.test(message)) {
    return describe('EMPTY_FILE', '账号表没有内容', '所选文件或工作表为空。', '选择有账号数据的工作表，或下载模板填写后重新导入。');
  }
  if (/(?:超过|不能超过)\s*10\s*MB|file too large/i.test(message)) {
    return describe('FILE_TOO_LARGE', '账号文件太大', '账号文件不能超过 10 MB。', '把账号表拆成较小的文件，再分批导入。');
  }
  if (/工作表范围过大|too many (?:rows|columns)/i.test(message)) {
    return describe('FILE_TOO_LARGE', '工作表范围太大', '工作表中的行列过多，暂时无法读取。', '删除不需要的空白行列，或把账号表拆分后重新导入。');
  }
  if (/编码|UTF-?8|encoding/i.test(message)) {
    return describe('FILE_ENCODING', '账号表编码无法识别', '文本文件的编码不受支持。', '在表格软件中另存为 UTF-8 编码的 CSV，或另存为 .xlsx，再重新导入。');
  }
  if (/不支持\s*\.?xls(?:\s|老|$)|\.xls\s*老格式/i.test(message)) {
    return describe('INVALID_FILE', '请转换旧版表格格式', '暂不支持 .xls 格式的账号表。', '用表格软件打开文件，另存为 .xlsx 后重新导入。');
  }
  if (/请选择.*(?:xlsx|csv|tsv)|文件类型|不支持.*(?:文件|格式)|unsupported (?:file|format)/i.test(message)) {
    return describe('INVALID_FILE', '请选择支持的账号表', '插件支持 .xlsx、.xlsm、.csv 和 .tsv 文件。', '选择上述格式的账号表，或先用表格软件转换格式。');
  }
  if (/表头|没有识别到主页链接列|缺少.*(?:主页链接列|链接列)|missing.*header/i.test(message)) {
    return describe('MISSING_HEADERS', '没有找到主页链接列', '插件未识别出账号主页链接所在的列。', '把该列表头改为“主页链接”，填写账号主页地址后重新导入。');
  }
  if (/没有.*账号|无.*账号|未.*账号|先导入账号|no accounts/i.test(message)) {
    return describe('NO_ACCOUNTS', '没有可采集的账号', '所选文件或平台筛选中没有可用账号。', '确认表中有 Instagram 或 YouTube 主页链接，并检查工作表和平台筛选。');
  }
  if (/找不到.*工作表|没有找到工作表|sheet.*not found/i.test(message)) {
    return describe('INVALID_FILE', '无法读取所选工作表', '文件中没有找到可以读取的工作表。', '重新选择工作表；如果仍无法读取，请另存为 .xlsx 后重新导入。');
  }
  if (/Excel 组件尚未加载/.test(message)) {
    return describe('COMPONENT_UNAVAILABLE', '表格组件尚未就绪', '插件暂时无法读取表格文件。', '重新打开插件工作台后再导入；仍失败时请重新加载扩展。');
  }
  return describe('INVALID_FILE', '账号文件导入失败', '插件未能读取这份账号表，文件可能损坏、受保护或格式不受支持。',
    '用表格软件打开文件，另存为 .xlsx 或 UTF-8 编码的 CSV 后重试；仍失败时请复制诊断日志反馈。');
}

function clipboardError() {
  return describe('CLIPBOARD_UNAVAILABLE', '暂时无法复制', '浏览器未允许插件写入剪贴板。', '请下载诊断日志，或在日志区域选中文本后手动复制。');
}

function storageError() {
  return describe('STORAGE_UNAVAILABLE', '结果暂时无法保存', '浏览器的临时存储不可用或空间不足，恢复记录可能未保存。',
    '先导出当前结果，再重新打开工作台；仍失败时请复制诊断日志反馈。');
}

function unknownError() {
  return describe('UNKNOWN_ERROR', '操作未完成', '插件遇到了未预料的问题，本次操作未完成。', '请复制诊断日志并反馈，以便定位问题。');
}

/** Never echo message, stack, filenames, URLs, tokens, or unrecognized codes. */
export function describeError(error, {platform = '', stage = ''} = {}) {
  const message = typeof error === 'string' ? error.slice(0, 4000) : field(error, 'message');
  const code = field(error, 'code');
  const name = field(error, 'name');
  const contextPlatform = typeof platform === 'string' ? platform.toLowerCase() : '';
  const selectedPlatform = ['instagram', 'ig', 'ins'].includes(contextPlatform) ? 'instagram'
    : ['youtube', 'yt'].includes(contextPlatform) ? 'youtube'
      : /\bYouTube\b/i.test(message) ? 'youtube' : /\bInstagram\b/i.test(message) ? 'instagram' : '';
  const selectedStage = typeof stage === 'string' ? stage.toLowerCase() : '';
  // A token or variable name may contain API/KEY. Require an actual missing,
  // invalid, denied or setup instruction, not just those two words.
  const keyProblem = !/网络|超时/.test(message) && (
    /(?:缺少|未填写|请.{0,30}(?:填写|输入)|无效|失效|被拒绝|未启用|invalid|missing|rejected|not configured).{0,80}(?:API[ _-]?Key|密钥)/i.test(message)
    || /(?:API[ _-]?Key|密钥).{0,80}(?:缺失|缺少|未填写|无效|失效|被拒绝|未启用|无权限|填写|invalid|missing|rejected|disabled|not valid)/i.test(message)
  );

  if (code === 'CANCELLED' || /用户已停止|用户取消|user cancel(?:led|ed)/i.test(message)) {
    return describe('CANCELLED', '采集已停止', '用户已停止本次采集，已完成的结果仍可导出。', '需要继续时，请重新选择要采集的账号并开始。');
  }
  if (code === 'INTERRUPTED' || /上次任务.*(?:中断|未完成)|上次运行中断/.test(message)) {
    return describe('INTERRUPTED', '上次采集任务已中断', '上次任务因工作页关闭、刷新或其他中断而未完成，已恢复可用的结果。',
      '先导出已完成的结果，再重新导入账号表，手动采集尚未完成的账号。');
  }
  // Operation context precedes parser/native exception text, which is untrusted.
  if (['import', 'file-import', 'file'].includes(selectedStage)) return importError(message);
  if (['clipboard', 'copy'].includes(selectedStage)) return clipboardError();
  if (selectedStage === 'template') return describe('TEMPLATE_EXPORT_FAILED', '账号模板下载失败',
    '浏览器未能生成或下载账号模板。', '检查浏览器的下载权限后重试；仍失败时请复制诊断日志反馈。');
  if (['export', 'download'].includes(selectedStage)) {
    return describe('EXPORT_FAILED', '结果导出失败', '浏览器未能生成或下载结果文件，当前页面中的结果仍然保留。',
      '检查浏览器的下载权限后重试，或尝试另一种导出格式；仍失败时请复制诊断日志反馈。');
  }
  if (['INTERNAL_FAILURE', 'UNKNOWN_ERROR'].includes(code)) return unknownError();
  // Clearing results or logs uses a storage operation, but a held job lock is
  // an actionable concurrency conflict rather than a storage malfunction.
  if (code === 'TASK_RUNNING' || /另一个.*(?:工作页|页面).*采集|任务.*(?:正在运行|已在运行)|task.*already running/i.test(message)) {
    return describe('TASK_RUNNING', '已有采集任务正在运行', '另一个插件工作页正在采集，暂时不能同时开始或清空记录。', '回到正在运行的工作页查看进度，完成或停止后再操作。');
  }
  if (selectedStage === 'storage' || /QuotaExceededError/i.test(name)
      || /QUOTA_BYTES|storage.*(?:quota|exceed|unavailable)|(?:存储|保存).*(?:不足|失败|不可用)/i.test(message)) return storageError();
  if (/clipboard|剪贴板|无法复制|复制失败/i.test(message)) return clipboardError();

  if (code === 'PAGE_INCOMPLETE') {
    const reasons = {
      recent_boundary: ['已遇到连续较早的帖子，快速检查已停止继续向历史扫描；尚不能确认目标日期已查全。', '先下载 Excel 并核对主页。需要扩大检查范围时，可选择“继续检查更多内容”。'],
      no_progress: ['继续滚动后没有发现新的帖子或日期，已停止重复读取，已取得的帖子仍保留。', '先下载 Excel 并检查账号主页。页面可继续显示更多内容后，再采集尚未确认的账号。'],
      detail_limit: ['已达到帖子详情访问上限，仍有帖子的日期无法确认。', '先下载 Excel。需要进一步检查时，可提高每账号详情访问上限。'],
      page_limit: ['已达到主页读取批次上限，尚不能确认目标日期已查全。', '先下载 Excel。需要进一步检查时，可提高主页读取批次上限。'],
      date_unavailable: ['已读取列表，但部分帖子没有提供有效日期，无法确认是否属于目标日期。', '下载 Excel 后打开主页核对。无法确认的日期和隐藏指标不会被编造。'],
    };
    const stopReason = field(error, 'stopReason');
    const reason = Object.hasOwn(reasons, stopReason) ? reasons[stopReason] : null;
    if (reason) return describe('PAGE_INCOMPLETE', '已读结果保留，完整性待核对', ...reason);
    return describe('PAGE_INCOMPLETE', '已读结果保留，完整性待核对',
    '已采集页面中能确认的帖子，但尚不能确认目标日期的全部内容。空白或隐藏的指标不会计为零。',
    '先导出已读结果并打开主页核对。可选择继续检查更多内容，或增加主页批次和详情上限；未能确认完整性时仍会保留此提示。');
  }
  if (code === 'PAGE_UNAVAILABLE') return describe('PAGE_UNAVAILABLE', 'Instagram 页面暂不可用',
    '主页或帖子未能正常显示，可能已删除、不可见或暂时加载失败。已读到的帖子仍会保留。',
    '在 Instagram 打开对应主页核对，能正常浏览后再采集该账号。');
  if (/详情访问上限必须/.test(message)) return describe('INVALID_INPUT', '请调整帖子数量上限',
    '每个账号最多打开的帖子数必须是 1 至 500 之间的整数。', '修改高级设置中的帖子数量上限后重试。');

  if (code === 'RATE_LIMIT' || /限流|配额.*(?:耗尽|用尽)|quotaExceeded|dailyLimitExceeded|rateLimitExceeded|too many requests|please wait a few minutes/i.test(message)) {
    if (selectedPlatform === 'youtube') return describe('YT_QUOTA', 'YouTube 请求额度暂不可用',
      'YouTube 的请求额度已用尽或请求过于频繁，本轮已停止该平台采集。', '稍后再试；若仍未恢复，请在 Google Cloud 检查该密钥项目的配额。');
    if (selectedPlatform === 'instagram') return describe('IG_RATE_LIMIT', 'Instagram 暂时限制采集',
      'Instagram 拒绝了当前采集请求，本轮已停止该平台采集。具体限制原因需结合诊断日志判断。', '暂停采集，等 Instagram 恢复后再试，暂时不要反复点击开始。');
    return describe('RATE_LIMIT', '平台暂时限制采集', '平台的请求额度不足或请求过于频繁，本轮已停止该平台采集。', '稍后再试，并检查相应平台的登录状态或请求配额。');
  }
  if (/私密账号|未关注|无权查看|没有.*权限.*(?:内容|账号)|private account/i.test(message)) {
    return describe('ACCESS_DENIED', '当前账号无权查看内容', '目标账号为私密账号，或当前登录账号没有查看权限。', '在网页中确认当前账号能看到该主页的帖子；无法查看的账号请先从采集列表移除。');
  }
  if (/视频详情不可用|视频.*(?:删除|转为私密)|视频所属频道不可用/.test(message)) {
    return describe('CONTENT_UNAVAILABLE', '部分视频无法读取', '视频可能已删除、设为私密，或暂时无法访问。', '打开对应视频链接核对状态；其他已完成的结果可以正常导出。');
  }
  if (/请先选择.*标签页|未选择.*标签页|没有.*标签页/.test(message)) {
    return describe('TAB_REQUIRED', '请选择 Instagram 标签页', '插件还没有连接到可用于采集的 Instagram 页面。', '在当前浏览器打开并登录 Instagram，然后点击“刷新标签页”并选择该页面。');
  }
  if (code === 'TAB' && !/超时|timed?\s*out|timeout/i.test(message)) {
    return describe('TAB_UNAVAILABLE', 'Instagram 标签页暂不可用', '所选页面已关闭、跳转，或插件没有读取该网站的权限。',
      '打开并登录 Instagram，允许扩展访问该网站，再刷新标签页列表并重新选择。');
  }
  if (code === 'AUTH' || /login_required|challenge_required|checkpoint_required|登录.*(?:失效|过期)|(?:完成|需要|要求|请先).*登录|登录或.*验证/i.test(message)
      || keyProblem) {
    if (selectedPlatform === 'youtube' || (keyProblem && selectedPlatform !== 'instagram')) return describe('YT_API_KEY', 'YouTube 密钥需要检查',
      '当前密钥缺失、无效，或没有访问 YouTube 数据服务的权限。', '填写自己的 API 密钥，并确认已启用 YouTube Data API v3，且密钥限制允许该请求。');
    return describe('LOGIN_REQUIRED', '请先完成登录或验证', '当前登录状态已失效，或平台要求完成账号验证。',
      '在 Instagram 采集标签页完成登录或验证，确认能看到主页后，再回到插件重新开始。');
  }
  if (/分页上限必须|最大分页数必须/.test(message)) return describe('INVALID_INPUT', '请调整分页上限',
    '分页上限必须是 1 至 50 之间的整数。', '在采集设置中填写有效分页数后重试。');
  if (/请求间隔.*(?:满足|必须)|最短间隔|最长间隔/.test(message)) return describe('INVALID_INPUT', '请调整请求间隔',
    '最短间隔不能小于 3 秒，最长间隔不能小于最短间隔，且不能超过 120 秒。', '检查最短和最长请求间隔后，再开始采集。');
  if (/达到.*(?:分页上限|最大分页数)|尚未覆盖.*日期.*上限|增大.*(?:分页上限|上限)/.test(message)) {
    return describe('PAGINATION_LIMIT', '目标日期还没有查完', '已达到分页上限，暂时无法确认目标日期的完整结果。',
      '适当增大分页上限，或缩小日期范围后重新采集该账号。');
  }
  if (/分页游标|游标.*(?:缺失|重复)|pagination.*cursor/i.test(message)) {
    return describe('PAGINATION_INVALID', '暂时无法继续翻页', '平台没有返回有效的下一页信息，目标日期尚未查全。',
      '先在网页确认该账号可以正常浏览，稍后重试；仍失败时请复制诊断日志反馈。');
  }
  if (/超时|timed?\s*out|timeout/i.test(message) || name === 'TimeoutError') {
    return describe('NETWORK_TIMEOUT', '连接超时', '平台未能在等待时间内返回数据，本次请求没有完成。',
      '检查网络并打开平台网页确认可以访问，再重新采集未完成的账号。');
  }
  if (/网络|failed to fetch|network(?:error| error)|ERR_(?:NETWORK|CONNECTION|INTERNET)/i.test(message)) {
    return describe('NETWORK_ERROR', '暂时无法连接平台', '网络连接中断或平台暂时无法访问。', '先确认网络和平台网页可以正常访问，再重新采集未完成的账号。');
  }
  if (code === 'TAB' || /标签页.*(?:关闭|跳转|不可用)|无法读取.*标签页|网站访问权限/.test(message)) {
    return describe('TAB_UNAVAILABLE', 'Instagram 标签页暂不可用', '所选页面已关闭、跳转，或插件没有读取该网站的权限。',
      '打开并登录 Instagram，允许扩展访问该网站，再刷新标签页列表并重新选择。');
  }
  if (/不支持任务锁|更新浏览器|浏览器.*(?:不支持|兼容)|navigator\.locks|browser.*not supported/i.test(message)) {
    return describe('BROWSER_UNSUPPORTED', '需要更新浏览器', '当前浏览器不具备运行插件所需的功能。', '更新 Microsoft Edge 或 Google Chrome 后，重新打开扩展工作台。');
  }
  if (/通过 Edge 扩展打开|通过.*扩展.*打开/.test(message)) {
    return describe('EXTENSION_REQUIRED', '请从扩展打开工作台', '当前页面没有在浏览器扩展环境中运行。', '在浏览器工具栏点击此扩展图标，重新打开工作台。');
  }
  if (/最多采集\s*500|超过\s*500.*账号/.test(message)) return describe('INVALID_INPUT', '本次账号数量太多',
    '每次最多采集 500 个账号。', '把账号表拆分成每份不超过 500 个账号，再分批采集。');
  if (/日期|时区|最近天数/.test(message)) {
    if (/最近天数/.test(message)) return describe('INVALID_INPUT', '请调整最近天数', '最近天数必须是 1 至 366 之间的整数。', '修改最近天数后重新开始。');
    if (/时区/.test(message)) return describe('INVALID_INPUT', '请选择有效时区', '当前时区无法用于判断发布日期。', '在设置中重新选择时区，再检查目标日期。');
    if (/无效|有效.*日期|至少选择|必须是/.test(message)) return describe('INVALID_INPUT', '请选择有效日期', '目标日期为空或不是有效的日历日期。', '重新选择目标日期后再开始采集。');
  }
  if (/账号文件|账号表|工作表|表头|文件.*(?:格式|内容|类型|编码|是空|超过)|先导入账号|没有.*账号|无.*账号/.test(message)) return importError(message);
  if (code === 'BAD_URL' || /主页链接|频道 ID 格式|视频 ID 格式|无法解析频道|不支持的.*请求地址/.test(message)) {
    if (selectedPlatform === 'youtube') return describe('INVALID_URL', '请检查 YouTube 主页链接',
      '当前链接无法识别为可采集的 YouTube 频道。', '使用频道的 /@用户名 或 /channel/UC… 主页链接，替换旧式 /c/ 链接后重新导入。');
    return describe('INVALID_URL', '请检查账号主页链接', '当前链接不是受支持的账号主页地址。', '从浏览器复制账号主页链接，替换帖子、登录页或搜索页链接后重新导入。');
  }
  if (/没有.*上传列表|频道.*(?:不可用|不存在|查不到)/.test(message)) {
    return describe('CHANNEL_UNAVAILABLE', '频道内容暂不可用', '没有找到该频道可读取的公开上传列表。', '在 YouTube 打开频道主页核对状态；无法访问的频道请先从采集列表移除。');
  }
  if (code === 'INVALID_DATA' || /(?:数据|内容|信息|列表|响应|结果).*结构|无效 (?:JSON|数据)|未知.*结构|返回.*(?:无效数据|空列表|内容过大)|缺少.*(?:链接|发布时间|用户 ID)|发布时间无效|账号.*不一致|未返回有效结果/.test(message)) {
    return describe('INVALID_DATA', '平台数据暂时无法确认', '平台返回的信息不完整或格式发生变化，无法确认本次采集结果。',
      '先在网页核对该账号的内容，稍后重试；仍失败时请复制诊断日志反馈。');
  }
  if (/导出|下载.*失败/.test(message)) return describe('EXPORT_FAILED', '结果导出失败', '结果文件暂时无法生成或下载。', '检查浏览器下载权限后重试，或尝试另一种导出格式。');
  if (code === 'FETCH_ERROR') return describe('FETCH_FAILED', '这个账号暂时未采集完成', '本次未能取得该账号的完整数据，结果仍需核对。',
    '先在网页确认账号能够正常访问，再重试；仍失败时请复制诊断日志反馈。');
  return unknownError();
}
