// 拷贝索引 (the canvas context menu): puts a reference to the selected shapes on the system
// clipboard — the page, the shape id, what the card is and the local file behind it — worded
// as the canvas summary words it for the model, so pasting it into a chat says exactly which
// card is meant. The page names shape ids only; the service reads them off the stored canvas
// and writes the clipboard on the user's machine, so Claude Code, ZCode and Codex pages all
// get it (a canvas page in an MCP Apps iframe may not be allowed to write the clipboard).
import { spawn } from 'node:child_process'

import { localPathForAssetSrc, pageIdOfShape, pageRecords, shapeText } from '../../shared/canvas-model.mjs'

export const COPY_REFERENCE_TOOL = 'copy_cowart_reference'

const MAX_SHAPES = 40
const NAME_LIMIT = 60
const CLIPBOARD_TIMEOUT_MS = 10000

// What the user calls a card, ahead of its shape type (meta the canvas page sets).
const TAGGED_KINDS = [
  ['cowartAnnotationNote', '注释'],
  ['cowartAnnotationArrow', '标注'],
  ['cowartWebReference', '网页卡片'],
  ['cowartVideoFrame', '视频截帧'],
  ['cowartAiImageHolder', 'AI 图片占位框'],
  ['cowartAiVideoHolder', 'AI 视频占位框'],
  ['cowartAiDraftHolder', 'AI HTML 占位框']
]
const SHAPE_KINDS = new Map([
  ['image', '图片'],
  ['video', '视频'],
  ['embed', 'AI HTML'],
  ['frame', '分组框'],
  ['text', '文字'],
  ['note', '便签'],
  ['geo', '形状'],
  ['arrow', '箭头'],
  ['line', '线'],
  ['draw', '手绘'],
  ['highlight', '荧光笔'],
  ['bookmark', '书签']
])

export async function copyCanvasReference({ snapshot, canvasDir, shapeIds }) {
  const store = snapshot?.store ?? {}
  const ids = [...new Set((Array.isArray(shapeIds) ? shapeIds : []).map((id) => String(id)))].slice(0, MAX_SHAPES)
  if (ids.length === 0) throw new Error('没有选中要拷贝的图形。')
  const missing = ids.filter((id) => store[id]?.typeName !== 'shape')
  // A shape the page just drew is not on disk yet; the page saves before it asks.
  if (missing.length > 0) throw new Error(`画布上还没有这${missing.length > 1 ? '些' : '个'}图形：${missing.join('、')}`)

  const pageId = pageIdOfShape(store, store[ids[0]])
  const page = pageRecords(snapshot).find((record) => record.id === pageId) ?? null
  const items = ids.map((id) => describeShape(store, canvasDir, store[id]))
  const text = formatReference(page, items)
  await writeTextToClipboard(text)
  return { text, pageId: pageId ?? null, pageName: page?.name ?? null, items }
}

function describeShape(store, canvasDir, shape) {
  const asset = typeof shape.props?.assetId === 'string' ? store[shape.props.assetId] : null
  const src = typeof asset?.props?.src === 'string' ? asset.props.src : htmlDraftSrc(shape)
  return {
    id: shape.id,
    type: shape.type ?? null,
    kind: kindOfShape(shape),
    name: nameOfShape(shape, asset),
    localPath: localPathForAssetSrc(canvasDir, src)
  }
}

// An AI HTML card keeps its file in meta; props.url is often the page inlined as a data: URL.
function htmlDraftSrc(shape) {
  const url = shape.meta?.cowartHtmlDraftAssetUrl
  return typeof url === 'string' ? url : null
}

function kindOfShape(shape) {
  for (const [flag, label] of TAGGED_KINDS) if (shape.meta?.[flag] === true) return label
  return SHAPE_KINDS.get(shape.type) ?? shape.type ?? '图形'
}

function nameOfShape(shape, asset) {
  const assetName = typeof asset?.props?.name === 'string' ? asset.props.name.trim() : ''
  if (assetName) return clip(assetName)
  const frameName = shape.type === 'frame' && typeof shape.props?.name === 'string' ? shape.props.name.trim() : ''
  if (frameName) return clip(frameName)
  const text = shapeText(shape).replace(/\s+/g, ' ')
  return text ? clip(text) : null
}

function clip(value) {
  return value.length > NAME_LIMIT ? `${value.slice(0, NAME_LIMIT)}…` : value
}

function referenceLine(item) {
  let line = `${item.id} ${item.kind}`
  if (item.name) line += `「${item.name}」`
  if (item.localPath) line += ` ${item.localPath}`
  return line
}

function formatReference(page, items) {
  const where = `Cowart 画布 页面「${page?.name ?? '？'}」`
  if (items.length === 1) return `${where} ${referenceLine(items[0])}`
  return [`${where}的 ${items.length} 个图形：`, ...items.map((item) => `- ${referenceLine(item)}`)].join('\n')
}

// ---- The system clipboard --------------------------------------------------------------
// Windows PowerShell 5.1 (every Windows has it) writes the clipboard from an STA thread; the
// text comes in through the environment, so nothing needs quoting. Mac and Linux take it on
// stdin — Wayland's wl-copy first, X11's xclip after it.
const WINDOWS_COPY_SCRIPT = 'Set-Clipboard -Value $env:COWART_CLIPBOARD_TEXT'

async function writeTextToClipboard(text) {
  // Checks look at the text without touching the user's clipboard.
  if (process.env.COWART_CLIPBOARD_DRY_RUN === '1') return
  if (process.platform === 'win32') {
    await runClipboard('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_COPY_SCRIPT, 'utf16le').toString('base64')], {
      env: { ...process.env, COWART_CLIPBOARD_TEXT: text.replace(/\n/g, '\r\n') }
    })
    return
  }
  if (process.platform === 'darwin') {
    await runClipboard('pbcopy', [], { stdin: text })
    return
  }
  try {
    await runClipboard('wl-copy', [], { stdin: text })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await runClipboard('xclip', ['-selection', 'clipboard'], { stdin: text })
  }
}

function runClipboard(command, args, { env = process.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: [stdin === null ? 'ignore' : 'pipe', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('系统剪贴板没有响应。'))
    }, CLIPBOARD_TIMEOUT_MS)
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      finish(Object.assign(new Error(error.code === 'ENOENT' ? `这台机器上没有 ${command}，拷不了剪贴板。` : `剪贴板写入失败：${error.message}`), { code: error.code }))
    })
    child.on('close', (code) => {
      finish(code === 0 ? null : new Error(`剪贴板写入失败${stderr.trim() ? `：${stderr.trim().split('\n')[0]}` : `（${command} 退出码 ${code}）`}`))
    })
    if (stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
  })
}
