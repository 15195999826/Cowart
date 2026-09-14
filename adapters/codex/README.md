# Cowart · Codex 适配层

还没写。这份说明是交接给接手的人的：现状、要做的事、两边的差别。动手前先读仓库根目录的 [FORK.md](../../FORK.md)。

## 现状

- Codex 直接跑上游原生插件：`.codex-plugin/plugin.json` → `.mcp.json` → `scripts/start-mcp.mjs` → `mcp/generated/cowart-mcp.mjs`，画布是 MCP Apps widget（资源 `ui://widget/cowart/canvas.html`，上游在返回资源时往 `</head>` 前注入宿主桥）。
- 本仓库对上游的补丁点（FORK.md 末尾的清单）已经打进这个 widget：
  - **标注改动对 Codex 直接生效**：标注绑定到卡片、「注释」工具、各卡片工具栏的「清理标注」。
  - **三个扩展接口还没人用**：`window.__cowartExtensions` 的 `tools`、`panels`、`imageToolbar` 没有注册，所以这部分跟上游一样。
- Claude Code 那边已经改成「全机一个画布服务（`adapters/service`）+ 每个会话一个薄桥（`adapters/claude/lib/bridge.mjs`）」，见 FORK.md「画布服务」。Codex 版照这个做：Codex 桥也连同一个画布服务，用同一张画布（服务的那一张，`~/.cowart/canvas`，所有会话、所有项目共用）。
- 下面这些目前只在 Claude Code 里有（用法见 [adapters/claude/README.md](../claude/README.md)「另外补了上游没有的」）：
  - AI 图片面板按 beast-gen 选模型，外加「Codex imagegen」一项。
  - AI 视频工具和面板。
  - 画布素材：拖到卡片上、描述框敲「/」选、「@」引用。
  - 网页参考卡片和「照这个做 HTML」。
  - AI 框像卡片一样操作、菜单精简、样式面板按需显示、视频播放控制条。

  它们的页面脚本和请求拼装都已经在 `adapters/shared/` 和画布服务里，本来就是给两边共用的。Codex 适配层要做的，是把这些接进 Codex。

## 要做的事（建议顺序）

1. **Codex 桥**：参考实现是 `adapters/claude/lib/bridge.mjs`。
   - **连画布服务**：用 `adapters/service/client.mjs` 的 `CanvasServiceClient`（找服务 / 后台拉起 / 按版本替换 / 保持会话连接）；上游子进程、写入排队、`insert_cowart_video` 都已经在服务里（`adapters/service/lib/canvas-ops.mjs`），桥转发过去即可。
   - **画布**：服务只有一张画布，页面和工具带的 `canvasDir` 由服务换成它。Codex 桥做好之前，别让 Codex 原生插件直接读写这张画布（比如把 `COWART_CANVAS_DIR` 指过去）：上游页面整张保存，会删掉它没见过的页的目录。
   - **页面专用工具**：带 `_meta.ui.visibility: ['app']`，模型看不到，只给画布页面调，转给服务的页面调用：
     - `prepare_cowart_generation_request`（`shared/generation-requests.mjs`，调用时 `host: 'codex'`）：保存上传的素材，拼好请求文本。
     - `capture_cowart_web_reference`（`shared/web-capture.mjs`）：用本机 Chrome / Edge 截整页长图，并存渲染后的页面代码。
     - `save_cowart_canvas_state` 等上游页面工具：走服务，才能跟 Claude 会话共用写入排队、差异保存和旧快照保护。页面那边算差异（`cowartDelta`）的代码目前在 Claude 的 `adapters/claude/web/bridge.js` 里，不带差异的保存会退回上游的整张保存；要让 Codex 的 widget 和 Claude 的面板同时改一页不互相冲掉，把这段挪到 `adapters/shared/web/` 共用。
   - **改写画布资源**：转发 `resources/read` 读 `ui://widget/cowart/canvas.html` 时，用 `shared/widget-html.mjs` 注入共用脚本：
     - 注入方式是 `injectIntoHead(html, await sharedPageScripts(hostConfig))`，其中 `hostConfig = { host: 'codex', videoModels, defaultVideoModelId, imageModels: imageModelsForHost('codex'), defaultImageModelId }`。
     - 共用脚本是普通 `<script>`，插在 `</head>` 前，会排在上游宿主桥之后、应用脚本之前运行。`kit.js` 必须在应用启动前注册扩展，这个顺序正好满足。
     - 「Codex imagegen」这一项在 `image-models.mjs` 里标了 `hosts: ['codex']`，只有 host 是 codex 时才会出现在清单里。
2. **插件入口**：把 `.mcp.json`（或 `.codex-plugin/plugin.json`）改指 Codex 桥的启动脚本。这会改动上游文件，属于补丁点，要登记到 FORK.md，并在 `check-contract` 里加对应标记。
3. **打包**：Codex 从插件缓存直接运行，不会执行 `npm install`（上游 README 明确这么要求）。
   - 桥和画布服务都要打成不依赖依赖安装的单文件并提交，做法同上游的 `mcp/generated/`（`scripts/build-release-artifacts.mjs` 的 esbuild 打法）。代码指纹要在打包时算好写进产物，服务的版本替换规则才能跟开发目录里跑的比较。
   - `puppeteer-core` 比较大：网页截图可以按需加载，加载不到就给出明确提示。
4. **测试**：仿 `adapters/claude/scripts/smoke-test.mjs` / `multi-session-test.mjs` 写 Codex 版：
   - 起桥，列工具，确认页面专用工具被隐藏。
   - 读画布资源，确认共用脚本已注入。
   - 调 `prepare_cowart_generation_request`，确认请求文本。
   - 「请求发给负责那一页的会话」（FORK.md「画布服务」的分页负责制）在 Codex 里能不能做，做的时候验证：widget 的消息走 `ui/message`，天然回到它自己的对话；页面的工具调用走 MCP Apps → Codex 桥 → 服务。
   - 做完再把 FORK.md 的「宿主差异」表更新一下。

## 两边的差别（写代码时要注意）

- **发送**：Claude 那边 AI 图片 / AI 视频由画布服务直接生成：页面调宿主桥的 `startGeneration`（`POST /api/generations`，见 `adapters/service/lib/generation-jobs.mjs`），不发消息、不用确认。Codex 的宿主桥没有 `startGeneration`，`kit.js` 就走老流程：先调 `prepare_cowart_generation_request` 拿到请求文本，再用 `window.cowartMcp.sendFollowUpMessage` 发出。Codex 桥以后也可以提供 `startGeneration`（转给服务），同样直接生成。
  - 在 Codex 里，上游宿主桥会把它变成一条 `ui/message` 直接进对话。
  - 所以 Codex 没有 Claude 那边的请求队列、确认卡片和「撤销」。`kit.host === 'codex'` 时，页面提示「已发送给 Codex」。
- **生图 / 生视频**：
  - 请求文本会让模型用 beast-gen 生成，Codex 的环境里要有 beast 命令行和 beast-gen skill。
  - 图片面板选「Codex imagegen」时，请求改让 Codex 用内置生图。
- **素材和视频**：
  - Claude 那边的页面素材由画布服务的网页提供，视频可以分段加载。
  - Codex 的 widget 跑在沙箱 iframe 里，上游用 `read_cowart_page_asset` 取素材。
  - 视频在 Codex 里能不能播放、要不要改走 data URL / blob，还没验证。
- **打开外部链接**（网页卡片的网站名按钮）：`kit.openLink` 优先调 `window.openai.openExternal`，Claude 的宿主桥提供了它；Codex 里要确认 MCP Apps 有没有对应能力，没有就退回 `window.open`。
- **页面脚本依赖的全局变量**：
  - `window.__cowartEditor`：上游的 tldraw 编辑器。
  - `window.cowartMcp`：宿主桥。
  - `window.openai.toolOutput`：给出 `projectDir` / `canvasDir`。
  - `window.__cowartHostConfig`：注入进去的宿主配置。

## 参考

- [FORK.md](../../FORK.md)：开发准则、已核实的接缝、画布服务、补丁点清单、分支与同步流程。
- [adapters/claude/README.md](../claude/README.md)：每个功能的用法和行为，Codex 版照着对齐。
- `adapters/service/`：画布服务（上游子进程、写入排队与保护、差异合并、分页负责、页面专用工具、请求队列、按版本替换）。
- `adapters/claude/lib/bridge.mjs`：薄桥的参考实现（工具定义、转发、宿主说明）。
