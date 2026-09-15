#!/usr/bin/env node
// Delivers this session's canvas requests. Claude Code and ZCode run it as a background task
// (Bash with run_in_background) with --once: it waits, costing the session nothing, until the
// canvas sends a request (or withdraws one it sent), prints that batch and exits. The exit is
// what wakes the session up, and nothing else ends a run: there is no timer, and a service that
// goes away (a newer version replacing it) is waited for. The service replays undelivered
// requests when the next run connects, so the session handles a batch and starts it again.
// Usage: node cowart-listen.mjs --port <port> --session <id> --once
// Without --once it is the older command for Claude Code's Monitor, which ends a watch after at
// most 30 minutes and wakes the session to say so, idle or not: it says how to run it now and
// leaves.
import { readEventStream } from '../../service/client.mjs'
import { readToken } from '../../service/lib/token.mjs'
import { listenCommand, requestNotice } from '../lib/request-notice.mjs'

const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
// A run exits once the events go quiet, not after the very first one: the service replays
// every undelivered request the moment a listener connects, and an exit on the first event
// would drop the rest of that burst (they are marked delivered, so nobody re-sends them).
const DRAIN_MS = 750
// Connection notes go to stderr, which lands in the output file the session reads when the run
// ends, so they are only written when asked for.
const DEBUG = Boolean(process.env.COWART_LISTEN_DEBUG)

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(line) {
  process.stdout.write(`${line}\n`)
}

function debug(line) {
  if (DEBUG) process.stderr.write(`${line}\n`)
}

let drainTimer = null
// After the first event, wait for the burst to finish before exiting.
function armDrain() {
  drainTimer ??= setTimeout(() => process.exit(0), DRAIN_MS)
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

let failures = 0
async function listen(token) {
  const response = await fetch(url, { headers: { accept: 'text/event-stream', 'x-cowart-token': token } })
  if (response.status === 403 || response.status === 400) {
    const payload = await response.json().catch(() => ({}))
    emit(`Cowart 画布监听：${payload.error || '本地服务拒绝了监听'}，已退出；重新打开画布即可拿到新的监听命令。`)
    process.exit(1)
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  debug(`connected to ${url}`)
  failures = 0
  await readEventStream(response.body, (event, data) => {
    if (event === 'replaced') {
      emit('Cowart 画布监听：这个会话又启动了一个监听，这个就退出了，不用处理。')
      process.exit(0)
    }
    if (event === 'session-ended') {
      emit('Cowart 画布监听：这个会话跟画布服务断开了，监听退出。用户要接着用画布时，重新打开画布（render_cowart_canvas_widget），照结果再启动监听。')
      process.exit(0)
    }
    if (event === 'request') {
      emit(requestNotice(data))
      armDrain()
    }
    if (event === 'cancelled') {
      emit(`Cowart 画布请求 #${data.id}「${data.title}」已在画布上撤销：不用处理了（如果正在用 AskUserQuestion 问用户，这条就不必再执行）`)
      armDrain()
    }
  })
  throw new Error('stream closed')
}

// The service going away (a newer version replacing it, the machine waking from sleep) drops
// the stream: connect again, soon at first, then every half minute for as long as it takes.
// A run that gave up would wake an idle session for nothing.
for (;;) {
  const token = await readToken()
  if (!token) {
    emit('Cowart 画布监听：找不到本地令牌（~/.cowart-claude/token），先打开一次画布再启动监听。')
    process.exit(1)
  }
  try {
    await listen(token)
  } catch (error) {
    debug(`disconnected: ${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures)))
    failures = Math.min(failures + 1, 10)
  }
}
