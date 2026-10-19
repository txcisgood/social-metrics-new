// SheetJS is bundled locally and loaded before this module by the extension page.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 512;
const RESULT_HEADERS = [
  "行号", "账号名", "平台", "主页链接", "目标日期", "当天有无发布", "作品标题",
  "作品链接", "发布时间(本地)", "类型", "时长", "粉丝数", "播放", "点赞", "评论", "抓取时间", "备注",
];
const PLATFORM_TEXT = { youtube: "YouTube", instagram: "Instagram", facebook: "Facebook" };
const STATUS_TEXT = { OK: "有", NO_POST: "无", FAILED: "抓取失败" };
const NAME_ALIASES = ["账号名", "账号", "账号名称", "名称", "昵称", "博主", "合作伙伴", "partner", "name", "account", "accountname", "username", "handle", "channel"];
const URL_ALIASES = ["链接", "主页链接", "主页", "地址", "网址", "url", "link", "profile", "profileurl", "profilelink", "homepage", "homepageurl", "accounturl", "accountlink", "channelurl", "channellink"];
const PLATFORM_ALIASES = ["平台", "渠道", "来源", "platform", "channeltype", "source", "site"];
const PLATFORM_DOMAINS = {
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  instagram: ["instagram.com", "instagr.am"],
  facebook: ["facebook.com", "fb.com", "fb.watch"],
};
const PLATFORM_HINTS = {
  youtube: ["youtube", "yt", "油管", "优兔"],
  instagram: ["instagram", "ins", "ig", "insta"],
  facebook: ["facebook", "fb", "脸书"],
  tiktok: ["tiktok", "tt", "抖音国际版"],
  douyin: ["douyin", "抖音"],
  xiaohongshu: ["xiaohongshu", "小红书", "xhs"],
  twitter: ["twitter", "x.com", "推特"],
};

function xlsx() {
  if (!globalThis.XLSX?.read || !globalThis.XLSX?.utils) {
    throw new Error("Excel 组件尚未加载，请重新打开插件页面。");
  }
  return globalThis.XLSX;
}

function inputBytes(arrayBuffer) {
  if (arrayBuffer instanceof ArrayBuffer) return new Uint8Array(arrayBuffer);
  if (ArrayBuffer.isView(arrayBuffer)) {
    return new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength);
  }
  throw new Error("文件内容格式无效，请重新选择文件。");
}

function decodeCsv(bytes) {
  // UTF-8 is the default, with a Windows Chinese CSV fallback. No network or
  // system-specific encoding library is required in Edge.
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      // Try the next encoding only if decoding failed.
    }
  }
  throw new Error("CSV 编码无法识别，请另存为 UTF-8 后重试。");
}

export function readWorkbook(arrayBuffer, fileName) {
  const bytes = inputBytes(arrayBuffer);
  if (!bytes.byteLength) throw new Error("文件是空的。");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("文件超过 10 MB，请拆分账号表后重试。");
  const extension = String(fileName ?? "").split(".").pop().toLowerCase();
  if (extension === "xls") throw new Error("不支持 .xls 老格式，请先另存为 .xlsx。");
  if (!["xlsx", "xlsm", "csv", "tsv", "txt"].includes(extension)) {
    throw new Error("请选择 .xlsx、.xlsm、.csv 或 .tsv 账号表。");
  }
  const csv = ["csv", "tsv", "txt"].includes(extension);
  try {
    const workbook = xlsx().read(csv ? decodeCsv(bytes) : bytes, {
      type: csv ? "string" : "array",
      raw: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
      ...(extension === "tsv" ? { FS: "\t" } : {}),
    });
    if (!workbook.SheetNames?.length) throw new Error("没有找到工作表");
    return workbook;
  } catch (error) {
    throw new Error(`无法读取账号表：${error.message || String(error)}`);
  }
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeHeader(value) {
  return text(value).toLowerCase().replace(/[（(][^）)]*[）)]/g, "").replace(/[\s_\-:*：]+/g, "");
}

function profileHeaderScore(value) {
  const normalized = normalizeHeader(value);
  // A post URL is never a substitute for the creator's profile URL.
  if (/作品|视频|帖子|贴文|post|video|reel|content/.test(normalized)) return 0;
  if (!URL_ALIASES.includes(normalized)) return 0;
  return /主页|profile|homepage|account|channel/.test(normalized) ? 2 : 1;
}

function cellText(sheet, row, column) {
  if (column == null) return "";
  const cell = sheet[xlsx().utils.encode_cell({ r: row, c: column })];
  return text(cell?.v);
}

function cellUrl(sheet, row, column) {
  if (column == null) return "";
  const cell = sheet[xlsx().utils.encode_cell({ r: row, c: column })];
  // Excel often shows a label while storing the actual URL in the hyperlink.
  return text(cell?.l?.Target) || text(cell?.v);
}

function parseProfileUrl(value) {
  const cleaned = text(value).replace(/^[<>"'，,、]+|[<>"'，,、]+$/g, "");
  if (!cleaned) return null;
  let candidate = cleaned;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    // Always use encrypted profile URLs, including older http links in sheets.
    url.protocol = "https:";
    return url;
  } catch {
    return null;
  }
}

function inferPlatform(url) {
  const host = url?.hostname.toLowerCase();
  if (!host) return "";
  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    if (domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return platform;
  }
  return "";
}

function platformHint(value) {
  const normalized = normalizeHeader(value);
  for (const [platform, names] of Object.entries(PLATFORM_HINTS)) {
    if (names.includes(normalized)) return platform;
  }
  return "";
}

function detectColumns(sheet, row, endColumn) {
  const values = Array.from({ length: endColumn + 1 }, (_, column) => cellText(sheet, row, column));
  // A link in the first nonempty row means this row is data, even if an account
  // happens to be named "Name" or "账号".
  const containsUrl = values.some((value, column) => {
    const raw = cellUrl(sheet, row, column);
    return Boolean(inferPlatform(parseProfileUrl(raw))) || /^https?:\/\//i.test(raw);
  });
  const name = values.findIndex(value => NAME_ALIASES.includes(normalizeHeader(value)));
  const platform = values.findIndex(value => PLATFORM_ALIASES.includes(normalizeHeader(value)));
  let url = -1;
  let bestScore = 0;
  values.forEach((value, column) => {
    const score = profileHeaderScore(value);
    if (score > bestScore) { url = column; bestScore = score; }
  });
  const header = !containsUrl && (name >= 0 || url >= 0);
  if (header) return { header, name: name >= 0 ? name : null, url: url >= 0 ? url : null, platform: platform >= 0 ? platform : null };
  if (endColumn === 0) return { header: false, name: null, url: 0, platform: null };
  return { header: false, name: 0, url: 1, platform: 2 };
}

export function loadAccounts(workbook, sheetName = workbook?.SheetNames?.[0]) {
  const sheet = workbook?.Sheets?.[sheetName];
  if (!sheet) throw new Error("找不到选中的工作表。");
  if (!sheet["!ref"]) throw new Error("工作表是空的。");
  const range = xlsx().utils.decode_range(sheet["!ref"]);
  if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLUMNS) {
    throw new Error(`工作表范围过大，请整理到 ${MAX_ROWS} 行、${MAX_COLUMNS} 列以内。`);
  }
  let firstRow = range.s.r;
  for (; firstRow <= range.e.r; firstRow++) {
    if (Array.from({ length: range.e.c + 1 }, (_, c) => cellUrl(sheet, firstRow, c)).some(Boolean)) break;
  }
  if (firstRow > range.e.r) throw new Error("工作表是空的。");
  const columns = detectColumns(sheet, firstRow, range.e.c);
  const accounts = [];
  const warnings = [];
  if (columns.url == null) {
    return { accounts, warnings: ["没有识别到主页链接列，请使用“主页链接”或“Profile URL”表头；作品链接不能作为账号主页。"] };
  }
  for (let row = firstRow + (columns.header ? 1 : 0); row <= range.e.r; row++) {
    const name = cellText(sheet, row, columns.name);
    const rawUrl = cellUrl(sheet, row, columns.url);
    if (!name && !rawUrl) continue;
    const label = `第 ${row + 1} 行「${name || "(无名)"}」`;
    if (!rawUrl) { warnings.push(`${label}缺少主页链接，已跳过`); continue; }
    const parsedUrl = parseProfileUrl(rawUrl);
    const platform = inferPlatform(parsedUrl);
    if (!platform) { warnings.push(`${label}的链接不是受支持的 Instagram / YouTube 主页链接，已跳过：${rawUrl}`); continue; }
    if (platform === "facebook") { warnings.push(`${label}是 Facebook，当前版本不支持，已跳过`); continue; }
    const rawPlatform = cellText(sheet, row, columns.platform);
    const declared = platformHint(rawPlatform);
    const note = declared && declared !== platform ? `表格填的是「${rawPlatform}」，但链接是 ${platform}，已按链接为准` : "";
    const guessedName = parsedUrl.pathname.split("/").filter(Boolean).pop() || parsedUrl.hostname;
    accounts.push({ row_no: row + 1, name: name || guessedName, url: parsedUrl.href, platform, note });
    if (note) warnings.push(`${label}${note}`);
  }
  return { accounts, warnings };
}

function literalCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return { t: "n", v: value };
  if (typeof value === "boolean") return { t: "b", v: value };
  // Explicit string types and no "f" field prevent captions, error messages,
  // names, and metadata starting with = / + / - / @ from becoming formulas.
  return { t: "s", v: value == null ? "" : String(value) };
}

function httpsLink(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.href;
  } catch { /* Keep malformed and non-HTTPS values as plain text. */ }
  return "";
}

function makeSheet(rows, widths, linkColumns = []) {
  const sheet = {};
  rows.forEach((row, r) => row.forEach((value, c) => {
    const cell = literalCell(value);
    if (r > 0 && linkColumns.includes(c)) {
      const target = httpsLink(value);
      if (target) cell.l = { Target: target };
    }
    sheet[xlsx().utils.encode_cell({ r, c })] = cell;
  }));
  sheet["!ref"] = xlsx().utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: widths.length - 1 } });
  sheet["!cols"] = widths.map(wch => ({ wch }));
  sheet["!rows"] = [{ hpt: 24 }];
  sheet["!autofilter"] = { ref: sheet["!ref"] };
  return sheet;
}

export function accountTemplateLabel(platform) {
  const labels = { instagram: "Instagram", youtube: "YouTube", all: "混合" };
  if (!Object.hasOwn(labels, platform)) throw new Error("请选择 Instagram、YouTube 或混合平台模板。");
  return labels[platform];
}

export function createAccountsTemplate(platform = "instagram") {
  accountTemplateLabel(platform); // Reject unsupported platforms; Facebook collection remains disabled.
  const platforms = platform === "all" ? ["instagram", "youtube"] : [platform];
  const workbook = xlsx().utils.book_new();
  // Keep the importable sheet first with headers on row 1. No sample accounts
  // or hyperlink targets: editing a URL must never retain an old hidden link.
  const input = makeSheet([
    ["账号名（选填）", "主页链接（必填）", "平台（选填）"],
    ...platforms.map(value => ["", "", PLATFORM_TEXT[value]]),
  ], [26, 68, 24]);
  input["!rows"] = Array.from({length: platforms.length + 1}, () => ({hpt: 24}));
  delete input["!autofilter"]; // This is an editable starter, not a fixed-size account list.
  xlsx().utils.book_append_sheet(workbook, input, "账号清单");
  const rows = [
    ["填写说明", "内容"],
    ["第 1 步", "在「账号清单」填写，每行一个账号；可以继续向下添加。"],
    ["第 2 步", "只需填写主页链接。下面的示例需换成你要采集的账号。"],
    ["第 3 步", "保存为 .xlsx，回插件点击「选择账号表格」导入。"],
    ["账号名（选填）", "填自己容易辨认的名称；不填时会根据链接生成名称。"],
    ["主页链接（必填）", "在浏览器打开账号主页，复制完整地址粘贴到链接列。"],
    ["平台（选填）", "可填写 Instagram 或 YouTube；插件以链接所属平台为准。"],
  ];
  if (platforms.includes("instagram")) rows.push(
    ["Instagram 账号名示例", "示例：我的合作博主"],
    ["Instagram 主页格式", "示例：https://www.instagram.com/your_username/"],
    ["Instagram 填写提示", "将 your_username 换为目标用户名，不要填写帖子或 Reels 链接。"],
    ["Instagram 登录", "在安装插件的同一浏览器用户配置中登录 Instagram，再回插件选择标签页。"],
  );
  if (platforms.includes("youtube")) rows.push(
    ["YouTube 账号名示例", "示例：我的合作频道"],
    ["YouTube 主页格式", "示例：https://www.youtube.com/@your_handle"],
    ["YouTube 填写提示", "将 your_handle 换为频道标识，或直接复制 /channel/ID 主页地址。"],
    ["YouTube 密钥", "API Key 填在插件工作台中，不要填入账号表。"],
  );
  rows.push(
    ["导入后", "选择「账号清单」工作表，检查识别数量和平台筛选。"],
    ["日期与时区", "在插件中选择采集日期和时区，不需要填在此表中。"],
    ["文件与账号上限", "每个文件不超过 10 MB，每轮最多采集 500 个账号。"],
    ["Facebook", "当前不支持采集；已有账号表中的 Facebook 行会提示跳过。"],
    ["账号信息", "只填写账号名称和公开主页链接，不填写密码或 Cookie。"],
  );
  const instructions = makeSheet(rows, [28, 92]);
  instructions["!rows"] = rows.map(() => ({hpt: 26}));
  delete instructions["!autofilter"];
  xlsx().utils.book_append_sheet(workbook, instructions, "填写说明");
  return workbook;
}

function failureSuggestion(error) {
  const message = String(error || "");
  if (/429|限流|频繁/.test(message)) return "停止重试，等待限流解除后再运行";
  if (/登录|401|403|验证/.test(message)) return "在 Instagram 标签页确认登录状态并完成页面提示";
  if (/配额/.test(message)) return "等待 YouTube API 配额恢复后重试";
  if (/不存在|查不到/.test(message)) return "手动打开主页确认账号是否改名或注销";
  return "手动打开主页链接核对，并检查失败原因";
}

export function createResultsWorkbook(results, meta = {}) {
  if (!Array.isArray(results)) throw new Error("采集结果格式无效。");
  const workbook = xlsx().utils.book_new();
  const rows = [RESULT_HEADERS];
  const failedRows = [["行号", "账号名", "平台", "主页链接", "失败原因", "建议"]];
  for (const result of results) {
    const extra = result.extra || {};
    const note = result.status === "FAILED" && result.error ? result.error : extra["备注"] || extra["提示"] || result.note || "";
    rows.push([
      result.row_no, result.account_name, PLATFORM_TEXT[result.platform] || result.platform,
      result.profile_url, result.target_date, STATUS_TEXT[result.status] || result.status,
      result.post_title, result.post_url, result.published_local, result.post_type, extra["时长"],
      result.follower_count, result.view_count, result.like_count, result.comment_count, result.fetched_at, note,
    ]);
    if (result.status === "FAILED") {
      failedRows.push([result.row_no, result.account_name, PLATFORM_TEXT[result.platform] || result.platform,
        result.profile_url, result.error, result.error_action || failureSuggestion(result.error)]);
    }
  }
  xlsx().utils.book_append_sheet(workbook, makeSheet(rows, [6, 22, 11, 38, 20, 13, 46, 40, 19, 11, 9, 12, 11, 11, 11, 19, 45], [3, 7]), "采集结果");
  xlsx().utils.book_append_sheet(workbook, makeSheet(failedRows, [6, 22, 11, 38, 50, 42], [3]), "待人工核对");
  const metaRows = [["项目", "值"], ...Object.entries(meta)];
  xlsx().utils.book_append_sheet(workbook, makeSheet(metaRows, [26, 70]), "本次运行信息");
  return workbook;
}

export function summarize(results) {
  const groups = { OK: new Set(), NO_POST: new Set(), FAILED: new Set() };
  let posts = 0;
  for (const result of results) {
    const group = groups[result.status];
    if (group) group.add(JSON.stringify([result.platform, result.row_no]));
    if (result.status === "OK") posts++;
  }
  return { okAccounts: groups.OK.size, noPostAccounts: groups.NO_POST.size, failedAccounts: groups.FAILED.size, posts };
}
