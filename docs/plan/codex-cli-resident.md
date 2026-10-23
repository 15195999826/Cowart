# Codex 改走 cowart 命令 + 画布服务常驻（CX，2026-10-23）

> 来源：2026-10-23 Claude 会话的讨论（服务内存实测 → 常驻 → Codex 弃 widget + MCP；两个待定点用户按推荐拍板，整体方案用户发 `/plan-runner 跑`）。范围：`adapters/`、`FORK.md`、根目录 `.mcp.json` / `.codex-plugin/plugin.json`、`docs/plan/`。**`src/`、`mcp/`、根 `skills/`、根 `package.json` / `package-lock.json` / `plugin.json` 零改动**。
> 状态：**未开始**。各阶段 SHA 见 §6；收口后待用户 push。
> 执行方式：每阶段 fresh context、一个原子提交、失败即停、无人值守不 push。本项目第一次用 plan-runner，profile 就是本文 §2。

---

## 0. Context（实测 / 读代码查到的事实）

- 服务内存（10-23，测试端口，拷真画布 50 页 JSON）：服务 + 上游子进程（`mcp/generated/cowart-mcp.mjs`）两个 node，刚起提交内存 ~152 MB，读几轮整张画布后 ~250 MB；杀掉子进程 15 秒后服务单独 ~70 MB。`puppeteer-core` 约占 20 MB（`shared/web-capture.mjs` 顶层 import，只有网页参考截图用）。上游子进程冷起 130 ms，首次读整张画布 65 ms。每个 Codex 任务挂一个 Cowart 桥进程（73 MB 工作集 / 85 MB 提交）。
- `~/.cowart-claude/service.log`：10-01 起用全机画布的 73 个服务有 54 个没写 `stopping` 就没了，Codex 一启动 22 秒内连起三个。实测 Claude 桌面版 Bash 进程 `IsProcessInJob` = true；libuv 的 `detached` 不加 `CREATE_BREAKAWAY_FROM_JOB`，所以 `service/client.mjs` 的 `spawnService` 拉起的服务在宿主的 Job 里。`Invoke-CimMethod Win32_Process -MethodName Create` 拉起的进程不在 Job 里、同一 SessionId、父进程 WmiPrvSE，`Win32_ProcessStartup.EnvironmentVariables` 能带整份环境（含中文）。
- 服务空闲 10 分钟退出（`service/lib/service.mjs` 的 `IDLE_MS` / `updateIdle`）。上游子进程归 `shared/upstream.mjs` 的 `UpstreamCowart`：断了下次调用自动重连（`client()`），从不主动停。
- 门房 Caddy 的自启：启动文件夹 `LocalhostCaddy.lnk` → `~/.local/caddy/start-hidden.vbs`（WMI 查到同名 vbs 已在跑就退出；`shell.Run(cmd, 0, True)`；退出码 0 结束，否则 60 秒后重起）。不用管理员。
- Codex（codex-cli 0.159.2，本机 `sandbox_mode = "danger-full-access"`）：`in_app_browser`、`hooks` 为 stable。源码 `codex-rs/core/src/exec_env.rs` 给命令设 `CODEX_THREAD_ID`。hook 在 `$CODEX_HOME/hooks.json`（默认 `~/.codex`）：`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"…","timeout":5}]}]}}`；stdin JSON 有 `session_id`、`cwd`、`prompt`；stdout 纯文本追加为模型上下文；新 hook 按 hash 要用户信任一次。`codex queue` 只经共享 daemon，桌面版会话不在 daemon 上。
- 本机 Codex 接法：`~/.codex/config.toml` 的 `[mcp_servers.cowart_mcp]` + `~/.codex/skills/` 下 4 个 junction（`cowart`、`cowart-image-edit`、`cowart-image-gen`、`cowart-open-canvas` → `adapters/codex/skills/*`）。Codex 桥会话 id = `codex-<CODEX_THREAD_ID>`（`codex/lib/bridge.mjs`，清洗 `[^A-Za-z0-9_.-]`、≤ 96）。`codex-imagegen`（`shared/image-models.mjs`，`hosts: ['codex']`）是 `kind: 'image'` 的请求，带 `requiredHost: 'codex'` 走 `server.mjs` 的 `#routeRequest`，由负责会话完成。
- cowart 命令（`claude/lib/cli.mjs`）：`HOST = 'claude'` 写死；`sessionIdFromEnv` 只认 `COWART_SESSION_ID` / `CLAUDE_CODE_HOST_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`；`openResult`、`takeResult`、`requestDetails`、`hostNotes`、`generationNote`、`confirmNote`（`BACKGROUND_NOTICE`）、`usage`、`OTHER_COMMANDS` 都是 Claude 的说法。命令会话在线：`server.mjs` 的 `#touchCommandSession`（`LEASE_MS` 30 分钟）、`#held`、`#keepFor`、`#openAgentStream`。页面：`service.mjs` 的 `renderPage` 用 `PAGE_HOST_LABELS = { zcode: 'ZCode' }`、`imageModelsForHost(PAGE_HOST)`。
- 安装：`claude/scripts/install-skill.mjs`（Claude skill junction + 命令入口）；`cowart install` 只写命令入口（`cli.mjs` 的 `installCommandLink`）；省心版的 Claude skill 由猛兽图书馆装。适配层 0.2.16（`adapters/package.json` 1 处、`package-lock.json` 2 处）；现役服务是 Codex 发布副本 0.2.16。
- Codex 专用的代码（盘点）：`adapters/codex/**`、`generated/cowart-codex-mcp.mjs`、`scripts/switch-codex-entry.mjs`、`scripts/verify-release.mjs`、`service/lib/widget-panes.mjs`、`service/test/widget-transport-test.mjs`，以及 `server.mjs` 的 widget 部分。`make-release-copy.mjs`、`bump-release.mjs` 发同事版还要用。`test:claude` 里 `feedback-test`、`canvas-edit-test`、`page-folders-test`、`context-menu-test`、`requests-test`、`multi-session-test`（`olderCheckout()` 用打包的 Codex 桥当「别的代码目录」）带着 Codex 桥那一腿。页面脚本（`shared/web/service-bridge.js`、`kit.js`、`video-playback.js`）的 `transport` 分支只给 widget 用，但没有页面级自动测试。

## 1. 固定决策（已拍板，执行时不重开）

### 1.1 用户拍板

| # | 决策 |
|---|---|
| U1 | Codex 不再用原生 MCP Apps widget + 每任务 MCP 桥，改走 skill + cowart 命令（同 Claude） |
| U2 | Codex 里画布在 Codex 内置浏览器看：命令给链接，用户点开 |
| U3 | 画布请求到 Codex：UserPromptSubmit hook 在用户发话时提醒，加上用户说「看画布」时去取；Codex 没有监听 |
| U4 | 画布服务常驻：登录自启，不挂在任何宿主进程下；闲时停上游子进程，puppeteer 按需加载 |
| U5 | 自启默认装（`cowart install` 一起装），任务管理器「启动应用」里能禁用 |
| U6 | Codex 原来 4 个 skill 合成 1 个 `cowart` |
| U7 | ZCode 不动，MCP 桥照旧，必须一直能用 |
| U8 | 删掉 Codex widget + MCP 这条线，根 `.mcp.json` / `.codex-plugin/plugin.json` 恢复上游原样；只给 widget 用的上游补丁点本轮不撤 |
| U9 | 阶段子 agent 一律 opus、effort xhigh |

### 1.2 技术决策（委托执行方定，用户只审结论）

| # | 决策 |
|---|---|
| D1 | Windows 上拉起服务改经 WMI `Win32_Process.Create`（ShowWindow 0、整份环境），脱离宿主 Job；WMI 不可用就退回今天的 spawn，记一行日志。不用计划任务：它带不了每次的环境变量，而测试靠环境变量隔离。非 Windows 照旧 |
| D2 | WMI 拉起的服务没有继承的 stdio、拿不到退出码：服务加 `--log <文件>`（自己追加日志），给了 `--log` 时把退出码写进 `<RUNTIME_DIR>/service-exit/<pid>`；`spawnService` 返回的 `exitCode` 改成 getter：活着 null，死了读文件（读后删），没文件 -1 |
| D3 | 自启照门房：`~/.cowart/bin/start-service.vbs`（只跑一份；`"<node>" "<服务入口>" --port 43240 --log "<SERVICE_LOG>"`；退出码 0 / 3 / 4 结束，其它 60 秒后重起）+ 启动文件夹 `CowartCanvas.lnk` + 服务入口 `~/.cowart/bin/cowart-service.mjs`（同命令入口的写法，指向这一份的 `SERVICE_ENTRY`）。install 不当场启动服务 |
| D4 | 空闲退出只对全机画布关掉（`COWART_CANVAS_DIR` 没设就不退）；别的画布照旧 10 分钟；`COWART_SERVICE_IDLE_MS` 优先 |
| D5 | `UpstreamCowart` 闲 180 秒（`COWART_UPSTREAM_IDLE_MS`）且没有调用在跑就关子进程；工具清单缓存保留，下次调用照旧自动拉起 |
| D6 | `web-capture.mjs` 用到时才 `await import('puppeteer-core')` |
| D7 | 会话 = `COWART_SESSION_ID` ‖ `CLAUDE_CODE_HOST_SESSION_ID` ‖ `CLAUDE_CODE_SESSION_ID` ‖ `codex-<CODEX_THREAD_ID>`（同桥的清洗）；host = `COWART_HOST` ‖（有 `CLAUDE_CODE_*` → claude）‖（有 `CODEX_THREAD_ID` → codex）‖ claude。桌面版门禁只管 host claude |
| D8 | Codex 命令会话：它的画布页开着时算 held，页关了按 LEASE 续；hook 每次调用给已知的 Codex 会话续 LEASE；从没跑过命令的 thread 不建会话 |
| D9 | `cowart hook prompt`：读 stdin JSON，会话按 D7（env 没有 `CODEX_THREAD_ID` 才用 stdin 的 `session_id` 加 `codex-`）；只找服务、不拉起，调服务新操作 `hook-check`；有未完的请求就打印提醒，否则不打印；服务没跑、过了 2.5 秒、出任何错都不打印，退出 0 |
| D10 | 提醒只提醒：先答用户这句话；与画布无关时在回复末尾提一句、问要不要做；用户说「看画布」或同意时 `requests` → `request <N>` 照做 |
| D11 | host codex 时命令的文字：open 给可点链接（内置浏览器 / Ctrl+Shift+B），不提监听；`listen` 说明后退出 2；请求详情标题「Codex 宿主说明」，确认规则按 D10；`codex-imagegen` 用 Codex 内置生图，其它模型照 beast-gen；网页复刻用内置浏览器看原网址；按标注修改带 `codex/lib/bridge.mjs` 的 `ANNOTATION_EDIT_NOTE`。不出现 AskUserQuestion、`mcp__Claude_Browser__`、run_in_background |
| D12 | 页面按会话 host：`PAGE_HOST_LABELS` 加 `codex: 'Codex'`，图片模型 `imageModelsForHost(host === 'codex' ? 'codex' : PAGE_HOST)`；传输照旧 HTTP |
| D13 | 安装收进新模块 `claude/lib/install.mjs`：命令入口、服务入口 + 自启、Codex（`CODEX_HOME` ‖ `~/.codex` 存在时：skill junction、清旧 junction、hooks.json 合并写入、删 config.toml 的 `[mcp_servers.cowart_mcp]` 段，改前都备份）。`cowart install` / `uninstall` 和 `install-skill.mjs` 都调它；`install-skill.mjs` 另外照旧链 Claude skill |
| D14 | Codex skill 放 `adapters/claude/codex-skill/cowart/SKILL.md`（`name: cowart`），以 Claude 版为底按 D7–D11 改写，并入旧 Codex skill 里仍适用的生图、按标注改图、打开接管规则；去掉 MCP / widget / requestKey |
| D15 | 根文件只恢复 `.mcp.json`、`.codex-plugin/plugin.json`（`git checkout upstream/main --`），根版本不动，免得重建根产物；`bump-release.mjs` 去掉插件那一半，只升适配层；`make-release-copy.mjs` 只去掉 Codex 入口 |
| D16 | 测试里的 Codex 桥腿换成 Codex 命令会话（`COWART_HOST=codex`），保持三个宿主都测；`multi-session-test` 的「别的代码目录」改用发布产物拷贝里的 `generated/cowart.mjs listen` |
| D17 | S1 把适配层升到 0.3.0，让本仓库的服务换掉现役的 0.2.16 发布副本服务 |

## 2. 每阶段验收协议（profile）

**全量测试组**（PowerShell 工具，在 `C:\WebProjects\Cowart`，一条一调用，timeout 600000，不与其它调用同批；超时就改 `run_in_background` 等通知）：

```
npm --prefix adapters run check:contract
npm --prefix adapters run test:claude
npm --prefix adapters run test:zcode
npm --prefix adapters run test:codex        # S5 删掉之前
npm --prefix adapters run build:artifacts
npm --prefix adapters run check:artifacts
npm --prefix adapters run probe:cold
```

**钉子**（S0 建）：① 全量组在 HEAD 上全绿，逐组记结果；② `service/test/upstream-test.mjs` 钉 `UpstreamCowart` 今日行为；③ `service/test/memory-probe.mjs` 记内存基线。已有的 `test:claude` / `test:zcode` 断言就是 Claude / ZCode 今日行为的钉子。

**钉子变红通则**：红 = 今日行为变了。计划明写的变化 → 记一条偏离后改断言；否则取保住今日行为的改法；都不行 → BLOCKED。**host claude 与 ZCode 的现有断言一律不许改**，除非本计划明写。

**先红后绿的两种红**：行为变化用例只用旧 API 写，在旧代码上必须断言红；纯新 API 用例在旧代码上 import / 解析失败也算红。同一文件先写行为变化用例看它红，再加新 API 用例。

**第 2 关**：完成定义逐条勾 + 两问自查（① 新增的表 / 定时器 / 文件 / 进程 / 安装项，在这些退场出口是否对称清掉：服务 `shutdown()`（stopped / replaced / idle / signal）、`#endSession` / `#forgetEnded`、页面流关闭、`UpstreamCowart.close()`、`uninstall`、测试清理 `stopTestService`；② 新增或改动的循环遍历的是不是快照）+ 偏离写进 [`codex-cli-resident-deviations.md`](codex-cli-resident-deviations.md)（`- <阶段>-<序号> / 做了什么 / 为什么`，≤ 200 字）。范围外发现记 §6「后续观察」一行，不顺手修。

**第 3 关**：无。S7 对累计 diff 整体审一次。

**计划没写到时的默认动作**：host claude 与 ZCode 保住今日行为；Codex 新路径取 §1 最直接的读法 / 最小实现。偏离标 [假设]，绝不问人。

**守卫**（每阶段完成定义都含）：① `git status --porcelain -- src mcp skills package.json package-lock.json plugin.json` 为空；② 开工时记下这些的 `Get-FileHash` / 列表，收工时要一致：`~/.codex/config.toml`、`~/.codex/hooks.json`（可能没有）、`~/.codex/skills/`、`~/.cowart/bin/`、`~/.claude/skills/cowart` 指向、启动文件夹。测试一律用临时目录（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`COWART_COMMAND_LINK`、`COWART_SERVICE_LINK`、`COWART_STARTUP_DIR`、`COWART_RUNTIME_DIR`、`COWART_CANVAS_DIR`）和测试端口，不碰 43240、真画布、真安装。

**提交协议**：单仓 `main`，本地提交、不 push；`git add <显式路径>`，不用 `-A`；改了 `adapters/` 就 `build:artifacts`，`adapters/generated/` 一起提交；提交信息英文 conventional（feat / fix / refactor / test / docs），末行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。§6 状态行随本阶段提交，SHA 用随后一个 docs 提交回填。

**踩坑**：Windows 要 LF 检出（`core.autocrlf false`）；Edit 工具会把混合换行文件（如 `service-bridge.js`）统一成多数换行，提交前比 `git diff --stat` 和 `git diff --ignore-cr-at-eol --stat`，不一致就按 HEAD 恢复换行；Write 工具把 `\uXXXX` 写成真字符（正则里用 `String.fromCharCode`）；Bash heredoc 吃双反斜杠；联调别占 43290；同一工作区有别的会话在改时，测试和提交搬到 detached worktree。

**人工验收**：各阶段不停链，统一列在 S7，S7 状态行写「待人工验收」。

## 3. 阶段

### S0 钉子先行

**改法**：不改 `adapters/` 的非测试源码。① HEAD 上跑全量组，逐组结果进 §6 备注。② 新 `adapters/service/test/upstream-test.mjs`（`test:upstream`，接到 `test:claude` 末尾）：直接 `new UpstreamCowart(...)`，`COWART_CANVAS_DIR` 设临时目录；子进程用 `Win32_Process`（ParentProcessId = 本进程、命令行含 `cowart-mcp.mjs`）找。钉：(a) `listTools()` 后杀掉子进程，下一次 `callTool('get_cowart_canvas_state', {})` 成功；(b) 两个并发 `callTool` 只起一个子进程；(c) `close()` 后子进程没了。③ 新 `adapters/service/test/memory-probe.mjs`（`probe:memory`，不进 `test:claude`）：测试端口 43397 / 43398、临时 `COWART_RUNTIME_DIR`，空画布一轮，真画布 `pages/**/*.json` 拷到临时目录一轮（没有真画布就跳过）；打印两个进程的工作集 / 提交内存：刚起、5 次 `get_cowart_canvas_state` + 20 次 `pages` 后、杀掉子进程 15 秒后。
**完成定义**：全量组全绿；`test:upstream` 连跑 3 次绿；`probe:memory` 的数字进 §6 备注；守卫空。
**钉子**：本阶段即钉子。**测试**：无新行为。**规则之家**：`FORK.md` 目录节 `service/test/` 那行补 upstream-test、memory-probe 各半句。

### S1 服务省内存、全机画布不空闲退出（D4 D5 D6 D17）

**改法**：① `shared/upstream.mjs` `UpstreamCowart`：构造参数加 `idleMs`（默认 `Number(process.env.COWART_UPSTREAM_IDLE_MS) || 180_000`）和 `onIdleClose`；私有 `#inFlight`、`#idleTimer`；`callTool` 和 `listTools` 真用到子进程的部分用 try/finally 计数，归零时 `setTimeout(...).unref()`，到点仍是 0 才关子进程（关法同 `close()`，不清 `#tools`），新调用开始时清定时器；`close()` 清定时器。`service.mjs` 传 `onIdleClose: () => log('upstream Cowart server stopped (idle)')`。② `shared/web-capture.mjs` 去掉顶层 `import puppeteer from 'puppeteer-core'`，在启动浏览器处 `const { default: puppeteer } = await import('puppeteer-core')`。③ `service/lib/service.mjs`：`IDLE_MS` 换成导出的纯函数 `serviceIdleMs(env = process.env)`（`COWART_SERVICE_IDLE_MS` > 0 用它；`COWART_CANVAS_DIR` 没设 → `Infinity`；否则 600000），模块顶层算一次（在 `startCanvasService` 改写 `COWART_CANVAS_DIR` 之前）；`updateIdle` 遇 `Infinity` 不建定时器；文件头注释改说法。④ `adapters/package.json`、`adapters/package-lock.json` 版本 0.2.16 → 0.3.0（共 3 处）。
**完成定义**：`rg "^import puppeteer" adapters/shared/web-capture.mjs` 零命中；新用例绿；全量组绿；`probe:memory` 刚起时的提交内存低于 S0（数字进 §6）；守卫空。
**钉子**：沿 S0（upstream-test a–c 照旧绿）。
**测试**：upstream-test 加 (d)【行为变化】`idleMs: 500`，调用完 1.5 秒后子进程不在了，再调用成功；(e)【行为变化】子进程被闲时关掉后再 `listTools()` 不起子进程。新 `service/test/resident-test.mjs`（`test:resident`，接进 `test:claude`）：(f)【纯新 API】`serviceIdleMs({})` = Infinity，`{COWART_CANVAS_DIR:'x'}` = 600000，`{COWART_SERVICE_IDLE_MS:'5000'}` = 5000。
**规则之家**：`FORK.md`「画布服务」的「空闲退出」一条按 D4 改写，加一句上游子进程闲时停、puppeteer 按需。

### S2 脱离宿主拉起 + 开机自启（D1 D2 D3）

**改法**：① 新 `service/lib/launch.mjs` 的 `launchDetached({ execPath, args, cwd, env })`：非 Windows 返回 null；Windows 用 `spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command','-'], { input: 脚本, env: { ...process.env, COWART_LAUNCH: base64(JSON{ commandLine, cwd, env: ['K=V'…] }) }, timeout: 15000, windowsHide: true })`。脚本解出参数，`New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly`（ShowWindow 0、EnvironmentVariables）+ `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`，输出 `{"ret":…,"pid":…}`；ret ≠ 0 或任何异常返回 null，成功返回 `{ pid }`。命令行按 Windows 规则逐个参数加引号。② `service/client.mjs` `spawnService`：Windows 先 `launchDetached`（参数加 `--log SERVICE_LOG`，env 用 `serviceEnv()`，cwd 用 `REPO_ROOT`），成功返回 `{ pid, get exitCode() }`（D2，读 `RUNTIME_DIR/service-exit/<pid>`）；失败就照今天 spawn，并往日志写一行 `launch via WMI failed, spawned directly`。日志轮转从 `openServiceLog` 拆成 `rotateServiceLog()`，两条路都先调；拉起前删掉 `service-exit/` 里一天前的文件。③ `service/bin/cowart-service.mjs`：`--log <文件>` 时，在 import 服务之前 `openSync(文件, 'a')`，把 `process.stdout.write` / `process.stderr.write` 换成 `writeSync` 包装（保留 callback），并 `process.on('exit', code => 同步写 RUNTIME_DIR/service-exit/<pid>)`。④ 新 `claude/lib/install.mjs`：从 `cli.mjs` 搬入 `linkTarget`、`installCommandLink`、`removeCommandLink`（`cli.mjs` 改成 import，导出名不变）；新增 `installServiceAutostart()` / `removeServiceAutostart()`（D3；`COWART_SERVICE_LINK`、`COWART_STARTUP_DIR` 可改位置；lnk 由 PowerShell `WScript.Shell.CreateShortcut` 写，TargetPath `wscript.exe`，Arguments 是 vbs 路径；非 Windows 返回 `{ skipped }`）；`installCowart()` / `removeCowart()` 依次调命令入口和自启，返回逐行说明。⑤ `cli.mjs` 的 `install` / `uninstall` 和 `claude/scripts/install-skill.mjs` 改调 `installCowart()` / `removeCowart()`，`OTHER_COMMANDS` 里 install 的说明跟着改。
**完成定义**：resident-test 新用例绿；`multi-session-test`（版本替换）和 `stop-test` 照旧绿；临时目录里 install 写出 lnk、vbs、服务入口，uninstall 全删；全量组绿；守卫空。
**钉子**：沿 S0；multi-session 的替换场景照旧绿，即改走 WMI 后替换行为不变。
**测试**：resident-test 加 (g)【行为变化】经 `CanvasServiceClient` 在测试端口拉起服务，服务进程 `IsProcessInJob` 为 false（测试进程自己不在 Job 里时跳过并打印原因）；(h)【行为变化】服务的父进程不是拉起它的进程；(i)【纯新】`--log` 写日志，端口被占时退出码 3 经文件读回；(j)【纯新 API】`installServiceAutostart` / `removeServiceAutostart`：lnk 存在，vbs 含 node 绝对路径、`--port 43240`、`--log`，uninstall 后都没了。
**规则之家**：`FORK.md`「画布服务」「全机一个」条里「后台拉起（detached…）」改成经 WMI，写明 Job 的原因；加「开机自启」一条（D3）。

### S3 cowart 命令认 Codex 会话（D7 D8 D11 D12）

**改法**：⓪ 先实测一次（不写真 `~/.codex`）：`codex exec --skip-git-repo-check --dangerously-bypass-hook-trust -c mcp_servers.cowart_mcp.enabled=false -c '<UserPromptSubmit hook 指向一个临时 probe 脚本>' "Run: node -e \"console.log(process.env.CODEX_THREAD_ID)\" and reply with its output only."`。probe 把 stdin 和自己的 `CODEX_THREAD_ID` 写进临时文件。比较三者，结论进偏离记录。shell 里没有 `CODEX_THREAD_ID` → BLOCKED（附证据）；`codex exec` 跑不通 → 跳过实测，§6 后续观察记一行。① `claude/lib/cli.mjs`：`HOST` 常量换成导出的 `hostFromEnv(env)`（D7），`sessionIdFromEnv` 加 `CODEX_THREAD_ID`；`newClient` 和 `listen` 的 query 用它；门禁只在 host claude 时查；缺会话标识的报错按 host。② 文字按 host，只加 codex 分支，claude 分支一字不改：`openResult` / `takeResult`、`requestDetails` 标题、`hostNotes` / `generationNote` / `confirmNote`（codex 不用 `BACKGROUND_NOTICE`，按 D10；按标注修改带 `ANNOTATION_EDIT_NOTE`，复制进 `claude/lib/request-notice.mjs` 导出）、`usage` 首行、`OTHER_COMMANDS` 的 listen 说明；`listen` 在 host codex 时打印「Codex 不用 listen：…」并退出 2。③ `service/lib/server.mjs`：`#held` 加 `|| (session.cli && session.host === 'codex' && session.pages.size > 0)`；`#openPageStream` 的 close 里，该会话 `cli` 且不再 held 时 `#keepFor(session, LEASE_MS)`；`#deliver` / `#presence` 不动。④ `service/lib/service.mjs` `renderPage`：D12。
**完成定义**：只设 `CODEX_THREAD_ID=<uuid>`（没有 `CLAUDE_*`、`COWART_SESSION_ID`）跑 `open` 退出 0，`--status` 里会话 id `codex-<uuid>`、host codex、cli true；codex 的 open 文字含「内置浏览器」，不含「Browser 面板」「run_in_background」「AskUserQuestion」；`listen` 退出 2；Claude 的 smoke 断言一字未改且绿；全量组绿；守卫空。
**钉子**：沿 S0；Claude 文字断言不许改。
**测试**：新 `claude/scripts/codex-cli-test.mjs`（`test:codex-cli`，接进 `test:claude`，端口 43391）：(k)【行为变化】只设 `CODEX_THREAD_ID` 跑 `open`，旧代码退出 2；(l) codex 的 open / take / request 文字；(m)【行为变化】Codex 会话的画布页事件流（照 test-kit 的 `openEvents`）开着时，过了 `COWART_SESSION_LEASE_MS=1000` 仍 online，页关后约 1 秒变 ended；(n) codex 会话的页面 HTML 里 hostLabel 为 Codex，图片模型含 `codex-imagegen`。
**规则之家**：无（宿主说法集中在 S6 改）。

### S4 Codex 的 hook、skill 与安装（D9 D10 D13 D14）

**改法**：① `cli.mjs` 新命令 `hook prompt`（登进 `OTHER_COMMANDS`，在门禁和会话检查之前处理）：按 D9，用 `client.mjs` 的 `findService` + `loadOrCreateToken` 直接 POST `/api/bridge/call`（`{ session, op: 'hook-check', cli: true, host: 'codex' }`）；整体 2.5 秒定时器到点 `process.exit(0)`；提醒文字按 D10，列编号、标题、来自哪页，写全 `requests` / `request <N>` 命令（`cowartCommand()`）。② `server.mjs` `#bridgeCall` 加 `case 'hook-check'`：`this.#sessions.get(id)`（不建）；没有 → `{ requests: [] }`；有且 `cli` → `#touchCommandSession(session, 'codex')`；返回该会话非终态、`executor !== 'service'` 的请求 `{ id, title, pageName, status }`，不标送达。③ 新 `adapters/claude/codex-skill/cowart/SKILL.md`：按 D14。④ `install.mjs` 加 `installCodex()` / `removeCodex()`，接进 `installCowart()` / `removeCowart()`：`codexHome()` = `CODEX_HOME` ‖ `~/.codex`，不存在就跳过。skill junction `<home>/skills/cowart` → codex-skill：指向别处的链接改指，真实目录不动、报一行。`<home>/skills/` 下 `cowart-image-edit` / `cowart-image-gen` / `cowart-open-canvas`，只删「是链接且指向某个 `adapters/codex/skills/`」的。hooks.json 合并：认 command 里同时有 `cowart` 和 `hook prompt` 的条目，替换不重复；JSON 坏了就不动、报一行；command = `"<node 绝对路径>" "<命令入口>" hook prompt`，`timeout: 5`。config.toml 删 `[mcp_servers.cowart_mcp]` 及其子表（删到下一个不以 `[mcp_servers.cowart_mcp` 开头的表头为止），保留原换行。改任何文件前备份成 `<文件>.bak-cowart-<YYYYMMDDHHMMSS>`。uninstall 删 skill 链接（指向本份的）和 hook 条目（先备份），不恢复 MCP 段。
**完成定义**：临时 `CODEX_HOME` 里：install 后 skill 链接对，旧三个链接没了（真实目录留着），hooks.json 恰有一条 cowart hook（install 两次仍一条），别的 hook 原样，config.toml 没有 cowart_mcp 段而其余字节不变，备份在；uninstall 后 hook 条目和链接没了；`hook prompt`：服务没跑时 2.5 秒内无输出、退出 0，有待处理请求时输出含编号和「看画布」，没有时无输出，不认识的 thread 不出现在 `--status`；全量组绿；守卫空。
**钉子**：沿 S0、S3。
**测试**：codex-cli-test 加（都是纯新 API）：(o) hook 的四种情况；(p) install / uninstall 的 Codex 部分，夹具含已有别的 hook 的 hooks.json、带子表的 cowart_mcp 段的 config.toml。
**规则之家**：无（S6 统一改）。

### S5 删掉 Codex widget + MCP（D15 D16）

**改法**：① 先搬再删：`service/test/widget-transport-test.mjs` 里「撤销时请求已不在 / 已开始（410）」用例搬进 `service/test/requests-test.mjs`，「client start 等会话 hello」用例搬进 resident-test（把 `widget-poll` 换成 `pages`）；`adapters/codex/scripts/client-test.mjs` 里只测 `src/cowartClient.js` 的用例搬成 `service/test/page-client-test.mjs`（接进 `test:claude`）。搬过来的先在旧代码上跑绿。② 删：`adapters/codex/` 整个目录、`adapters/generated/cowart-codex-mcp.mjs`、`adapters/scripts/switch-codex-entry.mjs`、`adapters/scripts/verify-release.mjs`、`service/lib/widget-panes.mjs`、`service/test/widget-transport-test.mjs`。③ `service/lib/server.mjs` 删 widget：`WidgetPanes` import、`WIDGET_LEASE_MS`、`DELIVERY_LEASE_MS`、`PAGE_ACTIONS` 的 `/api/requests/claim` `/delivered` `/release`；字段 `#widgets` `#widgetViews` `#deliveryClaims` `#deliveryReceipts`，以及它们在构造、queue changed、`close()`、`pageCount`、`status()` 里的用法；`#pageAction` 的 `widget` 参数、`save_cowart_view_state` 拦截、`viewState` / `sessionViewState` 注入、`onlyIfFree`、claim / delivered / release 分支；方法 `#clearDeliveryClaim` `#widgetDelivery` `#touchWidget` `#expireWidget`；`#forgetEnded` 的 widgets 条件；`#presence` 改成 `Boolean(session.listener)`；`#deliver` 的 codex 早退；`#broadcastPresence` / `#broadcastCanvas` / `#revealPut` 里的 widget 广播；`#bridgeCall` 的 `widget-call` / `widget-poll`；`#openCanvas` 里 widget 的 paneOpen、视图清除、goto-page。保留 `/api/bridge/session`（ZCode）、`/api/requests/cancel`（含 requestKey / 410）、`requiredHost`、`request-get` / `request-reply` 的 requestKey 检查。④ `scripts/build-artifacts.mjs` 删 `cowart-codex-mcp.mjs` 入口、`.codex-plugin/plugin.json` 资源、`adapters/codex/web` 文件；`scripts/probe-cold-install.mjs` 删 Codex 那段和用不上的 MCP Client import，断言改成 CLI 自己拉起服务；`scripts/make-release-copy.mjs` 的 `extra` 去掉 `adapters/codex/bin/start.mjs`；`scripts/bump-release.mjs` 按 D15 去掉插件那一半（`PLUGIN_FILES`、`+codex.<stamp>`），用法注释跟着改。⑤ `adapters/package.json` 删 `test:codex`，description 去掉 Codex 桥。⑥ 根目录 `git checkout upstream/main -- .mcp.json .codex-plugin/plugin.json`。⑦ 测试按 D16：`feedback-test`、`canvas-edit-test`、`page-folders-test`、`context-menu-test`、`requests-test` 的 Codex 腿改成 Codex 命令会话（`cliSession` 带 `env: { COWART_HOST: 'codex' }`；context-menu 那步改走 host codex 的 HTTP 页面）；`test-kit.mjs` 删 `CODEX_BRIDGE`；`multi-session-test` 的 `olderCheckout()` 改用发布产物拷贝里的 `generated/cowart.mjs listen`（每个带不同 `COWART_SESSION_ID` 的 listen 算一个长连客户端），场景和断言不变。
**完成定义**：`adapters/codex` 不存在；`rg -l "cowart-codex-mcp|codex/bin/start|WidgetPanes|widget-poll|widget-call|CODEX_BRIDGE" adapters -g '!node_modules' -g '!generated/**' -g '!shared/web/**'` 零命中；`git diff upstream/main -- .mcp.json .codex-plugin/plugin.json` 为空；全量组（不含 test:codex）绿；测试数只少了 Codex 桥 / widget 专用的（数目和名字进备注）；守卫空。
**钉子**：沿 S0；ZCode 断言一字不改；页面脚本不动（§4）。
**测试**：搬来的 410、hello、page-client 用例照旧绿；Codex 腿改成命令会话后绿。
**规则之家**：无（S6）。

### S6 文档（docs）

**改法**：`FORK.md` 改写：开头和开发准则（Codex 不再是 MCP 薄桥）；目录（删 `codex/` 块和 Codex 发版脚本，加 `claude/lib/install.mjs`、`claude/codex-skill/`、`service/lib/launch.mjs`、新测试）；分支与同步（删 marketplace / cachebuster / verify-release / switch-codex-entry，bump-release 只升适配层）；接缝 1 / 5；宿主差异表的 Codex 列（命令 + 内置浏览器 + hook 提醒 + 「看画布」）；「Claude Code 改走 skill + 命令」加一段 Codex 也改走（2026-10-23，为什么：桥的内存、被宿主连带杀、widget 维护）；「画布服务」相关各条（会话、版本替换里的发布副本历史留作历史，「Codex 媒体加载」整条删）；「Codex 任务切换与恢复」整节换成两三句历史说明；反馈 / 画布整理 / 右键 / 页的文件夹里「三个宿主」的说法；「注意」里插件 skills 一条；补丁点清单删 `.mcp.json` / `.codex-plugin` 一行，`widget-resource.mjs` 等只给 widget 用的行注明「待撤」。另改 `adapters/claude/README.md`（命令也给 Codex 用、install 装什么）、`adapters/claude/beast-library/INSTALL.md`（install 会装开机自启和 Codex 的 skill + hook；去掉 cowart_mcp 的说明）、`adapters/claude/skills/cowart/SKILL.md` 和 `adapters/zcode/skills/cowart/SKILL.md` 里提到 Codex widget 的字样（「Codex 口吻」的说明不改）。
**完成定义**：`rg -n "adapters/codex|cowart-codex-mcp|verify-release|switch-codex-entry|MCP Apps widget|原生 widget" FORK.md adapters -g '*.md' -g '!node_modules'` 只剩标明历史或待撤的句子（逐条列进备注）；FORK.md 里写到的仓内路径逐个 `Test-Path` 都在；全量组绿；守卫空。
**钉子**：无（只改文档）。**测试**：无。**规则之家**：本阶段即规则之家。

### S7 整体审与收口

**改法**：对 S1–S6 累计 diff（`git diff <S0 的 SHA>..HEAD`）开 2 个子 agent 审（opus、xhigh；① 正确性与回归：Claude / ZCode 行为、版本替换、Job 外拉起、退出码、hook 不拖住发话；② 退场对称与资源：定时器、子进程、退出码文件、备份文件、hook 条目、安装 / 卸载对称），修 ≥ medium 和零风险的 low，不采纳的记后续观察；退役词扫尾（同 S6 的 rg）；再跑一次 `probe:memory`，数字进备注。§6 S7 行写「待人工验收」，清单：1) 真装 `node adapters/claude/scripts/install-skill.mjs`，看输出和备份；2) `npm --prefix adapters run service:stop` 后双击启动文件夹的 CowartCanvas（或注销重登），服务起来，「启动应用」里有它；3) 开关 Claude、Codex 会话、重启 Codex 后 `service:status` 的 pid 不变；4) 右键「在资源管理器中显示」「拷贝索引」照常；5) Codex 桌面版新任务：信任 hook，说「打开 Cowart 画布 <页名>」，链接在内置浏览器打开，`put` 能放东西（画布请求不手点）；6) 闲 5 分钟后画布服务只剩一个 node、约 65 MB。
**完成定义**：全量组绿；审查采纳 / 不采纳条数进备注；守卫空。

## 4. 明确不做（本轮认可，勿重开）

- 撤回只给 widget 用的上游补丁点（`src/App.jsx`、`src/cowartClient.js`、`mcp/lib/widget-resource.mjs`），以及页面脚本（`service-bridge.js`、`kit.js`、`video-playback.js`）里的 `transport` 分支和 `media-assets.mjs` 分段读：没有页面级自动测试兜底，改 `src/` 还要重建根产物，单独一轮。
- ZCode 改走命令；主动叫醒 Codex（`codex queue`、app-server daemon）；Mac / Linux 开机自启；V8 参数调优；换掉 MCP SDK 客户端。
- 发版：push、bump 后发同事版、其它机器、删 `~/.cowart/releases` 旧副本、真机 install。用户收工后做。

## 5. 启动指令

两种方式等价，都是每阶段一个 fresh context：逐阶段开新会话粘贴「阶段 prompt」，或对一个会话说 `/plan-runner docs/plan/codex-cli-resident.md` 按序派子 agent。总控须开 bypass permissions，电脑不能睡眠，无人值守期间不 push。子 agent：model opus、effort xhigh。

**总控 prompt**：

```
你是「Codex 改走 cowart 命令 + 画布服务常驻」的总控，只派活不干活。读 C:\WebProjects\Cowart\docs\plan\codex-cli-resident.md 的 §5 与 §6 状态表，找到第一个状态不是「已完成」的阶段（顺序 S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7）。派活前先核该阶段：改法具体到文件 / 符号、完成定义可机械核对、钉子与测试写明、规则之家有写、§2 有「没写到时的默认动作」、计划与偏离记录在 docs/plan/、§5 已填实；缺项就停下逐条报给用户，不自己补计划、不读源码找证据。再核工作区：git -C C:\WebProjects\Cowart status --porcelain 干净、在 main；用 ListAgents（没有就看 git worktree list）看同一工作区有没有别的会话在改代码，有就在阶段 prompt 末尾追加「提交只走显式路径；全量验收搬隔离 worktree」。然后用 Agent 工具派一个子 agent：subagent_type general-purpose，model opus，effort xhigh，run_in_background false（工具不允许长阻塞就改 true，收到完成通知再继续），prompt 用 §5「阶段 prompt」原文填入阶段号。子 agent 返回后核四项：读它的回报；跑 git -C C:\WebProjects\Cowart log -2 --oneline 核对有本阶段的 commit；读 §6 确认该行已填「已完成」（S7 是「待人工验收」）；跑 git -C C:\WebProjects\Cowart status --porcelain -- src mcp skills package.json package-lock.json plugin.json 确认为空。四项都对就派下一阶段；回报是 BLOCKED、核对不符、或该行写「待人工验收」就停链，把回报原样转给用户，列出已完成与卡住的阶段。全部完成后汇总并附 push 命令（git -C C:\WebProjects\Cowart push origin main，由用户执行）。你自己不读源码、不跑测试、不改文件、不 push；不把两个阶段合给一个子 agent；子 agent 的问题你不替它决定，它按 §2 无人值守策略自己定。
```

**阶段 prompt**（填 `<n>`）：

```
你在 C:\WebProjects\Cowart（单仓，分支 main，Windows；上游文件 src/ mcp/ 根 skills/ 冻结）执行「Codex 改走 cowart 命令 + 画布服务常驻」的阶段 S<n>。先读 docs/plan/codex-cli-resident.md（§0 事实、§1 固定决策不重开、§2 验收协议、§3 你的阶段、§4 不做、§6 状态表与后续观察中提到本阶段的条目），再读 CLAUDE.md 和 FORK.md（开发准则、目录、补丁点、注意）。开工前 git status --porcelain 须干净且在 main，并按 §2 守卫②记下真安装的哈希 / 列表。工序：钉子先行 → 新行为测试先红后绿（行为变化用例断言红；纯新 API 用例 import 失败算红，同文件先看行为用例红再加）→ 改代码 → 第 1 关（§2 全量测试组，逐条单独调用）→ 第 2 关（完成定义逐条 + 两问自查）→ 规则之家 → 一个 commit（不 push，git add 显式路径，含 adapters/generated/）→ §6 状态行随这个 commit（SHA 用随后一个 docs 提交回填）。无人值守：不问人；计划没写到的选择取 §2 的默认并在偏离记录标 [假设]；第 1 关修复最多 2 轮，仍红即 BLOCKED（不 commit、不 stash、工作区原样留下，§6 状态行写 BLOCKED + 原因 + 建议）。只做本阶段范围，范围外发现记 §6 后续观察一行，不顺手修。src/ mcp/ 根 skills/ 根 package.json package-lock.json plugin.json 一行不许改；不碰 43240 上的服务、真画布和真安装（~/.codex、~/.claude/skills、~/.cowart/bin、启动文件夹）。回报不超过 15 行：DONE / BLOCKED / 待人工验收、SHA、测试数变化、偏离条数、后续观察条数、阻塞原因。
```

## 6. 状态与偏离记录

| 阶段 | 状态 | SHA | 备注 |
|---|---|---|---|
| S0 钉子先行 | 已完成 | 9f97c5c | HEAD 3fbf866 全绿：contract OK、test:claude 100 PASS + 6 node:test、zcode 12、codex 25 + 26、build 无 diff、check OK、cold 4；加 upstream-test 后 test:claude 103 + 6，test:upstream 连跑 3 次绿；内存（WS / 提交，服务 + 上游）空画布刚起 143 / 150 MB、读后 146 / 185、杀子进程 15 秒后服务 61 / 69；真画布 50 页刚起 146 / 152、读后 267 / 286、杀后 60 / 67；守卫空；两问自查：测试的子进程、服务、临时目录都在 finally 清掉，循环遍历的都是快照 |
| S1 省内存、不空闲退出 | 未开始 | | |
| S2 脱离宿主拉起 + 开机自启 | 未开始 | | |
| S3 命令认 Codex 会话 | 未开始 | | |
| S4 Codex 的 hook、skill 与安装 | 未开始 | | |
| S5 删掉 Codex widget + MCP | 未开始 | | |
| S6 文档 | 未开始 | | |
| S7 整体审与收口 | 未开始 | | |

> 备注列只写验收摘要一行（各组结果 / 测试数变化 / 内存数字 / 守卫 / 两问自查一句），偏离内容在 deviations 文件。

**后续观察**（范围外发现记一行，不顺手修）：

- 
