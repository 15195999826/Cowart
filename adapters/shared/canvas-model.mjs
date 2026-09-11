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

// Compact description of the canvas for the model, instead of the raw snapshot.
export function summarizeCanvas({ snapshot, viewState, canvasDir, storage }) {
  const store = snapshot?.store ?? {}
  // 标注 arrows are bound to the card their tip points at (arrow binding, end terminal).
  const annotated = new Map(
    Object.values(store)
      .filter((record) => record?.typeName === 'binding' && record.type === 'arrow' && record.props?.terminal === 'end')
      .map((binding) => [binding.fromId, binding.toId])
  )
  const pages = pageRecords(snapshot).map((page) => {
    const shapes = shapesOnPage(snapshot, page.id)
    return {
      id: page.id,
      name: page.name,
      shapeCount: shapes.length,
      shapes: shapes.slice(0, MAX_SHAPES_PER_PAGE).map((shape) => {
        const bounds = shapeBounds(store, shape)
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

  return {
    canvasDir,
    storage,
    currentPageId: viewState?.currentPageId ?? pages[0]?.id ?? null,
    pages
  }
}

export function formatCanvasSummary(summary) {
  const lines = [`Cowart 画布：${summary.canvasDir}（${summary.storage}）`, `当前页面：${summary.currentPageId ?? '（无）'}`]
  if (summary.pages.length === 0) lines.push('画布还是空的。')
  for (const page of summary.pages) {
    lines.push('', `页面「${page.name}」(${page.id})：${page.shapeCount} 个图形`)
    for (const shape of page.shapes) {
      let line = `- ${shape.id} ${shape.type} (${shape.x}, ${shape.y}) ${shape.w}×${shape.h}`
      if (shape.text) line += ` 「${shape.text.replace(/\s+/g, ' ')}」`
      if (shape.asset) line += ` 素材 ${shape.asset.name ?? shape.asset.id} → ${shape.asset.localPath}`
      if (shape.tags) line += ` [${shape.tags.join(', ')}]`
      if (shape.annotates) line += ` ${shape.note ? '注释（常驻说明）' : '标注（修改要求）'} → ${shape.annotates}`
      if (shape.parentId) line += ` 父级 ${shape.parentId}`
      lines.push(line)
    }
    if (page.shapeCount > page.shapes.length) lines.push(`- ……另有 ${page.shapeCount - page.shapes.length} 个图形未列出`)
  }
  return lines.join('\n')
}
