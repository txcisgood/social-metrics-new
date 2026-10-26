import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createResultsWorkbook, createVideoResultsWorkbook, createAccountsTemplate, accountTemplateLabel, loadAccounts, readWorkbook, summarize } from "../extension/lib/workbook.mjs";
import { failedRow } from "../extension/lib/jobs.mjs";

const require = createRequire(import.meta.url);
globalThis.XLSX = require("../extension/vendor/xlsx.full.min.js");
const XLSX = globalThis.XLSX;

function workbook(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Accounts");
  return wb;
}

for (const platform of ["instagram", "youtube", "all"]) {
  test(`${platform} template round trip starts empty, documents examples separately, and imports edited links`, () => {
    const generated = createAccountsTemplate(platform);
    const bytes = XLSX.write(generated, {type: "array", bookType: "xlsx"});
    const actual = readWorkbook(bytes, "template.xlsx");
    assert.deepEqual(actual.SheetNames, ["账号清单", "填写说明"]);
    assert.deepEqual(loadAccounts(actual), {accounts: [], warnings: []}, "examples must not become capture targets");
    assert.deepEqual(loadAccounts(actual, "填写说明").accounts, [], "instruction examples are not input rows");
    const input = actual.Sheets["账号清单"];
    const instructions = XLSX.utils.sheet_to_json(actual.Sheets["填写说明"], {header: 1}).flat().join("\n");
    assert.match(instructions, /保存为 .xlsx/);
    if (platform !== "youtube") assert.match(instructions, /示例：https:\/\/www.instagram.com\/your_username\//);
    if (platform !== "instagram") assert.match(instructions, /示例：https:\/\/www.youtube.com\/@your_handle/);
    assert.match(instructions, /Facebook/); assert.match(instructions, /当前不支持/);
    for (const sheet of Object.values(actual.Sheets)) {
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith("!")) continue;
        assert.equal(cell.f, undefined); assert.equal(cell.l, undefined);
      }
    }
    const selected = platform === "all" ? ["instagram", "youtube"] : [platform];
    selected.forEach((value, i) => {
      input[`B${i + 2}`] = {t: "s", v: value === "instagram" ? "https://www.instagram.com/filled_creator/" : "https://www.youtube.com/@filled_channel"};
      input[`C${i + 2}`] = {t: "s", v: ""}; // Platform and account name are optional.
    });
    const filled = readWorkbook(XLSX.write(actual, {type: "array", bookType: "xlsx"}), "filled.xlsx");
    const imported = loadAccounts(filled);
    assert.deepEqual(imported.accounts.map(account => account.platform), selected);
    assert.equal(imported.accounts.length, selected.length); assert.deepEqual(imported.warnings, []);
    input.B2.v = "https://www.instagram.com/replacement_creator/";
    assert.equal(loadAccounts(actual).accounts[0].url, input.B2.v, "changing visible URL cannot leave a hidden old target");
  });
}

test("templates cannot imply support for Facebook or arbitrary platform values", () => {
  assert.equal(accountTemplateLabel("all"), "混合");
  for (const value of ["facebook", "__proto__", "constructor", "unknown"]) {
    assert.throws(() => createAccountsTemplate(value), /请选择/);
    assert.throws(() => accountTemplateLabel(value), /请选择/);
  }
});

test("review-sheet guidance matches friendly failures and skipped rows, with legacy fallback", () => {
  const account = {row_no: 2, name: "Creator", platform: "instagram", url: "https://www.instagram.com/creator/"};
  const options = {targetDates: ["2026-10-19"]};
  const error = Object.assign(new Error("Instagram 已限流"), {code: "RATE_LIMIT"});
  const actual = failedRow(account, options, error);
  const skipped = failedRow({...account, row_no: 3}, options, error, {skipped: true});
  const legacy = {...actual, row_no: 4, error_action: undefined, error: "HTTP 429"};
  const generated = createResultsWorkbook([actual, skipped, legacy]);
  const saved = XLSX.read(XLSX.write(generated, {type: "buffer", bookType: "xlsx"}), {type: "buffer"});
  const sheet = saved.Sheets["待人工核对"];
  assert.equal(sheet.F2.v, actual.error_action);
  assert.match(sheet.F2.v, /暂停采集/);
  assert.equal(sheet.F3.v, skipped.error_action);
  assert.match(sheet.F3.v, /本账号未发送采集请求/);
  assert.match(sheet.F4.v, /等待限流解除/);
});

test("recognizes Chinese headers and prefers profile URLs over post or generic links", () => {
  const wb = workbook([
    ["作品链接", "链接", "账号名", "主页链接（必填）", "平台"],
    ["https://www.instagram.com/p/post/", "https://youtube.com/@wrong", "博主甲", "https://www.instagram.com/creator/", "ins"],
  ]);
  assert.deepEqual(loadAccounts(wb), {
    accounts: [{ row_no: 2, name: "博主甲", url: "https://www.instagram.com/creator/", platform: "instagram", note: "" }],
    warnings: [],
  });
});

test("English reordered headers and sheet selection work", () => {
  const wb = workbook([["Platform", "Profile URL", "Account Name"], ["YouTube", "youtube.com/@creator", "Name"]]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["url"], ["instagram.com/other/"]]), "Other");
  assert.equal(loadAccounts(wb).accounts[0].name, "Name");
  assert.equal(loadAccounts(wb).accounts[0].platform, "youtube");
  assert.equal(loadAccounts(wb, "Other").accounts[0].name, "other");
});

test("headerless rows preserve actual row numbers and duplicate account names", () => {
  const wb = workbook([
    [],
    ["账号", "https://instagram.com/one/", "Instagram"],
    [],
    ["账号", "https://instagram.com/two/", "Instagram"],
  ]);
  const { accounts } = loadAccounts(wb);
  assert.deepEqual(accounts.map(account => account.row_no), [2, 4]);
  assert.deepEqual(accounts.map(account => account.name), ["账号", "账号"]);
});

test("Excel hyperlink targets take precedence over display labels", () => {
  const wb = workbook([["账号名", "主页链接"], ["Creator", "点击打开主页"]]);
  wb.Sheets.Accounts.B2.l = { Target: "https://www.instagram.com/creator/" };
  const serialized = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  assert.equal(loadAccounts(readWorkbook(serialized, "accounts.xlsx")).accounts[0].url, "https://www.instagram.com/creator/");
});

test("arbitrary and deceptive hosts cannot become accounts via platform hints", () => {
  const urls = [
    "https://instagram.com.evil.example/creator/",
    "https://evilinstagram.com/creator/",
    "https://example.org/instagram.com/creator/",
    "https://instagram.com@evil.example/creator/",
    "https://evil.example@instagram.com/creator/",
    "javascript:alert(1)",
    "https://instagram.com:9233/creator/",
    "https://facebook.com/creator/",
    "https://m.instagram.com/allowed/",
    "https://youtu.be/allowed",
  ];
  const { accounts, warnings } = loadAccounts(workbook([["账号名", "主页链接", "平台"], ...urls.map((url, index) => [String(index), url, "Instagram"])]));
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map(account => account.platform), ["instagram", "youtube"]);
  assert.equal(warnings.length, 9); // Eight skipped rows plus the platform mismatch.
  assert.match(warnings[7], /Facebook/);
});

test("a post-only header does not get mistaken for a profile URL column", () => {
  const result = loadAccounts(workbook([["账号名", "作品链接"], ["Creator", "https://instagram.com/p/post/"]]));
  assert.equal(result.accounts.length, 0);
  assert.match(result.warnings[0], /主页链接列/);
});

test("UTF-8 BOM and GB18030 Chinese CSV inputs retain headers and names", () => {
  const utf8 = new TextEncoder().encode("\uFEFF账号名,主页链接,平台\r\n测试,https://www.instagram.com/example/,Instagram\r\n");
  const gb18030 = Uint8Array.from(Buffer.from("d5cbbac5c3fb2cd6f7d2b3c1b4bdd32cc6bdcca80ab2e2cad42c68747470733a2f2f7777772e696e7374616772616d2e636f6d2f6578616d706c652f2c496e7374616772616d0a", "hex"));
  for (const bytes of [utf8, gb18030]) {
    const { accounts, warnings } = loadAccounts(readWorkbook(bytes, "中文账号.CSV"));
    assert.equal(accounts[0].name, "测试");
    assert.equal(accounts[0].url, "https://www.instagram.com/example/");
    assert.deepEqual(warnings, []);
  }
});

test("TSV decoding and size / old Excel validation return useful errors", () => {
  const tsv = new TextEncoder().encode("Account Name\tProfile URL\nCreator\thttps://instagram.com/creator/\n");
  assert.equal(loadAccounts(readWorkbook(tsv, "accounts.tsv")).accounts[0].name, "Creator");
  assert.throws(() => readWorkbook(tsv, "accounts.xls"), /另存为 .xlsx/);
  assert.throws(() => readWorkbook(new ArrayBuffer(10 * 1024 * 1024 + 1), "large.xlsx"), /10 MB/);
  assert.throws(() => readWorkbook(new ArrayBuffer(0), "empty.csv"), /空/);
  const huge = workbook([["账号名", "主页链接"]]);
  huge.Sheets.Accounts["!ref"] = "A1:B1048576";
  assert.throws(() => loadAccounts(huge), /范围过大/);
});

test("exported text stays literal and only valid HTTPS links are linked after XLSX round trip", () => {
  const rows = [
    { row_no: 2, account_name: "=HYPERLINK(\"https://evil.example\")", platform: "instagram", profile_url: "https://instagram.com/creator/", status: "OK", post_title: "=1+2", post_url: "javascript:alert(1)", like_count: 0, extra: { 备注: "@formula" } },
    { row_no: 3, account_name: "+123", platform: "instagram", profile_url: "https://user:password@example.com", status: "FAILED", error: "=2+2", post_url: "http://example.com/post" },
  ];
  const wb = createResultsWorkbook(rows, { "=meta": "=3+3" });
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const actual = XLSX.read(bytes, { type: "array", cellFormula: true });
  assert.deepEqual(actual.SheetNames, ["采集结果", "待人工核对", "本次运行信息"]);
  for (const [sheetName, address, expected] of [
    ["采集结果", "B2", rows[0].account_name], ["采集结果", "G2", "=1+2"],
    ["采集结果", "Q2", "@formula"], ["待人工核对", "E2", "=2+2"],
    ["本次运行信息", "A2", "=meta"], ["本次运行信息", "B2", "=3+3"],
  ]) {
    const cell = actual.Sheets[sheetName][address];
    assert.equal(cell.t, "s");
    assert.equal(cell.v, expected);
    assert.equal(cell.f, undefined);
  }
  assert.equal(actual.Sheets["采集结果"].D2.l.Target, rows[0].profile_url);
  for (const address of ["H2", "D3", "H3"]) assert.equal(actual.Sheets["采集结果"][address].l, undefined);
  assert.equal(actual.Sheets["采集结果"].N2.v, 0);
  assert.equal(wb.Sheets["采集结果"]["!cols"].length, 17);
  assert.equal(actual.Sheets["采集结果"]["!autofilter"].ref, "A1:Q3");
});

const ORIGINAL_HEADERS = ["行号", "账号名", "平台", "主页链接", "目标日期", "期间有无发布", "作品标题",
  "作品链接", "发布时间(本地)", "类型", "时长", "粉丝数", "播放", "点赞", "评论", "抓取时间", "备注"];
for (const mode of ['instagram', 'youtube', 'mixed', 'channel', 'keyword']) {
  test(`${mode} export retains the original headers, widths and sheets despite additional video fields`, () => {
    const row = {row_no: 2, platform: mode === 'instagram' || mode === 'mixed' ? 'instagram' : 'youtube',
      status: 'OK', post_title: '原标题', post_description: '额外简介', source_mode: mode,
      channel_title: '频道', comments_status: 'PARTIAL', comments: [{id: 'comment', text: '评论'}]};
    const rows = mode === 'mixed' ? [row, {...row, platform: 'youtube', row_no: 3}] : [row];
    const meta = {采集模式: ({channel: '频道视频', keyword: '关键词搜索'})[mode] || '视频 URL（含评论）'};
    const generated = createResultsWorkbook(rows, meta);
    const actual = readWorkbook(XLSX.write(generated, {type: 'array', bookType: 'xlsx'}), 'original.xlsx');
    assert.deepEqual(actual.SheetNames, ['采集结果', '待人工核对', '本次运行信息']);
    assert.deepEqual(XLSX.utils.sheet_to_json(actual.Sheets['采集结果'], {header: 1})[0], ORIGINAL_HEADERS);
    assert.deepEqual(generated.Sheets['采集结果']['!cols'].map(column => column.wch),
      [6, 22, 11, 38, 28, 13, 46, 40, 19, 11, 9, 12, 11, 11, 11, 19, 45]);
    assert.equal(actual.Sheets['采集结果']['!ref'], `A1:Q${rows.length + 1}`);
    assert.equal(actual.Sheets['采集结果']['!autofilter'].ref, `A1:Q${rows.length + 1}`);
    assert.equal(actual.Sheets['待人工核对']['!ref'], 'A1:F1');
  });
}

test("empty exports keep all three sheets and results headers", () => {
  const wb = createResultsWorkbook([]);
  assert.deepEqual(wb.SheetNames, ["采集结果", "待人工核对", "本次运行信息"]);
  assert.equal(wb.Sheets["采集结果"].A1.v, "行号");
});

test('both export templates format YouTube durations in restored data while retaining the raw result and other platforms', () => {
  const rows = [{row_no: 1, platform: 'youtube', status: 'OK', extra: {时长: 'PT16S'}},
    {row_no: 2, platform: 'youtube', status: 'OK', extra: {时长: 'PT15M2S'}},
    {row_no: 3, platform: 'instagram', status: 'OK', extra: {时长: 'PT16S'}}];
  for (const create of [createResultsWorkbook, createVideoResultsWorkbook]) {
    const wb = readWorkbook(XLSX.write(create(rows), {type: 'array', bookType: 'xlsx'}), 'durations.xlsx');
    assert.equal(wb.Sheets['采集结果'].K2.v, '00:16');
    assert.equal(wb.Sheets['采集结果'].K2.t, 's');
    assert.equal(wb.Sheets['采集结果'].K3.v, '15:02');
    assert.equal(wb.Sheets['采集结果'].K4.v, 'PT16S');
  }
  assert.equal(rows[0].extra.时长, 'PT16S');
});

test("incomplete coverage exports as review needed while retaining posts and actual failures", () => {
  const account = {row_no: 2, name: "Creator", platform: "instagram", url: "https://www.instagram.com/creator/"};
  const options = {targetDates: ["2026-10-19"]};
  const incomplete = failedRow(account, options, Object.assign(new Error("未查全"), {code: "PAGE_INCOMPLETE", stopReason: "no_progress"}));
  const failure = failedRow({...account, row_no: 3}, options, Object.assign(new Error("暂时限制"), {code: "RATE_LIMIT"}));
  const rows = [{...incomplete, status: "OK", error: "", post_url: "https://www.instagram.com/p/KNOWN/"}, incomplete, failure];
  const actual = XLSX.read(XLSX.write(createResultsWorkbook(rows), {type: "array", bookType: "xlsx"}), {type: "array"});
  assert.equal(actual.Sheets["采集结果"].F2.v, "有");
  assert.equal(actual.Sheets["采集结果"].F3.v, "待核对");
  assert.equal(actual.Sheets["采集结果"].F4.v, "抓取失败");
  assert.equal(actual.Sheets["采集结果"].H2.v, rows[0].post_url);
  assert.equal(actual.Sheets["待人工核对"].E2.v, incomplete.error);
  assert.equal(actual.Sheets["待人工核对"].E3.v, failure.error);
  assert.equal(incomplete.status, "FAILED", "Export labeling must not change coverage accounting");
});

test("summary uses platform and source row identity, including partial failures", () => {
  const results = [
    { row_no: 2, account_name: "same", platform: "instagram", status: "OK" },
    { row_no: 2, account_name: "same", platform: "instagram", status: "OK" },
    { row_no: 3, account_name: "same", platform: "instagram", status: "OK" },
    { row_no: 2, account_name: "same", platform: "youtube", status: "OK" },
    { row_no: 2, platform: "instagram", status: "FAILED" },
    { row_no: 2, platform: "instagram", status: "FAILED" },
    { row_no: 4, platform: "instagram", status: "NO_POST" },
    { row_no: 4, platform: "instagram", status: "NO_POST" },
  ];
  assert.deepEqual(summarize(results), { okAccounts: 3, noPostAccounts: 1, failedAccounts: 1, posts: 4 });
});
