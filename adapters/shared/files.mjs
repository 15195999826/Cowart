// File helpers shared by the host adapters.
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac']
])

export function sanitizeFileName(name, fallbackExtension) {
  const raw = basename(String(name || 'file'))
  const extension = extname(raw) || fallbackExtension
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'file'}${extension}`
}

export async function uniqueFilePath(dir, fileName) {
  const extension = extname(fileName)
  const base = fileName.slice(0, fileName.length - extension.length)
  for (let counter = 1; ; counter += 1) {
    const candidate = counter === 1 ? fileName : `${base}-v${counter}${extension}`
    try {
      await stat(join(dir, candidate))
    } catch (error) {
      if (error.code === 'ENOENT') return { fileName: candidate, filePath: join(dir, candidate) }
      throw error
    }
  }
}

// Decodes a material the page uploaded as a data: URL.
export function parseMediaDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl))
  if (!match) throw new Error('上传的素材格式不对。')
  const mimeType = match[1].toLowerCase()
  const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
  const kind = mimeType.startsWith('image/') ? 'images' : mimeType.startsWith('video/') ? 'videos' : mimeType.startsWith('audio/') ? 'audios' : null
  if (!kind) throw new Error(`不支持的素材类型：${mimeType}`)
  return { mimeType, buffer, kind }
}
