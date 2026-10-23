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

- 

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
