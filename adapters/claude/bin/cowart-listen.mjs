#!/usr/bin/env node
// Delivers this session's canvas requests for ZCode (see ../lib/listen.mjs; Claude Code runs
// `cowart listen` instead): run in the background with --once, it exits when a request comes.
// Usage: node cowart-listen.mjs --port <port> --session <id> --once
// Without --once it is the older command for Claude Code's Monitor, which ends a watch after at
// most 30 minutes and wakes the session to say so, idle or not: it says how to run it now and
// leaves.
import { readToken } from '../../service/lib/token.mjs'
import { emit, listenForRequests } from '../lib/listen.mjs'
import { listenCommand } from '../lib/request-notice.mjs'

// Connection notes go to stderr, which lands in the output file the session reads when the run
// ends, so they are only written when asked for.
const DEBUG = Boolean(process.env.COWART_LISTEN_DEBUG)
const REOPEN = '重新打开画布（render_cowart_canvas_widget），照结果再启动监听。'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(option('port'))
const session = option('session')
if (!Number.isInteger(port) || port <= 0) {
  emit('Cowart 画布监听：缺少 --port 参数，已退出。')
  process.exit(1)
}
if (!session) {
  emit('Cowart 画布监听：缺少 --session 参数（这是旧的监听命令），已退出；重新打开画布即可拿到新的监听命令。')
  process.exit(1)
}
if (!process.argv.includes('--once')) {
  const command = listenCommand({ script: process.argv[1], port, session })
  emit(`Cowart 画布监听的用法改了，这条命令已经退出：别再用 Monitor 跑它（Monitor 最多 30 分钟，到点就叫醒会话，空闲时也白耗 token）。改用 Bash 工具后台运行（run_in_background: true，description「Cowart 画布请求」）：${command}。它一直等着、不耗 token，画布上真来了请求才退出叫醒你（通知只带输出文件路径，先 Read 它）；处理完再这样启动一次。`)
  process.exit(0)
}
const url = `http://${option('host') || '127.0.0.1'}:${port}/api/agent-events?session=${encodeURIComponent(session)}`

await listenForRequests({
  reopen: REOPEN,
  debug: (line) => DEBUG && process.stderr.write(`${line}\n`),
  async target() {
    const token = await readToken()
    if (!token) {
      emit('Cowart 画布监听：找不到本地令牌（~/.cowart-claude/token），先打开一次画布再启动监听。')
      process.exit(1)
    }
    return { url, token }
  }
})
