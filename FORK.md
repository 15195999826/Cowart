# Cowart 二次开发说明（fork）

本仓库 fork 自 [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart)（MIT），同时给 **Codex**、**Claude Code 桌面版** 和 **ZCode** 使用。

## 开发准则：上游原版 + Codex 适配层 + Claude Code 适配层 + ZCode 适配层

- 上游文件尽量不改。新功能、宿主差异都写在 `adapters/` 下。
- 适配层做不到的，才在上游文件里打「补丁点」：改动最小，代码里用 `[fork-patch]` 注释标出，并登记到文末清单。通用的扩展接口优先提 PR 给上游。
- 各宿主真正不同的只有三处：画布怎么显示、画布怎么给 AI 发消息、用什么生图。

## 目录

```
adapters/
  package.json  适配层自己的依赖（MCP SDK、fractional-indexing、puppeteer-core），装在 adapters/node_modules
  service/      全机一个的画布服务和全机那一张画布，宿主无关（见下文「画布服务」）
    bin/        服务入口 cowart-service.mjs（桥在后台拉起；--status / --stop 手动查看、停止，--import 把旧画布的页搬进来）、
                反馈收件箱 cowart-feedback.mjs（npm run feedback：列出、查看、关掉用户反馈，见下文「反馈」）
    lib/        HTTP 服务与会话（server.mjs：请求按页路由）、画布操作（canvas-ops.mjs：上游子进程、写入排队、页面专用工具、
                视频插入、插入的图片保持原比例、差异保存、给会话建页）、差异合并（delta-merge.mjs）、谁负责哪一页（presence.mjs）、
                请求队列、写入保护、令牌、身份与代码指纹（identity.mjs）、一张画布一个服务的锁（canvas-lock.mjs）、
                画布直接生成（generation-jobs.mjs；猛兽命令行 beast-cli.mjs，写提示词 prompt-writer.mjs）、旧画布搬页（canvas-import.mjs）、
                用户反馈（feedback.mjs：send_cowart_feedback 工具和本机反馈目录）、右键「在资源管理器中显示」（reveal-file.mjs）
    test/       服务层的检查：widget 传输、反馈（feedback-test.mjs：三个宿主的桥各记一条，再用收件箱处理）、
                手动查看 / 停止（stop-test.mjs：两个联调服务各占一个测试端口、各用一张画布，给了端口的 --stop 只停那一个）
    client.mjs  给各宿主的桥用：找服务 / 后台拉起 / 按版本替换 / 保持会话连接 / 调用
  shared/       两边共用：上游子进程连接、页面注入、画布摘要、视频探测与摆放、
                图片 / 视频模型清单（image-models.mjs / video-models.mjs）、
                把面板选项变成请求文本的 prepare_cowart_generation_request（generation-requests.mjs）
                网页截图 web-capture.mjs（puppeteer-core 驱动本机 Chrome / Edge）
    web/        各端共用的画布页面脚本：service-bridge.js（差异保存、页同步、负责状态、生成与队列）、
                kit.js（卡片行为、面板骨架、发送流程）、canvas-chrome.js（菜单精简、右键「在资源管理器中显示」、样式面板按需显示）、
                AI 视频、接管后的 AI 图片、网页参考、视频播放
  claude/       Claude Code 适配（说明见 adapters/claude/README.md）
    bin/        MCP 入口 cowart-claude-mcp.mjs（每个会话一个薄桥）、画布请求监听 cowart-listen.mjs（ZCode 也用，--once 见「宿主差异」）
    lib/        薄桥 bridge.mjs：工具定义、给 Claude 的说明、请求的宿主说明，工具都转给画布服务
    web/        Claude 网页的 HTTP / SSE 传输（bridge.js），画布行为使用 shared/web/service-bridge.js
    skills/     Claude 版 skill cowart：打开画布、画布请求怎么处理、结果放哪一页、标注怎么读（install:skill 链接进 ~/.claude/skills）
    scripts/    冒烟测试、多会话测试、上游接口检查、手动联调宿主、安装 skill（install-skill.mjs）
  zcode/        ZCode 适配（说明见 adapters/zcode/README.md）：桥是 Claude 桥的姊妹版（同样的工具和转发），
    bin/ lib/   差别只在怎么打开画布（网址给用户在浏览器开）和怎么收到画布请求（--once 后台任务退出唤醒）
    skills/     ZCode 版 skill cowart
    scripts/    install.mjs（注册 MCP + 链接 skill，install:zcode）、冒烟测试（test:zcode）
  codex/        Codex 适配（说明见 adapters/codex/README.md）
    bin/        start.mjs（插件启动入口，运行已打包 bridge）、cowart-codex-mcp.mjs（源码入口）
    lib/        薄桥 bridge.mjs：模型工具转发、原生 MCP Apps widget、仅 widget 可用的服务通道
    web/        MCP Apps 传输（transport.js），负责会话的 widget 轮询领取队列请求，再通过 ui/message 通知会话
    skills/     Codex 版共享画布、打开、生图、按标注改图 skills；插件使用这里，根 skills/ 保留上游版本
  scripts/      build-artifacts.mjs（构建 / 检查适配层发布产物）、probe-cold-install.mjs（无依赖安装冷启动验证）
  generated/    已打包的宿主桥、画布服务、监听入口和发布清单；安装后不用 npm install
FORK.md         本文件
```

## 分支与同步

- 只有 `main` 一个分支，直接在上面开发、提交，不开 `feat/*` 之类的开发分支。Codex 和 Claude Code 都从这里装；Codex 从 GitHub marketplace 安装插件并**自动跟随远程 `main`**，所以没验证过的提交先留在本地。开发完成并通过本地验证后直接推送，无需再次确认；推送前先 `git fetch origin`、`git rebase origin/main`，rebase 若改变代码或产物，补做受影响的验证再推送。
- `upstream` remote 指向原作者仓库。同步：`git fetch upstream && git merge upstream/main`。`mcp/generated/` 下的发布产物有冲突时不手工合并，重新 `npm run build:artifacts` 生成。
- 同步上游后先跑 `npm --prefix adapters run check:contract`（宿主桥接口、工具名和入参是否还在，补丁点有没有丢）和 `npm --prefix adapters run test:claude`（端到端冒烟、多会话、直接生成和反馈测试），都过了再推送。
- 有补丁点以后，改了 `src/` 就要在仓库根目录 `npm ci && npm run build:artifacts` 重新生成 `mcp/generated/`，并和源码一起提交；`npm run check:artifacts` 能核对两者是否一致。
- 改动适配层后运行 `npm --prefix adapters run build:artifacts` 和 `check:artifacts`，提交 `adapters/generated/`；`npm --prefix adapters run probe:cold` 用临时目录中的发布文件验证不依赖 `node_modules`、既有服务和真实用户画布。原生 Codex widget 的视频、外链和完整交互仍需宿主验收，协议测试不能替代。
- **Git marketplace 发布也要更新外层插件版本**：只有 `adapters/package.json` 版本或 `main` 提交变了，已安装的 Codex 仍可能复用 `.codex/plugins/cache/<marketplace>/cowart/<插件版本>`。发布用 plugin-creator 的 `update_plugin_cachebuster.py` 给 `.codex-plugin/plugin.json` 加一个新的 `+codex.<时间戳>` 后缀，同时同步根 `package.json`、`package-lock.json` 和 `plugin.json` 的版本，再构建两套产物、检查并推送。此后通过 `codex plugin marketplace upgrade cowart-github` / `codex plugin add cowart@cowart-github` 更新安装时，必须核对实际缓存中的适配层版本、build 与启动入口，不能只看 marketplace 指向 `main`。
- **Windows 上构建前必须按 LF 检出**：`git config core.autocrlf false`、`git config core.eol lf`，再重新检出（`git rm -r --cached -q . && git reset -q --hard`，先把未提交的改动存好）。否则 `index.html` 和 SVG 图标会以 CRLF 被打进页面，产物跟上游对不上。

## 已核实的接缝（2026-09-11，2026-09-12 补充）

1. 页面只通过 `window.cowartMcp`（`callServerTool` / `sendFollowUpMessage` / `getHostCapabilities` / `requestDisplayMode`）和 `window.openai.toolOutput`（`projectDir` / `canvasDir`）跟宿主通信。宿主桥在服务时注入（`mcp/lib/widget-resource.mjs` 的 `injectMcpHostBridge`），`mcp/generated/cowart-widget.html` 本身不含宿主桥。→ 适配层换注入脚本即可，`src/App.jsx` 不用改。
2. `mcp/server.mjs` 是脚本（顶层建 server、stdio connect，不导出）。→ 适配层做 MCP 代理，把上游生成的 bundle 当子进程黑盒，转发、改写、追加工具。
3. `mcp/lib/canvas-storage.mjs` 导出画布读写函数，可直接 import。
4. （补丁点，见文末）`src/App.jsx` 的扩展接口 `window.__cowartExtensions`，适配层在页面加载前设置：
   - `tools: [{ id, label, iconSvg, onSelect(editor), after? }]`：工具出现在底部工具栏的 AI 工具组里（AI 视频）；`after: 'asset'` 则排在「媒体」后面（网页）。
   - `panels: ['ai-image']`：上游不再渲染自己的 AI 图片输入面板和右上角的「尺寸 / 比例」，由适配层画一个面板管全部（模型、画幅、参数）；画幅直接改框的形状并锁定比例。占位框本身、`insert_cowart_image` 替换占位框还是上游的。
   - `imageToolbar: [{ id, label, title?, iconSvg?, isFor(shape), onSelect({ editor, shape, anchor }) }]`：选中图片时，`isFor` 认领的图片在上游那一排图片工具栏末尾多出这些按钮（网页参考卡片的「打开原网页」「照这个做 HTML」），样式和「按标注修改」一样。
   - `contextMenu: [{ id, label, isFor(shapes, editor), onSelect({ editor, shapes, addToast }) }]`：右键菜单在「复制为 / 导出为 / 下载原图」那组下面多一组，`isFor` 认领当前选中的图形时出现（「在资源管理器中显示」）。
   都没设置时跟上游完全一样。
5. 共用面板先用 `prepare_cowart_generation_request` 保存上传素材、拼请求；猛兽 AI 图片 / AI 视频交画布服务直接执行，其余请求进同一队列并按页路由。Claude 通过 Monitor 收通知；Codex 由负责会话自己的 widget 领取，再用 `ui/message` 通知请求编号，模型通过 `get_cowart_request` 读取原文与状态。
6. 页面的存取调用都带上 `toolOutput` 里的 `projectDir` / `canvasDir`（`src/cowartClient.js` 的 `serverToolArgs`），上游工具也都接受 `canvasDir`。→ 一个上游子进程能服务任何画布目录；画布服务在入口把它们统一换成全机那一张（见「画布服务」的一张画布）。
7. Claude Code 桌面版给它起的 MCP 服务进程传 `CLAUDE_CODE_ENTRYPOINT=claude-desktop`、`CLAUDE_CODE_HOST_SESSION_ID`（桌面版会话 id）和 `CLAUDE_CODE_SESSION_ID`，进程工作目录是会话的项目目录（2026-09-12 读正在跑的 MCP 进程的环境核实）。命令行版和桌面版读同一份 MCP 配置，只能靠入口变量区分。→ 桥用会话 id 当会话标识，按入口决定提不提供工具。
8. 页面的同步模型（`src/App.jsx` 的 `loadRemoteCanvasSnapshot` / `saveCanvas`）：每 1.6 秒拉一次整张快照，本地有未保存改动时跳过不应用；保存是整张快照（`getStoreSnapshot()`），远端同步只增改、只删 shape / asset / binding，从不删页；上游存盘时会把保存里缺的页整个目录删掉（`mcp/lib/canvas-storage.mjs` 的 `saveStoredCanvasSnapshot`）。→ 适配层在保存请求上多带一份差异（`cowartDelta`），服务按差异合并（见「画布服务」），上游文件不用改。

## 宿主差异

| | Codex | Claude Code 桌面版 | ZCode |
|---|---|---|---|
| 画布显示 | 原生 MCP Apps widget；每个会话一个薄桥，同 Claude 共用全机画布服务、page、素材和差异保存 | 全机一个画布服务在本地提供网页，在 Browser 面板打开；每个会话只跑一个薄桥 | 同一张本地网页，ZCode 没有 Browser 面板也没有 MCP Apps widget（2026-09-14 核实：主程序包无 `ui://` 资源、无 `openai.toolOutput`），网址交给用户在任意浏览器打开；页面按打开它的会话的宿主换文案（`service.mjs` 注入 hostLabel，只改措辞不改行为） |
| 画布 → AI 消息 | 猛兽生成由共享服务直接执行；其它请求先按页路由，再由负责会话自己的 widget 轮询领取，经 MCP Apps `ui/message` 通知编号；模型 get 原文、回 running / done / failed；目标 widget 未开时留队列，可 list 补读 | AI 图片 / AI 视频由画布服务直接生成，不经过会话、不用确认；其它请求进画布服务的队列，发给负责那一页的会话：Monitor 推事件（一次最多 30 分钟，监听快到点先提醒会话用同一条命令重开）→ 对话里确认后处理 | 生成和队列同 Claude；没有 Monitor：监听命令（`cowart-listen.mjs --once`）用 Bash 后台运行，收到一批事件（首事件后约 750ms 静默）就退出，后台任务的完成通知唤醒会话，处理完再启动一次；服务在监听重连时补发（`server.mjs` 的 deliverPending），不漏 |
| 生图 | 同一 AI 图片面板与猛兽生成服务；额外提供 Codex imagegen，按页路由给负责会话用内置生图完成，结果回原 pageId | AI 图片面板按 beast-gen 模板选模型，点发送由画布服务直接调猛兽生成（面板上标着花不花钱）；上游其它按 Codex 写的生图提示词改用 beast-gen | 同 Claude（beast-gen 模板 + 直接生成）；ZCode 没装 beast-gen skill 时 `install:zcode` 会从 `~/.claude/skills` 链接一份 |
| 视频 | 共用 AI 视频工具、生成面板、insert_cowart_video 和播放控制；widget 经 MCP 工具读取本地素材，实际解码与播放需 Codex 宿主验收 | 底部工具栏「AI 视频」（占位框 + 同款输入面板，生成后替换占位框，默认本地免费的 H3）+ `insert_cowart_video`，点发送由画布服务直接调猛兽生成；视频直接用本地服务的素材地址流式播放（服务按 Range 分段给，点开就出画面，不在页面里整段读成 Blob），画布上自动静音循环播放 | 同 Claude |

ZCode 还有一处结构性差异：它不给 MCP 进程传会话标识（`ZCODE_*` / `ZAI_*` 环境变量里没有，2026-09-14 核实），所以一个桥进程就是一个画布会话（Claude 用 `CLAUDE_CODE_HOST_SESSION_ID`）；重开对话算新会话，之前负责的页要重新「接管」。`npm --prefix adapters run install:zcode` 把桥注册进 `~/.zcode/cli/config.json` 的 `mcp.servers.cowart`（stdio、绝对路径、`timeoutMs` 5 分钟）并链接 ZCode 版 skill，`test:zcode` 是它的冒烟测试。

背景（2026-09-11 调研）：

- Claude Code 桌面版的 Code 标签页不渲染 MCP Apps：实测 `render_cowart_canvas_widget` 只返回 JSON，另见 [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671)。
- Claude Code 的 channels 能让 MCP 服务往会话里推消息，但目前只有 CLI 能开（自建通道要加 `--dangerously-load-development-channels`），桌面版不能传启动参数。
- Monitor 推来的事件不算用户输入，所以画布发给会话的请求每条都要在对话里确认后才执行；AI 图片 / AI 视频因此改由画布服务直接生成、不经过会话（见「画布服务」的画布直接生成）。

## 画布服务（2026-09-12）

以前每个 Claude Code 会话各起一套（适配层 + 上游子进程 + 网页服务，空闲约 76 MB、用过画布 130–170 MB），同一画布在两个会话里开着会两边各写一份文件。现在拆成全机一个画布服务 + 每个会话一个薄桥：

- **全机一个**：端口（默认 43240，`COWART_CLAUDE_PORT` 可改）就是互斥锁。桥先带令牌 `GET /api/service` 做身份检查：是画布服务就复用；确认是别的程序（回了不是画布服务状态的 HTTP，或者根本不是 HTTP；包括还没重启的旧版每会话适配层）才往后换端口；端口被占着却没回话（连接被重置、被关掉、超时）就在这个端口上接着问，最多 10 秒，还没回话就报错、不换端口：正在退出或启动的画布服务、别的桥正在试这个端口（绑一下就放）时都是这样，2026-09-15 一次替换里就有桥把它当成别的程序，在 43241 上给同一张画布又起了一个服务。端口空着就在后台拉起一个（`detached`，环境里去掉会话的 Claude 变量和凭据，日志写 `~/.cowart-claude/service.log`），等它起来时只连不绑，免得抢了它的端口。几个桥同时拉起时，只有一个服务绑得上端口。手动停（`cowart-service.mjs --stop`）不给端口时照桥的找法找，只停用这台机器画布的那个，用别的画布的（测试服务、联调宿主）不停；给了端口（`--port` / `COWART_CLAUDE_PORT`）就只停那一个端口上的、不往后找：往后找曾把另一个会话的联调服务停掉（2026-09-15）。停就等到它的进程退出。
- **一个写入方**：服务里只有一个上游子进程、一个请求队列、一套写入排队与旧快照保护，同一画布在几个会话里开着也不会两边各写一份。
- **一张画布一个服务**（`canvas-lock.mjs`）：端口只拦得住同一个端口上的第二个服务。服务开始监听前先拿画布目录里的锁文件（`.cowart-service.lock`：pid、端口、启动时间），这张画布还归另一个服务（进程在，并且在它的端口上回话，或者 30 秒内刚起、正在退出）就不起，退出码 4（端口被占是 3）；拉起它的桥看退出码：画布的服务在同一个端口上正在退出就等它退完再拉，在别的端口就去用那个。服务退出时先在锁上记下正在退出，上游子进程关掉（最后一笔写完）才放锁；进程已经没了、或 pid 换了主（锁是早先的、它的端口上没有画布服务回话）的锁直接接过来。
- **一张画布**：画布是服务的，不属于哪个项目，全机只有一张：`~/.cowart/canvas`（`COWART_CANVAS_DIR` 可改，只管它拉起的服务；测试和联调宿主靠它另用临时画布）。Codex、Claude Code、ZCode 的所有会话和项目都在这张画布上按页分工；页面网址和工具调用里带的 `canvasDir` 一律换成它（旧网址照样能用），`projectDir` 只说明会话在哪个项目，模型的工具不再列这两个参数。Codex 插件已改走薄桥和共享服务；旧上游插件仍按 `<项目>/canvas` 整张保存，不能直接指向共享画布，否则会删掉它没见过的页目录。以前各项目画布上的页用 `cowart-service.mjs --import <画布目录> …` 搬进来：整个页目录原样拷过去（素材地址按页目录走），排在已有的页后面，已有的页跳过，原目录不动；正在跑的新版服务会先停下（会话马上会重新拉起），旧版服务不管这张画布，可以边跑边搬。
- **会话**：Claude 桥用 Claude 的会话 id，Codex 桥优先用 `CODEX_THREAD_ID`（测试可设 `COWART_SESSION_ID`，缺少宿主 id 时为桥进程生成唯一 id）；桥连着一条事件流表示在线。Browser 面板或原生 widget 属于打开它的会话，`get / reply / list` 只看路由到本会话的请求。桥断开 5 秒没回来算会话结束：它负责的页放掉，页面提示重新打开，没处理的请求留着，同一个会话恢复后自动接上并补发。
- **分页负责制**：一张画布大家共用，谁都能看、能改，权限只在页上。每页同一时间由一个会话负责、每个会话最多负责一页；只有在会话里说「打开 Cowart 画布 X」「接管 X」（`render_cowart_canvas_widget` 的 `page`，没有这页就由服务建；「接管这页」是 `shownPage`）或点画布顶部的「X来负责」按钮才换人，在画布上翻页只是看。某页的 AI 请求发给负责它的会话，不管在哪个面板里点的；没人负责的页，点它的那个面板所属的会话顺手负责。模型不带 `pageId` 的插入放进它负责的页，没负责页时放进它面板正看的页；别人负责的页拒绝写入，例外是它正在处理的请求（被接管前发出的）结果照样放回。会话名字和谁负责哪页记在 `~/.cowart-claude/session-names.json`，服务重启不丢（以前记在各项目画布上的，读进来算在这张画布上）；页被用户删掉时负责关系一起解除。
- **差异保存**：上游页面每次保存整张画布、有未保存改动时不应用远端，两个页面同时改会互相覆盖，缺的页还会被删目录。各端共用的页面桥（`adapters/shared/web/service-bridge.js`）记住每条记录磁盘上次认可的版本，保存时在请求上多带 `cowartDelta`（改动 / 新增的记录 + 删掉的 id），服务（`delta-merge.mjs`）在写锁里把差异合到磁盘副本再交上游存盘：晚同步的页面冲不掉别人的东西，没见过的页和记录删不掉；同一时刻改同一条记录，后一个盖前一个。页面与磁盘的 tldraw schema 不一致（升级过 tldraw）或页面没带差异（旧页面）时，退回上游的整张保存。删页也是差异：服务广播 `pages-deleted`，其它页面跟着撤掉（tldraw 远端同步从不删页）。
- **打开时进哪一页**：页面先去它的会话负责的页（服务渲染时写进 `heldPageId`），其次网址里的 `pageId`，再次上游存的视图。上游在第一帧动画时恢复存下的视图（每张画布只有一份，谁最后存算谁的），隐藏的 Browser 面板要等被显示才跑这一帧，会把已经打开的页拽回别的页；所以网址指定了页、而存下的视图不是这一页时，页面丢掉这份视图。会话在面板开着时进了别的页，服务给它的面板发 `goto-page`，面板跟过去。只带端口的网址（面板卡片只记了地址）重定向到最后一次打开的画布网址。
- **画布直接生成**（`generation-jobs.mjs`）：AI 图片 / AI 视频面板里模型和参数都是用户选好的，点发送就是完整的指令，所以不经过 Claude 会话、也不在对话里确认。画布服务写提示词 → 上传素材 → 提交猛兽（`beast` 命令行，`~/.beast/bin/beast.mjs` 或 `COWART_BEAST_CLI`）→ 等 → 下载 → 放进占位框的位置（要透明底的先过 `matte` 抠图），每一步显示在画布顶部的请求条上，放进画布之前都能撤销（还在排队的猛兽任务一起撤回）。本机没有 beast 命令行时，面板退回老路：请求发给会话、在对话里确认。会话里的 Claude 收到的画布请求是后台通知、不是用户在对话里说的话，按规则每条都要先问；直接生成不经过会话，所以不用问。
- **写提示词**（`prompt-writer.mjs`）：H3 要英文结构化提示词（固定字段 + 按模式的首行），Ideogram 要 JSON 标注，FLUX / Krea 英文最稳，写错格式不报错只出废片，程序替代不了。所以服务在后台跑一次 `claude -p`：不带任何工具（`--tools ""`）、不连 MCP、不留会话、不思考，系统提示是 beast-gen skill 里对应模板的写法文件，参考图随消息附上；它只回一段提示词文字，模板、参数、素材、放哪儿都是服务按面板的选择定的（「自动」的模板由它在免费模板里挑）。H3 的首行和各模式的素材编号由服务算好。`COWART_PROMPT_WRITER=off` 关掉它（原话套上模板必需的结构），`COWART_PROMPT_MODEL` 换模型（默认 haiku），`COWART_CLAUDE_CLI` 指定可执行文件。它失败时同样按原话生成，请求条上注明。
- **版本替换**：身份里有协议号、`adapters/package.json` 版本、代码指纹（服务会加载的源码和上游产物的哈希）和代码目录。桥启动时：同一个代码目录、指纹不同 → 让旧服务退出（等到它的进程没了：它最后一笔写完才放画布）、拉起新的（已打开的页面自动重连；请求队列存在画布目录的 `.cowart-requests.json`，新服务接着用、编号接着排，只有服务直接跑的生成会中断并标成失败）；不同代码目录 → 版本号大的留下，一样就沿用；旧桥遇到协议不兼容的新服务就提示重开会话。一个桥只替换一次，几个新桥同时启动时之后都用跑起来的那个；桥断线重连时不替换，免得两边来回抢。检查里用 `COWART_SERVICE_BUILD_SALT_FILE` 模拟改了代码：写了它之后启动的桥和服务都算新代码。
- **空闲退出**：没有会话连着、也没有打开的画布页面，10 分钟后退出（`COWART_SERVICE_IDLE_MS` 可改）。
- **只给桌面版**：`CLAUDE_CODE_ENTRYPOINT` 不是 `claude-desktop` 时，桥不提供工具、不拉起服务；没设这个变量（测试、联调宿主）照常；`COWART_ALLOW_CLI=1` 放开。
- Claude / ZCode 网页和 Codex 原生 MCP Apps widget 使用相同的页面功能与差异保存脚本；宿主传输分别是 HTTP / SSE 和 MCP Apps 工具调用 / 轮询。共享服务保存相同的 page 与素材，切换宿主不用转换画布。
- **在资源管理器中显示**（右键菜单）：选中一张背后有画布文件的卡片（图片、网页卡片、视频、AI HTML）右键，「复制为 / 导出为 / 下载原图」下面多这一项（Mac 上叫「在访达中显示」）。页面脚本（`canvas-chrome.js`）只把卡片的素材地址交给页面工具 `reveal_cowart_file`，画布服务（`reveal-file.mjs`）只认画布目录里的文件，在本机打开：Windows 由一段隐藏的 PowerShell 复用已经开着这个文件夹的资源管理器窗口（没有才新开）、用 Shell COM 选中文件，再借前台线程的输入把窗口提到最前（后台进程开的窗口会被 Windows 压在用户点的程序后面；服务直接起的 `explorer /select` 也没选中文件）；Mac 用 `open -R`，Linux 只开文件夹。服务就在本机，所以 Claude Code、ZCode、Codex 都能用。检查用 `COWART_REVEAL_DRY_RUN=1` 只核对路径、不开窗口。
- **Codex 媒体加载**：原生 widget 通过 MCP 分段读取视频并生成 Blob URL，资源 metadata 的 `ui.csp` / `openai/widgetCSP` 必须同时声明 `blob:` / `data:` 本地资源与 frame 权限，不能假定宿主自动放行。HTML data URL 在页面内直接解码，不经过 `fetch`。资源读取失败不再回退到原生 widget 无法访问的相对路径；视频读取或解码失败时卡片显示「视频加载失败 / 重试」。重试只使该素材的本地 resolver 失效，不修改画布记录或重载其它视频。`test:codex` 在带 CSP 的 Chromium MCP Apps 宿主夹具中验证中文 HTML、分段完整性、播放 / 暂停 / seek、同步前后 DOM / Blob 身份及读取 / 解码失败后的恢复；最终原生宿主表现仍需在 Codex 中验收。

## Codex 任务切换与恢复（2026-09-15）

- Codex 可注册已验证的本地发布副本 `~/.cowart/releases/<适配层版本>-<提交>/adapters/codex/bin/start.mjs`，避免直接加载正在开发的工作目录。副本按 `adapters/generated/release-manifest.json` 校验并复制产物/资源，再带上发布清单与启动脚本；升级时发布一个新目录，备份配置后只更新 `cowart_mcp` 的入口，并从实际安装目录验证版本与资源哈希。不能以工作目录已更新代替安装验证。

- 原生工具调用先转成标准 JSON，再经 MCP Apps 的 postMessage 发出；可选字段的 `undefined` 不能穿过宿主的 JSON 参数校验（否则为 `-32602 Invalid tool call params`）。浏览器测试在转发到 stdio 之前执行同样的严格校验，不能靠测试桥的 JSON 序列化隐藏该错误。
- 可缓存的 widget HTML 只含静态配置，当前 session、负责页和存储位置从当前 MCP 连接的 bootstrap 获取，读取和轮询必须等握手完成。打开空闲页时自动接管；其他会话已负责的页仍需明确点击接管。按钮把当前页登记与接管作为一次操作，并直接显示失败原因，成功后立即应用返回的负责状态。

- 当前 Codex 宿主在离开任务时会销毁 MCP Apps sandbox，插件不能保留被销毁的 DOM。`codex/web/transport.js` 仅为新的 render 调用领取一次自动展开，历史 inline 卡片不加载完整画布、视频或队列；已加载的画布收起时暂停视频和轮询，展开后恢复。
- 存储定位由适配层的 `getStorageTarget()` 提供，不依赖易被主题通知、历史结果或错误结果覆盖的 `openai.toolOutput`。上游客户端等到有效存储参数才结束监听；首次读取可重试，并显示真实错误和「重新连接」，未读到快照前不挂载可编辑的空画布。`src/App.jsx` 在初始视角应用后发送 `cowart:canvas-ready`，共享脚本再完成首次定位，不再用 800 毫秒定时器猜测（否则可能覆盖用户刚切到的页面）。
- 原生页的 view state（当前页、camera、视频的时间/暂停/声音/速度）按服务会话保存，与共享画布内容及其它任务分离。任务切回后用该状态恢复；明确进入另一页时清除旧视角。状态在服务内保留最多 256 个会话，服务重启或 bridge 换成新的会话标识时不承诺恢复旧播放状态。
- `codex/web/asset-cache.js` 使用有容量限制的 IndexedDB 保存完整视频传输（总计 128 MiB、单项上限 64 MiB，按 base64 长度计）。每次重建页面都向服务校验文件版本，命中只返回小型确认；文件变化、删除、分段期间换源和重试均不能使用旧数据。宿主禁用持久存储时正常退回 MCP 分段读取。
- 浏览器缓存始终是可选优化：打开、读取、写入事务均有 1 秒等待上限，失败后本页面停用缓存；视频字节到达后立即交给播放器，缓存写入在后台完成。宿主 `hostcontextchanged` 是增量通知，必须合并已有 context；只有主题/尺寸的通知不能清掉 displayMode 并把正在显示的画布误判为休眠。
- 视频 Blob URL 在素材明确失效时释放，文档销毁时由浏览器回收；不能在 `beforeunload` 提前全部撤销，因为视频解码器还可能读取分段，导航也可能被取消。媒体回归可通过 `COWART_QA_VIDEO` 指定真实视频，在隔离画布里验证完整读取、解码、播放、切页与销毁重建。
- `test:codex` 包含初始化通知乱序、任务状态隔离、文件版本变化、真实 iframe 销毁/重建后页/视角/暂停进度恢复、缓存视频零字节重传、历史卡片不自动展开及点击恢复；依然需要真实 Codex 宿主验证其销毁与重新加载行为。

## 反馈（2026-09-14）

用户在别的项目里用 Cowart（Claude Code、ZCode、Codex 都一样）觉得哪里不舒服，说「反馈：…」，那个会话的 AI 就调 `send_cowart_feedback` 记下来；我们在本仓库里按反馈改。

- **工具在画布服务上**（`service/lib/feedback.mjs`）：服务把它和上游工具一起经 `model-tools` 列给各宿主的桥，调用照常转给服务，所以三个桥的转发代码都不用动；上游起不来时它照样列出（这种时候最该反馈）。三边的桥说明和 cowart skill 各有一段写什么时候调、怎么写：用户原话放 `text`，AI 只补它知道的情况；用户只是抱怨时先问一句要不要记；只记录，不在别的项目里改 Cowart。
- **存在本机** `~/.cowart/feedback/<编号>-<标题>/`（`COWART_FEEDBACK_DIR` 可改，编号在本机递增）：`feedback.json`（记录）、`feedback.md`（同样内容给人看）、`canvas.txt`（说的那一页当时的画布摘要）、`service-log.txt`（服务日志最后 80 行）和模型附上的文件。服务自动记下：机器、宿主、会话名、项目目录、会话负责 / 面板在看的页、代码版本（build 指纹、仓库提交、未提交文件数）、本会话最近 10 条画布请求（连同这些页上服务直接生成的）。
- **在本仓库处理**：用户说「看看反馈」时，`npm --prefix adapters run feedback` 列出没处理的，`-- show <编号>` 看全文、当时的情况和文件路径；按开发准则先跟用户讨论再改，改完 `-- done <编号> --commit <提交> --note "<改了什么>"`，不改的 `-- wontfix <编号> --note "<为什么>"`，`-- reopen <编号>` 重开（编号直接写数字：PowerShell 里 `#` 后面算注释）。
- 别的机器上记的反馈留在那台机器的 `~/.cowart/feedback`，拉到这台来处理的命令还没做。

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
- Claude Code 只把 MCP 服务 `instructions` 的前 2048 个字符放进上下文（2026-09-14 实测，后面直接截断）。桥的说明（`bridge.mjs` 的 `INSTRUCTIONS`）只讲画布是什么、怎么打开、请求先问再做，冒烟测试盯着长度；请求怎么处理、结果放哪一页、标注怎么读、Codex 口吻怎么换成 beast-gen 写在 `adapters/claude/skills/cowart/SKILL.md`，`npm --prefix adapters run install:skill` 把它链接成全局 skill（Windows 用目录 junction），桥的说明和每条请求的宿主说明都让 Claude 先加载它。仓库根目录的 `skills/` 保留上游给 Codex 的版本；本 fork 插件改用 `adapters/codex/skills/`，三份原有 skill 的适配版和通用 `cowart` skill 统一按共享服务、请求原页与卡片绑定标注操作，不再要求项目目录或整张保存。

## 补丁点清单

| 文件 | 位置 | 原因 | 上游 PR |
|---|---|---|---|
| `mcp/lib/widget-resource.mjs` | `applyHostContext`（标 `[fork-patch]`） | 合并宿主增量 context，保留通知中未提供的 displayMode、widget identity 和能力字段，避免主题或尺寸更新中断视频分段读取 | 未提（通用 MCP Apps 增量 context 契约） |
| `src/cowartClient.js`、`src/App.jsx` | 有效存储参数等待、适配层 storage/activity 接口、首次加载重试、错误操作、view state 去重与隐藏页轮询（均标 `[fork-patch]`） | 初始化通知可能先给主题后给存储；一次性监听会误报文件加载失败。宿主重建 sandbox 后应从权威快照和会话状态恢复，错误可重试；隐藏时不积累读取，时间戳也不应导致无变化的视角持续写入 | 未提（通用初始化与生命周期恢复） |
| `.mcp.json`、`.codex-plugin/plugin.json` | Codex MCP 启动入口、skills 路径和插件使用文案 | 保留 MCP Apps 原生画布，入口转到 `adapters/codex/bin/start.mjs` 的已打包薄桥，skills 转到 `adapters/codex/skills/`，让 Codex 使用共享服务和分页负责规则；上游入口与根 skills 保留在仓库供同步参考 | fork 专用 |
| `src/App.jsx` | `cowartExtensionTools()` 等三个函数、`cowartUiOverrides.translations` / `tools`、`CowartToolbar`（均标 `[fork-patch]`） | 底部工具栏是写死的 React 组件，适配层没法从外面加按钮；开一个通用的工具栏扩展接口，适配层用它加「AI 视频」（AI 组）和「网页」（`after: 'asset'`，排在媒体后面）。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartPanelTakenOver()`、`CowartCanvasOverlay` 里的 AI 图片面板、`CowartAiImageStyleControls` 的提前返回（均标 `[fork-patch]`） | 上游 AI 图片面板只有「参考图 + 描述 + 发送」，没法选模型和参数，尺寸比例又放在右上角；开一个面板接管开关，适配层画一个管全部控制项的面板。未接管时行为与上游一致 | 未提 |
| `src/App.jsx` | `cowartImageToolbarItems()`、`CowartImageToolbarContent` 里的 `imageShape` 和扩展按钮、`CowartExtensionImageToolbarButton`（均标 `[fork-patch]`） | 图片工具栏也是写死的 React 组件；网页参考卡片的按钮要并进这一排（用户不要两排），从外面往 React 管的节点里塞按钮会被重渲染冲掉、也不参与工具栏的定位。开一个通用的图片工具栏扩展接口。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartContextMenuItems()`、`CowartContextMenu` / `CowartContextMenuContent`、`cowartComponents.ContextMenu` 和对应的 tldraw 导入（均标 `[fork-patch]`） | 右键菜单同样是写死的 React 组件，tldraw 的 `DefaultContextMenuContent` 各组之间没有插槽；开一个通用的右键菜单扩展接口，适配层用它在「复制为 / 导出为 / 下载原图」下面加「在资源管理器中显示」。内容照抄 tldraw 5.1 的 `DefaultContextMenuContent` 再加一组，升级 tldraw 时要对一下。未注册扩展时与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | 标注绑定：`cowartAnnotationNotices` 到 `registerAnnotationBindings()` 一组函数和新的 `collectAnnotationTargetShapeIds`（替换了原来按距离、颜色收集标注的辅助函数和常量）、`CowartAnnotationPointing` 的 `updateArrowEnd` / `complete` / `cancel`、`CowartAnnotationToolbarItem` 的提示、5 个按标注请求构建函数的 `annotationLines`、`handleMount` 里的注册和去掉的 `unsubscribeAnnotationEditingToolLock` 监听（均标 `[fork-patch]`） | 上游按「卡片周围一圈里的红 / 橙 / 黄箭头和文字」猜标注归谁：挨得近的卡片互相串、离得远的漏掉。改成画的时候必须指到卡片（图片 / 视频 / 网页卡片 / AI HTML / AI Slides，松手不在卡片上就撤掉并提示），箭头尖用 tldraw 箭头绑定钉在松手点、随画布保存；卡片移动时标注整条跟着走、删卡片一起删；拖箭头尖换卡片按松手点改绑，拖到空白处退回原位；写要求时回车完成（Shift+回车换行），完成后回到选择工具（去掉了上游写完字又切回标注工具的监听），没写字就结束的标注直接撤掉；新增「注释」工具（`CowartNoteTool`，蓝色虚线，`meta.cowartAnnotationNote`，常驻说明，请求里单列为背景）和各卡片工具栏的「清理标注」（`CowartClearAnnotationsButton`，只删标注、留注释；视频工具栏为此换成 `CowartVideoToolbar`）；只认「标注」「注释」工具的箭头，旧的未绑定标注在打开画布时按箭头尖位置补绑；请求里除截图外再逐条列出每个标注的字和指向的位置（占卡片宽高的百分比） | 未提（改的是上游行为，可以作为提案提） |
| `src/App.jsx` | `followUpSender(sourceShapeId)` 及各图片 / 标注 / HTML / Slides 请求入口、Slides 截图后的页面检查（均标 `[fork-patch]`） | 开始准备截图或上传时固定来源页，通过 `message.cowart.pageId/pageName` 发给共享桥；等待期间翻页也不会把请求发给另一页负责者。Slides 需要先建新框，截图期间翻页则明确终止，避免在新页误建框 | 未提（通用消息来源元数据） |
| `src/App.jsx` | `buildCowartAssetUrls()` 的中文语言资源补全（标 `[fork-patch]`） | 在 tldraw 校验语言包之前补齐尚缺的 `page-menu.max-pages-reached`、`page-menu.resize`，消除中文菜单缺词警告 | 未提 |
| `src/App.jsx` | `readCowartHtmlDataUrl()`、`CowartHtmlDraftEmbed` 的来源选择、`resolveCowartTldrawAssetUrl()`、本地重试 signal 和 `CowartVideoShapeUtil` / `CowartVideoRetryBoundary`（均标 `[fork-patch]`） | HTML data URL 直接解码；相同素材的并发读取共用一个 Blob URL，换源时过滤旧请求结果。MCP 读取失败返回空并通过带素材版本的 `cowart:asset-load` 事件报告，适配层呈现视频错误；`cowart:retry-asset` 使素材缓存失效，由 React 边界订阅 signal 并只重建失败播放器，缩放后也能重试，不往共享画布写重试状态；宿主给出 `window.cowartMcp.directAssetUrl` 时（Claude / ZCode 这类由画布服务直接提供的页面）视频直接用素材地址，由服务按 Range 流式提供，不整段读成 Blob | 未提（通用资源加载与恢复能力） |
