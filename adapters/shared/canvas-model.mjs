// Read-only helpers over a tldraw store snapshot as saved by upstream Cowart.
import { join } from 'node:path'

const PAGE_ASSETS_ROUTE = '/page-assets/'
const GLOBAL_ASSETS_ROUTE = '/assets/'
const MAX_SHAPES_PER_PAGE = 200

export function storeRecords(snapshot) {
  return Object.values(snapshot?.store ?? {})
}

export function pageRecords(snapshot) {
  return storeRecords(snapshot)
    .filter((record) => record?.typeName === 'page')
    .sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')))
}

export function pageIdOfShape(store, shape) {
  let record = shape
  const visited = new Set()
  while (record && !visited.has(record.id)) {
    visited.add(record.id)
    if (record.typeName === 'page') return record.id
    record = store[record.parentId]
  }
  return null
}

// Page-space position, ignoring rotation of ancestors (good enough for placement).
export function absolutePosition(store, shape) {
  let x = 0
  let y = 0
  let record = shape
  const visited = new Set()
  while (record && record.typeName === 'shape' && !visited.has(record.id)) {
    visited.add(record.id)
    x += Number(record.x) || 0
    y += Number(record.y) || 0
    record = store[record.parentId]
  }
  return { x, y }
}

export function shapeSize(shape) {
  const w = Number(shape?.props?.w)
  const h = Number(shape?.props?.h)
  return {
    w: Number.isFinite(w) && w > 0 ? w : 100,
    h: Number.isFinite(h) && h > 0 ? h : 100
  }
}

export function shapeBounds(store, shape) {
  return { ...absolutePosition(store, shape), ...shapeSize(shape) }
}

// ---- Where shapes are on the page ------------------------------------------------------
// Positions the model reads (the canvas summary) and writes (canvas-edit.mjs) are the top
// left of a shape's page-aligned box, through its parents' positions and rotations.

// tldraw's text: a 16px base font times the size style, and its line height.
const TEXT_FONT_SIZES = { s: 18, m: 24, l: 36, xl: 44 }
const TEXT_LINE_HEIGHT = 1.35
const NOTE_SIZE = 200
const IDENTITY = { x: 0, y: 0, rotation: 0 }

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// Fractional index keys sort by their characters, not by locale.
export function compareIndex(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  return left < right ? -1 : left > right ? 1 : 0
}

// Shapes by parent id (a page or a shape), each list in z-order.
export function childrenByParent(store) {
  const children = new Map()
  for (const record of Object.values(store ?? {})) {
    if (record?.typeName !== 'shape') continue
    const siblings = children.get(record.parentId) ?? []
    siblings.push(record)
    children.set(record.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => compareIndex(a.index, b.index))
  return children
}

// One line of text is about a full em per CJK (and other wide) character and a bit over half
// an em per other character. The page measures the real text; this is for laying out and
// describing it.
function lineWidth(line, fontSize) {
  let width = 0
  for (const char of line) width += char.codePointAt(0) >= 0x2e80 ? fontSize : fontSize * 0.6
  return width
}

// The size a text shape takes on the page, estimated from its words: an autoSize text is as
// wide as its longest line, a fixed-width one wraps inside w.
export function estimateTextSize(props = {}) {
  const fontSize = TEXT_FONT_SIZES[props.size] ?? TEXT_FONT_SIZES.m
  const scale = finite(props.scale, 1) || 1
  const text = props.richText ? richTextToPlain(props.richText) : String(props.text ?? '')
  const widths = text.split('\n').map((line) => lineWidth(line, fontSize))
  const fixed = props.autoSize === false && finite(props.w) > 0
  const w = fixed ? finite(props.w) : Math.max(fontSize / 2, ...widths)
  const rows = fixed ? widths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / w)), 0) : widths.length
  return { w: w * scale, h: rows * fontSize * TEXT_LINE_HEIGHT * scale }
}

function float16(buffer, offset) {
  const bits = buffer.readUInt16LE(offset)
  const sign = bits >> 15 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

// A draw / highlight segment's points: tldraw keeps them in base64, the first point as three
// Float32s and every next one as three Float16 deltas.
function segmentPoints(segment) {
  if (Array.isArray(segment?.points)) return segment.points
  const buffer = Buffer.from(String(segment?.path ?? ''), 'base64')
  if (buffer.length < 12) return []
  let x = buffer.readFloatLE(0)
  let y = buffer.readFloatLE(4)
  const points = [{ x, y }]
  for (let offset = 12; offset + 6 <= buffer.length; offset += 6) {
    x += float16(buffer, offset)
    y += float16(buffer, offset + 2)
    points.push({ x, y })
  }
  return points
}

function pointsBounds(points, scaleX = 1, scaleY = scaleX) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    const x = Number(point?.x) * scaleX
    const y = Number(point?.y) * scaleY
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function unionBounds(list) {
  const boxes = list.filter(Boolean)
  if (boxes.length === 0) return null
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  return {
    x,
    y,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - x,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - y
  }
}

// A shape's box in its own coordinates, before its position and rotation (shapes drawn from
// points, like arrows and lines, do not start at 0, 0).
export function localBounds(shape) {
  const props = shape?.props ?? {}
  const scale = finite(props.scale, 1) || 1
  switch (shape?.type) {
    case 'text':
      return { x: 0, y: 0, ...estimateTextSize(props) }
    case 'note':
      return { x: 0, y: 0, w: NOTE_SIZE * scale, h: (NOTE_SIZE + finite(props.growY)) * scale }
    case 'arrow':
      return pointsBounds([props.start, props.end])
    case 'line':
      return pointsBounds(Object.values(props.points ?? {}))
    case 'draw':
    case 'highlight': {
      const points = (Array.isArray(props.segments) ? props.segments : []).flatMap(segmentPoints)
      if (points.length > 0) return pointsBounds(points, finite(props.scaleX, 1) || 1, finite(props.scaleY, 1) || 1)
      break
    }
    case 'geo': {
      const { w, h } = shapeSize(shape)
      return { x: 0, y: 0, w, h: h + finite(props.growY) }
    }
  }
  return { x: 0, y: 0, ...shapeSize(shape) }
}

export function toPage(transform, point) {
  const cos = Math.cos(transform.rotation)
  const sin = Math.sin(transform.rotation)
  return { x: transform.x + point.x * cos - point.y * sin, y: transform.y + point.x * sin + point.y * cos }
}

export function fromPage(transform, point) {
  const cos = Math.cos(transform.rotation)
  const sin = Math.sin(transform.rotation)
  const dx = point.x - transform.x
  const dy = point.y - transform.y
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
}

// Where a shape's own coordinates land on the page: a point p goes to (x, y) plus p turned by
// rotation, through every parent frame or group.
export function pageTransform(store, shape) {
  const chain = []
  const visited = new Set()
  for (let record = shape; record?.typeName === 'shape' && !visited.has(record.id); record = store[record.parentId]) {
    visited.add(record.id)
    chain.unshift(record)
  }
  let transform = IDENTITY
  for (const record of chain) {
    const origin = toPage(transform, { x: finite(record.x), y: finite(record.y) })
    transform = { x: origin.x, y: origin.y, rotation: transform.rotation + finite(record.rotation) }
  }
  return transform
}

// The transform of a parent's children: a page's is none.
export function parentTransform(store, parentId) {
  const parent = store[parentId]
  return parent?.typeName === 'shape' ? pageTransform(store, parent) : IDENTITY
}

// The page-aligned box around a shape; a group's is the box around its children.
export function pageBounds(store, shape, children = null) {
  if (shape?.type === 'group') {
    const index = children ?? childrenByParent(store)
    const boxes = (index.get(shape.id) ?? []).map((child) => pageBounds(store, child, index))
    if (boxes.length > 0) return unionBounds(boxes)
  }
  const local = localBounds(shape)
  const transform = pageTransform(store, shape)
  const corners = [
    { x: local.x, y: local.y },
    { x: local.x + local.w, y: local.y },
    { x: local.x, y: local.y + local.h },
    { x: local.x + local.w, y: local.y + local.h }
  ]
  return pointsBounds(corners.map((corner) => toPage(transform, corner)))
}

// The largest size of the given aspect (width / height) that fits a w x h box.
export function containSize(box, aspect) {
  if (!(Number.isFinite(aspect) && aspect > 0)) return { w: box.w, h: box.h }
  return aspect > box.w / box.h ? { w: box.w, h: box.w / aspect } : { w: box.h * aspect, h: box.h }
}

// An image shape resized to its bitmap's ratio inside the box it has now, centered in that
// box or kept at its top left; the side it does not fill is rounded to a whole unit. Null
// when the shape already has that ratio (to the unit) or shows a crop.
export function fitImageToAsset(shape, asset, { center = false } = {}) {
  const box = { w: Number(shape?.props?.w), h: Number(shape?.props?.h) }
  const aspect = Number(asset?.props?.w) / Number(asset?.props?.h)
  if (shape?.type !== 'image' || shape.props.crop || !(box.w > 0 && box.h > 0 && Number.isFinite(aspect) && aspect > 0)) return null
  const size = containSize(box, aspect)
  const w = size.w < box.w ? Math.max(1, Math.min(box.w, Math.round(size.w))) : box.w
  const h = size.h < box.h ? Math.max(1, Math.min(box.h, Math.round(size.h))) : box.h
  if (box.w - w < 1 && box.h - h < 1) return null
  let x = Number(shape.x) || 0
  let y = Number(shape.y) || 0
  if (center) {
    // The offset is in the shape's own frame, which turns about its top left.
    const dx = (box.w - w) / 2
    const dy = (box.h - h) / 2
    const rotation = Number(shape.rotation) || 0
    x += dx * Math.cos(rotation) - dy * Math.sin(rotation)
    y += dx * Math.sin(rotation) + dy * Math.cos(rotation)
  }
  return { ...shape, x, y, props: { ...shape.props, w, h } }
}

export function shapesOnPage(snapshot, pageId) {
  const store = snapshot?.store ?? {}
  return storeRecords(snapshot).filter(
    (record) => record?.typeName === 'shape' && pageIdOfShape(store, record) === pageId
  )
}

export function richTextToPlain(node) {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  const separator = node.type === 'doc' ? '\n' : ''
  return node.content.map(richTextToPlain).join(separator)
}

export function shapeText(shape) {
  const props = shape?.props ?? {}
  const text = props.richText ? richTextToPlain(props.richText) : props.text
  return typeof text === 'string' ? text.trim() : ''
}

export function localPathForAssetSrc(canvasDir, src) {
  if (typeof src !== 'string') return null
  if (src.startsWith(PAGE_ASSETS_ROUTE)) {
    const [pageDir, ...parts] = src.slice(PAGE_ASSETS_ROUTE.length).split('/')
    if (!pageDir || parts.length === 0) return null
    return join(canvasDir, 'pages', decodeURIComponent(pageDir), 'assets', ...parts.map(decodeURIComponent))
  }
  if (src.startsWith(GLOBAL_ASSETS_ROUTE)) {
    return join(canvasDir, 'assets', ...src.slice(GLOBAL_ASSETS_ROUTE.length).split('/').map(decodeURIComponent))
  }
  return null
}

function shapeTags(shape) {
  return Object.entries(shape?.meta ?? {})
    .filter(([key, value]) => key.startsWith('cowart') && value === true)
    .map(([key]) => key)
}

function round(value) {
  return Math.round(Number(value) || 0)
}

// Compact description of the canvas for the model, instead of the raw snapshot. invalid: the
// records tldraw's validation skips ({ id, typeName, type, reason }): a canvas page never shows
// them and the next save drops them, so they are listed apart rather than as shapes.
export function summarizeCanvas({ snapshot, viewState, canvasDir, storage, invalid = [] }) {
  const store = snapshot?.store ?? {}
  const children = childrenByParent(store)
  const invalidById = new Map(invalid.filter((record) => typeof record?.id === 'string').map((record) => [record.id, record]))
  // 标注 arrows are bound to the card their tip points at (arrow binding, end terminal).
  const annotated = new Map(
    Object.values(store)
      .filter((record) => record?.typeName === 'binding' && record.type === 'arrow' && record.props?.terminal === 'end')
      .map((binding) => [binding.fromId, binding.toId])
  )
  const listed = new Set()
  const pages = pageRecords(snapshot).map((page) => {
    const onPage = shapesOnPage(snapshot, page.id)
    const shapes = onPage.filter((shape) => !invalidById.has(shape.id))
    const broken = onPage
      .filter((shape) => invalidById.has(shape.id))
      .map((shape) => ({ id: shape.id, type: shape.type ?? null, reason: invalidById.get(shape.id).reason ?? '' }))
    for (const shape of onPage) listed.add(shape.id)
    return {
      id: page.id,
      name: page.name,
      shapeCount: shapes.length,
      ...(broken.length > 0 ? { invalid: broken } : {}),
      shapes: shapes.slice(0, MAX_SHAPES_PER_PAGE).map((shape) => {
        const bounds = pageBounds(store, shape, children)
        const asset = typeof shape.props?.assetId === 'string' ? store[shape.props.assetId] : null
        const summary = {
          id: shape.id,
          type: shape.type,
          x: round(bounds.x),
          y: round(bounds.y),
          w: round(bounds.w),
          h: round(bounds.h)
        }
        const text = shapeText(shape)
        if (text) summary.text = text.length > 120 ? `${text.slice(0, 120)}…` : text
        if (shape.type === 'frame' && typeof shape.props?.name === 'string' && shape.props.name.trim()) summary.name = shape.props.name.trim()
        const contained = (children.get(shape.id) ?? []).filter((child) => !invalidById.has(child.id)).length
        if (contained > 0) summary.children = contained
        if (shape.parentId !== page.id) summary.parentId = shape.parentId
        const tags = shapeTags(shape)
        if (tags.length) summary.tags = tags
        if (shape.meta?.cowartAnnotationArrow === true && annotated.has(shape.id)) {
          summary.annotates = annotated.get(shape.id)
          if (shape.meta.cowartAnnotationNote === true) summary.note = true
        }
        if (asset) {
          const src = asset.props?.src
          summary.asset = {
            id: asset.id,
            type: asset.type,
            name: asset.props?.name ?? null,
            localPath: localPathForAssetSrc(canvasDir, src) ?? (typeof src === 'string' && src.startsWith('data:') ? '(inline data)' : src ?? null)
          }
        }
        return summary
      })
    }
  })

  // Invalid records on no page (bindings, assets, shapes whose parent is gone).
  const invalidElsewhere = [...invalidById.values()]
    .filter((record) => !listed.has(record.id))
    .map((record) => ({ id: record.id, typeName: record.typeName ?? null, type: record.type ?? null, reason: record.reason ?? '' }))

  return {
    canvasDir,
    storage,
    currentPageId: viewState?.currentPageId ?? pages[0]?.id ?? null,
    pages,
    ...(invalidElsewhere.length > 0 ? { invalidRecords: invalidElsewhere } : {})
  }
}

export function formatCanvasSummary(summary) {
  const lines = [
    `Cowart 画布：${summary.canvasDir}（${summary.storage}）`,
    `当前页面：${summary.currentPageId ?? '（无）'}`,
    '位置是图形在页面上的左上角 (x, y) 和宽×高；父级是它所在的分组框。'
  ]
  if (summary.pages.length === 0) lines.push('画布还是空的。')
  for (const page of summary.pages) {
    lines.push('', `页面「${page.name}」(${page.id})：${page.shapeCount} 个图形`)
    for (const shape of page.shapes) {
      let line = `- ${shape.id} ${shape.type} (${shape.x}, ${shape.y}) ${shape.w}×${shape.h}`
      if (shape.name) line += ` 标题「${shape.name.replace(/\s+/g, ' ')}」`
      if (shape.text) line += ` 「${shape.text.replace(/\s+/g, ' ')}」`
      if (shape.children) line += ` 内含 ${shape.children} 个图形`
      if (shape.asset) line += ` 素材 ${shape.asset.name ?? shape.asset.id} → ${shape.asset.localPath}`
      if (shape.tags) line += ` [${shape.tags.join(', ')}]`
      if (shape.annotates) line += ` ${shape.note ? '注释（常驻说明）' : '标注（修改要求）'} → ${shape.annotates}`
      if (shape.parentId) line += ` 父级 ${shape.parentId}`
      lines.push(line)
    }
    if (page.shapeCount > page.shapes.length) lines.push(`- ……另有 ${page.shapeCount - page.shapes.length} 个图形未列出`)
    for (const record of page.invalid ?? []) {
      lines.push(`- ⚠ ${record.id} ${record.type ?? ''} 是无效记录：画布页面显示不了，下次保存就会被丢掉（${record.reason}）。别把它当成画布上有的东西`)
    }
  }
  if (summary.invalidRecords?.length > 0) {
    lines.push('', `⚠ 另有 ${summary.invalidRecords.length} 条无效记录，页面显示不了、下次保存会被丢掉：`)
    for (const record of summary.invalidRecords) lines.push(`- ${record.id} ${record.type ?? record.typeName ?? ''}（${record.reason}）`)
  }
  return lines.join('\n')
}
