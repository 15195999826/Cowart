// Video support that upstream Cowart does not have: probing files and planning
// where a tldraw `video` shape goes. Pure functions plus file probing; no host code.
import { execFile } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { promisify } from 'node:util'

import { generateKeyBetween } from 'fractional-indexing'

import { containSize, pageIdOfShape, pageRecords, shapeBounds, shapesOnPage } from './canvas-model.mjs'

const execFileAsync = promisify(execFile)

export const VIDEO_MIME_BY_EXTENSION = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm']
])

const DEFAULT_ASPECT = 16 / 9
const DEFAULT_WIDTH = 640
const MAX_PLACEMENT_ATTEMPTS = 30

// Identifies common media by magic bytes (used for upstream's extension-less `.bin` assets too).
export function sniffMediaType(head) {
  if (!head || head.length < 12) return null
  if (head.toString('latin1', 4, 8) === 'ftyp') {
    return head.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm'
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  const text = head.toString('utf8').trimStart().toLowerCase()
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'text/html'
  return null
}

export async function readFileHead(filePath, length = 64) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function videoMimeType(filePath) {
  const byExtension = VIDEO_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase())
  if (byExtension) return byExtension
  const sniffed = sniffMediaType(await readFileHead(filePath))
  return sniffed?.startsWith('video/') ? sniffed : null
}

// Walks MP4 boxes to the first track header (tkhd) with a non-zero size.
function mp4Dimensions(buffer) {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'])

  function walk(start, end) {
    let offset = start
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset)
      const type = buffer.toString('latin1', offset + 4, offset + 8)
      let header = 8
      if (size === 1) {
        if (offset + 16 > end) return null
        size = Number(buffer.readBigUInt64BE(offset + 8))
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) return null

      if (type === 'tkhd') {
        const boxEnd = offset + size
        const width = buffer.readUInt32BE(boxEnd - 8) / 65536
        const height = buffer.readUInt32BE(boxEnd - 4) / 65536
        if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) }
      } else if (containers.has(type)) {
        const found = walk(offset + header, offset + size)
        if (found) return found
      }
      offset += size
    }
    return null
  }

  try {
    return walk(0, buffer.length)
  } catch {
    return null
  }
}

async function ffprobeDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath],
      { timeout: 15_000, windowsHide: true }
    )
    const [width, height] = stdout.trim().split('x').map(Number)
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

export async function probeVideoFile(filePath) {
  const { size } = await stat(filePath)
  const mimeType = await videoMimeType(filePath)
  let dimensions = null
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    dimensions = mp4Dimensions(await readFile(filePath))
  }
  dimensions ??= await ffprobeDimensions(filePath)
  return { mimeType, fileSize: size, width: dimensions?.width ?? null, height: dimensions?.height ?? null }
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

// Decides page, size, position and z-index for a new video shape. x, y (page coordinates of
// its top left) put it exactly there; otherwise it goes beside the anchor (right, left, below,
// above) or right of the page's content, stepping past the shapes in the way.
export function planVideoPlacement({
  snapshot,
  viewState,
  pageId,
  anchorShapeId,
  placement = 'right',
  margin = 40,
  matchAnchor = true,
  displayWidth,
  displayHeight,
  videoWidth,
  videoHeight,
  x: givenX,
  y: givenY
}) {
  const store = snapshot?.store ?? {}
  const pages = pageRecords(snapshot)
  if (pages.length === 0) {
    throw new Error('画布里还没有页面：先在 Browser 面板里打开一次画布（会自动建页面），再插入视频。')
  }

  const anchor = anchorShapeId ? store[anchorShapeId] : null
  if (anchorShapeId && anchor?.typeName !== 'shape') throw new Error(`画布里找不到 anchorShapeId：${anchorShapeId}`)

  const currentPageId = viewState?.currentPageId && store[viewState.currentPageId] ? viewState.currentPageId : null
  const targetPageId = pageId || (anchor && pageIdOfShape(store, anchor)) || currentPageId || pages[0].id
  if (store[targetPageId]?.typeName !== 'page') throw new Error(`画布里找不到页面：${targetPageId}`)

  const aspect = positiveNumber(videoWidth) && positiveNumber(videoHeight) ? videoWidth / videoHeight : DEFAULT_ASPECT
  const anchorBounds = anchor ? shapeBounds(store, anchor) : null
  let w = positiveNumber(displayWidth)
  let h = positiveNumber(displayHeight)
  if (w && !h) h = w / aspect
  else if (h && !w) w = h * aspect
  else if (!w && !h && anchorBounds && matchAnchor !== false) {
    if (placement === 'below' || placement === 'above') {
      w = anchorBounds.w
      h = w / aspect
    } else {
      h = anchorBounds.h
      w = h * aspect
    }
  } else if (!w && !h) {
    w = Math.min(positiveNumber(videoWidth) ?? DEFAULT_WIDTH, DEFAULT_WIDTH)
    h = w / aspect
  }

  const others = shapesOnPage(snapshot, targetPageId)
    .filter((shape) => shape.id !== anchor?.id && store[shape.parentId]?.typeName === 'page')
    .map((shape) => shapeBounds(store, shape))

  let x
  let y
  if (anchorBounds) {
    if (placement === 'left') {
      x = anchorBounds.x - margin - w
      y = anchorBounds.y
    } else if (placement === 'below') {
      x = anchorBounds.x
      y = anchorBounds.y + anchorBounds.h + margin
    } else if (placement === 'above') {
      x = anchorBounds.x
      y = anchorBounds.y - margin - h
    } else {
      x = anchorBounds.x + anchorBounds.w + margin
      y = anchorBounds.y
    }
  } else if (others.length > 0) {
    x = Math.max(...others.map((b) => b.x + b.w)) + margin * 2
    y = Math.min(...others.map((b) => b.y))
  } else {
    x = 0
    y = 0
  }

  const exactX = typeof givenX === 'number' && Number.isFinite(givenX)
  const exactY = typeof givenY === 'number' && Number.isFinite(givenY)
  if (exactX) x = givenX
  if (exactY) y = givenY
  for (let attempt = 0; !exactX && !exactY && attempt < MAX_PLACEMENT_ATTEMPTS; attempt += 1) {
    const candidate = { x, y, w, h }
    const blocker = others.find((bounds) => overlaps(candidate, bounds))
    if (!blocker) break
    if (placement === 'below') y = blocker.y + blocker.h + margin
    else if (placement === 'above') y = blocker.y - margin - h
    else if (placement === 'left') x = blocker.x - margin - w
    else x = blocker.x + blocker.w + margin
  }

  const siblingIndexes = Object.values(store)
    .filter((record) => record?.typeName === 'shape' && record.parentId === targetPageId && typeof record.index === 'string')
    .map((record) => record.index)
    .sort()
  const index = generateKeyBetween(siblingIndexes.at(-1) ?? null, null)

  return {
    pageId: targetPageId,
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
    index
  }
}

// Fits a video inside an AI video holder (contain, centered) and takes over its z-index.
export function planVideoInHolder({ snapshot, holderShapeId, videoWidth, videoHeight }) {
  const store = snapshot?.store ?? {}
  const holder = store[holderShapeId]
  if (holder?.typeName !== 'shape') throw new Error(`画布里找不到 AI 视频框：${holderShapeId}`)
  const pageId = pageIdOfShape(store, holder)
  if (!pageId) throw new Error(`AI 视频框不在任何页面上：${holderShapeId}`)

  const bounds = shapeBounds(store, holder)
  const aspect = positiveNumber(videoWidth) && positiveNumber(videoHeight) ? videoWidth / videoHeight : bounds.w / bounds.h
  const { w, h } = containSize(bounds, aspect)

  let index = holder.index
  if (holder.parentId !== pageId || typeof index !== 'string') {
    const siblingIndexes = Object.values(store)
      .filter((record) => record?.typeName === 'shape' && record.parentId === pageId && typeof record.index === 'string')
      .map((record) => record.index)
      .sort()
    index = generateKeyBetween(siblingIndexes.at(-1) ?? null, null)
  }

  return {
    pageId,
    x: Math.round(bounds.x + (bounds.w - w) / 2),
    y: Math.round(bounds.y + (bounds.h - h) / 2),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
    index
  }
}

export function videoRecords({ assetId, shapeId, plan, fileName, assetUrl, mimeType, fileSize, videoWidth, videoHeight, altText = '', shapeMeta = {} }) {
  const asset = {
    id: assetId,
    typeName: 'asset',
    type: 'video',
    props: {
      w: positiveNumber(videoWidth) ?? plan.w,
      h: positiveNumber(videoHeight) ?? plan.h,
      name: fileName,
      isAnimated: true,
      mimeType: mimeType ?? null,
      src: assetUrl,
      fileSize: fileSize ?? -1
    },
    meta: {}
  }
  const shape = {
    id: shapeId,
    typeName: 'shape',
    type: 'video',
    x: plan.x,
    y: plan.y,
    rotation: 0,
    index: plan.index,
    parentId: plan.pageId,
    isLocked: false,
    opacity: 1,
    props: {
      w: plan.w,
      h: plan.h,
      time: 0,
      playing: true,
      autoplay: true,
      url: '',
      assetId,
      altText
    },
    meta: { ...shapeMeta, cowartVideo: true }
  }
  return { asset, shape }
}
