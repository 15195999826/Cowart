// Delivers a session's canvas requests. The session runs it as a background task (Bash with
// run_in_background): it waits, costing the session nothing, until the canvas sends a request
// (or withdraws one it sent), prints that batch and exits. The exit is what wakes the session
// up, and nothing else ends a run: there is no timer, and a service that goes away (a newer
// version replacing it) is waited for. The service replays undelivered requests when the next
// run connects, so the session handles a batch and starts it again. ZCode runs it as
// cowart-listen.mjs (a fixed port), Claude Code as `cowart listen` (cli.mjs), whose listener
// also keeps the session online.
import { readEventStream } from '../../service/client.mjs'
import { requestNotice } from './request-notice.mjs'

const RETRY_MS = 300
const RETRY_MAX_MS = 30_000
// A run exits once the events go quiet, not after the very first one: the service replays
// every undelivered request the moment a listener connects, and an exit on the first event
// would drop the rest of that burst (they are marked delivered, so nobody re-sends them).
const DRAIN_MS = 750

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function emit(line) {
  process.stdout.write(`${line}\n`)
}

// target(): { url, token } of the event stream to read now (asked again after every drop; a
// throw counts as a drop). reopen: what to do when the service turns the listener away.
// details: how the printed lines say to read a request (request-notice.mjs).
export async function listenForRequests({ target, reopen, details, debug = () => {} }) {
  let drainTimer = null
  // After the first event, wait for the burst to finish before exiting.
  const armDrain = () => {
    drainTimer ??= setTimeout(() => process.exit(0), DRAIN_MS)
  }
  // The service going away (a newer version replacing it, the machine waking from sleep) drops
  // the stream: connect again, soon at first, then every half minute for as long as it takes.
  // A run that gave up would wake an idle session for nothing.
  let failures = 0
  for (;;) {
    try {
      const { url, token } = await target()
      const response = await fetch(url, { headers: { accept: 'text/event-stream', 'x-cowart-token': token } })
      if (response.status === 403 || response.status === 400) {
        const payload = await response.json().catch(() => ({}))
        emit(`Cowart 画布监听：${payload.error || '本地服务拒绝了监听'}，已退出；${reopen}`)
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
          emit(`Cowart 画布监听：这个会话跟画布服务断开了，监听退出。用户要接着用画布时，${reopen}`)
          process.exit(0)
        }
        if (event === 'request') {
          emit(requestNotice(data, { details }))
          armDrain()
        }
        if (event === 'cancelled') {
          emit(`Cowart 画布请求 #${data.id}「${data.title}」已在画布上撤销：不用处理了（如果正在用 AskUserQuestion 问用户，这条就不必再执行）`)
          armDrain()
        }
      })
      throw new Error('stream closed')
    } catch (error) {
      debug(`disconnected: ${error.message}`)
      await delay(Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures))
      failures = Math.min(failures + 1, 10)
    }
  }
}
