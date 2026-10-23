# Codex 改走 cowart 命令 + 画布服务常驻——偏离记录

> 配套 [`codex-cli-resident.md`](codex-cli-resident.md) §2 第 2 关。每阶段执行方在此追加；格式 `- <阶段>-<序号> / 做了什么 / 为什么`，每条 ≤ 200 字；「影响」只在会改变后续阶段时写；锚点写符号不写 file:line；计划没写到而自己定的写法标 `[假设]`。范围外发现不写这里，记计划 §6「后续观察」。

## S0 钉子先行

- S0-1 / upstream-test 的 `upstreamServers()` 排除查询自己的 PowerShell（`$PID`）/ 它是本进程的子进程、命令行也含 `cowart-mcp.mjs`，不排除就多数一个。影响：S1 加 (d)(e) 照用这个函数。
- S0-2 / [假设] upstream-test 在非 Windows 用 `ps -A -o pid=,ppid=,args=` 找子进程 / 计划只写了 Win32_Process，取最小实现让测试在别的系统也能跑。
- S0-3 / [假设] memory-probe 只在 Windows 量（别处打印跳过、退出 0）；「提交」取 `Get-Process` 的 PrivateMemorySize64；调用走 cowart 命令（`call get_cowart_canvas_state`、`pages`）；真画布只拷 pages 下的 JSON、跳过 assets / 计划没写到，取最直接的实现。

## S1 省内存、全机画布不空闲退出

- S1-1 / [假设] `serviceIdleMs` 把空串的 `COWART_CANVAS_DIR` 也算没设（Infinity），`COWART_SERVICE_IDLE_MS` 不大于 0（含负数）时不用它 / 跟 `paths.mjs` 的 `COWART_CANVAS_DIR || 默认画布` 一致；旧写法负数会变成立刻退出。
- S1-2 / [假设] `UpstreamCowart` 的 `idleMs` 不是有限正数（Infinity、0）就从不闲停；`onIdleClose` 只在真关掉了子进程时调；定时器回调吞掉异常 / 计划没写到，取最小实现，免得 Infinity 进 setTimeout 变成 1ms、日志回调出错打崩服务。
- S1-3 / [假设] 规则之家之外顺带改了 `adapters/claude/README.md` 环境变量那行（`COWART_SERVICE_IDLE_MS` 默认值、加 `COWART_UPSTREAM_IDLE_MS`）/ 那行写的正是本阶段改掉的默认值，留到 S6 会错两个阶段。

## S2 脱离宿主拉起 + 开机自启

- S2-1 / (g) 不查服务的 `IsProcessInJob`，改查测试所在宿主 Job 的进程列表（经 cmd 起的 PowerShell 调 `QueryInformationJobObject(NULL)`），断言服务不在其中 / 实测 Node 一拉起非 detached 子进程，libuv 就把自己放进自建的 Job，服务起了上游子进程后恒为 true，计划的判据分不出宿主的 Job。
- S2-2 / [假设] `--log` 时服务先轮转那个日志（> 5 MB 改名 `.1`），并用 `uncaughtExceptionMonitor` 把崩溃栈写进日志 / 开机自启那条路没有命令替它轮转；Node 崩溃时直接写 fd 2、不经 `process.stderr.write`，不记就丢。
- S2-3 / [假设] 服务入口指向的不在了就退出 0（命令入口是 2）；vbs 先查 node 和服务入口在不在、不在就安静退出，工作目录设成 `REPO_ROOT`（同 `spawnService`），存成 UTF-16 带 BOM / 免得每分钟重试不存在的东西或登录时弹脚本错误框；中文路径在 ANSI 下会乱。
- S2-4 / [假设] 启动文件夹默认问 Windows（`GetFolderPath('Startup')`），问不到才用 `%APPDATA%` 下的；uninstall 只在服务入口指向这一份或不存在时删三样 / 启动文件夹可能被挪进 OneDrive；同命令入口「别的 checkout 的不动」。
- S2-5 / [假设] `installCowart` / `removeCowart` 返回 `{ ok, lines }`，有一部分失败时 `install` / `uninstall` 退出 1（以前 uninstall 一律 0）；两者首行不变 / 计划只写「逐行说明」；首行不变，INSTALL.md 的说法和 smoke 断言照旧对。
- S2-6 / [假设] test-kit 给会话加临时的 `COWART_SERVICE_LINK` / `COWART_STARTUP_DIR`（`finish` 删），probe:cold 的 install 也指进沙箱并断言写出打包的服务入口和 lnk；`stopTestService` 停完删那个服务的退出码文件 / smoke、probe:cold 都跑 install，不隔离会写真安装（守卫②）。
- S2-7 / [假设] `launchDetached` 多一个 `onFailure`（原因写进日志那行的括号）；`cli.mjs` 从 install.mjs 转出 `ENTRY` / `COMMAND_LINK` / `installCommandLink` / `removeCommandLink`，`install-skill.mjs` 直接 import install.mjs / 计划没写到，取最小实现。

## S3 cowart 命令认 Codex 会话

- S3-1 / ⓪ 实测（`codex exec --json`，hook 用 `-c hooks.UserPromptSubmit=…` 给）：thread_id = shell 的 `CODEX_THREAD_ID` = hook stdin 的 `session_id`；hook 进程没有 `CODEX_THREAD_ID`。影响：S4 的 hook 必走 stdin 的 `session_id`（D9 已如此）。
- S3-2 / [假设] 关页续 LEASE 只在「关前 held、关后不 held」时做（即只有 Codex 命令会话）/ 字面「cli 且不再 held」会让 Claude 命令会话关页时把监听断开后 2 分钟的宽限拉成 30 分钟，违背保住 Claude 今日行为。
- S3-3 / [假设] codex 的 `requests` 行由 `requestNotice` 的新选项 `host` 给（Claude / ZCode 不传），`requests` / `reply` 不附「重启监听」，open 结果不带 `listenCommand` / D11 不许出现 AskUserQuestion 等，计划只点名 open / take / request。
- S3-4 / [假设] `hostFromEnv` 把 `COWART_HOST` 去空白、转小写，只有 codex 换说法；host codex 的 `listen` 在会话检查之前就退出 2 / 计划没写到，取最小实现。
- S3-5 / [假设] test-kit 的 `sessionEnv` 去掉继承的 `CODEX_THREAD_ID`；codex-cli-test 用临时 `COWART_RUNTIME_DIR`，(m) 先开页面流再 open，另加 D7 单元、不受门禁两个用例 / 在 Codex 任务里跑检查时 Claude 会话会被认成 Codex；LEASE 1 秒下 open 到开页可能超时。

## S4 Codex 的 hook、skill 与安装

- S4-1 / [假设] `hook-check` 在 `/api/bridge/call` 入口就分开：只 `#sessions.get`、跳过通用的 cli 续租，`#bridgeCall` 收到 null 会话回空 / 入口先 `#session(id)` 会建会话，等不到 `#bridgeCall` 的 case。
- S4-2 / [假设] config.toml 只删表头是 `mcp_servers.cowart_mcp` 或 `mcp_servers.cowart_mcp.…` 的表（去掉空白和引号再比），`[mcp_servers.cowart_mcp_two]` 留着 / 字面「以 `[mcp_servers.cowart_mcp` 开头」会删掉名字恰好以它开头的别的服务。
- S4-3 / [假设] hooks.json：第一条 cowart hook 原地替换，多的删、只装它的组删；内容不变就不写不备份；同一秒已有备份名就加 `-2`；容 BOM；不是 JSON 或认不出 `hooks.UserPromptSubmit` 数组就不动、报一行 / 计划只写「替换不重复、坏了不动」，取最小、不多留备份的写法。
- S4-4 / [假设] hooks.json 坏了、`skills/cowart` 是真实目录时 install 退出 1；没有 Codex 主目录只报一行、退出 0 / 照 S2-5「有一部分没装上就退出 1」。
- S4-5 / [假设] uninstall 只在命令入口已删或指向本份时删 hook；`UserPromptSubmit` 删空就去掉这个键 / 照 S2-4「别的 checkout 的不动」：入口还指向别的 checkout 时 hook 照样能用。
- S4-6 / [假设] `build-artifacts` 把 `adapters/claude/codex-skill/**` 列进发布清单的 resources，probe:cold 给沙箱建 Codex 主目录、断言链接和 hook 指向发布副本 / 不然从发布副本（省心版）install 没有 Codex skill 可链。
- S4-7 / [假设] test-kit 的会话环境给一个从不建的 `CODEX_HOME`（smoke 的 install），probe:cold 用沙箱里的 / 守卫②：install 现在会写 Codex 主目录。
- S4-8 / [假设] 导出 `hookSessionId(env, input)`、`hookReminder(requests, cli)`；提醒每条带自己的 `request <N>` 命令，running 的注明做完回 done / failed；`hook` 后面不是 `prompt` 就打用法、退出 2 / 计划没写到，取最小实现。
- S4-9 / 核对了 hook 命令在 Windows 怎么跑：codex-rs `hooks/src/engine/command_runner.rs` 用 `cmd.exe /C` 加 raw 的外层引号，D9 的 `"<node>" "<入口>" hook prompt` 原样到得了 / 计划定了格式，cmd /C 的去引号规则可能吃掉它。

## S5 删掉 Codex widget + MCP

- S5-1 / build-artifacts 保留 `.codex-plugin/plugin.json` 资源（计划 ④ 写删）/ 上游 MCP 子进程启动时就读它（`mcp/server.mjs` 的 `pluginManifest`），发布副本缺了它上游起不来，probe:cold 和省心版都会坏；文件本身照 D15 恢复成上游原样。
- S5-2 / [假设] `media-assets-test` 从删掉的 `test:codex` 挪进 `test:claude` 的 `node --test` / 它测的 `media-assets.mjs` 按 §4 保留，不挪就没人跑。
- S5-3 / [假设] 搬来的撤销 410 用例改走 HTTP 页面接口（`/api/messages` 带 session）；requests-test 先设临时 `COWART_SESSION_NAMES_FILE` / `COWART_RUNTIME_DIR` 再动态 import / 起 CanvasServer 会读写会话名字文件，静态 import 时它已指向真的 `~/.cowart-claude`。
- S5-4 / [假设] hello 用例搬进 resident-test 时 host 写 zcode / 会话流只剩 ZCode 的桥在用；计划只说把 `widget-poll` 换成 `pages`。
- S5-5 / 补了一个行为用例：服务不再接 `/api/requests/claim|delivered|release`（旧代码 403、新代码 404，先红后绿）/ 计划没列 S5 的新行为用例；没写 widget 那两个操作名，免得撞完成定义的 rg。
- S5-6 / feedback-test 的 Codex 腿查 Codex skill 里的 `` `cowart feedback` ``，Claude / ZCode 照旧查 `send_cowart_feedback` / S4 的 Codex skill 只写命令不写工具名，原断言在旧代码上就红。
- S5-7 / [假设] context-menu 的 Codex 步：Codex 命令会话 open 后用它的会话 + pane 开页面事件流，带 `x-cowart-pane` 调页面接口，另断言服务里该会话 host 为 codex / 计划只写「改走 host codex 的 HTTP 页面」。
- S5-8 / [假设] multi-session 的「别的代码目录」先起 1 个 listen、等它的服务起来再起其余 9 个，步名 bridges → listeners / 10 个同时首拉起会各经 WMI 起一个服务抢端口；原来的桥也是一个个起的。
- S5-9 / [假设] probe:cold 去掉 Codex 段后由 `call render_cowart_canvas_widget` 拉起服务，断言改成页是新建的、listen 后服务 pid 不变；环境另删 `CODEX_THREAD_ID` / 在 Codex 任务里跑检查时命令会被认成 Codex 会话。
- S5-10 / [假设] 顺手改了说已删的 Codex 桥 / widget 投递的 4 处代码注释（`request-notice` `requests` `feedback` `generation-requests`）和 `adapters/package.json` 的 description / 写的正是本阶段删掉的东西。

## S6 文档

- S6-1 / [假设] 计划没点名的 `beast-library/README.md`（「Codex 用不了」）和 `zcode/README.md`（图里「空闲 10 分钟退出」，Claude 那行加 Codex）也改了 / 写的正是本计划改掉的事（S1 常驻、S4 install 顺带装 Codex），不改就错。
- S6-2 / [假设] INSTALL.md「去掉 cowart_mcp 的说明」取第 1 节 Codex 那行手动卸 `[mcp_servers.cowart_mcp]`（install 现在自己去掉）；3B 第 4 步压掉根 `.mcp.json` 的 `cowart_mcp` 留着、改说成上游原版的 / 恢复上游后根 `.mcp.json` 仍有它，clone 里开 Claude 会话照样多一套工具。
- S6-3 / Claude 版、ZCode 版 SKILL.md 没改 / 两份里的 Codex 只出现在「Codex 口吻」几条（计划说不改），没有 Codex 小部件的字样。
- S6-4 / [假设] widget-resource 补丁行补登第二处 `[fork-patch]`（`callServerTool` 前转标准 JSON）；「待撤」只标纯小部件的两行（widget-resource、Blob 上限），`readCowartHtmlDataUrl` 行只注明经 MCP 读成 Blob 那条路 / 它原来只记在删掉的「Codex 任务切换与恢复」；存储参数等待那行画布服务的网页也在用。
- S6-5 / [假设] 「FORK.md 写到的仓内路径都在」按现行的核：写成历史的已删路径（`adapters/codex/`、`cowart-codex-mcp.mjs`、`widget-panes.mjs`、`verify-release.mjs`、`switch-codex-entry.mjs`、`cowart-claude-mcp.mjs`）不在是对的 / 历史要写得出删了什么。
- S6-6 / [假设] claude/README「已知限制」和 FORK.md 写进两条后续观察（服务重启后 hook 认不得 Codex 会话、服务端几句报错还是 Claude 说法）/ 用户该知道；只写不修。

## S7 整体审与收口

- S7-1 / 提醒 hook 的命令末尾加 `|| exit 0`，codex-cli-test (p) 和 probe:cold 比对整条命令的断言跟着改 / 审查 medium：codex-rs 把 UserPromptSubmit 的退出码 2 + stderr 当拦截，命令入口指向的 Cowart 不在了（入口退出 2）时用户每句话都被拦；改的是 Codex 断言。
- S7-2 / [假设] `hostFromEnv` 把 D7 的「有 `CLAUDE_CODE_*`」收窄成 Claude Code 给会话命令的 ENTRYPOINT / HOST_SESSION_ID / SESSION_ID（有值才算）/ 整台机器设的 `CLAUDE_CODE_GIT_BASH_PATH` 之类 Codex 也继承，原写法把 Codex 会话认成 Claude。
- S7-3 / [假设] hook 不问比 0.3.0 旧（或没报版本）的服务，`identity.mjs` 导出 `compareVersions`；只改 hook-check 的续租条件（host 为 codex 或空），不改它列出的请求 / 审查 low：旧服务先建会话再回 422；嵌套 Codex 会把 Claude 会话改成 codex，开着面板就永不结束。
- S7-4 / [假设] config.toml 的 cowart_mcp 段里有跨行的值（未闭合的 [ / {、三引号）就整份不动、报一行请用户删，install 仍退出 0；不做 TOML 解析 / 按行删会在值里像表头的行提前停、留下坏的 config；保守退让只会少删不会多删，常见的单行写法照旧删。
- S7-5 / [假设] 导出 `launchedService(pid, since)`（测试用）；早于拉起时刻 1 秒以上写的退出码文件算同 pid 的旧进程留的、按 -1 并删；带 `--log` 的服务启动时也清一天前的（导出 `clearOldExitCodes`）/ 审查 low：开机自启和被替换的服务的文件没人读，pid 复用会读到旧码。
- S7-6 / [假设] `#settle` 每次拉起后重算 20 秒等待（原先从进 `#settle` 算）、`CanvasGuard` 记新条目前先清已结算的，这两处没加测试 / 前者要慢 WMI 才测得到、只放宽上限；后者外面看不出（结算的条目本来就不再用），现有写入保护测试兜住没回归。
- S7-7 / [假设] `Presence` 在 `#persist` 里删 7 天没见、不负责页、没开着面板的条目（同存盘的口径，只多了负责页 / 面板两条保留）/ 审查 medium：常驻后内存里的会话名只增不删，备用名会用光、旧名不能再用。
- S7-8 / resident-test 起服务那步包进 step（+1 PASS），codex-cli-test 的 finally 各步单独 catch、`stopTestService` 挪进 try / 审查 low：失败路径会跳过清理和 finish；只改测试。
