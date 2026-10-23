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

- 

## S4 Codex 的 hook、skill 与安装

- 

## S5 删掉 Codex widget + MCP

- 

## S6 文档

- 

## S7 整体审与收口

- 
