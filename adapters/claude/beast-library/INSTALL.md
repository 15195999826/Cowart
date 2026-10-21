---
works-with: Claude Code 桌面版 · Windows / Mac（命令行版 claude、Codex 用不了）
needs: Node ≥ 22.12 · 二选一：省心版 = Cowart 运行包 {{VERSION}}（猛兽取件柜 cowart 栏）/ 开发版 = git clone 源码自己改
---

# 装 Cowart 画布 {{VERSION}}

Cowart 是 Claude Code 桌面版里的一块无限画布（tldraw）：图片、视频、网页截图、AI 生成的 HTML 都能摆在上面，
按页分给不同会话干活。装好之后在新会话里说「打开 Cowart 画布」，画布就在桌面版右侧的 Browser 面板里打开。

## 0. 先确认适用，再让用户二选一

只支持 **Claude Code 桌面版**（Windows / Mac）：Cowart 的 MCP 薄桥只在桌面版里提供工具，画布要在桌面版的 Browser 面板里开。
你（借书人的 AI）不是跑在 Claude Code 桌面版里，就停下来告诉用户：这本书在他的环境里用不了。
走公司中转的桌面版（环境变量 `CLAUDE_CODE_ENTRYPOINT` 是 `claude-desktop-3p`）也是桌面版，能用。

然后**问用户要哪一种**（一台电脑上只留一种，第 1 节会把另一种清掉）：

| | 省心版（推荐） | 开发版 |
|---|---|---|
| 是什么 | 作者打包好的运行包，只有运行件、没有源码 | 作者 GitHub 仓库的源码，clone 到本机 |
| 能不能改 | 不能改（改了下次升级就被盖掉） | 随便改，自己管 |
| 以后升级 | 书出新版（版本号变了）就照本说明换新运行包 | **跟作者完全脱钩**：clone 后去掉远程仓库，作者以后的更新不会进来，书出新版也不用管 |
| 要装 | Node | Node、git，外加约 50 MB 的 npm 依赖 |

用户拿不定主意就推荐省心版。

## 1. 先清掉另一种（两种版本都要先做这一步）

一台电脑上同时有两份 Cowart，会抢同一个画布服务。先查这台电脑上已经有什么，**查到的东西列给用户看，用户点头再清**：

| 查什么 | 怎么查 | 是哪一种 |
|---|---|---|
| 用户级 MCP 注册 | 读 `~/.claude.json` 顶层 `mcpServers.cowart`，看 `args` 里的脚本路径。**别用** `claude mcp get` / `claude mcp list` 查：它们做健康检查会顺手拉起画布服务，服务占着命令的输出不放，命令卡住不返回 | 在 `~/.cowart/releases/cowart-<版本>/` 下 = 省心版；在别的目录（一个 clone）下 = 开发版 |
| 项目级 MCP 注册 | 读 `~/.claude.json`，找 `projects.<目录>.mcpServers` 里叫 `cowart` 的 | 以前在某个项目里单独注册过的，都算多出来的一份。**项目级优先于用户级**：不清的话，在那个项目里开的会话还走旧的那份 |
| skill | `~/.claude/skills/cowart` | 普通文件夹 = 省心版；链接（Windows junction / Mac symlink）到某个 clone = 开发版。Git Bash 的 `ls` 会把 junction 也显示成链接，拿不准用 PowerShell `(Get-Item <路径>).LinkType` |
| 运行包 | `~/.cowart/releases/` 下**只认 `cowart-<版本>` 开头的目录** | 省心版装过的版本。`<版本>-<提交>`（如 `0.2.13-d51159a`）这种是作者开发机上 Codex 用的发布副本，不归这本书管，查到也别动 |
| Codex | `codex plugin list` 里的 cowart，以及 `~/.codex/config.toml` 里手工注册的 `[mcp_servers.cowart_mcp]` | 另一份，告诉用户、问要不要卸 |

要装的跟已有的是同一种、同一个版本：什么都不用清，直接跳到第 6 步验证。否则按下面清掉另一种（以及多出来的项目级注册）：

1. **画布服务**：`node "<已有那份的目录>/adapters/generated/cowart-service.mjs" --status` 看正在跑的服务（`version`、`root`）和连着它的会话。
   先记住一条：**旧版注册之后开的每个会话都挂着旧版 cowart**，不管用没用过画布；服务一停，它们会马上从旧那份把服务再拉起来。所以：
   - **要装的版本号比正在跑的服务大**（省心版升级就是这样）：**不停服务、不用请用户关会话**。照下面注销旧注册、照 3A / 3B 装好新的，
     第 4 步请用户开个新会话：新版会把旧服务替换掉，旧会话也改连新服务。等 `--status` 里的 `root` 换成新的那份，再删旧运行包（第 4 条）。
   - **版本号一样或更小**，而服务跑的正是要删掉的那份（比如同一版本从开发版换省心版、还要删 clone）：先请用户关掉旧版注册之后开的会话，
     再 `--stop`，然后才删目录。不停的话，新装的那份会接着用这个目录已经删了的旧服务，画布页面打不开。
   - 服务是别的东西起的（比如 Codex 那份、或者要留着的 clone）就**不停**，告诉用户：停了会打断那边开着的画布；版本号一样时新装的那份会直接连上它，不影响用。
2. 注销 MCP：用户级 `claude mcp remove cowart -s user`；项目级的**进到那个项目目录里**跑 `claude mcp remove cowart -s local`。
   项目目录已经不在了（在那里跑不了命令）：备份 `~/.claude.json`，把 `projects.<目录>.mcpServers.cowart` 那一项删掉（先给用户看要删的那几行）。
3. skill：`~/.claude/skills/cowart` 是**链接就只删链接本身**——Windows `cmd /c rmdir "%USERPROFILE%\.claude\skills\cowart"`；
   Mac `rm ~/.claude/skills/cowart`（不带 `-r`、末尾不加 `/`）。**别用** `Remove-Item -Recurse`、`rm -rf`，也别直接往链接里拷文件：
   都会穿过链接改掉、删掉它指向的 clone 里的源码。是普通文件夹就整个删。
4. 省心版的运行包 `~/.cowart/releases/cowart-<旧版本>/`：删掉（升级时等服务换成新版再删，见第 1 条）。开发版的 clone 目录**不删**——那是用户自己的代码，告诉用户它已经不再被使用。
   clone 有未提交的改动、或者还连着远程仓库（`git -C <clone> status` / `git remote -v`）时，说明它可能是谁正在用的开发环境，先特别提醒用户再注销。
5. **别动** `~/.cowart/canvas`（画布本身）、`~/.cowart-claude/`（会话名字、令牌、日志）：两种版本共用，切换不丢画布。

## 2. Node ≥ 22.12（两种都要；AI 查，没有请用户装）

- 查：`node -v`。
- 没有、或低于 22.12：请用户自己装 Node 22 LTS（https://nodejs.org 下载安装包；Mac 也可以 `brew install node@22`），
  装完**新开一个终端**再查一次。别替用户下载运行安装包。

## 3A. 省心版：运行包 {{VERSION}}

1. 网关地址看 `~/.beast/config.json` 的 `server`（以那里写的为准，比如 `http://beast.o.com` 或 `http://192.168.50.246:8020`）。
2. 下载到一个新建的空临时目录：`curl.exe -fL -o cowart-{{VERSION}}.zip "<server>/api/locker/file/cowart/cowart-{{VERSION}}.zip"`
   （PowerShell 里的 `curl` 是别名、参数不认，要写 `curl.exe`；Mac / Git Bash 写 `curl`）。
3. 核对：`beast locker ls cowart --json` 里（`sections[].items[]` 下）`cowart-{{VERSION}}.zip` 这一项的 **`sha256` 字段**，跟下载下来的算出来的一样才往下走
   （Windows：`(Get-FileHash cowart-{{VERSION}}.zip).Hash`；Mac：`shasum -a 256 cowart-{{VERSION}}.zip`；大小写不用管）。
   同一项的说明（`note`）里还有一串「发布清单 sha256」，那是运行包里清单文件的指纹，**不是 zip 的**，别拿它比。
4. 解压到 `~/.cowart/releases/`（目录没有就建），解出来是 `~/.cowart/releases/cowart-{{VERSION}}/`：
   - Windows：PowerShell `Expand-Archive -Path cowart-{{VERSION}}.zip -DestinationPath "$HOME\.cowart\releases"`
     （Git Bash 里的 `tar` 解不了 zip，别用）；
   - Mac：`mkdir -p ~/.cowart/releases && unzip -q cowart-{{VERSION}}.zip -d ~/.cowart/releases`。
5. 解出来的顶层目录就是 `cowart-{{VERSION}}`（列一下 `~/.cowart/releases/` 确认），`~/.cowart/releases/cowart-{{VERSION}}/adapters/generated/cowart-claude-mcp.mjs` 在，`release-origin.json` 里的
   `version` 是 `{{VERSION}}`。下载的 zip 删掉。
6. 注册 MCP（先告诉用户要加一条用户级 MCP「cowart」）。**node 和脚本都写绝对路径**（Mac 上桌面版不一定带着终端的 PATH）：

   ```bash
   claude mcp add cowart -s user -- "<node 的绝对路径>" "<家目录>/.cowart/releases/cowart-{{VERSION}}/adapters/generated/cowart-claude-mcp.mjs"
   ```

   node 的绝对路径：Mac `command -v node`；Windows `(Get-Command node).Source`。Windows 上路径里的反斜杠换成 `/` 也行。
   以前照 0.2.13 的说明注册时带过 `-e COWART_ALLOW_CLI=1`（给公司中转桌面版用的）：0.2.14 起中转版直接算桌面版，第 1 步注销后照上面这条重新注册、不带它就行。
7. skill：照接入清单把这本书的 SKILL.md 放进 `~/.claude/skills/cowart/`（第 1 步已经把链接、旧的那份清掉了；还在就先回第 1 步第 3 条）。

## 3B. 开发版：clone 源码

1. 查 git：`git --version`，没有请用户装（Windows：Git for Windows；Mac：`xcode-select --install`）。
2. 问用户放哪（比如 `~/Cowart`；Windows 路径别带中文和空格）。clone、回到这本书对应的提交、**去掉远程仓库**：

   ```bash
   git clone -c core.autocrlf=false -c core.eol=lf https://github.com/15195999826/Cowart.git "<目录>"
   git -C "<目录>" reset --hard {{COMMIT}}
   git -C "<目录>" remote remove origin
   ```

   换行按 LF 检出是仓库自己的要求（FORK.md：Windows 上 CRLF 检出会把页面产物打坏）。去掉 origin 之后这份代码就是用户自己的：
   作者以后的更新不会拉进来，用户的改动也推不回作者那里。
3. 装适配层依赖：`npm ci --prefix "<目录>/adapters"`（约 50 MB，MCP SDK 等）。
4. 压掉仓库根目录 `.mcp.json` 里给 Codex 用的 `cowart_mcp`：在 `<目录>/.claude/settings.local.json` 写
   `{"disabledMcpjsonServers": ["cowart_mcp"]}`（已有这个文件就合并进去）。不压的话，在这个目录里开 Claude 会话会多出一套冲突的工具。
5. 注册 MCP（先告诉用户），指向**源码入口**——改了适配层代码，重开会话就生效：

   ```bash
   claude mcp add cowart -s user -- "<node 的绝对路径>" "<目录>/adapters/claude/bin/cowart-claude-mcp.mjs"
   ```

6. skill：`node "<目录>/adapters/claude/scripts/install-skill.mjs"`，把 `~/.claude/skills/cowart` 链接到仓库里的
   `adapters/claude/skills/cowart`——**这本书的 SKILL.md 不用放**（接入清单的「放进 skill 目录」那一步照这里来），
   以后改仓库里的 skill 直接生效。
7. 告诉用户怎么改：开发准则、目录、补丁点都在仓库的 `FORK.md`，在这个目录里开会话改就行。FORK.md 里关于推送 GitHub、
   发 Codex 插件、上架猛兽图书馆（`publish-beast-library.mjs`）的部分是作者自己的发版流程，脱钩之后用不上。
   改了画布页面（`src/`）要在根目录 `npm ci && npm run build:artifacts` 重新生成页面产物（再多约 170 MB 依赖），只改 `adapters/` 不用。

## 4.（两种都要）开一个新会话（用户本人）

MCP 注册只对新会话生效：请用户在桌面版里**新开一个会话**，不用退出桌面版。已经开着的会话还用着旧的那份（或者没有 cowart），要在里面用就关掉重开。

## 5. 找不到 `claude` 命令

告诉用户，请他在终端里能用 `claude` 之后再来；或者由你备份 `~/.claude.json` 后，在顶层 `mcpServers` 里加
`"cowart": {"type": "stdio", "command": "<node 绝对路径>", "args": ["<脚本绝对路径>"], "env": {}}`
（改之前把要加的这几行给用户看，用户点头再改；注销就是删掉这一项）。

## 6. 验证（在新会话里）

- 新会话的工具里有 `mcp__cowart__…`（比如 `render_cowart_canvas_widget`）。`claude mcp list` 显示 Connected 不算数：没工具时它也是 Connected。
  新会话系统提示里 cowart 那段说「这个会话的入口是 …，所以没有 cowart 工具」= cowart 认为这个会话不是桌面版。用户确实在桌面版里，就把那句原话（带入口名）告诉用户、
  转给作者；临时绕法是注册时加 `-e COWART_ALLOW_CLI=1`（代价是终端里的 `claude` 命令行会话也会有 cowart 工具）。
- 用户说「打开 Cowart 画布」：Browser 面板打开画布页面，顶部显示这个会话起的名字。
- 起不来：看 `~/.cowart-claude/service.log` 最后几十行，把报错告诉用户。
- 回报时说清装的是**省心版 {{VERSION}}** 还是**开发版（从 {{COMMIT}} 起步、已脱钩，目录在哪）**，以及第 1 步清掉了什么。

## 可选（缺了只是少功能）

- **beast 命令行 + beast-gen skill**：画布上「AI 图片 / AI 视频」点发送就由画布服务直接调猛兽生成。过了猛兽新手关的同事本来就有；没有时这两个按钮退回成「发给会话」的请求。
- **本机 Chrome 或 Edge**：画布的「网页参考」截网页图用。
- **终端里能用的 `claude` 命令**：画布服务在后台用它把面板里的话写成模型认的提示词（`claude -p`）；没有就按原话生成，请求条上会注明。

## 以后

- **省心版升级**：`beast skill ls` 看到《cowart》有新版 → `beast skill get cowart` 再借一次 → 版本号变了就照 3A 装新运行包
  （第 1 步注销旧注册；服务不用停、会话不用关），第 4 步开个新会话，`--status` 看到服务换成新版后删旧运行包，再第 6 步。
- **开发版**：书出新版不用管。想换回省心版，照本说明选省心版重装一遍（第 1 步会注销开发版，clone 目录留着）。
