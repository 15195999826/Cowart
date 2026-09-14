// The native widget cannot fetch localhost URLs. Read video assets through its app
// tool in bounded chunks, leaving the persisted asset URL and tldraw cache unchanged.
import { open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { localPathForAssetSrc } from '../../shared/canvas-model.mjs'

const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }
const CHUNK_BYTES = 768 * 1024 // divisible by three, so base64 chunks concatenate
export async function readVideoAsset(args) {
  const file = localPathForAssetSrc(args.canvasDir, args.assetUrl)
  if (!file || !TYPES[extname(file).toLowerCase()]) return null
  const [root, target] = await Promise.all([realpath(args.canvasDir), realpath(file)])
  const within = relative(root, target)
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('视频路径不在画布素材目录内。')
  const offset = args.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('视频读取位置无效。')
  const handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(CHUNK_BYTES, Math.max(0, info.size - offset))
    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    return { assetUrl: args.assetUrl, mimeType: TYPES[extname(file).toLowerCase()], dataBase64: buffer.subarray(0, bytesRead).toString('base64'), totalBytes: info.size, nextOffset: offset + bytesRead < info.size ? offset + bytesRead : null }
  } finally { await handle.close() }
}
