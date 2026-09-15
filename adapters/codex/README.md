# Cowart · Codex 适配层

Codex 保留原生 **MCP Apps widget**，每个会话只运行一个薄 bridge，和 Claude Code / ZCode 连接同一个本机画布服务。三端共用 `~/.cowart/canvas` 的 page、素材、分页负责关系、差异保存和请求队列。开发约定见 [FORK.md](../../FORK.md)。

## 怎么用

在 Codex 中说「打开 Cowart 画布」，或直接 `@Cowart`。`render_cowart_canvas_widget` 返回原生画布资源 `ui://widget/cowart/canvas.html`，无需打开 Browser 面板或手动启动网页服务。

| 要做什么 | 工具参数 |
|---|---|
| 打开画布 | `{ "sessionName": "小川" }`；第一次选一个本会话固定的短名字 |
| 打开 / 接管「角色设定」页 | 加 `"page": "角色设定"`，没有该页则创建 |
| 接管面板正显示的页 | 加 `"shownPage": true` |

不传 `page` / `shownPage` 时只打开画布，不改变负责关系。工具不需要 `projectDir` / `canvasDir`；画布不属于当前项目。每页同时由一个会话负责，每个会话最多负责一页；翻页只是查看，接管才会换人。

例如 Claude 先创建「角色设定」，Codex 就能打开同一页、看到原有图片和标注。让 Codex 接管后，该页后续 AI 请求交给 Codex；无需导出、复制或转换 page。模型插入默认放到本会话负责的页，未负责页时使用本会话面板正看的页。处理队列请求时始终显式传回原请求的 `pageId`。

用着哪里不舒服，说「反馈：……」，Codex 调 `send_cowart_feedback` 记到本机的 `~/.cowart/feedback/`（服务附上会话、页、代码版本和最近的画布请求）；回到 Cowart 仓库用 `npm --prefix adapters run feedback` 处理，见 [FORK.md](../../FORK.md)「反馈」。

## 对齐的画布功能

- **AI 图片**：共用模型、画幅、参考素材和参数面板；猛兽模型由画布服务直接生成。Codex 额外提供「Codex imagegen」，交给负责该页的 Codex 会话处理。
- **AI 视频**：底部「AI 视频」工具、占位框和生成面板；服务生成后替换占位框，也支持 `insert_cowart_video` 插入本地视频。
- **画布素材**：拖到卡片上、描述框输入 `/` 选择、用 `@` 引用。
- **网页参考**：整页截图、页面代码、原网页链接和「照这个做 HTML」。截图需要本机 Chrome / Edge。
- **AI HTML / AI Slides / 标注**：经同一请求队列交给负责会话；标注绑定到卡片，注释提供常驻背景，修改结果保留原作与标注。
- **共用交互**：卡片操作、菜单精简、样式面板按需显示、视频控制条、请求进度和撤销。

共用功能代码在 `adapters/shared/`。Codex 素材经 MCP 工具读取到 widget，本地视频通过该通道加载；Claude 的网页画布仍走本地 HTTP 分段加载。真实 Codex 宿主中的视频解码、外链打开和完整交互需要宿主验收，不能以协议冒烟测试替代。

## 请求怎么到负责会话

AI 图片 / AI 视频的猛兽生成由共享服务执行，面板所选模型、参数、素材和目标页构成任务，进度和撤销显示在画布中。缺少 `beast` 命令行时服务会退回会话请求；Codex imagegen 始终走会话请求。

HTML、Slides、标注和 Codex imagegen 等请求先进入服务队列，再按原页的负责关系路由。Claude / ZCode 由后台监听收通知（来了请求才退出、唤醒会话）；Codex 由**负责会话自己的 widget**轮询领取，再发送 MCP Apps `ui/message` 通知请求编号。发起请求的面板不替另一个会话执行任务。

Codex 收到通知后：

1. `get_cowart_request { id, requestKey }` 读取原文、`pageId`、`executor` 和当前状态；key 原样复制通知或请求列表中的值，不凭通知摘要执行。
2. 已完成、失败、跳过或撤销的请求不重复执行；服务执行中的生成也不另起一次。
3. 开工前 `reply_cowart_request { id, requestKey, status: "running" }`，按原请求完成生成或编辑，结果插回原 `pageId`。
4. 成功回 `done`，失败回 `failed`，`message` 简述结果或原因；用户跳过回 `skipped`。每次回复均携带读取结果返回的同一个 `requestKey`，拒绝服务重启后旧编号误指向新请求。

目标 Codex widget 没开着时，请求留在服务队列，可用 `list_cowart_requests` 补读或重新打开画布接收。队列存在画布目录的 `.cowart-requests.json`，服务换版本或重启后请求、状态和编号都接得上（服务直接跑的猛兽生成会中断并标成失败）；page 和素材也在磁盘上。`ui/message` 只是投递通道，仍须遵守当前会话的授权边界。

使用说明随插件加载自 `adapters/codex/skills/`：通用 `cowart` 负责请求、共享页、HTML / Slides 和媒体插入；`cowart-open-canvas`、`cowart-image-gen`、`cowart-image-edit` 分别处理打开、生成和按标注改图。根目录 `skills/` 保留上游版本，不作为本 fork 的 Codex skill 入口，也不需要安装到用户全局 skills。

## 实现与打包

```text
.codex-plugin/plugin.json
  ├─ skills → adapters/codex/skills/
  └─ .mcp.json → adapters/codex/bin/start.mjs
                  └─ adapters/generated/cowart-codex-mcp.mjs
                       └─ CanvasServiceClient → 全机共享画布服务
```

- `lib/bridge.mjs`：模型工具转发、原生 widget 资源和仅 widget 可见的 `cowart_canvas_app` 通道。
- `web/transport.js`：MCP Apps 调用、轮询、领取请求及 `ui/message` 投递；不在 iframe 里直接请求 localhost。
- `../shared/web/service-bridge.js`：与 Claude 共用差异保存、页同步、负责状态和生成流程。
- `../scripts/build-artifacts.mjs`：把桥、服务和监听入口连同依赖打包到 `adapters/generated/`，发布清单记录资源与代码指纹。安装后的插件仅需要 Node.js >= 22.12.0，启动不执行 `npm install`。网页截图使用本机浏览器，不下载浏览器。

开发环境修改后运行：

```powershell
npm --prefix adapters run build:artifacts
npm --prefix adapters run check:artifacts
npm --prefix adapters run probe:cold
```

`probe:cold` 在独立临时目录用发布文件启动桥与共享服务，验证没有 `node_modules`、没有既有服务时仍可运行，且不访问真实用户画布。它不证明 Codex 桌面宿主的全部 UI 行为。修改上游 `src/` 时，另外按 [FORK.md](../../FORK.md) 先生成 `mcp/generated/`。

旧项目画布由共享服务的 `--import` 导入：只搬入尚不存在的页，保留原目录。不要把旧上游插件直接指向 `~/.cowart/canvas`，也不要手工整张覆盖共享画布 JSON；所有新写入都通过服务工具完成。
