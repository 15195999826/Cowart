// Tools the model lays a canvas page out with (FORK.md 画布整理): text for labels, numbers and
// titles, group frames, moving / resizing / retitling shapes, and deleting them. The canvas
// service lists them next to upstream's tools, so every host's bridge forwards them like the
// rest. This file plans a call on the stored canvas and returns the canvas to write; the
// service checks that against tldraw's validation before it saves (canvas-ops.mjs).
//
// Positions are page coordinates of a shape's top left, as the canvas summary reports them.
// A frame (tldraw's frame shape) holds shapes as its children: they move with it and are
// clipped to it. The page's own rules for 标注 are kept: an annotation arrow follows the card
// it points at when that card moves, and goes with it when it is deleted (src/App.jsx
// registerAnnotationBindings does this for the user's edits only, not for remote ones).
import { randomUUID } from 'node:crypto'

import { generateNKeysBetween } from 'fractional-indexing'

import { childrenByParent, compareIndex, estimateTextSize, fromPage, pageBounds, pageIdOfShape, pageTransform, parentTransform, shapeText, unionBounds } from '../../shared/canvas-model.mjs'

export const TEXT_TOOL = 'insert_cowart_text'
export const FRAME_TOOL = 'insert_cowart_frame'
export const UPDATE_TOOL = 'update_cowart_shapes'
export const DELETE_TOOL = 'delete_cowart_shapes'
export const EDIT_TOOLS = new Set([TEXT_TOOL, FRAME_TOOL, UPDATE_TOOL, DELETE_TOOL])

const COLORS = ['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white']
const SIZES = ['s', 'm', 'l', 'xl']
const FONTS = ['sans', 'serif', 'mono', 'draw']
const TEXT_ALIGNS = ['start', 'middle', 'end']
const PLACEMENTS = ['below', 'above', 'left', 'right']
const TEXT_MARGIN = 12
const FRAME_PADDING = 40
// Room a frame keeps around a text it grew for.
const GROW_MARGIN = 16
const MAX_ITEMS = 500
// Shapes with a box of their own (props.w / props.h) that can be resized.
const RESIZABLE = new Set(['image', 'video', 'embed', 'geo', 'frame', 'bookmark'])
// Resized with one side given, these keep their ratio.
const KEEP_RATIO = new Set(['image', 'video'])
const UPDATE_FIELDS = ['x', 'y', 'dx', 'dy', 'w', 'h', 'text', 'name', 'frameId', 'fit']

const PAGE_ID_INPUT = {
  type: 'string',
  description: 'Page to work on. By default the page this session is responsible for (or the one its canvas pane shows); a call that names shapes works on their page.'
}

export const EDIT_TOOL_DEFINITIONS = [
  {
    name: TEXT_TOOL,
    title: 'Insert Cowart Text',
    description:
      'Put text on a canvas page: numbers and labels for cards, titles, notes. Each item goes at x, y (page coordinates of its top left, as get_cowart_canvas_state reports positions) or next to anchorShapeId (placement below / above / left / right, margin apart), exactly there: nothing is shifted around other shapes, so leave room first (update_cowart_shapes moves cards). Below or above a card the text box is as wide as the card, so textAlign "middle" centers it on the card. A text next to a card inside a group frame goes into that frame, and the frame grows when the text would stick out. All items of a call are saved together. Returns the new shape ids and their boxes.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: PAGE_ID_INPUT,
        items: {
          type: 'array',
          description: 'The texts to add.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The words; a line break starts a new line.' },
              x: { type: 'number', description: 'Page x of the text box top left (with y; or give anchorShapeId).' },
              y: { type: 'number', description: 'Page y of the text box top left.' },
              anchorShapeId: { type: 'string', description: 'Put the text next to this shape instead of at x, y.' },
              placement: { type: 'string', enum: PLACEMENTS, description: 'Side of anchorShapeId (default below).' },
              margin: { type: 'number', description: `Gap to anchorShapeId (default ${TEXT_MARGIN}).` },
              frameId: { type: 'string', description: 'Put the text into this group frame (it grows to fit). A text next to a card in a frame goes into that frame anyway; "page" keeps it out.' },
              width: { type: 'number', description: 'Fixed width to wrap the text in. Without it the box fits the words (below / above an anchor: the anchor width).' },
              size: { type: 'string', enum: SIZES, description: 'Font size: s 18, m 24 (default), l 36, xl 44.' },
              color: { type: 'string', enum: COLORS, description: 'Default black.' },
              font: { type: 'string', enum: FONTS, description: 'Default sans; draw is the hand-drawn font.' },
              textAlign: { type: 'string', enum: TEXT_ALIGNS, description: 'Alignment inside the text box (default start).' }
            },
            required: ['text']
          }
        }
      },
      required: ['items']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: FRAME_TOOL,
    title: 'Insert Cowart Group Frame',
    description:
      'Group shapes on a canvas page in a frame: a box with a title above it; what is inside moves with the frame and is clipped to it. With shapeIds the frame is fitted around those shapes (padding apart) and they move into it without changing place (their 标注 arrows stay bound and visible). Without shapeIds give x, y, w, h for an empty frame. The frame goes behind the other shapes of its page (or of the frame the shapes share). Returns the frame id and its box.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: PAGE_ID_INPUT,
        name: { type: 'string', description: 'Title shown above the frame (e.g. 风格 A).' },
        shapeIds: { type: 'array', items: { type: 'string' }, description: 'Shapes to put into the frame.' },
        padding: { type: 'number', description: `Room between the shapes and the frame edge (default ${FRAME_PADDING}).` },
        x: { type: 'number', description: 'Without shapeIds: page x of the frame top left.' },
        y: { type: 'number', description: 'Without shapeIds: page y of the frame top left.' },
        w: { type: 'number', description: 'Without shapeIds: frame width.' },
        h: { type: 'number', description: 'Without shapeIds: frame height.' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: UPDATE_TOOL,
    title: 'Update Cowart Shapes',
    description:
      'Move, resize, retitle or regroup shapes on a canvas page, any number in one call (saved together). x, y put a shape top left at page coordinates (as get_cowart_canvas_state reports them); dx, dy move it by that much. A frame moves with everything inside it, and the 标注 / 注释 arrows of a moved card follow it. w, h resize (an image or video given one side keeps its ratio; a text given w wraps inside it). text replaces the words of a text, note or labeled shape; name retitles a frame. frameId puts a shape into that group frame, "page" takes it out; either way it stays where it is on the page. fit: true makes a frame just big enough for what is inside (padding apart). Canvas pages pick the change up within seconds; Ctrl+Z on a page does not undo it.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: PAGE_ID_INPUT,
        updates: {
          type: 'array',
          description: 'One entry per shape.',
          items: {
            type: 'object',
            properties: {
              shapeId: { type: 'string' },
              x: { type: 'number', description: 'New page x of the top left.' },
              y: { type: 'number', description: 'New page y of the top left.' },
              dx: { type: 'number', description: 'Move right by this much (negative: left).' },
              dy: { type: 'number', description: 'Move down by this much (negative: up).' },
              w: { type: 'number', description: 'New width.' },
              h: { type: 'number', description: 'New height.' },
              text: { type: 'string', description: 'New words (text, note, geo or arrow label).' },
              name: { type: 'string', description: 'New frame title.' },
              frameId: { type: 'string', description: 'Group frame to put the shape into; "page" takes it out of its frame.' },
              fit: { type: 'boolean', description: 'Frames: fit the frame around what is inside it.' },
              padding: { type: 'number', description: `With fit: room around the contents (default ${FRAME_PADDING}).` }
            },
            required: ['shapeId']
          }
        }
      },
      required: ['updates']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: DELETE_TOOL,
    title: 'Delete Cowart Shapes',
    description:
      'Delete shapes from a canvas page: only what the user asked to remove. The 标注 / 注释 arrows bound to a deleted card go with it. Deleting a frame keeps what is inside it on the page (in place) unless deleteChildren is true. Image and video files stay in the page assets folder (the result lists them), so a deleted picture can be put back with insert_cowart_image. Ctrl+Z on a canvas page does not bring deleted shapes back.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: PAGE_ID_INPUT,
        shapeIds: { type: 'array', items: { type: 'string' }, description: 'Shapes to delete.' },
        deleteChildren: { type: 'boolean', description: 'Frames: delete what is inside too (default false: it stays on the page).' }
      },
      required: ['shapeIds']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }
]

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOrNull(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

function round(value) {
  return Math.round(value * 100) / 100
}

function box(bounds) {
  return { x: round(bounds.x), y: round(bounds.y), w: round(bounds.w), h: round(bounds.h) }
}

function describeBox(bounds) {
  return `(${Math.round(bounds.x)}, ${Math.round(bounds.y)}) ${Math.round(bounds.w)}×${Math.round(bounds.h)}`
}

function pick(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (allowed.includes(value)) return value
  throw new Error(`${label} 只能是 ${allowed.join(' / ')}，收到的是 ${JSON.stringify(value)}。`)
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function uniqueIds(value) {
  return [...new Set(list(value).map(nonEmpty).filter(Boolean))]
}

function newShapeId() {
  return `shape:${randomUUID().replaceAll('-', '').slice(0, 21)}`
}

function plainText(value) {
  return String(value).replace(/\r\n?/g, '\n')
}

// tldraw's toRichText: one paragraph per line.
export function toRichText(text) {
  return {
    type: 'doc',
    content: plainText(text)
      .split('\n')
      .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }))
  }
}

// Angles as tldraw keeps them, without float noise around whole turns.
function tidyRotation(rotation) {
  const turn = Math.PI * 2
  const normal = ((rotation % turn) + turn) % turn
  return Math.abs(normal) < 1e-9 || Math.abs(normal - turn) < 1e-9 ? 0 : normal
}

// Index keys tldraw wrote may end in 0 after the integer part, which fractional-indexing
// refuses; the same key without those zeros sorts the same.
function tidyIndex(key) {
  if (typeof key !== 'string' || !key) return null
  const head = key.charCodeAt(0)
  const integer = head >= 97 && head <= 122 ? head - 97 + 2 : head >= 65 && head <= 90 ? 90 - head + 2 : 0
  if (!integer || key.length < integer) return null
  let tail = key.slice(integer)
  while (tail.endsWith('0')) tail = tail.slice(0, -1)
  return key.slice(0, integer) + tail
}

// The canvas being edited: a copy of the stored store, with what changed.
class Draft {
  constructor(store, pageId) {
    this.base = store
    this.store = { ...store }
    this.pageId = pageId
    this.created = new Set()
    this.changed = new Set()
    this.removed = new Set()
  }

  children(parentId) {
    return childrenByParent(this.store).get(parentId) ?? []
  }

  // A shape of the page being edited.
  shape(id, label) {
    const record = id ? this.store[id] : null
    if (record?.typeName !== 'shape') throw new Error(`${label}：画布上没有图形 ${id}（id 以 get_cowart_canvas_state 列出的为准）。`)
    const pageId = pageIdOfShape(this.store, record)
    if (pageId !== this.pageId) throw new Error(`${label}：${id} 不在 ${this.pageId} 这一页，一次调用只改一页。`)
    return record
  }

  frame(id, label) {
    const record = this.shape(id, label)
    if (record.type !== 'frame') throw new Error(`${label}：${id} 是 ${record.type}，不是分组框。`)
    return record
  }

  isAncestor(ancestorId, id) {
    const visited = new Set()
    for (let record = this.store[this.store[id]?.parentId]; record?.typeName === 'shape' && !visited.has(record.id); record = this.store[record.parentId]) {
      if (record.id === ancestorId) return true
      visited.add(record.id)
    }
    return false
  }

  descendants(id) {
    const index = childrenByParent(this.store)
    const found = []
    const queue = [...(index.get(id) ?? [])]
    while (queue.length > 0) {
      const shape = queue.shift()
      found.push(shape.id)
      queue.push(...(index.get(shape.id) ?? []))
    }
    return found
  }

  // The frame a shape sits in, through groups (null: none).
  frameOf(shape) {
    const visited = new Set()
    for (let record = this.store[shape.parentId]; record?.typeName === 'shape' && !visited.has(record.id); record = this.store[record.parentId]) {
      if (record.type === 'frame') return record
      visited.add(record.id)
    }
    return null
  }

  put(record) {
    this.store[record.id] = record
    if (!this.created.has(record.id)) this.changed.add(record.id)
  }

  create(record) {
    this.store[record.id] = record
    this.created.add(record.id)
  }

  remove(id) {
    delete this.store[id]
    this.created.delete(id)
    this.changed.delete(id)
    if (this.base[id]) this.removed.add(id)
  }

  #indexes(parentId) {
    return this.children(parentId).map((shape) => tidyIndex(shape.index)).filter(Boolean).sort(compareIndex)
  }

  topIndexes(parentId, count) {
    return generateNKeysBetween(this.#indexes(parentId).at(-1) ?? null, null, count)
  }

  bottomIndexes(parentId, count) {
    return generateNKeysBetween(null, this.#indexes(parentId)[0] ?? null, count)
  }

  // Moves a shape under another parent without moving it on the page.
  reparent(id, parentId, index) {
    const shape = this.store[id]
    const own = pageTransform(this.store, shape)
    const parent = parentTransform(this.store, parentId)
    const origin = fromPage(parent, own)
    this.put({
      ...shape,
      parentId,
      index: index ?? this.topIndexes(parentId, 1)[0],
      x: round(origin.x),
      y: round(origin.y),
      rotation: tidyRotation(own.rotation - parent.rotation)
    })
  }

  // Moves a shape on the page by dx, dy (its children go along).
  translate(id, dx, dy) {
    const shape = this.store[id]
    const own = pageTransform(this.store, shape)
    const parent = parentTransform(this.store, shape.parentId)
    const origin = fromPage(parent, { x: own.x + dx, y: own.y + dy })
    this.put({ ...shape, x: round(origin.x), y: round(origin.y) })
  }

  // Gives a frame a new page box while what is inside stays where it is on the page.
  setFrameBox(id, target) {
    const frame = this.store[id]
    const own = pageTransform(this.store, frame)
    if (tidyRotation(own.rotation) !== 0) throw new Error(`分组框 ${id} 转过角度，不能自动改它的范围。`)
    const parent = parentTransform(this.store, frame.parentId)
    const origin = fromPage(parent, { x: target.x, y: target.y })
    const dx = target.x - own.x
    const dy = target.y - own.y
    this.put({ ...frame, x: round(origin.x), y: round(origin.y), props: { ...frame.props, w: round(target.w), h: round(target.h) } })
    if (dx !== 0 || dy !== 0) {
      for (const child of this.children(id)) this.put({ ...child, x: round(child.x - dx), y: round(child.y - dy) })
    }
  }

  // Grows a frame (and the frames around it) until the page box fits inside, margin apart.
  // Returns the frames that grew.
  growFrameToFit(id, bounds, margin) {
    const grown = []
    let frame = this.store[id]
    let needed = { x: bounds.x - margin, y: bounds.y - margin, w: bounds.w + margin * 2, h: bounds.h + margin * 2 }
    while (frame?.type === 'frame') {
      const current = pageBounds(this.store, frame)
      const target = unionBounds([current, needed])
      if (target.x >= current.x - 0.01 && target.y >= current.y - 0.01 && target.w <= current.w + 0.01 && target.h <= current.h + 0.01) break
      this.setFrameBox(frame.id, target)
      grown.push(frame.id)
      needed = target
      frame = this.frameOf(frame)
    }
    return grown
  }

  // 标注 / 注释 arrows on the page follow the card they point at when it moved on the page,
  // the way the canvas page moves them after a user's drag. Returns the arrows moved.
  followAnnotations() {
    const moved = []
    for (const binding of Object.values(this.store)) {
      if (binding?.typeName !== 'binding' || binding.type !== 'arrow' || binding.props?.terminal !== 'end') continue
      const arrow = this.store[binding.fromId]
      const target = this.store[binding.toId]
      const before = this.base[binding.toId]
      if (arrow?.meta?.cowartAnnotationArrow !== true || !target || !before) continue
      if (this.store[arrow.parentId]?.typeName !== 'page' || moved.includes(arrow.id)) continue
      if (this.base[arrow.id] && (this.base[arrow.id].x !== arrow.x || this.base[arrow.id].y !== arrow.y || this.base[arrow.id].parentId !== arrow.parentId)) continue
      const from = pageTransform(this.base, before)
      const to = pageTransform(this.store, target)
      const dx = to.x - from.x
      const dy = to.y - from.y
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue
      this.put({ ...arrow, x: round(arrow.x + dx), y: round(arrow.y + dy) })
      moved.push(arrow.id)
    }
    return moved
  }

  // Frames whose contents stick out of them after an edit (the page clips those parts).
  clipped() {
    const found = []
    const index = childrenByParent(this.store)
    for (const record of Object.values(this.store)) {
      if (record?.typeName !== 'shape' || record.type !== 'frame') continue
      const touched = this.changed.has(record.id) || (index.get(record.id) ?? []).some((child) => this.changed.has(child.id) || this.created.has(child.id))
      if (!touched) continue
      const frame = pageBounds(this.store, record, index)
      for (const child of index.get(record.id) ?? []) {
        const inner = pageBounds(this.store, child, index)
        const outside = inner.x < frame.x - 0.5 || inner.y < frame.y - 0.5 || inner.x + inner.w > frame.x + frame.w + 0.5 || inner.y + inner.h > frame.y + frame.h + 0.5
        if (outside) found.push({ frameId: record.id, frameName: record.props?.name ?? '', shapeId: child.id })
      }
    }
    return found
  }
}

function frameLabel(record) {
  const name = nonEmpty(record?.props?.name)
  return name ? `「${name}」` : ''
}

function textShape({ parentId, index, origin, rotation, props }) {
  return {
    id: newShapeId(),
    typeName: 'shape',
    type: 'text',
    x: round(origin.x),
    y: round(origin.y),
    rotation,
    isLocked: false,
    opacity: 1,
    parentId,
    index,
    props,
    meta: {}
  }
}

function planText(draft, args) {
  const items = list(args.items)
  if (items.length === 0) throw new Error('items 至少要有一条：{ text, x 和 y }，或 { text, anchorShapeId, placement }。')
  if (items.length > MAX_ITEMS) throw new Error(`一次最多放 ${MAX_ITEMS} 段文字。`)
  const added = []
  const grown = new Set()
  for (const [n, item] of items.entries()) {
    const label = `items[${n}]`
    const text = typeof item?.text === 'string' ? plainText(item.text) : ''
    if (!text.trim()) throw new Error(`${label}：text 不能是空的。`)
    const width = numberOrNull(item.width)
    if (width !== null && width <= 0) throw new Error(`${label}：width 要大于 0。`)
    const props = {
      color: pick(item.color, COLORS, 'black', `${label}.color`),
      size: pick(item.size, SIZES, 'm', `${label}.size`),
      font: pick(item.font, FONTS, 'sans', `${label}.font`),
      textAlign: pick(item.textAlign, TEXT_ALIGNS, 'start', `${label}.textAlign`),
      w: 1,
      richText: toRichText(text),
      scale: 1,
      autoSize: width === null
    }
    if (width !== null) props.w = width

    const anchorId = nonEmpty(item.anchorShapeId)
    const x = numberOrNull(item.x)
    const y = numberOrNull(item.y)
    let bounds
    let frame = null
    if (anchorId) {
      if (x !== null || y !== null) throw new Error(`${label}：x / y 和 anchorShapeId 只给一种。`)
      const anchor = draft.shape(anchorId, `${label}.anchorShapeId`)
      const around = pageBounds(draft.store, anchor)
      const placement = pick(item.placement, PLACEMENTS, 'below', `${label}.placement`)
      const margin = numberOrNull(item.margin) ?? TEXT_MARGIN
      if (placement === 'below' || placement === 'above') {
        props.autoSize = false
        props.w = width ?? around.w
        const size = estimateTextSize(props)
        const offset = props.textAlign === 'middle' ? (around.w - size.w) / 2 : props.textAlign === 'end' ? around.w - size.w : 0
        bounds = { x: around.x + offset, y: placement === 'below' ? around.y + around.h + margin : around.y - margin - size.h, ...size }
      } else {
        const size = estimateTextSize(props)
        bounds = { x: placement === 'right' ? around.x + around.w + margin : around.x - margin - size.w, y: around.y, ...size }
      }
      frame = draft.frameOf(anchor)
    } else {
      if (x === null || y === null) throw new Error(`${label}：给 x 和 y（文字框左上角的页面坐标），或者给 anchorShapeId。`)
      bounds = { x, y, ...estimateTextSize(props) }
    }
    if (props.autoSize) props.w = Math.max(1, Math.ceil(bounds.w))

    const frameInput = nonEmpty(item.frameId)
    if (frameInput === 'page' || frameInput === draft.pageId) frame = null
    else if (frameInput) frame = draft.frame(frameInput, `${label}.frameId`)
    const parentId = frame?.id ?? draft.pageId
    const parent = parentTransform(draft.store, parentId)
    const record = textShape({
      parentId,
      index: draft.topIndexes(parentId, 1)[0],
      origin: fromPage(parent, bounds),
      rotation: tidyRotation(-parent.rotation),
      props
    })
    draft.create(record)
    if (frame) for (const id of draft.growFrameToFit(frame.id, bounds, GROW_MARGIN)) grown.add(id)
    added.push({ shapeId: record.id, text, bounds: box(bounds), ...(frame ? { frameId: frame.id } : {}) })
  }

  const lines = [
    `已放 ${added.length} 段文字（位置按估算的字宽，页面上以实际渲染为准）：`,
    ...added.map((entry) => `- ${entry.shapeId} 「${entry.text.replace(/\s+/g, ' ')}」 ${describeBox(entry.bounds)}${entry.frameId ? ` 在分组框 ${entry.frameId} 里` : ''}`),
    ...[...grown].map((id) => `分组框 ${id}${frameLabel(draft.store[id])} 变大到 ${describeBox(pageBounds(draft.store, draft.store[id]))}，放得下新文字。`)
  ]
  return { lines, result: { pageId: draft.pageId, texts: added, grownFrames: [...grown] } }
}

function planFrame(draft, args) {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const ids = uniqueIds(args.shapeIds)
  const padding = numberOrNull(args.padding) ?? FRAME_PADDING
  if (padding < 0) throw new Error('padding 不能小于 0。')
  const explicit = ['x', 'y', 'w', 'h'].map((key) => numberOrNull(args[key]))
  let members = []
  let bounds
  let parentId = draft.pageId
  if (ids.length > 0) {
    if (explicit.some((value) => value !== null)) {
      throw new Error('给了 shapeIds 时分组框按这些图形的范围定大小，不用再给 x / y / w / h（建好后可以用 update_cowart_shapes 调）。')
    }
    const shapes = ids.map((id) => draft.shape(id, 'shapeIds'))
    // A shape inside another listed shape goes along with it.
    members = shapes.filter((shape) => !shapes.some((other) => other.id !== shape.id && draft.isAncestor(other.id, shape.id)))
    const content = unionBounds(members.map((shape) => pageBounds(draft.store, shape)))
    bounds = { x: content.x - padding, y: content.y - padding, w: content.w + padding * 2, h: content.h + padding * 2 }
    // Shapes that share a frame get a frame inside it.
    const common = members[0].parentId
    if (draft.store[common]?.type === 'frame' && members.every((shape) => shape.parentId === common)) parentId = common
  } else {
    const [x, y, w, h] = explicit
    if (x === null || y === null || w === null || h === null) throw new Error('给 shapeIds（要框进去的图形），或者给空分组框的 x、y、w、h。')
    if (w <= 0 || h <= 0) throw new Error('w、h 要大于 0。')
    bounds = { x, y, w, h }
  }

  const parent = parentTransform(draft.store, parentId)
  const origin = fromPage(parent, bounds)
  const frame = {
    id: newShapeId(),
    typeName: 'shape',
    type: 'frame',
    x: round(origin.x),
    y: round(origin.y),
    rotation: tidyRotation(-parent.rotation),
    isLocked: false,
    opacity: 1,
    parentId,
    index: draft.bottomIndexes(parentId, 1)[0],
    props: { w: round(bounds.w), h: round(bounds.h), name, color: 'black' },
    meta: {}
  }
  draft.create(frame)
  const ordered = [...members].sort((a, b) => compareIndex(a.index, b.index))
  const keys = ordered.length > 0 ? generateNKeysBetween(null, null, ordered.length) : []
  ordered.forEach((shape, n) => draft.reparent(shape.id, frame.id, keys[n]))
  if (parentId !== draft.pageId) draft.growFrameToFit(parentId, bounds, 0)

  const lines = [
    `已建分组框 ${frame.id}${name ? `「${name}」` : ''} ${describeBox(bounds)}${parentId !== draft.pageId ? `，在分组框 ${parentId} 里` : ''}。`,
    members.length > 0 ? `框进 ${members.length} 个图形，页面上的位置不变：${ordered.map((shape) => shape.id).join('、')}` : '框里还没有东西：update_cowart_shapes 给图形传 frameId 放进来。'
  ]
  return { lines, result: { pageId: draft.pageId, frameId: frame.id, name, bounds: box(bounds), shapeIds: ordered.map((shape) => shape.id), parentId } }
}

function planUpdate(draft, args) {
  const updates = list(args.updates)
  if (updates.length === 0) throw new Error('updates 至少要有一条：{ shapeId, 要改的字段 }。')
  if (updates.length > MAX_ITEMS) throw new Error(`一次最多改 ${MAX_ITEMS} 个图形。`)
  const seen = new Set()
  const changes = []
  for (const [n, update] of updates.entries()) {
    const label = `updates[${n}]`
    const id = nonEmpty(update?.shapeId)
    if (!id) throw new Error(`${label}：缺 shapeId。`)
    if (seen.has(id)) throw new Error(`${label}：${id} 在这次调用里出现了两次，合成一条。`)
    seen.add(id)
    draft.shape(id, `${label}.shapeId`)
    if (!UPDATE_FIELDS.some((field) => update[field] !== undefined)) {
      throw new Error(`${label}：没说要改 ${id} 的什么（${UPDATE_FIELDS.join('、')}）。`)
    }
    const done = []

    if (update.frameId !== undefined) {
      const input = update.frameId === null ? 'page' : nonEmpty(update.frameId)
      if (!input) throw new Error(`${label}：frameId 是空的（拿出分组框用 "page"）。`)
      const target = input === 'page' || input === draft.pageId ? draft.pageId : draft.frame(input, `${label}.frameId`).id
      if (target === id || (target !== draft.pageId && draft.isAncestor(id, target))) throw new Error(`${label}：不能把 ${id} 放进它自己里面。`)
      if (draft.store[id].parentId !== target) {
        draft.reparent(id, target)
        done.push(target === draft.pageId ? '拿出分组框' : `放进分组框 ${target}`)
      }
    }

    const x = numberOrNull(update.x)
    const y = numberOrNull(update.y)
    const dx = numberOrNull(update.dx)
    const dy = numberOrNull(update.dy)
    if ((x !== null || y !== null) && (dx !== null || dy !== null)) throw new Error(`${label}：x / y 和 dx / dy 只给一种。`)
    if (x !== null || y !== null || dx !== null || dy !== null) {
      const bounds = pageBounds(draft.store, draft.store[id])
      const moveX = x !== null ? x - bounds.x : dx ?? 0
      const moveY = y !== null ? y - bounds.y : dy ?? 0
      if (Math.abs(moveX) >= 0.01 || Math.abs(moveY) >= 0.01) {
        draft.translate(id, moveX, moveY)
        done.push(`移到 (${Math.round(bounds.x + moveX)}, ${Math.round(bounds.y + moveY)})`)
      }
    }

    const w = numberOrNull(update.w)
    const h = numberOrNull(update.h)
    const fit = update.fit === true
    if (fit && (w !== null || h !== null)) throw new Error(`${label}：fit 和 w / h 只给一种。`)
    if (w !== null || h !== null) {
      if ((w !== null && w <= 0) || (h !== null && h <= 0)) throw new Error(`${label}：w、h 要大于 0。`)
      const shape = draft.store[id]
      if (shape.type === 'text') {
        if (w === null) throw new Error(`${label}：文字只能给 w（换行的宽度），高度跟着字走。`)
        draft.put({ ...shape, props: { ...shape.props, autoSize: false, w: round(w / (Number(shape.props?.scale) || 1)) } })
        done.push(`宽 ${Math.round(w)}（超出换行）`)
      } else if (RESIZABLE.has(shape.type) && Number(shape.props?.w) > 0 && Number(shape.props?.h) > 0) {
        const ratio = shape.props.w / shape.props.h
        const keep = KEEP_RATIO.has(shape.type)
        const width = w ?? (keep ? h * ratio : shape.props.w)
        const height = h ?? (keep ? w / ratio : shape.props.h)
        draft.put({ ...shape, props: { ...shape.props, w: round(width), h: round(height) } })
        done.push(`尺寸 ${Math.round(width)}×${Math.round(height)}`)
      } else {
        throw new Error(`${label}：${shape.type} 不能改尺寸。`)
      }
    }
    if (fit) {
      const shape = draft.store[id]
      if (shape.type !== 'frame') throw new Error(`${label}：fit 只用在分组框上，${id} 是 ${shape.type}。`)
      const padding = numberOrNull(update.padding) ?? FRAME_PADDING
      if (padding < 0) throw new Error(`${label}：padding 不能小于 0。`)
      const contents = draft.children(id).map((child) => pageBounds(draft.store, child))
      if (contents.length === 0) throw new Error(`${label}：分组框 ${id} 里没有东西，不能按内容定大小。`)
      const content = unionBounds(contents)
      const target = { x: content.x - padding, y: content.y - padding, w: content.w + padding * 2, h: content.h + padding * 2 }
      draft.setFrameBox(id, target)
      done.push(`按内容定范围 ${describeBox(target)}`)
    }

    if (update.text !== undefined) {
      if (typeof update.text !== 'string') throw new Error(`${label}：text 要是文字。`)
      const shape = draft.store[id]
      if (!shape.props || !('richText' in shape.props)) throw new Error(`${label}：${shape.type} 上没有文字可改。`)
      draft.put({ ...shape, props: { ...shape.props, richText: toRichText(update.text) } })
      done.push(`文字改成「${plainText(update.text).replace(/\s+/g, ' ')}」`)
    }
    if (update.name !== undefined) {
      if (typeof update.name !== 'string') throw new Error(`${label}：name 要是文字。`)
      const shape = draft.store[id]
      if (shape.type !== 'frame') throw new Error(`${label}：name 是分组框的标题，${id} 是 ${shape.type}。`)
      draft.put({ ...shape, props: { ...shape.props, name: update.name.trim() } })
      done.push(`标题改成「${update.name.trim()}」`)
    }

    // Already as asked (a layout that leaves some shapes where they are).
    changes.push({ shapeId: id, changes: done.length > 0 ? done : ['已经是这样，没动'] })
  }

  const followed = draft.followAnnotations()
  const clipped = draft.clipped()
  const lines = [
    `已改 ${changes.length} 个图形：`,
    ...changes.map((entry) => `- ${entry.shapeId}：${entry.changes.join('；')}`),
    ...(followed.length > 0 ? [`标注跟着卡片移动：${followed.join('、')}`] : []),
    ...clipped.map(
      (entry) =>
        `⚠ ${entry.shapeId} 超出了分组框 ${entry.frameId}${entry.frameName ? `「${entry.frameName}」` : ''}，页面上超出的部分会被裁掉：给这个框 fit: true，或者给 ${entry.shapeId} frameId: "page" 拿出来。`
    )
  ]
  const result = {
    pageId: draft.pageId,
    updated: changes.map((entry) => ({ ...entry, bounds: box(pageBounds(draft.store, draft.store[entry.shapeId])) })),
    followedAnnotations: followed,
    clipped
  }
  return { lines, result }
}

function planDelete(draft, args) {
  const ids = uniqueIds(args.shapeIds)
  if (ids.length === 0) throw new Error('shapeIds 至少要有一个。')
  const deleteChildren = args.deleteChildren === true
  const doomed = new Set(ids.map((id) => draft.shape(id, 'shapeIds').id))
  if (deleteChildren) for (const id of ids) for (const descendant of draft.descendants(id)) doomed.add(descendant)

  // What was inside a deleted frame stays on the page (or in the frame around it), behind the
  // shapes there as it was.
  const released = []
  if (!deleteChildren) {
    const byParent = new Map()
    for (const id of ids) {
      for (const child of draft.children(id)) {
        if (doomed.has(child.id)) continue
        let parentId = draft.store[id].parentId
        while (doomed.has(parentId)) parentId = draft.store[parentId].parentId
        const group = byParent.get(parentId) ?? []
        group.push(child)
        byParent.set(parentId, group)
      }
    }
    for (const [parentId, shapes] of byParent) {
      const keys = draft.bottomIndexes(parentId, shapes.length)
      shapes.forEach((shape, n) => {
        draft.reparent(shape.id, parentId, keys[n])
        released.push(shape.id)
      })
    }
  }

  // 标注 / 注释 go with the card they point at.
  const annotations = []
  for (const record of Object.values(draft.store)) {
    if (record?.typeName !== 'binding' || record.type !== 'arrow' || record.props?.terminal !== 'end' || !doomed.has(record.toId)) continue
    const arrow = draft.store[record.fromId]
    if (arrow?.meta?.cowartAnnotationArrow === true && !doomed.has(arrow.id)) {
      doomed.add(arrow.id)
      annotations.push(arrow.id)
    }
  }

  const deleted = [...doomed].map((id) => {
    const shape = draft.store[id]
    const asset = typeof shape.props?.assetId === 'string' ? draft.store[shape.props.assetId] : null
    const text = shapeText(shape)
    return {
      id,
      type: shape.type,
      ...(text ? { text } : {}),
      ...(nonEmpty(shape.props?.name) ? { name: shape.props.name.trim() } : {}),
      ...(asset && typeof asset.props?.src === 'string' ? { assetSrc: asset.props.src } : {})
    }
  })
  for (const record of Object.values(draft.store)) {
    if (record?.typeName === 'binding' && (doomed.has(record.fromId) || doomed.has(record.toId))) draft.remove(record.id)
  }
  for (const id of doomed) draft.remove(id)

  const direct = deleted.filter((entry) => !annotations.includes(entry.id))
  const lines = [
    `已删 ${direct.length} 个图形：`,
    ...direct.map((entry) => `- ${entry.id} ${entry.type}${entry.name ? ` 「${entry.name}」` : ''}${entry.text ? ` 「${entry.text.replace(/\s+/g, ' ').slice(0, 40)}」` : ''}`),
    ...(annotations.length > 0 ? [`指着它们的标注一起删了：${annotations.join('、')}`] : []),
    ...(released.length > 0 ? [`框里的 ${released.length} 个图形留在页面上，位置不变：${released.join('、')}`] : []),
    '页面上的 Ctrl+Z 撤不回这次删除。'
  ]
  return {
    lines,
    result: { pageId: draft.pageId, deleted, deletedAnnotations: annotations, released },
    imageDeletes: deleted.filter((entry) => entry.type === 'image').map((entry) => entry.id)
  }
}

const PLANNERS = { [TEXT_TOOL]: planText, [FRAME_TOOL]: planFrame, [UPDATE_TOOL]: planUpdate, [DELETE_TOOL]: planDelete }

// The shapes a call names, which decide the page it works on.
export function referencedShapeIds(name, args = {}) {
  const ids = []
  const add = (value) => {
    const id = nonEmpty(value)
    if (id && id !== 'page' && !id.startsWith('page:')) ids.push(id)
  }
  if (name === TEXT_TOOL) {
    for (const item of list(args.items)) {
      add(item?.anchorShapeId)
      add(item?.frameId)
    }
  }
  if (name === FRAME_TOOL || name === DELETE_TOOL) list(args.shapeIds).forEach(add)
  if (name === UPDATE_TOOL) {
    for (const update of list(args.updates)) {
      add(update?.shapeId)
      add(update?.frameId)
    }
  }
  return [...new Set(ids)]
}

// Plans a call on the stored store for the page args.pageId. Returns the store to save, the
// records it adds, changes and removes, the image shapes it deletes (the save acknowledges
// those), and the text and structured result for the model.
export function planCanvasEdit(name, store, args = {}) {
  const planner = PLANNERS[name]
  if (!planner) throw new Error(`画布服务不认识工具 ${name}。`)
  const pageId = nonEmpty(args.pageId)
  if (!pageId) throw new Error(`${name}：不知道改哪一页。先让用户说「打开 Cowart 画布 <页名>」进入一页，或者传 pageId。`)
  if (store?.[pageId]?.typeName !== 'page') throw new Error(`${name}：画布上没有 ${pageId} 这一页。`)
  const draft = new Draft(store, pageId)
  const planned = planner(draft, args)
  return {
    store: draft.store,
    created: [...draft.created],
    changed: [...draft.changed],
    removed: [...draft.removed],
    imageDeletes: planned.imageDeletes ?? [],
    text: planned.lines.join('\n'),
    result: planned.result
  }
}
