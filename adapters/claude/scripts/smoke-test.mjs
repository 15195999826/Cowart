#!/usr/bin/env node
// End-to-end check of the Claude adapter without Claude Code: runs it over stdio against a
// throwaway project and exercises tools, the page API, video support and canvas requests.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { loadOrCreateToken } from '../lib/token.mjs'

const FIXTURES = join(ADAPTERS_DIR, 'claude', 'test', 'fixtures')
const PORT = Number(process.env.COWART_SMOKE_PORT) || 43290

let failures = 0
async function step(name, run) {
  try {
    await run()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ') ?? error}`)
  }
}

function text(result) {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
}

// Minimal SSE reader over fetch; returns an async queue of { event, data }.
function openEvents(url, headers) {
  const controller = new AbortController()
  const events = []
  const waiters = []
  const ready = fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
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
            if (!data) continue
            const item = { event, data: JSON.parse(data) }
            const waiter = waiters.findIndex((entry) => entry.match(item))
            if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(item)
            else events.push(item)
          }
        }
      } catch {
        // Aborted.
      }
    })()
  })
  return {
    ready,
    close: () => controller.abort(),
    next(match, timeoutMs = 5000) {
      const index = events.findIndex(match)
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs)
        waiters.push({ match, resolve: (item) => (clearTimeout(timer), resolve(item)) })
      })
    }
  }
}

function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res))
    })
    req.on('error', reject)
    req.end()
  })
}

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-claude-smoke-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(join(FIXTURES, 'empty-canvas.json'), join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-claude-mcp.mjs')],
  cwd: projectDir,
  env: { ...process.env, COWART_CLAUDE_PORT: String(PORT) },
  stderr: 'pipe'
})
const client = new Client({ name: 'cowart-claude-smoke', version: '0.0.0' })
await client.connect(transport)
const call = (name, args = {}) => client.callTool({ name, arguments: args })

let origin = ''
let pageUrl = ''
let imageShapeId = ''
let videoShapeId = ''
const api = (path, body) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify(body)
  }).then((response) => response.json())

try {
  await step('tool list: Claude tools present, page-only tools hidden', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of [
      'render_cowart_canvas_widget',
      'get_cowart_canvas_state',
      'get_cowart_selection',
      'insert_cowart_image',
      'insert_cowart_html_draft',
      'insert_cowart_video',
      'get_cowart_request',
      'reply_cowart_request',
      'list_cowart_requests'
    ]) {
      assert.ok(names.includes(name), `missing ${name}`)
    }
    for (const name of ['save_cowart_canvas_state', 'track_cowart_analytics_event', 'read_cowart_page_asset']) {
      assert.ok(!names.includes(name), `should hide ${name}`)
    }
  })

  await step('render returns a localhost URL and listener command', async () => {
    const result = await call('render_cowart_canvas_widget', { projectDir })
    const { url, port, listenCommand, listenerConnected } = result.structuredContent
    assert.equal(port, PORT)
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?projectDir=`))
    assert.match(listenCommand, /cowart-listen\.mjs" --port \d+$/)
    assert.equal(listenerConnected, false)
    origin = `http://127.0.0.1:${port}`
    pageUrl = url
  })

  await step('canvas page is served with the Claude bridge and a CSP', async () => {
    const response = await fetch(pageUrl)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    const html = await response.text()
    assert.ok(html.includes('id="cowartClaudeBridge"'))
    assert.ok(html.includes('window.__COWART_CLAUDE__='))
  })

  await step('API rejects missing token and foreign Host headers', async () => {
    const noToken = await fetch(`${origin}/api/tools/call`, { method: 'POST', body: '{}' })
    assert.equal(noToken.status, 403)
    const foreignHost = await rawGet(PORT, '/', { host: 'evil.example:80' })
    assert.equal(foreignHost.statusCode, 403)
  })

  await step('page tool calls reach upstream; analytics is dropped', async () => {
    const state = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir, canvasDir } })
    assert.equal(state.structuredContent.storage, 'per-page')
    const analytics = await api('/api/tools/call', { name: 'track_cowart_analytics_event', arguments: {} })
    assert.equal(analytics.structuredContent.skippedBy, 'cowart-claude-adapter')
  })

  await step('insert_cowart_image via the adapter, summarized with local paths', async () => {
    const inserted = await call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })
    assert.ok(!inserted.isError, text(inserted))
    imageShapeId = inserted.structuredContent.shapeId
    const summary = await call('get_cowart_canvas_state', {})
    assert.ok(!summary.isError, text(summary))
    assert.match(text(summary), /tiny\.png → .*assets[\\/]tiny\.png/)
  })

  await step('insert_cowart_video places a playable video right of its anchor', async () => {
    const inserted = await call('insert_cowart_video', { videoPath: join(FIXTURES, 'tiny.mp4'), anchorShapeId: imageShapeId })
    assert.ok(!inserted.isError, text(inserted))
    const { shapeId, bounds, filePath, mimeType } = inserted.structuredContent
    videoShapeId = shapeId
    assert.equal(mimeType, 'video/mp4')
    assert.ok((await stat(filePath)).size > 0)
    const summary = await call('get_cowart_canvas_state', { includeSnapshot: true })
    const store = summary.structuredContent.snapshot.store
    const image = store[imageShapeId]
    assert.equal(store[shapeId].type, 'video')
    assert.equal(bounds.x, image.x + image.props.w + 40)
    assert.equal(bounds.h, image.props.h)
  })

  await step('video asset is served with range support to same-origin pages', async () => {
    const referer = pageUrl
    const full = await rawGet(PORT, '/page-assets/page/tiny.mp4', { host: `127.0.0.1:${PORT}`, referer })
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['content-type'], 'video/mp4')
    const partial = await rawGet(PORT, '/page-assets/page/tiny.mp4', { host: `127.0.0.1:${PORT}`, referer, range: 'bytes=0-99' })
    assert.equal(partial.statusCode, 206)
    assert.match(partial.headers['content-range'], /^bytes 0-99\//)
    const crossSite = await rawGet(PORT, '/page-assets/page/tiny.mp4', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site' })
    assert.equal(crossSite.statusCode, 403)
  })

  await step('a stale page save cannot drop a freshly inserted video', async () => {
    const stale = JSON.parse(await readFile(join(FIXTURES, 'empty-canvas.json'), 'utf8'))
    const current = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir, canvasDir } })
    // Simulate a page that loaded before the video existed and never polled since.
    const pageStore = { ...current.structuredContent.snapshot.store }
    delete pageStore[videoShapeId]
    for (const [id, record] of Object.entries(pageStore)) if (record.typeName === 'asset' && record.type === 'video') delete pageStore[id]
    const saved = await api('/api/tools/call', {
      name: 'save_cowart_canvas_state',
      arguments: { projectDir, canvasDir, snapshot: { schema: stale.schema, store: pageStore }, protectImageRecords: true }
    })
    assert.equal(saved.structuredContent.ok, true, JSON.stringify(saved))
    const after = await call('get_cowart_canvas_state', { includeSnapshot: true })
    assert.ok(after.structuredContent.snapshot.store[videoShapeId], 'video was dropped')
  })

  await step('canvas messages become requests delivered to one listener', async () => {
    const pageEvents = openEvents(`${origin}/api/page-events?token=${token}`, {})
    const agent = openEvents(`${origin}/api/agent-events`, { 'x-cowart-token': token })
    await Promise.all([pageEvents.ready, agent.ready])
    await pageEvents.next((item) => item.event === 'presence' && item.data.agentOnline === true)

    const text = '[@Cowart](plugin://cowart@cowart-github) 生成图片\n说明\n\nPrompt:\n一只猫'
    const created = await api('/api/messages', { text, projectDir, canvasDir })
    const delivered = await agent.next((item) => item.event === 'request')
    assert.equal(delivered.data.id, created.request.id)
    assert.equal(delivered.data.title, '生成图片')
    assert.equal(delivered.data.summary, '一只猫')

    const details = await call('get_cowart_request', { id: created.request.id })
    assert.ok(details.structuredContent.text.includes('Prompt:'))
    assert.ok(details.structuredContent.hostNotes.some((note) => note.includes('beast-gen')))

    await call('reply_cowart_request', { id: created.request.id, status: 'done', message: '好了' })
    const update = await pageEvents.next((item) => item.event === 'request' && item.data.status === 'done')
    assert.equal(update.data.message, '好了')

    const replacement = openEvents(`${origin}/api/agent-events`, { 'x-cowart-token': token })
    await replacement.ready
    await agent.next((item) => item.event === 'replaced')
    replacement.close()
    agent.close()
    pageEvents.close()
  })

  await step('video requests carry the selected image path', async () => {
    const created = await api('/api/requests/video', { shapeId: imageShapeId, prompt: '让它动起来', projectDir, canvasDir })
    assert.equal(created.request.kind, 'video')
    const details = await call('get_cowart_request', { id: created.request.id })
    assert.match(details.structuredContent.text, /Source image local path: .*tiny\.png/)
    assert.match(details.structuredContent.text, /insert_cowart_video/)
  })
} finally {
  await client.close().catch(() => {})
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
