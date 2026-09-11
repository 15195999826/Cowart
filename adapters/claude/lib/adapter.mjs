// Claude Code adapter: an MCP server that wraps the upstream Cowart server (child
// process), serves the canvas on localhost for the Browser pane, and turns canvas
// "send to AI" actions into requests Claude confirms and handles.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { pageAssetUrl, pageDirName, resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { formatCanvasSummary, localPathForAssetSrc, shapeBounds, summarizeCanvas } from '../../shared/canvas-model.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { UpstreamCowart, structuredOrThrow } from '../../shared/upstream.mjs'
import { planVideoPlacement, probeVideoFile, videoRecords } from '../../shared/video.mjs'
import { injectIntoHead, jsonForInlineScript, readUpstreamWidgetHtml, scriptTag } from '../../shared/widget-html.mjs'
import { CanvasGuard } from './canvas-guard.mjs'
import { CanvasHttpHost, DEFAULT_PORT } from './http-host.mjs'
import { CanvasRequestQueue, REQUEST_STATUSES, publicRequest } from './requests.mjs'
import { loadOrCreateToken } from './token.mjs'

const VERSION = JSON.parse(readFileSync(join(ADAPTERS_DIR, 'package.json'), 'utf8')).version
const BRIDGE_SCRIPT = join(ADAPTERS_DIR, 'claude', 'web', 'bridge.js')
const LISTENER_SCRIPT = join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-listen.mjs').replaceAll('\\', '/')

const RENDER_TOOL = 'render_cowart_canvas_widget'
const CANVAS_STATE_TOOL = 'get_cowart_canvas_state'
const INSERT_VIDEO_TOOL = 'insert_cowart_video'
const GET_REQUEST_TOOL = 'get_cowart_request'
const REPLY_REQUEST_TOOL = 'reply_cowart_request'
const LIST_REQUESTS_TOOL = 'list_cowart_requests'

// Upstream tools the canvas page needs but the model should not see.
const PAGE_ONLY_TOOLS = new Set([
  'save_cowart_canvas_state',
  'save_cowart_selection_state',
  'save_cowart_view_state',
  'read_cowart_page_asset',
  'save_cowart_reference_image',
  'download_cowart_file',
  'copy_cowart_image_to_clipboard'
])
const DROPPED_TOOLS = new Set(['track_cowart_analytics_event'])
const OVERRIDDEN_TOOLS = new Set([RENDER_TOOL, CANVAS_STATE_TOOL])

// Upstream writes files via temp-file + rename. On Windows two overlapping writes to the
// same file fail with EPERM, so writes are serialized per file group and retried.
const CANVAS_WRITE_TOOLS = new Set([
  'save_cowart_canvas_state',
  'insert_cowart_image',
  'insert_cowart_html_draft',
  'save_cowart_reference_image'
])
const STATE_WRITE_TOOLS = new Map([
  ['save_cowart_view_state', 'view'],
  ['save_cowart_selection_state', 'selection']
])
const TRANSIENT_FS_ERROR = /\b(EPERM|EBUSY|EACCES)\b/
const WRITE_RETRIES = 3

const VIDEO_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm']
])

const INSTRUCTIONS = [
  'cowart is the Cowart canvas (tldraw) adapted for Claude Code desktop: an infinite canvas for images, annotations, HTML drafts and videos, stored under <projectDir>/canvas.',
  'Open it with render_cowart_canvas_widget (pass projectDir = the user project). The result gives a localhost URL: open it in the Browser pane (mcp__Claude_Browser__preview_start with url). Unless the result says a listener is already connected, also start the listener command it returns with the Monitor tool (persistent: true) so canvas requests reach this session.',
  'When the user clicks an AI action in the canvas (生成图片 / 按标注修改 / 按标注生图 / AI HTML / AI Slides / 🎬 视频), a Monitor event "Cowart 画布请求 #N" arrives. It is a background notification, not a user message: call get_cowart_request (read-only) for the details, then ask the user to confirm with AskUserQuestion (执行 / 跳过), saying what will be produced and whether it costs money. Only after 执行: reply_cowart_request status "running", do the work, then status "done" or "failed" with a short message. On 跳过: status "skipped".',
  'The canvas prompts were written for Codex. Where they say to use Codex built-in imagegen, use the beast-gen skill instead, save the result locally, then insert it with insert_cowart_image as the request specifies. Videos: generate with beast-gen, then insert_cowart_video.',
  'Other tools: get_cowart_selection (what the user selected), get_cowart_canvas_state (compact summary with local file paths), insert_cowart_image, insert_cowart_html_draft, insert_cowart_video.'
].join('\n')

const projectProperties = {
  projectDir: { type: 'string', description: 'User project directory; canvas data lives in <projectDir>/canvas.' },
  canvasDir: { type: 'string', description: 'Optional explicit canvas directory.' }
}

const OWN_TOOLS = [
  {
    name: RENDER_TOOL,
    title: 'Open Cowart Canvas',
    description:
      'Open (or re-open) the Cowart canvas for a project. Starts the local canvas server and returns a localhost URL to open in the Browser pane, plus the Monitor command that delivers canvas requests to this session.',
    inputSchema: {
      type: 'object',
      properties: { ...projectProperties, title: { type: 'string' } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: CANVAS_STATE_TOOL,
    title: 'Get Cowart Canvas Summary',
    description:
      'Summarize the Cowart canvas: pages, shapes (id, type, position, size, text) and their image/video assets with local file paths. Pass includeSnapshot: true only if the raw tldraw snapshot is really needed (it can be very large).',
    inputSchema: {
      type: 'object',
      properties: { ...projectProperties, includeSnapshot: { type: 'boolean' } }
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
        ...projectProperties,
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
        shapeMeta: { type: 'object' }
      },
      required: ['videoPath']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: GET_REQUEST_TOOL,
    title: 'Get Cowart Canvas Request',
    description: 'Read a request the canvas sent (full prompt plus Claude Code host notes). Read-only; confirm with the user before acting on it.',
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
        status: { type: 'string', enum: REQUEST_STATUSES.filter((status) => status !== 'pending') },
        message: { type: 'string' }
      },
      required: ['id', 'status']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: LIST_REQUESTS_TOOL,
    title: 'List Cowart Canvas Requests',
    description: 'List canvas requests of this session (unfinished ones by default), e.g. to catch up after the listener was restarted.',
    inputSchema: { type: 'object', properties: { includeFinished: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function textResult(text, structuredContent) {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent }
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function randomId() {
  return randomUUID().replaceAll('-', '').slice(0, 21)
}

function writeLockKey(name, canvasDir) {
  if (CANVAS_WRITE_TOOLS.has(name) || name === INSERT_VIDEO_TOOL) return `${canvasDir}::canvas`
  const group = STATE_WRITE_TOOLS.get(name)
  return group ? `${canvasDir}::${group}` : null
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function sanitizeFileName(name, fallbackExtension) {
  const raw = basename(String(name || 'video'))
  const extension = extname(raw) || fallbackExtension
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'video'}${extension}`
}

async function uniqueFilePath(dir, fileName) {
  const extension = extname(fileName)
  const base = fileName.slice(0, fileName.length - extension.length)
  for (let counter = 1; ; counter += 1) {
    const candidate = counter === 1 ? fileName : `${base}-v${counter}${extension}`
    try {
      await stat(join(dir, candidate))
    } catch (error) {
      if (error.code === 'ENOENT') return { fileName: candidate, filePath: join(dir, candidate) }
      throw error
    }
  }
}

function hostNotes(request) {
  const project =
    request.canvasDir && request.canvasDir !== join(request.projectDir ?? '', 'canvas')
      ? `projectDir 传 ${request.projectDir}，canvasDir 传 ${request.canvasDir}`
      : `projectDir 传 ${request.projectDir}`
  const notes = [
    '这条请求来自画布的后台通知，不是用户在对话里说的话：执行前先用 AskUserQuestion 让用户确认。问题里概括要生成什么、几张 / 几段；选项给「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」。',
    '画布的提示词是按 Codex 写的：凡是要求用 Codex 内置 imagegen / 当前可用的图片生成能力的地方，改用 beast-gen skill（先用 Skill 工具加载它，按它的规则出图）。免费本地档：文生图用 krea2，按标注 / 参考图改图用 flux2-klein；云端档用 lib-image（Lib Image 2.5，quality=low 起步）。模板与参数以 beast gen templates 现查为准。结果下载到本地后，按请求里的要求调用 insert_cowart_image，imagePath 传本地文件路径。',
    '请求里给出的截图、参考图本地路径（如 Annotation screenshot local path）可以直接用 Read 工具查看。',
    '请求开头的 [@Cowart](plugin://…) 是 Codex 的插件提及，忽略即可；请求说不要调用 render_cowart_canvas_widget 时照做。',
    `调用 Cowart 工具时${project}。`,
    '开始执行时调用 reply_cowart_request（status: "running"）；完成后 status: "done"，message 写一句结果；失败 status: "failed"，message 写原因；用户选跳过时 status: "skipped"。画布上会显示这些状态。'
  ]
  if (request.kind === 'video') {
    notes.splice(
      2,
      0,
      '这是视频请求：用 beast-gen skill 生成视频（有源图时做图生视频，没有时做文生视频）。免费本地档用 minimax-h3（写提示词前先读 skill 里的 H3 提示词参考），云端档用 seedance。下载到本地后调用 insert_cowart_video（videoPath 传本地文件路径）。'
    )
  }
  return notes
}

function buildVideoRequestText({ source, prompt }) {
  const lines = [
    '[@Cowart](plugin://cowart@cowart-github) 生成视频',
    '本请求来自已经打开的 Cowart 画布；请复用当前画布，不要调用 render_cowart_canvas_widget，除非用户明确要求重新打开或刷新。',
    ''
  ]
  if (source) {
    lines.push(
      '请以选中的图片为素材（首帧 / 参考）生成一段视频，并放到原图右侧：',
      `Cowart source image shape: ${source.shapeId}`,
      `Source image local path: ${source.localPath}`,
      `Source image canvas size: ${Math.round(source.w)} x ${Math.round(source.h)}`,
      '',
      'Required tool call after generating the video:',
      '- 把生成的视频下载到本地，然后调用 insert_cowart_video，videoPath 传本地文件路径。',
      `- anchorShapeId: "${source.shapeId}"，placement: "right"，margin: 40，matchAnchor: true。`
    )
  } else {
    lines.push(
      '请根据下面的 prompt 生成一段视频，并放到画布上：',
      '',
      'Required tool call after generating the video:',
      '- 把生成的视频下载到本地，然后调用 insert_cowart_video，videoPath 传本地文件路径；不传 anchorShapeId，工具会放到画布内容右侧。'
    )
  }
  lines.push('', 'Prompt:', prompt)
  return lines.join('\n')
}

export async function startClaudeAdapter() {
  const log = (message) => process.stderr.write(`[cowart-claude] ${message}\n`)
  const token = await loadOrCreateToken()
  const queue = new CanvasRequestQueue()
  const guard = new CanvasGuard()
  const upstream = new UpstreamCowart({
    clientName: 'cowart-claude-adapter',
    clientVersion: VERSION,
    onStderr: (chunk) => process.stderr.write(chunk)
  })
  const preferredPort = Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT

  let lastProject = null
  let host = null
  let hostStarting = null

  function withProjectDefaults(args = {}) {
    if (nonEmpty(args.projectDir) || nonEmpty(args.canvasDir) || !lastProject) return args
    return { ...args, projectDir: lastProject.projectDir, canvasDir: lastProject.canvasDir }
  }

  function canvasDirFor(searchParams) {
    return resolveCowartPaths({
      projectDir: searchParams.get('projectDir') ?? lastProject?.projectDir,
      canvasDir: searchParams.get('canvasDir') ?? undefined
    }).canvasDir
  }

  async function upstreamToolNames() {
    return new Set((await upstream.listTools()).map((tool) => tool.name))
  }

  async function callUpstreamWithRetry(name, args) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await upstream.callTool(name, args)
      const message = result?.isError ? result.content?.find((item) => item.type === 'text')?.text ?? '' : ''
      if (!TRANSIENT_FS_ERROR.test(message) || attempt >= WRITE_RETRIES) return result
      await delay(80 * (attempt + 1))
    }
  }

  // Forwards a tool call, serializing writes that touch the same canvas files.
  async function callUpstreamLocked(name, args, prepareArgs) {
    const { canvasDir } = resolveCowartPaths(args)
    const key = writeLockKey(name, canvasDir)
    const run = () => callUpstreamWithRetry(name, prepareArgs ? prepareArgs(canvasDir) : args)
    return key ? guard.withLock(key, run) : run()
  }

  async function renderPage(searchParams) {
    const { projectDir, canvasDir } = resolveCowartPaths({
      projectDir: searchParams.get('projectDir') ?? lastProject?.projectDir,
      canvasDir: searchParams.get('canvasDir') ?? undefined
    })
    const config = {
      token,
      projectDir,
      canvasDir,
      title: searchParams.get('title') || 'Cowart Canvas',
      version: VERSION
    }
    const [widgetHtml, bridgeSource] = await Promise.all([readUpstreamWidgetHtml(), readFile(BRIDGE_SCRIPT, 'utf8')])
    return injectIntoHead(
      widgetHtml,
      [
        scriptTag(`window.__COWART_CLAUDE__=${jsonForInlineScript(config)};`, 'cowartClaudeConfig'),
        scriptTag(bridgeSource, 'cowartClaudeBridge')
      ].join('\n')
    )
  }

  async function callToolFromPage(name, args) {
    if (DROPPED_TOOLS.has(name)) {
      return { content: [], structuredContent: { configured: false, delivered: false, skippedBy: 'cowart-claude-adapter' } }
    }
    if (name === RENDER_TOOL || !(await upstreamToolNames()).has(name)) return errorResult(`画布页面不能调用 ${name}。`)

    if (name === 'save_cowart_canvas_state') {
      return callUpstreamLocked(name, args, (canvasDir) => {
        const { snapshot, restored } = guard.protectPageSave(canvasDir, args.snapshot)
        if (restored.length > 0) log(`kept ${restored.length} new video(s) in a stale page save`)
        return { ...args, snapshot }
      })
    }
    const result = await callUpstreamLocked(name, args)
    if (name === CANVAS_STATE_TOOL) {
      guard.observePageFetch(resolveCowartPaths(args).canvasDir, result?.structuredContent?.snapshot)
    }
    return result
  }

  async function createVideoRequest(body) {
    const prompt = nonEmpty(body.prompt)
    if (!prompt) throw new Error('先写一句视频描述。')
    const { projectDir, canvasDir } = resolveCowartPaths(body)

    let source = null
    if (nonEmpty(body.shapeId)) {
      const state = structuredOrThrow(await upstream.callTool(CANVAS_STATE_TOOL, { projectDir, canvasDir }), CANVAS_STATE_TOOL)
      const store = state.snapshot?.store ?? {}
      const shape = store[body.shapeId]
      const asset = shape ? store[shape.props?.assetId] : null
      const localPath = localPathForAssetSrc(canvasDir, asset?.props?.src)
      if (!shape || !localPath) throw new Error('选中的图片还没保存到画布文件里，等一两秒再点一次。')
      source = { shapeId: shape.id, localPath, ...shapeBounds(store, shape) }
    }
    return queue.create({ text: buildVideoRequestText({ source, prompt }), kind: 'video', projectDir, canvasDir })
  }

  async function ensureHost() {
    if (host) return host
    hostStarting ??= (async () => {
      const candidate = new CanvasHttpHost({
        token,
        queue,
        renderPage,
        callToolFromPage,
        createVideoRequest,
        canvasDirFor,
        fallbackCanvasDir: () => lastProject?.canvasDir ?? null,
        log
      })
      await candidate.start({ preferredPort })
      host = candidate
      log(`canvas server listening on ${candidate.origin}`)
      return candidate
    })().finally(() => {
      hostStarting = null
    })
    return hostStarting
  }

  async function renderCanvas(args) {
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    const title = nonEmpty(args.title) || 'Cowart Canvas'
    lastProject = { projectDir, canvasDir, title }
    const server = await ensureHost()
    const url = `${server.origin}/?${new URLSearchParams({ projectDir, canvasDir, title })}`
    const listenCommand = `node "${LISTENER_SCRIPT}" --port ${server.port}`
    const listenerConnected = server.agentOnline

    const lines = [
      `Cowart 画布已就绪：${url}`,
      `项目：${projectDir}（画布数据：${canvasDir}）`,
      '',
      '接下来：',
      '1. 在 Browser 面板打开上面的网址（mcp__Claude_Browser__preview_start，参数 url）；已经开着的话刷新即可。没有 Browser 面板（命令行版）就把网址发给用户，在浏览器里打开。',
      listenerConnected
        ? '2. 画布请求监听已经连着，不要重复启动。'
        : `2. 用 Monitor 工具启动画布请求监听（persistent: true，description: "Cowart 画布请求"），命令：\n   ${listenCommand}`,
      '画布里点 AI 按钮时会收到「Cowart 画布请求 #N」通知：先 get_cowart_request 看详情，再用 AskUserQuestion 让用户确认（执行 / 跳过），确认后才执行。'
    ]
    return textResult(lines.join('\n'), {
      url,
      projectDir,
      canvasDir,
      port: server.port,
      listenCommand,
      listenerConnected
    })
  }

  async function canvasStateForModel(args) {
    const projectArgs = withProjectDefaults(args)
    const result = await upstream.callTool(CANVAS_STATE_TOOL, { ...projectArgs, hydrateAssets: false })
    if (args.includeSnapshot === true) return result
    const summary = summarizeCanvas(structuredOrThrow(result, CANVAS_STATE_TOOL))
    return textResult(formatCanvasSummary(summary), summary)
  }

  async function insertVideo(args) {
    const videoPath = nonEmpty(args.videoPath)
    if (!videoPath) throw new Error('videoPath 必填。')
    const sourcePath = resolve(videoPath)
    try {
      if (!(await stat(sourcePath)).isFile()) throw new Error()
    } catch {
      throw new Error(`找不到视频文件：${sourcePath}`)
    }
    const probe = await probeVideoFile(sourcePath)
    if (!probe.mimeType) throw new Error(`不是可识别的视频文件（支持 mp4 / mov / webm）：${sourcePath}`)

    const { projectDir, canvasDir } = resolveCowartPaths(withProjectDefaults(args))
    return guard.withLock(writeLockKey(INSERT_VIDEO_TOOL, canvasDir), async () => {
      const state = structuredOrThrow(await upstream.callTool(CANVAS_STATE_TOOL, { projectDir, canvasDir }), CANVAS_STATE_TOOL)
      if (!state.snapshot) {
        throw new Error('这个项目还没有画布数据：先用 render_cowart_canvas_widget 打开画布，并在 Browser 面板里加载一次。')
      }
      const videoWidth = Number(args.videoWidth) || probe.width
      const videoHeight = Number(args.videoHeight) || probe.height
      const plan = planVideoPlacement({
        snapshot: state.snapshot,
        viewState: state.viewState,
        pageId: nonEmpty(args.pageId),
        anchorShapeId: nonEmpty(args.anchorShapeId),
        placement: args.placement,
        margin: Number.isFinite(args.margin) ? args.margin : 40,
        matchAnchor: args.matchAnchor,
        displayWidth: args.displayWidth,
        displayHeight: args.displayHeight,
        videoWidth,
        videoHeight
      })

      const assetsDir = join(canvasDir, 'pages', pageDirName(plan.pageId), 'assets')
      await mkdir(assetsDir, { recursive: true })
      const { fileName, filePath } = await uniqueFilePath(
        assetsDir,
        sanitizeFileName(nonEmpty(args.fileName) || basename(sourcePath), VIDEO_EXTENSIONS.get(probe.mimeType) ?? '.mp4')
      )
      await copyFile(sourcePath, filePath)

      const { asset, shape } = videoRecords({
        assetId: `asset:${randomId()}`,
        shapeId: `shape:${randomId()}`,
        plan,
        fileName,
        assetUrl: pageAssetUrl(plan.pageId, fileName),
        mimeType: probe.mimeType,
        fileSize: probe.fileSize,
        videoWidth,
        videoHeight,
        altText: nonEmpty(args.altText) ?? '',
        shapeMeta: {
          ...(args.shapeMeta && typeof args.shapeMeta === 'object' ? args.shapeMeta : {}),
          ...(nonEmpty(args.anchorShapeId) ? { cowartVideoSourceShapeId: args.anchorShapeId } : {})
        }
      })
      const snapshot = { ...state.snapshot, store: { ...state.snapshot.store, [asset.id]: asset, [shape.id]: shape } }
      const saved = structuredOrThrow(
        await callUpstreamWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot }),
        'save_cowart_canvas_state'
      )
      if (!saved.ok) throw new Error(saved.message || '保存画布失败。')
      const rejected = (saved.skippedRecords ?? []).filter((record) => record.id === asset.id || record.id === shape.id)
      if (rejected.length > 0) {
        throw new Error(`视频记录没通过 tldraw 校验：${rejected.map((record) => `${record.id} ${record.reason}`).join('；')}`)
      }
      guard.trackInsertedVideo(canvasDir, { shape, asset })

      return textResult(
        `已插入视频 ${shape.id}：${plan.w}×${plan.h}，位于 ${plan.pageId} 的 (${plan.x}, ${plan.y})；文件 ${filePath}`,
        { ok: true, shapeId: shape.id, assetId: asset.id, pageId: plan.pageId, bounds: { x: plan.x, y: plan.y, w: plan.w, h: plan.h }, filePath, mimeType: probe.mimeType }
      )
    })
  }

  function getRequest(args) {
    const request = queue.get(args.id)
    if (!request) throw new Error(`没有编号为 ${args.id} 的画布请求（本会话的请求只保存在内存里）。`)
    const notes = hostNotes(request)
    const text = [
      `画布请求 #${request.id}「${request.title}」 状态：${request.status}`,
      `项目：${request.projectDir}`,
      '',
      '—— 画布发来的原始请求 ——',
      request.text,
      '',
      '—— Claude Code 宿主说明 ——',
      ...notes.map((note) => `- ${note}`)
    ].join('\n')
    return textResult(text, { ...publicRequest(request), text: request.text, hostNotes: notes })
  }

  function replyRequest(args) {
    const request = queue.update(args.id, { status: args.status, message: args.message })
    return textResult(`已把画布请求 #${request.id} 标成 ${request.status}${request.message ? `：${request.message}` : ''}`, publicRequest(request))
  }

  function listRequests(args) {
    const requests = queue.list().filter((request) => args.includeFinished === true || !['done', 'failed', 'skipped'].includes(request.status))
    const text = requests.length
      ? requests.map((request) => `#${request.id} [${request.status}] ${request.title}${request.summary ? `：${request.summary}` : ''}`).join('\n')
      : '没有待处理的画布请求。'
    return textResult(text, { requests: requests.map(publicRequest) })
  }

  const server = new Server({ name: 'cowart', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const forwarded = (await upstream.listTools())
      .filter((tool) => !PAGE_ONLY_TOOLS.has(tool.name) && !DROPPED_TOOLS.has(tool.name) && !OVERRIDDEN_TOOLS.has(tool.name))
      .map(({ _meta: _ignored, ...tool }) => tool)
    const [render, canvasState, ...rest] = OWN_TOOLS
    return { tools: [render, canvasState, ...forwarded, ...rest] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const args = request.params.arguments ?? {}
    try {
      switch (name) {
        case RENDER_TOOL:
          return await renderCanvas(args)
        case CANVAS_STATE_TOOL:
          return await canvasStateForModel(args)
        case INSERT_VIDEO_TOOL:
          return await insertVideo(args)
        case GET_REQUEST_TOOL:
          return getRequest(args)
        case REPLY_REQUEST_TOOL:
          return replyRequest(args)
        case LIST_REQUESTS_TOOL:
          return listRequests(args)
        default:
          if (DROPPED_TOOLS.has(name)) return textResult('Claude Code 适配层不上报统计。')
          if (!(await upstreamToolNames()).has(name)) return errorResult(`未知工具：${name}`)
          return await callUpstreamLocked(name, withProjectDefaults(args))
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    await host?.close().catch(() => {})
    await upstream.close()
    process.exit(0)
  }

  server.onclose = shutdown
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.connect(new StdioServerTransport())
  upstream.listTools().catch((error) => log(`upstream Cowart server failed to start: ${error.message}`))
}
