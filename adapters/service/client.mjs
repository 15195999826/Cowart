// Bridge side of the canvas service. It finds the machine-wide service on 127.0.0.1 (the
// port is the lock), starts it in the background when nobody runs one, replaces it when
// this checkout's code changed (identity.mjs), keeps the session connected and calls it.
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

import { ADAPTERS_DIR, REPO_ROOT } from '../shared/paths.mjs'
import { DEFAULT_PORT, SERVICE_NAME, localIdentity, serviceVerdict } from './lib/identity.mjs'
import { RUNTIME_DIR, SERVICE_LOG, loadOrCreateToken } from './lib/token.mjs'

export const SERVICE_ENTRY = process.env.COWART_BUNDLED === '1'
  ? join(ADAPTERS_DIR, 'generated', 'cowart-service.mjs')
  : join(ADAPTERS_DIR, 'service', 'bin', 'cowart-service.mjs')
// Ports held by something else (another program, a pre-service adapter) are skipped.
export const PORT_ATTEMPTS = 20
const PROBE_TIMEOUT_MS = 4_000
const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 600_000
const RECONNECT_MAX_MS = 5_000
const LOG_LIMIT_BYTES = 5 * 1024 * 1024

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

// Binding is instant; on Windows a refused connection to a closed port takes a second or two.
function portIsFree(port) {
  return new Promise((resolveFree) => {
    const tester = net.createServer()
    tester.once('error', () => resolveFree(false))
    tester.listen(port, '127.0.0.1', () => tester.close(() => resolveFree(true)))
  })
}

// free: nothing listens. cowart: a canvas service (with its status). foreign: anything else.
export async function probeService(port, token) {
  if (await portIsFree(port)) return { kind: 'free' }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/service`, {
        headers: { 'x-cowart-token': token },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      const payload = await response.json().catch(() => null)
      if (response.ok && payload?.service === SERVICE_NAME) return { kind: 'cowart', status: payload }
      return { kind: 'foreign' }
    } catch (error) {
      if (error?.cause?.code === 'ECONNREFUSED') return { kind: 'free' }
    }
  }
  return { kind: 'foreign' }
}

// The first canvas service from port upward, where a bridge would find it; exact: on this
// port and no other.
export async function findService({ port = DEFAULT_PORT, token, exact = false } = {}) {
  for (let offset = 0; offset < (exact ? 1 : PORT_ATTEMPTS); offset += 1) {
    const probe = await probeService(port + offset, token)
    if (probe.kind === 'cowart') return { port: port + offset, status: probe.status }
  }
  return null
}

export async function stopService(port, token, reason = 'requested') {
  await fetch(`http://127.0.0.1:${port}/api/service/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  }).catch(() => {})
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true
    await delay(100)
  }
  return false
}

// The service outlives the session that started it: keep that session's identity and
// credentials out of its environment.
function serviceEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => /^COWART_/i.test(key) || (!/^(CLAUDE|ANTHROPIC|CODEX_THREAD|CODEX_SESSION)/i.test(key) && !/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key))
    )
  )
}

function openServiceLog() {
  mkdirSync(RUNTIME_DIR, { recursive: true })
  try {
    if (statSync(SERVICE_LOG).size > LOG_LIMIT_BYTES) renameSync(SERVICE_LOG, `${SERVICE_LOG}.1`)
  } catch {
    // No log yet, or another service holds it.
  }
  return openSync(SERVICE_LOG, 'a')
}

// Detached so the service is not tied to this bridge: the session ending must not end it.
export function spawnService(port, { entry = SERVICE_ENTRY } = {}) {
  const out = openServiceLog()
  try {
    const child = spawn(process.execPath, [entry, '--port', String(port)], {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: serviceEnv()
    })
    child.on('error', () => {})
    child.unref()
    return child.pid
  } finally {
    closeSync(out)
  }
}

async function waitForService(port, token) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const probe = await probeService(port, token)
    if (probe.kind !== 'free') return probe
    await delay(150)
  }
  return null
}

// Calls back (event, data) for each server-sent event until the stream ends.
export async function readEventStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) onEvent(event, JSON.parse(data))
    }
  }
}

export class CanvasServiceClient {
  #token = null
  #port = null
  #mine = localIdentity()
  #stream = null
  #connecting = null
  #closed = false
  #replaced = false

  constructor({ host, session, cwd, port = DEFAULT_PORT, entry = SERVICE_ENTRY, log }) {
    this.host = host
    this.session = session
    this.cwd = cwd
    this.basePort = port
    this.entry = entry
    this.log = log ?? (() => {})
  }

  get port() {
    return this.#port
  }

  get origin() {
    return `http://127.0.0.1:${this.#port}`
  }

  // At startup a service running older code of this checkout is replaced; reconnects later
  // live with whatever runs, so bridges of different versions never take turns.
  async start() {
    await this.#connect({ allowReplace: true })
  }

  close() {
    this.#closed = true
    this.#stream?.abort()
  }

  async call(op, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (this.#connecting) await this.#connecting.catch(() => {})
    if (!this.#port) await this.#connect({ allowReplace: true })
    for (let attempt = 0; ; attempt += 1) {
      let response
      try {
        response = await fetch(`${this.origin}/api/bridge/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cowart-token': this.#token },
          body: JSON.stringify({ session: this.session, cwd: this.cwd, op, args }),
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (error) {
        // The service went away (a crash, or a newer bridge replacing it): find or start it
        // once more, then retry.
        if (attempt > 0 || this.#closed || error?.name === 'TimeoutError') throw new Error(`画布服务没有响应：${error.message}`)
        await this.#connect({ allowReplace: false })
        continue
      }
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `画布服务返回 ${response.status}`)
      return payload.result
    }
  }

  async #connect({ allowReplace }) {
    this.#connecting ??= (async () => {
      this.#token ??= await loadOrCreateToken()
      this.#port = await this.#locate({ allowReplace })
      await this.#openSessionStream()
    })().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #locate({ allowReplace }) {
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const port = this.basePort + offset
      const probe = await probeService(port, this.#token)
      if (probe.kind === 'foreign') continue
      if (probe.kind === 'cowart') {
        const verdict = serviceVerdict(probe.status, this.#mine)
        if (verdict === 'reuse') return port
        if (verdict !== 'replace' || !allowReplace) {
          if (probe.status.protocol === this.#mine.protocol) return port
          throw new Error(`画布服务（${probe.status.version}，协议 ${probe.status.protocol}）比这个会话的 cowart 新：重开这个会话即可。`)
        }
        this.log(`replacing the canvas service on ${port} (build ${probe.status.build} → ${this.#mine.build})`)
        if (!(await stopService(port, this.#token, 'replaced'))) throw new Error(`旧的画布服务（端口 ${port}）没有按时退出。`)
      }
      // Nobody serves this port: start the service. Bridges racing here are fine, the port
      // lets exactly one of the services they start bind.
      spawnService(port, { entry: this.entry })
      const started = await waitForService(port, this.#token)
      if (!started) throw new Error(`画布服务没能启动（端口 ${port}），日志在 ${SERVICE_LOG}。`)
      if (started.kind === 'foreign') continue
      if (started.status.protocol !== this.#mine.protocol) {
        throw new Error(`画布服务（${started.status.version}，协议 ${started.status.protocol}）跟这个会话的 cowart 不兼容：重开这个会话即可。`)
      }
      this.log(`canvas service on ${port} (pid ${started.status.pid})`)
      return port
    }
    throw new Error(`端口 ${this.basePort}–${this.basePort + PORT_ATTEMPTS - 1} 都被别的程序占着，画布服务起不来。`)
  }

  // Stays open while the session lives: the service counts the session as connected, and
  // notices when it ends.
  #openSessionStream() {
    this.#stream?.abort()
    const controller = new AbortController()
    this.#stream = controller
    let registered = false
    let resolveRegistered
    let rejectRegistered
    const registration = new Promise((resolve, reject) => {
      resolveRegistered = resolve
      rejectRegistered = reject
    })
    const query = new URLSearchParams({ session: this.session, host: this.host, cwd: this.cwd ?? '', pid: String(process.pid) })
    fetch(`${this.origin}/api/bridge/session?${query}`, {
      headers: { accept: 'text/event-stream', 'x-cowart-token': this.#token },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        await readEventStream(response.body, (event) => {
          // A bridge call must not race the session's host/state registration. The stream
          // stays open in the background once the service acknowledges this session.
          if (event === 'hello') {
            registered = true
            resolveRegistered()
          }
          if (event === 'replaced') this.#replaced = true
        })
      })
      .catch((error) => rejectRegistered(error))
      .finally(() => {
        if (!registered) {
          rejectRegistered(new Error('画布服务没有确认会话连接。'))
          return
        }
        if (this.#stream !== controller || this.#closed || this.#replaced) return
        this.#reconnect(0)
      })
    return registration
  }

  #reconnect(attempt) {
    setTimeout(async () => {
      if (this.#closed) return
      try {
        await this.#connect({ allowReplace: false })
      } catch (error) {
        this.log(`reconnect failed: ${error.message}`)
        this.#reconnect(attempt + 1)
      }
    }, Math.min(RECONNECT_MAX_MS, 300 * 2 ** attempt)).unref()
  }
}
