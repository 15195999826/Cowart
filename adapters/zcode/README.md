# Cowart · ZCode 适配层

让上游 Cowart 画布在 **ZCode**（智谱 ZCode 桌面版 / CLI）里可用。和 Claude Code 适配层共用同一个全机画布服务、同一张画布、同一套页面脚本——ZCode 会话和 Claude Code 会话在画布上按页分工，互相看得到对方负责的页。

```
ZCode 会话 ──stdio MCP──▶ 薄桥 cowart-zcode-mcp.mjs ──┐
Claude Code 会话 ──stdio MCP──▶ 薄桥 cowart-claude-mcp.mjs ──┤ HTTP 127.0.0.1:43240（令牌）
                                                        ▼
              画布服务 adapters/service（全机一个，后台进程，空闲 10 分钟退出）
                ├─ 上游 Cowart 服务（黑盒子进程）+ 请求队列（按页路由）+ 画布直接生成
                └─ 网页画布 ──▶ 任何浏览器打开（网址带会话标识；ZCode 没有 Browser 面板）
```

## ZCode 和 Claude Code 宿主的两处不同

| | Claude Code 桌面版 | ZCode |
|---|---|---|
| 画布显示 | Browser 面板 | 没有内置面板，也没有 MCP Apps widget（2026-09-14 在主程序包里核实：无 `ui://` 资源、无 `openai.toolOutput` 宿主桥）。画布网址交给用户在任意浏览器打开；装了 browser-use 插件时也可以自己打开 |
| 会话标识 | `CLAUDE_CODE_HOST_SESSION_ID` | ZCode 不给 MCP 进程传会话标识（核实过 `ZCODE_*` / `ZAI_*` 环境变量），一个桥进程就是一个画布会话。同一个 ZCode 会话里桥重启（重开对话）会算新会话，原来负责的页要重新「接管」 |

画布请求的送达两边一样：监听命令（`cowart-listen.mjs --once`）用 Bash 工具后台运行，一直等着、不耗 token；收到一批画布事件（首事件后约 750ms 静默）才退出，**退出本身唤醒会话**（后台任务的完成通知），会话处理完再后台启动一次。服务端在监听重连时补发没送达的请求（`server.mjs` 的 deliverPending），所以不会漏；监听没在跑时请求在服务里排队，用户说「看画布」时取走。

其余也全部共用：分页负责制、差异保存、AI 图片 / AI 视频面板（beast-gen 模板、画布直接生成）、网页参考、标注绑定、视频播放。画布页面按打开它的会话的宿主显示文案（服务端注入 `hostLabel: "ZCode"`，只改措辞不改行为）。

## 配置

一次性安装依赖（仓库根目录执行），然后把适配层装进 ZCode（一次就行；仓库挪了位置再跑一次，`uninstall:zcode` 移除）：

```bash
npm install --prefix adapters
npm --prefix adapters run install:zcode
```

安装做了三件事（`adapters/zcode/scripts/install.mjs`）：

1. 在 `~/.zcode/cli/config.json` 的 `mcp.servers.cowart` 注册薄桥（stdio，绝对路径——ZCode 不展开配置文件里的 `${...}` 模板；`timeoutMs` 放宽到 5 分钟，第一次连接可能要拉起画布服务）。
2. 把 `adapters/zcode/skills/cowart` 链接成 `~/.zcode/skills/cowart`（Windows 是 junction），画布请求怎么处理、结果放哪页、标注怎么读都在这个 skill 里。
3. 本机装过 Claude 版 beast-gen（`~/.claude/skills/beast-gen`）时把它也链接进 `~/.zcode/skills/`：画布的生图流程要靠它。

**新开的 ZCode 会话生效**（MCP 服务在会话开始时连接）；已经开着的会话要重开。

环境变量与 Claude 版相同（`COWART_CLAUDE_PORT`、`COWART_CANVAS_DIR`、`COWART_SERVICE_IDLE_MS`、`COWART_BEAST_CLI` 等，见 [adapters/claude/README.md](../claude/README.md)）；`COWART_SESSION_ID` 可显式指定会话标识（测试用）。

## 使用

1. 对 ZCode 说「打开 Cowart 画布」（或「打开 Cowart 画布 角色设定」进入某页）。它会调 `render_cowart_canvas_widget`，把画布网址发给你（Markdown 链接，浏览器里打开），并后台启动画布请求监听。
2. 画布顶部显示「● ZCode 在等请求」后就可以点 AI 按钮了。AI 图片 / AI 视频点发送直接生成；其它请求会唤醒会话，用 AskUserQuestion 确认后执行。
3. 会话处理完每条画布请求，会自动再启动一次监听接下一条；监听没在跑时请求排队，在会话里说「看画布」就取来。
4. 说「给这页的图编号、分组」「排整齐」「加个标题」「把 X 删掉」，ZCode 用整理工具（`insert_cowart_text` / `insert_cowart_frame` / `update_cowart_shapes` / `delete_cowart_shapes`）直接改它负责的页；这些改动页面上的 Ctrl+Z 撤不回，删除前会先说清楚。
5. 用着哪里不舒服，说「反馈：……」，ZCode 用 `send_cowart_feedback` 记到本机的 `~/.cowart/feedback/`（会话、页、代码版本、最近的画布请求自动附上）；回到 Cowart 仓库用 `npm --prefix adapters run feedback` 处理（见 FORK.md「反馈」）。

## 开发与检查

```bash
npm --prefix adapters run test:zcode    # 端到端：桥、宿主注册、页面文案、--once 监听、安装脚本（临时项目、测试端口，不碰真实画布）
npm --prefix adapters run test:claude   # 共用部分（画布服务、页面、请求队列）的完整回归
```

`adapters/zcode/lib/bridge.mjs` 是 `adapters/claude/lib/bridge.mjs` 的 ZCode 姊妹版：工具定义、转发逻辑、请求的宿主说明都一样，差别只在「怎么打开画布」和「怎么收到画布请求」两段说明（INSTRUCTIONS、renderResult、hostNotes）。

## 已知限制（ZCode 特有）

- **画布在浏览器里，不在 ZCode 窗口里**：没有 Browser 面板，画布网址在哪个浏览器打开都行（网址带会话标识）；关掉浏览器页面只是看不见画布，数据都在。
- **会话恢复不接续**：ZCode 不传会话标识，重开对话后是新的画布会话；之前负责的页显示「会话已结束」，重新说「接管 <页名>」即可。
- **请求送达依赖会话自己重启监听**：会话忘了再跑监听命令时，请求一直在服务里排队（画布顶部显示「请求会排队 · 到对话里说「看画布」」），在会话里说「看画布」就用 `list_cowart_requests` 取来。
- **一条唤醒处理一批**：监听退出时把同一批到达的事件一起带出来（首事件后约 750ms 内的都算一批），按编号逐条问、逐条做；刚好在退出之后到达的下一条等下一次监听连接时补发。
