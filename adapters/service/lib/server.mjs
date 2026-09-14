// HTTP side of the canvas service (127.0.0.1, one per machine). It serves the machine's one
// canvas to the Browser pane, relays page tool calls, serves page assets (videos need real URLs
// with range support), tracks the sessions whose bridges are connected, routes each canvas
// request to the session responsible for its page and streams it to that session's
// listener, starts the AI 图片 / AI 视频 generation it runs itself (generation-jobs.mjs), and
// tells every page who is responsible for which page (presence.mjs).
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'

import { resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { localPathForAssetSrc } from '../../shared/canvas-model.mjs'
import { readFileHead, sniffMediaType } from '../../shared/video.mjs'
import { INSERT_VIDEO_TOOL, PAGE_WRITE_TOOLS, textResult } from './canvas-ops.mjs'
import { Presence } from './presence.mjs'
import { FINAL_STATUSES, publicRequest } from './requests.mjs'

// Pages served here are the Claude Code canvas; Codex shows upstream's MCP Apps widget.
const PAGE_HOST = 'claude'
const MAX_BODY_BYTES = 128 * 1024 * 1024
const HEARTBEAT_MS = 20_000
const RECENT_FINAL_MS = 60_000
const RECONNECT_MS = 1_500
// A bridge that drops and comes back within this time (a restarted MCP server) keeps its session.
const BRIDGE_GRACE_MS = Number(process.env.COWART_SESSION_GRACE_MS) || 5_000
// A page or listener whose session has no bridge yet (say after a service restart) waits this long.
const SESSION_WAIT_MS = Number(process.env.COWART_SESSION_WAIT_MS) || 15_000
// A page that reconnects within this time keeps its place.
const PANE_GRACE_MS = 5_000
const MESSAGE_KINDS = new Set(['canvas', 'image', 'video', 'web'])
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,96}$/

const CONTENT_TYPES = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm']
])

// Blocks every external origin (upstream's Google Analytics included) while keeping the
// single-file widget, blob/data assets and HTML draft iframes working.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path)
}

function tokensMatch(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('请求体太大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

async function readJsonBody(req) {
  const body = await readBody(req)
  return body ? JSON.parse(body) : {}
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(`retry: ${RECONNECT_MS}\n: connected\n\n`)
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS)
  req.on('close', () => clearInterval(heartbeat))
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function endStream(res, event, data) {
  try {
    sendEvent(res, event, data)
    res.end()
  } catch {
    // Already gone.
  }
}

export function agentEventPayload(request) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    projectDir: request.projectDir,
    page: request.pageName ?? null
  }
}

export class CanvasServer {
  #server = null
  #port = null
  #startedAt = new Date().toISOString()
  #closing = false
  // Session id → { id, host, cwd, bridge, listener, pages, state, lastCanvas, timer }.
  // state: waiting (no bridge yet) → online (bridge connected) → ended (bridge gone).
  #sessions = new Map()
  // Page event streams: res → { session, pane, canvasDir }.
  #pageStreams = new Map()
  #paneTimers = new Map()
  // Where the last «打开 Cowart 画布» pointed (path and query), for a bare address.
  #lastOpenedUrl = null

  // canvasDir: the machine's one canvas (SHARED_CANVAS_DIR), the only one this serves.
  constructor({ token, identity, canvasDir, queue, ops, jobs, renderPage, log, onActivity, onShutdownRequest, presence }) {
    this.token = token
    this.identity = identity
    this.canvasDir = canvasDir
    this.queue = queue
    this.ops = ops
    this.jobs = jobs ?? null
    this.renderPage = renderPage
    this.log = log ?? (() => {})
    this.onActivity = onActivity ?? (() => {})
    this.onShutdownRequest = onShutdownRequest ?? (() => {})
    this.presence = presence ?? new Presence({ canvasDir })

    queue.on('created', (request) => this.#deliver(request))
    // Every page showing the canvas follows its requests, whichever session they went to.
    queue.on('changed', (request) => this.#broadcastCanvas(request.canvasDir, 'request', publicRequest(request)))
    queue.on('cancelled', (request) => this.#deliverCancel(request))
    this.presence.on('changed', (canvasDir) => this.#broadcastCanvas(canvasDir, 'page-state', this.presence.view(canvasDir)))
    ops.on('pages-deleted', ({ canvasDir, pageIds }) => {
      this.presence.releasePages(canvasDir, pageIds)
      this.#broadcastCanvas(canvasDir, 'pages-deleted', { pageIds })
    })
    // Sessions that held pages when the service last ran: their bridges reconnect within
    // moments, or they end and their pages are released.
    for (const id of this.presence.sessionsWithPages()) this.#session(id)
  }

  get port() {
    return this.#port
  }

  get origin() {
    return `http://127.0.0.1:${this.#port}`
  }

  get bridgeCount() {
    return [...this.#sessions.values()].filter((session) => session.bridge).length
  }

  get pageCount() {
    return this.#pageStreams.size
  }

  // Binds exactly this port: the port is the machine-wide lock, and the bridges choose it.
  async start({ port }) {
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.log(`request failed: ${error.stack || error}`)
        if (!res.headersSent) sendJson(res, 500, { error: error.message })
        else res.end()
      })
    })
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    this.#server = server
    this.#port = port
    return this
  }

  async close({ reason = 'stopping' } = {}) {
    this.#closing = true
    const streams = [...this.#pageStreams.keys()]
    for (const session of this.#sessions.values()) {
      clearTimeout(session.timer)
      if (session.bridge) streams.push(session.bridge)
      if (session.listener) streams.push(session.listener)
    }
    for (const timer of this.#paneTimers.values()) clearTimeout(timer)
    for (const res of streams) endStream(res, 'stopping', { reason })
    if (!this.#server) return
    const closed = new Promise((resolveClose) => this.#server.close(() => resolveClose()))
    this.#server.closeAllConnections?.()
    await closed
    this.#server = null
  }

  status() {
    return {
      ...this.identity,
      pid: process.pid,
      port: this.#port,
      canvasDir: this.canvasDir,
      startedAt: this.#startedAt,
      pages: this.#pageStreams.size,
      generations: this.jobs?.running ?? 0,
      sessions: [...this.#sessions.values()].map((session) => ({
        id: session.id,
        name: this.presence.nameOf(session.id),
        host: session.host,
        state: session.state,
        bridge: Boolean(session.bridge),
        listener: Boolean(session.listener),
        pages: session.pages.size,
        canvasDir: session.lastCanvas?.canvasDir ?? null,
        page: this.presence.pageOf(session.id)
      }))
    }
  }

  #isAllowedHost(host) {
    return [`127.0.0.1:${this.#port}`, `localhost:${this.#port}`, `[::1]:${this.#port}`].includes(host)
  }

  #isAuthorized(req, url) {
    return tokensMatch(this.token, req.headers['x-cowart-token'] || url.searchParams.get('token'))
  }

  async #handle(req, res) {
    if (!this.#isAllowedHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden host')
      return
    }
    const url = new URL(req.url, this.origin)

    if (req.method === 'GET' && url.pathname === '/') return this.#servePage(res, url)
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: this.identity.service, protocol: this.identity.protocol, version: this.identity.version })
    }
    if (req.method === 'GET' && (url.pathname.startsWith('/page-assets/') || url.pathname.startsWith('/assets/'))) {
      return this.#serveAsset(req, res, url)
    }
    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' })
    if (!this.#isAuthorized(req, url)) {
      return sendJson(res, 403, { error: 'Cowart 本地服务令牌无效：回到 Claude Code 重新打开画布。' })
    }

    // Bridges: who is running here, stop it, stay connected as a session, call canvas operations.
    if (req.method === 'GET' && url.pathname === '/api/service') return sendJson(res, 200, this.status())
    if (req.method === 'POST' && url.pathname === '/api/service/shutdown') {
      const { reason } = await readJsonBody(req)
      sendJson(res, 200, { ok: true })
      setImmediate(() => this.onShutdownRequest(String(reason || 'requested')))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/bridge/session') return this.#openBridgeStream(req, res, url)
    if (req.method === 'POST' && url.pathname === '/api/bridge/call') {
      const { session: id, cwd, op, args } = await readJsonBody(req)
      if (!validId(id)) return sendJson(res, 400, { error: '缺少会话标识。' })
      try {
        const result = await this.#bridgeCall(this.#session(id), { cwd, op, args: args && typeof args === 'object' ? args : {} })
        return sendJson(res, 200, { result })
      } catch (error) {
        return sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    // Canvas pages.
    if (req.method === 'POST' && url.pathname === '/api/tools/call') {
      const { name, arguments: args } = await readJsonBody(req)
      const pane = this.#paneContext(req.headers['x-cowart-pane'])
      return sendJson(res, 200, await this.ops.callFromPage(String(name || ''), this.#oneCanvas(args && typeof args === 'object' ? args : {}), { host: PAGE_HOST, pane }))
    }
    // The page says which page it shows (a default for its session's writes, nothing more).
    if (req.method === 'POST' && url.pathname === '/api/panes/page') {
      const { pane, pageId, pageName } = await readJsonBody(req)
      if (!this.presence.pane(pane)) return sendJson(res, 409, { error: '画布页面还没连上画布服务。' })
      this.presence.setPanePage(pane, { pageId: nonEmpty(pageId), pageName: nonEmpty(pageName) })
      return sendJson(res, 200, { ok: true })
    }
    // The page's button: this pane's session takes the page the pane shows.
    if (req.method === 'POST' && url.pathname === '/api/pages/enter') {
      const { pane } = await readJsonBody(req)
      const entry = this.presence.pane(pane)
      if (!entry?.pageId) return sendJson(res, 409, { error: '画布页面还没连上画布服务。' })
      const session = this.#sessions.get(entry.session)
      if (!session || session.state === 'ended') {
        return sendJson(res, 409, { error: '这个面板的会话已经结束了：在某个会话里说「打开 Cowart 画布 ' + (entry.pageName ?? '<页名>') + '」让它负责这一页。' })
      }
      const { previous } = this.presence.enter(entry.session, entry.canvasDir, entry.pageId)
      return sendJson(res, 200, { ok: true, pageId: entry.pageId, previous: previous && previous !== entry.session ? this.#nameOf(previous) : null })
    }
    // The AI 图片 / AI 视频 panels: the canvas service generates on the click. Without the
    // beast command line the page sends the request to Claude instead (fallback).
    if (req.method === 'POST' && url.pathname === '/api/generations') {
      const body = await readJsonBody(req)
      const available = this.jobs ? this.jobs.availability() : { ok: false, reason: '画布服务不能直接生成。' }
      if (!available.ok) return sendJson(res, 409, { error: available.reason, fallback: true })
      try {
        const request = await this.jobs.start({ args: this.#oneCanvas(body && typeof body === 'object' ? body : {}), host: PAGE_HOST })
        return sendJson(res, 200, { ok: true, request: publicRequest(request) })
      } catch (error) {
        return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error), fallback: Boolean(error?.fallback) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const body = await readJsonBody(req)
      if (!String(body.text || '').trim()) return sendJson(res, 400, { error: '请求内容为空。' })
      if (!validId(body.session)) {
        return sendJson(res, 409, { error: '这个画布页面是旧版本打开的：回到 Claude Code 重新打开画布。' })
      }
      let target
      try {
        target = this.#routeRequest(body)
      } catch (error) {
        return sendJson(res, 409, { error: error.message })
      }
      // The shared AI 图片 / AI 视频 panels tag their messages with the kind and holder.
      const kind = MESSAGE_KINDS.has(body.kind) ? body.kind : 'canvas'
      const holderShapeId = kind !== 'canvas' && typeof body.holderShapeId === 'string' ? body.holderShapeId : null
      const request = this.queue.create({
        text: body.text,
        kind,
        session: target,
        projectDir: body.projectDir,
        canvasDir: this.canvasDir,
        pageId: nonEmpty(body.pageId),
        pageName: nonEmpty(body.pageName),
        holderShapeId
      })
      return sendJson(res, 200, { ok: true, request: publicRequest(request) })
    }
    // The canvas withdraws a request Claude has not started on, or a generation before its
    // result goes in (from any page of the canvas).
    if (req.method === 'POST' && url.pathname === '/api/requests/cancel') {
      const { id } = await readJsonBody(req)
      try {
        const request = this.queue.get(id)
        const cancelled = request?.executor === 'service' && this.jobs ? this.jobs.cancel(id) : this.queue.cancel(id)
        return sendJson(res, 200, { ok: true, request: publicRequest(cancelled) })
      } catch (error) {
        return sendJson(res, 409, { error: error.message })
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/page-events') return this.#openPageStream(req, res, url)
    if (req.method === 'GET' && url.pathname === '/api/agent-events') return this.#openAgentStream(req, res, url)
    return sendJson(res, 404, { error: 'Not found' })
  }

  // A request from a page goes to the session responsible for that page. A page nobody is
  // responsible for goes to the session of the pane it was clicked in, which takes the page.
  #routeRequest(body) {
    const own = this.#session(body.session)
    const pageId = nonEmpty(body.pageId)
    if (!pageId) return own.id
    const canvasDir = this.canvasDir
    const holder = this.presence.holderOf(canvasDir, pageId)
    if (holder && this.#sessions.get(holder)?.state !== 'ended') return holder
    if (own.state === 'ended') {
      throw new Error(`这个面板的会话已经结束了：在某个会话里说「打开 Cowart 画布 ${nonEmpty(body.pageName) ?? '<页名>'}」让它负责这一页，再点。`)
    }
    this.presence.enter(own.id, canvasDir, pageId)
    return own.id
  }

  // Which session a page's tool calls belong to. undefined: an older page that does not say
  // which pane it is. null: a pane the service does not know (yet).
  #paneContext(paneId) {
    if (typeof paneId !== 'string' || !paneId) return undefined
    const entry = this.presence.pane(paneId)
    return entry ? { session: entry.session } : null
  }

  // ---- Sessions ----------------------------------------------------------------------

  #session(id) {
    let session = this.#sessions.get(id)
    if (!session) {
      session = { id, host: null, cwd: null, bridge: null, listener: null, pages: new Set(), state: 'waiting', lastCanvas: null, timer: null }
      this.#sessions.set(id, session)
      this.#armEnd(session, SESSION_WAIT_MS)
    }
    return session
  }

  #armEnd(session, ms) {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => this.#endSession(session), ms)
  }

  // The session's pages learn it is gone, unanswered requests wait for it to come back, and
  // the page it was responsible for is free again.
  #endSession(session) {
    session.timer = null
    if (session.bridge || session.state === 'ended' || this.#closing) return
    session.state = 'ended'
    this.queue.resetDelivery(session.id)
    this.presence.release(session.id)
    if (session.listener) {
      endStream(session.listener, 'session-ended', {})
      session.listener = null
    }
    this.#broadcastPresence(session)
    this.log(`session ${session.id} ended`)
  }

  // One bridge per session: a newer one (a restarted MCP server) replaces the previous one.
  #openBridgeStream(req, res, url) {
    const id = url.searchParams.get('session')
    if (!validId(id)) return sendJson(res, 400, { error: '缺少会话标识。' })
    const session = this.#session(id)
    if (session.bridge) endStream(session.bridge, 'replaced', {})

    openEventStream(req, res)
    session.bridge = res
    session.host = url.searchParams.get('host') || session.host
    session.cwd = nonEmpty(url.searchParams.get('cwd')) ?? session.cwd
    clearTimeout(session.timer)
    session.timer = null
    const resumed = session.state === 'ended'
    session.state = 'online'
    sendEvent(res, 'hello', this.identity)
    req.on('close', () => {
      if (session.bridge !== res) return
      session.bridge = null
      if (!this.#closing) this.#armEnd(session, BRIDGE_GRACE_MS)
      this.onActivity()
    })
    this.log(`session ${id} ${resumed ? 'resumed' : 'connected'} (${session.host ?? 'unknown host'})`)
    this.#broadcastPresence(session)
    this.#deliverPending(session)
    this.onActivity()
  }

  // One listener per session: a newer Monitor replaces the previous one so requests are
  // never announced twice.
  #openAgentStream(req, res, url) {
    const id = url.searchParams.get('session')
    if (!validId(id)) {
      return sendJson(res, 400, { error: '监听命令缺少 --session：回到 Claude Code 重新打开画布，用新给的监听命令。' })
    }
    const session = this.#session(id)
    if (session.listener) endStream(session.listener, 'replaced', {})

    openEventStream(req, res)
    session.listener = res
    req.on('close', () => {
      if (session.listener !== res) return
      session.listener = null
      this.#broadcastPresence(session)
    })
    this.#broadcastPresence(session)
    this.#deliverPending(session)
  }

  #openPageStream(req, res, url) {
    const id = url.searchParams.get('session')
    const session = validId(id) ? this.#session(id) : null
    const pane = validId(url.searchParams.get('pane')) ? url.searchParams.get('pane') : null
    // Whatever canvas the page's URL names (older pages name their project's), it shows this one.
    const canvasDir = this.canvasDir
    openEventStream(req, res)
    this.#pageStreams.set(res, { session: session?.id ?? null, pane, canvasDir })
    session?.pages.add(res)
    if (pane && session && canvasDir) {
      clearTimeout(this.#paneTimers.get(pane))
      this.#paneTimers.delete(pane)
      this.presence.openPane({ pane, session: session.id, canvasDir })
    }
    req.on('close', () => {
      this.#pageStreams.delete(res)
      session?.pages.delete(res)
      if (pane && !this.#closing) {
        clearTimeout(this.#paneTimers.get(pane))
        this.#paneTimers.set(
          pane,
          setTimeout(() => {
            this.#paneTimers.delete(pane)
            this.presence.closePane(pane)
          }, PANE_GRACE_MS)
        )
      }
      this.onActivity()
    })

    const now = Date.now()
    const recent = canvasDir
      ? this.queue
          .list()
          .filter((request) => request.canvasDir === canvasDir)
          .filter((request) => !FINAL_STATUSES.has(request.status) || now - Date.parse(request.updatedAt) < RECENT_FINAL_MS)
          .map(publicRequest)
      : []
    sendEvent(res, 'hello', { protocol: this.identity.protocol, build: this.identity.build })
    sendEvent(res, 'presence', this.#presence(session))
    sendEvent(res, 'requests', { requests: recent })
    if (canvasDir) sendEvent(res, 'page-state', this.presence.view(canvasDir))
    this.onActivity()
  }

  #presence(session) {
    if (!session) return { session: 'ended', agentOnline: false }
    return { session: session.state, agentOnline: session.state === 'online' && Boolean(session.listener) }
  }

  #deliver(request) {
    if (request.executor === 'service') return
    const stream = this.#sessions.get(request.session)?.listener
    if (!stream || request.delivered) return
    sendEvent(stream, 'request', agentEventPayload(request))
    this.queue.markDelivered(request.id)
  }

  #deliverPending(session) {
    if (!session.listener) return
    for (const request of this.queue.undelivered(session.id)) this.#deliver(request)
  }

  // Claude only needs to hear about a withdrawal if it was told about the request.
  #deliverCancel(request) {
    if (request.executor === 'service') return
    const stream = this.#sessions.get(request.session)?.listener
    if (stream && request.delivered) sendEvent(stream, 'cancelled', agentEventPayload(request))
  }

  #broadcastPresence(session) {
    for (const res of session.pages) sendEvent(res, 'presence', this.#presence(session))
  }

  #broadcastCanvas(canvasDir, event, data) {
    for (const [res, stream] of this.#pageStreams) if (stream.canvasDir === canvasDir) sendEvent(res, event, data)
  }

  // ---- Bridge operations -------------------------------------------------------------

  // Every page and session works on the machine's one canvas: whatever canvasDir an older
  // page URL or a model call names is replaced by it.
  #oneCanvas(args) {
    return { ...args, canvasDir: this.canvasDir }
  }

  // Model tools: the one canvas, and projectDir saying which project the session works in.
  #withDefaults(session, args = {}) {
    return this.#oneCanvas({ ...args, projectDir: nonEmpty(args.projectDir) ?? session.cwd ?? undefined })
  }

  #ownRequest(session, id) {
    const request = this.queue.get(id)
    if (!request || request.session !== session.id) {
      throw new Error(`这个会话没有编号为 ${id} 的画布请求（请求只存在画布服务的内存里，服务重启后就没了）。`)
    }
    return request
  }

  async #bridgeCall(session, { cwd, op, args }) {
    session.cwd = nonEmpty(cwd) ?? session.cwd
    switch (op) {
      case 'model-tools':
        return { tools: await this.ops.modelTools() }
      case 'open-canvas':
        return this.#openCanvas(session, args)
      case 'canvas-state':
        return this.#canvasState(session, this.#withDefaults(session, args))
      case 'insert-video':
        return this.ops.insertVideo(await this.#pageWrite(session, INSERT_VIDEO_TOOL, this.#withDefaults(session, args)))
      case 'tool': {
        const name = String(args.name || '')
        let toolArgs = this.#withDefaults(session, args.arguments ?? {})
        if (PAGE_WRITE_TOOLS.has(name)) toolArgs = await this.#pageWrite(session, name, toolArgs)
        await this.ops.replaySelection(name, toolArgs, session.id)
        return this.ops.callForModel(name, toolArgs)
      }
      case 'request-get': {
        const request = this.#ownRequest(session, args.id)
        return { request: { ...publicRequest(request), text: request.text } }
      }
      case 'request-reply': {
        this.#ownRequest(session, args.id)
        return { request: publicRequest(this.queue.update(args.id, { status: args.status, message: args.message })) }
      }
      case 'request-list': {
        const requests = this.queue.list(session.id).filter((request) => args.includeFinished === true || !FINAL_STATUSES.has(request.status))
        return { requests: requests.map(publicRequest) }
      }
      default:
        throw new Error(`画布服务不认识操作 ${op}。`)
    }
  }

  #nameOf(session) {
    return this.presence.nameOf(session) ?? '另一个会话'
  }

  // Opens the canvas for the session and, with `page` (a name) or `shownPage` (the page the
  // session's pane shows), makes the session responsible for that page.
  async #openCanvas(session, args) {
    const target = resolveCowartPaths(this.#withDefaults(session, args))
    const sessionName = nonEmpty(args.sessionName) ? this.presence.setName(session.id, args.sessionName) : this.presence.ensureName(session.id)
    const title = nonEmpty(args.title) || 'Cowart Canvas'
    session.lastCanvas = { projectDir: target.projectDir, canvasDir: target.canvasDir }

    let entered = null
    let previous = null
    const wanted = nonEmpty(args.page)
    const paneOpen = [...this.#pageStreams.values()].some((stream) => stream.session === session.id && stream.canvasDir === target.canvasDir)
    if (wanted) {
      entered = await this.ops.ensurePage(target, wanted)
    } else if (args.shownPage === true) {
      const pane = this.presence.panesOf(session.id, target.canvasDir)[0]
      if (!pane) throw new Error('这个会话还没在 Browser 面板里打开这张画布，不知道是哪一页：说「打开 Cowart 画布 <页名>」，或先打开画布。')
      entered = { id: pane.pageId, name: pane.pageName ?? pane.pageId, created: false }
    }
    if (entered) {
      previous = this.presence.enter(session.id, target.canvasDir, entered.id).previous
      // «打开 Cowart 画布 X» while the session's canvas pane is open: the pane goes to X.
      for (const [res, stream] of this.#pageStreams) {
        if (stream.session === session.id && stream.canvasDir === target.canvasDir) sendEvent(res, 'goto-page', { pageId: entered.id })
      }
    }

    const pages = (await this.ops.canvasPages(target)).map((entry) => {
      const holder = this.presence.holderOf(target.canvasDir, entry.id)
      return { ...entry, holder: holder ? this.#nameOf(holder) : null, mine: holder === session.id }
    })
    // A page the session held that is gone (deleted, or on another canvas) is no responsibility.
    const held = this.presence.pageOf(session.id)
    if (held && held.canvasDir === target.canvasDir && !pages.some((entry) => entry.id === held.pageId)) this.presence.release(session.id)
    const myPage = pages.find((entry) => entry.mine) ?? null

    const query = new URLSearchParams({ session: session.id, projectDir: target.projectDir, canvasDir: target.canvasDir, title })
    if (entered) query.set('pageId', entered.id)
    this.#lastOpenedUrl = `/?${query}`
    return {
      url: `${this.origin}/?${query}`,
      port: this.#port,
      session: session.id,
      sessionName,
      projectDir: target.projectDir,
      canvasDir: target.canvasDir,
      page: entered ? entered.name : null,
      pageCreated: Boolean(entered?.created),
      takenFrom: previous && previous !== session.id ? this.#nameOf(previous) : null,
      myPage: myPage ? myPage.name : null,
      paneOpen,
      title,
      pages,
      listenerConnected: Boolean(session.listener)
    }
  }

  // A model write lands on one page: the one named in the call (or holding the shape it
  // names), else the page this session is responsible for, else the page its canvas pane
  // shows. A page another session is responsible for is refused, apart from results of
  // requests this session is handling on it.
  async #pageWrite(session, name, args) {
    const { canvasDir } = resolveCowartPaths(args)
    let pageId = await this.ops.targetPage(args)
    if (!pageId) {
      const held = this.presence.pageOf(session.id)
      pageId = held?.canvasDir === canvasDir ? held.pageId : (this.presence.panesOf(session.id, canvasDir)[0]?.pageId ?? null)
      if (pageId) args = { ...args, pageId }
    }
    if (!pageId) return args
    const holder = this.presence.holderOf(canvasDir, pageId)
    if (!holder || holder === session.id) return args
    const handling = this.queue.list(session.id).some((request) => request.pageId === pageId && !FINAL_STATUSES.has(request.status))
    if (handling) return args
    const pageName = (await this.ops.canvasPages(args)).find((page) => page.id === pageId)?.name ?? pageId
    throw new Error(
      `${name}：「${pageName}」这一页由「${this.#nameOf(holder)}」负责，这个会话不能往里放东西。要在这一页操作，请用户在这个会话里说「接管 ${pageName}」（或「打开 Cowart 画布 ${pageName}」）。`
    )
  }

  // The model's canvas summary also says who is responsible for which page.
  async #canvasState(session, args) {
    const result = await this.ops.canvasState(args)
    if (args.includeSnapshot === true || result?.isError) return result
    const { canvasDir } = resolveCowartPaths(args)
    const view = this.presence.view(canvasDir)
    const lines = Object.entries(view.pages).map(([pageId, page]) => {
      const name = (result.structuredContent?.pages ?? []).find((entry) => entry.id === pageId)?.name ?? pageId
      return `- ${name} → ${this.#nameOf(page.holder)}${page.holder === session.id ? '（本会话）' : ''}`
    })
    const mine = this.presence.pageOf(session.id)
    const summary = lines.length > 0 ? lines.join('\n') : '- 还没有会话负责任何一页'
    const own = mine?.canvasDir === canvasDir ? '' : '\n这个会话没负责这张画布的页：不带 pageId 的插入会放进它的画布面板正看着的页（没人负责的话）。'
    const text = `${result.content?.[0]?.text ?? ''}\n\n谁负责哪一页（别的会话负责的页不能往里放东西）：\n${summary}${own}`
    return textResult(text, { ...result.structuredContent, responsibilities: view })
  }

  // ---- Page and assets ---------------------------------------------------------------

  // The page opens on the page its session is responsible for (heldPageId), whatever the
  // URL says: the Browser pane's card reopens the address it was first given.
  async #servePage(res, url) {
    const session = url.searchParams.get('session')
    // A bare address (only the origin kept) shows the canvas opened last.
    if (!session && this.#lastOpenedUrl) {
      res.writeHead(302, { location: this.#lastOpenedUrl, 'cache-control': 'no-store' }).end()
      return
    }
    const held = validId(session) ? this.presence.pageOf(session) : null
    const html = await this.renderPage(url.searchParams, { heldPageId: held?.canvasDir === this.canvasDir ? held.pageId : null })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'referrer-policy': 'same-origin'
    })
    res.end(html)
  }

  // Media elements cannot send the token header, so assets (all from the one canvas) are
  // limited to same-origin requests.
  async #serveAsset(req, res, url) {
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403).end('Forbidden')
      return
    }

    const canvasDir = this.canvasDir
    const filePath = localPathForAssetSrc(canvasDir, url.pathname)
    if (!filePath || !isInside(canvasDir, resolve(filePath))) {
      res.writeHead(404).end('Not found')
      return
    }

    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch {
      res.writeHead(404).end('Not found')
      return
    }
    if (!fileStat.isFile()) {
      res.writeHead(404).end('Not found')
      return
    }

    const contentType =
      CONTENT_TYPES.get(extname(filePath).toLowerCase()) ||
      sniffMediaType(await readFileHead(filePath)) ||
      'application/octet-stream'
    const headers = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : fileStat.size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : fileStat.size - 1
      start = Math.max(0, start)
      end = Math.min(end, fileStat.size - 1)
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${fileStat.size}` }).end()
        return
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${fileStat.size}`, 'content-length': String(end - start + 1) })
      createReadStream(filePath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, { ...headers, 'content-length': String(fileStat.size) })
    createReadStream(filePath).pipe(res)
  }
}
