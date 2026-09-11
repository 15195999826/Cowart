#!/usr/bin/env node
// Run by Claude's Monitor tool: prints one line per Cowart canvas request so the session
// wakes up. Usage: node cowart-listen.mjs --port <port>
import { readToken } from '../lib/token.mjs'

const GIVE_UP_MS = 120_000
const RETRY_MS = 2_000

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(line) {
  process.stdout.write(`${line}\n`)
}

function formatRequest(request) {
  const summary = request.summary ? `：${request.summary}` : ''
  return `Cowart 画布请求 #${request.id}「${request.title}」${summary} → 先调 get_cowart_request {"id": ${request.id}} 看详情，再用 AskUserQuestion 请用户确认（执行 / 跳过）`
}

const port = Number(option('port'))
if (!Number.isInteger(port) || port <= 0) {
  emit('Cowart 画布监听：缺少 --port 参数，已退出。')
  process.exit(1)
}
const url = `http://${option('host') || '127.0.0.1'}:${port}/api/agent-events`

async function listenOnce(token) {
  const response = await fetch(url, { headers: { accept: 'text/event-stream', 'x-cowart-token': token } })
  if (response.status === 403) {
    emit('Cowart 画布监听：本地服务拒绝了令牌，已退出；重新打开画布即可拿到新的监听命令。')
    process.exit(1)
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  process.stderr.write(`connected to ${url}\n`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream closed')
    lastAlive = Date.now()
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
      if (event === 'replaced') {
        emit('Cowart 画布监听：已有新的监听接替，本监听退出。')
        process.exit(0)
      }
      if (event === 'request' && data) emit(formatRequest(JSON.parse(data)))
      if (event === 'cancelled' && data) {
        const request = JSON.parse(data)
        emit(`Cowart 画布请求 #${request.id}「${request.title}」已在画布上撤销：不用处理了（如果正在用 AskUserQuestion 问用户，这条就不必再执行）`)
      }
    }
  }
}

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
      emit(`Cowart 画布监听：连不上本地服务超过 2 分钟（${error.message}），已退出；重新打开画布时会给出新的监听命令。`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
}
