// In-memory queue of requests from canvas pages. Most go to a Claude session (the Codex host
// receives them as ui/message chat turns instead): the one responsible for the page they came
// from. AI 图片 / AI 视频 ones the canvas service runs itself (executor "service",
// generation-jobs.mjs): they belong to no session and report their steps as they go. Ids
// are unique across sessions.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const MENTION = /^\s*\[@Cowart\]\([^)]*\)\s*/
const MAX_REQUESTS = 200
// "cancelled" is set from the canvas only (the user withdrew a request nobody had started, or
// a service job before its result went in); Claude reports running / done / failed / skipped.
export const REQUEST_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']
export const AGENT_STATUSES = ['running', 'done', 'failed', 'skipped']
export const FINAL_STATUSES = new Set(['done', 'failed', 'skipped', 'cancelled'])

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

  create({
    text,
    kind = 'canvas',
    session = null,
    executor = 'session',
    title,
    summary,
    projectDir,
    canvasDir,
    pageId = null,
    pageName = null,
    holderShapeId = null
  }) {
    const body = String(text ?? '').trim()
    const now = new Date().toISOString()
    const request = {
      id: this.#nextId++,
      requestKey: randomUUID(),
      session,
      executor,
      pageId,
      pageName,
      kind,
      title: title ?? requestTitle(body),
      summary: summary ?? requestSummary(body),
      text: body,
      projectDir,
      canvasDir,
      holderShapeId,
      status: 'pending',
      message: '',
      delivered: false,
      // A service job putting its result into the canvas can no longer be withdrawn.
      finishing: false,
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

  list(session) {
    const requests = [...this.#requests.values()]
    return session === undefined ? requests : requests.filter((request) => request.session === session)
  }

  undelivered(session) {
    return this.list(session).filter((request) => request.executor === 'session' && !request.delivered && request.status === 'pending')
  }

  markDelivered(id) {
    const request = this.get(id)
    if (!request || request.delivered) return
    request.delivered = true
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
  }

  // A session that went away hears about its unanswered requests again when it comes back.
  resetDelivery(session) {
    for (const request of this.list(session)) {
      if (request.status !== 'pending' || !request.delivered) continue
      request.delivered = false
      request.updatedAt = new Date().toISOString()
      this.emit('changed', request)
    }
  }

  // Claude reports on a request routed to its session.
  update(id, { status, message }) {
    const request = this.get(id)
    if (!request) throw new Error(`没有编号为 ${id} 的画布请求。`)
    if (request.executor === 'service') throw new Error(`画布请求 #${request.id} 由画布服务直接生成，不用 Claude 处理。`)
    if (!AGENT_STATUSES.includes(status)) throw new Error(`不支持的状态：${status}`)
    if (request.status === 'cancelled') throw new Error(`画布请求 #${request.id} 已经在画布上撤销了，不要再处理。`)
    if (FINAL_STATUSES.has(request.status)) {
      if (status === request.status) return request
      throw new Error(`画布请求 #${request.id} 已经结束（${request.status}），不要重复执行。`)
    }
    request.status = status
    if (typeof message === 'string') request.message = message.trim().slice(0, 500)
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
    return request
  }

  // A service job's current step; false once the request is over (withdrawn, say).
  setProgress(id, message, { finishing = false } = {}) {
    const request = this.get(id)
    if (!request || FINAL_STATUSES.has(request.status)) return false
    request.status = 'running'
    request.message = String(message ?? '').trim().slice(0, 200)
    if (finishing) request.finishing = true
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
    return true
  }

  finishService(id, status, message) {
    const request = this.get(id)
    if (!request || FINAL_STATUSES.has(request.status)) return null
    request.status = status
    request.message = String(message ?? '').trim().slice(0, 500)
    request.finishing = false
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
    return request
  }

  // The user withdraws a request from the canvas: before Claude starts on it, or a service
  // job before its result goes in.
  cancel(id) {
    const request = this.get(id)
    if (!request) throw new Error(`没有编号为 ${id} 的画布请求。`)
    const serviceRunning = request.executor === 'service' && request.status === 'running' && !request.finishing
    if (request.status !== 'pending' && !serviceRunning) {
      if (request.status === 'cancelled') throw new Error('这条请求已经撤销了。')
      if (request.executor === 'service') throw new Error(request.finishing ? '结果已经在放进画布了，撤销不了。' : '这条请求已经结束了。')
      throw new Error('Claude 已经开始处理这条请求，撤销不了了。')
    }
    request.status = 'cancelled'
    request.message = '在画布上撤销了'
    request.finishing = false
    request.updatedAt = new Date().toISOString()
    this.emit('changed', request)
    this.emit('cancelled', request)
    return request
  }

  #trim() {
    while (this.#requests.size > MAX_REQUESTS) {
      const oldest = this.#requests.keys().next().value
      this.#requests.delete(oldest)
    }
  }
}
