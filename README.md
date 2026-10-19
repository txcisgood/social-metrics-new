# 社媒动态采集工具

**现在可以使用 Edge / Chrome 桌面插件 0.4.1：** [安装、使用与验收说明](edge-extension/README.md)。首次使用可按平台下载带填写说明的账号模板。使用安装插件的同一浏览器用户配置中的 Instagram 登录会话，自动创建专用主页和帖子详情标签，读取正常页面 DOM、内嵌 JSON 和页面自身已请求的数据，减少详情访问，原标签不导航。工作台仅显示进度与汇总，导入账号表后可直接导出 Excel 结果，无需 PyCharm、Python 或独立调试窗口。

Edge 通过 `edge://extensions`、Chrome 通过 `chrome://extensions` 开启开发者模式并加载项目内的 `edge-extension` 文件夹，两者使用同一份文件。扩展要求 Chromium 120 或更新版本；Edge 155 和 Chrome 155 均已通过 macOS 隔离离线集成测试，Edge 另有真实单帖验证。Chrome 的真实登录采集仍待验证。2026-10-20 用户试用反馈无明显大问题并确认发布；这不替代完整账号表和所有指标逐项核对。完整功能、升级步骤、测试结果与限制见 [本次更新记录](CHANGELOG.md)。

插件导出独立结果文件，不回填原始账号表。下面保留的安装、命令行、PyCharm 和回填说明适用于 **Python 版本**；需要该流程时请从 [Python 操作与验收步骤](操作与验收步骤.md) 开始。

抓取合作伙伴社媒账号**在指定某一天有没有发布内容**，以及那条内容的点赞数、评论数、播放数。

当前支持 YouTube 和 Instagram。Facebook 采集已移除，旧表中的 Facebook 行会跳过。YouTube 使用官方 API；Instagram 插件读取正常页面已提供的内容，不再调用旧版固定私有接口。下方 Python 版本仍保留原来的网页接口实现。页面能否访问取决于账号权限、登录态和平台限制。

## 设计理念

**一、明确数据来源。** YouTube 通过 Data API 读取公开数据，仍需处理配额、访问权限和缺失字段。Instagram 插件正常打开账号主页、滚动并读取必要的帖子详情；不读取或导出 Cookie，也不重试旧版被拒的私有接口。正常页面同样可能要求验证或限制访问。

**二、从频道上传列表读取内容。** YouTube 采集从频道的 uploads 播放列表分页获取视频，并使用视频的实际发布时间筛选日期。达到分页上限仍未覆盖目标日期时，记录失败，避免误报无发布。

**三、失败要留下可核对的记录。** 账号改名、注销或链接错误不会让这一行消失，失败原因会进入「待人工核对」工作表。限流或配额耗尽时停止该平台，剩余账号也保留失败记录，其他平台继续处理。

**四、口径写在输出里，不写在脑子里。** "当天"取决于时区，"点赞数"可能被创作者隐藏，Shorts 和长视频是两种内容形态。这些歧义不该靠使用者记住，所以结果表里同时给出本地时间与 UTC 时间、内容类型、以及"未公开（创作者已隐藏）"这类可读提示。

**五、以当前实际验收为准。** Instagram 纯 HTTP 模式曾返回 429，旧版插件也遇到过首个私有接口请求被拒。0.3.0 已更换为正常页面读取，2026-10-19 自动试采取得一条真实帖子及 88 次赞、3,244 粉丝；完整账号表、全部目标日期和在线导出仍需核对。日期没有查全时保留已确认的帖子并附带 `PAGE_INCOMPLETE`，不会误报无发布。

**六、为剩下的平台预留位置，但不提前抽象。** 平台采集器只约定一个 `fetch(account, options) -> list[PostMetric]` 契约，输入解析、日期过滤、结果输出全部平台无关。接 Instagram 时确实只加了一个文件，主流程只改了平台白名单一行。

## 准备工作：拿一个 YouTube API Key（约 5 分钟，免费）

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，登录 Google 账号
2. 顶部项目下拉框 → 新建项目，名字随便填，比如 `partner-metrics`
3. 左侧「API 和服务」→「库」→ 搜索 `YouTube Data API v3` → 点进去点「启用」
4. 左侧「API 和服务」→「凭据」→ 顶部「创建凭据」→ 选「API 密钥」
5. 复制生成的 key（形如 `AIzaSy...`）

不需要 OAuth、不需要绑卡、不需要审核。建议顺手点一下密钥的「编辑」→ API 限制 → 只勾选 YouTube Data API v3，这样 key 泄露了也用不到别处。

拿到后三种给法任选一种。注意 key 要放进 **`config.json`**，不是 `config.example.json` —— 后者是给别人看的模板，会被提交到 git，放真实 key 有泄露风险（项目里的 `.gitignore` 已经把 `config.json` 排除在版本控制外）。

```bash
# 方式一：配置文件（推荐，一次配好长期用）
cp config.example.json config.json && vi config.json

# 方式二：环境变量
export YOUTUBE_API_KEY=AIzaSy...

# 方式三：命令行临时传
python3 run.py --api-key AIzaSy... --input accounts.xlsx
```

## 安装

```bash
pip3 install -r requirements.txt   # Python 版本依赖 requests、openpyxl、websocket-client
```

或者跑一键脚本（macOS / Linux，会自动检测系统、装 Python 3.9+、建 venv、装依赖、初始化 `config.json`）：

```bash
./install.sh
```

Windows 用户跑 `install.ps1`（会自动用 winget 装 Python 3.12 + 建 venv + 装依赖 + 初始化 `config.json`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

要求 Win10 1809+ / Win11（自带 winget）。没有 winget 的老 Windows 才需要手动装 Python。

## 使用

**先记住两件事**：这批合作伙伴都在英国，所以时区要用 `Europe/London`；日常应该抓**昨天**而不是今天。

原因是英国比北京晚 7 小时。你在国内上午十点跑，英国才凌晨三点，那一天几乎必然是 0 条。实测 2026-08-29 北京时间下午 1 点跑，13 个账号全部「当天无发布」，而抓昨天立刻就有 3 个账号命中。想抓当天的话，等北京时间晚上 10 点以后再跑（对应英国下午 3 点）比较有意义。

```bash
# 日常这么跑就行：抓昨天
python3 run.py --input accounts.xlsx --tz Europe/London --date yesterday

# 抓今天（建议北京时间晚上再跑）
python3 run.py --input accounts.xlsx --tz Europe/London --date today

# 抓指定某一天
python3 run.py --input accounts.xlsx --tz Europe/London --date 2026-08-28

# 抓最近 7 天，适合周一补一整周
python3 run.py --input accounts.xlsx --tz Europe/London --days 7

# 抓不连续的几天
python3 run.py --input accounts.xlsx --tz Europe/London --date 2026-08-25,2026-08-28
```

`--date` 认 `yesterday`、`today` 这两个关键字，也认中文的「昨天」「今天」，都会按 `--tz` 指定的时区换算。

## 在 PyCharm 里跑

仓库不包含本机的 `.idea` 运行配置或 `.venv` 环境。首次克隆请按 [Python 环境与 PyCharm 配置步骤](操作与验收步骤.md#21-在-pycharm-中运行可替代下面的终端命令) 创建环境、安装依赖并手动添加运行配置。

采集的启动文件是 `run.py`，工作目录设为项目根目录，参数例如 `--input accounts.xlsx --tz Europe/London --date yesterday`。要抓今天或最近 7 天，分别改为 `--date today` 或 `--days 7`；离线自测使用 `selftest.py`。Python 解释器必须指向当前电脑的虚拟环境（macOS/Linux 为 `.venv/bin/python`，Windows 为 `.venv\Scripts\python.exe`），不要沿用其他目录或其他电脑的绝对路径。

结果默认写到 `./results/社媒动态-日期-时间戳.xlsx`，同时留一份同名 `.jsonl` 原始数据，方便以后做环比。

## 账号表格怎么填

跑一次 `python3 make_template.py` 会生成 `accounts_template.xlsx`，照着填即可。三列：

| 账号名 | 主页链接 | 平台 |
|---|---|---|
| MrBeast | https://www.youtube.com/@MrBeast | YouTube |

几个容错设计，实际用起来会省事：列顺序可以随便打乱（按表头识别）；没有表头也能读（按名称/链接/平台顺序）；平台列填错甚至填「抖音」都不影响，程序以链接为准并在备注里提示；链接不带 `https://` 会自动补全；链接支持 `youtube.com/@handle`、`/channel/UCxxx`、`/c/xxx`、`/user/xxx` 四种频道形态，甚至直接贴一个视频链接也行（会自动换成它所属频道）。

## Instagram 说明

默认使用纯 HTTP 请求，也可通过 `--ig-transport browser` 使用登录浏览器发出请求。过去曾有部分账号可以匿名访问，但这不保证当前可用；登录态也不能保证绕过限流。2026-10-08 实测，现有配置下 15 个 Instagram 账号均返回 HTTP 429，当前尚未通过在线验证。遇到 429 时程序会停止本轮 Instagram 请求，剩余账号标记失败。

有三条路径，程序自动降级：

主路径是 `web_profile_info` 接口，一次请求读取粉丝数和首页作品。首页未覆盖目标日期时转 feed 分页。

第一条兜底是 `feed` 接口。历史上部分账号的主路径返回过 400 和 `ig_business_category_subvertical has been deleted`，程序可在有 user id 时尝试 `/api/v1/feed/user/{user_id}/`；这不保证当前可以匿名访问，登录后也仍可能受限。已解析的 user id 保存在本机 `.cache/ig_user_ids.json`，缓存不随仓库分发，新克隆需要重新解析。遇到 429 时会停止该平台，不继续尝试其他接口。

第二条兜底需要 sessionid。设了年龄限制的账号匿名读不到内容，而且接口返回的是**空列表而不是报错**——这点很坑，会被误判成「当天没发」。程序对此做了专门处理：无法确定内容可见性时直接报错进人工核对；只有接口明确表示公开账号作品总数为 0 时，才按无发布处理。

### 要不要配 sessionid

浏览器模式不需要配置 sessionid；请在独立 Edge 登录。下面的配置仅适用于 HTTP 模式，是否可访问仍取决于平台限制。想配置 HTTP 模式的话：任意浏览器登录 Instagram → 开发者工具 → Application 或存储 → Cookies → instagram.com → 复制 `sessionid` 的值 → 填进 `config.json` 的 `instagram_sessionid`。有效期通常几个月。

注意这是账号凭证，`config.json` 已经在 `.gitignore` 里。建议用一个小号而不是主账号。

### 内容类型与频率

Reels、视频、图文轮播、图片四种类型会区分开。播放量只有视频类才有，图片帖留空（正好对应原表 Views 列写的「如有」）。

请求之间按最小、最大延迟随机等待；未设置时默认为 2.5 到 5 秒，本地配置可覆盖。分页会增加请求数，耗时取决于账号数量和历史深度。遇到 429 会停止本轮 Instagram 请求，请等待限制解除后再测试。

## 回填原表（默认开启）

如果你的表格本来就预留了 `Fans / Post / Post Date / Post Link / Views / Likes / Comments` 这些空列，程序会在输出独立结果文件之外，**再产出一份填好的原表副本**。本次采集行的目标列会刷新，目标列之外的内容和未采集行保持原样。

原文件一个字节都不会动 —— 程序先物理复制一份再往副本里写。

列的定位是按表头文字自动匹配的，中英文都认（`Likes`、`点赞`、`点赞数量` 都能对上），所以列顺序变了、多了几列都不影响。表头不在第一行也能找到，程序会在前三行里挑匹配最多的那行当表头。

几个填写约定：同一个账号当天发了多条时，多条内容在同一单元格里换行罗列，标题、链接、播放、点赞、评论按同样顺序一一对应；当天没发的行，`Post` 列写「（当天无发布）」并附上最近一条的发布时间；抓取失败的行写「（抓取失败：原因）」；三种状态分别标绿、黄、红底色。部分作品失败也会标红并明确提示；已采集行的旧指标和旧链接会清除，防止上次数据混入本次结果。

本次没有采集的平台（比如使用 --platform 筛选时未选择的平台）整行保持原样，不会覆盖你手工填过的内容。

副本里会追加一个「采集记录」sheet，记录每次运行的时间、目标日期、命中与失败数量、以及回填了哪些行号，多次运行会累加，方便回溯。

不想要这份副本就加 `--no-fill-back`。

## 独立结果表怎么看

「采集结果」sheet 里，`当天有无发布` 一列有三种值并配了底色：绿色「有」、黄色「无」、红色「抓取失败」。当天发了多条就出多行。当天没发的，备注里会给出"最近一条发布于 X 月 X 日"，方便判断这个账号是不活跃还是彻底停更。

「待人工核对」sheet 只在有失败时出现，每行带失败原因和建议动作。

「本次运行信息」sheet 记录这次跑的日期、时区、API 消耗，便于回溯。

## 几个必须知道的口径

**"当天"是按时区算的。** 默认用 `Asia/Shanghai`。一条 UTC 时间 8 月 28 日 23:40 发布的视频，在东八区算 8 月 29 日 07:40，会被算进 8 月 29 日。如果你更关心创作者当地的"当天"，用 `--tz` 换成对应时区。结果表里同时给出本地时间和 UTC 时间，随时可以自己核。

**计数字段可能拿不到。** 点赞或评论字段缺失时写“未公开或不可用”，不会当成 0，也不会仅凭缺失字段断定隐藏点赞或关闭评论。

**内容类型会区分。** Shorts、长视频、直播回放、正在直播、直播预告五种。Shorts 的判定先按时长粗筛（≤3 分钟），再参考 Shorts 页面响应进行启发式判断，不是官方类型标识。如果嫌慢可以加 `--no-shorts-check`。

**播放量和点赞量有延迟。** YouTube 自己的统计数字对新发布的视频有几分钟到几小时的更新延迟，刚发一小时的视频数字偏低是正常的。如果要做严肃的数据对比，建议固定在每天同一时间跑。

## 配额够用吗

每天免费 10000 单位。每个频道稳定消耗约 2~3 单位（频道 ID 解析结果会缓存到 `.cache/`，第二次跑就不再消耗）。也就是说 10000 单位大概能跑 3000 多个账号，几十个账号一天跑几十遍都用不完。真跑超了程序会中止 YouTube 并提示，Instagram 继续，不会把配额浪费在无效重试上。

## 出问题怎么办

看「待人工核对」sheet 的失败原因。常见几种：`无法解析出频道 ID` 说明链接不是频道主页（可能贴了播放列表或搜索结果页）；`频道查不到` 说明账号改名或注销了；`网络异常` 重跑一次通常就好；`配额已用尽` 等次日零点（太平洋时间）重置。

想不消耗配额验证程序本身是否正常，跑 `python3 selftest.py`，它用构造的接口响应把全链路逻辑走一遍。

## 更新记录

- 2026-08-29 v0.1.0 首版。YouTube 全链路（四种链接形态解析、按日期过滤、Shorts/直播识别、配额保护、失败兜底）、xlsx/csv 输入、Excel + jsonl 输出、离线自测 33 项全通过。
- 2026-08-29 v0.2.0 按真实账号表适配。新增回填原表功能（自动定位 Fans/Post/Post Date/Post Link/Views/Likes/Comments 列，原文件不改动，一天多条同格换行合并，追加「采集记录」sheet）；新增粉丝数采集（复用已有的 channels.list 请求，零额外配额）；平台列里的列说明文字不再产生备注噪音，同时扩展了平台别名以便真正填错时能提示；实测真实表格 31 行全部正确解析，13 个 YouTube 频道链接用网页兜底方式全部预验通过；自测扩充到 45 项。
- 2026-08-29 v0.3.0 接入真实 API Key 跑通全量。13 个 YouTube 账号实测采集成功，7 天窗口验证到 19 条作品、长视频/Shorts/正在直播三种类型均正确识别、点赞评论播放与粉丝数全部拿到。新增 `--date yesterday/today` 关键字；多日期的目标日期统一压成「起~止」区间写法（原来会在文件名和单元格里写出一长串日期）；补上 PyCharm 运行配置四个；把误放在 `config.example.json` 的真实 key 迁到 `config.json` 并加 `.gitignore` 防止泄露。踩坑记录：英国比北京晚 7 小时，国内白天跑「今天」几乎必然 0 条，日常应抓昨天。
- 2026-08-29 v0.4.0 接入 Instagram，纯 HTTP 实现。实测 28 个账号（13 YouTube + 15 Instagram）一次跑完 27 成功，唯一失败的是设了年龄限制的账号。三条自动降级路径：web_profile_info 主路径、feed 接口兜底（配 user id 缓存，已预置三个查证过的 id）、sessionid 路径（可选）。自测扩到 83 项。

  这一版走了弯路：Instagram 最初做的是浏览器自动化（独立 Chrome 实例 + CDP），做完才验证纯 requests 匿名可行，于是把浏览器降级为可选。过程中修掉四个问题，两个是自己的 bug：CDP 通道回传 591KB 响应被截断却被归类成「未登录」；`Page.navigate` 异步返回加上旧文档 readyState 已是 complete，导致脚本跑在 about:blank 上。另外两个更值得记：Instagram 允许匿名返回 200，用「返回 200」判断登录态是错的，实际一直在匿名抓；以及年龄限制账号返回空列表会被误判成「当天无发布」——这种静默的错误数据比直接失败危险得多，现在一条作品都读不到就直接报错。

  还修了一个设计错误：单个账号缺 sessionid 原本会中止整个平台，把后面 11 个能正常抓的账号全带崩，现在改成单账号级失败。


## 采集完整性与验证

`--scan-pages` 同时限制两个平台的分页请求。Instagram 首页不足以覆盖目标日期时会转 feed 翻页，跨页内容去重；分页失败、游标缺失或达到上限仍未覆盖日期时记为抓取失败，不会误报无发布。可以增大 `--scan-pages` 后重试。置顶帖子不用于判断日期覆盖。YouTube 达到分页上限也会明确失败。

计数字段缺失表示未公开或不可用，不据此断定创作者隐藏点赞或关闭评论。YouTube 某条视频详情不可用时，该条记为失败。YouTube 配额耗尽只停止该平台，剩余账号均有失败记录，Instagram 继续。退出码 0 表示全部完成，2 表示结果含失败账号。

`python3 selftest.py` 只运行离线测试，不发网络请求；`python3 -m unittest discover -s tests -v` 运行分页及异常回归测试。离线通过不等于实时接口可访问。

2026-10-08 在线验证：按 Europe/London 查询 2026-10-02 至 2026-10-08，13 个 YouTube 账号均成功（9 个有发布、4 个无发布，共 15 条视频）。本次关闭 Shorts 额外页面探测，因此没有验证 Shorts 分类的在线准确性。Instagram 15 个账号均返回 HTTP 429，尚未验证在线采集及分页可用性。


## Instagram 浏览器模式（待在线验收）

普通打开 Edge 不会自动开启调试接口。新增 `--ig-transport browser` 会让已登录的
Instagram 标签页实际发出请求；原来的 `--use-browser` 仅用于解析 user id，两者不同。
新模式不读取或导出 Cookie，不使用配置文件中的 sessionid，也不会偷偷退回 Python HTTP。

显式运行以下启动器会打开独立 Edge 配置目录（`.cache/instagram-edge-9222`），
不会关闭日常 Edge 或复制它的登录资料。首次需要在新窗口中手动登录 Instagram。
调试端口限于本机，使用期间本机程序可以访问该实例，因此只在该实例打开采集所需页面。

```bash
python3 start_instagram_browser.py
python3 run.py --input 网红list.xlsx --platform instagram --ig-transport browser --tz Europe/London --date yesterday
```

可用 `--browser-port` 指定其他本机端口，启动器对应参数是 `--port`。
仅发送 GET 请求，限定为 Instagram 主页、账号信息和 feed 接口；遇到 429 仍会停止，
不会换代理或重复强刷。浏览器模式是待实测的访问路径，并不保证网页能打开就意味着接口可用。
当前已完成离线传输、域名限制、登录异常、限流和现有采集回归测试，尚未完成在线验收。

参考：[Microsoft Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)。
