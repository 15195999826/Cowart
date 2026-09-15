// Bridge side of the canvas service. It finds the machine-wide service on 127.0.0.1 (the
// port is the lock), starts it in the background when nobody runs one, replaces it when
// this checkout's code changed (identity.mjs), keeps the session connected and calls it.
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

import { ADAPTERS_DIR, REPO_ROOT, SHARED_CANVAS_DIR } from '../shared/paths.mjs'
import { canvasOwner, isAlive } from './lib/canvas-lock.mjs'
import { DEFAULT_PORT, EXIT_CANVAS_BUSY, EXIT_PORT_TAKEN, SERVICE_NAME, localIdentity, serviceVerdict } from './lib/identity.mjs'
import { RUNTIME_DIR, SERVICE_LOG, loadOrCreateToken } from './lib/token.mjs'

export const SERVICE_ENTRY = process.env.COWART_BUNDLED === '1'
  ? join(ADAPTERS_DIR, 'generated', 'cowart-service.mjs')
  : join(ADAPTERS_DIR, 'service', 'bin', 'cowart-service.mjs')
// Ports held by something else (another program, a pre-service adapter) are skipped.
export const PORT_ATTEMPTS = 20
const PROBE_TIMEOUT_MS = 4_000
// How long a port that is taken but does not answer is asked again (see probeService).
const UNSURE_MS = 10_000
const RETRY_MS = 200
const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 10_000
// Services a bridge starts for one port before it gives up: another bridge's service can
// bind the port first, and a service that is stopping can still have the canvas.
const START_ATTEMPTS = 5
const CALL_TIMEOUT_MS = 600_000
const RECONNECT_MAX_MS = 5_000
const LOG_LIMIT_BYTES = 5 * 1024 * 1024

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

// Binding is instant; on Windows a refused connection to a closed port takes a second or two.
// But the test holds the port for that moment: a service that starts then cannot bind it,
// and another bridge's probe then connects to the test (dropped at once). So only a
// bridge's first look at a port binds it.
function portIsFree(port) {
  return new Promise((resolveFree) => {
    const tester = net.createServer((socket) => socket.destroy())
    tester.once('error', () => resolveFree(false))
    tester.listen(port, '127.0.0.1', () => tester.close(() => resolveFree(true)))
  })
}

// free: nothing listens. cowart: a canvas service (with its status). foreign: something else
// answered, HTTP that is not a canvas service's status or not HTTP at all. unsure: the port
// is taken but gave no answer (a reset or closed connection, a timeout). A canvas service
// that is stopping or starting, and other bridges testing the port, look like that for a
// moment, so callers ask again rather than take it for another program: on 2026-09-15 a
// bridge that did started a second service on the same canvas. bind: false only connects.
export async function probeService(port, token, { bind = true } = {}) {
  if (bind && (await portIsFree(port))) return { kind: 'free' }
  let response
  let body
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/service`, {
      headers: { 'x-cowart-token': token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    body = await response.text()
  } catch (error) {
    const code = String(error?.cause?.code ?? error?.name ?? 'error')
    if (code === 'ECONNREFUSED') return { kind: 'free' }
    return code.startsWith('HPE_') ? { kind: 'foreign', reason: code } : { kind: 'unsure', reason: code }
  }
  let payload = null
  try {
    payload = JSON.parse(body)
  } catch {
    // Not JSON: not a canvas service.
  }
  if (response.ok && payload?.service === SERVICE_NAME) return { kind: 'cowart', status: payload }
  return { kind: 'foreign', reason: `HTTP ${response.status}` }
}

// The first canvas service from port upward, where a bridge would find it (a port that does
// not answer yet is asked again); exact: on this port and no other.
export async function findService({ port = DEFAULT_PORT, token, exact = false } = {}) {
  for (let offset = 0; offset < (exact ? 1 : PORT_ATTEMPTS); offset += 1) {
    let probe = await probeService(port + offset, token)
    for (const deadline = Date.now() + UNSURE_MS; probe.kind === 'unsure' && Date.now() < deadline; ) {
      await delay(RETRY_MS)
      probe = await probeService(port + offset, token, { bind: false })
    }
    if (probe.kind === 'cowart') return { port: port + offset, status: probe.status }
  }
  return null
}

// Asks the service on `port` to stop and waits until its process is gone: its port closes
// first, but it has the canvas until its last write.
export async function stopService(port, token, reason = 'requested', { pid } = {}) {
  pid ??= (await probeService(port, token, { bind: false })).status?.pid
  await fetch(`http://127.0.0.1:${port}/api/service/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  }).catch(() => {})
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pid ? !isAlive(pid) : await portIsFree(port)) return true
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
// exitCode stays null while the service runs (EXIT_* in identity.mjs say why one did not).
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
    const started = { pid: child.pid, exitCode: null }
    child.on('error', () => {
      started.exitCode ??= -1
    })
    child.on('exit', (code) => {
      started.exitCode = code ?? -1
    })
    child.unref()
    return started
  } finally {
    closeSync(out)
  }
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
      for (let attempt = 0; ; attempt += 1) {
        this.#port = await this.#locate({ allowReplace: allowReplace && attempt === 0 })
        try {
          return await this.#openSessionStream()
        } catch (error) {
          // The service stopped between answering and taking the session (it was being
          // replaced): find the one that runs now.
          if (attempt >= 2 || this.#closed) throw error
        }
      }
    })().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #locate({ allowReplace }) {
    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
      const port = await this.#settle(this.basePort + offset, { allowReplace })
      if (port) return port
    }
    throw new Error(`端口 ${this.basePort}–${this.basePort + PORT_ATTEMPTS - 1} 都被别的程序占着，画布服务起不来。`)
  }

  // Gets a canvas service this bridge can use on `port`: the one there (replaced first, at
  // startup and once, when it runs older code of this checkout) or one this bridge starts.
  // Returns the port to use; null only when another program holds the port for sure. A
  // port that is taken but does not answer is asked again, not skipped: moving on would
  // start a second service on the same canvas (which the canvas lock turns away).
  async #settle(port, { allowReplace }) {
    let mayReplace = allowReplace
    let started = null
    let starts = 0
    let waitingFor = null
    let unsureSince = null
    let deadline = Date.now() + READY_TIMEOUT_MS
    for (let look = 0; ; look += 1) {
      // Only the first look binds the port: later ones must not take it from a service that
      // is starting.
      const probe = await probeService(port, this.#token, { bind: look === 0 })
      unsureSince = probe.kind === 'unsure' ? (unsureSince ?? Date.now()) : null
      if (probe.kind === 'foreign') {
        this.log(`port ${port} is held by another program (${probe.reason})`)
        return null
      }
      if (probe.kind === 'cowart') {
        const { status } = probe
        const verdict = serviceVerdict(status, this.#mine)
        if (verdict === 'reuse') return port
        if (verdict === 'replace' && mayReplace) {
          this.log(`replacing the canvas service on ${port} (build ${status.build} → ${this.#mine.build})`)
          if (!(await stopService(port, this.#token, 'replaced', { pid: status.pid }))) throw new Error(`旧的画布服务（端口 ${port}）没有按时退出。`)
          // Once: the service that runs next may be one that another bridge started.
          mayReplace = false
          deadline = Date.now() + READY_TIMEOUT_MS
          continue
        }
        if (status.protocol !== this.#mine.protocol) {
          throw new Error(starts > 0
            ? `画布服务（${status.version}，协议 ${status.protocol}）跟这个会话的 cowart 不兼容：重开这个会话即可。`
            : `画布服务（${status.version}，协议 ${status.protocol}）比这个会话的 cowart 新：重开这个会话即可。`)
        }
        if (starts > 0) this.log(`canvas service on ${port} (pid ${status.pid})`)
        return port
      }
      if (Date.now() > deadline) throw new Error(`画布服务没能启动（端口 ${port}），日志在 ${SERVICE_LOG}。`)
      if (probe.kind === 'unsure') {
        if (Date.now() - unsureSince > UNSURE_MS) {
          throw new Error(`端口 ${port} 被占着却一直没有回应（${probe.reason}）：可能是卡住的画布服务，也可能是别的程序。结束它，或设 COWART_CLAUDE_PORT 换个端口。`)
        }
        await delay(RETRY_MS)
        continue
      }
      // Free. Wait while the service this bridge started is coming up, or while the service
      // that has the canvas finishes on this port.
      if ((started && started.exitCode === null) || (waitingFor && isAlive(waitingFor))) {
        await delay(RETRY_MS)
        continue
      }
      if (started) {
        const { exitCode } = started
        started = null
        if (exitCode === EXIT_CANVAS_BUSY) {
          const owner = canvasOwner(SHARED_CANVAS_DIR)
          if (owner && owner.port !== port) return this.#joinOwner(owner, port)
          waitingFor = owner?.pid ?? null
        } else if (exitCode !== EXIT_PORT_TAKEN) {
          throw new Error(`画布服务没能启动（端口 ${port}，退出码 ${exitCode}），日志在 ${SERVICE_LOG}。`)
        }
        continue
      }
      if (starts >= START_ATTEMPTS) throw new Error(`画布服务没能启动（端口 ${port}），日志在 ${SERVICE_LOG}。`)
      // Bridges racing here are fine: the port lets one of the services they start bind, and
      // the canvas lock lets one of them have the canvas.
      started = spawnService(port, { entry: this.entry })
      starts += 1
      mayReplace = false
    }
  }

  // The canvas is served on another port (its lock says so), so no service starts on this
  // one: use that service once it answers.
  async #joinOwner(owner, port) {
    const deadline = Date.now() + UNSURE_MS
    for (;;) {
      const probe = await probeService(owner.port, this.#token, { bind: false })
      if (probe.kind === 'cowart' && probe.status.protocol === this.#mine.protocol) {
        this.log(`the canvas is served on port ${owner.port} (pid ${probe.status.pid}), not on ${port}`)
        return owner.port
      }
      if (probe.kind === 'foreign' || probe.kind === 'cowart' || !isAlive(owner.pid) || Date.now() > deadline) {
        throw new Error(`这张画布（${SHARED_CANVAS_DIR}）由端口 ${owner.port} 上的画布服务（pid ${owner.pid}）在用，端口 ${port} 上不能再起一个，而那个服务这个会话连不上（${probe.reason ?? probe.kind}）。`)
      }
      await delay(RETRY_MS)
    }
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
