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
import { fitImageToAsset, formatCanvasSummary, localPathForAssetSrc, pageBounds, pageIdOfShape, pageRecords, summarizeCanvas } from '../../shared/canvas-model.mjs'
import { sanitizeFileName, uniqueFilePath } from '../../shared/files.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { PREPARE_REQUEST_TOOL, prepareGenerationRequest } from '../../shared/generation-requests.mjs'
import { structuredOrThrow } from '../../shared/upstream.mjs'
import { planVideoInHolder, planVideoPlacement, probeVideoFile, videoRecords } from '../../shared/video.mjs'
import { CAPTURE_WEB_TOOL, captureWebReference } from '../../shared/web-capture.mjs'
import { EDIT_TOOLS, planCanvasEdit, referencedShapeIds } from './canvas-edit.mjs'
import { applyDelta, readDelta, stableStringify } from './delta-merge.mjs'
import { REVEAL_FILE_TOOL, revealCanvasFile } from './reveal-file.mjs'
import { readVideoAsset } from './video-assets.mjs'

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
  const properties = { ...tool.inputSchema.properties, ...PLACEMENT_INPUTS }
  const placement = properties.placement
  if (Array.isArray(placement?.enum) && !placement.enum.includes('above')) properties.placement = { ...placement, enum: [...placement.enum, 'above'] }
  return { ...tool, description: `${tool.description ?? ''}${PLACEMENT_NOTE}`, inputSchema: { ...tool.inputSchema, properties } }
}

function finiteOrNull(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

function rectsOverlap(a, b, padding) {
  return !(a.x + a.w + padding <= b.x || b.x + b.w + padding <= a.x || a.y + a.h + padding <= b.y || b.y + b.h + padding <= a.y)
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

  constructor({ upstream, guard, log }) {
    super()
    this.#upstream = upstream
    this.#guard = guard
    this.#log = log ?? (() => {})
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
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.#upstream.callTool(name, args)
      const message = result?.isError ? result.content?.find((item) => item.type === 'text')?.text ?? '' : ''
      if (!TRANSIENT_FS_ERROR.test(message) || attempt >= WRITE_RETRIES) return result
      await delay(80 * (attempt + 1))
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

  // The canvas's pages in their tldraw order: [{ id, name }].
  async canvasPages(args) {
    return pageRecords(await this.#storedSnapshot(args)).map((page) => ({ id: page.id, name: page.name }))
  }

  // A record of the stored canvas (null when it is not there).
  async shapeRecord(args, id) {
    return (await this.#storedSnapshot(args))?.store?.[id] ?? null
  }

  // The page of that name, created after the last page when the canvas has none (a canvas
  // nobody opened yet starts from the empty template). Open pages pick it up on their next
  // sync. Returns { id, name, created }.
  async ensurePage(args, name) {
    const wanted = nonEmpty(name)
    if (!wanted) throw new Error('页名不能为空。')
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey('save_cowart_canvas_state', canvasDir), async () => {
      const stored = await this.#storedSnapshot({ projectDir, canvasDir })
      const snapshot = stored?.store ? stored : JSON.parse(await readFile(EMPTY_CANVAS_TEMPLATE, 'utf8'))
      const pages = pageRecords(snapshot)
      const existing = pages.find((page) => page.name === wanted)
      if (existing) return { id: existing.id, name: existing.name, created: false }
      const page = {
        id: `page:${randomId()}`,
        typeName: 'page',
        name: wanted,
        index: generateKeyBetween(pages.at(-1)?.index ?? null, null),
        meta: {}
      }
      // A fresh canvas keeps only the page asked for, not the template's «Page 1».
      const store = stored?.store
        ? { ...snapshot.store }
        : Object.fromEntries(Object.entries(snapshot.store).filter(([, record]) => record?.typeName !== 'page'))
      store[page.id] = page
      const saved = structuredOrThrow(
        await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store } }),
        'save_cowart_canvas_state'
      )
      if (!saved.ok) throw new Error(saved.message || `建不了「${wanted}」这一页。`)
      if ((saved.skippedRecords ?? []).some((record) => record.id === page.id)) throw new Error(`「${wanted}」这一页没通过 tldraw 校验。`)
      this.#guard.trackInsertedRecords(canvasDir, [page])
      return { id: page.id, name: wanted, created: true }
    })
  }

  // The page a model write lands on when the call names it or a shape on it; null otherwise.
  async targetPage(args, name) {
    if (EDIT_TOOLS.has(name)) return this.#editTargetPage(args, name)
    if (nonEmpty(args.pageId)) return args.pageId.trim()
    const shapeId = ANCHOR_ARGS.map((key) => nonEmpty(args[key])).find(Boolean)
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
  // reads it, the file gets this session's last selection back.
  async replaySelection(name, args, session) {
    if (!SELECTION_READERS.has(name) || !session) return
    const { projectDir, canvasDir } = resolveCowartPaths(args)
    const selection = this.#selections.get(`${canvasDir}\n${session}`)
    if (selection === undefined) return
    await this.#callLocked('save_cowart_selection_state', { projectDir, canvasDir, selection })
  }

  // Tool calls from a canvas page (the upstream widget and the shared panels). pane is the
  // page's { session } when it identified itself.
  async callFromPage(name, args, { host, pane } = {}) {
    if (name === 'read_cowart_page_asset') {
      try {
        const video = await readVideoAsset(args)
        if (video) return textResult('画布视频素材。', video)
      } catch (error) { return errorResult(error.message) }
    }
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
    if (name === 'save_cowart_selection_state' && pane?.session) {
      this.#selections.set(`${resolveCowartPaths(args).canvasDir}\n${pane.session}`, args.selection)
    }
    const result = await this.#callLocked(name, args)
    if (name === CANVAS_STATE_TOOL) {
      this.#guard.observePageFetch(resolveCowartPaths(args).canvasDir, result?.structuredContent?.snapshot)
    }
    return result
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
      if (delta && snapshot?.store) {
        const disk = await this.#storedSnapshot({ projectDir, canvasDir })
        if (disk?.store && stableStringify(disk.schema) === stableStringify(snapshot.schema)) {
          const applied = applyDelta({ disk, incoming: snapshot, delta })
          snapshot = applied.snapshot
          deletedPages = applied.deletedPages
          merged = true
        }
      }
      const guarded = this.#guard.protectPageSave(canvasDir, snapshot, { restoreInserted: !merged })
      if (guarded.restored.length > 0 || guarded.dropped.length > 0) {
        this.#log(`stale page save: kept ${guarded.restored.length} inserted record(s), dropped ${guarded.dropped.length} replaced holder(s)`)
      }
      const result = await this.#callWithRetry('save_cowart_canvas_state', { ...saveArgs, projectDir, canvasDir, snapshot: guarded.snapshot })
      if (deletedPages.length > 0 && !result?.isError && result?.structuredContent?.ok !== false) {
        this.emit('pages-deleted', { canvasDir, pageIds: deletedPages })
      }
      return result
    })
  }

  // Upstream tools the model calls through a bridge (insert_cowart_image, get_cowart_selection …).
  async callForModel(name, args) {
    if (DROPPED_TOOLS.has(name)) return textResult('画布服务不上报统计。')
    if (!(await this.#upstreamToolNames()).has(name)) return errorResult(`未知工具：${name}`)
    if (!MODEL_INSERT_TOOLS.has(name)) return this.#callLocked(name, args)
    // Upstream places beside an anchor (right, left, below) or in free space; x, y and above
    // are the service's, applied once upstream inserted (sized for below, as above is).
    const { x, y, placement, ...rest } = args
    const place = { x: finiteOrNull(x), y: finiteOrNull(y), above: placement === 'above' }
    const upstreamArgs = placement === undefined ? rest : { ...rest, placement: place.above ? 'below' : placement }
    // What the insert added (and the holder it replaced) survives a stale page save.
    const { canvasDir } = resolveCowartPaths(args)
    return this.#guard.withLock(writeLockKey(name, canvasDir), async () => {
      const before = (await this.#storedSnapshot(args))?.store ?? {}
      let result = await this.#callWithRetry(name, upstreamArgs)
      if (result?.isError) return result
      if (name === 'insert_cowart_image') result = await this.#fitInsertedImage(upstreamArgs, result)
      if (place.x !== null || place.y !== null || place.above) result = await this.#placeInserted(upstreamArgs, result, place)
      const after = (await this.#storedSnapshot(args))?.store ?? {}
      this.#guard.trackInsertedRecords(canvasDir, Object.values(after).filter((record) => !before[record.id]))
      for (const [id, record] of Object.entries(before)) {
        if (record?.typeName === 'shape' && !after[id]) this.#guard.trackRemovedShape(canvasDir, id)
      }
      return result
    })
  }

  // Upstream sizes an inserted image to its box (the AI 图片 holder it replaces, the anchor it
  // matches as 按标注修改 does, or displayWidth x displayHeight) whatever the bitmap's ratio,
  // and a generated image is rarely exactly the holder's ratio: it would land stretched. The
  // image is fitted back to its bitmap's ratio inside that box, centered in a holder (upstream
  // marks what it put into one) and from the box's top left elsewhere. Best effort: when this
  // fails, the insert stands as upstream made it.
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
      if (!fitted) return result
      const saved = structuredOrThrow(
        await this.#callWithRetry('save_cowart_canvas_state', { projectDir, canvasDir, snapshot: { ...snapshot, store: { ...snapshot.store, [fitted.id]: fitted } } }),
        'save_cowart_canvas_state'
      )
      if (!saved.ok) throw new Error(saved.message || '保存画布失败。')
      if ((saved.skippedRecords ?? []).some((record) => record.id === fitted.id)) throw new Error('没通过 tldraw 校验。')
      const bounds = { x: fitted.x, y: fitted.y, w: fitted.props.w, h: fitted.props.h }
      const size = (w, h) => `${round2(w)}×${round2(h)}`
      const lines = [
        `Inserted ${fitted.id} on ${inserted.pageId} at (${round2(bounds.x)}, ${round2(bounds.y)}) using ${inserted.index}.`,
        `图片按原图比例（${size(asset.props.w, asset.props.h)}）等比放进 ${size(shape.props.w, shape.props.h)} 的${center ? ' AI 图片框并居中' : '范围，左上对齐'}：${size(bounds.w, bounds.h)}。`
      ]
      return { ...result, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...inserted, bounds } }
    } catch (error) {
      this.#log(`kept upstream's size for ${inserted.shapeId}: ${error instanceof Error ? error.message : error}`)
      return result
    }
  }

  // Puts what upstream just inserted at x, y, or above its anchor (stepping up past the shapes
  // there, the way upstream steps down for below). A result that replaced, filled or updated
  // something stays where that was.
  async #placeInserted(args, result, place) {
    const inserted = result?.structuredContent
    if (!inserted?.shapeId || inserted.dryRun) return result
    const note = (line) => ({ ...result, content: [{ type: 'text', text: `${result.content?.[0]?.text ?? ''}\n${line}` }] })
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
      const around = pageBounds(store, anchor)
      const margin = Math.max(0, finiteOrNull(args.margin) ?? 40)
      const obstacles = Object.values(store)
        .filter((record) => record?.typeName === 'shape' && record.parentId === shape.parentId && record.id !== shape.id && record.id !== anchor.id)
        .map((record) => pageBounds(store, record))
      const candidate = { x: around.x, y: around.y - margin - bounds.h, w: bounds.w, h: bounds.h }
      for (let attempt = 0; attempt < 60 && obstacles.some((other) => rectsOverlap(candidate, other, margin / 2)); attempt += 1) {
        candidate.y -= bounds.h + margin
      }
      target = candidate
    }
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

  async canvasState(args) {
    const result = await this.#upstream.callTool(CANVAS_STATE_TOOL, { ...args, hydrateAssets: false })
    if (args.includeSnapshot === true) return result
    const state = structuredOrThrow(result, CANVAS_STATE_TOOL)
    // Records a page cannot show are marked, so the model does not count on them.
    const invalid = state.snapshot?.store
      ? await this.#invalidRecords(state.snapshot).catch((error) => {
          this.#log(`canvas summary without validation: ${error instanceof Error ? error.message : error}`)
          return []
        })
      : []
    const summary = summarizeCanvas({ ...state, invalid })
    return textResult(formatCanvasSummary(summary), summary)
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
            matchAnchor: args.matchAnchor,
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
