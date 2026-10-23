# Cowart 二次开发说明（fork）

本仓库 fork 自 [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart)（MIT），同时给 **Codex**、**Claude Code 桌面版** 和 **ZCode** 使用。

## 开发准则：上游原版 + 适配层（Claude Code、Codex 跑 cowart 命令，ZCode 是 MCP 薄桥）

- 上游文件尽量不改。新功能、宿主差异都写在 `adapters/` 下。
- 适配层做不到的，才在上游文件里打「补丁点」：改动最小，代码里用 `[fork-patch]` 注释标出，并登记到文末清单。通用的扩展接口优先提 PR 给上游。
- 各宿主真正不同的只有四处：会话怎么接进来（Claude Code、Codex 是 skill + `cowart` 命令，ZCode 是 MCP 薄桥）、画布怎么显示、画布怎么给 AI 发消息、用什么生图。Codex 到 2026-10-23 为止是原生 MCP Apps 小部件 + 每个任务一个 MCP 薄桥，之后也改走命令（见「Codex 也改走 skill + 命令」）。

## 目录

```
adapters/
  package.json  适配层自己的依赖（MCP SDK、fractional-indexing、puppeteer-core），装在 adapters/node_modules
  service/      全机一个的画布服务和全机那一张画布，宿主无关（见下文「画布服务」）
    bin/        服务入口 cowart-service.mjs（cowart 命令和 ZCode 的桥在后台拉起，Windows 上登录时由开机自启拉起；--log 自己写日志和退出码；
                --status / --stop 手动查看、停止，--import 把旧画布的页搬进来）、
                反馈收件箱 cowart-feedback.mjs（npm run feedback：列出、查看、关掉用户反馈，见下文「反馈」）
    lib/        HTTP 服务与会话（server.mjs：请求按页路由）、画布操作（canvas-ops.mjs：上游子进程、写入排队、页面专用工具、
                视频插入、插入的图片保持原比例、差异保存、给会话建页）、差异合并（delta-merge.mjs）、谁负责哪一页（presence.mjs）、
                请求队列、写入保护、令牌、身份与代码指纹（identity.mjs）、一张画布一个服务的锁（canvas-lock.mjs）、
                脱离宿主拉起服务（launch.mjs：Windows 经 WMI 的 Win32_Process.Create）、
                画布直接生成（generation-jobs.mjs；猛兽命令行 beast-cli.mjs，写提示词 prompt-writer.mjs）、旧画布搬页（canvas-import.mjs）、
                用户反馈（feedback.mjs：send_cowart_feedback 工具和本机反馈目录）、右键「在资源管理器中显示」（reveal-file.mjs）、
                右键「拷贝索引」（copy-reference.mjs：引用文本和系统剪贴板）、
                画布整理工具（canvas-edit.mjs：放文字、分组框、移动 / 改尺寸 / 删除，写前按 tldraw 校验）、
                页的文件夹（page-folders.mjs：move_cowart_pages 工具、页记录上的 meta.cowartFolder、给模型看的文件夹树；
                page-activity.mjs：每页最后改动的时间，给页菜单的「最近改过」）
    test/       服务层的检查：反馈（feedback-test.mjs：Claude、Codex 的命令会话和 ZCode 的桥各记一条，再用收件箱处理）、
                请求（requests-test.mjs：发问前的那一行和宿主说明、服务重启后队列还在、撤销时请求已不在 / 已开始）、
                页面首次读取（page-client-test.mjs：src/cowartClient.js 的补丁点）、分段读素材（media-assets-test.mjs）、
                手动查看 / 停止（stop-test.mjs：两个联调服务各占一个测试端口、各用一张画布，给了端口的 --stop 只停那一个）、
                画布整理（canvas-edit-test.mjs：三个宿主都列出整理工具，放文字 / 建框 / 移动 / 删除、别人负责的页被拒、无效记录）、
                右键菜单（context-menu-test.mjs：三个宿主都拷得到索引，截帧存进页素材、写的卡片过 tldraw 校验）、
                页的文件夹（page-folders-test.mjs：三个宿主都列出工具、能带 folder 进页，folder 命令挪页 / 挪整个文件夹、pages 按文件夹缩进、哪些改动记进页的改动时间）、
                网址（address-test.mjs：门房把 cowart.localhost 转到服务时网址不带端口，没有门房、门房口是别的程序时带服务端口，别的主机名被拒）、
                上游子进程（upstream-test.mjs：子进程死了下次调用照样拉起、同时来的调用只起一个、close 后不留子进程、闲时停）、
                常驻（resident-test.mjs：全机画布的服务不空闲退出、经 WMI 拉起不在宿主的 Job 里、--log 和退出码文件、
                开机自启装卸、桥的会话流 hello）；
                另有内存探针 memory-probe.mjs（probe:memory，不进 test:claude：空画布和真画布页文件的拷贝各起一个测试服务，
                打出服务和上游子进程刚起、读过画布、杀掉子进程 15 秒后的工作集和提交内存）
    client.mjs  给 cowart 命令（Claude Code、Codex）和 ZCode 的桥用：找服务 / 后台拉起（Windows 经 launch.mjs）/ 按版本替换 /
                保持会话连接（命令不连，见「会话」）/ 调用
  shared/       两边共用：上游子进程连接、页面注入、画布摘要、视频探测与摆放、
                图片 / 视频模型清单（image-models.mjs / video-models.mjs）、
                把面板选项变成请求文本的 prepare_cowart_generation_request（generation-requests.mjs）
                网页截图 web-capture.mjs（puppeteer-core 驱动本机 Chrome / Edge）
    web/        各端共用的画布页面脚本：service-bridge.js（差异保存、页同步、负责状态、生成与队列）、
                kit.js（卡片行为、面板骨架、发送流程）、canvas-chrome.js（菜单精简、右键「截取当前帧」「拷贝索引」「在资源管理器中显示」、样式面板按需显示、AI HTML / Slides 框放空地）、
                page-tree.js（左上角页菜单换成文件夹树 + 搜索，见「页的文件夹」）、
                AI 视频、接管后的 AI 图片、网页参考、视频播放
  claude/       Claude Code 和 Codex 的适配（说明见 adapters/claude/README.md）：没有 MCP，skill + cowart 命令
                （见「Claude Code 改走 skill + 命令」「Codex 也改走 skill + 命令」）
    bin/        cowart 命令 cowart.mjs（Claude 用 Bash、Codex 在终端里跑，一条命令一个进程；`listen` 是 Claude 后台跑的画布请求监听，
                连着 = 会话在线，Codex 不用）、ZCode 的画布请求监听 cowart-listen.mjs（Bash 后台跑 --once，见「宿主差异」）
    lib/        cowart 命令 cli.mjs（子命令、参数、给模型读的结果和请求的宿主说明，按宿主（hostFromEnv）写 Claude / Codex 两套说法，
                都转给画布服务；Codex 的提醒 hook `hook prompt`）、工具定义 tools.mjs、监听的循环 listen.mjs、
                请求那一行怎么写 request-notice.mjs（ZCode 也用）、
                安装 install.mjs（`cowart install` / `uninstall` 和 install-skill.mjs 共用：命令入口、服务入口 + 开机自启、
                装了 Codex 时它的 skill + 提醒 hook、去掉以前的 cowart_mcp）
    web/        画布网页的 HTTP / SSE 传输（bridge.js，三个宿主打开的都是这张网页），画布行为使用 shared/web/service-bridge.js
    skills/     Claude 版 skill cowart：cowart 命令怎么用、打开画布、画布请求怎么处理、结果放哪一页、标注怎么读
    codex-skill/  Codex 版 skill cowart（install 链成 Codex 的 skills/cowart；发布清单带着它）：同样的命令，内置浏览器、提醒 hook、Codex imagegen
    scripts/    冒烟测试、多会话测试、Codex 命令会话测试（codex-cli-test.mjs，test:codex-cli）、上游接口检查、手动联调宿主、
                安装（install-skill.mjs，install:claude：skill 链接进 ~/.claude/skills，再照 install.mjs 装其余的）
    beast-library/  公司猛兽「图书馆」里《cowart》这本书的安装说明 INSTALL.md：同事二选一，省心版（取件柜的运行包，不能改）/ 开发版
                （clone 本仓库、reset 到发版提交、去掉 origin，从此脱钩自己管），一台电脑只留一种；{{VERSION}} / {{COMMIT}} 由 publish-beast-library.mjs 填
  zcode/        ZCode 适配（说明见 adapters/zcode/README.md）：桥是 Claude 以前那个 MCP 薄桥的姊妹版（同样的工具和转发），
    bin/ lib/   差别只在怎么打开画布（网址给用户在浏览器开）和怎么收到画布请求（--once 后台任务退出唤醒）
    skills/     ZCode 版 skill cowart
    scripts/    install.mjs（注册 MCP + 链接 skill，install:zcode）、冒烟测试（test:zcode）
  scripts/      build-artifacts.mjs（构建 / 检查适配层发布产物）、probe-cold-install.mjs（无依赖安装冷启动验证）、
                fix-page-order.mjs（0.2.9 之前服务给第 36 页起建的页都排在同一个 index `aa`，页菜单顺序乱；
                它经画布服务按建页时间重排这些页，不带 --apply 只列方案）、
                发版用的 bump-release.mjs（升适配层版本）、make-release-copy.mjs（从提交生成本地发布副本），用法见「分支与同步」；
                publish-beast-library.mjs（给同事发版：从提交的发布副本打 cowart-<版本>.zip 投猛兽取件柜 cowart 栏，
                再把 claude/skills/cowart 加上 version、配上 beast-library/INSTALL.md 上架猛兽图书馆；--dry-run 只在临时目录里打包不上传）；
                这几个只在开发机上跑，不进发布产物
  generated/    已打包的 cowart 命令、画布服务和发布清单；安装后不用 npm install
FORK.md         本文件
```

## 分支与同步

- 只有 `main` 一个分支，直接在上面开发、提交，不开 `feat/*` 之类的开发分支。本机的 Claude Code 和 Codex 都跑这个检出（`install:claude` 装的入口指向它），同事的开发版从 GitHub clone 发版提交，所以没验证过的提交先留在本地。（2026-10-23 以前 Codex 从 GitHub marketplace 安装插件、**自动跟随远程 `main`**。）开发完成并通过本地验证后直接推送，无需再次确认；推送前先 `git fetch origin`、`git rebase origin/main`，rebase 若改变代码或产物，补做受影响的验证再推送。
- `upstream` remote 指向原作者仓库。同步：`git fetch upstream && git merge upstream/main`。`mcp/generated/` 下的发布产物有冲突时不手工合并，重新 `npm run build:artifacts` 生成。
- 同步上游后先跑 `npm --prefix adapters run check:contract`（宿主桥接口、工具名和入参是否还在，补丁点有没有丢）和 `npm --prefix adapters run test:claude`（端到端冒烟、多会话、直接生成、反馈、整理、右键菜单、页的文件夹、请求、手动停服务、网址、上游子进程、常驻、Codex 命令会话测试；Claude、Codex 会话一律跑 cowart 命令），ZCode 的桥另跑 `test:zcode`，都过了再推送。
- 有补丁点以后，改了 `src/` 就要在仓库根目录 `npm ci && npm run build:artifacts` 重新生成 `mcp/generated/`，并和源码一起提交；`npm run check:artifacts` 能核对两者是否一致。
- 改动适配层后运行 `npm --prefix adapters run build:artifacts` 和 `check:artifacts`，提交 `adapters/generated/`；`npm --prefix adapters run probe:cold` 用临时目录中的发布文件验证不依赖 `node_modules`、既有服务和真实用户画布（install 写进沙箱，另断言打包的服务入口、开机自启和 Codex 的 skill / hook）。Codex 内置浏览器里开画布、提醒 hook、Browser 面板里的页面交互仍要在宿主里手验，命令测试不能替代。
- **发版先升适配层版本**：`node adapters/scripts/bump-release.mjs [<适配层版本>]`（不给版本就把补丁号加一，`--dry-run` 只列要改的、不写）只升 `adapters/package.json`、`adapters/package-lock.json`（版本大的服务才换得掉正在跑的旧服务，见「画布服务」的版本替换）；每处版本按出现次数核对，有一处对不上就一个文件都不写；只换版本串，换行照 git 里的原样（LF），工作区换行跟 git 不一致（CRLF 检出）时拒绝。再构建、检查适配层产物并推送。根目录的版本和 `.codex-plugin/plugin.json` 不动（后者 2026-10-23 恢复成上游原样；发布产物照样带着它，上游的 MCP 子进程启动时要读）。历史：Codex 从 GitHub marketplace 装插件时（到 2026-10-23），发版还要给插件换 `+codex.<UTC 时间>` 后缀、连根目录一起构建，装好后用 verify-release.mjs 核对插件缓存、switch-codex-entry.mjs 把 Codex 的入口换到新的本地发布副本；Codex 改走 cowart 命令后这两个脚本和插件那一半都删了。
- **给同事发 Claude Code 版（猛兽图书馆）**：同事那边按版本号判断要不要升级（beast-home ADR-0038），所以只发 bump 过版本、已提交推送的提交：`node adapters/scripts/publish-beast-library.mjs`（先投取件柜的 `cowart-<版本>.zip`，再上架带 `version` 的书；同版本的包已在柜里且发布清单一样就跳过，发布清单不一样就停下要你先 bump）。只改了 `adapters/claude/beast-library/INSTALL.md` 或 skill 措辞、运行件没变：加 `--book-rev <n>`，书的版本变成 `<版本>.<n>`（图书馆要求内容改了版本号变大），运行包不重投。
- **Windows 上构建前必须按 LF 检出**：`git config core.autocrlf false`、`git config core.eol lf`，再重新检出（`git rm -r --cached -q . && git reset -q --hard`，先把未提交的改动存好）。否则 `index.html` 和 SVG 图标会以 CRLF 被打进页面，产物跟上游对不上。

## 已核实的接缝（2026-09-11，2026-09-12 补充）

1. 页面只通过 `window.cowartMcp`（`callServerTool` / `sendFollowUpMessage` / `getHostCapabilities` / `requestDisplayMode`）和 `window.openai.toolOutput`（`projectDir` / `canvasDir`）跟宿主通信。宿主桥在服务时注入（`mcp/lib/widget-resource.mjs` 的 `injectMcpHostBridge`），`mcp/generated/cowart-widget.html` 本身不含宿主桥。→ 适配层换注入脚本即可，`src/App.jsx` 不用改：画布服务给三个宿主打开的网页都注入 `claude/web/bridge.js`（HTTP / SSE）和 `shared/web/service-bridge.js`（以前的 Codex 原生小部件注入的是 MCP Apps 传输，2026-10-23 去掉）。
2. `mcp/server.mjs` 是脚本（顶层建 server、stdio connect，不导出）。→ 适配层做 MCP 代理，把上游生成的 bundle 当子进程黑盒，转发、改写、追加工具。
3. `mcp/lib/canvas-storage.mjs` 导出画布读写函数，可直接 import。
4. （补丁点，见文末）`src/App.jsx` 的扩展接口 `window.__cowartExtensions`，适配层在页面加载前设置：
   - `tools: [{ id, label, iconSvg, onSelect(editor), after? }]`：工具出现在底部工具栏的 AI 工具组里（AI 视频）；`after: 'asset'` 则排在「媒体」后面（网页）。
   - `panels: ['ai-image']`：上游不再渲染自己的 AI 图片输入面板和右上角的「尺寸 / 比例」，由适配层画一个面板管全部（模型、画幅、参数）；画幅直接改框的形状并锁定比例。占位框本身、`insert_cowart_image` 替换占位框还是上游的。
   - `imageToolbar: [{ id, label, title?, iconSvg?, isFor(shape), onSelect({ editor, shape, anchor }) }]`：选中图片时，`isFor` 认领的图片在上游那一排图片工具栏末尾多出这些按钮（网页参考卡片的「打开原网页」「照这个做 HTML」），样式和「按标注修改」一样。
   - `contextMenu: [{ id, label, isFor(shapes, editor), onSelect({ editor, shapes, addToast }) }]`：右键菜单在「复制为 / 导出为 / 下载原图」那组下面多一组，`isFor` 认领当前选中的图形时出现（「在资源管理器中显示」）。
   都没设置时跟上游完全一样。
5. 共用面板先用 `prepare_cowart_generation_request` 保存上传素材、拼请求；猛兽 AI 图片 / AI 视频交画布服务直接执行，其余请求进同一队列并按页路由。Claude / ZCode 由后台跑的监听唤醒（来了请求才退出）；Codex 没有监听、不被叫醒：用户每发一句话，提醒 hook（`cowart hook prompt`）问一次有没有请求在等这个会话，有就提醒一句，用户说「看画布」或答应时 `cowart requests` / `request <N>` 取原文、回状态（2026-10-23 以前由负责会话自己的小部件领取、经 `ui/message` 通知编号）。
6. 页面的存取调用都带上 `toolOutput` 里的 `projectDir` / `canvasDir`（`src/cowartClient.js` 的 `serverToolArgs`），上游工具也都接受 `canvasDir`。→ 一个上游子进程能服务任何画布目录；画布服务在入口把它们统一换成全机那一张（见「画布服务」的一张画布）。
7. Claude Code 桌面版给它起的 MCP 服务进程传 `CLAUDE_CODE_ENTRYPOINT=claude-desktop`、`CLAUDE_CODE_HOST_SESSION_ID`（桌面版会话 id）和 `CLAUDE_CODE_SESSION_ID`，进程工作目录是会话的项目目录（2026-09-12 读正在跑的 MCP 进程的环境核实）。命令行版和桌面版读同一份 MCP 配置，只能靠入口变量区分。公司中转版桌面版（`%LOCALAPPDATA%\Claude-3p`）传的是 `claude-desktop-3p`，同样有 Browser 面板（2026-10-21 在 company2 的会话记录里核实）。→ 桥用会话 id 当会话标识，按入口决定提不提供工具：`claude-desktop` 和 `claude-desktop-<后缀>` 都算桌面版。会话的 Bash 工具起的子进程也带着这几个变量（2026-10-22 在桌面版的 Bash 里读到 `CLAUDE_CODE_HOST_SESSION_ID=local_…`、`CLAUDE_CODE_ENTRYPOINT=claude-desktop`），所以 Claude 改用命令后照样这样认会话、认入口。
8. 页面的同步模型（`src/App.jsx` 的 `loadRemoteCanvasSnapshot` / `saveCanvas`）：每 1.6 秒拉一次整张快照（适配层让版本没变的轮询只回「没变」，见「画布服务」的轮询带版本），本地有未保存改动时跳过不应用；保存是整张快照（`getStoreSnapshot()`），远端同步只增改、只删 shape / binding，从不删页、也不删 asset 记录（见补丁点）；上游存盘时会把保存里缺的页整个目录删掉（`mcp/lib/canvas-storage.mjs` 的 `saveStoredCanvasSnapshot`）。→ 适配层在保存请求上多带一份差异（`cowartDelta`），服务按差异合并（见「画布服务」），上游文件不用改。

## 宿主差异

| | Codex | Claude Code 桌面版 | ZCode |
|---|---|---|---|
| 画布显示 | 同一张本地网页：`cowart open` 给一个可点的链接，用户在 Codex 的内置浏览器里看（Ctrl+Shift+B）；会话在终端里跑 `cowart` 命令（Codex 版 skill 讲怎么用，`install` 链进 Codex 的 skills）；页面写 Codex、AI 图片面板多一项 Codex imagegen（`service.mjs` 按会话的宿主）。2026-10-23 以前是原生 MCP Apps widget + 每个任务一个 MCP 薄桥 | 全机一个画布服务在本地提供网页，在 Browser 面板打开；会话不跑 MCP，用 Bash 跑 `cowart` 命令（全局 skill 讲怎么用） | 同一张本地网页，ZCode 没有 Browser 面板也没有 MCP Apps widget（2026-09-14 核实：主程序包无 `ui://` 资源、无 `openai.toolOutput`），网址交给用户在任意浏览器打开；页面按打开它的会话的宿主换文案（`service.mjs` 注入 hostLabel，只改措辞不改行为） |
| 画布 → AI 消息 | AI 图片 / AI 视频同 Claude（画布服务直接生成）；其它请求进同一个队列、发给负责那一页的会话，但 Codex 没有监听、请求叫不醒它：用户每发一句话，Codex 跑一次提醒 hook（`cowart hook prompt`，UserPromptSubmit，`install` 写进 Codex 的 hooks.json），它问服务这个会话有没有请求在等（只看、不算送达），有就在这句话后面附一句提醒；模型先答用户这句话，跟画布无关时在回复末尾问一句要不要做；用户说「看画布」或答应时 `cowart requests` → `request <N>` 照做，回 running / done / failed | AI 图片 / AI 视频由画布服务直接生成，不经过会话、不用确认；其它请求进画布服务的队列，发给负责那一页的会话：监听（`cowart listen`）用 Bash 后台运行，平时一直等着、不唤醒会话，真来了请求才退出，后台任务的完成通知唤醒会话 → 对话里确认后处理，处理完再启动一次；监听连着也表示会话在线（见「画布服务」的会话）；监听没在跑时请求排队，用户说「看画布」时 `cowart requests` 取走（算送达，之后的监听不再为它唤醒） | 生成、队列和监听同 Claude（监听是同一套循环，入口是 `cowart-listen.mjs --once`，不管在线）：收到一批事件（首事件后约 750ms 静默）才退出；服务在监听重连时补发（`server.mjs` 的 deliverPending），不漏 |
| 生图 | 同 Claude（AI 图片面板 + 画布直接生成）；面板多一项 Codex imagegen（`requiredHost: 'codex'`），按页路由给负责那一页的 Codex 会话用内置生图完成，`put image` 放回原页；上游按 Codex 写的其它生图提示词照样用内置生图，指定了猛兽模板的照 beast-gen | AI 图片面板按 beast-gen 模板选模型，点发送由画布服务直接调猛兽生成（面板上标着花不花钱）；上游其它按 Codex 写的生图提示词改用 beast-gen | 同 Claude（beast-gen 模板 + 直接生成）；ZCode 没装 beast-gen skill 时 `install:zcode` 会从 `~/.claude/skills` 链接一份 |
| 视频 | 同 Claude（AI 视频工具、生成面板、`put video`，服务直链流式播放） | 底部工具栏「AI 视频」（占位框 + 同款输入面板，生成后替换占位框，默认本地免费的 H3）+ `insert_cowart_video`，点发送由画布服务直接调猛兽生成；视频直接用本地服务的素材地址流式播放（服务按 Range 分段给，点开就出画面，不在页面里整段读成 Blob），画布上自动静音循环播放 | 同 Claude |

ZCode 还有一处结构性差异：它不给 MCP 进程传会话标识（`ZCODE_*` / `ZAI_*` 环境变量里没有，2026-09-14 核实），所以一个桥进程就是一个画布会话（Claude 用 `CLAUDE_CODE_HOST_SESSION_ID`）；重开对话算新会话，之前负责的页要重新「接管」。`npm --prefix adapters run install:zcode` 把桥注册进 `~/.zcode/cli/config.json` 的 `mcp.servers.cowart`（stdio、绝对路径、`timeoutMs` 5 分钟）并链接 ZCode 版 skill，`test:zcode` 是它的冒烟测试。

背景（2026-09-11 调研）：

- Claude Code 桌面版的 Code 标签页不渲染 MCP Apps：实测 `render_cowart_canvas_widget` 只返回 JSON，另见 [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671)。
- Claude Code 的 channels 能让 MCP 服务往会话里推消息，但目前只有 CLI 能开（自建通道要加 `--dangerously-load-development-channels`），桌面版不能传启动参数。
- 后台通知（Monitor 事件、后台任务的完成通知）不算用户输入，所以画布发给会话的请求每条都要在对话里确认后才执行；AI 图片 / AI 视频因此改由画布服务直接生成、不经过会话（见「画布服务」的画布直接生成）。
- （2026-10-22）Claude Code 改走 skill + 命令，见「Claude Code 改走 skill + 命令」。
- （2026-10-23）Codex 也改走 skill + 命令，画布在 Codex 的内置浏览器里看，请求靠提醒 hook；画布服务常驻（登录自启、不挂在宿主下），见「Codex 也改走 skill + 命令」和「画布服务」。
- （2026-09-15）画布请求怎么叫醒会话：会话挂着时不能有定时唤醒——每次唤醒都是一轮完整的模型调用，要把整段对话再读一遍，挂一晚上就是十几轮。调研结果：Monitor 每次最多 30 分钟，到点必定通知一次（没有常驻参数），不能拿来空等；桌面版的 `send_message` 只有会话里的模型能调，画布服务没有往会话里投递消息的入口；channels 只有命令行版能开。Bash / PowerShell 工具的后台任务（`run_in_background`）只在进程退出时通知一次，通知只带输出文件路径、命令描述和退出码（stdout、stderr 都写进那个文件，所以监听平时不往 stderr 写），实测跑了 30 分钟以上不被杀、期间零通知；TaskStop 会连 node 子进程一起结束，不留孤儿。所以监听改用 Bash 后台跑、只在来了请求时退出（`cowart-listen.mjs --once`；不带 --once 的旧 Monitor 命令只打一行新用法就退出）；没在跑时请求在服务里排队，用户说「看画布」时 `list_cowart_requests` 取走并记为已送达。

## Claude Code 改走 skill + 命令（2026-10-22）

Claude Code 这边原来也是 MCP 薄桥（`cowart-claude-mcp.mjs`），要在每个项目里 `claude mcp add cowart -s local`：只注册过四个项目，2026-10-22 在没注册的 hy-lab 里只能绕道写脚本直连桥，桥进程一退出页就丢了，插入落进了别人的页。选 MCP 是从上游继承的，Claude 这边的画布显示（Browser 面板里的本地网页）和请求监听（Bash 后台）本来就不走 MCP，MCP 只剩「工具入口 + 常驻在线」两件事。用户拍板 Claude 改走 skill + 命令，Codex（画布是 MCP Apps 小部件，离不开 MCP）和 ZCode（桥照旧）不动。（第二天 Codex 也弃了小部件、改走同一个命令，见下一节。）

- **命令**：`adapters/claude/bin/cowart.mjs`（打包成 `adapters/generated/cowart.mjs`，不依赖 `node_modules`）。第一版照工具一比一搬（`insert-image`、`state` …），hy-lab 验收时 `state` 一次倒出全机 48 页、268 KB，`open` 把所有页名挤一行，同一件事（替换 AI 框）在三种插入里参数还各叫各的；用户指出这是命令设计的问题，改成按「模型要干什么」分组：会话 `open [页名]` / `take <页名>|--shown` / `listen`，看 `pages` / `page [页名]` / `selection`，放 `put image|video|html|text`（位置参数统一：`--at x,y`、`--next-to <id> [--side …]`、`--replace <AI 框>`、`--size 宽,高`、`--page <页名>`；html 另有 `--slide-of`），整理 `group` / `edit` / `delete`，请求 `requests` / `request` / `reply`，另有 `feedback`、`call <工具名>`（照工具定义直接调，画布请求里按 Codex 写的工具调用照搬）、`tools`、`help`、`install` / `uninstall`。命令自己的参数之外，工具的其它参数照工具定义写成 `--kebab-case` 也能用（按工具的 schema 转类型，不认识的参数直接拒、列出能用的），也能整个给 `--json`（`put text`、`edit` 能给数组）/ `--json-file`；结果是给模型读的文字，里面写着新图形的 id、位置尺寸、文件（第一版每条后面还跟一行 `结构化结果：{…}`，跟第一行几乎一样，2026-10-22 试用后去掉了；`call` 照旧带，`--out json` 给整个结果）。第二轮验收（同日）又挑出几处：`help listen` 说没这个命令（不对应工具的命令查不到），help 里 `delete` 叫 `--page-id`、`open` 露出 `--title` / `--shown-page`、`edit --fit` 和 `feedback --kind` 混在英文的「其它参数」里，`put image` / `selection` 的结果和锚点不存在之类的报错是上游的英文原话。现在每个命令把该用的参数都写成自己的参数（中文说明），工具定义里用不上或别的命令管的参数（`hidden`）不列，剩下的归「少用的参数」、配中文说明（`PARAM_ABOUT`）；上游的英文结果首行和常见报错由命令改写成中文（`restate` / `localizeError`，`call` 也一样），给 Codex 的工具文字不动。第三轮验收又挑出：整理工具（`canvas-edit.mjs`）的报错带着字段路径和工具名（`updates[0].shapeId：…（id 以 get_cowart_canvas_state 列出的为准）`），提示里写 `fit: true`、`update_cowart_shapes`。命令把这些换成自己的说法（`inCommandWords`：只有一条时不带「第几条」，批量时写「第 2 条」；工具名换成 `page`、`edit --fit` 这样的命令），`call` 照旧是工具原话；`put text` 不给文字、`edit` / `delete` 不给 id 这类缺了主体的命令直接打出用法（`needs`），不再让工具用参数名回话。之后我在临时画布上当模型完整用了一遍，又改了：`put` 只认 `--next-to` / `--replace` 给的锚点，不拿用户的选区当锚点（服务的 `replaySelection` 带 `anchor: false`，给了 x / y 的插入也一样：一张 96px 的图放在 x, y，被撑成了选中那张卡片的大小）；`put image --replace` 也能换普通卡片（`insert_cowart_image` 多了 `replaceShapeId`，见画布整理）；`selection` 跟 `page` 一样一行一个，带页面坐标、分组框、本地路径；批量的 `--json` 数组里每条能用命令的参数名（`next-to`、`align`、`at`、`by` …，`itemFromFlags`）。`put html --next-to` 带 `updateExistingDraft: false`：上游把锚点当成要填的草稿，挨着一份 HTML 草稿放会把那份改写掉。`page` 只摘要一页（服务的 `canvas-state` 带 `pageId`，`get_cowart_canvas_state` 也多了这个参数，Codex 也能用），`pages` 是服务的 `pages` 操作。每条命令照桥的规矩找服务、拉起、按版本替换（`client.mjs` 的 `command: true`：不开会话事件流），调用时带 `cli: true`。
- **固定入口**：`install` 写 `~/.cowart/bin/cowart.mjs`，几行代码 import 这一份 Cowart 的 cowart 命令；skill 和所有给模型看的文字都写 `node ~/.cowart/bin/cowart.mjs …`，开发版、省心版、仓库挪了位置都一样。入口指向的不是本份时，文字里写本份的完整路径。
- **在线**：见「画布服务」的会话（命令会话）。监听是 `cowart listen`：找到服务（服务换了版本、换了端口照样找回来）、带 `presence=1` 连 `/api/agent-events`，来了请求才退出。
- **门禁、会话标识**跟桥一样，从会话 Bash 的环境变量读（见接缝 7）。
- **请求要用户明确答应**：AskUserQuestion 会回「无偏好」（用户没选），第二轮验收时会话把它当成了执行，做了用户不要的请求。监听那一行、宿主说明和两份 skill（Claude、ZCode）都写明：只有选了要做的那项或打字说要做才做；「无偏好」、没选、看不出来都不算，不做、不回状态，请求留在画布上。
- **去掉的**：Claude 的 MCP 桥（`cowart-claude-mcp.mjs`、`lib/bridge.mjs`）、发布产物里的 `cowart-claude-mcp.mjs` 和 `cowart-listen.mjs`（ZCode 跑源码里的那份）；`~/.claude.json` 里各项目的 `mcpServers.cowart` 也删掉。工具定义挪到 `lib/tools.mjs`（当时 Codex 桥接着用）。
- 检查：`test:claude` 里 Claude 会话全换成 cowart 命令（`test-kit.mjs` 的 `cliSession`：一条命令一个进程，结果按 `--out json` 读回）；多会话测试另查监听在线、送完请求在线、没送就断了结束、回来拿回页、插入不被别的页的选区带走；冒烟测试查参数解析、结构化结果和 `install`；`probe:cold` 从发布产物跑 `install`、经入口 `open` 和 `listen`。

## Codex 也改走 skill + 命令（2026-10-23）

Codex 原来走上游的路子：原生 MCP Apps 小部件显示画布，每个任务挂一个 MCP 薄桥（`adapters/codex`）。用户拍板改走 Claude 那套 skill + cowart 命令（计划和偏离记录：`docs/plan/codex-cli-resident.md`、`codex-cli-resident-deviations.md`），原因有三：

- **桥的内存**：每个 Codex 任务一个桥进程（73 MB 工作集 / 85 MB 提交），开着几个任务就是几百 MB，任务不关它就一直在。
- **被宿主连带杀**：桥在后台拉起的画布服务落在宿主的 Job 里，宿主一关 Job，服务跟着没了、日志里一句话没有；Codex 一启动 22 秒内连着拉起过三个服务（见「画布服务」的全机一个、开机自启）。
- **小部件难养**：宿主离开任务就销毁 sandbox，为它做了按会话的视图状态、IndexedDB 素材缓存、MCP 分段读、Blob 上限、宿主增量 context 合并（见「Codex 原生小部件」），页面脚本里还另有一条只给它的传输。

做法：

- **会话和宿主**（`cli.mjs` 的 `sessionIdFromEnv` / `hostFromEnv`）：Codex 给它跑的命令传 `CODEX_THREAD_ID`、不传 Claude 的变量，会话是 `codex-<thread>`（跟以前的桥一样清洗成 `[A-Za-z0-9_.-]`、最多 96 个字符）。会话按 `COWART_SESSION_ID` ‖ `CLAUDE_CODE_HOST_SESSION_ID` ‖ `CLAUDE_CODE_SESSION_ID` ‖ `codex-<CODEX_THREAD_ID>` 取；宿主按 `COWART_HOST` ‖（有 `CLAUDE_CODE_*` 变量 → claude）‖（有 `CODEX_THREAD_ID` → codex）‖ claude 认，桌面版门禁只管 claude。实测（`codex exec`，2026-10-23）：thread id = 终端里的 `CODEX_THREAD_ID` = hook 从 stdin 收到的 `session_id`，hook 进程自己的环境里没有 `CODEX_THREAD_ID`。
- **画布在内置浏览器**：`open` / `take` 的结果让模型把网址写成可点的链接发给用户，用户点开就在 Codex 的内置浏览器里看（也能 Ctrl+Shift+B 打开内置浏览器再粘网址）；不提监听。`listen` 在 Codex 里只说明 Codex 不用它，退出 2。页面（`service.mjs` 按打开它的会话的宿主）写 Codex，AI 图片面板多一项 Codex imagegen；传输照旧是 HTTP。
- **在线**（`server.mjs` 的 `#held`）：Codex 命令会话没有监听，它的画布页开着（页面事件流连着）就算在线；页关了从那一刻起再留 30 分钟（`COWART_SESSION_LEASE_MS`），之后的每条命令、每次提醒 hook 也续这 30 分钟。hook 只续已有的会话：从没跑过命令的 thread 不建会话。
- **请求靠提醒 hook**（`cowart hook prompt`，Codex 的 UserPromptSubmit hook）：用户每发一句话 Codex 跑它一次，它从 stdin 读这一轮的 JSON（环境里没有 `CODEX_THREAD_ID` 才用 stdin 的 `session_id`），只找服务、不拉起，调服务的 `hook-check`（不建会话、不算送达），有没做完的请求就打一段提醒（编号、标题、哪一页、各自的 `request <N>` 命令），Codex 把它接在用户这句话后面给模型；没有请求、服务没跑、超过 2.5 秒、出任何错都什么都不打、退出 0，用户的话不等它。提醒只是提醒：模型先答用户这句话，跟画布无关时在回复末尾问一句要不要做；用户说「看画布」或答应时 `requests` 取、`request <N>` 照做。新 hook 要用户在 Codex 里信任一次（按 hash）。
- **说法**（`cli.mjs` 只加了 codex 分支，Claude 的一字没改）：请求详情的标题是「Codex 宿主说明」；不出现确认卡片（AskUserQuestion）、Browser 面板、后台监听；用户选 Codex imagegen 的、上游提示词要内置 imagegen 的，用 Codex 内置的图片生成，指定了猛兽模板的照 beast-gen；网页复刻用内置浏览器看原网址；按标注修改带以前桥的说法（`request-notice.mjs` 的 `ANNOTATION_EDIT_NOTE`）。服务端还有几句报错是 Claude 的说法（`take --shown` 没开页、令牌无效、没有 beast 命令行时），还没改。
- **skill**：原来 4 个（`cowart`、`cowart-image-edit`、`cowart-image-gen`、`cowart-open-canvas`）合成一个 `adapters/claude/codex-skill/cowart/SKILL.md`（`name: cowart`）：以 Claude 版为底换成 Codex 的说法，并进旧 skill 里还用得上的生图、按标注改图、打开 / 接管规则，去掉 MCP、小部件和 requestKey。
- **安装**（`claude/lib/install.mjs` 的 `installCodex` / `removeCodex`，`cowart install` 和 `install:claude` 都装）：Codex 主目录（`CODEX_HOME`，没设是 `~/.codex`）不在就跳过。`skills/cowart` 链到 codex-skill（指向别处的链接改指过来；是真实目录就不动、报一行、退出 1）；以前插件的 `cowart-image-edit` / `cowart-image-gen` / `cowart-open-canvas` 只删「是链接、指向某个 `adapters/codex/skills/`」的；`hooks.json` 合并写入 UserPromptSubmit 的 `"<node>" "<命令入口>" hook prompt`（timeout 5 秒；已有的 cowart hook 原地替换、不重复，别的 hook 原样；不是 JSON 或认不出格式就不动、报一行）；`config.toml` 删掉 `[mcp_servers.cowart_mcp]` 和它的子表，其余字节不变。改哪个文件都先备份成 `<文件>.bak-cowart-<时间>`。`uninstall` 删指向本份的 skill 链接和 hook 条目（命令入口还指向别的 Cowart 时 hook 留着），不恢复 cowart_mcp。
- **去掉的**：`adapters/codex/`（桥、小部件传输和素材缓存、4 个 skill、它的检查）、发布产物里的 `cowart-codex-mcp.mjs`、`service/lib/widget-panes.mjs`、发版用的 verify-release / switch-codex-entry 两个脚本，服务里小部件的面板、视图状态、投递租约和 claim / delivered / release 页面接口；根目录 `.mcp.json`、`.codex-plugin/plugin.json` 恢复上游原样，根目录版本不动（免得重建根产物）。只给小部件用的上游补丁点、页面脚本（`service-bridge.js`、`kit.js`、`video-playback.js`）的 `transport` 分支和 `media-assets.mjs` 的分段读这一轮没撤：没有页面级自动测试兜底，改 `src/` 还要重建根产物，另开一轮（见补丁点清单的「待撤」）。
- **检查**：`claude/scripts/codex-cli-test.mjs`（`test:codex-cli`，并进 `test:claude`，端口 43391）：只设 `CODEX_THREAD_ID` 时的会话和宿主、Codex 的文字、画布页开着时在线和关页后结束、页面写 Codex 并列出 Codex imagegen、提醒 hook 的几种情况、install / uninstall 的 Codex 部分；反馈、整理、右键菜单、页的文件夹、请求测试里 Codex 那一腿是 Codex 命令会话（`COWART_HOST=codex`）。`test:codex`（小部件的浏览器夹具、Codex 冒烟测试）随小部件删了。

## 画布服务（2026-09-12）

以前每个 Claude Code 会话各起一套（适配层 + 上游子进程 + 网页服务，空闲约 76 MB、用过画布 130–170 MB），同一画布在两个会话里开着会两边各写一份文件。现在拆成全机一个画布服务 + 各会话的入口：ZCode 每个会话一个薄桥，Claude Code（2026-10-22 起）和 Codex（2026-10-23 起，之前也是薄桥）是一条条 cowart 命令。2026-10-23 起服务常驻：登录时自启、全机那张画布的服务闲着也不退出、不挂在任何宿主下（见下面的全机一个、空闲退出、开机自启）。

- **全机一个**：端口（默认 43240，`COWART_CLAUDE_PORT` 可改）就是互斥锁。桥先带令牌 `GET /api/service` 做身份检查：是画布服务就复用；确认是别的程序（回了不是画布服务状态的 HTTP，或者根本不是 HTTP；包括还没重启的旧版每会话适配层）才往后换端口；端口被占着却没回话（连接被重置、被关掉、超时）就在这个端口上接着问，最多 10 秒，还没回话就报错、不换端口：正在退出或启动的画布服务、别的桥正在试这个端口（绑一下就放）时都是这样，2026-09-15 一次替换里就有桥把它当成别的程序，在 43241 上给同一张画布又起了一个服务。端口空着就在后台拉起一个，等它起来时只连不绑，免得抢了它的端口。Windows 上经 WMI 拉起（`service/lib/launch.mjs`：`Win32_Process.Create`，不显示窗口，2026-10-23 起），不再 `detached`：Claude Code 桌面版（Codex 也是）把会话跑的命令放在一个 Job 里，libuv 的 `detached` 不脱离 Job，宿主关掉 Job 时服务跟着没了、日志里一句话也没有（10-01 到 10-23 用全机画布的 73 个服务有 54 个这样没的）；WMI 起的进程不在任何宿主的 Job 里，父进程是 WMI 自己的宿主进程。环境照旧去掉会话的 Claude 变量和凭据（WMI 按给的那份环境起，不掺别的）；服务带 `--log` 自己往 `~/.cowart-claude/service.log` 追加日志（Node 自己报的崩溃也记），退出码写进 `~/.cowart-claude/service-exit/<pid>`，拉起它的命令不是它的父进程，从这里读它为什么没起来（读后删，一天没人读的下次拉起时删）。WMI 起不了时退回 `detached` 拉起，日志记一行 `launch via WMI failed, spawned directly`；别的系统照旧 `detached`。几个桥同时拉起时，只有一个服务绑得上端口。手动停（`cowart-service.mjs --stop`）不给端口时照桥的找法找，只停用这台机器画布的那个，用别的画布的（测试服务、联调宿主）不停；给了端口（`--port` / `COWART_CLAUDE_PORT`）就只停那一个端口上的、不往后找：往后找曾把另一个会话的联调服务停掉（2026-09-15）。停就等到它的进程退出。
- **一个写入方**：服务里只有一个上游子进程、一个请求队列、一套写入排队与旧快照保护，同一画布在几个会话里开着也不会两边各写一份。
- **一张画布一个服务**（`canvas-lock.mjs`）：端口只拦得住同一个端口上的第二个服务。服务开始监听前先拿画布目录里的锁文件（`.cowart-service.lock`：pid、端口、启动时间），这张画布还归另一个服务（进程在，并且在它的端口上回话，或者 30 秒内刚起、正在退出）就不起，退出码 4（端口被占是 3）；拉起它的桥看退出码：画布的服务在同一个端口上正在退出就等它退完再拉，在别的端口就去用那个。服务退出时先在锁上记下正在退出，上游子进程关掉（最后一笔写完）才放锁；进程已经没了、或 pid 换了主（锁是早先的、它的端口上没有画布服务回话）的锁直接接过来。替换时新服务在旧服务还跑着时就把锁接过来（见下面的「版本替换」）。
- **一张画布**：画布是服务的，不属于哪个项目，全机只有一张：`~/.cowart/canvas`（`COWART_CANVAS_DIR` 可改，只管它拉起的服务；测试和联调宿主靠它另用临时画布）。Codex、Claude Code、ZCode 的所有会话和项目都在这张画布上按页分工；页面网址和工具调用里带的 `canvasDir` 一律换成它（旧网址照样能用），`projectDir` 只说明会话在哪个项目，模型的工具不再列这两个参数。上游原版的插件（根目录 `.mcp.json` 里的 `cowart_mcp`）按 `<项目>/canvas` 整张保存，不能直接指向共享画布，否则会删掉它没见过的页目录。以前各项目画布上的页用 `cowart-service.mjs --import <画布目录> …` 搬进来：整个页目录原样拷过去（素材地址按页目录走），排在已有的页后面，已有的页跳过，原目录不动；正在跑的新版服务会先停下（会话马上会重新拉起），旧版服务不管这张画布，可以边跑边搬。
- **会话**：cowart 命令在 Claude Code 里用 Claude 的会话 id（`CLAUDE_CODE_HOST_SESSION_ID`），在 Codex 里用 `codex-<CODEX_THREAD_ID>`（见「Codex 也改走 skill + 命令」；测试可设 `COWART_SESSION_ID`）；ZCode 不传会话标识，桥为自己的进程生成唯一 id。画布页面（Browser 面板、Codex 内置浏览器、ZCode 用的浏览器里的）属于打开它的会话，`request / reply / requests` 只看路由到本会话的请求。
  - 有桥的会话（ZCode；2026-10-23 以前 Codex 也是）：桥连着一条事件流表示在线；桥断开 5 秒没回来算会话结束：它负责的页放掉，页面提示重新打开，没处理的请求留着，同一个会话恢复后自动接上并补发。
  - 命令会话（Claude Code、Codex，`server.mjs` 里 `cli`）：命令一条一个进程，不连事件流，所以负责权跟连接脱钩（2026-10-22 用户拍板），看监听：带 `presence=1` 的监听（`cowart listen`）连着就在线。监听送完请求才退出（这条流上发过请求或撤销）＝会话在处理、在等用户回答，照样在线，直到它重跑监听或下一条命令，最多 12 小时（`COWART_SESSION_BUSY_MS`）；监听没送东西就断了＝会话被关、后台任务被停，2 分钟后结束（`COWART_LISTENER_GONE_MS`）；从没起过监听、只跑命令的，最后一条命令后 30 分钟结束（`COWART_SESSION_LEASE_MS`）。结束时一样放页、请求留着；之后同一个会话再跑命令或起监听就回来了，补发请求，结束时放掉的那页没被别人接走的话还给它（有桥的会话不这样）。以前它也是一个 MCP 薄桥，桥一退出页就丢了（2026-10-22 hy-lab 会话绕道写脚本直连桥，下一批插入落进了别人的页）。结束满 1 小时（`COWART_ENDED_SESSION_KEPT_MS` 可改）、又没有东西等着它（路由给它的请求没处理完、负责着页、它的画布页面或监听还连着）的会话从服务里删掉，它在服务里记的选区一起删（2026-10-05）：Codex 每个任务一个会话，以前服务跑几天 `--status` 就列着几百条已结束的（lomo 跑 8 天 200 多条）。删掉的会话再回来就按新会话连上，请求照样补发（队列按会话 id 存）；会话名字另记在 `session-names.json`，照旧留 7 天。
  - Codex 的命令会话没有监听（2026-10-23）：它的画布页开着就在线，页关了再留 30 分钟，之后的命令和提醒 hook 续这 30 分钟（见「Codex 也改走 skill + 命令」）；结束、回来、删掉照上面的规矩。
- **分页负责制**：一张画布大家共用，谁都能看、能改，权限只在页上。每页同一时间由一个会话负责、每个会话最多负责一页；只有在会话里说「打开 Cowart 画布 X」「接管 X」（`cowart open X` / `cowart take X`，ZCode 是 `render_cowart_canvas_widget` 的 `page`，没有这页就由服务建；「接管这页」是 `cowart take --shown`，ZCode 是 `shownPage`）或点画布顶部的「X来负责」按钮才换人，在画布上翻页只是看。某页的 AI 请求发给负责它的会话，不管在哪个面板里点的；没人负责的页，点它的那个面板所属的会话顺手负责。模型不带 `pageId` 的插入放进它负责的页，没负责页时放进它面板正看的页；别人负责的页拒绝写入，例外是它正在处理的请求（被接管前发出的）结果照样放回。上游的插入没给锚点时拿选中的那一个图形当锚点、放到那个图形的页上，不管 `pageId`（2026-10-22：一张给 A 页的图落进了面板正看着的页）：服务只让本会话自己的选区、而且是插入那一页上的图形当锚点，别的一律当没选中（`canvas-ops.mjs` 的 `#anchorSelection`）。给了 x / y 的插入、cowart 的 `put` 命令都不拿选区当锚点（`replaySelection` 的 `anchor`）。插在一张卡片旁边默认跟它一样大（`matchAnchor`，给按标注修改用）；锚点是分组框（不是 AI 框、Slides）时这么做会把小图撑成整组那么大（2026-10-22 验收时 96px 的图被拉到 220），服务这时默认不跟（`isGroupFrame`，图片、HTML、视频都是）。会话名字和谁负责哪页记在 `~/.cowart-claude/session-names.json`，服务重启不丢（以前记在各项目画布上的，读进来算在这张画布上）；页被用户删掉时负责关系一起解除。
- **差异保存**：上游页面每次保存整张画布、有未保存改动时不应用远端，两个页面同时改会互相覆盖，缺的页还会被删目录。各端共用的页面桥（`adapters/shared/web/service-bridge.js`）记住每条记录磁盘上次认可的版本，保存时在请求上多带 `cowartDelta`（改动 / 新增的记录 + 删掉的 id），服务（`delta-merge.mjs`）在写锁里把差异合到磁盘副本再交上游存盘：晚同步的页面冲不掉别人的东西，没见过的页和记录删不掉；同一时刻改同一条记录，后一个盖前一个。磁盘上没有的记录不算认可过，页面手里还留着它时下次保存重新送上去（撤销删图后留在页面里的 asset 就是这样写回磁盘的）。页面与磁盘的 tldraw schema 不一致（升级过 tldraw）或页面没带差异（旧页面）时，退回上游的整张保存。删页也是差异：服务广播 `pages-deleted`，其它页面跟着撤掉（tldraw 远端同步从不删页）。
- **页面看不见时**（2026-09-16）：tldraw 在动画帧上才把攒下的改动交给 store listener，页面隐藏（浏览器标签页切走、Browser 面板收起）就没有动画帧：上游的自动保存听不到改动，远端同步却靠定时器照跑，一轮（1.6 秒）就把磁盘版本盖回来，隐藏期间的改动、切走前最后一帧还没交出去的改动都会丢（实测隐藏页里新建的图形 8 秒内 0 次保存、1.6 秒后被抹掉）。页面桥（三个宿主共用）补了三处：隐藏时每 400ms 调一次 `editor.store.listen(空函数)()`，这个公开 API 先把攒下的改动交给已注册的 listener，上游的自动保存就照常跑；变成隐藏的那一刻和 `pagehide` 时立刻存一笔差异（上游听到改动后还要等 500ms，关标签页等不到；这笔保存把差异里删掉的 id 当作确认过的删图，否则删了图马上切走会被服务按「图片没确认删除」拒存）；服务页的 `isActive()` 在隐藏时为 false，上游已有的补丁点就跳过远端同步，回到可见的下一轮再同步（以前的 Codex 小部件本来就这样）。`kit.saveCanvasNow` 用的也是这笔保存。
- **放了东西面板跟过去**（2026-10-22）：会话放进一页的东西（插图、HTML、视频、文字、分组框），服务给这个会话自己的画布面板发 `reveal-shapes`（`server.mjs` 的 `#revealPut`）；面板正看着那一页时（`service-bridge.js` 的 `follow`），等这些图形同步过来，不在视野里（顶栏、底部工具栏挡住的部分不算视野）就平移过去，放不下才缩小（`kit.js` 的 `revealRect`，工具栏建的 AI 图片 / 视频 / HTML / Slides 框、网页参考、截帧用的也是它：第三轮验收时放大到 129% 点 AI HTML，比视野宽的框只被对准了中心，边、标题和旁边的卡片都在屏幕外）；15 秒内连着放的一起算；用户 5 秒内在画布上点过、滚过、按过键就不动，也不替用户换页。验收时一个新页上的第一组东西有一半压在顶栏下面，按 Shift+1 才看全。顶部状态也分开说：请求送到了、会话还在问用户时是「等你在对话里确认」，回了 running 才是「正在处理请求」（以前一送到就写「正在处理请求」，请求条上却还是「请到对话里点执行」）。工具栏的 AI HTML 框、AI Slides 框也不再建在视口正中压住已有的卡片，从那里往右滑到空地、视角跟过去（`canvas-chrome.js`，AI 图片框在 `ai-image.js` 里早就这样）。
- **打开时进哪一页**：页面先去它的会话负责的页（服务渲染时写进 `heldPageId`），其次网址里的 `pageId`，再次上游存的视图。上游在第一帧动画时恢复存下的视图（每张画布只有一份，谁最后存算谁的），隐藏的 Browser 面板要等被显示才跑这一帧，会把已经打开的页拽回别的页；所以网址指定了页、而存下的视图不是这一页时，页面丢掉这份视图。会话在面板开着时进了别的页，服务给它的面板发 `goto-page`，面板跟过去。只带端口的网址（面板卡片只记了地址）重定向到最后一次打开的画布网址。
- **网址**（2026-10-05）：画布在 `http://cowart.localhost` 打开，不带端口。浏览器（Chrome、Edge、Firefox、Browser 面板）自己把 `*.localhost` 指回本机，不用改 hosts、不用管理员权限，而且跟 localhost 一样算安全上下文（自定义的 `cowart` / `cowart.test` 走 http 就不算，剪贴板之类的功能会用不了）。不写端口时浏览器找 80，而 80 同一时间只能一个程序占，本机还有别的 `*.localhost`（看板之类）也要不带端口，所以 80 由机器上的「门房」占着：Caddy，开机自启，只听本机，按名字把请求转给各程序的端口，原样带着 Host（本机、lomo 装在 `~/.local/caddy`，加域名就在那里的 Caddyfile 加一段再 `caddy reload`，见同目录 README）。画布服务自己不碰 80（2026-10-05 第一版是服务自己占 80，看板就只能带端口了），只听它的端口（43240，全机的锁，桥、监听、锁检查都走它）；给网址前经 80 带 `Host: cowart.localhost` 问一次 `/api/service`，回话的是自己（pid 对得上）才给 `http://cowart.localhost`，没有门房、门房口是别的程序、门房转去了别的端口时给 `cowart.localhost:43240`（没装门房的机器就是这样，比如 company2）。用别的画布的服务（测试、联调宿主）不问门房，网址还是 `127.0.0.1:<端口>`；`COWART_DOMAIN_PORT` 换门房的端口，`=0` 关掉（网址回到 `127.0.0.1:<端口>`）。只认 `127.0.0.1` / `localhost` / `[::1]` / `cowart.localhost` 这几个名字、服务和门房这两个端口，DNS 重绑定的页面带的是它自己的域名，照样被拒。网址里不再带 `canvasDir`（页面只显示这张画布），旧网址照样能用；结果里另给 `localUrl`（`127.0.0.1` 的），给不认 `*.localhost` 的浏览器（Safari 之类）用，ZCode 的结果里会提到；Node 自己的 fetch 在 Windows 上也解析不了 `cowart.localhost`，所以桥和检查都走 127.0.0.1。服务常驻（2026-10-23 起登录时自启、闲着不退出），这个域名平时一直打得开；服务被手动停掉时打不开，下一条命令再拉起。换了地址，AI 图片 / AI 视频面板记在浏览器里的上次选项（localStorage 按来源分）要重选一次。
- **画布直接生成**（`generation-jobs.mjs`）：AI 图片 / AI 视频面板里模型和参数都是用户选好的，点发送就是完整的指令，所以不经过 Claude 会话、也不在对话里确认。画布服务写提示词 → 上传素材 → 提交猛兽（`beast` 命令行，`~/.beast/bin/beast.mjs` 或 `COWART_BEAST_CLI`）→ 等 → 下载 → 放进占位框的位置（要透明底的先过 `matte` 抠图），每一步显示在画布顶部的请求条上，放进画布之前都能撤销（还在排队的猛兽任务一起撤回）。本机没有 beast 命令行时，面板退回老路：请求发给会话、在对话里确认。会话里的 Claude 收到的画布请求是后台通知、不是用户在对话里说的话，按规则每条都要先问；直接生成不经过会话，所以不用问。
- **写提示词**（`prompt-writer.mjs`）：H3 要英文结构化提示词（固定字段 + 按模式的首行），Ideogram 要 JSON 标注，FLUX / Krea 英文最稳，写错格式不报错只出废片，程序替代不了。所以服务在后台跑一次 `claude -p`：不带任何工具（`--tools ""`）、不连 MCP、不留会话、不思考，系统提示是 beast-gen skill 里对应模板的写法文件，参考图随消息附上；它只回一段提示词文字，模板、参数、素材、放哪儿都是服务按面板的选择定的（「自动」的模板由它在免费模板里挑）。H3 的首行和各模式的素材编号由服务算好。`COWART_PROMPT_WRITER=off` 关掉它（原话套上模板必需的结构），`COWART_PROMPT_MODEL` 换模型（默认 haiku），`COWART_CLAUDE_CLI` 指定可执行文件。它失败时同样按原话生成，请求条上注明。
- **版本替换**：身份里有协议号、`adapters/package.json` 版本、代码指纹（服务会加载的源码和上游产物的哈希）和代码目录。命令（和桥）找到服务时：同一个代码目录、指纹不同 → 替换；不同代码目录 → 版本号大的留下（要替换），一样就沿用；旧桥遇到协议不兼容的新服务就提示重开会话。已打开的页面自动重连；请求队列存在画布目录的 `.cowart-requests.json`，新服务接着用、编号接着排，只有服务直接跑的生成会中断并标成失败。一个桥只替换一次；桥断线重连时不替换。
  - **先接锁、再停旧的**（2026-10-10）：替换不是「停掉旧服务、再拉起自己的」。桥带着旧服务的 pid 拉起自己的服务（`cowart-service.mjs --port <端口> --replace <pid>`），新服务先把画布锁接过来（锁上还是那个 pid 就直接改写成自己的；旧服务退出时看锁不是自己的，不会删它），再请旧服务退出（旧服务日志：`stopping (replaced by <版本>, pid <新服务>)`），等它的进程没了（最后一笔写完）才开始读画布、监听端口（端口被别的桥测试时占一下，就在 3 秒内重试，不放锁）。这样旧服务一退，连着它的桥都来重连、各自拉起自己代码的服务时，锁已经是新服务的：它们拉起的服务看见锁就退出（退出码 4），桥等锁上那个服务起来、连上它。锁的这条规矩从有锁那天起没变，已经装好的旧版桥（比如 Codex 的发布副本）也照着办，所以不用等它们升级。几个新桥同时替换时，只有一个新服务接得到锁，其余的退出码 4、它们的桥等那一个。旧服务 15 秒（`REPLACE_WAIT_MS`）内没退出：新服务把锁还给它（记成正在退出，按原来的 30 秒规矩处理），退出码 5，桥报「旧的画布服务没有按时退出」。
  - 以前是先停再拉，2026-10-10 本机因此来回替换：现役是 Codex 发布副本 0.2.10，每开一个 Claude 会话（仓库 0.2.11，版本大）就停掉它，但几十个 Codex 桥重连时抢先拉起 0.2.10（打包的单文件启动快，停后约 0.4 秒就拿到锁；仓库源码的服务那次 2.3 秒后才去拿锁），Claude 桥替换的机会已经用掉，只好沿用 0.2.10。新代码一直上不去，每开一个 Claude 会话所有画布页面断一下（视频请求中断）。
  - 检查：`COWART_SERVICE_BUILD_SALT_FILE` 模拟改了代码（写了它之后启动的命令、桥和服务都算新代码）；`multi-session-test` 另把发布产物拷到临时目录、版本号改成 0.0.1 当「别的代码目录」，10 个它的监听（发布产物里的 `generated/cowart.mjs listen`，各带一个会话；2026-10-23 以前是 10 个 Codex 桥）连着它的服务，再起一个本仓库的命令会话（`NODE_OPTIONS=--import` 让它的进程晚 1.5 秒起，照那天的情形）：先停再拉时每次都是 0.0.1 抢回来，现在都是本仓库的服务留下、监听都连着它。
- **空闲退出**（2026-10-23 起只给别的画布）：全机那张画布的服务（`COWART_CANVAS_DIR` 没设）闲着也不退出，一直开着；用别的画布的服务（测试、联调宿主）没有会话在线（桥连着，或命令会话还没结束）、也没有打开的画布页面，10 分钟后退出（`service.mjs` 的 `serviceIdleMs`；`COWART_SERVICE_IDLE_MS` 给了就按它，两种服务都管）。常开着不多占内存靠两处：上游子进程 3 分钟没有调用就停掉（`shared/upstream.mjs` 的 `UpstreamCowart`，`COWART_UPSTREAM_IDLE_MS` 可改，服务日志记 `upstream Cowart server stopped (idle)`），下一次调用再拉起，工具清单留着、不为它拉起；`puppeteer-core`（约 20 MB）第一次截网页时才加载（`web-capture.mjs`）。
- **开机自启**（2026-10-23，Windows）：`cowart install`（`install:claude` 也一样，都在 `claude/lib/install.mjs`）照门房的做法装三样：`~/.cowart/bin/cowart-service.mjs`（几行，同命令入口的写法，指向这一份的服务入口；指向的不在了就退出 0）、旁边的 `start-service.vbs`（存成 UTF-16，路径里有中文也对；只跑一份；不显示窗口跑 `"<node>" "<服务入口>" --port 43240 --log "<service.log>"`，退出码 0（手动停、被新版替换）/ 3（端口被占）/ 4（画布已有服务）就结束，别的 60 秒后重起；node 或服务入口不在了就安静退出，不弹脚本错误框）和启动文件夹里的 `CowartCanvas.lnk`（`wscript.exe` 跑这个 vbs）。登录时服务就起来，不挂在任何宿主下；任务管理器「启动应用」里能禁用。install 不当场起服务，会话用到时照旧拉起；`uninstall` 删这三样（服务入口指向别的 Cowart 时不动），正在跑的服务不停。`COWART_SERVICE_LINK`（服务入口，vbs 在它旁边）、`COWART_STARTUP_DIR`（启动文件夹，默认问 Windows）改位置，测试用。
- **只给桌面版**（只管 Claude 会话，Codex 会话不查）：`CLAUDE_CODE_ENTRYPOINT` 不是 `claude-desktop`、也不是 `claude-desktop-<后缀>`（中转版 `claude-desktop-3p`）时，cowart 命令只说入口不对、不拉起服务；没设这个变量（测试、联调宿主）照常；`COWART_ALLOW_CLI=1` 放开。
- 三个宿主打开的是同一张网页（画布服务提供，HTTP / SSE 传输），页面功能、差异保存脚本都一样，切换宿主不用转换画布。页面脚本里给 MCP Apps 传输留的 `transport` 分支（`service-bridge.js`、`kit.js`、`video-playback.js`）和 `media-assets.mjs` 的分段读是以前的 Codex 原生小部件用的，待撤（见补丁点清单）。
- **在资源管理器中显示**（右键菜单）：选中一张背后有画布文件的卡片（图片、网页卡片、视频、AI HTML）右键，「复制为 / 导出为 / 下载原图」下面多这一项（Mac 上叫「在访达中显示」）。页面脚本（`canvas-chrome.js`）只把卡片的素材地址交给页面工具 `reveal_cowart_file`，画布服务（`reveal-file.mjs`）只认画布目录里的文件，在本机打开：Windows 由一段隐藏的 PowerShell 复用已经开着这个文件夹的资源管理器窗口（没有才新开）、用 Shell COM 选中文件，再借前台线程的输入把窗口提到最前（后台进程开的窗口会被 Windows 压在用户点的程序后面；服务直接起的 `explorer /select` 也没选中文件）；Mac 用 `open -R`，Linux 只开文件夹。服务就在本机，所以 Claude Code、ZCode、Codex 都能用。检查用 `COWART_REVEAL_DRY_RUN=1` 只核对路径、不开窗口。
- **素材加载**（2026-10-10）：Claude / ZCode 的页面由画布服务直接提供，图片、视频都直接用服务的 `/page-assets/` 地址（页面桥的 `directAssetUrl`），HTML 草稿和 Slides 里的图片也是；服务给素材带 `ETag` / `Last-Modified`、`cache-control: no-cache`，浏览器每次用前问一句，没变回 304（切回看过的页每张图只传几百字节），带 `If-Range` 而文件改过时回整个新文件，不把新旧两份拼起来。原来图片经 `read_cowart_page_asset` 转成 base64 再在页面里解码成 Blob，一张 2 MB 的图要传约 2.7 MB 文字，Blob 一直留在页面内存里。（以前的 Codex 原生 widget 连不到服务，一直经 MCP 读；2026-10-23 起 Codex 也开这张网页。）
- **轮询带版本**（2026-10-10）：上游页面每 1.6 秒把整张画布读一遍、在页面里逐条比对（本机 8 页约 800 KB，每个开着的画布页面都这样）。服务按画布记写入次数（`canvas-ops.mjs` 的 `canvasVersion`：经上游子进程的调用除了只读和存查看状态 / 选区之类，跑完都加一，加上本服务实例的随机前缀），整张读时附上 `cowartVersion`；页面桥（三个宿主共用）下次轮询带上 `cowartSince`，没变就只回 `{ unchanged: true }`，补丁让上游这一轮什么都不做。页面只在确实持有它读到的那份时才记版本（`sync.note` 逐条比对：上游在页面有自己没存的改动时不应用拉到的快照，这时记下就会把别人的改动当成「没变」一直漏掉），比对不上就照旧整张读；每分钟至少整张读一次兜底。服务重启（前缀变了）、旧服务不认版本时都退回整张读。

## Codex 原生小部件（2026-09-15 至 2026-10-23，已去掉）

Codex 以前在对话里用原生 MCP Apps 小部件显示画布，每个任务挂一个 MCP 薄桥，桥从 `~/.cowart/releases/<版本>-<提交>` 的本地发布副本起（`make-release-copy.mjs` 生成，当时还有 `verify-release.mjs` 核对、`switch-codex-entry.mjs` 切换 `config.toml` 里的入口）。Codex 离开任务就销毁小部件的 sandbox，为此做了按会话保存的视图状态（页、视角、视频进度）、IndexedDB 素材缓存和 MCP 分段读、宿主增量 context 合并、Blob 占用上限，以及只给新打开的卡片自动展开。2026-10-23 Codex 改走 cowart 命令、在内置浏览器里看同一张网页（见「Codex 也改走 skill + 命令」），这些连同 `adapters/codex/` 一起删了；只给小部件用的上游补丁点、页面脚本的 `transport` 分支和 `media-assets.mjs` 的分段读还在，待撤（见补丁点清单）。

## 反馈（2026-09-14）

用户在别的项目里用 Cowart（Claude Code、ZCode、Codex 都一样）觉得哪里不舒服，说「反馈：…」，那个会话的 AI 就记下来（Claude Code、Codex 跑 `cowart feedback`，ZCode 调 `send_cowart_feedback`）；我们在本仓库里按反馈改。

- **工具在画布服务上**（`service/lib/feedback.mjs`）：服务把它和上游工具一起经 `model-tools` 列给 ZCode 的桥和 cowart 命令，调用照常转给服务，所以转发代码都不用动；上游起不来时它照样列出（这种时候最该反馈）。三份 cowart skill（Claude、Codex、ZCode）各有一段写什么时候记、怎么写：用户原话放 `text`，AI 只补它知道的情况；用户只是抱怨时先问一句要不要记；只记录，不在别的项目里改 Cowart。
- **存在本机** `~/.cowart/feedback/<编号>-<标题>/`（`COWART_FEEDBACK_DIR` 可改，编号在本机递增）：`feedback.json`（记录）、`feedback.md`（同样内容给人看）、`canvas.txt`（说的那一页当时的画布摘要）、`service-log.txt`（服务日志最后 80 行）和模型附上的文件。服务自动记下：机器、宿主、会话名、项目目录、会话负责 / 面板在看的页、代码版本（build 指纹、仓库提交、未提交文件数）、本会话最近 10 条画布请求（连同这些页上服务直接生成的）。
- **在本仓库处理**：用户说「看看反馈」时，`npm --prefix adapters run feedback` 列出没处理的，`-- show <编号>` 看全文、当时的情况和文件路径；按开发准则先跟用户讨论再改，改完 `-- done <编号> --commit <提交> --note "<改了什么>"`，不改的 `-- wontfix <编号> --note "<为什么>"`，`-- reopen <编号>` 重开（编号直接写数字：PowerShell 里 `#` 后面算注释）。
- 别的机器上记的反馈留在那台机器的 `~/.cowart/feedback`，拉到这台来处理的命令还没做。

## 画布整理（2026-09-17）

lomo 上一个 ZCode 会话要「给每张图编号、分组」，模型这边只有插入工具：放不了文字、建不了分组框、不能按坐标放，也挪不动、删不掉已有的卡片。它手写进页面 JSON 的文字记录是旧字段（`align` / `text`，缺 `textAlign` / `richText`），页面显示不了，下次存盘被上游的校验丢掉，而 `get_cowart_canvas_state` 读盘不校验、照样列着；改把编号画成 PNG 用 `below` 挂到图下，上游默认按锚点尺寸插图再往下避让，标签全被挪到整列底部。用户选了「基础 + 分组框」，AI 能动本会话负责的页里的一切。

- **工具在画布服务上**（`service/lib/canvas-edit.mjs`，跟 `send_cowart_feedback` 一样经 `model-tools` 列给 ZCode 的桥和 cowart 命令，转发代码不用改；cowart 命令里是 `put text`、`group`、`edit`、`delete`）：`insert_cowart_text`（编号、标题、说明：给 x / y，或挂在卡片上下左右；放下就是那里、不避让；卡片上下方的文字框跟卡片同宽，`textAlign: middle` 就居中）、`insert_cowart_frame`（tldraw 的 frame：按 `shapeIds` 的范围建框，成员原地进框）、`update_cowart_shapes`（批量移动、改尺寸、改文字 / 框标题、进出分组框、`fit` 让框贴合内容）、`delete_cowart_shapes`（删框默认留下里面的东西）。上游的 `insert_cowart_image` / `insert_cowart_html_draft` 插完由服务挪到 `x / y`，或挪到锚点的那一边（右、左、下，`above` 是服务加的；服务给它们的 schema 加了这几项），`insert_cowart_video` 在 `planVideoPlacement` 里直接支持；替换或填进框的插入不挪。挡路的东西用同一条规矩跳过（`canvas-model.mjs` 的 `placeBeside` / `stepPast`：每次跳到挡路的那个东西边上再隔 margin；上游每次挪自己的宽或高，给分组框里的卡片 `below` 放的东西落在框下面将近一张卡片高的地方，2026-10-22）。`insert_cowart_image` 的 `replaceShapeId` 换掉一张普通卡片（图、视频、HTML）：新图等比放进它的位置居中、留在同一个分组框里，卡片连同绑在上面的标注删掉，文件留在素材目录（`#replaceCard`；给的是 AI 图片框就照上游的替换）。插图时素材的显示名换回原文件名（上游的文件名只留 ASCII，`猫-水彩.png` 在画布和摘要里成了 `image.png`），盘上的文件名不动；HTML 草稿按文件名起名（上游起成 `draft-<时间>`），文件名里没有 ASCII 字母数字时照旧。`insert_cowart_frame` 建出的框盖住框外的东西（另一组、编号）时，结果里提示：是这一组的就放进来再 `fit`，不是就挪开。
- **坐标**：工具读写的 x / y 都是图形在页面上的包围盒左上角（算上父级分组框的位置和旋转），跟画布摘要一致（`shared/canvas-model.mjs` 的 `pageBounds`：箭头、线按端点，手绘按 tldraw 的 base64 增量点解码，文字按字号估算——CJK 一个字号宽、其它 0.6 个，行高 1.35；无头 Chrome 里页面实测的高度差不到 1px，自动宽度偏大一些）。
- **写入规则**跟插图一样：按页负责制（`PAGE_WRITE_TOOLS` 和 `#pageWrite`；一次调用只改一页，引用的图形分在几页上直接拒），在画布写锁里读盘、规划、保存。
- **写前校验**：服务进程里没有 tldraw，上游子进程有（它每次存盘先跑 `sanitizeCanvasSnapshotForTldraw`）。所以服务把规划好的画布（只含涉及的页，素材的 `src` 置空、不拷文件）存进一个临时画布目录，读上游回报的 `skippedRecords`：这次要写的记录有被跳过的，整批不写、报出原因。通过了才真正保存，带上 `protectImageRecords` 和删掉的图片 id 作确认，别的图片若在这次保存里消失会被上游拦下。接口检查（`check:contract`）盯着上游存盘还回报 `skippedRecords`。
- **摘要标出无效记录**：`get_cowart_canvas_state` 用同一个办法校验整张画布，页面显示不了的记录不再算作图形，单列成「⚠ … 是无效记录」；摘要还多了分组框标题、「内含 N 个图形」，位置改成页面上的包围盒。
- **跟页面的规矩一致**：页面里的标注跟随和级联删除（`registerAnnotationBindings`）只处理用户自己的改动，服务的改动经远端同步进页面不会触发，所以服务自己做：卡片（或装着它的框）在页面上移动了，绑在它上面的页面级标注 / 注释箭头整条平移；删卡片时它的标注和绑定一起删。新建的框放在页面（或成员共同所在的框）最底层，页面级的标注箭头照样盖在上面；删框时里面的东西按原来的层次留在原位；挂在框里卡片旁的文字超出框时框自动变大；移动或放进框后超出框的内容，结果里提示 `fit`。新记录和删掉的图形交给写入保护（`trackInsertedRecords` / `trackRemovedShape`），旧页面的整张保存冲不掉、带不回。
- **撤不回**：服务的改动经远端同步进页面，不进 tldraw 的撤销栈，页面上 Ctrl+Z 撤不回。删掉的图片 / 视频文件还在页素材目录，结果列出路径，要放回用插入工具。三份 skill 都写了只删用户要删的、删之前说清楚。
- **拖分组框时标注跟着走**（页面，补丁点）：页面原来只在卡片本身移动时让标注跟随，拖框时框里卡片的标注箭头留在原地被拉长；现在装着东西的框（编组也一样）移动时，里面卡片的标注一起平移。删框时 tldraw 的 `deleted-shapes` 本来就带着子图形，级联删除不用改。
- 检查：`service/test/canvas-edit-test.mjs`（并进 `test:claude`，单跑 `test:edit`，端口 43385）：三个宿主（Claude、Codex 的命令会话，ZCode 的桥）都列出工具；Claude 会话实际放图、放文字、建框、移动、改尺寸、进出框、删除；ZCode 会话动别人负责的页被拒；Codex 会话建框；手写的旧字段文字记录在摘要里标出，移动它被拒、盘上不变。

## 右键菜单：截帧与索引（2026-09-18）

视频在画布上循环播着，看到哪一帧想留下来只能重新生成；要跟 AI 说「这张图」又只能靠描述。两项都加在右键菜单里（`__cowartExtensions.contextMenu`，和「在资源管理器中显示」同一组，页面脚本三个宿主共用）。

- **截取当前帧**（`shared/web/canvas-chrome.js`）：只在恰好选中一个视频时出现。**菜单一打开就抓帧**（画布上的视频一直循环播，等用户读完菜单再抓就不是他看到的那一帧了：实测右键时 2.1s、点下去时 4.6s，留下的是 2.1s），把 `<video>` 当前画面按视频原分辨率画进离屏 canvas；点下去才落盘，PNG 经上游的 `save_cowart_reference_image` 存进这一页的素材目录，再由**页面**自己建 asset 和 image 卡片，放到视频右边的空位（`kit.freePosition` 往右滑过挡路的卡片），和视频卡片同宽、按帧的比例定高。页面建卡片而不是交给服务插入，所以 Ctrl+Z 撤得回。素材名是「<视频名> 1.9s.png」，meta 记 `cowartVideoFrame`、来自哪个视频、第几秒。浏览器把视频当成跨源时画布被污染、`toDataURL` 抛错，这时提示截不下来，不存黑图。
- **拷贝索引**（`service/lib/copy-reference.mjs`）：选中任何图形都能用。画布上每个图形本来就有 tldraw 的 id（`shape:…`），画布摘要给模型看的就是它，所以不另起编号。页面只报 shape id（报之前先存一笔，刚画的东西才在盘上），服务按摘要的口径拼出引用——页名、shape id、这是什么（网页卡片、视频截帧、标注、注释、各种占位框按 meta 认，其余按 tldraw 类型给中文名）、素材名和**素材在本机的路径**——再写进系统剪贴板（Windows 用 PowerShell 5.1 的 `Set-Clipboard`，文本经环境变量传；Mac `pbcopy`；Linux 先 `wl-copy` 后 `xclip`）。剪贴板由服务写而不是页面写（当初是为以前的 Codex 小部件：它在 iframe 里不一定拿得到剪贴板权限）。粘给 AI 之后，路径可以直接 Read 看图，shape id 可以直接调整理工具。单选一行，多选时首行写页名和个数、之后一行一个。三份 skill 都写了用户粘来这段时怎么用。`COWART_CLIPBOARD_DRY_RUN=1` 只拼文本、不动剪贴板（检查用）。
- **顺带修掉的 tldraw bug**：菜单开着的时候直接拖卡片，之后右键再也打不开菜单（要刷新页面）。tldraw 5.1 把右键菜单渲染成 `{isOpen && <Portal>}`，isOpen 读它自己的 `editor.menus`：菜单从那里被拿掉，radix 的内容就地卸载，radix 并不知道自己关了。它的 Root 是非受控的、只在值变化时通知，于是它一直以为 open，之后每次右键都把 open 设成 true（值没变），tldraw 再也收不到 `onOpenChange(true)`。左键按下正是这条路：`MenuClickCapture` 在 `flushSync` 里调 `clearOpenMenus()`，抢在这一下传到 document、radix 的 `DismissableLayer` 看见外部点击之前。tldraw 自己的右键路径特意绕开了它（源码注释：不调 clearOpenMenus，让 radix 的外部点击检测去关，两边状态才对得上），所以页面脚本让 `clearOpenMenus` 也把右键菜单留给 radix：同一下按键里 radix 自己关掉它，跟 tldraw 同步，拖动照旧。接口检查盯着 `clearOpenMenus` / `deleteOpenMenu` / `context menu` 这几个名字还在上游产物里。
- 检查：`service/test/context-menu-test.mjs`（并进 `test:claude`，单跑 `test:menu`，端口 43386）：Claude、ZCode、Codex 会话的页面（都是 HTTP）拷到同一段引用；截帧存进页素材，页面写的那条 image 记录过得了 tldraw 校验（`skippedRecords` 为空）；多选按行列出；画布上没有的图形被拒。浏览器里抓帧、放卡片、Ctrl+Z 撤回在 Browser 面板手验（2026-09-18，dev-host + 临时画布）。

## 页的文件夹（2026-10-22）

全机一张画布，所有会话、所有项目的页都在上面（10-22 本机 50 页），tldraw 的页菜单是一长列，找页难。用户要「页分组 / 多级文件夹」，选了：页菜单换成文件夹树（不另开侧栏），**页进哪个文件夹只由 AI 管**，用户在菜单里不拖、不建文件夹。

- **数据**：文件夹记在页记录自己身上，`meta.cowartFolder` 是一串文件夹名用 `/` 连起来（`数码宝贝/参考`），没有就在顶层。上游存盘按页原样存页记录（含 meta），远端同步会把页记录的改动交给开着的页面，所以三个宿主都看得到、不用别的存储。没有单独的文件夹记录：有页在里面文件夹就在，不用建也不用删。
- **页菜单**（`shared/web/page-tree.js`，三个宿主共用）：点左上角页名的按钮不再打开 tldraw 的列表（Radix 只在 click 上开它，脚本在 window 的捕获阶段把这次 click 截下），在原位置弹出自己的菜单：顶上搜索（页名和文件夹路径都算，上下键 + 回车跳页）、文件夹可折叠（同一层文件夹在前、页在后，都按画布上的页序；展开状态记在浏览器里）、当前页高亮并自动展开所在文件夹、页上标出谁负责（`service-bridge.js` 把负责关系发 `cowart:page-holders`）、底部「新建页面」。点一页只换页、菜单不收起（用户要能一页页翻着找，10-22 第一版点了就收起被嫌），点画布、按 Esc 或再点按钮才收起；上下键 + 回车同样。tldraw 列表原有的重命名 / 复制 / 删除放在每页的「⋮」和右键里（复制的页留在原文件夹，叫「… 副本」）；拖动排序没了。菜单挂在 body 上、层级在画布浮层（AI 面板、视频控制条）之上：画布在一个 fixed 的 <main> 里，自成层叠上下文，放在 tldraw 容器里出不来，tldraw 的主题变量在打开时从容器抄过来。菜单开着时页名、文件夹被会话改了，几百毫秒内重画，当前页挪了文件夹就展开新位置。用 tldraw 的 CSS 变量，跟着亮暗主题。
- **排序**（用户选的三种，选择记在浏览器里）：建页先后（默认，画布上的页序，跟建页先后一致）、按名称（还是树；英文、数字开头的在前按字母，中文的在后按拼音，数字按大小：参考 2 在参考 10 前面）、最近改过（铺成一列，页名下一行是文件夹，右边「3 分钟前」；没有记录的老页排在分隔线下面，按页序）。上游每次保存把所有页文件都重写一遍，文件时间看不出哪页改过，所以服务自己记（`service/lib/page-activity.mjs`，画布目录的 `.cowart-page-activity.json`，10-22 起才有）：页面保存的差异里真变了的图形、绑定，页改名、新建（`delta-merge.mjs` 的 `changedPages`），以及模型的插入、整理、插视频、建页（`canvas-ops.mjs` 发 `pages-changed`）；挪文件夹不算。时间放在 `page-state` 里（`changedAt`），一页正被改时每次自动保存都会更新，所以最多 3 秒广播一次。
- **模型这边**：服务的 `move_cowart_pages`（跟整理工具一样经 `model-tools` 列给 ZCode 的桥和 cowart 命令）：`pages` + `folder` 把页放进文件夹，`fromFolder` + `folder` 把整个文件夹（连子文件夹）挪过去 / 改名，`folder` 是 `/` 为顶层。文件夹不算页的内容，所以别人负责的页也能挪（不经 `#pageWrite`）。`render_cowart_canvas_widget` 多了 `folder`：进的页（新建的、已有的）放进那个文件夹。新建的页落在顶层而画布上有文件夹时，打开结果列出现有文件夹，让模型在明显同一个项目 / 主题时放进去并告诉用户。画布摘要的页标题带「在文件夹「…」里」。
- **cowart 命令**（Claude Code、Codex）：新的「页」组：`pages [文件夹]`（按文件夹缩进；给了文件夹只列那一个，50 页时不用整棵读）、`folder <文件夹> <页名>…` / `folder <新文件夹> --from <旧文件夹>`；`open` / `take` 带 `--folder`。页名照旧按名字找：服务建页时同名的页只有一个，不另加「文件夹/页名」的写法（会跟页名里本来的 `/` 打架）。
- **检查**：`service/test/page-folders-test.mjs`（并进 `test:claude`，单跑 `test:folders`，端口 43389）；接口检查盯着 `tlui-page-menu__trigger`、`duplicatePage`、`renamePage`。菜单本身在 Browser 面板里手验（临时画布，10-22）：折叠、搜索 + 键盘跳页、会话改文件夹时实时重画、负责人标记、复制 / 删除 / 新建 + 起名、点页不收起、三种排序、在画布上改东西后「最近改过」几秒内把这页排到最前。

## 注意

- 本仓库公开：内网地址、凭据不要提交；生图规范里只写 skill 名。
- 上游带 GA4 统计（前端 gtag + `track_cowart_analytics_event`）。画布服务不转发统计工具，并用页面安全策略挡掉统计域名。
- 上游在 Windows 上有并发写同一文件时改名失败（EPERM）的问题，Codex 在 Windows 上同样会遇到：目标文件正被读着（页面每 1.6 秒把每页文件读一遍）时，改名覆盖它就报 EPERM。画布服务用排队 + 重试兜住了写入；上游写文件原先改名失败就把临时文件留在原地，服务每重试一次多留一个（2026-10-05 本机画布目录积了 586 个 `cowart-view-state.json.*.tmp`、lomo 有 15 个），所以打了补丁点（见清单）：原地重试改名，最后还失败就删掉临时文件。
- 上游 `insert_cowart_image` 把图片拉成它定下的框的尺寸（替换的 AI 图片框、按标注修改时匹配的原图、`displayWidth` × `displayHeight`），不看原图比例；生成的图很少正好是框的比例（krea2 的 3:4 出 896×1152，框是 512×683），会被压扁或拉长。画布服务在插入后把图等比缩回那个框里：AI 图片框里居中，其它左上对齐（`canvas-model.mjs` 的 `fitImageToAsset`），没改上游。接口检查盯着上游给放进框里的图写的 `cowartGeneratedForAiImageHolder`。
- 画布页面把 tldraw 编辑器挂在 `window.__cowartEditor`（上游 `handleMount` 里），适配层的画布内功能（AI 视频、AI 图片面板、网页参考、视频控制条）靠它，接口检查会盯着。
- 页面脚本还按类名 / data-testid 藏上游的界面：网页参考卡片的图片工具栏里藏掉「替换」「裁剪」「按标注生成 Html」（`tool.image-replace` / `tool.image-crop` / `tool.cowart-annotation-html`，由「照这个做 HTML」顶替）、样式面板按需显示（`.tlui-style-panel__wrapper`）。这些名字也在接口检查里。
- 标注绑定在数据层（见补丁点清单）：「标注」「注释」工具画的箭头（`meta.cowartAnnotationArrow`，注释另有 `meta.cowartAnnotationNote`）用 tldraw 的箭头绑定（`binding`，`props.terminal: 'end'`）挂在它指着的卡片上，随画布保存。上游的按标注修改、适配层的「照这个做 HTML」、给模型看的画布摘要（「标注（修改要求）/ 注释（常驻说明）→ 卡片 id」）都按绑定取，不再按距离和颜色猜。
- 模型清单（`adapters/shared/*-models.mjs`）照 `beast gen templates` 手抄，网关模板改了要跟着改；画布直接生成按清单里的模板和参数名提交。
- 画布直接生成每次写提示词都跑一次 `claude -p`（默认 haiku，约 5 秒），用本机 Claude Code 的登录额度；产物落在猛兽上、记在 beast 配置里的用户（`~/.beast/config.json` 的 client）名下。
- Claude Code 这边给模型的说明全在 `adapters/claude/skills/cowart/SKILL.md`（以前 MCP 服务的 `instructions` 只有前 2048 个字符进得了上下文，2026-09-14 实测，所以说明本来就挪进了 skill）：cowart 命令怎么写、请求怎么处理、结果放哪一页、标注怎么读、Codex 口吻怎么换成 beast-gen。`npm --prefix adapters run install:claude` 把它链接成全局 skill（Windows 用目录 junction），并写 `~/.cowart/bin/cowart.mjs`；每条请求的宿主说明都让 Claude 先加载它。Codex 的说明在 `adapters/claude/codex-skill/cowart/SKILL.md`（同一个 install 链成 Codex 的 `skills/cowart`；2026-10-23 以前 Codex 有 4 个 skill，在 `adapters/codex/skills/`，合成了这一个）。仓库根目录的 `skills/` 保留上游给 Codex 插件的版本，本 fork 不用。

## 补丁点清单

| 文件 | 位置 | 原因 | 上游 PR |
|---|---|---|---|
| `mcp/lib/widget-resource.mjs` | `applyHostContext`、`callServerTool` 发出前转成标准 JSON（均标 `[fork-patch]`） | 合并宿主增量 context，保留通知中未提供的 displayMode、widget identity 和能力字段，避免主题或尺寸更新中断视频分段读取；可选字段的 `undefined` 穿不过宿主的 JSON 参数校验（`-32602 Invalid tool call params`），postMessage 之前先转成标准 JSON | **待撤**：只给以前的 Codex 原生小部件用（2026-10-23 去掉）；未提（通用 MCP Apps 增量 context 契约） |
| `src/cowartClient.js`、`src/App.jsx` | 有效存储参数等待、适配层 storage/activity 接口、首次加载重试、错误操作、view state 去重与隐藏页轮询（均标 `[fork-patch]`） | 初始化通知可能先给主题后给存储；一次性监听会误报文件加载失败。宿主重建 sandbox 后应从权威快照和会话状态恢复，错误可重试；隐藏时不积累读取，时间戳也不应导致无变化的视角持续写入 | 未提（通用初始化与生命周期恢复） |
| `src/App.jsx` | `cowartExtensionTools()` 等三个函数、`cowartUiOverrides.translations` / `tools`、`CowartToolbar`（均标 `[fork-patch]`） | 底部工具栏是写死的 React 组件，适配层没法从外面加按钮；开一个通用的工具栏扩展接口，适配层用它加「AI 视频」（AI 组）和「网页」（`after: 'asset'`，排在媒体后面）。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartPanelTakenOver()`、`CowartCanvasOverlay` 里的 AI 图片面板、`CowartAiImageStyleControls` 的提前返回（均标 `[fork-patch]`） | 上游 AI 图片面板只有「参考图 + 描述 + 发送」，没法选模型和参数，尺寸比例又放在右上角；开一个面板接管开关，适配层画一个管全部控制项的面板。未接管时行为与上游一致 | 未提 |
| `src/App.jsx` | `cowartImageToolbarItems()`、`CowartImageToolbarContent` 里的 `imageShape` 和扩展按钮、`CowartExtensionImageToolbarButton`（均标 `[fork-patch]`） | 图片工具栏也是写死的 React 组件；网页参考卡片的按钮要并进这一排（用户不要两排），从外面往 React 管的节点里塞按钮会被重渲染冲掉、也不参与工具栏的定位。开一个通用的图片工具栏扩展接口。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartContextMenuItems()`、`CowartContextMenu` / `CowartContextMenuContent`、`cowartComponents.ContextMenu` 和对应的 tldraw 导入（均标 `[fork-patch]`） | 右键菜单同样是写死的 React 组件，tldraw 的 `DefaultContextMenuContent` 各组之间没有插槽；开一个通用的右键菜单扩展接口，适配层用它在「复制为 / 导出为 / 下载原图」下面加「在资源管理器中显示」。内容照抄 tldraw 5.1 的 `DefaultContextMenuContent` 再加一组，升级 tldraw 时要对一下。未注册扩展时与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | 标注绑定：`cowartAnnotationNotices` 到 `registerAnnotationBindings()` 一组函数和新的 `collectAnnotationTargetShapeIds`（替换了原来按距离、颜色收集标注的辅助函数和常量）、`CowartAnnotationPointing` 的 `updateArrowEnd` / `complete` / `cancel`、`CowartAnnotationToolbarItem` 的提示、5 个按标注请求构建函数的 `annotationLines`、`handleMount` 里的注册和去掉的 `unsubscribeAnnotationEditingToolLock` 监听、`moveAnnotationsWithCard` 对装着东西的框的放行（均标 `[fork-patch]`） | 上游按「卡片周围一圈里的红 / 橙 / 黄箭头和文字」猜标注归谁：挨得近的卡片互相串、离得远的漏掉。改成画的时候必须指到卡片（图片 / 视频 / 网页卡片 / AI HTML / AI Slides，松手不在卡片上就撤掉并提示），箭头尖用 tldraw 箭头绑定钉在松手点、随画布保存；卡片移动时标注整条跟着走（拖装着卡片的分组框 / 编组时也是）、删卡片一起删；拖箭头尖换卡片按松手点改绑，拖到空白处退回原位；写要求时回车完成（Shift+回车换行），完成后回到选择工具（去掉了上游写完字又切回标注工具的监听），没写字就结束的标注直接撤掉；新增「注释」工具（`CowartNoteTool`，蓝色虚线，`meta.cowartAnnotationNote`，常驻说明，请求里单列为背景）和各卡片工具栏的「清理标注」（`CowartClearAnnotationsButton`，只删标注、留注释；视频工具栏为此换成 `CowartVideoToolbar`）；只认「标注」「注释」工具的箭头，旧的未绑定标注在打开画布时按箭头尖位置补绑；请求里除截图外再逐条列出每个标注的字和指向的位置（占卡片宽高的百分比） | 未提（改的是上游行为，可以作为提案提） |
| `src/App.jsx` | `getAiImageGenerationPanelLayout()` 的面板下沿（标 `[fork-patch]`） | AI HTML / AI Slides 的输入面板贴着视口底边放，而它的层在底部工具栏下面：Browser 面板小的时候（1024×768）「发送」按钮被工具栏盖住，点中间点到的是工具栏（2026-10-22 验收）。改成面板下沿停在底部工具栏那一行（`.tlui-layout__bottom`）上面；适配层自己的 AI 图片 / AI 视频面板（`kit.js`）同样处理 | 未提（通用，可以提） |
| `src/App.jsx` | `followUpSender(sourceShapeId)` 及各图片 / 标注 / HTML / Slides 请求入口、Slides 截图后的页面检查（均标 `[fork-patch]`） | 开始准备截图或上传时固定来源页，通过 `message.cowart.pageId/pageName` 发给共享桥；等待期间翻页也不会把请求发给另一页负责者。Slides 需要先建新框，截图期间翻页则明确终止，避免在新页误建框 | 未提（通用消息来源元数据） |
| `src/App.jsx` | `buildCowartAssetUrls()` 的中文语言资源补全（标 `[fork-patch]`） | 在 tldraw 校验语言包之前补齐尚缺的 `page-menu.max-pages-reached`、`page-menu.resize`，消除中文菜单缺词警告 | 未提 |
| `src/App.jsx` | `readCowartHtmlDataUrl()`、`CowartHtmlDraftEmbed` 的来源选择、`resolveCowartTldrawAssetUrl()`、`hydrateCowartHtmlDraftLocalImages()`、`CowartSlidesMedia` 的图片来源、本地重试 signal 和 `CowartVideoShapeUtil` / `CowartVideoRetryBoundary`（均标 `[fork-patch]`） | HTML data URL 直接解码；相同素材的并发读取共用一个 Blob URL，换源时过滤旧请求结果。MCP 读取失败返回空并通过带素材版本的 `cowart:asset-load` 事件报告，适配层呈现视频错误；`cowart:retry-asset` 使素材缓存失效，由 React 边界订阅 signal 并只重建失败播放器，缩放后也能重试，不往共享画布写重试状态；宿主给出 `window.cowartMcp.directAssetUrl` 时（Claude / ZCode 这类由画布服务直接提供的页面）图片和视频直接用素材地址，不整段读成 Blob：视频由服务按 Range 流式提供，图片由浏览器缓存；HTML 草稿和 Slides 里的图片也用这个地址（草稿的 iframe 同源），不再内嵌成 base64 | 未提（通用资源加载与恢复能力）；宿主不给 `directAssetUrl` 时经 MCP 读成 Blob 的那条路只有以前的 Codex 小部件走，那部分待撤 |
| `src/App.jsx` | `REMOTE_REMOVABLE_RECORD_TYPES`（标 `[fork-patch]`） | 上游存盘只留被 shape 引用的 asset 记录：删掉一张图，它的 asset 就从磁盘上没了，下一次远端同步把页面里的那条也删掉——这是 remote 改动，撤销不回来。Ctrl+Z 于是只恢复得了图片的 shape，asset 缺着（卡片是破的），紧接着的保存又按「依赖缺失」（`src/canvasSnapshot.js` 的 `pruneRecordsWithMissingDependencies`）把这个 shape 也剪掉，图片彻底没了；标注、方框这些不带 asset 的照常恢复，所以看着像「标注回来了、图片没回来」。改成远端同步不删 asset 记录：asset 只是一个本地地址（不是图本身），没有 shape 用它就进不了磁盘，刷新页面即散 | 未提（改的是上游行为，可以作为提案提） |
| `src/App.jsx` | `cowartTldrawOptions` 的 `maxPages: Infinity`（标 `[fork-patch]`） | tldraw 默认最多 40 页（`maxPages`），到了页菜单只显示「已达到页面数量上限」、不让新建。全机一张画布由所有会话共用，会话经画布服务建页不受这个限制（2026-10-05 lomo 的画布已有 89 页），上限只拦得住用户自己在页菜单里建页 | 未提（fork 专用：上游一个项目一张画布） |
| `src/App.jsx` | `revokeCowartCachedAsset()` 的释放事件、`COWART_ASSET_BLOB_LIMIT` / `releaseCowartAssetBlobs()`、`resolveCowartTldrawAssetUrl()` 记下大小与使用时间、`handleMount` 里切页后的释放（均标 `[fork-patch]`） | 经 MCP 读的素材（Codex 原生 widget）都成 Blob 留在页面里、从不释放，翻过的页越多占得越多。改成切页时释放别页的图片、总量超 256 MB 时按最久没用释放（当前页的不动），释放的再看时由 widget 的素材缓存补回 | **待撤**：只给以前的 Codex 原生小部件用（画布服务的网页图片、视频都走直链，不产生 Blob）；未提（通用的内存上限，可以提） |
| `src/cowartClient.js`、`src/App.jsx` | `refreshCowartCanvasSnapshot` 对 `unchanged` 回 null、`loadRemoteCanvasSnapshot` 遇 null 直接返回（均标 `[fork-patch]`） | 画布服务对版本没变的轮询只回「没变」（见「画布服务」的轮询带版本），上游这一轮不用再整张 sanitize、比对。补丁丢了页面桥照样把手里那份快照交回去，只是又回到整张比对，不会错 | 未提（依赖适配层的版本号） |
| `mcp/lib/canvas-storage.mjs` | `writeJsonAtomic` / `renameWithRetry`（标 `[fork-patch]`） | Windows 上目标文件正被读着时改名覆盖报 EPERM，上游失败后把临时文件留在原地，服务的重试每次再留一个。改成用同一个临时文件原地重试改名（20 / 40 / 80 / 160ms），还失败就删掉临时文件再报错。实测按 1.6 秒轮询读，6528 次写入只有 2 次要重试、最长等 19ms | 未提（通用，可以提） |
