// Canvas operations of the service. One upstream Cowart server (child process) serves every
// canvas, with writes serialized per canvas; on top of it come the page-only tools the shared
// panels use, the tools adapters add (canvas summary, videos), delta saves for canvases
// several pages show at once, pages created for sessions, and each session's own selection.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { generateKeyBetween } from 'fractional-indexing'

import { pageAssetUrl, pageDirName, resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { fitImageToAsset, formatCanvasSummary, localPathForAssetSrc, pageBounds, pageIdOfShape, pageRecords, placeBeside, shapesOnPage, summarizeCanvas } from '../../shared/canvas-model.mjs'
import { sanitizeFileName, uniqueFilePath } from '../../shared/files.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { PREPARE_REQUEST_TOOL, prepareGenerationRequest } from '../../shared/generation-requests.mjs'
import { structuredOrThrow } from '../../shared/upstream.mjs'
import { planVideoInHolder, planVideoPlacement, probeVideoFile, videoRecords } from '../../shared/video.mjs'
import { CAPTURE_WEB_TOOL, captureWebReference } from '../../shared/web-capture.mjs'
import { DELETE_TOOL, EDIT_TOOLS, UPDATE_TOOL, planCanvasEdit, referencedShapeIds } from './canvas-edit.mjs'
import { applyDelta, changedPages, pageOfRecord, readDelta, stableStringify } from './delta-merge.mjs'
import { COPY_REFERENCE_TOOL, copyCanvasReference } from './copy-reference.mjs'
import { REVEAL_FILE_TOOL, revealCanvasFile } from './reveal-file.mjs'
import { describeMoves, folderOf, normalizeFolder, planPageMoves, withFolder } from './page-folders.mjs'

// A canvas nobody has opened yet gets its first page from this (the schema of the bundled
// tldraw and a document record); the page fills in the rest when it loads.
const EMPTY_CANVAS_TEMPLATE = join(ADAPTERS_DIR, 'shared', 'empty-canvas.json')

export const RENDER_TOOL = 'render_cowart_canvas_widget'
export const CANVAS_STATE_TOOL = 'get_cowart_canvas_state'
export const INSERT_VIDEO_TOOL = 'insert_cowart_video'

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
// Bridges offer their own version of these.
const OVERRIDDEN_TOOLS = new Set([RENDER_TOOL, CANVAS_STATE_TOOL])
// Model tools that write into a page: only the session editing that page may use them.
export const PAGE_WRITE_TOOLS = new Set(['insert_cowart_image', 'insert_cowart_html_draft', 'save_cowart_reference_image', INSERT_VIDEO_TOOL, ...EDIT_TOOLS])
// Upstream tools that add shapes for the model; their additions are protected like videos.
const MODEL_INSERT_TOOLS = new Set(['insert_cowart_image', 'insert_cowart_html_draft'])
// Placement the service adds to those: x, y (exactly there) and above an anchor.
const PLACEMENT_INPUTS = {
  x: { type: 'number', description: 'Page x of the top left: put it exactly at x, y (not used when it replaces or fills a holder).' },
  y: { type: 'number', description: 'Page y of the top left.' }
}
const PLACEMENT_NOTE = ' x, y put it exactly there; placement "above" puts it above the anchor.'
// insert_cowart_image only: an ordinary card to replace (#replaceCard).
const REPLACE_INPUT = {
  replaceShapeId: {
    type: 'string',
    description: 'A card on the page to replace (an image, video or HTML card, also inside a group frame): the new image takes its place, centered in its box at the bitmap\'s ratio and in its frame, and the card is deleted (its file stays in the page assets). An AI 图片 holder given here is replaced the way anchorShapeId with replaceAiImageHolder does.'
  }
}
// Model tools that read the canvas selection (to report it, or as the anchor of an insert).
const SELECTION_READERS = new Set(['get_cowart_selection', 'insert_cowart_image', 'insert_cowart_html_draft', 'save_cowart_reference_image'])
// Shape arguments that say where a write lands, in the order upstream reads them.
const ANCHOR_ARGS = ['replaceHolderShapeId', 'holderShapeId', 'draftShapeId', 'anchorShapeId', 'sourceShapeId']

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
// Upstream tools that leave the stored canvas (its pages, shapes, bindings and assets) as it
// was. Every other call counts as a change of it (see canvasVersion).
const CANVAS_NEUTRAL_TOOLS = new Set([
  CANVAS_STATE_TOOL,
  'get_cowart_selection',
  'save_cowart_selection_state',
  'save_cowart_view_state',
  'read_cowart_page_asset',
  'download_cowart_file',
  'copy_cowart_image_to_clipboard',
  'track_cowart_analytics_event'
])

const VIDEO_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm']
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// The model's tools all work on the machine's one canvas: no project or canvas to pass.
const CANVAS_INPUTS = new Set(['projectDir', 'canvasDir'])

function withoutCanvasInputs(tool) {
  const schema = tool.inputSchema
  if (!schema?.properties) return tool
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !CANVAS_INPUTS.has(key)))
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => !CANVAS_INPUTS.has(key)) : undefined
  return { ...tool, inputSchema: { ...schema, properties, ...(required ? { required } : {}) } }
}

// Upstream's inserts with the service's placement inputs (callForModel places the result).
function withPlacementInputs(tool) {
  const properties = { ...tool.inputSchema.properties, ...PLACEMENT_INPUTS, ...(tool.name === 'insert_cowart_image' ? REPLACE_INPUT : {}) }
  const placement = properties.placement
  if (Array.isArray(placement?.enum) && !placement.enum.includes('above')) properties.placement = { ...placement, enum: [...placement.enum, 'above'] }
  return { ...tool, description: `${tool.description ?? ''}${PLACEMENT_NOTE}`, inputSchema: { ...tool.inputSchema, properties } }
}

function finiteOrNull(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

// A group frame (insert_cowart_frame, tldraw's frame tool), not an AI holder or Slides. An insert
// beside a card takes the card's size by default (matchAnchor, for 按标注修改); beside a group
// it would blow a small image up to the size of the whole group (2026-10-22), so it keeps its own.
function isGroupFrame(shape) {
  const meta = shape?.meta ?? {}
  return shape?.typeName === 'shape' && shape.type === 'frame' && !meta.cowartAiImageHolder && !meta.cowartAiDraftHolder && !meta.cowartAiVideoHolder && !meta.cowartAiSlides
}

export function textResult(text, structuredContent) {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent }
}

export function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function randomId() {
  return randomUUID().replaceAll('-', '').slice(0, 21)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

function writeLockKey(name, canvasDir) {
  if (CANVAS_WRITE_TOOLS.has(name) || name === INSERT_VIDEO_TOOL) return `${canvasDir}::canvas`
  const group = STATE_WRITE_TOOLS.get(name)
  return group ? `${canvasDir}::${group}` : null
}

// Emits 'pages-deleted' ({ canvasDir, pageIds }) when a save deleted pages, so every page
// showing the canvas can drop them too (tldraw's remote sync never removes pages) and
// nobody stays responsible for them.
export class CanvasOps extends EventEmitter {
  #upstream
  #guard
  #log
  // `${canvasDir}\n${session}` → the selection that session's page saved last
  #selections = new Map()
  // canvasDir → how many writes of the stored canvas this service started; with #epoch (this
  // service instance) it names a state of the canvas (canvasVersion).
  #writes = new Map()
  #epoch = randomId().slice(0, 8)
  // canvasDir → { version, snapshot } the pages were given last
  #served = new Map()

  constructor({ upstream, guard, log }) {
    super()
    this.#upstream = upstream
    this.#guard = guard
    this.#log = log ?? (() => {})
  }

  // Changes after every write of the stored canvas through this service, the only writer of it
  // (canvas-lock.mjs). A page that has the canvas of this version has it as stored.
  canvasVersion(canvasDir) {
    return `${this.#epoch}.${this.#writes.get(canvasDir) ?? 0}`
  }

  #noteWrite(args) {
    let canvasDir
    try {
      canvasDir = resolveCowartPaths(args).canvasDir
    } catch {
      return
    }
    this.#writes.set(canvasDir, (this.#writes.get(canvasDir) ?? 0) + 1)
  }

  async #upstreamToolNames() {
    return new Set((await this.#upstream.listTools()).map((tool) => tool.name))
  }

  // Upstream tools the model sees through a bridge, next to the bridge's own tools.
  async modelTools() {
    return (await this.#upstream.listTools())
      .filter((tool) => !PAGE_ONLY_TOOLS.has(tool.name) && !DROPPED_TOOLS.has(tool.name) && !OVERRIDDEN_TOOLS.has(tool.name))
      .map(({ _meta: _ignored, ...tool }) => withoutCanvasInputs(tool))
      .map((tool) => (MODEL_INSERT_TOOLS.has(tool.name) && tool.inputSchema?.properties ? withPlacementInputs(tool) : tool))
  }

  async #callWithRetry(name, args) {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const result = await this.#upstream.callTool(name, args)
        const message = result?.isError ? result.content?.find((item) => item.type === 'text')?.text ?? '' : ''
        if (!TRANSIENT_FS_ERROR.test(message) || attempt >= WRITE_RETRIES) return result
        await delay(80 * (attempt + 1))
      }
    } finally {
      // Once it is over (a failed write may have written part of it): a page reading from now
      // on gets the new version with what it reads.
      if (!CANVAS_NEUTRAL_TOOLS.has(name)) this.#noteWrite(args)
    }
  }

  // Forwards a tool call, serializing writes that touch the same canvas files.
  async #callLocked(name, args) {
    const { canvasDir } = resolveCowartPaths(args)
    const key = writeLockKey(name, canvasDir)
    const run = () => this.#callWithRetry(name, args)
    return key ? this.#guard.withLock(key, run) : run()
  }

  async #storedSnapshot(args) {
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    const state = structuredOrThrow(await this.#upstream.callTool(CANVAS_STATE_TOOL, { projectDir, canvasDir, hydrateAssets: false }), CANVAS_STATE_TOOL)
    return state.snapshot ?? null
  }

  // The canvas's pages in their tldraw order: [{ id, name, folder }] (folder "" at the top level).
  async canvasPages(args) {
    return pageRecords(await this.#storedSnapshot(args)).map((page) => ({ id: page.id, name: page.name, folder: folderOf(page) }))
  }

  // A record of the stored canvas (null when it is not there).
  async shapeRecord(args, id) {
    return (await this.#storedSnapshot(args))?.store?.[id] ?? null
  }

  // The page of that name, created after the last page when the canvas has none (a canvas
  // nobody opened yet starts from the empty template). Open pages pick it up on their next
  // sync. With folder (page-folders.mjs), the page goes into that folder, a page already there
  // as well. Returns { id, name, folder, created, movedFrom }.
  async ensurePage(args, name, { folder } = {}) {
    const wanted = nonEmpty(name)
    if (!wanted) throw new Error('页名不能为空。')
    const wantedFolder = folder === undefined || folder === null ? null : normalizeFolder(folder)
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey('save_cowart_canvas_state', canvasDir), async () => {
      const stored = await this.#storedSnapshot({ projectDir, canvasDir })
      const snapshot = stored?.store ? stored : JSON.parse(await readFile(EMPTY_CANVAS_TEMPLATE, 'utf8'))
      const pages = pageRecords(snapshot)
      const existing = pages.find((page) => page.name === wanted)
      const save = async (store, what) => {
        const saved = structuredOrThrow(
          await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store } }),
          'save_cowart_canvas_state'
        )
        if (!saved.ok) throw new Error(saved.message || what)
        return saved
      }
      if (existing) {
        const was = folderOf(existing)
        if (wantedFolder === null || wantedFolder === was) return { id: existing.id, name: existing.name, folder: was, created: false, movedFrom: null }
        await save({ ...snapshot.store, [existing.id]: withFolder(existing, wantedFolder) }, `没能把「${wanted}」放进文件夹「${wantedFolder}」。`)
        return { id: existing.id, name: existing.name, folder: wantedFolder, created: false, movedFrom: was }
      }
      const page = withFolder(
        {
          id: `page:${randomId()}`,
          typeName: 'page',
          name: wanted,
          index: generateKeyBetween(pages.at(-1)?.index ?? null, null),
          meta: {}
        },
        wantedFolder ?? ''
      )
      // A fresh canvas keeps only the page asked for, not the template's «Page 1».
      const store = stored?.store
        ? { ...snapshot.store }
        : Object.fromEntries(Object.entries(snapshot.store).filter(([, record]) => record?.typeName !== 'page'))
      store[page.id] = page
      const saved = await save(store, `建不了「${wanted}」这一页。`)
      if ((saved.skippedRecords ?? []).some((record) => record.id === page.id)) throw new Error(`「${wanted}」这一页没通过 tldraw 校验。`)
      this.#guard.trackInsertedRecords(canvasDir, [page])
      this.#pagesChanged(canvasDir, [page.id])
      return { id: page.id, name: wanted, folder: wantedFolder ?? '', created: true, movedFrom: null }
    })
  }

  // Pages a write changed, for the page menu's 最近改过 order (page-activity.mjs).
  #pagesChanged(canvasDir, pageIds) {
    const ids = [...new Set(pageIds.filter(Boolean))]
    if (ids.length > 0) this.emit('pages-changed', { canvasDir, pageIds: ids })
  }

  // move_cowart_pages: pages into a folder, or a folder with what is in it to another path
  // (page-folders.mjs). Only the page records change; open pages pick them up on their next sync.
  async movePages(args) {
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey('save_cowart_canvas_state', canvasDir), async () => {
      const snapshot = await this.#storedSnapshot({ projectDir, canvasDir })
      if (!snapshot?.store) throw new Error('画布上还没有页。')
      const plan = planPageMoves(pageRecords(snapshot), args)
      if (plan.changed.length > 0) {
        const store = { ...snapshot.store, ...Object.fromEntries(plan.changed.map((page) => [page.id, page])) }
        const saved = structuredOrThrow(
          await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store } }),
          'save_cowart_canvas_state'
        )
        if (!saved.ok) throw new Error(saved.message || '没能挪这些页。')
      }
      const { changed: _records, ...result } = plan
      return textResult(describeMoves(plan), result)
    })
  }

  // The page a model write lands on when the call names it or a shape on it; null otherwise.
  async targetPage(args, name) {
    if (EDIT_TOOLS.has(name)) return this.#editTargetPage(args, name)
    if (nonEmpty(args.pageId)) return args.pageId.trim()
    const shapeId = ['replaceShapeId', ...ANCHOR_ARGS].map((key) => nonEmpty(args[key])).find(Boolean)
    if (!shapeId) return null
    const snapshot = await this.#storedSnapshot(args)
    const shape = snapshot?.store?.[shapeId]
    return shape ? pageIdOfShape(snapshot.store, shape) : null
  }

  // A layout call works on one page: the one it names, or the one its shapes are on.
  async #editTargetPage(args, name) {
    const named = nonEmpty(args.pageId)
    const ids = referencedShapeIds(name, args)
    if (ids.length === 0) return named
    const store = (await this.#storedSnapshot(args))?.store ?? {}
    const pages = new Set(ids.map((id) => (store[id]?.typeName === 'shape' ? pageIdOfShape(store, store[id]) : null)).filter(Boolean))
    if (pages.size > 1) throw new Error(`${name}：这些图形分在 ${pages.size} 页上（${[...pages].join('、')}），一次调用只改一页。`)
    const [shapesPage = null] = pages
    if (named && shapesPage && named !== shapesPage) throw new Error(`${name}：pageId 是 ${named}，图形却在 ${shapesPage} 上。`)
    return named ?? shapesPage
  }

  // Every page of every session saves into one selection file per canvas; before a model tool
  // reads it, the file gets this session's last selection back. anchor: false (Claude's put
  // commands, which name their anchor with --next-to) keeps the selection from anchoring an
  // insert; so do x, y and replaceShapeId: on 2026-10-22 a 96 px image put at x, y came out
  // 512 x 512, the size of what the user had selected.
  async replaySelection(name, args, session, { anchor = true } = {}) {
    if (!SELECTION_READERS.has(name) || !session) return
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    let selection = this.#selections.get(`${canvasDir}\n${session}`)
    if (MODEL_INSERT_TOOLS.has(name) && !ANCHOR_ARGS.some((key) => nonEmpty(args[key]))) {
      const placed = finiteOrNull(args.x) !== null || finiteOrNull(args.y) !== null || nonEmpty(args.replaceShapeId)
      selection = anchor && !placed ? await this.#anchorSelection(selection, args) : { selectedShapes: [] }
    }
    if (selection === undefined) return
    await this.#callLocked('save_cowart_selection_state', { projectDir, canvasDir, selection })
  }

  // An insert that names no anchor gets the one selected shape as its anchor (upstream), and
  // lands on that shape's page whatever pageId says: on 2026-10-22 an image for page A went to
  // the page the session's pane showed. So it only gets this session's own selection, and only
  // a shape on the page the insert is for; otherwise none.
  async #anchorSelection(selection, args) {
    const none = { selectedShapes: [] }
    const shapes = selection?.selectedShapes
    if (!Array.isArray(shapes)) return none
    if (shapes.length !== 1 || !nonEmpty(args.pageId)) return selection
    const store = (await this.#storedSnapshot(args))?.store ?? {}
    const shape = store[shapes[0]?.id]
    return shape?.typeName === 'shape' && pageIdOfShape(store, shape) === args.pageId.trim() ? selection : none
  }

  // A session the canvas service forgot (server.mjs #forgetEnded): its selection goes with it.
  forgetSession(session) {
    for (const key of this.#selections.keys()) if (key.endsWith(`\n${session}`)) this.#selections.delete(key)
  }

  // Tool calls from a canvas page (the upstream widget and the shared panels). pane is the
  // page's { session } when it identified itself.
  async callFromPage(name, args, { host, pane } = {}) {
    if (DROPPED_TOOLS.has(name)) {
      return { content: [], structuredContent: { configured: false, delivered: false, skippedBy: 'cowart-canvas-service' } }
    }
    if (name === PREPARE_REQUEST_TOOL) {
      try {
        const prepared = await prepareGenerationRequest({ upstream: this.#upstream, host, args })
        return textResult('已生成画布请求。', prepared)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }
    if (name === CAPTURE_WEB_TOOL) {
      try {
        const captured = await captureWebReference({ args })
        return textResult(`已截下 ${captured.url}（${captured.width}×${captured.height}）。`, captured)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }
    if (name === COPY_REFERENCE_TOOL) {
      try {
        const { projectDir, canvasDir } = resolveCowartPaths(args)
        const copied = await copyCanvasReference({ snapshot: await this.#storedSnapshot({ projectDir, canvasDir }), canvasDir, shapeIds: args.shapeIds })
        return textResult('已拷贝画布索引。', copied)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }
    if (name === REVEAL_FILE_TOOL) {
      try {
        const revealed = await revealCanvasFile({ canvasDir: resolveCowartPaths(args).canvasDir, assetUrl: args.assetUrl })
        return textResult(`已在文件管理器里显示 ${revealed.filePath}。`, revealed)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }
    if (name === RENDER_TOOL || !(await this.#upstreamToolNames()).has(name)) return errorResult(`画布页面不能调用 ${name}。`)

    if (name === 'save_cowart_canvas_state') return this.#savePage(args)
    if (name === CANVAS_STATE_TOOL) return this.#pageCanvasState(args)
    if (name === 'save_cowart_selection_state' && pane?.session) {
      this.#selections.set(`${resolveCowartPaths(args).canvasDir}\n${pane.session}`, args.selection)
    }
    return this.#callLocked(name, args)
  }

  // Every open page reads the whole stored canvas each 1.6 s (upstream's remote sync). The
  // canvas comes with its version (cowartVersion); a page that says it has that one
  // (cowartSince) hears it is unchanged instead of getting all of it again.
  async #pageCanvasState({ cowartSince, ...args }) {
    const { canvasDir } = resolveCowartPaths(args)
    const version = this.canvasVersion(canvasDir)
    const served = this.#served.get(canvasDir)
    if (cowartSince === version && served?.version === version) {
      this.#guard.observePageFetch(canvasDir, served.snapshot)
      return textResult('画布没有变化。', { unchanged: true, cowartVersion: version })
    }
    const result = await this.#callLocked(CANVAS_STATE_TOOL, args)
    const snapshot = result?.structuredContent?.snapshot
    if (result?.isError || !snapshot) return result
    // Of the version taken before the read: a write finishing meanwhile makes the next poll read again.
    this.#served.set(canvasDir, { version, snapshot })
    this.#guard.observePageFetch(canvasDir, snapshot)
    return { ...result, structuredContent: { ...result.structuredContent, cowartVersion: version } }
  }

  // A page that sends a delta (what changed in it since the stored canvas last agreed with
  // it) gets it laid over the stored canvas (delta-merge.mjs); a page without one (an older
  // page), or one whose tldraw schema differs from the stored one (its records were all
  // migrated in memory), saves the whole canvas as upstream does.
  async #savePage(args) {
    const { cowartDelta, ...saveArgs } = args
    const delta = readDelta(cowartDelta)
    const { projectDir, canvasDir } = resolveCowartPaths(saveArgs)
    return this.#guard.withLock(writeLockKey('save_cowart_canvas_state', canvasDir), async () => {
      let snapshot = saveArgs.snapshot
      let deletedPages = []
      let merged = false
      let touched = []
      if (delta && snapshot?.store) {
        const disk = await this.#storedSnapshot({ projectDir, canvasDir })
        if (disk?.store && stableStringify(disk.schema) === stableStringify(snapshot.schema)) {
          const applied = applyDelta({ disk, incoming: snapshot, delta })
          snapshot = applied.snapshot
          deletedPages = applied.deletedPages
          touched = changedPages({ disk, merged: applied.snapshot, delta })
          merged = true
        }
      }
      const guarded = this.#guard.protectPageSave(canvasDir, snapshot, { restoreInserted: !merged })
      if (guarded.restored.length > 0 || guarded.dropped.length > 0) {
        this.#log(`stale page save: kept ${guarded.restored.length} inserted record(s), dropped ${guarded.dropped.length} replaced holder(s)`)
      }
      const result = await this.#callWithRetry('save_cowart_canvas_state', { ...saveArgs, projectDir, canvasDir, snapshot: guarded.snapshot })
      if (!result?.isError && result?.structuredContent?.ok !== false) {
        if (deletedPages.length > 0) this.emit('pages-deleted', { canvasDir, pageIds: deletedPages })
        this.#pagesChanged(canvasDir, touched)
      }
      return result
    })
  }

  // Upstream tools the model calls through a bridge (insert_cowart_image, get_cowart_selection …).
  async callForModel(name, args) {
    if (DROPPED_TOOLS.has(name)) return textResult('画布服务不上报统计。')
    if (!(await this.#upstreamToolNames()).has(name)) return errorResult(`未知工具：${name}`)
    if (!MODEL_INSERT_TOOLS.has(name)) return this.#callLocked(name, args)
    if (name === 'insert_cowart_image' && nonEmpty(args.replaceShapeId)) return this.#replaceCard(args)
    // Upstream sizes the insert and puts it beside an anchor (right, left, below) or in free
    // space; the service then puts it at x, y or beside the anchor on any side (above too),
    // past what is in the way (#placeInserted).
    const { x, y, placement, replaceShapeId: _replace, ...rest } = args
    const side = ['left', 'below', 'above'].includes(placement) ? placement : 'right'
    const place = { x: finiteOrNull(x), y: finiteOrNull(y), side, asked: finiteOrNull(x) !== null || finiteOrNull(y) !== null || side === 'above' }
    const upstreamArgs = placement === undefined ? rest : { ...rest, placement: side === 'above' ? 'below' : placement }
    // An HTML draft is named after its file (upstream names it draft-<time>), when that name
    // has something upstream keeps (it drops what is not ASCII).
    const htmlName = name === 'insert_cowart_html_draft' && !nonEmpty(rest.fileName) && nonEmpty(rest.htmlPath) ? basename(rest.htmlPath.trim()) : null
    if (htmlName && /[A-Za-z0-9]/.test(htmlName.replace(/\.[^.]+$/, ''))) upstreamArgs.fileName = htmlName
    // What the insert added (and the holder it replaced) survives a stale page save.
    const { canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey(name, canvasDir), async () => {
      const before = (await this.#storedSnapshot(args))?.store ?? {}
      let result = await this.#callWithRetry(name, upstreamArgs.matchAnchor === undefined && isGroupFrame(before[nonEmpty(upstreamArgs.anchorShapeId)]) ? { ...upstreamArgs, matchAnchor: false } : upstreamArgs)
      if (result?.isError) return result
      if (name === 'insert_cowart_image') result = await this.#fitInsertedImage(upstreamArgs, result)
      result = await this.#placeInserted(upstreamArgs, result, place)
      const after = (await this.#storedSnapshot(args))?.store ?? {}
      const inserted = Object.values(after).filter((record) => !before[record.id])
      this.#guard.trackInsertedRecords(canvasDir, inserted)
      const removed = []
      for (const [id, record] of Object.entries(before)) {
        if (record?.typeName === 'shape' && !after[id]) {
          this.#guard.trackRemovedShape(canvasDir, id)
          removed.push(record)
        }
      }
      this.#pagesChanged(canvasDir, [...inserted.map((record) => pageOfRecord(after, record)), ...removed.map((record) => pageOfRecord(before, record))])
      return result
    })
  }

  // Upstream sizes an inserted image to its box (the AI 图片 holder it replaces, the anchor it
  // matches as 按标注修改 does, or displayWidth x displayHeight) whatever the bitmap's ratio,
  // and a generated image is rarely exactly the holder's ratio: it would land stretched. The
  // image is fitted back to its bitmap's ratio inside that box, centered in a holder (upstream
  // marks what it put into one) and from the box's top left elsewhere. Its asset also gets the
  // name of the file it came from back: upstream keeps only ASCII in file names, so 猫-水彩.png
  // was image.png on the canvas and in every summary (2026-10-22); the file keeps upstream's
  // name. Best effort: when this fails, the insert stands as upstream made it.
  async #fitInsertedImage(args, result) {
    const inserted = result?.structuredContent
    if (!inserted?.shapeId || inserted.dryRun) return result
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    try {
      const snapshot = await this.#storedSnapshot({ projectDir, canvasDir })
      const shape = snapshot?.store?.[inserted.shapeId]
      const asset = snapshot?.store?.[shape?.props?.assetId]
      const center = Boolean(shape?.meta?.cowartGeneratedForAiImageHolder)
      const fitted = fitImageToAsset(shape, asset, { center })
      const original = basename(nonEmpty(args.fileName) ?? nonEmpty(args.imagePath) ?? '')
      const renamed = asset && original && asset.props?.name !== original ? { ...asset, props: { ...asset.props, name: original } } : null
      if (!fitted && !renamed) return result
      const changed = [fitted, renamed].filter(Boolean)
      const saved = structuredOrThrow(
        await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store: { ...snapshot.store, ...Object.fromEntries(changed.map((record) => [record.id, record])) } } }),
        'save_cowart_canvas_state'
      )
      if (!saved.ok) throw new Error(saved.message || '保存画布失败。')
      if ((saved.skippedRecords ?? []).some((record) => changed.some((entry) => entry.id === record.id))) throw new Error('没通过 tldraw 校验。')
      if (!fitted) return result
      const bounds = { x: fitted.x, y: fitted.y, w: fitted.props.w, h: fitted.props.h }
      const size = (w, h) => `${round2(w)}×${round2(h)}`
      const lines = [
        `Inserted ${fitted.id} on ${inserted.pageId} at (${round2(bounds.x)}, ${round2(bounds.y)}) using ${inserted.index}.`,
        `图片按原图比例（${size(asset.props.w, asset.props.h)}）等比放进 ${size(shape.props.w, shape.props.h)} 的${center ? ' AI 图片框并居中' : '范围，左上对齐'}：${size(bounds.w, bounds.h)}。`
      ]
      return { ...result, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...inserted, bounds } }
    } catch (error) {
      this.#log(`kept upstream's size and name for ${inserted.shapeId}: ${error instanceof Error ? error.message : error}`)
      return result
    }
  }

  // An image in place of an ordinary card (insert_cowart_image's replaceShapeId; an AI 图片
  // holder goes to upstream, which replaces those): it takes the card's place — its frame,
  // centered in its box at the bitmap's ratio — and the card is deleted with what is bound to
  // it (its 标注 / 注释); the card's file stays in the page assets. 2026-10-22: --replace on a
  // plain image put the new one at the end of the row and left the old one.
  async #replaceCard(args) {
    const { replaceShapeId, x: _x, y: _y, placement: _placement, anchorShapeId: _anchor, sourceShapeId: _source, replaceAiImageHolder: _holder, ...rest } = args
    const id = replaceShapeId.trim()
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    const store = (await this.#storedSnapshot(args))?.store ?? {}
    const card = store[id]
    if (card?.typeName !== 'shape') return errorResult(`replaceShapeId：画布上没有图形 ${id}（id 以 get_cowart_canvas_state 列出的为准）。`)
    if (card.meta?.cowartAiImageHolder) return this.callForModel('insert_cowart_image', { ...rest, anchorShapeId: id, replaceAiImageHolder: true })
    if (card.type === 'frame') return errorResult(`replaceShapeId：${id} 是框，不是卡片：要换掉框里的哪一张，就给那一张的 id。`)
    const pageId = pageIdOfShape(store, card)
    const box = pageBounds(store, card)
    // Upstream puts it on that page at the card's size (stretched), the fit gives it its ratio
    // back; then it moves in and the card goes.
    const inserted = await this.callForModel('insert_cowart_image', { ...rest, pageId, displayWidth: box.w, displayHeight: box.h, matchAnchor: false })
    if (inserted?.isError || !inserted?.structuredContent?.shapeId) return inserted
    const made = inserted.structuredContent
    const at = { x: round2(box.x + (box.w - made.bounds.w) / 2), y: round2(box.y + (box.h - made.bounds.h) / 2) }
    const frameId = store[card.parentId]?.typeName === 'shape' ? card.parentId : null
    await this.editCanvas(UPDATE_TOOL, { projectDir, canvasDir, pageId, updates: [{ shapeId: made.shapeId, ...at, ...(frameId ? { frameId } : {}) }] })
    const removed = await this.editCanvas(DELETE_TOOL, { projectDir, canvasDir, pageId, shapeIds: [id] })
    const bounds = { ...at, w: made.bounds.w, h: made.bounds.h }
    const source = basename(nonEmpty(rest.fileName) ?? nonEmpty(rest.imagePath) ?? '')
    const text = [
      `已用新图 ${made.shapeId}${source && source !== basename(made.assetFile ?? '') ? `（${source}）` : ''} 换掉 ${id}：${round2(bounds.w)}×${round2(bounds.h)}，位于 ${pageId} 的 (${bounds.x}, ${bounds.y})${frameId ? `，在${store[frameId]?.type === 'frame' ? '分组框' : ''} ${frameId} 里` : ''}，在原来那张的位置居中；文件 ${made.assetFile}`,
      removed?.content?.find((item) => item.type === 'text')?.text ?? ''
    ].filter(Boolean).join('\n')
    return textResult(text, { ...made, bounds, parentId: frameId ?? pageId, replacedShapeId: id })
  }

  // Puts what upstream just inserted at x, y, or beside its anchor on its side (placeBeside:
  // past what is in the way, each step to just beyond it; upstream steps by the new shape's own
  // size). A result that replaced, filled or updated something stays where that was; place.asked
  // (x, y or above) says so in the result.
  async #placeInserted(args, result, place) {
    const inserted = result?.structuredContent
    if (!inserted?.shapeId || inserted.dryRun) return result
    const note = (line) => (place.asked ? { ...result, content: [{ type: 'text', text: `${result.content?.[0]?.text ?? ''}\n${line}` }] } : result)
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    const snapshot = await this.#storedSnapshot({ projectDir, canvasDir })
    const store = snapshot?.store ?? {}
    const shape = store[inserted.shapeId]
    const meta = shape?.meta ?? {}
    const tookPlace =
      inserted.replacedAiImageHolder || inserted.replacedAiDraftHolder || inserted.updatedExistingHtmlDraft ||
      meta.cowartGeneratedForAiImageHolder || meta.cowartGeneratedForAiDraftHolder || meta.cowartAiSlidesParentShapeId
    if (!shape || tookPlace || store[shape.parentId]?.typeName !== 'page') return note('x / y、above 没用上：这次替换或填进了一个框，位置跟着那个框。')
    const bounds = pageBounds(store, shape)
    let target
    if (place.x !== null || place.y !== null) {
      target = { x: place.x ?? bounds.x, y: place.y ?? bounds.y }
    } else {
      const anchor = store[inserted.anchorShapeId ?? inserted.draftShapeId]
      if (anchor?.typeName !== 'shape') return note('above 没用上：没有 anchorShapeId。')
      const margin = Math.max(0, finiteOrNull(args.margin) ?? 40)
      const others = Object.values(store)
        .filter((record) => record?.typeName === 'shape' && record.parentId === shape.parentId && record.id !== shape.id && record.id !== anchor.id)
        .map((record) => pageBounds(store, record))
      target = placeBeside(pageBounds(store, anchor), bounds, place.side, margin, others)
    }
    if (Math.abs(target.x - bounds.x) < 0.01 && Math.abs(target.y - bounds.y) < 0.01) return result
    const moved = { ...shape, x: Math.round((shape.x + target.x - bounds.x) * 100) / 100, y: Math.round((shape.y + target.y - bounds.y) * 100) / 100 }
    const saved = structuredOrThrow(
      await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store: { ...store, [moved.id]: moved } } }),
      'save_cowart_canvas_state'
    )
    if (!saved.ok || (saved.skippedRecords ?? []).some((record) => record.id === moved.id)) return note('没能挪到指定位置，留在了上面说的位置。')
    const placed = { x: target.x, y: target.y, w: bounds.w, h: bounds.h }
    // Upstream's line names where it first put the shape: it names the final place instead.
    const [first = '', ...rest] = (result.content?.[0]?.text ?? '').split('\n')
    const line = first.replace(/ at \([^)]*\)/, ` at (${Math.round(placed.x)}, ${Math.round(placed.y)})`)
    return { ...result, content: [{ type: 'text', text: [line, ...rest].join('\n') }], structuredContent: { ...inserted, bounds: placed } }
  }

  // ---- Layout tools (canvas-edit.mjs) ----------------------------------------------------

  // insert_cowart_text / insert_cowart_frame / update_cowart_shapes / delete_cowart_shapes on the
  // page args.pageId: planned on the stored canvas, checked against tldraw before anything is
  // written (a record the page could not show fails the call), then saved at once.
  async editCanvas(name, args) {
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey('save_cowart_canvas_state', canvasDir), async () => {
      const snapshot = await this.#storedSnapshot({ projectDir, canvasDir })
      if (!snapshot?.store) throw new Error('画布还没有数据：先打开画布，在画布页面里加载一次。')
      // The page the call's shapes are on, when the session's page did not have to stand in.
      const pageId = nonEmpty(args.pageId) ?? (await this.#editTargetPage(args, name))
      const plan = planCanvasEdit(name, snapshot.store, { ...args, pageId })
      const next = { ...snapshot, store: plan.store }
      const written = new Set([...plan.created, ...plan.changed])
      const rejected = (await this.#invalidRecords(next, { pageIds: [pageId] })).filter((record) => written.has(record.id))
      if (rejected.length > 0) {
        throw new Error(`${name}：没有写入，${rejected.map((record) => `${record.id}（${record.reason}）`).join('；')} 没通过 tldraw 的校验，页面显示不了。`)
      }
      const saved = await this.#callWithRetry('save_cowart_canvas_state', {
        projectDir,
        canvasDir,
        snapshot: next,
        protectImageRecords: true,
        acknowledgedImageShapeDeletes: plan.imageDeletes
      })
      const content = saved?.structuredContent ?? {}
      if (saved?.isError || content.ok === false) {
        const text = saved?.content?.find((item) => item.type === 'text')?.text
        throw new Error(`${name}：保存画布失败：${content.message || text || '原因不明'}`)
      }
      const skipped = (content.skippedRecords ?? []).filter((record) => written.has(record.id))
      if (skipped.length > 0) this.#log(`${name}: saved without ${skipped.map((record) => record.id).join(', ')}`)
      this.#guard.trackInsertedRecords(canvasDir, plan.created.map((id) => plan.store[id]))
      for (const id of plan.removed) if (snapshot.store[id]?.typeName === 'shape') this.#guard.trackRemovedShape(canvasDir, id)
      this.#pagesChanged(canvasDir, [pageId])

      let text = plan.text
      const files = (plan.result.deleted ?? []).map((entry) => (entry.assetSrc ? localPathForAssetSrc(canvasDir, entry.assetSrc) : null)).filter(Boolean)
      if (files.length > 0) text += `\n素材文件还在（要放回就用 insert_cowart_image / insert_cowart_video）：\n${files.map((file) => `- ${file}`).join('\n')}`
      if (skipped.length > 0) text += `\n⚠ 保存时 ${skipped.map((record) => record.id).join('、')} 被丢掉了（${skipped[0].reason}）。`
      return textResult(text, plan.result)
    })
  }

  // The records tldraw's validation skips (a canvas page could not show them): upstream saves
  // the snapshot, or its pages pageIds, into a scratch canvas (every upstream save validates
  // first) and reports them. Assets go without their src, so no media file is copied.
  async #invalidRecords(snapshot, { pageIds = null } = {}) {
    const store = snapshot?.store ?? {}
    const wanted = pageIds ? new Set(pageIds) : null
    const subset = {}
    for (const [id, record] of Object.entries(store)) {
      if (record?.typeName === 'asset') {
        subset[id] = { ...record, props: { ...record.props, src: null } }
      } else if (wanted && record?.typeName === 'page') {
        if (wanted.has(id)) subset[id] = record
      } else if (wanted && record?.typeName === 'shape') {
        if (wanted.has(pageIdOfShape(store, record))) subset[id] = record
      } else {
        subset[id] = record
      }
    }
    const scratch = await mkdtemp(join(tmpdir(), 'cowart-check-'))
    try {
      const result = await this.#upstream.callTool('save_cowart_canvas_state', { projectDir: scratch, canvasDir: scratch, snapshot: { ...snapshot, store: subset } })
      const content = result?.structuredContent
      if (!content) throw new Error(result?.content?.find((item) => item.type === 'text')?.text || '上游没回校验结果。')
      return (content.skippedRecords ?? []).filter((record) => !(wanted && record.typeName === 'binding' && /^Missing dependent record/.test(record.reason ?? '')))
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }

  // The canvas summary; with pageId, of that page alone (the one canvas carries every session's
  // pages, dozens of them: the whole summary ran to 268 KB on 2026-10-22).
  async canvasState({ pageId: wantedPage, ...args }) {
    const result = await this.#upstream.callTool(CANVAS_STATE_TOOL, { ...args, hydrateAssets: false })
    if (args.includeSnapshot === true) return result
    const state = structuredOrThrow(result, CANVAS_STATE_TOOL)
    const pageId = nonEmpty(wantedPage)
    if (pageId && !pageRecords(state.snapshot).some((page) => page.id === pageId)) throw new Error(`画布上没有 ${pageId} 这一页。`)
    // Records a page cannot show are marked, so the model does not count on them.
    const invalid = state.snapshot?.store
      ? await this.#invalidRecords(state.snapshot, { pageIds: pageId ? [pageId] : null }).catch((error) => {
          this.#log(`canvas summary without validation: ${error instanceof Error ? error.message : error}`)
          return []
        })
      : []
    const whole = summarizeCanvas({ ...state, invalid })
    const summary = pageId ? { ...whole, pages: whole.pages.filter((page) => page.id === pageId) } : whole
    return textResult(formatCanvasSummary(summary, { onePage: Boolean(pageId) }), summary)
  }

  // Every page in order, with how many shapes it has (no validation, no shape details).
  async pageList(args) {
    const snapshot = await this.#storedSnapshot(args)
    return pageRecords(snapshot).map((page) => ({ id: page.id, name: page.name, folder: folderOf(page), shapes: shapesOnPage(snapshot, page.id).length }))
  }

  async insertVideo(args) {
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

    const { projectDir, canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey(INSERT_VIDEO_TOOL, canvasDir), async () => {
      const state = structuredOrThrow(await this.#upstream.callTool(CANVAS_STATE_TOOL, { projectDir, canvasDir }), CANVAS_STATE_TOOL)
      if (!state.snapshot) {
        throw new Error('这个画布还没有数据：先用 render_cowart_canvas_widget 打开画布，并在 Browser 面板里加载一次。')
      }
      const videoWidth = Number(args.videoWidth) || probe.width
      const videoHeight = Number(args.videoHeight) || probe.height
      const holderShapeId = nonEmpty(args.replaceHolderShapeId)
      const plan = holderShapeId
        ? planVideoInHolder({ snapshot: state.snapshot, holderShapeId, videoWidth, videoHeight })
        : planVideoPlacement({
            snapshot: state.snapshot,
            viewState: state.viewState,
            pageId: nonEmpty(args.pageId),
            anchorShapeId: nonEmpty(args.anchorShapeId),
            placement: args.placement,
            margin: Number.isFinite(args.margin) ? args.margin : 40,
            matchAnchor: args.matchAnchor ?? (isGroupFrame(state.snapshot.store?.[nonEmpty(args.anchorShapeId)]) ? false : undefined),
            displayWidth: args.displayWidth,
            displayHeight: args.displayHeight,
            videoWidth,
            videoHeight,
            x: finiteOrNull(args.x),
            y: finiteOrNull(args.y)
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
      const store = { ...state.snapshot.store, [asset.id]: asset, [shape.id]: shape }
      // The video replaces its holder; a holder the user filled with other shapes stays put.
      const removeHolder =
        holderShapeId && !Object.values(store).some((record) => record?.typeName === 'shape' && record.parentId === holderShapeId)
      if (removeHolder) delete store[holderShapeId]
      const snapshot = { ...state.snapshot, store }
      const saved = structuredOrThrow(
        await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot }),
        'save_cowart_canvas_state'
      )
      if (!saved.ok) throw new Error(saved.message || '保存画布失败。')
      const rejected = (saved.skippedRecords ?? []).filter((record) => record.id === asset.id || record.id === shape.id)
      if (rejected.length > 0) {
        throw new Error(`视频记录没通过 tldraw 校验：${rejected.map((record) => `${record.id} ${record.reason}`).join('；')}`)
      }
      this.#guard.trackInsertedVideo(canvasDir, { shape, asset })
      if (removeHolder) this.#guard.trackRemovedShape(canvasDir, holderShapeId)
      this.#pagesChanged(canvasDir, [plan.pageId])

      return textResult(
        `已插入视频 ${shape.id}：${plan.w}×${plan.h}，位于 ${plan.pageId} 的 (${plan.x}, ${plan.y})${removeHolder ? `，替换了 AI 视频框 ${holderShapeId}` : ''}；文件 ${filePath}`,
        {
          ok: true,
          shapeId: shape.id,
          assetId: asset.id,
          pageId: plan.pageId,
          bounds: { x: plan.x, y: plan.y, w: plan.w, h: plan.h },
          replacedHolderShapeId: removeHolder ? holderShapeId : null,
          filePath,
          mimeType: probe.mimeType
        }
      )
    })
  }
}
