---
name: cowart-open-canvas
description: Open, reopen, or explicitly refresh the native Cowart MCP Apps canvas, or open and take responsibility for a shared page when the user asks. Also handles a bare @Cowart invocation with no other workflow.
---

# Cowart 原生画布

用 `cowart_mcp` 的 `render_cowart_canvas_widget` 打开 Codex 原生 MCP Apps widget。工具可能以完整名 `mcp__cowart_mcp__render_cowart_canvas_widget` 提供。需要时先发现工具；不要为图片生成、标注、HTML、Slides 或已有 widget 的请求例行重复 render。

## 打开和接管

| 用户请求 | 参数 |
|---|---|
| 打开 / 重开 / 刷新 Cowart 画布，或单独 `@Cowart` | `{ "sessionName": "小川" }` |
| 打开 Cowart 画布「角色设定」/ 进入「角色设定」/ 接管「角色设定」 | 加 `"page": "角色设定"`；没有该页则创建 |
| 接管这页 | 加 `"shownPage": true` |

第一次打开选一个简短人名作为 `sessionName`，整个会话沿用，避开现有会话的名字。没有 `page` / `shownPage` 时不改变负责关系；每个会话最多负责一页，每页同时一位负责者，翻页只是查看。

工具返回 `openai/outputTemplate: ui://widget/cowart/canvas.html`，由 Codex 渲染原生 widget。无需打开 Browser 面板、启动旧本地网页脚本或运行 Claude 的 Monitor。当前会话工具不可见时先做工具发现再重试，不因一次没找到就要求用户开新任务。

## 共用 page

画布在全机共享服务的 `~/.cowart/canvas`，Codex、Claude Code 和 ZCode 的所有项目共用同一组 page、素材和负责关系。**不传 `projectDir` / `canvasDir`**，也不在当前项目下创建画布目录。

打开后画布自动同步读取与插入结果。其它 Cowart 操作使用现有 widget；只在用户明确要求打开、重开、刷新、进入或接管页时 render。打开失败时才诊断运行环境，不例行运行构建、读写画布文件或截图。

收到 `Cowart 画布请求 #N` 时使用同插件的 `cowart` skill 处理队列；不要通过再次 render 开始执行请求。共享页不能直接整张覆盖保存，读写通过 Cowart MCP 服务工具完成。
