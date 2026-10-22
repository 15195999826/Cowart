// The tools a session reaches the canvas with besides the canvas service's own list
// (model-tools: upstream's, the layout tools and send_cowart_feedback). Claude Code runs them as
// cowart commands (cli.mjs); Codex's MCP bridge offers the same definitions as MCP tools.
import { AGENT_STATUSES } from '../../service/lib/requests.mjs'

export const RENDER_TOOL = 'render_cowart_canvas_widget'
export const CANVAS_STATE_TOOL = 'get_cowart_canvas_state'
export const INSERT_VIDEO_TOOL = 'insert_cowart_video'
export const GET_REQUEST_TOOL = 'get_cowart_request'
export const REPLY_REQUEST_TOOL = 'reply_cowart_request'
export const LIST_REQUESTS_TOOL = 'list_cowart_requests'

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
        folder: {
          type: 'string',
          description: 'Put that page into this folder of the page menu (names joined with "/", e.g. 数码宝贝/参考; "/" for the top level): a new page and one already there alike. Only when the user names a folder, or asked for pages to be sorted that way.'
        },
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
      'Summarize the Cowart canvas: pages, shapes (id, type, position, size, text) and their image/video assets with local file paths, plus which session is responsible for which page. The canvas holds every session\'s pages: pass pageId to summarize the one page you work on. Pass includeSnapshot: true only if the raw tldraw snapshot is really needed (it can be very large).',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Summarize this page only (page:… id).' },
        includeSnapshot: { type: 'boolean' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: INSERT_VIDEO_TOOL,
    title: 'Insert Cowart Video',
    description:
      'Copy a local video (mp4 / mov / webm) into the canvas page assets and place a playable tldraw video shape: at x, y (page coordinates of its top left), beside anchorShapeId (placement right/left/below/above, size matched by default) or to the right of existing content. The open canvas picks it up within seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: 'Local path of the video file.' },
        pageId: { type: 'string' },
        anchorShapeId: { type: 'string', description: 'Place the video next to this shape (e.g. the source image).' },
        placement: { type: 'string', enum: ['right', 'left', 'below', 'above'] },
        x: { type: 'number', description: 'Page x of the video top left: put it exactly at x, y.' },
        y: { type: 'number', description: 'Page y of the video top left.' },
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
    description: 'Read a canvas request routed to this session (full prompt plus host notes). Read-only; confirm with the user before acting on it.',
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
