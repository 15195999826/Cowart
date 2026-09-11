# Cowart · Claude Code 适配层

让上游 Cowart 画布在 **Claude Code 桌面版**里可用。上游代码一行没改，全部改动都在本目录和 `adapters/shared/`。开发准则见仓库根目录 [FORK.md](../../FORK.md)。

## 它做了什么

```
Claude Code ──stdio MCP──▶ 适配层 cowart-claude-mcp.mjs ──stdio MCP──▶ 上游 Cowart 服务（mcp/generated，黑盒子进程）
                              │
                              ├─ 本地网页服务 127.0.0.1:43240 起 ──▶ Browser 面板里的画布页面
                              │     └─ 上游画布页面 + 注入的 Claude 宿主桥（web/bridge.js）
                              └─ 画布请求队列 ──▶ cowart-listen.mjs（Monitor 工具运行）──▶ 唤醒 Claude 会话
```

| 上游在 Codex 里的做法 | 这里的替代 |
|---|---|
| MCP Apps widget 内嵌显示 | 本地网页服务，在 Browser 面板打开 |
| 画布调工具走 MCP Apps 桥 | 注入 `window.cowartMcp`，经本地 HTTP 转发给上游服务 |
| 画布发消息 = `ui/message` 对话轮 | 进请求队列 → Monitor 通知 → Claude 用确认卡片问用户 → 执行 |
| Codex 内置 imagegen | beast-gen skill（本地免费档 / 云端花额度档，由确认卡片选） |
| GA4 统计 | 统计工具不转发，页面安全策略挡掉所有外部域名 |

另外补了上游没有的：

- **视频**：`insert_cowart_video` 工具 + 画布顶部「🎬 视频」按钮（选中图片 = 图生视频，否则文生视频）。视频文件经本地服务按需分段加载，选中后双击播放。
- **画布摘要**：模型调 `get_cowart_canvas_state` 拿到的是紧凑摘要（图形、位置、素材本地路径），不是几 MB 的原始快照。
- **写入保护**：同一画布的写操作排队、Windows 上的临时文件改名冲突（EPERM）自动重试；刚插入的视频不会被画布的旧快照自动保存冲掉（上游只保护图片）。
- **状态浮层**：画布顶部显示 Claude 是否在监听、每个请求的状态（排队 / 等确认 / 处理中 / 完成）。

## 配置

一次性安装依赖（仓库根目录执行）：

```bash
npm install --prefix adapters
```

把适配层注册成某个项目的 `cowart` MCP 服务（在那个项目目录下执行）：

```bash
claude mcp add cowart -s local -- node C:/WebProjects/Cowart/adapters/claude/bin/cowart-claude-mcp.mjs
```

新开 Claude Code 会话后生效。环境变量 `COWART_CLAUDE_PORT` 可以改起始端口（默认 43240，被占用时往后顺延）。

## 使用

1. 对 Claude 说「打开 Cowart 画布」。Claude 调 `render_cowart_canvas_widget`，按返回的指引在 Browser 面板打开网址，并用 Monitor 启动画布请求监听。
2. 画布顶部显示「● Claude 已连接」后，就可以在画布里点 AI 按钮了：AI 图片 / AI HTML / AI Slides / 按标注修改 / 按标注生图 / 🎬 视频。
3. 每个请求都会在对话里弹一张确认卡片（免费本地模型 / 云端模型 / 跳过），点了才执行。结果回到画布，状态显示在画布顶部。

画布数据存在 `<项目>/canvas/`，和 Codex 版格式一致，两边可以打开同一个画布。

## 开发与检查

```bash
npm --prefix adapters run test:claude       # 端到端冒烟测试（临时项目，不碰真实画布）
npm --prefix adapters run check:contract    # 同步上游后跑：适配层依赖的上游接口是否还在
node adapters/claude/scripts/dev-host.mjs --project <目录>   # 不经 Claude Code 手动联调
```

`dev-host.mjs` 会像 Claude Code 一样启动适配层、打开画布，并在 `127.0.0.1:43299` 提供控制端口：带请求头 `x-cowart-dev: 1` 发 `POST /call {"name": "...", "arguments": {...}}`，就能直接调适配层的任意工具。

## 已知限制

- **每条画布请求都要在对话里确认一次**：Monitor 推来的是后台通知，不算用户输入。确认卡片同时用来选模型、确认花费。
- **会话结束，服务就停**：适配层跟着 Claude Code 会话走。画布页面会显示「Cowart 服务未连接」，重新说「打开 Cowart 画布」即可接上（令牌持久化在 `~/.cowart-claude/token`，已打开的页面能自动重连）。
- **视频不自动播放**：tldraw 遵循系统的「减少动态效果」设置，选中视频后双击出现播放控件。
- **同一画布别在两个会话里同时开**：两个适配层会各自写同一份文件。
