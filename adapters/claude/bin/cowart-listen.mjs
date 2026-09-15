#!/usr/bin/env node
// Run by Claude's Monitor tool: prints one line per canvas request of this session so the
// session wakes up. Usage: node cowart-listen.mjs --port <port> --session <id> [--once]
// ZCode has no Monitor: its bridge passes --once and runs this as a background task that
// exits after the first request/cancelled event (the exit is what wakes the session up);
// the service replays undelivered requests when the next listener connects.
import { readEventStream } from '../../service/client.mjs'
import { readToken } from '../../service/lib/token.mjs'
import { requestNotice } from '../lib/request-notice.mjs'

const GIVE_UP_MS = 120_000
const RETRY_MS = 2_000
const ONCE = process.argv.includes('--once')
// --once exits after the events go quiet, not after the very first one: the service replays
// every undelivered request the moment a listener connects, and an exit on the first event
// would drop the rest of that burst (they are marked delivered, so nobody re-sends them).
const ONCE_DRAIN_MS = 750
let onceDrainTimer = null
// Claude Code's Monitor ends a watch after at most 30 minutes. Leaving a little earlier with a
// line that says so wakes the session with what to do, instead of the canvas quietly going
// without a listener until someone notices.
const LIFETIME_MS = Number(process.env.COWART_LISTEN_LIFETIME_MS) || 29 * 60_000

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(line) {
  process.stdout.write(`${line}\n`)
}

// --only with --once: after the first event, wait for the burst to finish before exiting.
function armOnceDrain() {
  if (!ONCE || onceDrainTimer) return
  onceDrainTimer = setTimeout(() => process.exit(0), ONCE_DRAIN_MS)
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
const url = `http://${option('host') || '127.0.0.1'}:${port}/api/agent-events?session=${encodeURIComponent(session)}`

if (!ONCE) {
  setTimeout(() => {
    emit('Cowart 画布监听：这一轮快到 Monitor 的 30 分钟上限了，先退出。马上用同一条命令重新启动监听（Monitor，timeout_ms: 1800000），不然画布请求只会排队。')
    process.exit(0)
  }, LIFETIME_MS)
}

async function listenOnce(token) {
  const response = await fetch(url, { headers: { accept: 'text/event-stream', 'x-cowart-token': token } })
  if (response.status === 403 || response.status === 400) {
    const payload = await response.json().catch(() => ({}))
    emit(`Cowart 画布监听：${payload.error || '本地服务拒绝了监听'}，已退出；重新打开画布即可拿到新的监听命令。`)
    process.exit(1)
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  process.stderr.write(`connected to ${url}\n`)
  try {
    await readEventStream(response.body, (event, data) => {
      if (event === 'replaced') {
        emit('Cowart 画布监听：已有新的监听接替，本监听退出。')
        process.exit(0)
      }
      if (event === 'session-ended') {
        emit('Cowart 画布监听：这个会话跟画布服务断开了，本监听退出；重新打开画布时会给出新的监听命令。')
        process.exit(0)
      }
      if (event === 'request') {
        emit(requestNotice(data))
        armOnceDrain()
      }
      if (event === 'cancelled') {
        emit(`Cowart 画布请求 #${data.id}「${data.title}」已在画布上撤销：不用处理了（如果正在用 AskUserQuestion 问用户，这条就不必再执行）`)
        armOnceDrain()
      }
    })
  } finally {
    lastAlive = Date.now()
  }
  throw new Error('stream closed')
}

// A service restart (a newer version replacing it) drops the stream; keep trying for a while.
let lastAlive = Date.now()
for (;;) {
  const token = await readToken()
  if (!token) {
    emit('Cowart 画布监听：找不到本地令牌（~/.cowart-claude/token），先打开一次画布再启动监听。')
    process.exit(1)
  }
  try {
    await listenOnce(token)
  } catch (error) {
    process.stderr.write(`disconnected: ${error.message}\n`)
    if (Date.now() - lastAlive > GIVE_UP_MS) {
      emit(`Cowart 画布监听：连不上画布服务超过 2 分钟（${error.message}），已退出；重新打开画布时会给出新的监听命令。`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
}
