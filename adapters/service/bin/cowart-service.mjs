#!/usr/bin/env node
// The machine-wide Cowart canvas service. Session bridges start it in the background (see
// adapters/service/client.mjs); by hand:
//   node cowart-service.mjs --port 43240   run it in the foreground
//   node cowart-service.mjs --status       show the running service and its sessions
//   node cowart-service.mjs --stop         stop it (bridges start a new one when needed)
//   node cowart-service.mjs --import <canvas or project dir> …
//                                          move the pages of old per-project canvases into
//                                          the machine's one canvas (the sources stay as they are)
// --status looks for the service the way bridges do, from the port (43240 unless one is given)
// upward. So does --stop without a port, and it stops the service only when it keeps the
// machine's canvas; with a port given (--port or COWART_CLAUDE_PORT) it looks at that port and
// no other: going on from an empty one once stopped another session's dev host (2026-09-15).
import { DEFAULT_PORT, samePath } from '../lib/identity.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

// A --port without a number must not pass for no port at all.
if (process.argv.includes('--port') && !(Number(option('port')) > 0)) {
  console.error('--port 后面要写端口号。')
  process.exit(1)
}
const givenPort = Number(option('port')) || Number(process.env.COWART_CLAUDE_PORT) || 0
const port = givenPort || DEFAULT_PORT

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
  const { PORT_ATTEMPTS, findService, stopService } = await import('../client.mjs')
  const { loadOrCreateToken } = await import('../lib/token.mjs')
  const { SHARED_CANVAS_DIR } = await import('../../shared/paths.mjs')
  const stopping = process.argv.includes('--stop')
  const token = await loadOrCreateToken()
  const found = await findService({ port, token, exact: stopping && Boolean(givenPort) })
  if (!found) {
    console.log(
      stopping && givenPort
        ? `端口 ${port} 上没有在跑的 Cowart 画布服务，什么也没停（给了端口就只看这一个端口）。`
        : `没有在跑的 Cowart 画布服务（查了端口 ${port}–${port + PORT_ATTEMPTS - 1}）。`
    )
    process.exit(0)
  }
  const service = `端口 ${found.port} 上的画布服务（pid ${found.status.pid}，${found.status.canvasDir ? `画布 ${found.status.canvasDir}` : '按项目存画布的旧版'}）`
  if (!stopping) {
    if (found.port !== port) console.log(`端口 ${port} 上没有画布服务，往后找到的是${service}：`)
    console.log(JSON.stringify(found.status, null, 2))
  } else if (!givenPort && found.status.canvasDir && !samePath(found.status.canvasDir, SHARED_CANVAS_DIR)) {
    // Found by looking: a service on a canvas of its own is a check's or a dev host's. Services
    // from before the one canvas report none; they are the machine's all the same.
    console.log(`${service}用的不是这台机器的画布（${SHARED_CANVAS_DIR}），没停：多半是测试或联调宿主的。确实要停它就用 --port ${found.port}。`)
    process.exit(1)
  } else {
    console.log(`停止${service}…`)
    const stopped = await stopService(found.port, token, 'stopped by hand')
    console.log(stopped ? '已停止。' : '没有按时退出。')
    process.exit(stopped ? 0 : 1)
  }
} else {
  const { startCanvasService } = await import('../lib/service.mjs')
  await startCanvasService({ port }).catch((error) => {
    process.stderr.write(`[cowart-service] failed to start: ${error?.stack || error}\n`)
    process.exit(1)
  })
}
