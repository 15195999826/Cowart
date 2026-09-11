// In-memory queue of requests the canvas sends to Claude (the Codex host would
// receive them as ui/message chat turns instead).
import { EventEmitter } from 'node:events'

const MENTION = /^\s*\[@Cowart\]\([^)]*\)\s*/
const MAX_REQUESTS = 200
export const REQUEST_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped']
export const FINAL_STATUSES = new Set(['done', 'failed', 'skipped'])

export function requestTitle(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] ?? ''
  return firstLine.replace(MENTION, '').trim().slice(0, 40) || '画布请求'
}

export function requestSummary(text) {
  const prompt = /\nPrompt:\s*\n([\s\S]*)$/.exec(String(text))?.[1]?.trim().replace(/\s+/g, ' ')
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt
  const annotations = /Included annotation shapes:\s*(\d+)/.exec(String(text))?.[1]
  return annotations ? `${annotations} 条标注` : ''
}

export function publicRequest(request) {
  const { text: _text, ...rest } = request
  return rest
}

export class CanvasRequestQueue extends EventEmitter {
  #requests = new Map()
  #nextId = 1

  create({ text, kind = 'canvas', projectDir, canvasDir }) {
    const body = String(text ?? '').trim()
    const now = new Date().toISOString()
    const request = {
      id: this.#nextId++,
      kind,
      title: requestTitle(body),
      summary: requestSummary(body),
      text: body,
      projectDir,
      canvasDir,
      status: 'pending',
      message: '',
      delivered: false,
      createdAt: now,
      updatedAt: now
    }
    this.#requests.set(request.id, request)
    this.#trim()
    this.emit('created', request)
    this.emit('changed', request)
    return request
  }

  get(id) {
    return this.#requests.get(Number(id)) ?? null
  }

  list() {
    return [...this.#requests.values()]
  }

  undelivered() {
    return this.list().filter((request) => !request.delivered && request.status === 'pending')
  }

  markDelivered(id) {
    const request = this.get(id)
    if (!request || request.delivered) return
    request.delivered = true
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
  }

  update(id, { status, message }) {
    const request = this.get(id)
    if (!request) throw new Error(`没有编号为 ${id} 的画布请求。`)
    if (!REQUEST_STATUSES.includes(status)) throw new Error(`不支持的状态：${status}`)
    request.status = status
    if (typeof message === 'string') request.message = message.trim().slice(0, 500)
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
    return request
  }

  #trim() {
    while (this.#requests.size > MAX_REQUESTS) {
      const oldest = this.#requests.keys().next().value
      this.#requests.delete(oldest)
    }
  }
}
