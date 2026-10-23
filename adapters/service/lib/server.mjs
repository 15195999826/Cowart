// HTTP side of the canvas service (127.0.0.1, one per machine). It serves the machine's one
// canvas to the Browser pane (at http://cowart.localhost, through the machine's front door), relays page tool calls, serves page assets (videos need real URLs
// with range support), tracks the sessions whose bridges are connected, routes each canvas
// request to the session responsible for its page and streams it to that session's
// listener, starts the AI 图片 / AI 视频 generation it runs itself (generation-jobs.mjs),
// tells every page who is responsible for which page (presence.mjs), and keeps the feedback
// users send about Cowart itself (feedback.mjs).
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

import { resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { formatCanvasSummary, localPathForAssetSrc } from '../../shared/canvas-model.mjs'
import { readFileHead, sniffMediaType } from '../../shared/video.mjs'
import { EDIT_TOOL_DEFINITIONS, EDIT_TOOLS } from './canvas-edit.mjs'
import { INSERT_VIDEO_TOOL, PAGE_WRITE_TOOLS, textResult } from './canvas-ops.mjs'
import { FEEDBACK_TOOL, FEEDBACK_TOOL_DEFINITION, FeedbackStore } from './feedback.mjs'
import { PAGE_ACTIVITY_FILE_NAME, PageActivity } from './page-activity.mjs'
import { MOVE_PAGES_TOOL, MOVE_PAGES_TOOL_DEFINITION } from './page-folders.mjs'
import { Presence } from './presence.mjs'
import { PAGE_HOSTNAME } from './identity.mjs'
import { FINAL_STATUSES, publicRequest } from './requests.mjs'

// What canvas pages (HTTP, with their event stream) ask the service for.
const PAGE_ACTIONS = new Set(['/api/tools/call', '/api/panes/page', '/api/pages/enter', '/api/generations', '/api/messages', '/api/requests/cancel'])
const MAX_BODY_BYTES = 128 * 1024 * 1024
const HEARTBEAT_MS = 20_000
const RECENT_FINAL_MS = 60_000
const RECONNECT_MS = 1_500
// A bridge that drops and comes back within this time (a restarted MCP server) keeps its session.
const BRIDGE_GRACE_MS = Number(process.env.COWART_SESSION_GRACE_MS) || 5_000
// A Claude session runs no bridge: it calls the cowart command (adapters/claude/bin/cowart.mjs)
// and runs the listener in the background, and the listener keeps it online. It goes on being
// online after the listener left to deliver a request (the session handles it, or waits for the
// user's answer) until it runs the listener again, at most this long ...
const BUSY_MS = Number(process.env.COWART_SESSION_BUSY_MS) || 12 * 60 * 60_000
// ... and this long after a listener that went without delivering anything (the session was
// closed, or its background task stopped) ...
const LISTENER_GONE_MS = Number(process.env.COWART_LISTENER_GONE_MS) || 2 * 60_000
// ... or, with no listener running, after its last command.
const LEASE_MS = Number(process.env.COWART_SESSION_LEASE_MS) || 30 * 60_000
// A page or listener whose session has no bridge yet (say after a service restart) waits this long.
const SESSION_WAIT_MS = Number(process.env.COWART_SESSION_WAIT_MS) || 15_000
// An ended session is forgotten this long after it ended, once nothing waits for it (#forgetEnded).
const ENDED_KEPT_MS = Number(process.env.COWART_ENDED_SESSION_KEPT_MS) || 60 * 60_000
// A page that reconnects within this time keeps its place.
const PANE_GRACE_MS = 5_000
// Pages hear when pages last changed (page-activity.mjs) at most this often.
const ACTIVITY_ANNOUNCE_MS = 3_000
const MESSAGE_KINDS = new Set(['canvas', 'image', 'video', 'web'])
// Model writes that put something new on a page: the session's own canvas panes bring it into
// view (#revealPut).
const PUT_TOOLS = new Set(['insert_cowart_image', 'insert_cowart_html_draft', 'insert_cowart_text', 'insert_cowart_frame'])
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,96}$/
// The session's latest canvas requests a feedback item keeps.
const FEEDBACK_REQUESTS = 10
// Names a request may come with: loopback only, so a DNS-rebinding page (its own name, resolved
// to 127.0.0.1) is turned away.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', PAGE_HOSTNAME])
// The most one range response carries. A video asks for `bytes=N-` and reads only as far as it
// buffers; the rest of the file kept that connection, and a browser opens six per host: five
// videos left the other cards and the page's own calls (saves too) waiting. A short answer ends,
// the connection goes back to the pool, and the video asks for the next part.
const MAX_RANGE_BYTES = 2 * 1024 * 1024

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

// The browser's copy is still the file (If-None-Match wins over If-Modified-Since).
function notModified(headers, etag, mtime) {
  const tags = headers['if-none-match']
  if (tags) return tags.trim() === '*' || tags.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
  const since = Date.parse(headers['if-modified-since'] || '')
  return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since
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
    annotations: request.annotations,
    projectDir: request.projectDir,
    page: request.pageName ?? null
  }
}

export class CanvasServer {
  #server = null
  #port = null
  // Where browsers reach cowart.localhost without naming this port (80 for the machine's
  // canvas): a front door there (Caddy) forwards the name here. #frontDoor: it did last time.
  #domainPort = 0
  #frontDoor = false
  #startedAt = new Date().toISOString()
  #closing = false
  // Session id → { id, host, cwd, bridge, listener, pages, state, endedAt, lastCanvas, timer,
  // cli, listenerKeeps, keepUntil, releasedPage }.
  // state: waiting (no bridge yet) → online (bridge connected) → ended (bridge gone) → forgotten.
  // A command session (cli) is online while its listener runs (listenerKeeps) and until
  // keepUntil after; the page it held when it ended (releasedPage) is its again when it comes
  // back, if nobody took it meanwhile.
  #sessions = new Map()
  // Listener streams that carried a request (or a withdrawal): a --once listener leaves after it.
  #deliveredOn = new WeakSet()
  // Page event streams: res → { session, pane, canvasDir }.
  #pageStreams = new Map()
  #paneTimers = new Map()
  // Where the last «打开 Cowart 画布» pointed (path and query), for a bare address.
  #lastOpenedUrl = null

  // canvasDir: the machine's one canvas (SHARED_CANVAS_DIR), the only one this serves.
  constructor({ token, identity, canvasDir, queue, ops, jobs, renderPage, log, onActivity, onShutdownRequest, presence, feedback, activity }) {
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
    this.feedback = feedback ?? new FeedbackStore()
    this.activity = activity ?? new PageActivity({ file: canvasDir ? join(canvasDir, PAGE_ACTIVITY_FILE_NAME) : null })

    queue.on('created', (request) => this.#deliver(request))
    // Every page showing the canvas follows its requests, whichever session they went to.
    queue.on('changed', (request) => this.#broadcastCanvas(request.canvasDir, 'request', publicRequest(request)))
    queue.on('cancelled', (request) => this.#deliverCancel(request))
    this.presence.on('changed', (canvasDir) => this.#broadcastCanvas(canvasDir, 'page-state', this.#pageState(canvasDir)))
    ops.on('pages-changed', ({ canvasDir, pageIds }) => {
      if (canvasDir === this.canvasDir) this.activity.touch(pageIds)
    })
    this.activity.on('changed', () => this.#announceActivity())
    ops.on('pages-deleted', ({ canvasDir, pageIds }) => {
      this.presence.releasePages(canvasDir, pageIds)
      if (canvasDir === this.canvasDir) this.activity.forget(pageIds)
      for (const session of this.#sessions.values()) {
        if (session.releasedPage?.canvasDir === canvasDir && pageIds.includes(session.releasedPage.pageId)) session.releasedPage = null
      }
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

  // Where the canvas pages open: http://cowart.localhost for the machine's canvas when the front
  // door forwards it here, cowart.localhost on this port when not; 127.0.0.1 for any other canvas.
  get pageOrigin() {
    if (!this.#domainPort) return this.origin
    const port = this.#frontDoor ? this.#domainPort : this.#port
    return `http://${PAGE_HOSTNAME}${port === 80 ? '' : `:${port}`}`
  }

  // Asks the front door for cowart.localhost and sees whether this service answers: not when
  // nothing listens there, when it forwards the name to another port, or to another program.
  async refreshPageOrigin() {
    if (!this.#domainPort) return this.origin
    const host = `${PAGE_HOSTNAME}${this.#domainPort === 80 ? '' : `:${this.#domainPort}`}`
    this.#frontDoor = await new Promise((resolveProbe) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.#domainPort, path: '/api/service', headers: { host, 'x-cowart-token': this.token }, timeout: 1000 },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            try {
              resolveProbe(res.statusCode === 200 && JSON.parse(body).pid === process.pid)
            } catch {
              resolveProbe(false)
            }
          })
        }
      )
      req.on('timeout', () => req.destroy())
      req.on('error', () => resolveProbe(false))
    })
    return this.pageOrigin
  }

  // Sessions that use the service now (bridges, and command sessions while they are online).
  get sessionCount() {
    return [...this.#sessions.values()].filter((session) => session.bridge || session.state === 'online').length
  }

  get pageCount() {
    return this.#pageStreams.size
  }

  // Binds exactly this port: the port is the machine-wide lock, and the bridges choose it.
  // domainPort (80) is the front door's, never bound here: it serves every *.localhost name.
  async start({ port, domainPort = 0 }) {
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
    this.#port = server.address().port
    this.#domainPort = domainPort
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
    clearTimeout(this.#activityTimer)
    this.activity.save()
    for (const res of streams) endStream(res, 'stopping', { reason })
    if (!this.#server) return
    const closed = new Promise((resolveClose) => this.#server.close(() => resolveClose()))
    this.#server.closeAllConnections?.()
    await closed
    this.#server = null
  }

  status() {
    this.#forgetEnded()
    return {
      ...this.identity,
      pid: process.pid,
      port: this.#port,
      address: this.pageOrigin,
      canvasDir: this.canvasDir,
      startedAt: this.#startedAt,
      pages: this.pageCount,
      generations: this.jobs?.running ?? 0,
      sessions: [...this.#sessions.values()].map((session) => ({
        id: session.id,
        name: this.presence.nameOf(session.id),
        host: session.host,
        state: session.state,
        endedAt: session.state === 'ended' ? new Date(session.endedAt).toISOString() : null,
        bridge: Boolean(session.bridge),
        listener: Boolean(session.listener),
        // A command session (no bridge): online while its listener runs, and until keptUntil after.
        cli: session.cli,
        keptUntil: session.cli && session.state === 'online' && !this.#held(session) && session.keepUntil ? new Date(session.keepUntil).toISOString() : null,
        pages: session.pages.size,
        canvasDir: session.lastCanvas?.canvasDir ?? null,
        page: this.presence.pageOf(session.id)
      }))
    }
  }

  #isAllowedHost(host) {
    const match = /^(\[::1\]|[^:[\]]+)(?::(\d+))?$/.exec(host || '')
    if (!match || !LOOPBACK_HOSTS.has(match[1].toLowerCase())) return false
    // The front door passes the browser's Host on: cowart.localhost, with its port (80: none).
    const port = match[2] ? Number(match[2]) : 80
    return port === this.#port || (this.#domainPort > 0 && port === this.#domainPort)
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
      const { session: id, cwd, op, args, cli, host } = await readJsonBody(req)
      if (!validId(id)) return sendJson(res, 400, { error: '缺少会话标识。' })
      // Codex's prompt hook (hook-check) asks for every thread the user talks in: one that never ran
      // a command is no session here, and none is made for it.
      const asking = op === 'hook-check'
      const session = asking ? this.#sessions.get(id) ?? null : this.#session(id)
      // A cowart command: the session is online for a while after it (no bridge keeps it).
      if (cli === true && !asking) this.#touchCommandSession(session, nonEmpty(host))
      try {
        const result = await this.#bridgeCall(session, { cwd, op, args: args && typeof args === 'object' ? args : {} })
        return sendJson(res, 200, { result })
      } catch (error) {
        return sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    // Canvas pages: the session a page belongs to is the one its pane was opened for.
    if (req.method === 'POST' && PAGE_ACTIONS.has(url.pathname)) {
      const body = await readJsonBody(req)
      const paneId = req.headers['x-cowart-pane'] || body.pane
      const pane = this.presence.pane(paneId)
      const session = pane ? this.#sessions.get(pane.session) : null
      const result = await this.#pageAction(url.pathname, body, { paneId, session, host: session?.host ?? 'claude' })
      return sendJson(res, result.status, result.payload)
    }
    if (req.method === 'GET' && url.pathname === '/api/page-events') return this.#openPageStream(req, res, url)
    if (req.method === 'GET' && url.pathname === '/api/agent-events') return this.#openAgentStream(req, res, url)
    return sendJson(res, 404, { error: 'Not found' })
  }

  async #pageAction(path, body, { paneId, session, host }) {
    const reply = (status, payload) => ({ status, payload })
    if (body.session && session && body.session !== session.id) return reply(403, { error: '不能替另一个会话操作画布。' })
    if (body.pane && paneId && body.pane !== paneId) return reply(403, { error: '不能替另一个画布面板操作。' })
    try {
      switch (path) {
        case '/api/tools/call': {
          const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {}
          const pane = paneId ? this.#paneContext(paneId) : undefined
          return reply(200, await this.ops.callFromPage(String(body.name || ''), this.#oneCanvas(args), { host, pane }))
        }
        case '/api/panes/page': {
          if (!this.presence.pane(paneId)) return reply(409, { error: '画布页面还没连上画布服务。' })
          this.presence.setPanePage(paneId, { pageId: nonEmpty(body.pageId), pageName: nonEmpty(body.pageName) })
          return reply(200, { ok: true })
        }
        case '/api/pages/enter': {
          let entry = this.presence.pane(paneId)
          // Register the clicked page in the same operation as taking it.
          if (entry && nonEmpty(body.pageId)) {
            const page = (await this.ops.canvasPages(this.#withDefaults(session))).find((page) => page.id === body.pageId)
            if (!page) return reply(404, { error: '要接管的页面已不存在。' })
            this.presence.setPanePage(paneId, { pageId: page.id, pageName: page.name })
            entry = this.presence.pane(paneId)
          }
          if (!entry?.pageId) return reply(409, { error: '画布页面还没连上画布服务。' })
          if (!session || session.state === 'ended') return reply(409, { error: '这个面板的会话已经结束了：在会话里重新打开画布再接管这一页。' })
          const { previous } = this.presence.enter(session.id, entry.canvasDir, entry.pageId)
          return reply(200, { ok: true, claimed: true, pageId: entry.pageId, previous: previous && previous !== session.id ? this.#nameOf(previous) : null, state: this.presence.view(entry.canvasDir) })
        }
        case '/api/generations': {
          const available = this.jobs ? this.jobs.availability() : { ok: false, reason: '画布服务不能直接生成。' }
          if (!available.ok) return reply(409, { error: available.reason, fallback: true })
          const request = await this.jobs.start({ args: this.#oneCanvas(body), host })
          return reply(200, { ok: true, request: publicRequest(request) })
        }
        case '/api/messages': {
          if (!String(body.text || '').trim()) return reply(400, { error: '请求内容为空。' })
          const own = session?.id ?? body.session
          if (!validId(own)) return reply(409, { error: '这个画布页面是旧版本打开的：回到会话重新打开画布。' })
          const target = this.#routeRequest({ ...body, session: own })
          const kind = MESSAGE_KINDS.has(body.kind) ? body.kind : 'canvas'
          const request = this.queue.create({
            text: body.text,
            kind,
            session: target,
            projectDir: body.projectDir ?? session?.cwd,
            canvasDir: this.canvasDir,
            pageId: nonEmpty(body.pageId),
            pageName: nonEmpty(body.pageName),
            holderShapeId: kind !== 'canvas' && typeof body.holderShapeId === 'string' ? body.holderShapeId : null
          })
          return reply(200, { ok: true, request: publicRequest(request) })
        }
        case '/api/requests/cancel': {
          const request = this.queue.get(body.id)
          // Numbers start over when the service is replaced: a page still showing a request
          // from before (nothing has the number, or another request's key) learns it is gone.
          if (!request || (body.requestKey && body.requestKey !== request.requestKey)) {
            return reply(410, { error: '这条请求已经不在了：画布服务重启过（换了新版本），没处理完的请求没保留下来。要的话请重新点一次。', gone: true })
          }
          try {
            const cancelled = request.executor === 'service' && this.jobs ? this.jobs.cancel(body.id) : this.queue.cancel(body.id)
            return reply(200, { ok: true, request: publicRequest(cancelled) })
          } catch (error) {
            // Too late to withdraw (Claude started on it, or it is over): the page shows why.
            return reply(409, { error: error instanceof Error ? error.message : String(error), request: publicRequest(request) })
          }
        }
        default:
          return reply(404, { error: 'Not found' })
      }
    } catch (error) {
      return reply(409, { error: error instanceof Error ? error.message : String(error), ...(path === '/api/generations' ? { fallback: Boolean(error?.fallback) } : {}) })
    }
  }

  #recentRequests(canvasDir) {
    const now = Date.now()
    return this.queue.list()
      .filter((request) => request.canvasDir === canvasDir)
      .filter((request) => !FINAL_STATUSES.has(request.status) || now - Date.parse(request.updatedAt) < RECENT_FINAL_MS)
      .map(publicRequest)
  }

  #pageEvents(session, canvasDir) {
    return [
      { event: 'hello', data: { protocol: this.identity.protocol, build: this.identity.build, startedAt: this.#startedAt } },
      { event: 'presence', data: this.#presence(session) },
      { event: 'requests', data: { requests: this.#recentRequests(canvasDir) } },
      { event: 'page-state', data: this.#pageState(canvasDir) }
    ]
  }

  // Who is responsible for which page, and when each page last changed (page-activity.mjs).
  #pageState(canvasDir) {
    return { ...this.presence.view(canvasDir), changedAt: canvasDir === this.canvasDir ? this.activity.view() : {} }
  }

  #activityTimer = null
  #announceActivity() {
    if (this.#activityTimer || this.#closing) return
    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = null
      this.#broadcastCanvas(this.canvasDir, 'page-state', this.#pageState(this.canvasDir))
    }, ACTIVITY_ANNOUNCE_MS)
    this.#activityTimer.unref?.()
  }

  // A request from a page goes to the session responsible for that page. A page nobody is
  // responsible for goes to the session of the pane it was clicked in, which takes the page.
  #routeRequest(body) {
    const own = this.#session(body.session)
    const pageId = nonEmpty(body.pageId)
    const canvasDir = this.canvasDir
    const holder = pageId ? this.presence.holderOf(canvasDir, pageId) : null
    const holding = holder ? this.#sessions.get(holder) : null
    const target = holding && holding.state !== 'ended' ? holder : own.id
    const requiredHost = nonEmpty(body.requiredHost)
    if (requiredHost && this.#sessions.get(target)?.host !== requiredHost) {
      throw new Error(`这项生成需要 ${requiredHost === 'codex' ? 'Codex' : requiredHost}，但当前页面由「${this.#nameOf(target)}」负责。请在 Codex 会话接管这一页，或选择两个宿主都支持的模型。`)
    }
    if (!pageId || target !== own.id) return target
    if (holder === own.id && own.state !== 'ended') return own.id
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
      session = {
        id,
        host: null,
        cwd: null,
        bridge: null,
        listener: null,
        pages: new Set(),
        state: 'waiting',
        endedAt: null,
        lastCanvas: null,
        timer: null,
        cli: false,
        listenerKeeps: false,
        keepUntil: 0,
        releasedPage: null
      }
      this.#sessions.set(id, session)
      this.#armEnd(session, SESSION_WAIT_MS)
    }
    return session
  }

  #armEnd(session, ms) {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => this.#endSession(session), Math.max(0, ms))
  }

  // Connected: its bridge, or the listener of a command session. A Codex command session runs no
  // listener: its canvas page open keeps it.
  #held(session) {
    return Boolean(session.bridge) || Boolean(session.listener && session.listenerKeeps) || (session.cli && session.host === 'codex' && session.pages.size > 0)
  }

  // A command session stays online at least ms longer (replace: exactly ms from now); with
  // nothing holding it, it ends at keepUntil.
  #keepFor(session, ms, { replace = false } = {}) {
    const until = Date.now() + ms
    session.keepUntil = replace ? until : Math.max(session.keepUntil, until)
    if (!this.#held(session) && !this.#closing) this.#armEnd(session, session.keepUntil - Date.now())
  }

  // A command session comes online (or back): its page is its again, unless taken meanwhile.
  #online(session) {
    clearTimeout(session.timer)
    session.timer = null
    if (session.state === 'online') return
    const resumed = session.state === 'ended'
    session.state = 'online'
    const page = session.releasedPage
    session.releasedPage = null
    if (page && !this.presence.pageOf(session.id) && !this.presence.holderOf(page.canvasDir, page.pageId)) {
      this.presence.enter(session.id, page.canvasDir, page.pageId)
      this.log(`session ${session.id} took its page ${page.pageId} back`)
    }
    this.log(`session ${session.id} ${resumed ? 'resumed' : 'connected'} (${session.host ?? 'unknown host'}, cowart command)`)
    this.#broadcastPresence(session)
    this.#deliverPending(session)
    this.onActivity()
  }

  // A cowart command of the session (adapters/claude/bin/cowart.mjs, Claude Code).
  #touchCommandSession(session, host) {
    session.cli = true
    session.host = host ?? session.host
    this.#online(session)
    if (!this.#held(session)) this.#keepFor(session, LEASE_MS)
  }

  // The session's pages learn it is gone, unanswered requests wait for it to come back, and
  // the page it was responsible for is free again.
  #endSession(session) {
    session.timer = null
    if (this.#held(session) || session.state === 'ended' || this.#closing) return
    // A command session is kept longer meanwhile (it was busy when a command came).
    if (session.cli && session.keepUntil > Date.now()) {
      this.#armEnd(session, session.keepUntil - Date.now())
      return
    }
    session.state = 'ended'
    session.endedAt = Date.now()
    this.queue.resetDelivery(session.id)
    const page = this.presence.release(session.id)
    if (session.cli) session.releasedPage = page
    if (session.listener) {
      endStream(session.listener, 'session-ended', {})
      session.listener = null
    }
    this.#broadcastPresence(session)
    this.log(`session ${session.id} ended`)
    this.#forgetEnded()
    this.onActivity()
  }

  // Sessions that ended ENDED_KEPT_MS ago are dropped, unless something still waits for them:
  // an unfinished request routed to them, a page they hold, a canvas page or listener of
  // theirs still connected. Codex starts a session for every task, and the service used to
  // list each of them for as long as it ran. One that comes back afterwards starts over as a
  // new session and still hears its requests: the queue keeps them by session id.
  #forgetEnded() {
    const now = Date.now()
    for (const session of this.#sessions.values()) {
      if (session.state !== 'ended' || now - session.endedAt < ENDED_KEPT_MS) continue
      if (session.listener || session.pages.size > 0) continue
      if (this.presence.pageOf(session.id) || this.queue.list(session.id).some((request) => !FINAL_STATUSES.has(request.status))) continue
      this.#sessions.delete(session.id)
      this.ops.forgetSession(session.id)
      this.log(`session ${session.id} forgotten`)
    }
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

  // One listener per session (run in the background until a request comes): a newer one
  // replaces the previous one so requests are never announced twice. A command session's
  // listener (presence=1: `cowart listen`) keeps it online; when it goes, the session stays
  // online while it handles what the listener brought, and ends soon if it brought nothing.
  #openAgentStream(req, res, url) {
    const id = url.searchParams.get('session')
    if (!validId(id)) {
      return sendJson(res, 400, { error: '监听命令缺少 --session：回到 Claude Code 重新打开画布，用新给的监听命令。' })
    }
    const session = this.#session(id)
    if (session.listener) endStream(session.listener, 'replaced', {})

    openEventStream(req, res)
    const keeps = url.searchParams.get('presence') === '1'
    session.listener = res
    session.listenerKeeps = keeps
    if (keeps) {
      session.cli = true
      session.host = nonEmpty(url.searchParams.get('host')) ?? session.host
      this.#online(session)
    }
    req.on('close', () => {
      if (session.listener !== res) return
      session.listener = null
      if (keeps) this.#keepFor(session, this.#deliveredOn.has(res) ? BUSY_MS : LISTENER_GONE_MS, { replace: true })
      this.#broadcastPresence(session)
      this.onActivity()
    })
    this.#broadcastPresence(session)
    this.#deliverPending(session)
    this.onActivity()
  }

  #openPageStream(req, res, url) {
    const id = url.searchParams.get('session')
    const session = validId(id) ? this.#session(id) : null
    const pane = validId(url.searchParams.get('pane')) ? url.searchParams.get('pane') : null
    // Whatever canvas the page's URL names (older pages name their project's), it shows this one.
    const canvasDir = this.canvasDir
    const knownPane = pane ? this.presence.pane(pane) : null
    if (knownPane && knownPane.session !== session?.id) return sendJson(res, 403, { error: '这个画布面板属于另一个会话。' })
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
      // A command session its canvas page kept online (Codex): online a lease longer.
      const held = session ? this.#held(session) : false
      session?.pages.delete(res)
      if (session?.cli && held && !this.#held(session) && !this.#closing) this.#keepFor(session, LEASE_MS)
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

    for (const { event, data } of this.#pageEvents(session, canvasDir)) sendEvent(res, event, data)
    this.onActivity()
  }

  #presence(session) {
    if (!session) return { session: 'ended', agentOnline: false }
    return { session: session.state, host: session.host, agentOnline: session.state === 'online' && Boolean(session.listener) }
  }

  #deliver(request) {
    if (request.executor === 'service') return
    const stream = this.#sessions.get(request.session)?.listener
    if (!stream || request.delivered) return
    sendEvent(stream, 'request', agentEventPayload(request))
    this.#deliveredOn.add(stream)
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
    if (!stream || !request.delivered) return
    sendEvent(stream, 'cancelled', agentEventPayload(request))
    this.#deliveredOn.add(stream)
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

  // What a session just put on a page, for its own canvas panes: one showing that page brings
  // it into view (service-bridge.js: not while the user works the canvas). 10-22: the first
  // group on a new page sat half under the top bar, and the user had to look for it.
  #revealPut(session, result) {
    const put = result && !result.isError ? result.structuredContent : null
    const ids = put && !put.dryRun ? [put.shapeId, put.frameId, ...(put.texts ?? []).map((text) => text.shapeId)].filter((id) => typeof id === 'string' && id.startsWith('shape:')) : []
    if (ids.length === 0 || !nonEmpty(put.pageId)) return result
    const data = { pageId: put.pageId, shapeIds: [...new Set(ids)] }
    for (const [res, stream] of this.#pageStreams) {
      if (stream.session === session.id && stream.canvasDir === this.canvasDir) sendEvent(res, 'reveal-shapes', data)
    }
    return result
  }

  #ownRequest(session, id) {
    const request = this.queue.get(id)
    if (!request || request.session !== session.id) {
      throw new Error(`这个会话没有编号为 ${id} 的画布请求（请求只存在画布服务的内存里，服务重启后就没了）。`)
    }
    return request
  }

  async #bridgeCall(session, { cwd, op, args }) {
    if (session) session.cwd = nonEmpty(cwd) ?? session.cwd
    switch (op) {
      case 'hook-check': {
        // The requests still waiting for a Codex session, for its prompt hook to remind it of
        // (cowart hook prompt). Asking delivers nothing; a known Codex command session stays
        // online the way its commands keep it. A Codex started inside a Claude Code session asks
        // with that session's id (D7): it stays Claude Code's, kept online by its own commands.
        if (!session) return { requests: [] }
        if (session.cli && (session.host ?? 'codex') === 'codex') this.#touchCommandSession(session, 'codex')
        const waiting = this.queue.list(session.id).filter((request) => !FINAL_STATUSES.has(request.status) && request.executor !== 'service')
        return { requests: waiting.map(({ id, title, pageName, status }) => ({ id, title, pageName, status })) }
      }
      case 'model-tools': {
        // Upstream's tools, the service's layout tools (canvas-edit.mjs), page folders
        // (page-folders.mjs) and its feedback tool, which stays listed when upstream is down:
        // that is worth feedback too.
        const upstreamTools = await this.ops.modelTools().catch((error) => {
          this.log(`upstream tools unavailable: ${error.message}`)
          return []
        })
        return { tools: [...upstreamTools, ...(upstreamTools.length > 0 ? [...EDIT_TOOL_DEFINITIONS, MOVE_PAGES_TOOL_DEFINITION] : []), FEEDBACK_TOOL_DEFINITION] }
      }
      case 'open-canvas':
        return this.#openCanvas(session, args)
      case 'canvas-state':
        return this.#canvasState(session, this.#withDefaults(session, args))
      case 'pages':
        return this.#pages(session)
      case 'insert-video':
        return this.#revealPut(session, await this.ops.insertVideo(await this.#pageWrite(session, INSERT_VIDEO_TOOL, this.#withDefaults(session, args))))
      case 'tool': {
        const name = String(args.name || '')
        if (name === FEEDBACK_TOOL) return this.#recordFeedback(session, args.arguments ?? {})
        // Folders are no page's content: any session sorts any page (page-folders.mjs).
        if (name === MOVE_PAGES_TOOL) return this.ops.movePages(this.#withDefaults(session, args.arguments ?? {}))
        let toolArgs = this.#withDefaults(session, args.arguments ?? {})
        if (PAGE_WRITE_TOOLS.has(name)) toolArgs = await this.#pageWrite(session, name, toolArgs)
        if (EDIT_TOOLS.has(name)) {
          const edited = await this.ops.editCanvas(name, toolArgs)
          return PUT_TOOLS.has(name) ? this.#revealPut(session, edited) : edited
        }
        // Claude's put commands name their anchor (--next-to): the selection is none of it.
        await this.ops.replaySelection(name, toolArgs, session.id, { anchor: args.selectionAnchor !== false })
        const result = await this.ops.callForModel(name, toolArgs)
        return PUT_TOOLS.has(name) ? this.#revealPut(session, result) : result
      }
      case 'request-get': {
        const request = this.#ownRequest(session, args.id)
        if (args.requestKey && args.requestKey !== request.requestKey) throw new Error('这条画布请求来自已经重启的旧服务，不能用旧编号处理新请求。')
        return { request: { ...publicRequest(request), text: request.text } }
      }
      case 'request-reply': {
        const request = this.#ownRequest(session, args.id)
        if (args.requestKey && args.requestKey !== request.requestKey) throw new Error('这条画布请求来自已经重启的旧服务，不能用旧编号处理新请求。')
        const updated = this.queue.update(args.id, { status: args.status, message: args.message })
        return { request: publicRequest(updated), listenerConnected: Boolean(session.listener) }
      }
      case 'request-list': {
        // Asked for in the conversation (the user said 看画布 while no listener ran): what waits
        // is announced now, so the next listener does not wake the session with it again.
        if (args.acknowledge === true) for (const request of this.queue.undelivered(session.id)) this.queue.markDelivered(request.id)
        const requests = this.queue.list(session.id).filter((request) => args.includeFinished === true || !FINAL_STATUSES.has(request.status))
        return { requests: requests.map(publicRequest), listenerConnected: Boolean(session.listener) }
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
      entered = await this.ops.ensurePage(target, wanted, { folder: args.folder })
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

    // The page always shows the machine's canvas, so the address does not name it.
    const query = new URLSearchParams({ session: session.id, projectDir: target.projectDir })
    if (title !== 'Cowart Canvas') query.set('title', title)
    if (entered) query.set('pageId', entered.id)
    this.#lastOpenedUrl = `/?${query}`
    return {
      url: `${await this.refreshPageOrigin()}/?${query}`,
      // For a browser that does not send *.localhost to this machine.
      localUrl: `${this.origin}/?${query}`,
      port: this.#port,
      session: session.id,
      sessionName,
      protocol: this.identity.protocol,
      projectDir: target.projectDir,
      canvasDir: target.canvasDir,
      page: entered ? entered.name : null,
      pageFolder: entered ? entered.folder ?? '' : null,
      pageMovedFrom: entered?.movedFrom ?? null,
      pageCreated: Boolean(entered?.created),
      takenFrom: previous && previous !== session.id ? this.#nameOf(previous) : null,
      alreadyHeld: Boolean(entered) && previous === session.id,
      myPage: myPage ? myPage.name : null,
      heldPageId: myPage?.id ?? null,
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
    let pageId = await this.ops.targetPage(args, name)
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
    const pageId = nonEmpty(args.pageId)
    if (pageId) {
      const holder = view.pages[pageId]?.holder
      const duty = holder ? `这一页由「${this.#nameOf(holder)}」负责${holder === session.id ? '（本会话）' : '：别的会话不能往里放东西'}。` : '这一页还没人负责。'
      return textResult(`${result.content?.[0]?.text ?? ''}\n\n${duty}`, { ...result.structuredContent, responsibilities: view })
    }
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

  // Every page of the canvas: who is responsible for it, which one this session holds and which
  // its canvas pane shows.
  async #pages(session) {
    const pages = await this.ops.pageList(this.#withDefaults(session))
    const shown = this.presence.panesOf(session.id, this.canvasDir)[0]?.pageId ?? null
    const mine = this.presence.pageOf(session.id)
    return {
      pages: pages.map((page) => {
        const holder = this.presence.holderOf(this.canvasDir, page.id)
        return { ...page, holder: holder ? this.#nameOf(holder) : null, mine: holder === session.id, shown: page.id === shown }
      }),
      myPageId: mine?.canvasDir === this.canvasDir ? mine.pageId : null,
      shownPageId: shown
    }
  }

  // ---- Feedback ----------------------------------------------------------------------

  // send_cowart_feedback: the user's words and the model's account, with what the service
  // knows of the session right now. Each part of that is best effort: the feedback is kept
  // even when the canvas cannot be read.
  async #recordFeedback(session, input) {
    const pages = await this.ops.canvasPages(this.#withDefaults(session)).catch(() => [])
    const pageRef = (idOrName) => {
      if (!idOrName) return null
      const page = pages.find((entry) => entry.id === idOrName || entry.name === idOrName)
      return page ? { id: page.id, name: page.name } : { id: idOrName, name: null }
    }
    const held = this.presence.pageOf(session.id)
    const heldPage = held?.canvasDir === this.canvasDir ? pageRef(held.pageId) : null
    const shownPages = this.presence.panesOf(session.id, this.canvasDir).map((pane) => ({ id: pane.pageId, name: pane.pageName ?? pageRef(pane.pageId).name }))
    const page = pageRef(nonEmpty(input.pageId)) ?? heldPage ?? shownPages[0] ?? null
    const pageIds = new Set([page?.id, heldPage?.id, ...shownPages.map((entry) => entry.id)].filter(Boolean))
    const requests = this.queue
      .list()
      .filter((request) => request.session === session.id || (request.executor === 'service' && pageIds.has(request.pageId)))
      .slice(-FEEDBACK_REQUESTS)
      .map(({ id, kind, executor, title, summary, status, message, pageName, createdAt, updatedAt }) => ({ id, kind, executor, title, summary, status, message, pageName, createdAt, updatedAt }))
    const { record, dir, skipped } = await this.feedback.create(input, {
      source: { host: session.host ?? null, session: session.id, sessionName: this.presence.nameOf(session.id), project: session.cwd ?? null },
      canvas: { canvasDir: this.canvasDir, page, heldPage, shownPages },
      code: { version: this.identity.version, protocol: this.identity.protocol, build: this.identity.build, root: this.identity.root },
      requests,
      canvasText: page ? await this.#pageSummary(session, page.id) : null
    })
    const kept = [
      '会话、项目、代码版本',
      page && `当时的页「${page.name ?? page.id}」`,
      requests.length > 0 && `最近 ${requests.length} 条画布请求`,
      record.files.serviceLog && '服务日志',
      record.attachments.length > 0 && `${record.attachments.length} 个附件`
    ].filter(Boolean)
    const lines = [
      `已记下反馈 #${record.id}「${record.title}」：${dir}`,
      `一起记下的还有${kept.join('、')}。`,
      ...skipped.map((item) => `没附上 ${item.from}：${item.reason}。`),
      '把编号告诉用户就行：反馈在 Cowart 仓库里处理（npm --prefix adapters run feedback），这个会话不用改 Cowart。'
    ]
    return textResult(lines.join('\n'), { id: record.id, title: record.title, status: record.status, dir })
  }

  // The page as the canvas summary describes it now.
  async #pageSummary(session, pageId) {
    try {
      const summary = (await this.ops.canvasState(this.#withDefaults(session))).structuredContent
      const page = summary?.pages?.find((entry) => entry.id === pageId)
      return page ? formatCanvasSummary({ ...summary, currentPageId: pageId, pages: [page] }) : null
    } catch {
      return null
    }
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
    const host = validId(session) ? this.#sessions.get(session)?.host ?? null : null
    const html = await this.renderPage(url.searchParams, {
      heldPageId: held?.canvasDir === this.canvasDir ? held.pageId : null,
      host
    })
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
    // The browser keeps what it fetched and asks again with these (no-cache: every use checks
    // first); an unchanged file is a 304 with no body, so going back to a page with many
    // pictures costs a round trip per picture, not the pictures.
    const etag = `"${fileStat.size.toString(36)}-${Math.trunc(fileStat.mtimeMs).toString(36)}"`
    const lastModified = fileStat.mtime.toUTCString()
    const headers = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      etag,
      'last-modified': lastModified,
      'x-content-type-options': 'nosniff'
    }
    if (notModified(req.headers, etag, fileStat.mtime)) {
      const { 'content-type': _type, ...validators } = headers
      res.writeHead(304, validators).end()
      return
    }

    // A range of a file that changed since the browser kept the rest of it (If-Range) would
    // mix the two: the whole new file instead.
    const ifRange = req.headers['if-range']
    const range = !ifRange || ifRange === etag || ifRange === lastModified ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '') : null
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : fileStat.size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : fileStat.size - 1
      start = Math.max(0, start)
      end = Math.min(end, fileStat.size - 1, start + MAX_RANGE_BYTES - 1)
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
