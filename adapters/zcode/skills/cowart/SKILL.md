---
name: cowart
description: ZCode 里的 Cowart 画布（tldraw 无限画布，全机一张、按页分工）怎么配合用户干活：打开画布、进入 / 接管页，处理画布发来的「Cowart 画布请求 #N」（按标注修改、按标注生图、AI HTML、AI Slides、照网页做 HTML，本机没 beast 命令行时的 AI 图片 / AI 视频），把生成的图片 / 视频 / HTML 放上画布并放对页，整理页面（给图编号、加标题、分组、排版、删除），读画布摘要里的标注和素材。用户说「打开 Cowart 画布」「接管 X」「进入 X」「接管这页」「看画布」，后台监听唤醒说「Cowart 画布请求」，或者要把任何图 / 视频 / HTML「放到画布上」、按画布上的标注改图、给画布上的图编号 / 分组 / 排整齐 / 删掉、问画布上有什么——哪怕没提 Cowart 三个字——都先读本 skill 再调 cowart 工具。cowart 的 MCP 说明只有开头进了上下文，请求怎么回状态、结果放哪页、标注怎么读、Codex 口吻的提示词怎么换成 beast-gen 都只在这里，凭工具描述直接调容易放错页、漏回状态、白问用户要截图。
---

# Cowart 画布 · ZCode 用法

Cowart 是一块 tldraw 无限画布：图片、视频、网页截图卡片、AI HTML / AI Slides 草稿、标注箭头都放在上面。在 ZCode 里它由**画布服务**保管（全机一个后台进程），`cowart` 的 MCP 工具都转给这个服务。本文讲「怎么配合用户在画布上干活」，每个工具的参数看工具描述。

## 1. 先记住这几件事

- **全机只有一张画布**，在 `~/.cowart/canvas`，所有会话、所有项目共用（Claude Code、ZCode 打开的是同一张）。画布分页（tldraw 的页，画布左上角切换），一页一块板。工具不区分项目目录，不用传 projectDir / canvasDir。
- **分页负责制**：每页同一时间由一个会话负责，每个会话最多负责一页。换人只有三种方式：用户在会话里说「打开 Cowart 画布 X」「接管 X」「进入 X」（render 时传 `page`）、说「接管这页」（`shownPage: true`）、或点画布顶部的「X 来负责」按钮。用户在画布上翻页只是看，不改变谁负责。
- **你有名字**：本会话第一次打开画布时起一个像人的短名字（小川、阿满这种，不是角色、不是任务名），整个会话不换，别跟画布上已有的会话重名。用户和别的会话在画布顶部看到的就是它。
- **请求按页送人**：在某页点 AI 按钮，请求发给负责这一页的会话，跟在谁的浏览器里点无关；没人负责的页，点它的那个面板所属的会话顺手负责。
- **AI 图片 / AI 视频面板不经过你**：用户在面板里选好模型和参数点发送，画布服务自己调猛兽生成、自己放回画布，画布顶部有进度和撤销。只有本机没装 beast 命令行时，它们才变成发给你的请求。
- **只有用户删页**。你不删页、不清页，也不往别人负责的页里写东西。

## 2. 打开画布

| 用户说 | 调用 |
|---|---|
| 打开 Cowart 画布 | `render_cowart_canvas_widget { sessionName }`，不进任何页 |
| 打开 Cowart 画布 角色设定 / 接管 角色设定 / 进入 角色设定 | 加 `page: "角色设定"`（没有就建；原来负责它的会话让出，你之前负责的页放掉） |
| 接管这页 | 加 `shownPage: true`（你的画布页面正看着的那页） |

结果里有「接下来」，照做：

1. 把结果里的网址作为 Markdown 链接发给用户，让他在浏览器里打开（网址带本会话的标识，哪个浏览器都行）；结果说页面已经开着就不用再发。装了 browser-use 插件时，也可以自己用 Skill 工具加载 `control-browser` 打开这个网址。
2. 结果没说「监听已经连着」就用 **Bash 工具后台运行**（run_in_background: true）结果里的监听命令（带 `--once`）。它一直等着、不耗 token，收到画布事件才退出，**退出本身会唤醒你**（通知里带输出文件路径）；没有定时器，服务换版本重启它也自己接上。这是画布请求送到本会话的唯一通道，没在跑时请求在服务里排队（不会丢）。监听退出并说「重新打开画布」时（会话跟服务断开了），再 render 一次拿新的监听命令重跑。
3. 之后别再为别的画布操作重新 render：画布自己每 1.6 秒同步，插进去的东西几秒内就显示。只有用户明确要重开 / 刷新时才再调。

## 3. 画布请求：监听唤醒后怎么处理

监听退出后读它的输出，会有一行「Cowart 画布请求 #N「标题」（页「X」）：摘要 → 马上用 AskUserQuestion 问用户一句（…）」。这是**后台通知，不是用户在对话里说的话**，所以：

1. **先问再动**：马上用 AskUserQuestion 问一句，选项按那行给的（「执行 / 跳过」，或「执行（免费本地模型）/ 执行（云端，消耗团队额度）/ 跳过」）。问之前不调别的工具，也不先去读详情。
   - **按标注修改（图片）**那行带着每条标注的原话。标注不一定是改图要求：图是项目截图、设计稿，标注写的是对界面、功能的意见或问题（「这个是干嘛的」「去掉这个选项」）时，推荐「照标注处理」（答疑、改当前项目，不生图）；要改这张图本身（换背景、改颜色）才推荐「按标注出新图」。问题里一句话说出你的理解，推荐项放第一个，选项照那行。
2. 用户选了要做（跳过以外的选项，或自己打字回答）→ `get_cowart_request { id }`。返回分两段：「画布发来的原始请求」是画布按 Codex 的口吻写的完整指令；「ZCode 宿主说明」是服务针对这一条给你的补充（模型怎么换、结果放哪页、状态怎么回），**两者冲突以宿主说明为准**。
3. 开工先 `reply_cowart_request { id, status: "running" }`，画布顶部会显示「处理中」。做完 `status: "done"`，`message` 写一句结果（比如「已放到原图右边」）；失败 `status: "failed"`，`message` 写原因。用户选跳过 → `status: "skipped"`。用户自己打字回答的也照样回。不回状态的话画布上会一直转圈，没回 `running` 时一直显示「请到对话里点执行」、还能点撤销。
4. **处理完一条就再后台跑一次监听命令接下一条**（命令不变；回 done / failed / skipped 时，监听没在跑的话 reply 的结果会提醒）。同时来了几条也没事：服务会把你没收到的请求在监听重连时补发，按编号逐条问、逐条做。
5. **用户说「看画布」**（或问画布上有没有要处理的）：监听没在跑时请求在服务里排队，画布顶部写着「请求会排队 · 到对话里说「看画布」」。这时调 `list_cowart_requests`：等着的请求每条一行、带好要问的选项（跟监听那行一样），照样先问再做；列出来就算送到了，之后的监听不会再为它们唤醒你。结果末尾说监听没在跑的，照着再后台启动它。
6. 输出说「已在画布上撤销」：不做，也不必再问；正在问的就结束。撤销后 reply 会被拒，这是正常的。

### 3.1 各类请求怎么做

| 请求 | 你拿到什么 | 做法 | 结果怎么放 |
|---|---|---|---|
| 按标注修改（图片），选了「按标注出新图」 | 原图 shape id、逐条标注（文字 + 指向位置，占卡片宽高的百分比）、带标注的截图路径 | Read 截图和原图（原图本地路径在画布摘要里）；按标注改图用 beast-gen 的 `flux2-klein`（本地免费）或用户在确认时选的云端模型 | `insert_cowart_image`：`anchorShapeId` 传原图 id、`placement: "right"`（默认跟原图同尺寸）；原图和标注不动 |
| 按标注修改（图片），选了「照标注处理」 | 同上 | 标注是意见或问题，不是改图要求：Read 截图，在对话里逐条回答，要改的地方在当前项目里改（改动大的先跟用户对一下）；不生图，原始请求里「生成新图、放到原图旁边」那几句不适用 | 不往画布放东西；回 `done`，`message` 写一句（比如「已在对话里逐条答复」） |
| 按标注生图（AI HTML 草稿 → 图） | 草稿截图 + 标注 | 同上，草稿当构图和风格参考 | 放草稿右边（`anchorShapeId` 传草稿 id） |
| AI HTML | AI HTML 框 id、提示词、可能有参考图 | 写完整可运行的单文件 HTML（CSS / JS 内联） | `insert_cowart_html_draft`：`draftShapeId` 传框 id，`htmlContent` 传整份 HTML（默认替换框） |
| 按标注修改 AI HTML | 原草稿的 HTML 文件路径、截图、标注 | 以原 HTML 为基础改 | 新草稿放原草稿右边（`anchorShapeId` 传原草稿 id、`placement: "right"`），不覆盖原文件、原草稿 |
| AI Slides / 按标注修改 AI Slides | Slides 框 id、页数、提示词 | 每页一份 1024×576 的单文件 HTML | 按请求里列的参数逐页 `insert_cowart_html_draft`（`draftShapeId` 传 Slides 框 id，`replaceDraftHolder: false`、`updateExistingDraft: false`、`matchAnchor: false`），不替换、不删 Slides 框 |
| 照这个做 HTML（网页参考卡片） | 网址、整页截图、渲染后的页面代码、标注（坐标是页面 CSS 像素）、右边已建好的 AI HTML 框 | 见 3.2 | `insert_cowart_html_draft`：`draftShapeId` 传框 id |
| AI 图片 / AI 视频（本机没 beast 命令行时） | 面板里选好的模板、参数、素材本地路径和 Required steps | 照请求里的步骤：素材 `beast gen upload` → `beast gen submit` → `wait` → `output` 落本地 | 图片 `insert_cowart_image` 替换框（`anchorShapeId` 传框 id）；视频 `insert_cowart_video { replaceHolderShapeId }` |

**Codex 口吻怎么翻译**：请求是上游按 Codex 写的，遇到这些照下面理解：

- 开头的 `[@Cowart](plugin://…)` 是 Codex 的插件提及，忽略。
- 「用内置 imagegen」「用 Codex 当前可用的图片生成能力」= 用 beast-gen skill：先用 Skill 工具加载它，按它的选型表和写法出图，`beast gen output` 落本地，Read 看一眼没问题再插。免费档随便迭代：文生图 `krea2`，指令改图 / 多图合成 `flux2-klein`，最强保身份 / 参考图多 `flux2-dev`，带字物料 `ideogram4`；云端 `lib-image` 消耗团队额度，只在用户选了云端时用。
- 「不要调用 render_cowart_canvas_widget」照做。
- 「把图片下载到当前项目的 canvas/pages/<page-id>/assets/」：画布不在项目里。插入工具会自己把文件拷进页素材目录，你只管给本地路径。只有 AI HTML 里要嵌本地图片时，才把图放进画布摘要给的 canvasDir 下 `pages/<页 id 去掉 page: 前缀>/assets/`，HTML 里用 `/page-assets/<同一个目录名>/<文件名>` 引用；不要用 file:// 或 http(s) 图片，页面安全策略会拦。
- 请求里给的截图、参考图路径都是本地文件，直接 Read。

### 3.2 照网页做 HTML

用户的用法是：看到喜欢的网站 → 放上画布 → 让你照着重做 → 横向对比。

1. Read 整页截图（很长时分段看）把握整体观感。有标注时逐条 Read 它的局部截图：截图里的箭头和字是用户画的，不是网页内容。
2. 读渲染后的页面代码取配色、字体层级、间距、圆角、阴影、动效。想看真实的计算样式、或按坐标找标注指的是哪个元素，用 Skill 工具加载 `control-browser`（browser-use）打开原网址对照，读计算后的样式、用 `document.elementFromPoint` 定位。
3. 做成完整、独立的单文件 HTML：CSS / JS 内联，字体用系统字体近似，图片用 CSS 渐变、inline SVG 或 data URI，不盗链原站资源；按请求给的宽度排版，长度大致对应截图。标注要照着改，注释只当背景，做出来的页面里不能出现箭头和字。
4. `insert_cowart_html_draft { draftShapeId: 框 id, htmlContent, fileName: 简短英文 .html }`。

## 4. 用户在对话里直接要的画布操作

请求也可以不从画布来：用户在对话里说「生一张 X 放到画布上」「把这个视频放上去」「按画布上的标注改一版」。

- **生图放画布**：beast-gen 出图（免费档随便迭代，云端先说清消耗团队额度）→ 落本地 → Read 确认没问题 → `insert_cowart_image { imagePath }`。先 `get_cowart_selection` 看用户有没有选中东西：选中的是 AI 图片框（`isAiImageHolder` / `meta.cowartAiImageHolder`）→ `anchorShapeId` 传框 id，默认替换，图会等比放进框里居中，不用自己裁、不用传尺寸；选中的是别的图 → `anchorShapeId` 传它、`placement: "right"`；什么都没选 → 不传 anchor，放到空地。多张图从左到右排：第一张按上面放，之后每张用上一张返回的 `shapeId` 作 `anchorShapeId`，`replaceAiImageHolder: false`、`matchAnchor: false`、`placement: "right"`，不要拼成一张。
- **视频**：`insert_cowart_video { videoPath, anchorShapeId?, placement? }`；替换 AI 视频框用 `replaceHolderShapeId`。
- **HTML**：`insert_cowart_html_draft { htmlContent 或 htmlPath, fileName, anchorShapeId? }`。
- **放哪一页**：不传 `pageId` 的插入放进你负责的页；没负责页时放进你的画布页面正看着的页。别人负责的页会被拒绝，这时告诉用户在这个会话里说「接管 <页名>」，不要自己绕。处理画布请求时把结果放回请求那一页（宿主说明会给 `pageId`），哪怕这页后来换人了也放得进。
- **文件**：给插入工具的是本地路径，它自己拷进页素材目录，原文件不动。产物用时间戳或唯一文件名，不覆盖已有素材。
- **看画布**：`get_cowart_canvas_state` 是紧凑摘要：每页的图形（id、类型、页面上的左上角位置和尺寸、文字、所在的分组框）、素材本地路径、标注指向哪张卡片、谁负责哪页。`includeSnapshot: true` 只在真要原始 tldraw 记录时用，很大。`get_cowart_selection` 是用户在本会话画布页面里选中的东西。

### 4.1 整理页面：编号、标题、分组、排版、删除

用户说「给图编号」「分组」「排整齐」「加个标题 / 说明」「把 X 删掉」时用下面这几个工具。**不要手改画布文件**（`~/.cowart/canvas` 下的 JSON）：记录字段跟 tldraw 5.1 对不上，页面就显示不了，下次保存还会被悄悄丢掉，摘要里却照样列着，看着像成功了。也不要把字画成图片再插。

先 `get_cowart_canvas_state` 看这一页：每个图形一行，位置是它在页面上的左上角 (x, y) 和宽×高，「父级」是它所在的分组框，分组框带「标题「…」」和「内含 N 个图形」。下面所有工具的 x / y 都是这个坐标。

| 要做的事 | 工具 | 要点 |
|---|---|---|
| 排版、挪位置、改大小 | `update_cowart_shapes { updates: [{ shapeId, x, y }] }` | 一整批放一次调用，一起保存；`dx / dy` 是相对移动；图片 / 视频只给 `w` 或 `h` 时保持比例；卡片上的标注 / 注释箭头自动跟着走；已经在目标位置的那条不算错 |
| 编号、标题、说明文字 | `insert_cowart_text { items: [...] }` | 编号挂卡片下面：`{ text: "A1", anchorShapeId, textAlign: "middle" }`（文字框和卡片一样宽，所以居中）；标题给 `x / y` 和 `size: "xl"`。给的位置就是最终位置，**不会自动避让**：先用 update 留出空隙，一行字高约 s 24、m 32、l 49、xl 59 |
| 分组 | `insert_cowart_frame { name, shapeIds }` | 框按这些图形的范围定大小（`padding` 默认 40），它们原地进框；框在页面最底层，框标题显示在框的左上角外面（组与组之间留出约 60）；之后谁拖框，里面的东西和标注一起走 |
| 调整分组 | `update_cowart_shapes` | `frameId` 放进某个框、`"page"` 拿出来（位置都不变）；`fit: true` 让框刚好包住里面的东西；`name` 改框标题；`text` 改文字 |
| 删除 | `delete_cowart_shapes { shapeIds }` | 只删用户明确要删的；卡片的标注 / 注释跟着删；删分组框默认留下里面的东西（`deleteChildren: true` 才连内容一起删）；图 / 视频文件留在页素材目录，结果里给路径，要放回就用插入工具 |

- 放图 / 视频 / HTML 也能给 `x / y`（精确放到那里），或 `placement: "above"` 放到锚点上方。
- 典型的「给这页的图编号、分组」：摘要看尺寸 → 一次 `update_cowart_shapes` 排成网格（每行下面留出编号的高度，组之间留出框标题的位置）→ 一次 `insert_cowart_text` 给每张图加编号 → 每组一次 `insert_cowart_frame`（`shapeIds` 带上图和它的编号）→ 需要的话加大标题 → 再看一次摘要核对。
- 只能整理本会话负责的页（没负责页时是画布页面正看着、没人负责的那页）；一次调用只改一页。
- 这些改动在画布服务上完成，页面几秒内同步过来，但**用户在页面上按 Ctrl+Z 撤不回**。排版、编号放手做；删除前说清楚删哪些（拿不准就问），删完告诉用户删了什么、文件在哪。
- 结果里出现「⚠ … 超出了分组框」时照提示处理（给框 `fit: true`，或给它 `frameId: "page"`），不然页面上超出的部分被框裁掉。
- 摘要里标「⚠ … 是无效记录」的东西页面上看不到、下次保存会被丢掉，别当它在画布上；需要的话用工具重新放一份。

## 5. 标注和注释

标注是绑在卡片上的（数据层绑定，随画布保存），不是靠位置猜的。画布摘要里每条标注一行：

```
- shape:abc arrow (120, 80) 200×60 「把背景换成雪山」 标注（修改要求） → shape:img1
- shape:def arrow (…) 「这是主角，别换脸」 注释（常驻说明） → shape:img1
```

- 用户在对话里说「按标注改」：从摘要取标注文字和它指向的卡片（素材本地路径也在那行），**不需要向用户要截图，也不要按距离或颜色猜**。
- 标注（红）是这次要改的地方；注释（蓝）是常驻背景（人物不能变、品牌色这类），不是修改要求。
- 「改」不一定是改图：图是项目截图、设计稿时，标注多半是对界面、功能的意见或问题，照意见处理（答疑、改项目），别默认去生图。
- 结果放在原卡片旁边，原图和标注都不动、不删、不移。需求做完由用户自己点卡片工具栏的「清理标注」。
- 生成的图 / HTML 里不能带标注箭头、文字、选框或工具栏。

## 6. 工具速查

| 工具 | 干什么 | 要点 |
|---|---|---|
| `render_cowart_canvas_widget` | 打开画布、进入 / 接管页 | `sessionName`、`page`、`shownPage`；结果带网址、监听命令、谁负责哪页 |
| `get_cowart_canvas_state` | 画布摘要 | 默认不带快照 |
| `get_cowart_selection` | 本会话页面里选中的图形 | 判断 AI 图片框 / 锚点 |
| `insert_cowart_image` | 放图片 | `imagePath`；`anchorShapeId` + `placement`（right / left / below / above），或 `x / y`，或传 AI 图片框 id 替换它；`pageId` |
| `insert_cowart_video` | 放视频 | `videoPath`；`x / y` 或锚点 + `placement`；`replaceHolderShapeId` 替换 AI 视频框 |
| `insert_cowart_html_draft` | 放 / 替换 HTML 草稿、给 Slides 加页 | `htmlContent` 或 `htmlPath`、`draftShapeId`、`fileName` |
| `insert_cowart_text` | 放文字：编号、标题、说明 | `items`：`text` + `x / y` 或 `anchorShapeId` + `placement`；`size / color / font / textAlign` |
| `insert_cowart_frame` | 建分组框 | `name`、`shapeIds`（或空框的 `x / y / w / h`） |
| `update_cowart_shapes` | 批量移动、改尺寸、改文字 / 框标题、进出分组框 | `updates`：`shapeId` + `x / y`、`dx / dy`、`w / h`、`text`、`name`、`frameId`、`fit` |
| `delete_cowart_shapes` | 删除 | `shapeIds`；`deleteChildren` 连框里的东西一起删；页面 Ctrl+Z 撤不回 |
| `get_cowart_request` / `reply_cowart_request` / `list_cowart_requests` | 画布请求的详情、状态、列表 | 状态 running / done / failed / skipped |
| `send_cowart_feedback` | 记下用户对 Cowart 本身的意见 | 见第 7 节 |

没有整张保存的工具，也不要手写 tldraw 记录或手改画布文件：插入和整理工具会算位置、拷素材、按 tldraw 校验、存盘。

## 7. 反馈

用户说「反馈：…」「记个反馈」「给 Cowart 提个意见」，或抱怨 Cowart 本身（画布、面板、按钮、画布请求、生成、这些工具）哪里不好用时，调 `send_cowart_feedback` 记下来，交给 Cowart 仓库那边改。只是抱怨、没说要反馈的，先问一句要不要记。

- `text` 放用户原话，不改写、不删减；`title` 一句话（20 字左右）；`kind`：`bug` 坏了 / 结果不对，`friction` 能用但别扭、麻烦、慢，`idea` 想要的新功能。
- `details` 写你知道的情况：用户当时在做什么、点了什么、实际怎样、期望怎样、怎么复现。不知道的别编；最多问一句，别为补细节反复追问。
- 跟画布上的东西有关就传 `shapeIds`（说的不是本会话负责或正在看的页时再传 `pageId`）；有截图、生成结果之类的本地文件就传 `attachments`。
- 会话名、项目、负责 / 在看的页、代码版本、最近的画布请求、服务日志由服务自己附上，不用你收集。
- 只记录：不在当前项目里改 Cowart 的代码、配置或画布数据。记完告诉用户反馈编号。

## 8. 别做的事

- 不删页、不清页、不往别人负责的页写。
- 不手改 `~/.cowart/canvas` 下的文件，不把文字画成图片再插：文字、分组、排版、删除都有工具（4.1）。
- 不为面板里点发送的 AI 图片 / AI 视频插手：那是画布服务在做。
- 不重复 render；画布自己同步。
- 处理完画布请求后忘记重启监听（后台再跑一次监听命令）。
- 云端模型（lib-image、seedance、meshy）先说明消耗团队额度再用；免费本地模型随便迭代。
- 画布请求先问后做；撤销了就不做。
