# Cowart 二次开发说明（fork）

本仓库 fork 自 [zhongerxin/Cowart](https://github.com/zhongerxin/Cowart)（MIT），同时给 **Codex** 和 **Claude Code 桌面版**使用。

## 开发准则：上游原版 + Codex 适配层 + Claude Code 适配层

- 上游文件尽量不改。新功能、宿主差异都写在 `adapters/` 下。
- 适配层做不到的，才在上游文件里打「补丁点」：改动最小，代码里用 `[fork-patch]` 注释标出，并登记到文末清单。通用的扩展接口优先提 PR 给上游。
- 两个宿主真正不同的只有三处：画布怎么显示、画布怎么给 AI 发消息、用什么生图。

## 目录

```
adapters/
  package.json  适配层自己的依赖（MCP SDK、fractional-indexing），装在 adapters/node_modules
  shared/       两边共用：上游子进程连接、页面注入、画布摘要、视频探测与摆放
  claude/       Claude Code 适配（说明见 adapters/claude/README.md）
    bin/        MCP 入口 cowart-claude-mcp.mjs、画布请求监听 cowart-listen.mjs
    lib/        适配层主体、本地网页服务、请求队列、写入保护
    web/        注入画布页面的宿主桥和状态浮层（bridge.js）
    scripts/    冒烟测试、上游接口检查、手动联调宿主
  codex/        Codex 适配：先空着，Codex 新功能放这里
FORK.md         本文件
```

## 分支与同步

- `main`：主线，Codex 和 Claude Code 都从这里装。Codex 从 GitHub marketplace 安装插件并**自动跟随远程 `main`**，所以 `main` 只合验证过的改动。
- `feat/*`：开发分支，验证后合进 `main`。
- `upstream` remote 指向原作者仓库。同步：`git fetch upstream && git merge upstream/main`。`mcp/generated/` 下的发布产物有冲突时不手工合并，重新 `npm run build:artifacts` 生成。
- 同步上游后先跑 `npm --prefix adapters run check:contract`（宿主桥接口、工具名和入参是否还在）和 `npm --prefix adapters run test:claude`（端到端冒烟测试），都过了再合进 `main`。

## 已核实的接缝（2026-09-11）

1. 页面只通过 `window.cowartMcp`（`callServerTool` / `sendFollowUpMessage` / `getHostCapabilities` / `requestDisplayMode`）和 `window.openai.toolOutput`（`projectDir` / `canvasDir`）跟宿主通信。宿主桥在服务时注入（`mcp/lib/widget-resource.mjs` 的 `injectMcpHostBridge`），`mcp/generated/cowart-widget.html` 本身不含宿主桥。→ 适配层换注入脚本即可，`src/App.jsx` 不用改。
2. `mcp/server.mjs` 是脚本（顶层建 server、stdio connect，不导出）。→ 适配层做 MCP 代理，把上游生成的 bundle 当子进程黑盒，转发、改写、追加工具。
3. `mcp/lib/canvas-storage.mjs` 导出画布读写函数，可直接 import。

## 宿主差异

| | Codex | Claude Code 桌面版 |
|---|---|---|
| 画布显示 | MCP Apps widget（上游原生） | 本地 HTTP 服务，在 Browser 面板打开 |
| 画布 → AI 消息 | MCP Apps `ui/message`（上游原生） | 持久 Monitor 推事件 → 对话里一键确认（执行 / 跳过）后处理 |
| 生图 | Codex 内置 imagegen | beast-gen skill（确认卡片兼作花钱确认） |
| 视频 | 上游不支持 | `insert_cowart_video` + 画布「🎬 视频」按钮，beast-gen 生成；视频文件经本地服务分段加载 |

背景（2026-09-11 调研）：

- Claude Code 桌面版的 Code 标签页不渲染 MCP Apps：实测 `render_cowart_canvas_widget` 只返回 JSON，另见 [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671)。
- Claude Code 的 channels 能让 MCP 服务往会话里推消息，但目前只有 CLI 能开（自建通道要加 `--dangerously-load-development-channels`），桌面版不能传启动参数。
- Monitor 推来的事件不算用户输入，所以每条画布请求都要在对话里确认后才执行。

## 注意

- 本仓库公开：内网地址、凭据不要提交；生图规范里只写 skill 名。
- 上游带 GA4 统计（前端 gtag + `track_cowart_analytics_event`）。Claude 适配层不转发统计工具，并用页面安全策略挡掉统计域名。
- 上游在 Windows 上有并发写同一文件时改名失败（EPERM）的问题，Codex 在 Windows 上同样会遇到；Claude 适配层用排队 + 重试兜住了，没改上游。
- 画布页面把 tldraw 编辑器挂在 `window.__cowartEditor`（上游 `handleMount` 里），适配层的画布内功能（如「🎬 视频」）靠它，接口检查会盯着。

## 补丁点清单

目前没有补丁点：Claude 适配层（显示、消息、生图、视频）全部通过上面三个接缝实现，上游文件一行没改。

| 文件 | 位置 | 原因 | 上游 PR |
|---|---|---|---|
| （暂无） | | | |
