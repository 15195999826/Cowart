#!/usr/bin/env node
// The machine-wide Cowart canvas service. Session bridges start it in the background (see
// adapters/service/client.mjs); by hand:
//   node cowart-service.mjs --port 43240   run it in the foreground
//   node cowart-service.mjs --status       show the running service and its sessions
//   node cowart-service.mjs --stop         stop it (bridges start a new one when needed)
//   node cowart-service.mjs --import <canvas or project dir> …
//                                          move the pages of old per-project canvases into
//                                          the machine's one canvas (the sources stay as they are)
import { DEFAULT_PORT } from '../lib/identity.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(option('port')) || Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT

if (process.argv.includes('--import')) {
  const { findService, stopService } = await import('../client.mjs')
  const { loadOrCreateToken } = await import('../lib/token.mjs')
  const { importCanvasPages } = await import('../lib/canvas-import.mjs')
  const { SHARED_CANVAS_DIR } = await import('../../shared/paths.mjs')
  const sources = process.argv.slice(process.argv.indexOf('--import') + 1).filter((arg) => !arg.startsWith('--'))
  if (sources.length === 0) {
    console.log('用法：node cowart-service.mjs --import <旧画布目录或项目目录> …')
    process.exit(1)
  }
  const token = await loadOrCreateToken()
  const found = await findService({ port, token })
  // A service on this canvas could save a page that never saw the moved pages and drop them;
  // the sessions start it again right away.
  if (found?.status.canvasDir === SHARED_CANVAS_DIR) {
    if (!(await stopService(found.port, token, 'importing pages'))) {
      console.log(`端口 ${found.port} 上的画布服务没有按时退出，没搬。`)
      process.exit(1)
    }
    console.log(`先停了端口 ${found.port} 上的画布服务，会话会马上重新拉起它。`)
  }
  for (const result of await importCanvasPages({ sources, into: SHARED_CANVAS_DIR })) {
    console.log(
      result.skipped
        ? `跳过${result.name ? `「${result.name}」` : ` ${result.source}`}：${result.skipped}`
        : `搬入「${result.name}」（${result.pageId}，${result.assets} 个素材）← ${result.source}`
    )
  }
  console.log(`画布：${SHARED_CANVAS_DIR}`)
  if (found && !found.status.canvasDir) {
    console.log(`端口 ${found.port} 上跑的是按项目存画布的旧版服务：用 --stop 停掉它，会话会用新版重新拉起，改用这张画布。`)
  }
} else if (process.argv.includes('--status') || process.argv.includes('--stop')) {
  const { findService, stopService } = await import('../client.mjs')
  const { loadOrCreateToken } = await import('../lib/token.mjs')
  const token = await loadOrCreateToken()
  const found = await findService({ port, token })
  if (!found) {
    console.log(`没有在跑的 Cowart 画布服务（查了 ${port} 起的端口）。`)
    process.exit(0)
  }
  if (process.argv.includes('--stop')) {
    const stopped = await stopService(found.port, token, 'stopped by hand')
    console.log(stopped ? `已停止端口 ${found.port} 上的画布服务（pid ${found.status.pid}）。` : `端口 ${found.port} 上的画布服务没有按时退出。`)
    process.exit(stopped ? 0 : 1)
  }
  console.log(JSON.stringify(found.status, null, 2))
} else {
  const { startCanvasService } = await import('../lib/service.mjs')
  await startCanvasService({ port }).catch((error) => {
    process.stderr.write(`[cowart-service] failed to start: ${error?.stack || error}\n`)
    process.exit(1)
  })
}
