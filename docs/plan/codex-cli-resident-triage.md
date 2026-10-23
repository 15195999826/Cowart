# Codex 改走 cowart 命令 + 画布服务常驻 §6 后续观察 — 分诊与拍板（2026-10-23）

> 来源：[`codex-cli-resident.md`](codex-cli-resident.md) §6「后续观察」18 条。本文是「分诊 → 分桶 → 用户拍板 → 一轮落地」的产出。**执行状态：待拍板**。验收沿计划 §2，一个 commit，执行方不 push。
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

- 修哪些：只修 A（推荐：7 项都是小改、有测试钉住；B1 只为让上游的 `check:plugin` 过，而 fork 已不再当 Codex 插件发布、这个检查不在任何流程里，却要装根依赖重建上游产物）/ A + B / 都不动 → **待拍板**

## 3. 落地（拍板前只写「待拍板」）

- 待拍板
