# Cowart 二次开发说明（fork）

本仓库 fork 自 [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart)（MIT），同时给 **Codex** 和 **Claude Code 桌面版**使用。

## 开发准则：上游原版 + Codex 适配层 + Claude Code 适配层

- 上游文件尽量不改。新功能、宿主差异都写在 `adapters/` 下。
- 适配层做不到的，才在上游文件里打「补丁点」：改动最小，代码里用 `[fork-patch]` 注释标出，并登记到文末清单。通用的扩展接口优先提 PR 给上游。
- 两个宿主真正不同的只有三处：画布怎么显示、画布怎么给 AI 发消息、用什么生图。

## 目录

```
adapters/
  package.json  适配层自己的依赖（MCP SDK、fractional-indexing、puppeteer-core），装在 adapters/node_modules
  service/      全机一个的画布服务和全机那一张画布，宿主无关（见下文「画布服务」）
    bin/        服务入口 cowart-service.mjs（桥在后台拉起；--status / --stop 手动查看、停止，--import 把旧画布的页搬进来）
    lib/        HTTP 服务与会话（server.mjs：请求按页路由）、画布操作（canvas-ops.mjs：上游子进程、写入排队、页面专用工具、
                视频插入、插入的图片保持原比例、差异保存、给会话建页）、差异合并（delta-merge.mjs）、谁负责哪一页（presence.mjs）、
                请求队列、写入保护、令牌、身份与代码指纹（identity.mjs）、
                画布直接生成（generation-jobs.mjs；猛兽命令行 beast-cli.mjs，写提示词 prompt-writer.mjs）、旧画布搬页（canvas-import.mjs）
    client.mjs  给各宿主的桥用：找服务 / 后台拉起 / 按版本替换 / 保持会话连接 / 调用
  shared/       两边共用：上游子进程连接、页面注入、画布摘要、视频探测与摆放、
                图片 / 视频模型清单（image-models.mjs / video-models.mjs）、
                把面板选项变成请求文本的 prepare_cowart_generation_request（generation-requests.mjs）
                网页截图 web-capture.mjs（puppeteer-core 驱动本机 Chrome / Edge）
    web/        两边都注入画布页面的脚本：kit.js（卡片行为、面板骨架、发送流程）、canvas-chrome.js（菜单精简、样式面板按需显示）、
                AI 视频、接管后的 AI 图片、网页参考、视频播放
  claude/       Claude Code 适配（说明见 adapters/claude/README.md）
    bin/        MCP 入口 cowart-claude-mcp.mjs（每个会话一个薄桥）、画布请求监听 cowart-listen.mjs
    lib/        薄桥 bridge.mjs：工具定义、给 Claude 的说明、请求的宿主说明，工具都转给画布服务
    web/        只属于 Claude 的页面脚本：宿主桥、差异保存和状态浮层（bridge.js）
    skills/     Claude 版 skill cowart：打开画布、画布请求怎么处理、结果放哪一页、标注怎么读（install:skill 链接进 ~/.claude/skills）
    scripts/    冒烟测试、多会话测试、上游接口检查、手动联调宿主、安装 skill（install-skill.mjs）
  codex/        Codex 适配（说明见 adapters/codex/README.md）
FORK.md         本文件
```

## 分支与同步

- 只有 `main` 一个分支，直接在上面开发、提交，不开 `feat/*` 之类的开发分支。Codex 和 Claude Code 都从这里装；Codex 从 GitHub marketplace 安装插件并**自动跟随远程 `main`**，所以没验证过的提交先留在本地，验证过再推送。
- `upstream` remote 指向原作者仓库。同步：`git fetch upstream && git merge upstream/main`。`mcp/generated/` 下的发布产物有冲突时不手工合并，重新 `npm run build:artifacts` 生成。
- 同步上游后先跑 `npm --prefix adapters run check:contract`（宿主桥接口、工具名和入参是否还在，补丁点有没有丢）和 `npm --prefix adapters run test:claude`（端到端冒烟测试 + 多会话测试），都过了再推送。
- 有补丁点以后，改了 `src/` 就要在仓库根目录 `npm ci && npm run build:artifacts` 重新生成 `mcp/generated/`，并和源码一起提交；`npm run check:artifacts` 能核对两者是否一致。
- **Windows 上构建前必须按 LF 检出**：`git config core.autocrlf false`、`git config core.eol lf`，再重新检出（`git rm -r --cached -q . && git reset -q --hard`，先把未提交的改动存好）。否则 `index.html` 和 SVG 图标会以 CRLF 被打进页面，产物跟上游对不上。

## 已核实的接缝（2026-09-11，2026-09-12 补充）

1. 页面只通过 `window.cowartMcp`（`callServerTool` / `sendFollowUpMessage` / `getHostCapabilities` / `requestDisplayMode`）和 `window.openai.toolOutput`（`projectDir` / `canvasDir`）跟宿主通信。宿主桥在服务时注入（`mcp/lib/widget-resource.mjs` 的 `injectMcpHostBridge`），`mcp/generated/cowart-widget.html` 本身不含宿主桥。→ 适配层换注入脚本即可，`src/App.jsx` 不用改。
2. `mcp/server.mjs` 是脚本（顶层建 server、stdio connect，不导出）。→ 适配层做 MCP 代理，把上游生成的 bundle 当子进程黑盒，转发、改写、追加工具。
3. `mcp/lib/canvas-storage.mjs` 导出画布读写函数，可直接 import。
4. （补丁点，见文末）`src/App.jsx` 的扩展接口 `window.__cowartExtensions`，适配层在页面加载前设置：
   - `tools: [{ id, label, iconSvg, onSelect(editor), after? }]`：工具出现在底部工具栏的 AI 工具组里（AI 视频）；`after: 'asset'` 则排在「媒体」后面（网页）。
   - `panels: ['ai-image']`：上游不再渲染自己的 AI 图片输入面板和右上角的「尺寸 / 比例」，由适配层画一个面板管全部（模型、画幅、参数）；画幅直接改框的形状并锁定比例。占位框本身、`insert_cowart_image` 替换占位框还是上游的。
   - `imageToolbar: [{ id, label, title?, iconSvg?, isFor(shape), onSelect({ editor, shape, anchor }) }]`：选中图片时，`isFor` 认领的图片在上游那一排图片工具栏末尾多出这些按钮（网页参考卡片的「打开原网页」「照这个做 HTML」），样式和「按标注修改」一样。
   都没设置时跟上游完全一样。
5. 共用面板的发送流程两边一样：页面先调页面专用工具 `prepare_cowart_generation_request`（适配层保存上传的素材、拼好请求文本），再用宿主的 `sendFollowUpMessage` 发出去——Claude 进请求队列，Codex 是一条 `ui/message`。
6. 页面的存取调用都带上 `toolOutput` 里的 `projectDir` / `canvasDir`（`src/cowartClient.js` 的 `serverToolArgs`），上游工具也都接受 `canvasDir`。→ 一个上游子进程能服务任何画布目录；画布服务在入口把它们统一换成全机那一张（见「画布服务」的一张画布）。
7. Claude Code 桌面版给它起的 MCP 服务进程传 `CLAUDE_CODE_ENTRYPOINT=claude-desktop`、`CLAUDE_CODE_HOST_SESSION_ID`（桌面版会话 id）和 `CLAUDE_CODE_SESSION_ID`，进程工作目录是会话的项目目录（2026-09-12 读正在跑的 MCP 进程的环境核实）。命令行版和桌面版读同一份 MCP 配置，只能靠入口变量区分。→ 桥用会话 id 当会话标识，按入口决定提不提供工具。
8. 页面的同步模型（`src/App.jsx` 的 `loadRemoteCanvasSnapshot` / `saveCanvas`）：每 1.6 秒拉一次整张快照，本地有未保存改动时跳过不应用；保存是整张快照（`getStoreSnapshot()`），远端同步只增改、只删 shape / asset / binding，从不删页；上游存盘时会把保存里缺的页整个目录删掉（`mcp/lib/canvas-storage.mjs` 的 `saveStoredCanvasSnapshot`）。→ 适配层在保存请求上多带一份差异（`cowartDelta`），服务按差异合并（见「画布服务」），上游文件不用改。

## 宿主差异

| | Codex | Claude Code 桌面版 |
|---|---|---|
| 画布显示 | MCP Apps widget（上游原生） | 全机一个画布服务在本地提供网页，在 Browser 面板打开；每个会话只跑一个薄桥 |
| 画布 → AI 消息 | MCP Apps `ui/message`（上游原生） | AI 图片 / AI 视频由画布服务直接生成，不经过会话、不用确认；其它请求进画布服务的队列，发给负责那一页的会话：持久 Monitor 推事件 → 对话里一键确认（执行 / 跳过）后处理 |
| 生图 | Codex 内置 imagegen（上游原生）；Codex 适配层开发中：接管 AI 图片面板后同样按 beast-gen 模板选模型，外加 Codex imagegen 一项 | AI 图片面板按 beast-gen 模板选模型，点发送由画布服务直接调猛兽生成（面板上标着花不花钱）；上游其它按 Codex 写的生图提示词改用 beast-gen |
| 视频 | 上游不支持 | 底部工具栏「AI 视频」（占位框 + 同款输入面板，生成后替换占位框，默认本地免费的 H3）+ `insert_cowart_video`，点发送由画布服务直接调猛兽生成；视频文件经本地服务分段加载，画布上自动静音循环播放 |

背景（2026-09-11 调研）：

- Claude Code 桌面版的 Code 标签页不渲染 MCP Apps：实测 `render_cowart_canvas_widget` 只返回 JSON，另见 [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671)。
- Claude Code 的 channels 能让 MCP 服务往会话里推消息，但目前只有 CLI 能开（自建通道要加 `--dangerously-load-development-channels`），桌面版不能传启动参数。
- Monitor 推来的事件不算用户输入，所以画布发给会话的请求每条都要在对话里确认后才执行；AI 图片 / AI 视频因此改由画布服务直接生成、不经过会话（见「画布服务」的画布直接生成）。

## 画布服务（2026-09-12）

以前每个 Claude Code 会话各起一套（适配层 + 上游子进程 + 网页服务，空闲约 76 MB、用过画布 130–170 MB），同一画布在两个会话里开着会两边各写一份文件。现在拆成全机一个画布服务 + 每个会话一个薄桥：

- **全机一个**：端口（默认 43240，`COWART_CLAUDE_PORT` 可改）就是互斥锁。桥先带令牌 `GET /api/service` 做身份检查：是画布服务就复用；是别的程序（包括还没重启的旧版每会话适配层）就往后换端口；端口空着就在后台拉起一个（`detached`，环境里去掉会话的 Claude 变量和凭据，日志写 `~/.cowart-claude/service.log`）。几个桥同时拉起时，只有一个服务绑得上端口。
- **一个写入方**：服务里只有一个上游子进程、一个请求队列、一套写入排队与旧快照保护，同一画布在几个会话里开着也不会两边各写一份。
- **一张画布**：画布是服务的，不属于哪个项目，全机只有一张：`~/.cowart/canvas`（`COWART_CANVAS_DIR` 可改，只管它拉起的服务；测试和联调宿主靠它另用临时画布）。所有会话、所有项目（Codex 桥接进来以后也是）都在这张画布上按页分工；页面网址和工具调用里带的 `canvasDir` 一律换成它（旧网址照样能用），`projectDir` 只说明会话在哪个项目，模型的工具也不再列这两个参数。上游把画布存在 `<项目>/canvas`，Codex 原生插件现在还是这样，而且不能直接指到这张画布：它整张保存，会删掉它没见过的页的目录，要等 Codex 桥接入服务。以前各项目画布上的页用 `cowart-service.mjs --import <画布目录> …` 搬进来：整个页目录原样拷过去（素材地址按页目录走），排在已有的页后面，已有的页跳过，原目录不动；正在跑的新版服务会先停下（会话马上会重新拉起），旧版服务不管这张画布，可以边跑边搬。
- **会话**：桥用 Claude 的会话 id 当会话标识，连着一条事件流表示在线；画布网址和监听命令都带会话标识，一个 Browser 面板就属于打开它的会话，`get / reply / list` 只看路由到本会话的请求。桥断开 5 秒没回来算会话结束：它负责的页放掉，页面提示重新打开，没处理的请求留着，同一个会话恢复后自动接上并补发。
- **分页负责制**：一张画布大家共用，谁都能看、能改，权限只在页上。每页同一时间由一个会话负责、每个会话最多负责一页；只有在会话里说「打开 Cowart 画布 X」「接管 X」（`render_cowart_canvas_widget` 的 `page`，没有这页就由服务建；「接管这页」是 `shownPage`）或点画布顶部的「X来负责」按钮才换人，在画布上翻页只是看。某页的 AI 请求发给负责它的会话，不管在哪个面板里点的；没人负责的页，点它的那个面板所属的会话顺手负责。模型不带 `pageId` 的插入放进它负责的页，没负责页时放进它面板正看的页；别人负责的页拒绝写入，例外是它正在处理的请求（被接管前发出的）结果照样放回。会话名字和谁负责哪页记在 `~/.cowart-claude/session-names.json`，服务重启不丢（以前记在各项目画布上的，读进来算在这张画布上）；页被用户删掉时负责关系一起解除。
- **差异保存**：上游页面每次保存整张画布、有未保存改动时不应用远端，两个页面同时改会互相覆盖，缺的页还会被删目录。页面桥（`adapters/claude/web/bridge.js`）记住每条记录磁盘上次认可的版本，保存时在请求上多带 `cowartDelta`（改动 / 新增的记录 + 删掉的 id），服务（`delta-merge.mjs`）在写锁里把差异合到磁盘副本再交上游存盘：晚同步的页面冲不掉别人的东西，没见过的页和记录删不掉；同一时刻改同一条记录，后一个盖前一个。页面与磁盘的 tldraw schema 不一致（升级过 tldraw）或页面没带差异（旧页面）时，退回上游的整张保存。删页也是差异：服务广播 `pages-deleted`，其它页面跟着撤掉（tldraw 远端同步从不删页）。
- **打开时进哪一页**：页面先去它的会话负责的页（服务渲染时写进 `heldPageId`），其次网址里的 `pageId`，再次上游存的视图。上游在第一帧动画时恢复存下的视图（每张画布只有一份，谁最后存算谁的），隐藏的 Browser 面板要等被显示才跑这一帧，会把已经打开的页拽回别的页；所以网址指定了页、而存下的视图不是这一页时，页面丢掉这份视图。会话在面板开着时进了别的页，服务给它的面板发 `goto-page`，面板跟过去。只带端口的网址（面板卡片只记了地址）重定向到最后一次打开的画布网址。
- **画布直接生成**（`generation-jobs.mjs`）：AI 图片 / AI 视频面板里模型和参数都是用户选好的，点发送就是完整的指令，所以不经过 Claude 会话、也不在对话里确认。画布服务写提示词 → 上传素材 → 提交猛兽（`beast` 命令行，`~/.beast/bin/beast.mjs` 或 `COWART_BEAST_CLI`）→ 等 → 下载 → 放进占位框的位置（要透明底的先过 `matte` 抠图），每一步显示在画布顶部的请求条上，放进画布之前都能撤销（还在排队的猛兽任务一起撤回）。本机没有 beast 命令行时，面板退回老路：请求发给会话、在对话里确认。会话里的 Claude 收到的画布请求是后台通知、不是用户在对话里说的话，按规则每条都要先问；直接生成不经过会话，所以不用问。
- **写提示词**（`prompt-writer.mjs`）：H3 要英文结构化提示词（固定字段 + 按模式的首行），Ideogram 要 JSON 标注，FLUX / Krea 英文最稳，写错格式不报错只出废片，程序替代不了。所以服务在后台跑一次 `claude -p`：不带任何工具（`--tools ""`）、不连 MCP、不留会话、不思考，系统提示是 beast-gen skill 里对应模板的写法文件，参考图随消息附上；它只回一段提示词文字，模板、参数、素材、放哪儿都是服务按面板的选择定的（「自动」的模板由它在免费模板里挑）。H3 的首行和各模式的素材编号由服务算好。`COWART_PROMPT_WRITER=off` 关掉它（原话套上模板必需的结构），`COWART_PROMPT_MODEL` 换模型（默认 haiku），`COWART_CLAUDE_CLI` 指定可执行文件。它失败时同样按原话生成，请求条上注明。
- **版本替换**：身份里有协议号、`adapters/package.json` 版本、代码指纹（服务会加载的源码和上游产物的哈希）和代码目录。桥启动时：同一个代码目录、指纹不同 → 让旧服务退出、拉起新的（已打开的页面自动重连，内存里的请求队列会丢）；不同代码目录 → 版本号大的留下，一样就沿用；旧桥遇到协议不兼容的新服务就提示重开会话。桥断线重连时不替换，免得两边来回抢。
- **空闲退出**：没有会话连着、也没有打开的画布页面，10 分钟后退出（`COWART_SERVICE_IDLE_MS` 可改）。
- **只给桌面版**：`CLAUDE_CODE_ENTRYPOINT` 不是 `claude-desktop` 时，桥不提供工具、不拉起服务；没设这个变量（测试、联调宿主）照常；`COWART_ALLOW_CLI=1` 放开。
- 网页画布目前只给 Claude 用（服务注入 Claude 的宿主桥）；Codex 桥（下一步）也连这个服务、用同一张画布，页面仍是 Codex 里的 MCP Apps widget。

## 注意

- 本仓库公开：内网地址、凭据不要提交；生图规范里只写 skill 名。
- 上游带 GA4 统计（前端 gtag + `track_cowart_analytics_event`）。画布服务不转发统计工具，并用页面安全策略挡掉统计域名。
- 上游在 Windows 上有并发写同一文件时改名失败（EPERM）的问题，Codex 在 Windows 上同样会遇到；画布服务用排队 + 重试兜住了，没改上游。
- 上游 `insert_cowart_image` 把图片拉成它定下的框的尺寸（替换的 AI 图片框、按标注修改时匹配的原图、`displayWidth` × `displayHeight`），不看原图比例；生成的图很少正好是框的比例（krea2 的 3:4 出 896×1152，框是 512×683），会被压扁或拉长。画布服务在插入后把图等比缩回那个框里：AI 图片框里居中，其它左上对齐（`canvas-model.mjs` 的 `fitImageToAsset`），没改上游。接口检查盯着上游给放进框里的图写的 `cowartGeneratedForAiImageHolder`。
- 画布页面把 tldraw 编辑器挂在 `window.__cowartEditor`（上游 `handleMount` 里），适配层的画布内功能（AI 视频、AI 图片面板、网页参考、视频控制条）靠它，接口检查会盯着。
- 页面脚本还按类名 / data-testid 藏上游的界面：网页参考卡片的图片工具栏里藏掉「替换」「裁剪」「按标注生成 Html」（`tool.image-replace` / `tool.image-crop` / `tool.cowart-annotation-html`，由「照这个做 HTML」顶替）、样式面板按需显示（`.tlui-style-panel__wrapper`）。这些名字也在接口检查里。
- 标注绑定在数据层（见补丁点清单）：「标注」「注释」工具画的箭头（`meta.cowartAnnotationArrow`，注释另有 `meta.cowartAnnotationNote`）用 tldraw 的箭头绑定（`binding`，`props.terminal: 'end'`）挂在它指着的卡片上，随画布保存。上游的按标注修改、适配层的「照这个做 HTML」、给模型看的画布摘要（「标注（修改要求）/ 注释（常驻说明）→ 卡片 id」）都按绑定取，不再按距离和颜色猜。
- 模型清单（`adapters/shared/*-models.mjs`）照 `beast gen templates` 手抄，网关模板改了要跟着改；画布直接生成按清单里的模板和参数名提交。
- 画布直接生成每次写提示词都跑一次 `claude -p`（默认 haiku，约 5 秒），用本机 Claude Code 的登录额度；产物落在猛兽上、记在 beast 配置里的用户（`~/.beast/config.json` 的 client）名下。
- Claude Code 只把 MCP 服务 `instructions` 的前 2048 个字符放进上下文（2026-09-14 实测，后面直接截断）。桥的说明（`bridge.mjs` 的 `INSTRUCTIONS`）只讲画布是什么、怎么打开、请求先问再做，冒烟测试盯着长度；请求怎么处理、结果放哪一页、标注怎么读、Codex 口吻怎么换成 beast-gen 写在 `adapters/claude/skills/cowart/SKILL.md`，`npm --prefix adapters run install:skill` 把它链接成全局 skill（Windows 用目录 junction），桥的说明和每条请求的宿主说明都让 Claude 先加载它。仓库根目录的 `skills/` 是上游给 Codex 的（`$CODEX_HOME`、内置 imagegen、整张保存），Codex 跟着 `main` 自动更新，不改。

## 补丁点清单

| 文件 | 位置 | 原因 | 上游 PR |
|---|---|---|---|
| `src/App.jsx` | `cowartExtensionTools()` 等三个函数、`cowartUiOverrides.translations` / `tools`、`CowartToolbar`（均标 `[fork-patch]`） | 底部工具栏是写死的 React 组件，适配层没法从外面加按钮；开一个通用的工具栏扩展接口，适配层用它加「AI 视频」（AI 组）和「网页」（`after: 'asset'`，排在媒体后面）。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartPanelTakenOver()`、`CowartCanvasOverlay` 里的 AI 图片面板、`CowartAiImageStyleControls` 的提前返回（均标 `[fork-patch]`） | 上游 AI 图片面板只有「参考图 + 描述 + 发送」，没法选模型和参数，尺寸比例又放在右上角；开一个面板接管开关，适配层画一个管全部控制项的面板。未接管时行为与上游一致 | 未提 |
| `src/App.jsx` | `cowartImageToolbarItems()`、`CowartImageToolbarContent` 里的 `imageShape` 和扩展按钮、`CowartExtensionImageToolbarButton`（均标 `[fork-patch]`） | 图片工具栏也是写死的 React 组件；网页参考卡片的按钮要并进这一排（用户不要两排），从外面往 React 管的节点里塞按钮会被重渲染冲掉、也不参与工具栏的定位。开一个通用的图片工具栏扩展接口。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | 标注绑定：`cowartAnnotationNotices` 到 `registerAnnotationBindings()` 一组函数和新的 `collectAnnotationTargetShapeIds`（替换了原来按距离、颜色收集标注的辅助函数和常量）、`CowartAnnotationPointing` 的 `updateArrowEnd` / `complete` / `cancel`、`CowartAnnotationToolbarItem` 的提示、5 个按标注请求构建函数的 `annotationLines`、`handleMount` 里的注册和去掉的 `unsubscribeAnnotationEditingToolLock` 监听（均标 `[fork-patch]`） | 上游按「卡片周围一圈里的红 / 橙 / 黄箭头和文字」猜标注归谁：挨得近的卡片互相串、离得远的漏掉。改成画的时候必须指到卡片（图片 / 视频 / 网页卡片 / AI HTML / AI Slides，松手不在卡片上就撤掉并提示），箭头尖用 tldraw 箭头绑定钉在松手点、随画布保存；卡片移动时标注整条跟着走、删卡片一起删；拖箭头尖换卡片按松手点改绑，拖到空白处退回原位；写要求时回车完成（Shift+回车换行），完成后回到选择工具（去掉了上游写完字又切回标注工具的监听），没写字就结束的标注直接撤掉；新增「注释」工具（`CowartNoteTool`，蓝色虚线，`meta.cowartAnnotationNote`，常驻说明，请求里单列为背景）和各卡片工具栏的「清理标注」（`CowartClearAnnotationsButton`，只删标注、留注释；视频工具栏为此换成 `CowartVideoToolbar`）；只认「标注」「注释」工具的箭头，旧的未绑定标注在打开画布时按箭头尖位置补绑；请求里除截图外再逐条列出每个标注的字和指向的位置（占卡片宽高的百分比） | 未提（改的是上游行为，可以作为提案提） |
