#!/usr/bin/env node
// Manual test harness: runs the Claude adapter the way Claude Code does (MCP over stdio),
// opens a canvas, and exposes the adapter's tools on a control port.
// Usage: node dev-host.mjs --project <dir> [--control-port 43299]
//   curl -X POST -H "x-cowart-dev: 1" http://127.0.0.1:43299/call -d '{"name":"list_cowart_requests","arguments":{}}'
// The custom header keeps other local web pages from driving the adapter (it forces a CORS preflight).
import http from 'node:http'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { ADAPTERS_DIR } from '../../shared/paths.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const projectDir = resolve(option('project') || process.cwd())
const controlPort = Number(option('control-port')) || 43299

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-claude-mcp.mjs')],
  cwd: projectDir,
  env: { ...process.env },
  stderr: 'inherit'
})
const client = new Client({ name: 'cowart-dev-host', version: '0.0.0' })
await client.connect(transport)

const rendered = await client.callTool({ name: 'render_cowart_canvas_widget', arguments: { projectDir } })
console.log(rendered.content[0].text)

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
      const result = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 600_000 })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result, null, 2))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message }))
    }
  })
  .listen(controlPort, '127.0.0.1', () => {
    console.log(`control: POST http://127.0.0.1:${controlPort}/call {"name": "...", "arguments": {...}}`)
  })
