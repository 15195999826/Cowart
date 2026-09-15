// The machine-wide canvas service process: the machine's one canvas (SHARED_CANVAS_DIR),
// one upstream Cowart server, one request queue and one writer, shared by every session
// bridge (FORK.md). It has the canvas (canvas-lock.mjs) from before it listens until its
// last write, and exits after it has sat idle (no bridge connected, no canvas page open)
// for a while.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveCowartPaths } from '../../../mcp/lib/canvas-storage.mjs'
import { DEFAULT_IMAGE_MODEL_ID, imageModelsForHost } from '../../shared/image-models.mjs'
import { ADAPTERS_DIR, SHARED_CANVAS_DIR } from '../../shared/paths.mjs'
import { UpstreamCowart } from '../../shared/upstream.mjs'
import { DEFAULT_VIDEO_MODEL_ID, VIDEO_MODELS } from '../../shared/video-models.mjs'
import { injectIntoHead, jsonForInlineScript, readUpstreamWidgetHtml, scriptTag, sharedPageScripts } from '../../shared/widget-html.mjs'
import { CanvasGuard } from './canvas-guard.mjs'
import { acquireCanvasLock } from './canvas-lock.mjs'
import { CanvasOps } from './canvas-ops.mjs'
import { GenerationJobs } from './generation-jobs.mjs'
import { EXIT_CANVAS_BUSY, EXIT_PORT_TAKEN, localIdentity } from './identity.mjs'
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

export async function startCanvasService({ port }) {
  const log = (message) => process.stderr.write(`[cowart-service ${new Date().toISOString()}] ${message}\n`)
  const identity = localIdentity()
  const token = await loadOrCreateToken()
  // One service per canvas: while another service has it (on another port, or finishing on
  // this one), this one does not start.
  let lock
  try {
    lock = await acquireCanvasLock(SHARED_CANVAS_DIR, { port })
  } catch (error) {
    if (error.code !== 'ECANVASBUSY') throw error
    log(`canvas ${SHARED_CANVAS_DIR} is served by pid ${error.owner.pid} on port ${error.owner.port}, not starting a second service`)
    process.exit(EXIT_CANVAS_BUSY)
  }
  process.on('exit', () => lock.release())
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

  try {
    await server.start({ port })
  } catch (error) {
    // Taken after all (a service of another canvas, or a bridge testing the port this
    // moment): the bridge that started this one looks at the port again.
    if (error.code === 'EADDRINUSE') {
      lock.release()
      log(`port ${port} is taken, leaving it to the service already there`)
      process.exit(EXIT_PORT_TAKEN)
    }
    throw error
  }
  log(`listening on ${server.origin} (pid ${process.pid}, version ${identity.version}, build ${identity.build}, root ${identity.root}, canvas ${SHARED_CANVAS_DIR})`)
  updateIdle()
  upstream.listTools().catch((error) => log(`upstream Cowart server failed to start: ${error.message}`))
  process.on('SIGINT', () => shutdown('signal'))
  process.on('SIGTERM', () => shutdown('signal'))
}
