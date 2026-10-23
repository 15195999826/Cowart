# Codex 改走 cowart 命令 + 画布服务常驻 §6 后续观察 — 分诊与拍板（2026-10-23）

> 来源：[`codex-cli-resident.md`](codex-cli-resident.md) §6「后续观察」18 条。本文是「分诊 → 分桶 → 用户拍板 → 一轮落地」的产出。**执行状态：用户拍板 A + B，一轮落地 TR1 410b2d7、TR2 cecacbe**。验收沿计划 §2，一个 commit，执行方不 push。
> 同一计划再分诊一轮：在本文件末尾追加「## 第 N 轮（日期）」节，不另开文件。

## 0. 本轮约束（用户拍板）

- 沿计划 §2：`src/`、`mcp/`、根 `skills/` 冻结；host claude 与 ZCode 的现有断言不改；不碰 43240 上的服务、真画布和真安装。
- 桌面分诊 = 先对 §6 每条末尾的 → 处置标记（已处置的直接关闭），再读代码 + grep 核实；范围 = 本仓；未逐条跑复现，改动项的复现即本轮验收组。

## 1. 分桶总表

| 桶 | 条数 | 条目（§6 关键词，每条附核实依据） |
|---|---|---|
| ✅ 已关闭（执行期已落地，分诊核对后关闭） | 2 | ①（S2）README 缺 `COWART_SERVICE_LINK` / `COWART_STARTUP_DIR`：条目已标「S6 已补」。②（S5）本机真安装指着删掉的东西：10-23 人工验收第 1 条真装后，`config.toml` 已无 `cowart_mcp`，`~/.codex/skills/` 只剩指向 `codex-skill/cowart` 的一个链接 |
| 🟢 A 本轮修：确定性小项，有测试钉住 | 7 项（含 8 条） | **A1**（S2 + S7 两条日志）常驻服务日志只在启动时轮转、别的进程拉起前会把正在写的日志改名：`client.mjs` 的 `rotateServiceLog` 在每次 `spawnService` 前调，服务只在 `cowart-service.mjs --log` 启动时转一次 → 改成服务自己按大小轮转（`--log` 时写满就改名 `.1`、重开），拉起方不再轮转别人正在写的日志；测试用小上限环境变量。**A2**（S2）test-kit 不隔离 `COWART_RUNTIME_DIR`：`test-kit.mjs` 里没有这个变量，10-23 真 `service.log` 里有 `zsmoke-claude`、`stopping (test cleanup)` → test-kit 在任何 import 之前设临时 runtime 目录；验收：跑完 `test:claude` 真 `service.log` 没有新增测试会话行。**A3**（S6）`install-skill.mjs` 文件头注释没提 Codex 的 skill + hook：注释改一句，无行为。**A4**（S3）服务端给 Codex 会话的文字是 Claude 的说法：`server.mjs` 的令牌无效「回到 Claude Code」、缺 `--session`「回到 Claude Code」、`take --shown`「Browser 面板」，`generation-jobs.mjs`「交给 Claude 处理」→ 按会话 host 说；codex-cli-test 断言。**A5**（S4）服务重启后 Codex 会话的请求不提醒：`server.mjs` 的 `hook-check` 遇到不认识的会话直接回 `[]` → 不认识时按会话 id 查队列，有未完的请求才建会话并返回；测试。**A6**（S4）给 Codex 的命令文字写 `~/.cowart/...`，Windows PowerShell 5.1 不展开：`cli.mjs` 的 `cowartCommand()` 用 `COMMAND_LINK_SHOWN` → host codex 时写 `$HOME/.cowart/bin/cowart.mjs`；测试。**A7**（S7）提醒 hook 每句话都绑一下 43240，开机自启的服务正在起时会被挤掉（退出码 3、vbs 结束）：`cli.mjs` 的 hook 用 `findService`（首探绑端口）→ 先读画布锁文件（`.cowart-service.lock` 的端口和 pid）直接连，没有锁或连不上就当服务没跑、不打印；测试 |
| 🟡 B 本轮修：会动根产物 | 1 | **B1**（S5）根上游的 `check:plugin`（`scripts/check-plugin-metadata.mjs`）报版本不一致：根 `package.json` 是 `0.1.28+codex.20261022110200`，`.codex-plugin/plugin.json` 已恢复上游 0.1.27。修法是把根 `package.json` / `package-lock.json` / `plugin.json` 的版本也恢复成上游，再在根目录 `npm run build:artifacts`。预期漂移：`mcp/generated/release-manifest.json` 和 `cowart-widget.html` 里的版本字符串从 `0.1.28+codex…` 变成 `0.1.27`，其余字节不变（要先差分确认）；`check:contract` 的版本对照跟着变 |
| ⚪ 登记不修（每条写触发条件） | 7 | ①（S3）从 Claude Code 会话里起的 Codex 会被认成 Claude 会话：只影响这种嵌套；触发：用户在 Claude 会话里开 Codex 用画布、宿主认错。②（S7）config.toml 里紧跟 `cowart_mcp` 段的注释会一起删：有备份，本机已装完；触发：有人反馈注释丢了。③（S7）WMI 拉起的服务死后 pid 被复用，命令要等 20 秒才报「没能启动」：要比对进程创建时间；触发：日志里出现这种 20 秒超时。④（S7）开机自启的 vbs 持续失败时每分钟重起、不设上限：触发：`service.log` 里出现每分钟一次的启动失败。⑤（S7，存疑）Codex 只在 `danger-full-access` 下验过，默认沙箱可能连不上服务：触发：用户真用 Codex（验收延后）或换了沙箱配置。⑥（S7）`launchDetached` 15 秒超时后会再 detached 起一个，留下的可能在宿主 Job 里：触发：日志里有 `launch via WMI failed` 且随后服务被宿主带走。⑦（S7，存疑）Codex 关任务后内置浏览器标签页还开着，会话一直占着那一页：触发：用户真用 Codex 时发现页被占 |

## 2. 拍板记录

- 修哪些：只修 A（推荐：7 项都是小改、有测试钉住；B1 只为让上游的 `check:plugin` 过，而 fork 已不再当 Codex 插件发布、这个检查不在任何流程里，却要装根依赖重建上游产物）/ A + B / 都不动 → **拍板 A + B**（2026-10-23）
- 怎么落地：两个追加阶段，各一个 commit、各派一个 fresh 子 agent（opus、xhigh）：TR1 = A 桶 7 项，TR2 = B1。B1 放开计划 §2 守卫①里的根 `package.json` / `package-lock.json` / `plugin.json` 和 `mcp/generated/`（只限 TR2，且只限版本相关的变化）；`src/`、`mcp/server.mjs`、`mcp/lib/`、根 `skills/` 照旧冻结。

## 3. 落地

验收沿计划 §2（全量组：`check:contract`、`test:claude`、`test:zcode`、`build:artifacts`、`check:artifacts`、`probe:cold`；守卫②照旧；TR1 起守卫②再加：真 `~/.cowart-claude/service.log` 的大小和 `~/.cowart-claude/service-exit/` 列表在跑测试前后一致）。偏离写进 [`codex-cli-resident-deviations.md`](codex-cli-resident-deviations.md) 新节「TR1 / TR2」，编号 `TR1-n` / `TR2-n`。阶段做完在下表填状态和 SHA（SHA 用随后一个 docs 提交回填），并在计划 §6 对应条目末尾标「→ 已修 <SHA>」，登记的标「→ 登记：<触发条件>」，已关闭的标「→ 已关闭」。

| 阶段 | 状态 | SHA | 备注 |
|---|---|---|---|
| TR1 A 桶 7 项 | 已完成 | 410b2d7 | 全量组全绿（第 1 关一轮过）：contract OK、test:claude 143 PASS + 13 node:test（+6：resident q / r、codex-cli s / t / u / v；A2 无新用例、A3 只改注释）、zcode 12、build / check OK、cold 3；两条 rg 零命中；守卫①空，守卫②前后一致（含真 `service.log` 1845313 字节不变、`service-exit/` 59 个不变）；偏离 9 条（TR1-1…9），后续观察 +2；两问自查：日志 fd 随进程、`.1` 只留一份，hook-check 建回的会话走原有的租约 / 结束 / 遗忘，退回 spawn 的退出码文件在子进程退出时删，测试的临时运行目录通过即删、锁替身和服务在 finally 清掉；新循环遍历的都是 `queue.list` 的拷贝或常量数组 |
| TR2 B1 根版本恢复上游 | 已完成 | cecacbe | 全量组全绿（第 1 关一轮过）：contract OK（upstream 0.1.27）、test:claude 143 PASS + 13 node:test、zcode 12、build / check OK、cold 3，测试数不变（无新行为）；根 `check:artifacts`、`check:plugin` 通过（0.1.27）；`mcp/generated` 差分只有 `cowart-widget.html` 1 处版本串和 `release-manifest.json` 的版本串 + widget 哈希，另两个产物逐字节相同；适配层产物只变 `serviceBuild` 指纹和清单哈希；与上游五个文件差分为空，`src mcp/server.mjs mcp/lib skills` 空；守卫②前后一致（含真 `service.log` 1845313 字节、`service-exit/` 59 个）；偏离 4 条（TR2-1…4），后续观察 +0；两问自查：只改版本串和文档，没加表 / 定时器 / 文件 / 进程 / 安装项，没有新循环 |

### TR1 A 桶 7 项

**改法**：
- **A1 日志**：`service/bin/cowart-service.mjs` 的 `--log` 分支：打开时用 `statSync` 记下已有大小，每次写入累加字节数；超过上限（`client.mjs` 导出的 `LOG_LIMIT_BYTES`，`COWART_LOG_LIMIT_BYTES` 可改，测试用）时关掉 fd、把文件改名成 `.1`（覆盖旧的 `.1`）、重新打开、计数归零。`service/client.mjs` 的 `spawnService`：两条路（WMI、退回的 spawn）都给服务带 `--log SERVICE_LOG`，退回的 spawn 的 stdio 改成 `ignore`；拉起前不再调 `rotateServiceLog()`（轮转只由服务自己做：启动时一次 + 写满时）。客户端自己往日志追加的那一行（`launch via WMI failed…`）照旧 append。
- **A2 测试隔离运行目录**：新 `claude/scripts/test-runtime.mjs`：`COWART_RUNTIME_DIR` 没设时设成本进程独有的临时目录（`mkdtemp`），进程退出时删掉；`test-kit.mjs` 把它作为第一个 import。所有会拉起服务的测试入口（`claude/scripts/*-test.mjs`、`service/test/*.mjs`、`zcode/scripts/smoke-test.mjs`）在 import `service/client.mjs` / `lib/token.mjs` 之前先 import 它（ESM 按出现顺序求值；已自己设了的测试如 `stop-test` 不受影响）。
- **A3**：`claude/scripts/install-skill.mjs` 文件头注释补一句：在有 Codex 的机器上还会装 Codex 的 cowart skill、提醒 hook，并去掉原来的 `cowart_mcp`。
- **A4 服务端文字按宿主**：`service/lib/server.mjs` 里令牌无效、监听缺 `--session` 两处不知道会话，改成不点名宿主的说法（「回到你的会话重新打开画布」）；`#openCanvas` 里 `take --shown` 时没开页的报错，host codex 说「还没在 Codex 内置浏览器里打开这张画布」，其余照旧（claude 一字不改）；`service/lib/generation-jobs.mjs` 的「这类请求要交给 Claude 处理」改成「交给负责这一页的会话处理」。
- **A5 重启后也提醒**：`server.mjs` 的 `hook-check`：会话不在内存里时，按请求里的会话 id 查 `this.queue.list(id)`；有未完、`executor !== 'service'` 的请求才 `this.#session(id)` 建会话、`#touchCommandSession(session, 'codex')` 并返回它们，否则照旧 `{ requests: [] }`、不建会话（会话 id 要从 HTTP 入口传进 `#bridgeCall`）。
- **A6 `$HOME`**：`claude/lib/cli.mjs` 的 `cowartCommand()` 和用到 `COMMAND_LINK_SHOWN` 的文字：host codex 且没设 `COWART_COMMAND_LINK` 时写 `$HOME/.cowart/bin/cowart.mjs`；host claude 一字不改。
- **A7 hook 不绑端口**：`cli.mjs` 的 hook 不再用 `findService`：用 `service/lib/canvas-lock.mjs` 的 `canvasOwner(SHARED_CANVAS_DIR)` 读锁文件拿端口和 pid，pid 不在就当服务没跑；在就 `probeService(port, token, { bind: false })` 后照旧 POST `hook-check`；没锁、连不上、超时一律不打印、退出 0。
**完成定义**：A1–A7 的测试都绿；全量组绿；`rg -n "Claude 处理|回到 Claude Code" adapters/service/lib` 零命中；`rg -n "findService" adapters/claude/lib/cli.mjs` 零命中；守卫①空；守卫②（含真 `service.log`、`service-exit/`）前后一致。
**钉子**：沿计划 S0；host claude 与 ZCode 断言不改。
**测试**：resident-test 加 (q)【行为变化】`COWART_LOG_LIMIT_BYTES=2000` 的服务写满后出现 `service.log.1`，之后的日志行在新的 `service.log` 里；(r)【行为变化】服务在跑时，另一次拉起（端口被占、退出码 3）不会把它的日志改名。codex-cli-test 加 (s)【行为变化】host codex 的 `take --shown` 报错不含「Browser 面板」；(t)【行为变化】请求文件里排着 `codex-X` 的未完请求、服务重启后 `hook prompt`（会话 X）打印提醒；(u)【行为变化】host codex 的 `open` 文字含 `$HOME/.cowart/bin/cowart.mjs`、不含 `~/.cowart`（测试里不设 `COWART_COMMAND_LINK` 时）；(v)【行为变化】服务跑在扫描范围外的端口（锁文件指着它）时 `hook prompt` 照样找得到。A2 的验收即守卫②的新增项。
**规则之家**：`FORK.md`「画布服务」里讲日志轮转、hook 找服务的句子各改一句；`adapters/claude/README.md` 环境变量节加 `COWART_LOG_LIMIT_BYTES`。

### TR2 B1 根版本恢复上游

**改法**：`git checkout upstream/main -- package.json package-lock.json plugin.json`（三个文件和上游只差版本行，10-23 核过：`0.1.28+codex.20261022110200` → `0.1.27`，共 4 处）。根目录 `npm run build:artifacts`（失败于依赖时先 `npm ci`）。先差分：`git diff --stat mcp/generated` 只能是 `release-manifest.json` 和 `cowart-widget.html` 两个文件、且只有版本字符串变化；有别的变化就把 `mcp/generated` 还原（`git checkout -- mcp/generated`）、BLOCKED 附差分。然后适配层 `npm --prefix adapters run build:artifacts`（适配层发布清单记着 `mcp/generated` 的哈希）。
**完成定义**：`git diff upstream/main -- package.json package-lock.json plugin.json .mcp.json .codex-plugin/plugin.json` 为空；根 `npm run check:artifacts` 和 `npm run check:plugin` 通过；全量组绿；`git status --porcelain -- src mcp/server.mjs mcp/lib skills` 为空；守卫②一致。
**钉子**：沿计划 S0。**测试**：无新行为（版本字符串）。
**规则之家**：`FORK.md` 里说根版本 / 插件版本的句子（分支与同步、补丁点清单 `.mcp.json` 那行附近）改成「根版本跟上游一致，fork 只升适配层版本」。
