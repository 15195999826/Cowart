// Claude Code side of the Cowart canvas: a thin MCP server per session. The canvas itself
// runs in the machine-wide canvas service (adapters/service), which serves it on localhost
// for the Browser pane, makes one session at a time responsible for each page and routes a
// page's requests to that session; this bridge describes the tools to Claude and forwards
// them to the service.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { CanvasServiceClient } from '../../service/client.mjs'
import { DEFAULT_PORT, VERSION } from '../../service/lib/identity.mjs'
import { AGENT_STATUSES, requestTask } from '../../service/lib/requests.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { ANNOTATION_EDIT_QUESTION, ANNOTATION_REMARKS_NOTE, listenCommand, requestLine, restartListenerNote } from './request-notice.mjs'

const LISTENER_SCRIPT = (process.env.COWART_BUNDLED === '1'
  ? join(ADAPTERS_DIR, 'generated', 'cowart-listen.mjs')
  : join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-listen.mjs')).replaceAll('\\', '/')
const HOST = 'claude'
// The canvas needs the desktop's Browser pane; other entry points get no tools.
const DESKTOP_ENTRYPOINT = 'claude-desktop'

const RENDER_TOOL = 'render_cowart_canvas_widget'
const CANVAS_STATE_TOOL = 'get_cowart_canvas_state'
const INSERT_VIDEO_TOOL = 'insert_cowart_video'
const GET_REQUEST_TOOL = 'get_cowart_request'
const REPLY_REQUEST_TOOL = 'reply_cowart_request'
const LIST_REQUESTS_TOOL = 'list_cowart_requests'

// Claude Code keeps only the first 2048 characters of an MCP server's instructions (measured
// 2026-09-14: the rest is cut off in the system prompt). So this says what the canvas is, how
// to open it, that requests are confirmed first and when to record feedback (send_cowart_feedback,
// a tool of the canvas service); everything else lives in the cowart skill
// (adapters/claude/skills/cowart), which the model loads before working on the canvas. The
// smoke test checks the length.
export const INSTRUCTIONS_LIMIT = 2048
export const INSTRUCTIONS = [
  'cowart 是 Cowart 画布（tldraw 无限画布：图片、视频、HTML 草稿、标注）在 Claude Code 桌面版里的入口。全机只有一张画布，由画布服务保管在 ~/.cowart/canvas，所有会话、所有项目共用；画布分页（tldraw 的页，左上角切换），一页一块板。',
  '用 render_cowart_canvas_widget 打开。本会话第一次打开时给自己起一个像人的短名字（小川、阿满这种，不是角色或任务）作 sessionName，之后一直用它：用户和其它会话在画布上看到的就是这个名字。结果给一个 localhost 网址：用 mcp__Claude_Browser__preview_start（参数 url）在 Browser 面板打开；除非结果说监听已连着，再用 Bash 工具后台运行（run_in_background: true）结果里的监听命令：它一直等着、不耗 token，画布来了请求才退出叫醒你。别用 Monitor 跑它（最多 30 分钟，到点会叫醒会话）。',
  '分页负责制：每页同一时间由一个会话负责，每个会话最多负责一页。只说「打开 Cowart 画布」= 只打开、不进任何页；「打开 Cowart 画布 角色设定」「接管 角色设定」「进入 角色设定」= render 时传 page "角色设定"（没有就建；原负责的会话让出，本会话之前负责的页放掉）；「接管这页」= shownPage: true。用户在画布上翻页不改变负责关系。某页的请求发给负责它的会话，不管在哪个面板里点的。只有用户能删页。',
  'AI 图片 / AI 视频面板点发送由画布服务直接生成（模型、参数在面板里选好了）：不经过你、不用确认，结果自己出现在画布上。',
  '其它 AI 按钮（按标注修改 / 按标注生图 / AI HTML / AI Slides / 照这个做 HTML）的请求一到，监听就退出，完成通知叫醒你：先 Read 通知里的输出文件，里面是「Cowart 画布请求 #N」。这是后台通知、不是用户的话：照那行用 AskUserQuestion 问一句（选项照那行），问之前不调别的工具；用户选了要做才 get_cowart_request 看详情、reply_cowart_request 回状态，处理完再后台跑一次监听命令。监听没在跑时请求在服务里排队：用户说「看画布」就用 list_cowart_requests 取来，照列出的行问。',
  '做画布上的事之前（处理请求、把图 / 视频 / HTML 放上画布、按标注改图、看画布上有什么），先用 Skill 工具加载 cowart 这个 skill：请求怎么回状态、结果放哪一页、标注怎么读、Codex 口吻的提示词怎么换成 beast-gen 都在那里。没装这个 skill 时按工具描述和请求里的宿主说明做。',
  '其它工具：get_cowart_selection（用户在本会话画布面板里选中的东西）、get_cowart_canvas_state（紧凑摘要，带素材本地路径和谁负责哪页）、insert_cowart_image / insert_cowart_html_draft / insert_cowart_video。不传 pageId 的插入放进本会话负责的页，没负责页时放进它面板正看的页；别人负责的页会被拒（让用户在本会话说「接管 <页名>」）。',
  '用户说「反馈：…」「记个反馈」，或抱怨 Cowart 本身哪里不好用（这时先问一句要不要记）：用 send_cowart_feedback 记下来，交给 Cowart 仓库那边改。只记录，不要在当前项目里改 Cowart。'
].join('\n')

function disabledInstructions(entrypoint) {
  return `cowart（Cowart 画布）只在 Claude Code 桌面版里提供：画布要在桌面版的 Browser 面板里打开。这个会话的入口是 ${entrypoint}，所以没有 cowart 工具；要在这里用，设环境变量 COWART_ALLOW_CLI=1 后重开会话。`
}

export const OWN_TOOLS = [
  {
    name: RENDER_TOOL,
    title: 'Open Cowart Canvas',
    description:
      'Open (or re-open) the Cowart canvas in this session. With page (a page name) or shownPage, this session becomes responsible for that page: 「打开 Cowart 画布 角色设定」 / 「接管 角色设定」 → page "角色设定" (created when missing); 「接管这页」 → shownPage: true. Without either, the canvas opens and no page changes hands. Returns a localhost URL to open in the Browser pane, the listener command that delivers canvas requests to this session (run in the background: it exits, and so wakes the session, only when a request comes), and who is responsible for which page.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page to take responsibility for, by name (e.g. 角色设定); created if missing. The canvas pane opens on it.' },
        shownPage: { type: 'boolean', description: 'Take responsibility for the page this session\'s canvas pane currently shows (「接管这页」).' },
        sessionName: {
          type: 'string',
          description: 'This session\'s name on the canvas: a short human first name you pick once (e.g. 小川) and keep for the whole session. Must differ from the other sessions\' names.'
        },
        title: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: CANVAS_STATE_TOOL,
    title: 'Get Cowart Canvas Summary',
    description:
      'Summarize the Cowart canvas: pages, shapes (id, type, position, size, text) and their image/video assets with local file paths, plus which session is responsible for which page. Pass includeSnapshot: true only if the raw tldraw snapshot is really needed (it can be very large).',
    inputSchema: {
      type: 'object',
      properties: { includeSnapshot: { type: 'boolean' } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: INSERT_VIDEO_TOOL,
    title: 'Insert Cowart Video',
    description:
      'Copy a local video (mp4 / mov / webm) into the canvas page assets and place a playable tldraw video shape: beside anchorShapeId (placement right/left/below, height matched by default) or to the right of existing content. The open canvas picks it up within seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: 'Local path of the video file.' },
        pageId: { type: 'string' },
        anchorShapeId: { type: 'string', description: 'Place the video next to this shape (e.g. the source image).' },
        placement: { type: 'string', enum: ['right', 'left', 'below'] },
        margin: { type: 'number' },
        matchAnchor: { type: 'boolean' },
        displayWidth: { type: 'number' },
        displayHeight: { type: 'number' },
        videoWidth: { type: 'number', description: 'Pixel width if it cannot be probed from the file.' },
        videoHeight: { type: 'number', description: 'Pixel height if it cannot be probed from the file.' },
        fileName: { type: 'string' },
        altText: { type: 'string' },
        shapeMeta: { type: 'object' },
        replaceHolderShapeId: {
          type: 'string',
          description: 'AI 视频 holder to replace: the video takes its place (fitted inside it) and the holder is removed.'
        }
      },
      required: ['videoPath']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: GET_REQUEST_TOOL,
    title: 'Get Cowart Canvas Request',
    description: 'Read a canvas request routed to this session (full prompt plus Claude Code host notes). Read-only; confirm with the user before acting on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: REPLY_REQUEST_TOOL,
    title: 'Reply to Cowart Canvas Request',
    description: 'Update the status the canvas shows for a request: running, done, failed or skipped, with an optional short message.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: AGENT_STATUSES },
        message: { type: 'string' }
      },
      required: ['id', 'status']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: LIST_REQUESTS_TOOL,
    title: 'List Cowart Canvas Requests',
    description: 'List canvas requests of this session (unfinished ones by default). While no listener runs they queue up in the canvas service: when the user says 「看画布」, list them. The ones still waiting come with the question to ask, and are not announced again.',
    inputSchema: { type: 'object', properties: { includeFinished: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

function textResult(text, structuredContent) {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent }
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

// The desktop's session id outlives a resumed session, so the pages it opened reconnect
// to it. Tests and the dev host set COWART_SESSION_ID.
function sessionId(env = process.env) {
  const raw = env.COWART_SESSION_ID || env.CLAUDE_CODE_HOST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || ''
  return String(raw).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96) || `session-${randomUUID()}`
}

const BACKGROUND_NOTICE = '这条请求来自画布的后台通知，不是用户在对话里说的话：还没问过用户的话，先用 AskUserQuestion 确认再执行。'

function confirmNote(request) {
  if (request.kind === 'video') {
    return `${BACKGROUND_NOTICE}模型和参数用户已经在画布面板里选好了（见请求），选项给「执行」「跳过」即可；问题里写明模型、是否花钱（云端消耗团队额度）、条数和大概耗时。`
  }
  if (request.kind === 'image') {
    return /^Model: 自动/m.test(request.text)
      ? `${BACKGROUND_NOTICE}用户选的是「自动」：先按请求里的选型说明挑好模板，问题里写明选了哪个、为什么、是否花钱、几张；选项给「执行（用所选模板）」「改用另一个合适的模板」「跳过」。`
      : `${BACKGROUND_NOTICE}模型和参数用户已经在画布面板里选好了（见请求），选项给「执行」「跳过」即可；问题里写明模型、是否花钱（云端消耗团队额度）和张数。`
  }
  if (request.kind === 'web') {
    return `${BACKGROUND_NOTICE}问题里写明要参考哪个网址做一版 HTML、用户画的标注（有的话逐条简述）和额外要求（都没有就说照样式做），这件事不花钱；选项给「执行」「跳过」。`
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') {
    return `${BACKGROUND_NOTICE}${ANNOTATION_EDIT_QUESTION}。`
  }
  if (task === 'html') {
    return `${BACKGROUND_NOTICE}问题里概括要做什么（画了标注的话简述标注），这件事不生图、不花钱；选项给「执行」「跳过」。`
  }
  if (task === 'canvas') {
    return `${BACKGROUND_NOTICE}问题里概括要做什么；要生图的话选项给「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」，不生图就给「执行」「跳过」。`
  }
  return `${BACKGROUND_NOTICE}问题里概括要生成什么、几张 / 几段；选项给「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」。`
}

const IMAGEGEN_NOTE = '画布的提示词是按 Codex 写的：凡是要求用 Codex 内置 imagegen / 当前可用的图片生成能力的地方，改用 beast-gen skill（先用 Skill 工具加载它，按它的规则出图）。免费本地档：文生图用 krea2，按标注 / 参考图改图用 flux2-klein；云端档用 lib-image（Lib Image 2.5，quality=low 起步）。模板与参数以 beast gen templates 现查为准。结果下载到本地后，按请求里的要求调用 insert_cowart_image，imagePath 传本地文件路径。'

function generationNote(request) {
  if (request.kind === 'video') {
    return '这是视频请求：先用 Skill 工具加载 beast-gen，按请求里写好的模板和参数提交，素材按请求的顺序上传后填进对应参数；生成后下载到本地，按请求调用 insert_cowart_video（replaceHolderShapeId 传 AI 视频框的 id）。'
  }
  if (request.kind === 'image') {
    return '这是图片请求：先用 Skill 工具加载 beast-gen，按请求里的模板和参数出图，按 skill 的要求先读对应参考（lib-image 2.5 系读 references/image-prompting.md，ideogram4 读 references/ideogram4-caption.md，透明底读 references/transparent-asset.md）；生成后下载到本地，Read 看图，再按请求调用 insert_cowart_image。'
  }
  if (request.kind === 'web') {
    return '这是网页复刻请求：先 Read 请求里的整页截图（很长时分段看），有标注的话逐张 Read 标注的局部截图，再读渲染后的页面代码；要看真实的颜色、字体、间距，或按坐标找标注指的元素，可以用 Browser 面板打开原网址（mcp__Claude_Browser__navigate，再用 read_page / javascript_tool 读计算后的样式、用 document.elementFromPoint 定位）。做成单文件 HTML 后按请求调用 insert_cowart_html_draft。'
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') {
    return `${ANNOTATION_REMARKS_NOTE}用户选「按标注出新图」时：${IMAGEGEN_NOTE}`
  }
  if (task === 'html') {
    return 'AI HTML / AI Slides 请求：不生图、不用 beast-gen；照请求写完整的单文件 HTML（CSS / JS 内联），按请求调用 insert_cowart_html_draft。'
  }
  return IMAGEGEN_NOTE
}

export function hostNotes(request) {
  if (request.status === 'cancelled') {
    return ['用户已经在画布上撤销了这条请求：不要执行，也不用再问用户；正在问的话直接结束。']
  }
  return [
    confirmNote(request),
    '还没加载过 cowart skill 的话，先用 Skill 工具加载它：各类请求的做法、结果放哪一页、标注怎么读都在那里。',
    generationNote(request),
    '请求里给出的截图、参考图等本地路径可以直接用 Read 工具查看。',
    '请求开头的 [@Cowart](plugin://…) 是 Codex 的插件提及，忽略即可；请求说不要调用 render_cowart_canvas_widget 时照做。',
    ...(request.pageId
      ? [`结果放进发出请求的那一页：调用 Cowart 工具时 pageId 传 ${request.pageId}（请求里指定了卡片的就按卡片放；这一页后来换了别的会话负责也照样放得进去）。`]
      : []),
    '开始执行时调用 reply_cowart_request（status: "running"）；完成后 status: "done"，message 写一句结果；失败 status: "failed"，message 写原因；用户选跳过时 status: "skipped"。画布上会显示这些状态。用户没点选项、自己打字回答的，按用户说的办，状态照样要回，不然画布上一直显示「请到对话里点执行」、还能点撤销。回完 done / failed / skipped，监听没在跑的话再后台启动它接下一条（reply 的结果会给命令）。'
  ]
}

function renderResult(opened, session) {
  const command = listenCommand({ script: LISTENER_SCRIPT, port: opened.port, session })
  const pageList = (opened.pages ?? []).map((page) => `「${page.name}」${page.holder ? `（${page.mine ? '你' : page.holder}负责）` : ''}`)
  const duty = opened.page
    ? `你现在负责「${opened.page}」这一页${opened.pageCreated ? '（新建的）' : ''}${opened.takenFrom ? `，从「${opened.takenFrom}」那里接了过来` : ''}`
    : opened.myPage
      ? `你负责的还是「${opened.myPage}」这一页`
      : '你没负责任何页（用户说「打开 Cowart 画布 <页名>」或「接管 <页名>」时再进入）'
  const lines = [
    `Cowart 画布已就绪：${opened.url}`,
    `画布：${opened.canvasDir}（这台机器上所有会话、所有项目共用这一张，按页分工）`,
    `你在画布上的名字：${opened.sessionName}。${duty}。`,
    ...(pageList.length > 0 ? [`这张画布的页：${pageList.join('、')}。每一页同一时间由一个会话负责：那一页的画布请求发给它，别的会话不能往那一页放东西。`] : []),
    '',
    '接下来：',
    opened.paneOpen
      ? '1. 这个会话的画布面板已经开着，它会自动跳到这一页，不用重新打开。'
      : '1. 在 Browser 面板打开上面的网址（mcp__Claude_Browser__preview_start，参数 url）。没有 Browser 面板时把网址发给用户，在浏览器里打开。',
    opened.listenerConnected
      ? '2. 这个会话的画布请求监听已经连着，不要重复启动。'
      : `2. 用 Bash 工具后台启动画布请求监听（run_in_background: true，description: "Cowart 画布请求"），命令：\n   ${command}\n   它一直等着、不耗 token，画布上真来了请求才退出，退出的通知会叫醒你（通知里只有输出文件路径：先 Read 它，照里面那行用 AskUserQuestion 问用户）；处理完再这样启动一次接下一条。别用 Monitor 跑它：Monitor 最多 30 分钟，到点就会叫醒会话。`,
    '画布里点 AI 按钮时就是这样叫醒你的：「Cowart 画布请求 #N」→ 先问用户，用户选了要做再 get_cowart_request 看详情照做。监听没在跑时请求在服务里排队，用户说「看画布」时用 list_cowart_requests 取。',
    '之后的 Cowart 工具都作用在这张画布上：不传 pageId 的插入放进你负责的页，没负责页时放进你的画布面板正看着的页。'
  ]
  return textResult(lines.join('\n'), { ...opened, listenCommand: command })
}

function requestDetails(request) {
  const notes = hostNotes(request)
  const text = [
    `画布请求 #${request.id}「${request.title}」 状态：${request.status}${request.pageName ? `，来自「${request.pageName}」这一页` : ''}`,
    '',
    '—— 画布发来的原始请求 ——',
    request.text,
    '',
    '—— Claude Code 宿主说明 ——',
    ...notes.map((note) => `- ${note}`)
  ].join('\n')
  return textResult(text, { ...request, hostNotes: notes })
}

// Listed in the conversation (看画布): the requests still waiting come with their question and,
// when no listener runs, how to start it again.
function requestList({ requests, listenerConnected }, command) {
  const lines = requests.length ? requests.map(requestLine) : ['没有待处理的画布请求。']
  if (listenerConnected === false) lines.push('', restartListenerNote(command))
  return textResult(lines.join('\n'), { requests, listenerConnected })
}

export async function startClaudeBridge() {
  const log = (message) => process.stderr.write(`[cowart-claude] ${message}\n`)
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  const enabled = !entrypoint || entrypoint === DESKTOP_ENTRYPOINT || process.env.COWART_ALLOW_CLI === '1'
  const server = new Server(
    { name: 'cowart', version: VERSION },
    { capabilities: { tools: {} }, instructions: enabled ? INSTRUCTIONS : disabledInstructions(entrypoint) }
  )

  let service = null
  let shuttingDown = false
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    service?.close()
    process.exit(0)
  }
  server.onclose = shutdown
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (!enabled) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    server.setRequestHandler(CallToolRequestSchema, async () => errorResult(disabledInstructions(entrypoint)))
    await server.connect(new StdioServerTransport())
    return
  }

  const session = sessionId()
  service = new CanvasServiceClient({
    host: HOST,
    session,
    cwd: process.cwd(),
    port: Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT,
    log
  })
  // This session's listener command, on the port the service runs on now.
  const command = () => listenCommand({ script: LISTENER_SCRIPT, port: service.port, session })
  const ready = service.start()
  ready.then(
    () => log(`session ${session} connected to the canvas service on port ${service.port}`),
    (error) => log(`canvas service unavailable: ${error.message}`)
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Without the service the upstream tools are unknown; the own tools still explain why.
    const forwarded = await ready
      .then(() => service.call('model-tools'))
      .then((result) => result.tools)
      .catch(() => [])
    const [render, canvasState, ...rest] = OWN_TOOLS
    return { tools: [render, canvasState, ...forwarded, ...rest] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const args = request.params.arguments ?? {}
    try {
      switch (name) {
        case RENDER_TOOL:
          return renderResult(await service.call('open-canvas', args), session)
        case CANVAS_STATE_TOOL:
          return await service.call('canvas-state', args)
        case INSERT_VIDEO_TOOL:
          return await service.call('insert-video', args)
        case GET_REQUEST_TOOL:
          return requestDetails((await service.call('request-get', { id: args.id })).request)
        case REPLY_REQUEST_TOOL: {
          const { request: updated, listenerConnected } = await service.call('request-reply', { id: args.id, status: args.status, message: args.message })
          const lines = [`已把画布请求 #${updated.id} 标成 ${updated.status}${updated.message ? `：${updated.message}` : ''}`]
          // Done with this one: the next request needs the listener running again.
          if (listenerConnected === false && updated.status !== 'running') lines.push(restartListenerNote(command()))
          return textResult(lines.join('\n'), updated)
        }
        case LIST_REQUESTS_TOOL:
          return requestList(await service.call('request-list', { includeFinished: args.includeFinished === true, acknowledge: true }), command())
        default:
          return await service.call('tool', { name, arguments: args })
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  await server.connect(new StdioServerTransport())
}
