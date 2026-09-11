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
  shared/       两边共用：上游子进程连接、页面注入、画布摘要、视频探测与摆放、
                图片 / 视频模型清单（image-models.mjs / video-models.mjs）、
                把面板选项变成请求文本的 prepare_cowart_generation_request（generation-requests.mjs）
                网页截图 web-capture.mjs（puppeteer-core 驱动本机 Chrome / Edge）
    web/        两边都注入画布页面的脚本：kit.js（卡片行为、面板骨架、发送流程）、canvas-chrome.js（菜单精简、样式面板按需显示）、
                AI 视频、接管后的 AI 图片、网页参考、视频播放
  claude/       Claude Code 适配（说明见 adapters/claude/README.md）
    bin/        MCP 入口 cowart-claude-mcp.mjs、画布请求监听 cowart-listen.mjs
    lib/        适配层主体、本地网页服务、请求队列、写入保护
    web/        只属于 Claude 的页面脚本：宿主桥和状态浮层（bridge.js）
    scripts/    冒烟测试、上游接口检查、手动联调宿主
  codex/        Codex 适配（说明见 adapters/codex/README.md）
FORK.md         本文件
```

## 分支与同步

- `main`：主线，Codex 和 Claude Code 都从这里装。Codex 从 GitHub marketplace 安装插件并**自动跟随远程 `main`**，所以 `main` 只合验证过的改动。
- `feat/*`：开发分支，验证后合进 `main`。
- `upstream` remote 指向原作者仓库。同步：`git fetch upstream && git merge upstream/main`。`mcp/generated/` 下的发布产物有冲突时不手工合并，重新 `npm run build:artifacts` 生成。
- 同步上游后先跑 `npm --prefix adapters run check:contract`（宿主桥接口、工具名和入参是否还在，补丁点有没有丢）和 `npm --prefix adapters run test:claude`（端到端冒烟测试），都过了再合进 `main`。
- 有补丁点以后，改了 `src/` 就要在仓库根目录 `npm ci && npm run build:artifacts` 重新生成 `mcp/generated/`，并和源码一起提交；`npm run check:artifacts` 能核对两者是否一致。
- **Windows 上构建前必须按 LF 检出**：`git config core.autocrlf false`、`git config core.eol lf`，再重新检出（`git rm -r --cached -q . && git reset -q --hard`，先把未提交的改动存好）。否则 `index.html` 和 SVG 图标会以 CRLF 被打进页面，产物跟上游对不上。

## 已核实的接缝（2026-09-11）

1. 页面只通过 `window.cowartMcp`（`callServerTool` / `sendFollowUpMessage` / `getHostCapabilities` / `requestDisplayMode`）和 `window.openai.toolOutput`（`projectDir` / `canvasDir`）跟宿主通信。宿主桥在服务时注入（`mcp/lib/widget-resource.mjs` 的 `injectMcpHostBridge`），`mcp/generated/cowart-widget.html` 本身不含宿主桥。→ 适配层换注入脚本即可，`src/App.jsx` 不用改。
2. `mcp/server.mjs` 是脚本（顶层建 server、stdio connect，不导出）。→ 适配层做 MCP 代理，把上游生成的 bundle 当子进程黑盒，转发、改写、追加工具。
3. `mcp/lib/canvas-storage.mjs` 导出画布读写函数，可直接 import。
4. （补丁点，见文末）`src/App.jsx` 的扩展接口 `window.__cowartExtensions`，适配层在页面加载前设置：
   - `tools: [{ id, label, iconSvg, onSelect(editor), after? }]`：工具出现在底部工具栏的 AI 工具组里（AI 视频）；`after: 'asset'` 则排在「媒体」后面（网页）。
   - `panels: ['ai-image']`：上游不再渲染自己的 AI 图片输入面板和右上角的「尺寸 / 比例」，由适配层画一个面板管全部（模型、画幅、参数）；画幅直接改框的形状并锁定比例。占位框本身、`insert_cowart_image` 替换占位框还是上游的。
   - `imageToolbar: [{ id, label, title?, iconSvg?, isFor(shape), onSelect({ editor, shape, anchor }) }]`：选中图片时，`isFor` 认领的图片在上游那一排图片工具栏末尾多出这些按钮（网页参考卡片的「打开原网页」「照这个做 HTML」），样式和「按标注修改」一样。
   都没设置时跟上游完全一样。
5. 共用面板的发送流程两边一样：页面先调页面专用工具 `prepare_cowart_generation_request`（适配层保存上传的素材、拼好请求文本），再用宿主的 `sendFollowUpMessage` 发出去——Claude 进请求队列，Codex 是一条 `ui/message`。

## 宿主差异

| | Codex | Claude Code 桌面版 |
|---|---|---|
| 画布显示 | MCP Apps widget（上游原生） | 本地 HTTP 服务，在 Browser 面板打开 |
| 画布 → AI 消息 | MCP Apps `ui/message`（上游原生） | 持久 Monitor 推事件 → 对话里一键确认（执行 / 跳过）后处理 |
| 生图 | Codex 内置 imagegen（上游原生）；Codex 适配层开发中：接管 AI 图片面板后同样按 beast-gen 模板选模型，外加 Codex imagegen 一项 | AI 图片面板按 beast-gen 模板选模型（确认卡片兼作花钱确认）；上游其它按 Codex 写的生图提示词改用 beast-gen |
| 视频 | 上游不支持 | 底部工具栏「AI 视频」（占位框 + 同款输入面板，生成后替换占位框，默认本地免费的 H3）+ `insert_cowart_video`，beast-gen 生成；视频文件经本地服务分段加载，画布上自动静音循环播放 |

背景（2026-09-11 调研）：

- Claude Code 桌面版的 Code 标签页不渲染 MCP Apps：实测 `render_cowart_canvas_widget` 只返回 JSON，另见 [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671)。
- Claude Code 的 channels 能让 MCP 服务往会话里推消息，但目前只有 CLI 能开（自建通道要加 `--dangerously-load-development-channels`），桌面版不能传启动参数。
- Monitor 推来的事件不算用户输入，所以每条画布请求都要在对话里确认后才执行。

## 注意

- 本仓库公开：内网地址、凭据不要提交；生图规范里只写 skill 名。
- 上游带 GA4 统计（前端 gtag + `track_cowart_analytics_event`）。Claude 适配层不转发统计工具，并用页面安全策略挡掉统计域名。
- 上游在 Windows 上有并发写同一文件时改名失败（EPERM）的问题，Codex 在 Windows 上同样会遇到；Claude 适配层用排队 + 重试兜住了，没改上游。
- 画布页面把 tldraw 编辑器挂在 `window.__cowartEditor`（上游 `handleMount` 里），适配层的画布内功能（AI 视频、AI 图片面板、网页参考、视频控制条）靠它，接口检查会盯着。
- 页面脚本还按类名 / data-testid 藏上游的界面：网页参考卡片的图片工具栏里藏掉「替换」「裁剪」「按标注生成 Html」（`tool.image-replace` / `tool.image-crop` / `tool.cowart-annotation-html`，由「照这个做 HTML」顶替）、样式面板按需显示（`.tlui-style-panel__wrapper`）。这些名字也在接口检查里。
- 标注绑定在数据层（见补丁点清单）：「标注」「注释」工具画的箭头（`meta.cowartAnnotationArrow`，注释另有 `meta.cowartAnnotationNote`）用 tldraw 的箭头绑定（`binding`，`props.terminal: 'end'`）挂在它指着的卡片上，随画布保存。上游的按标注修改、适配层的「照这个做 HTML」、给模型看的画布摘要（「标注（修改要求）/ 注释（常驻说明）→ 卡片 id」）都按绑定取，不再按距离和颜色猜。
- 模型清单（`adapters/shared/*-models.mjs`）照 `beast gen templates` 手抄，网关模板改了要跟着改。

## 补丁点清单

| 文件 | 位置 | 原因 | 上游 PR |
|---|---|---|---|
| `src/App.jsx` | `cowartExtensionTools()` 等三个函数、`cowartUiOverrides.translations` / `tools`、`CowartToolbar`（均标 `[fork-patch]`） | 底部工具栏是写死的 React 组件，适配层没法从外面加按钮；开一个通用的工具栏扩展接口，适配层用它加「AI 视频」（AI 组）和「网页」（`after: 'asset'`，排在媒体后面）。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | `cowartPanelTakenOver()`、`CowartCanvasOverlay` 里的 AI 图片面板、`CowartAiImageStyleControls` 的提前返回（均标 `[fork-patch]`） | 上游 AI 图片面板只有「参考图 + 描述 + 发送」，没法选模型和参数，尺寸比例又放在右上角；开一个面板接管开关，适配层画一个管全部控制项的面板。未接管时行为与上游一致 | 未提 |
| `src/App.jsx` | `cowartImageToolbarItems()`、`CowartImageToolbarContent` 里的 `imageShape` 和扩展按钮、`CowartExtensionImageToolbarButton`（均标 `[fork-patch]`） | 图片工具栏也是写死的 React 组件；网页参考卡片的按钮要并进这一排（用户不要两排），从外面往 React 管的节点里塞按钮会被重渲染冲掉、也不参与工具栏的定位。开一个通用的图片工具栏扩展接口。未注册扩展时行为与上游一致 | 未提（接口是通用的，可以提） |
| `src/App.jsx` | 标注绑定：`cowartAnnotationNotices` 到 `registerAnnotationBindings()` 一组函数和新的 `collectAnnotationTargetShapeIds`（替换了原来按距离、颜色收集标注的辅助函数和常量）、`CowartAnnotationPointing` 的 `updateArrowEnd` / `complete` / `cancel`、`CowartAnnotationToolbarItem` 的提示、5 个按标注请求构建函数的 `annotationLines`、`handleMount` 里的注册和去掉的 `unsubscribeAnnotationEditingToolLock` 监听（均标 `[fork-patch]`） | 上游按「卡片周围一圈里的红 / 橙 / 黄箭头和文字」猜标注归谁：挨得近的卡片互相串、离得远的漏掉。改成画的时候必须指到卡片（图片 / 视频 / 网页卡片 / AI HTML / AI Slides，松手不在卡片上就撤掉并提示），箭头尖用 tldraw 箭头绑定钉在松手点、随画布保存；卡片移动时标注整条跟着走、删卡片一起删；拖箭头尖换卡片按松手点改绑，拖到空白处退回原位；写要求时回车完成（Shift+回车换行），完成后回到选择工具（去掉了上游写完字又切回标注工具的监听），没写字就结束的标注直接撤掉；新增「注释」工具（`CowartNoteTool`，蓝色虚线，`meta.cowartAnnotationNote`，常驻说明，请求里单列为背景）和各卡片工具栏的「清理标注」（`CowartClearAnnotationsButton`，只删标注、留注释；视频工具栏为此换成 `CowartVideoToolbar`）；只认「标注」「注释」工具的箭头，旧的未绑定标注在打开画布时按箭头尖位置补绑；请求里除截图外再逐条列出每个标注的字和指向的位置（占卡片宽高的百分比） | 未提（改的是上游行为，可以作为提案提） |
