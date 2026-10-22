#!/usr/bin/env node
// Manual test harness: a Claude session without Claude Code. It runs the cowart command's code
// (lib/cli.mjs) the way a session's commands do, opens the canvas, keeps the session's listener
// connected (the session is online, and its canvas requests are printed here), and exposes the
// tools on a control port.
// Usage: node dev-host.mjs --project <dir> [--session <id>] [--control-port 43299] [--canvas <dir>]
//   curl -X POST -H "x-cowart-dev: 1" http://127.0.0.1:43299/call -d '{"name":"list_cowart_requests","arguments":{}}'
// The custom header keeps other local web pages from driving the adapter (it forces a CORS preflight).
// --canvas gives a service this starts a canvas of its own instead of the machine's; only with
// COWART_CLAUDE_PORT set to a port of its own, so the machine's service never gets it.
import http from 'node:http'
import { resolve } from 'node:path'

import { CanvasServiceClient, readEventStream } from '../../service/client.mjs'
import { DEFAULT_PORT } from '../../service/lib/identity.mjs'
import { callTool, resultText } from '../lib/cli.mjs'
import { requestNotice } from '../lib/request-notice.mjs'
import { RENDER_TOOL } from '../lib/tools.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const projectDir = resolve(option('project') || process.cwd())
const controlPort = Number(option('control-port')) || 43299
const canvasDir = option('canvas') ? resolve(option('canvas')) : null
const port = Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT
if (canvasDir && port === DEFAULT_PORT) {
  console.error('--canvas 只给独立的测试服务用：同时把 COWART_CLAUDE_PORT 设成另一个端口，免得机器上的画布服务换了画布。')
  process.exit(1)
}
// A service this starts keeps that canvas.
if (canvasDir) process.env.COWART_CANVAS_DIR = canvasDir

// Its own session id, so it never takes over the pages of the Claude session it runs in.
const session = option('session') || 'dev-host'
const client = new CanvasServiceClient({ host: 'claude', session, cwd: projectDir, port, command: true, log: (message) => console.error(`[dev-host] ${message}`) })
await client.start()
console.log(resultText(await callTool(client, RENDER_TOOL, { projectDir })))

// The session's listener, staying connected after a request (a session's `cowart listen` exits).
;(async () => {
  for (;;) {
    try {
      const query = new URLSearchParams({ session, presence: '1', host: 'claude' })
      const response = await fetch(`${client.origin}/api/agent-events?${query}`, { headers: { accept: 'text/event-stream', 'x-cowart-token': client.token } })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await readEventStream(response.body, (event, data) => {
        if (event === 'request') console.log(`\n${requestNotice(data, { details: (id) => `POST /call {"name":"get_cowart_request","arguments":{"id":${id}}}` })}`)
        if (event === 'cancelled') console.log(`\nCowart 画布请求 #${data.id} 已在画布上撤销`)
      })
    } catch (error) {
      console.error(`[dev-host] listener: ${error.message}`)
    }
    await new Promise((done) => setTimeout(done, 1000))
    await client.reconnect().catch((error) => console.error(`[dev-host] ${error.message}`))
  }
})()

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/call') {
      res.writeHead(404).end()
      return
    }
    if (req.headers['x-cowart-dev'] !== '1') {
      res.writeHead(403).end('missing x-cowart-dev header')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { name, arguments: args } = JSON.parse(body || '{}')
      const result = await callTool(client, name, args || {})
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result, null, 2))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message }))
    }
  })
  .listen(controlPort, '127.0.0.1', () => {
    console.log(`control: POST http://127.0.0.1:${controlPort}/call {"name": "...", "arguments": {...}}`)
  })
