// The machine-wide canvas service process: the machine's one canvas (SHARED_CANVAS_DIR),
// one upstream Cowart server, one request queue and one writer, shared by every session
// bridge (FORK.md). It has the canvas (canvas-lock.mjs) from before it listens until its
// last write, and exits after it has sat idle (no bridge connected, no canvas page open)
// for a while. One that replaces a running service takes the canvas over first, then asks
// that service to stop and starts once it has exited.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { DEFAULT_IMAGE_MODEL_ID, imageModelsForHost } from '../../shared/image-models.mjs'
import { ADAPTERS_DIR, SHARED_CANVAS_DIR } from '../../shared/paths.mjs'
import { UpstreamCowart } from '../../shared/upstream.mjs'
import { DEFAULT_VIDEO_MODEL_ID, VIDEO_MODELS } from '../../shared/video-models.mjs'
import { injectIntoHead, jsonForInlineScript, readUpstreamWidgetHtml, scriptTag, sharedPageScripts } from '../../shared/widget-html.mjs'
import { CanvasGuard } from './canvas-guard.mjs'
import { acquireCanvasLock, canvasOwner, isAlive } from './canvas-lock.mjs'
import { CanvasOps } from './canvas-ops.mjs'
import { GenerationJobs } from './generation-jobs.mjs'
import { EXIT_CANVAS_BUSY, EXIT_PORT_TAKEN, EXIT_REPLACED_STUCK, REPLACE_WAIT_MS, domainPort, localIdentity } from './identity.mjs'
import { CanvasRequestQueue, REQUESTS_FILE_NAME } from './requests.mjs'
import { CanvasServer } from './server.mjs'
import { loadOrCreateToken } from './token.mjs'

// The canvas served to the browser is the local-server one (Claude Code desktop and ZCode
// share it); its host bridge lives with the Claude adapter. `host` is the opening session's
// host: it only changes the wording the page shows (hostLabel), not its behavior.
const PAGE_BRIDGE_SCRIPT = join(ADAPTERS_DIR, 'claude', 'web', 'bridge.js')
const PAGE_HOST = 'claude'
const PAGE_HOST_LABELS = { zcode: 'ZCode' }
const IDLE_MS = Number(process.env.COWART_SERVICE_IDLE_MS) || 10 * 60_000
// How long a service that took the canvas over keeps trying for its port: bridges testing it
// hold it for a moment, and the replaced service's bridges are waiting for this one.
const BIND_RETRY_MS = 3_000

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

// Asks the service this one replaces to stop (not another one that answers on its port by now)
// and waits for its process to end, its last write done. False when it does not exit.
async function retire({ port, pid, token, identity, log }) {
  const headers = { 'content-type': 'application/json', 'x-cowart-token': token }
  const ask = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(4_000), ...init })
  // No answer: it is stopping already, or too busy to say; asked all the same.
  const running = await ask('/api/service').then((response) => response.json()).catch(() => null)
  if (!running || running.pid === pid) {
    log(`took the canvas over from pid ${pid} on port ${port}, asking it to stop`)
    await ask('/api/service/shutdown', { method: 'POST', body: JSON.stringify({ reason: `replaced by ${identity.version}, pid ${process.pid}` }) }).catch(() => {})
  }
  for (const deadline = Date.now() + REPLACE_WAIT_MS; isAlive(pid); await delay(100)) {
    if (Date.now() > deadline) return false
  }
  return true
}

// replacing: the pid of the service on this port that this one replaces (a bridge found it
// running older code); see retire.
export async function startCanvasService({ port, replacing = null }) {
  const log = (message) => process.stderr.write(`[cowart-service ${new Date().toISOString()}] ${message}\n`)
  const identity = localIdentity()
  const token = await loadOrCreateToken()
  // One service per canvas: while another service has it (on another port, or finishing on
  // this one), this one does not start.
  let lock
  try {
    lock = await acquireCanvasLock(SHARED_CANVAS_DIR, { port, replacing })
  } catch (error) {
    if (error.code !== 'ECANVASBUSY') throw error
    log(`canvas ${SHARED_CANVAS_DIR} is served by pid ${error.owner.pid} on port ${error.owner.port}, not starting a second service`)
    process.exit(EXIT_CANVAS_BUSY)
  }
  process.on('exit', () => lock.release())
  // The canvas is this service's from here on, so bridges that come back while the replaced
  // service stops wait for this one, whatever their code: they start services of their own,
  // and those see the lock and leave (on 2026-10-10 an older checkout's did not wait). Nothing
  // here reads the canvas before the replaced service has written its last.
  if (replacing) {
    if (!(await retire({ port, pid: replacing, token, identity, log }))) {
      log(`pid ${replacing} did not exit within ${REPLACE_WAIT_MS / 1000} s of being asked to stop, leaving the canvas to it`)
      lock.handBack()
      process.exit(EXIT_REPLACED_STUCK)
    }
    if (!lock.reclaim()) {
      const owner = canvasOwner(SHARED_CANVAS_DIR)
      log(`canvas ${SHARED_CANVAS_DIR} was taken by pid ${owner?.pid} on port ${owner?.port} meanwhile, not starting a second service`)
      process.exit(EXIT_CANVAS_BUSY)
    }
  }
  // Upstream's own default canvas (for a call that names none) is the same one.
  process.env.COWART_CANVAS_DIR = SHARED_CANVAS_DIR
  const queue = new CanvasRequestQueue({ file: join(SHARED_CANVAS_DIR, REQUESTS_FILE_NAME) })
  const upstream = new UpstreamCowart({
    clientName: 'cowart-canvas-service',
    clientVersion: identity.version,
    onStderr: (chunk) => process.stderr.write(chunk)
  })
  const ops = new CanvasOps({ upstream, guard: new CanvasGuard(), log })
  const jobs = new GenerationJobs({ upstream, ops, queue, log, onActivity: () => updateIdle() })

  // The page to show: the one the session is responsible for (heldPageId), else `pageId`
  // (where the pane was when it reloaded), else `page` (a name, from older URLs).
  async function renderPage(searchParams, { heldPageId = null, host = null } = {}) {
    // Whatever canvas an older URL names, the page shows the machine's one canvas.
    const { projectDir } = resolveCowartPaths({ projectDir: searchParams.get('projectDir') ?? undefined })
    const hostLabel = PAGE_HOST_LABELS[host] || null
    const config = {
      token,
      session: searchParams.get('session') || '',
      projectDir,
      canvasDir: SHARED_CANVAS_DIR,
      page: searchParams.get('page') || null,
      pageId: searchParams.get('pageId') || null,
      heldPageId,
      title: searchParams.get('title') || 'Cowart Canvas',
      hostLabel,
      version: identity.version,
      protocol: identity.protocol
    }
    const hostConfig = {
      host: PAGE_HOST,
      hostName: hostLabel || undefined,
      videoModels: VIDEO_MODELS,
      defaultVideoModelId: DEFAULT_VIDEO_MODEL_ID,
      imageModels: imageModelsForHost(PAGE_HOST),
      defaultImageModelId: DEFAULT_IMAGE_MODEL_ID
    }
    const [widgetHtml, bridgeSource, pageRuntime, sharedScripts] = await Promise.all([
      readUpstreamWidgetHtml(),
      readFile(PAGE_BRIDGE_SCRIPT, 'utf8'),
      readFile(join(ADAPTERS_DIR, 'shared', 'web', 'service-bridge.js'), 'utf8'),
      sharedPageScripts(hostConfig)
    ])
    return injectIntoHead(
      widgetHtml,
      [
        scriptTag(`window.__COWART_CLAUDE__=${jsonForInlineScript(config)};`, 'cowartClaudeConfig'),
        scriptTag(bridgeSource, 'cowartClaudeBridge'),
        scriptTag(pageRuntime, 'cowartServiceBridge'),
        sharedScripts
      ].join('\n')
    )
  }

  let stopping = false
  let idleTimer = null
  const server = new CanvasServer({
    token,
    identity,
    canvasDir: SHARED_CANVAS_DIR,
    queue,
    ops,
    jobs,
    renderPage,
    log,
    onActivity: () => updateIdle(),
    onShutdownRequest: (reason) => shutdown(reason)
  })

  function updateIdle() {
    if (server.bridgeCount > 0 || server.pageCount > 0 || jobs.running > 0) {
      clearTimeout(idleTimer)
      idleTimer = null
      return
    }
    idleTimer ??= setTimeout(() => shutdown('idle'), IDLE_MS)
  }

  async function shutdown(reason) {
    if (stopping) return
    stopping = true
    log(`stopping (${reason})`)
    lock.stopping()
    await server.close({ reason }).catch(() => {})
    await upstream.close()
    // Its last write is done: the next service may have the canvas.
    lock.release()
    process.exit(0)
  }

  for (const deadline = Date.now() + (replacing ? BIND_RETRY_MS : 0); ; await delay(100)) {
    try {
      await server.start({ port, domainPort: domainPort() })
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (Date.now() < deadline) continue
      // Taken after all (a service of another canvas, or a bridge testing the port this
      // moment): the bridge that started this one looks at the port again.
      lock.release()
      log(`port ${port} is taken, leaving it to the service already there`)
      process.exit(EXIT_PORT_TAKEN)
    }
  }
  const pageOrigin = await server.refreshPageOrigin()
  const pages = pageOrigin === server.origin ? '' : `, pages at ${pageOrigin}`
  log(`listening on ${server.origin}${pages} (pid ${process.pid}, version ${identity.version}, build ${identity.build}, root ${identity.root}, canvas ${SHARED_CANVAS_DIR})`)
  updateIdle()
  upstream.listTools().catch((error) => log(`upstream Cowart server failed to start: ${error.message}`))
  process.on('SIGINT', () => shutdown('signal'))
  process.on('SIGTERM', () => shutdown('signal'))
}
