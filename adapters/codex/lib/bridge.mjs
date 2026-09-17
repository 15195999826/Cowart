// Codex owns only the MCP Apps surface and its host instructions. All state, writes,
// page responsibility and generation run in the same service as Claude.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { inlineWidget } from '../../../mcp/lib/widget-resource.mjs'
import { OWN_TOOLS } from '../../claude/lib/bridge.mjs'
import { CanvasServiceClient } from '../../service/client.mjs'
import { DEFAULT_PORT, PROTOCOL, VERSION } from '../../service/lib/identity.mjs'
import { requestTask } from '../../service/lib/requests.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { DEFAULT_IMAGE_MODEL_ID, imageModelsForHost } from '../../shared/image-models.mjs'
import { DEFAULT_VIDEO_MODEL_ID, VIDEO_MODELS } from '../../shared/video-models.mjs'
import { injectIntoHead, jsonForInlineScript, readUpstreamWidgetHtml, scriptTag, sharedPageScripts } from '../../shared/widget-html.mjs'

export const WIDGET_URI = 'ui://widget/cowart/canvas.html'
export const APP_TOOL = 'cowart_canvas_app'
const textResult = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })
const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true })
export const INSTRUCTIONS = `Cowart 是 Codex 原生 MCP Apps 无限画布。每个任务只有一个薄 bridge，和 Claude Code 共用本机 ~/.cowart/canvas 的页面、素材和画布服务。用 render_cowart_canvas_widget 打开原生 widget，不打开 Browser 网页；已有画布时直接用读取/插入工具。page 指定页名并接管（不存在就建），shownPage 接管当前显示页；不传时打开原负责页或当前显示页，空闲页自动接管，已有其他负责者则只查看。每个会话最多负责一页，每页同时一位负责者；翻页只是查看。插入默认放进本会话负责页，结果必须回原请求的 pageId。第一次打开选一个简短人名 sessionName。
画布的 AI 图片/视频面板由服务直接生成，模型与参数来自用户面板选择。Codex imagegen 和 HTML/Slides/标注等请求先排队路由给该页负责者，再由其原生 widget 发送 ui/message。处理画布请求、HTML/Slides 或素材前先读取同插件 cowart skill。收到 Cowart 请求 #N 时先带 requestKey 调用 get_cowart_request，已完成/撤销/跳过的不再执行；否则 reply_cowart_request running，再完成并回 done/failed。消息送达并不改变系统授权要求。跨会话的请求只由负责会话处理；目标 Codex widget 没打开时留队列，可用 list_cowart_requests 补读。生成方式按请求指定；内置 imagegen 用 cowart-image-gen / cowart-image-edit，猛兽用 beast-gen。保留原图与标注，只将按标注改图结果放在原图旁边。不要直接读写共享画布 JSON 或整张覆盖保存；整理页面（编号、标题、分组、排版、删除）用 insert_cowart_text、insert_cowart_frame、update_cowart_shapes、delete_cowart_shapes；只删用户要删的（页面上 Ctrl+Z 撤不回）。用户说「反馈：…」「记个反馈」，或抱怨 Cowart 本身不好用（先问一句要不要记）时，用 send_cowart_feedback 记下来，交给 Cowart 仓库处理；只记录，不在当前项目里改 Cowart。`

// MCP-delivered media is materialized as blob/data URLs in the widget. Codex does
// not add default resource domains; declare these local schemes for media and drafts.
const RESOURCE_META = { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['blob:', 'data:'], frameDomains: ['blob:', 'data:'] } }, 'openai/widgetDescription': 'Cowart native canvas shared with Claude Code', 'openai/widgetCSP': { connect_domains: [], resource_domains: ['blob:', 'data:'], frame_domains: ['blob:', 'data:'] } }
const RENDER_META = { ui: { resourceUri: WIDGET_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': WIDGET_URI, 'openai/outputTemplate': WIDGET_URI, 'openai/widgetAccessible': true }

// 按标注修改 is written as an image edit, but its 标注 are often remarks on what the picture
// shows (a screenshot of the user's project, a design): Codex reads them before choosing.
const ANNOTATION_EDIT_NOTE = '按标注修改的标注不一定是改图要求，先读标注：是对图里界面、功能、设计的意见或问题（图多是项目截图、设计稿），就在对话里逐条回答、在当前项目里改，不生图、不往画布放图，完成回 done 并写一句；是改这张图本身的要求（换背景、改颜色这类）才按上面的请求出新图。拿不准先问用户。'

// get_cowart_request's text: the request, where its result goes, and how to read 按标注修改.
export function requestText(request) {
  const note = requestTask(request) === 'annotation-edit' ? `\n${ANNOTATION_EDIT_NOTE}` : ''
  return `Cowart 请求 #${request.id} [${request.status}]\n${request.text}\n结果放回 pageId=${request.pageId}。${note}`
}

export async function startCodexBridge() {
  const session = String(process.env.COWART_SESSION_ID || (process.env.CODEX_THREAD_ID ? `codex-${process.env.CODEX_THREAD_ID}` : `codex-${randomUUID()}`)).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96)
  const service = new CanvasServiceClient({ host: 'codex', session, cwd: process.cwd(), port: Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT })
  const server = new Server({ name: 'cowart_mcp', version: VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS })
  let opened = null
  let latestRenderId = null
  let expandedRenderId = null
  let claimShownPage = true
  let closing = false
  const shutdown = () => { if (closing) return; closing = true; service.close(); process.exit(0) }
  server.onclose = shutdown
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  const ready = service.start()
  ready.catch((error) => process.stderr.write(`[cowart-codex] ${error.message}\n`))

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await ready
    const own = OWN_TOOLS.map((tool) => {
      if (tool.name === 'render_cowart_canvas_widget') return { ...tool, description: 'Open the native Cowart MCP Apps widget, shared with Claude. page takes responsibility for a named page (create if missing); shownPage takes the displayed page; without page arguments, an unowned displayed page is claimed automatically; another session’s page stays theirs until explicitly claimed.', _meta: RENDER_META }
      if (tool.name === 'get_cowart_request') return { ...tool, inputSchema: { ...tool.inputSchema, required: [...tool.inputSchema.required, 'requestKey'], properties: { ...tool.inputSchema.properties, requestKey: { type: 'string', description: 'Copy the requestKey from the widget message to reject stale messages after service restart.' } } }, description: 'Read this session’s queued canvas request, including its original pageId and current status. Supply the requestKey from the widget message. Do not execute cancelled or finished requests.' }
      if (tool.name === 'reply_cowart_request') return { ...tool, inputSchema: { ...tool.inputSchema, required: [...tool.inputSchema.required, 'requestKey'], properties: { ...tool.inputSchema.properties, requestKey: { type: 'string', description: 'Use the requestKey returned by get_cowart_request.' } } } }
      return tool
    })
    return { tools: [...own, ...(await service.call('model-tools')).tools, {
      name: APP_TOOL, description: 'Private canvas transport: widget page tools, events and request delivery.',
      inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['call', 'poll', 'bootstrap'] }, pane: { type: 'string' }, renderId: { type: 'string' }, path: { type: 'string' }, body: { type: 'object' }, cursor: {} }, required: ['op', 'pane'] },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    }] }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: WIDGET_URI, name: 'cowart-canvas-widget', title: 'Cowart Canvas', mimeType: 'text/html;profile=mcp-app', _meta: RESOURCE_META }] }))
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== WIDGET_URI) throw new Error('Unknown Cowart resource')
    await ready
    // A native host can cache this URI across tasks and MCP process restarts.
    // Only immutable host configuration belongs in the resource document.
    const config = { host: 'codex', hostLabel: 'Codex', protocol: PROTOCOL, version: VERSION }
    const [raw, transport, cache, runtime, shared] = await Promise.all([
      readUpstreamWidgetHtml(), readFile(join(ADAPTERS_DIR, 'codex', 'web', 'transport.js'), 'utf8'),
      readFile(join(ADAPTERS_DIR, 'codex', 'web', 'asset-cache.js'), 'utf8'),
      readFile(join(ADAPTERS_DIR, 'shared', 'web', 'service-bridge.js'), 'utf8'),
      sharedPageScripts({ host: 'codex', imageModels: imageModelsForHost('codex'), defaultImageModelId: DEFAULT_IMAGE_MODEL_ID, videoModels: VIDEO_MODELS, defaultVideoModelId: DEFAULT_VIDEO_MODEL_ID })
    ])
    // Expansion belongs to a new model render, not every historical widget mount.
    const html = injectIntoHead(inlineWidget({ html: raw, appVersion: VERSION }), [
      scriptTag(`window.__COWART_SERVICE_PAGE__=${jsonForInlineScript(config)};`, 'cowartServiceConfig'),
      scriptTag(cache, 'cowartCodexAssetCache'),
      scriptTag(transport, 'cowartCodexTransport'), scriptTag(runtime, 'cowartServiceBridge'), shared
    ].join('\n'))
    return { contents: [{ uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: html, _meta: RESOURCE_META }] }
  })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments || {}
    try {
      await ready
      switch (params.name) {
        case 'render_cowart_canvas_widget': {
          opened = await service.call('open-canvas', args)
          claimShownPage = !args.page && !args.shownPage
          latestRenderId = randomUUID()
          const payload = { ...opened, renderId: latestRenderId, version: 1, widget: 'cowart-canvas-widget', rendering: 'native-widget', preferredDisplayMode: 'fullscreen' }
          return { ...textResult(`已请求打开 Cowart 原生画布，界面正在连接和加载。${opened.sessionName}${opened.myPage ? `负责「${opened.myPage}」` : '尚未负责任何页'}。此返回值不代表画布已经显示完成。`, payload), _meta: { 'openai/outputTemplate': WIDGET_URI, widgetData: payload } }
        }
        case APP_TOOL: {
          if (args.op === 'bootstrap') {
            const context = { ...await service.call('open-canvas'), claimShownPage, host: 'codex', hostLabel: 'Codex', protocol: PROTOCOL, version: VERSION }
            const autoExpand = Boolean(args.renderId && args.renderId === latestRenderId && expandedRenderId !== latestRenderId)
            if (autoExpand) expandedRenderId = latestRenderId
            return textResult('Cowart widget lifecycle', { autoExpand, context })
          }
          if (!['call', 'poll'].includes(args.op)) throw new Error('Unknown widget operation')
          return textResult('Cowart app response', await service.call(args.op === 'poll' ? 'widget-poll' : 'widget-call', args))
        }
        case 'get_cowart_canvas_state': return await service.call('canvas-state', args)
        case 'insert_cowart_video': return await service.call('insert-video', args)
        case 'get_cowart_request': {
          if (!args.requestKey) throw new Error('请传入消息或请求列表里的 requestKey，避免处理旧服务的请求。')
          const { request } = await service.call('request-get', args)
          return textResult(requestText(request), request)
        }
        case 'reply_cowart_request': {
          if (!args.requestKey) throw new Error('请传入 get_cowart_request 返回的 requestKey。')
          return textResult('已更新画布请求。', await service.call('request-reply', args))
        }
        case 'list_cowart_requests': return textResult('本会话的画布请求。', await service.call('request-list', args))
        default: return await service.call('tool', { name: params.name, arguments: args })
      }
    } catch (error) { return errorResult(error.message) }
  })
  await server.connect(new StdioServerTransport())
}
