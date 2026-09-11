// Local web host for the Claude Code adapter. It serves the upstream canvas page with a
// Claude bridge injected, relays the page's tool calls, serves page assets (videos need
// real URLs with range support) and streams canvas requests to the Monitor listener.
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'

import { localPathForAssetSrc } from '../../shared/canvas-model.mjs'
import { readFileHead, sniffMediaType } from '../../shared/video.mjs'
import { FINAL_STATUSES, publicRequest } from './requests.mjs'

export const DEFAULT_PORT = 43240
const PORT_ATTEMPTS = 20
const MAX_BODY_BYTES = 128 * 1024 * 1024
const HEARTBEAT_MS = 20_000
const RECENT_FINAL_MS = 60_000

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
  res.write(': connected\n\n')
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS)
  req.on('close', () => clearInterval(heartbeat))
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function agentEventPayload(request) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    projectDir: request.projectDir
  }
}

export class CanvasHttpHost {
  #server = null
  #port = null
  #pageStreams = new Set()
  #agentStreams = new Set()

  constructor({ token, queue, renderPage, callToolFromPage, createVideoRequest, canvasDirFor, fallbackCanvasDir, log }) {
    this.token = token
    this.queue = queue
    this.renderPage = renderPage
    this.callToolFromPage = callToolFromPage
    this.createVideoRequest = createVideoRequest
    this.canvasDirFor = canvasDirFor
    this.fallbackCanvasDir = fallbackCanvasDir
    this.log = log ?? (() => {})

    queue.on('created', (request) => this.#deliver(request))
    queue.on('changed', (request) => this.#broadcastPage('request', publicRequest(request)))
  }

  get port() {
    return this.#port
  }

  get origin() {
    return `http://127.0.0.1:${this.#port}`
  }

  get agentOnline() {
    return this.#agentStreams.size > 0
  }

  async start({ preferredPort = DEFAULT_PORT } = {}) {
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const port = preferredPort + offset
      const server = http.createServer((req, res) => {
        this.#handle(req, res).catch((error) => {
          this.log(`request failed: ${error.stack || error}`)
          if (!res.headersSent) sendJson(res, 500, { error: error.message })
          else res.end()
        })
      })
      try {
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
      } catch (error) {
        server.close()
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error(`端口 ${preferredPort}–${preferredPort + PORT_ATTEMPTS - 1} 都被占用了。`)
  }

  async close() {
    for (const res of [...this.#pageStreams, ...this.#agentStreams]) res.end()
    this.#pageStreams.clear()
    this.#agentStreams.clear()
    await new Promise((resolveClose) => (this.#server ? this.#server.close(() => resolveClose()) : resolveClose()))
    this.#server = null
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
      return sendJson(res, 200, { ok: true, service: 'cowart-claude', agentOnline: this.agentOnline })
    }
    if (req.method === 'GET' && (url.pathname.startsWith('/page-assets/') || url.pathname.startsWith('/assets/'))) {
      return this.#serveAsset(req, res, url)
    }
    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' })
    if (!this.#isAuthorized(req, url)) {
      return sendJson(res, 403, { error: 'Cowart 本地服务令牌无效：回到 Claude Code 重新打开画布。' })
    }

    if (req.method === 'POST' && url.pathname === '/api/tools/call') {
      const { name, arguments: args } = await readJsonBody(req)
      return sendJson(res, 200, await this.callToolFromPage(String(name || ''), args && typeof args === 'object' ? args : {}))
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const body = await readJsonBody(req)
      if (!String(body.text || '').trim()) return sendJson(res, 400, { error: '请求内容为空。' })
      const request = this.queue.create({ text: body.text, kind: 'canvas', projectDir: body.projectDir, canvasDir: body.canvasDir })
      return sendJson(res, 200, { ok: true, request: publicRequest(request) })
    }
    if (req.method === 'POST' && url.pathname === '/api/requests/video') {
      try {
        const request = await this.createVideoRequest(await readJsonBody(req))
        return sendJson(res, 200, { ok: true, request: publicRequest(request) })
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/page-events') return this.#openPageStream(req, res)
    if (req.method === 'GET' && url.pathname === '/api/agent-events') return this.#openAgentStream(req, res)
    return sendJson(res, 404, { error: 'Not found' })
  }

  async #servePage(res, url) {
    const html = await this.renderPage(url.searchParams)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'referrer-policy': 'same-origin'
    })
    res.end(html)
  }

  // Media elements cannot send the token header, so assets are limited to same-origin
  // requests for the canvas the requesting page belongs to.
  async #serveAsset(req, res, url) {
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403).end('Forbidden')
      return
    }

    let canvasDir = this.fallbackCanvasDir()
    const referer = req.headers.referer
    if (referer) {
      try {
        const refererUrl = new URL(referer)
        if (refererUrl.host === url.host && refererUrl.pathname === '/') canvasDir = this.canvasDirFor(refererUrl.searchParams)
      } catch {
        // Keep the fallback canvas.
      }
    }
    const filePath = canvasDir ? localPathForAssetSrc(canvasDir, url.pathname) : null
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

  #openPageStream(req, res) {
    openEventStream(req, res)
    this.#pageStreams.add(res)
    req.on('close', () => this.#pageStreams.delete(res))

    const now = Date.now()
    const recent = this.queue
      .list()
      .filter((request) => !FINAL_STATUSES.has(request.status) || now - Date.parse(request.updatedAt) < RECENT_FINAL_MS)
      .map(publicRequest)
    sendEvent(res, 'presence', { agentOnline: this.agentOnline })
    sendEvent(res, 'requests', { requests: recent })
  }

  // One listener per adapter: a newer Monitor replaces the previous one so requests
  // are never announced twice.
  #openAgentStream(req, res) {
    for (const previous of this.#agentStreams) {
      sendEvent(previous, 'replaced', {})
      previous.end()
    }
    this.#agentStreams.clear()

    openEventStream(req, res)
    this.#agentStreams.add(res)
    req.on('close', () => {
      if (this.#agentStreams.delete(res)) this.#broadcastPresence()
    })
    this.#broadcastPresence()
    for (const request of this.queue.undelivered()) this.#deliver(request)
  }

  #deliver(request) {
    const [stream] = this.#agentStreams
    if (!stream || request.delivered) return
    sendEvent(stream, 'request', agentEventPayload(request))
    this.queue.markDelivered(request.id)
  }

  #broadcastPresence() {
    this.#broadcastPage('presence', { agentOnline: this.agentOnline })
  }

  #broadcastPage(event, data) {
    for (const res of this.#pageStreams) sendEvent(res, event, data)
  }
}
