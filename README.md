# 社媒动态采集工具

抓取合作伙伴社媒账号**在指定某一天有没有发布内容**，以及那条内容的点赞数、评论数、播放数。

当前已接入 YouTube、Instagram 和 Facebook。前两者是纯 HTTP 请求，不需要浏览器、不需要装插件；Facebook 因为匿名访问已被完全封死（实测 www 版 400、mbasic 版强制跳登录页、连 datr 设备 cookie 都绕不过），必须配一个登录 cookie 才能跑，没配的话 Facebook 账号会单账号级失败并给出指引，不影响其他平台。

## 设计理念

**一、能走官方接口就绝不解 HTML。** YouTube 有免费且完整的官方 API，数据准确、不会因为页面改版而失效、也不存在被封号的风险。只有在官方接口确实拿不到数据时（比如后面要接的 Facebook），才退到浏览器方案。这条原则决定了三个平台的实现难度天差地别，也决定了这个工具长期的维护成本。

**二、不用 search 接口，用 uploads 播放列表。** YouTube 的 `search.list` 一次消耗 100 个配额单位，而且它的索引有几分钟到几小时的延迟——当天刚发布的视频经常搜不到，这恰好是本工具最需要的场景。每个频道自带的 uploads 播放列表是实时的，一次只花 1 个单位。这个选择让单账号的配额消耗从 100 降到 3，也让"当天刚发的"这件事真正可靠。

**三、失败不阻断，失败要可交接。** 几十个账号里总会有改名的、注销的、链接贴错的。任何一个账号出问题，其余账号照常跑完，问题账号单独进「待人工核对」sheet，附上失败原因和处理建议以及可直接点开的链接。追求 100% 自动化的成本远高于手工补三五个。

**四、口径写在输出里，不写在脑子里。** "当天"取决于时区，"点赞数"可能被创作者隐藏，Shorts 和长视频是两种内容形态。这些歧义不该靠使用者记住，所以结果表里同时给出本地时间与 UTC 时间、内容类型、以及"未公开（创作者已隐藏）"这类可读提示。

**五、先用最笨的办法试一遍，再决定要不要上重武器。** Instagram 最初是用浏览器自动化做的——控制一个独立的 Chrome 实例，在已登录的页面里调接口。做完之后回头做了一件事：用纯 requests 匿名试了一遍，结果 15 个账号里 12 个直接就通了。于是整套浏览器方案降级成了可选兜底。教训是遇到「有反爬」的平台容易condition反射地上浏览器，但应该先花十分钟验证最简单的路径是否真的不行。

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
pip3 install -r requirements.txt   # 只需要 requests 和 openpyxl
```

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

项目里已经配好四个运行配置，打开项目后右上角的运行下拉框里直接选：

- **1 抓昨天（推荐）** —— 日常用这个
- **2 抓今天**
- **3 抓最近7天**
- **4 离线自测** —— 不消耗 API 配额，改完代码跑一下确认没弄坏

这四个配置都已经绑定了项目里的 `.venv` 解释器和真实的账号表路径，点绿色三角就能跑，不用敲命令。

如果运行下拉框是空的，说明 PyCharm 还没加载配置，重开一次项目即可。要改抓取日期又不想新建配置，就在配置的 Parameters 里把 `--date yesterday` 改成你要的日期。

第一次打开如果提示找不到解释器，去 Settings → Project → Python Interpreter 选 `.venv/bin/python`；依赖已经装好了，不用再 pip install。

结果默认写到 `./results/社媒动态-日期-时间戳.xlsx`，同时留一份同名 `.jsonl` 原始数据，方便以后做环比。

## 账号表格怎么填

跑一次 `python3 make_template.py` 会生成 `accounts_template.xlsx`，照着填即可。三列：

| 账号名 | 主页链接 | 平台 |
|---|---|---|
| MrBeast | https://www.youtube.com/@MrBeast | YouTube |

几个容错设计，实际用起来会省事：列顺序可以随便打乱（按表头识别）；没有表头也能读（按名称/链接/平台顺序）；平台列填错甚至填「抖音」都不影响，程序以链接为准并在备注里提示；链接不带 `https://` 会自动补全；链接支持 `youtube.com/@handle`、`/channel/UCxxx`、`/c/xxx`、`/user/xxx` 四种频道形态，甚至直接贴一个视频链接也行（会自动换成它所属频道）。

## Instagram 说明

不需要浏览器，不需要登录，纯 HTTP 就能跑。实测 15 个账号里 12 个匿名直接拿到完整数据（前 12 条作品 + 精确粉丝数）。

有三条路径，程序自动降级：

主路径是 `web_profile_info` 接口，一次请求拿到粉丝数和主页前 12 条作品。绝大多数账号走这条。

第一条兜底是 `feed` 接口。部分账号的主路径会稳定返回 400，错误信息是 `ig_business_category_subvertical has been deleted` —— 这是 Instagram 服务端自己的问题，换 UA、换 `i.instagram.com` 域名、换 app id 都一样。这时改用 `/api/v1/feed/user/{user_id}/`，匿名同样可用。麻烦的地方是拿 user id：匿名返回的主页 HTML 里没有，而所有能查 id 的接口都要求登录。好在 user id 永久不变，所以缓存一次就够了，缓存文件是 `.cache/ig_user_ids.json`，已经预置了三个查证过的 id。

第二条兜底需要 sessionid。设了年龄限制的账号匿名读不到内容，而且接口返回的是**空列表而不是报错**——这点很坑，会被误判成「当天没发」。程序对此做了专门处理：一条作品都读不到时直接报错进人工核对，绝不写成「当天无发布」。

### 要不要配 sessionid

不配也能跑，只是年龄限制的账号会失败，走兜底的账号拿不到粉丝数。想配的话：任意浏览器登录 Instagram → 开发者工具 → Application 或存储 → Cookies → instagram.com → 复制 `sessionid` 的值 → 填进 `config.json` 的 `instagram_sessionid`。有效期通常几个月。

注意这是账号凭证，`config.json` 已经在 `.gitignore` 里。建议用一个小号而不是主账号。

### 内容类型与频率

Reels、视频、图文轮播、图片四种类型会区分开。播放量只有视频类才有，图片帖留空（正好对应原表 Views 列写的「如有」）。

账号之间默认随机等待 2.5 到 5 秒，30 个账号跑完约两分钟。被限流了会明确提示，把 `--ig-min-delay` 调大再跑。

## 回填原表（默认开启）

如果你的表格本来就预留了 `Fans / Post / Post Date / Post Link / Views / Likes / Comments` 这些空列，程序会在输出独立结果文件之外，**再产出一份填好的原表副本**，格式、公式、其他 sheet 全部保留。

原文件一个字节都不会动 —— 程序先物理复制一份再往副本里写。

列的定位是按表头文字自动匹配的，中英文都认（`Likes`、`点赞`、`点赞数量` 都能对上），所以列顺序变了、多了几列都不影响。表头不在第一行也能找到，程序会在前三行里挑匹配最多的那行当表头。

几个填写约定：同一个账号当天发了多条时，多条内容在同一单元格里换行罗列，标题、链接、播放、点赞、评论按同样顺序一一对应；当天没发的行，`Post` 列写「（当天无发布）」并附上最近一条的发布时间；抓取失败的行写「（抓取失败：原因）」；三种状态分别标绿、黄、红底色。

本次没有采集的平台（比如目前的 Instagram 和 Facebook）整行保持留空不动，不会覆盖你手工填过的内容。

副本里会追加一个「采集记录」sheet，记录每次运行的时间、目标日期、命中与失败数量、以及回填了哪些行号，多次运行会累加，方便回溯。

不想要这份副本就加 `--no-fill-back`。

## 独立结果表怎么看

「采集结果」sheet 里，`当天有无发布` 一列有三种值并配了底色：绿色「有」、黄色「无」、红色「抓取失败」。当天发了多条就出多行。当天没发的，备注里会给出"最近一条发布于 X 月 X 日"，方便判断这个账号是不活跃还是彻底停更。

「待人工核对」sheet 只在有失败时出现，每行带失败原因和建议动作。

「本次运行信息」sheet 记录这次跑的日期、时区、API 消耗，便于回溯。

## 几个必须知道的口径

**"当天"是按时区算的。** 默认用 `Asia/Shanghai`。一条 UTC 时间 8 月 28 日 23:40 发布的视频，在东八区算 8 月 29 日 07:40，会被算进 8 月 29 日。如果你更关心创作者当地的"当天"，用 `--tz` 换成对应时区。结果表里同时给出本地时间和 UTC 时间，随时可以自己核。

**点赞数可能拿不到。** YouTube 允许创作者隐藏点赞数，这种情况下官方 API 也返回不了，表里会写"未公开（创作者已隐藏）"而不是 0。评论区被关闭时同理，写"已关闭评论"。这不是抓取失败，是数据本身不存在。

**内容类型会区分。** Shorts、长视频、直播回放、正在直播、直播预告五种。Shorts 的判定先按时长粗筛（≤3 分钟），再用一次不消耗配额的请求确认，准确率很高。如果嫌慢可以加 `--no-shorts-check`。

**播放量和点赞量有延迟。** YouTube 自己的统计数字对新发布的视频有几分钟到几小时的更新延迟，刚发一小时的视频数字偏低是正常的。如果要做严肃的数据对比，建议固定在每天同一时间跑。

## 配额够用吗

每天免费 10000 单位。每个频道稳定消耗约 2~3 单位（频道 ID 解析结果会缓存到 `.cache/`，第二次跑就不再消耗）。也就是说 10000 单位大概能跑 3000 多个账号，几十个账号一天跑几十遍都用不完。真跑超了程序会立刻中止并提示，不会把配额浪费在无效重试上。

## 出问题怎么办

看「待人工核对」sheet 的失败原因。常见几种：`无法解析出频道 ID` 说明链接不是频道主页（可能贴了播放列表或搜索结果页）；`频道查不到` 说明账号改名或注销了；`网络异常` 重跑一次通常就好；`配额已用尽` 等次日零点（太平洋时间）重置。

想不消耗配额验证程序本身是否正常，跑 `python3 selftest.py`，它用构造的接口响应把全链路逻辑走一遍。

## Facebook 说明

**必须用已登录的 Edge 协助**，匿名访问 2026 年已完全封死（实测：requests www 400、curl mbasic 强制登录、cookie 注入服务端 RSA 校验）。

最稳的做法：**让程序接管你已经登录的 Edge 标签页**。Edge 自身维持 Facebook 登录态，程序通过 CDP（9222 调试端口）接管其一个标签页，跳到目标主页抓数据。

### 使用流程（约 1 分钟）

1. **关掉所有 Edge 窗口**（重要：调试模式独占 Profile）
2. **跑项目里的启动脚本**：`./start_edge_debug.sh`，它会温和退出 Edge 然后以调试模式重启（你的真实 Profile，登录态和标签页全保留）
3. **在 Edge 里手动打开一个 Facebook 主页**（任何一个都行，目的让 Facebook 完成首次握手，cookie 写盘）。Edge 标题栏显示你的名字 = 已登录
4. **跑采集**：`python run.py --input 网红list.xlsx --platform facebook --tz Europe/London --date yesterday`
5. **采集完成后**：`pkill -x "Microsoft Edge"` 关掉调试实例，再正常启动 Edge

`start_edge_debug.sh` 自带端口检查和失败指引，不用记命令。

### 数据来源与口径

**走 www 版**（`https://www.facebook.com/<vanity>` 或 `profile.php?id=...`），从页面内嵌 JSON 提取数据。理由：mbasic 现在对所有非浏览器 UA 都重定向到 www 版，cookie 注入也不行；只有真浏览器能让 Facebook 吐出登录态内容。

字段来源（权威、来自 Facebook 服务端内嵌 JSON）：

| 字段 | 来源 | 备注 |
|---|---|---|
| 帖子时间 | `creation_time`（Unix 秒） | 精确可靠 |
| 帖子正文 | `message.text` | 最可靠 |
| Likes | `reaction_count.count` | 含全部反应表情（赞/爱心/哈哈），非纯「点赞」 |
| 评论数 | `comments.total_count` | 与前台一致 |
| 转发数 | `share_count.count` | 可能为 0 |
| 粉丝数 | `follower_count` | 页面头部 |

### 不支持的情况

- 主页存在但 Edge 登录账号不是好友（个人页时间线对非好友隐藏）→ 报错进人工核对，不会写成「当天无发布」
- Edge 登录态过期 → 提示「请在 Edge 里重新登录 Facebook」

### 调参

账号间随机等待 5~10 秒（`--fb-min-delay` / `--fb-max-delay` 或 `config.json` 的 `fb_min_delay` / `fb_max_delay`）。别调太小——登录态请求过快有触发风控的风险。


## 更新记录

- 2026-08-29 v0.1.0 首版。YouTube 全链路（四种链接形态解析、按日期过滤、Shorts/直播识别、配额保护、失败兜底）、xlsx/csv 输入、Excel + jsonl 输出、离线自测 33 项全通过。
- 2026-08-29 v0.2.0 按真实账号表适配。新增回填原表功能（自动定位 Fans/Post/Post Date/Post Link/Views/Likes/Comments 列，原文件不改动，一天多条同格换行合并，追加「采集记录」sheet）；新增粉丝数采集（复用已有的 channels.list 请求，零额外配额）；平台列里的列说明文字不再产生备注噪音，同时扩展了平台别名以便真正填错时能提示；实测真实表格 31 行全部正确解析，13 个 YouTube 频道链接用网页兜底方式全部预验通过；自测扩充到 45 项。
- 2026-08-29 v0.3.0 接入真实 API Key 跑通全量。13 个 YouTube 账号实测采集成功，7 天窗口验证到 19 条作品、长视频/Shorts/正在直播三种类型均正确识别、点赞评论播放与粉丝数全部拿到。新增 `--date yesterday/today` 关键字；多日期的目标日期统一压成「起~止」区间写法（原来会在文件名和单元格里写出一长串日期）；补上 PyCharm 运行配置四个；把误放在 `config.example.json` 的真实 key 迁到 `config.json` 并加 `.gitignore` 防止泄露。踩坑记录：英国比北京晚 7 小时，国内白天跑「今天」几乎必然 0 条，日常应抓昨天。
- 2026-08-29 v0.4.0 接入 Instagram，纯 HTTP 实现。实测 28 个账号（13 YouTube + 15 Instagram）一次跑完 27 成功，唯一失败的是设了年龄限制的账号。三条自动降级路径：web_profile_info 主路径、feed 接口兜底（配 user id 缓存，已预置三个查证过的 id）、sessionid 路径（可选）。自测扩到 83 项。

  这一版走了弯路：Instagram 最初做的是浏览器自动化（独立 Chrome 实例 + CDP），做完才验证纯 requests 匿名可行，于是把浏览器降级为可选。过程中修掉四个问题，两个是自己的 bug：CDP 通道回传 591KB 响应被截断却被归类成「未登录」；`Page.navigate` 异步返回加上旧文档 readyState 已是 complete，导致脚本跑在 about:blank 上。另外两个更值得记：Instagram 允许匿名返回 200，用「返回 200」判断登录态是错的，实际一直在匿名抓；以及年龄限制账号返回空列表会被误判成「当天无发布」——这种静默的错误数据比直接失败危险得多，现在一条作品都读不到就直接报错。

  还修了一个设计错误：单个账号缺 sessionid 原本会中止整个平台，把后面 11 个能正常抓的账号全带崩，现在改成单账号级失败。
- 2026-08-29 v0.5.0 接入 Facebook。路线变更：放弃"导出 cookie 走 mbasic"——实测 mbasic 现在对所有非浏览器 UA 强制重定向 www、cookie 注入被 RSA 校验挡住、requests/curl 全线失败。改走"接管已登录 Edge 标签页"：跑 `./start_edge_debug.sh` 启动调试模式 Edge（你的真实 Profile 保留），程序通过 CDP 接管一个已打开过 Facebook 的标签页，跳到目标主页抓页面内嵌 JSON（post_id/creation_time/reaction_count/comments.total_count/share_count/follower_count 都是权威数据）。无需导出 cookie、不用小号。配套脚本：`start_edge_debug.sh`（温和退出→调试模式启动→端口检查）。解析器兼容 JSON 字段空格，reaction_count/评论数/转发数/正文全部抽出。自测维持 93 项全过。账号间等待 5~10 秒，`--fb-min-delay/--fb-max-delay` 调整。
