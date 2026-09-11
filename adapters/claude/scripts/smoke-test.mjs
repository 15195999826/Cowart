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
// What the shared AI 图片 / AI 视频 panels do: prepare the text, then send it tagged.
const prepare = (args) =>
  api('/api/tools/call', { name: 'prepare_cowart_generation_request', arguments: { ...args, projectDir, canvasDir } })
const sendTagged = (prepared) =>
  api('/api/messages', {
    text: prepared.structuredContent.text,
    kind: prepared.structuredContent.kind,
    holderShapeId: prepared.structuredContent.holderShapeId,
    projectDir,
    canvasDir
  })

// Adds a holder frame the way the canvas tools create it, saved like the page would.
async function addHolder(id, props, meta) {
  const state = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir, canvasDir } })
  const pageSnapshot = state.structuredContent.snapshot
  const store = {
    ...pageSnapshot.store,
    [id]: {
      id,
      typeName: 'shape',
      type: 'frame',
      x: props.x,
      y: 0,
      rotation: 0,
      index: props.index,
      parentId: 'page:page',
      isLocked: false,
      opacity: 1,
      props: { w: props.w, h: props.h, name: props.name, color: 'blue' },
      meta
    }
  }
  const saved = await api('/api/tools/call', { name: 'save_cowart_canvas_state', arguments: { projectDir, canvasDir, snapshot: { ...pageSnapshot, store } } })
  assert.equal(saved.structuredContent.ok, true, JSON.stringify(saved))
  assert.ok(!(saved.structuredContent.skippedRecords ?? []).some((record) => record.id === id), JSON.stringify(saved.structuredContent.skippedRecords))
  const check = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir, canvasDir } })
  assert.ok(check.structuredContent.snapshot.store[id], `holder ${id} not saved: ${JSON.stringify(Object.keys(check.structuredContent.snapshot.store))}`)
  return { ...pageSnapshot, store }
}

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
    assert.ok(html.includes('window.__cowartHostConfig='))
    for (const script of ['kit', 'canvas-chrome', 'video-playback', 'ai-video', 'ai-image', 'web-reference']) {
      assert.ok(html.includes(`id="cowartShared-${script}"`), `missing ${script}`)
    }
    assert.ok(!html.includes('"codex-imagegen"'), 'Codex-only model offered on Claude')
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

  await step('a pending request can be withdrawn on the canvas, and Claude hears about it', async () => {
    const agent = openEvents(`${origin}/api/agent-events`, { 'x-cowart-token': token })
    await agent.ready
    const created = await api('/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 按标注修改\n\nPrompt:\n误点', projectDir, canvasDir })
    await agent.next((item) => item.event === 'request' && item.data.id === created.request.id)

    const cancel = (id) =>
      fetch(`${origin}/api/requests/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cowart-token': token },
        body: JSON.stringify({ id })
      })
    const withdrawn = await cancel(created.request.id)
    assert.equal(withdrawn.status, 200)
    assert.equal((await withdrawn.json()).request.status, 'cancelled')
    await agent.next((item) => item.event === 'cancelled' && item.data.id === created.request.id)

    // Claude can no longer pick it up, and it cannot be withdrawn twice.
    const running = await call('reply_cowart_request', { id: created.request.id, status: 'running' })
    assert.equal(running.isError, true)
    assert.match(text(running), /已经在画布上撤销/)
    const notes = (await call('get_cowart_request', { id: created.request.id })).structuredContent.hostNotes
    assert.match(notes[0], /撤销了这条请求：不要执行/)
    assert.equal((await cancel(created.request.id)).status, 409)
    agent.close()
  })

  await step('AI 视频 holder: request carries settings and first frame, video replaces the holder', async () => {
    const holderId = 'shape:smokevideoholder'
    const pageSnapshot = await addHolder(holderId, { x: 1000, w: 640, h: 360, index: 'aZ', name: 'AI 视频' }, { cowartAiVideoHolder: true, cowartAiVideoRatio: '16:9' })
    const store = pageSnapshot.store

    const pngDataUrl = `data:image/png;base64,${(await readFile(join(FIXTURES, 'tiny.png'))).toString('base64')}`
    const mp4DataUrl = `data:video/mp4;base64,${(await readFile(join(FIXTURES, 'tiny.mp4'))).toString('base64')}`

    // H3, first / last frame: a canvas image plus an uploaded file.
    const prepared = await prepare({
      kind: 'video',
      holderShapeId: holderId,
      prompt: '让它动起来',
      model: 'h3',
      ratio: '16:9',
      resolution: '480P',
      duration: 8,
      quality: 'full',
      mode: 'frames',
      firstFrame: { shapeId: imageShapeId },
      lastFrame: { dataUrl: pngDataUrl, fileName: 'end.png' }
    })
    assert.ok(!prepared.isError, JSON.stringify(prepared))
    const created = await sendTagged(prepared)
    assert.equal(created.request.kind, 'video', JSON.stringify(created))
    assert.equal(created.request.holderShapeId, holderId)
    const details = (await call('get_cowart_request', { id: created.request.id })).structuredContent.text
    assert.match(details, /beast 模板 minimax-h3/)
    assert.match(details, /Parameters: ratio="16:9", resolution="480P", duration=8, turbo=false/)
    assert.match(details, /First frame（描述里的 @首帧）: .*tiny\.png/)
    assert.match(details, /Last frame（描述里的 @尾帧）: .*ai-video-smokevideoholder-last\.png/)
    assert.match(details, /@图1、@视频1、@首帧 这类标记.*H3 的 <Picture N>/)
    assert.ok(details.includes(`replaceHolderShapeId: "${holderId}"`))

    // Seedance, reference materials: a canvas image and an uploaded video.
    const refsPrepared = await prepare({
      kind: 'video',
      holderShapeId: holderId,
      prompt: '图1 的角色跳舞',
      model: 'seedance-2.5',
      ratio: '21:9',
      resolution: '720P',
      duration: 20,
      count: 2,
      sound: false,
      mode: 'refs',
      refs: [{ shapeId: imageShapeId }, { dataUrl: mp4DataUrl, fileName: 'move.mp4' }]
    })
    const refsText = refsPrepared.structuredContent.text
    assert.match(refsText, /Parameters: model="Seedance 2.5", ratio="21:9", resolution="720P", duration=20, n=2, sound=false/)
    assert.match(refsText, /Reference images（依次是描述里的 @图1、@图2 …）:\n1\. .*tiny\.png/)
    assert.match(refsText, /Reference videos（依次是描述里的 @视频1、@视频2 …）:\n1\. .*ai-video-smokevideoholder-ref-2\.mp4/)
    assert.match(refsText, /会生成 2 条/)

    // H3 takes at most 3 reference videos.
    const tooMany = await prepare({
      kind: 'video',
      holderShapeId: holderId,
      prompt: 'x',
      model: 'h3',
      mode: 'refs',
      refs: Array.from({ length: 4 }, () => ({ dataUrl: mp4DataUrl, fileName: 'v.mp4' }))
    })
    assert.equal(tooMany.isError, true)
    assert.match(text(tooMany), /最多 3 个参考视频/)

    const inserted = await call('insert_cowart_video', { videoPath: join(FIXTURES, 'tiny.mp4'), replaceHolderShapeId: holderId })
    assert.ok(!inserted.isError, text(inserted))
    assert.equal(inserted.structuredContent.replacedHolderShapeId, holderId)
    assert.deepEqual(inserted.structuredContent.bounds, { x: 1000, y: 0, w: 640, h: 360 })

    // A page that has not polled since still has the holder and lacks the video.
    const stale = await api('/api/tools/call', {
      name: 'save_cowart_canvas_state',
      arguments: { projectDir, canvasDir, snapshot: { ...pageSnapshot, store } }
    })
    assert.equal(stale.structuredContent.ok, true, JSON.stringify(stale))
    const after = (await call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot.store
    assert.ok(!after[holderId], 'replaced holder came back')
    assert.ok(after[inserted.structuredContent.shapeId], 'new video was dropped')
  })

  await step('AI 图片 holder: beast model, holder ratio and references reach the request', async () => {
    // Upstream's default AI image holder is 512 x 683 (3:4).
    const holderId = 'shape:smokeimageholder'
    await addHolder(holderId, { x: 2000, w: 512, h: 683, index: 'b00', name: 'AI 图片' }, { cowartAiImageHolder: true, cowartAiImageHolderVersion: 1 })
    const pngDataUrl = `data:image/png;base64,${(await readFile(join(FIXTURES, 'tiny.png'))).toString('base64')}`

    const prepared = await prepare({
      kind: 'image',
      holderShapeId: holderId,
      prompt: '把图1 的猫放进图2 的房间',
      model: 'flux2-klein',
      resolution: '1K',
      count: 2,
      quality: 'turbo',
      transparent: true,
      refs: [{ shapeId: imageShapeId }, { dataUrl: pngDataUrl, fileName: 'room.png' }]
    })
    assert.ok(!prepared.isError, JSON.stringify(prepared))
    const imageText = prepared.structuredContent.text
    assert.match(imageText, /生成图片 · FLUX\.2 Klein/)
    assert.match(imageText, /beast 模板 flux2-klein，本地，免费/)
    assert.match(imageText, /Parameters: quality="turbo", ratio="3:4", resolution="1K", n=2/)
    assert.match(imageText, /Target canvas slot: 512 x 683 canvas units（3:4）/)
    assert.match(imageText, /Transparent background: 要透明底/)
    assert.match(imageText, /Reference images（依次是描述里的 @图1、@图2 …）:\n1\. .*tiny\.png\n2\. .*ai-image-smokeimageholder-ref-2\.png/)
    assert.match(imageText, /@图1、@视频1、@首帧 这类标记.*FLUX 系用 image 1/)
    assert.ok(imageText.includes(`anchorShapeId: "${holderId}"`))
    assert.match(imageText, /会出 2 张/)

    const created = await sendTagged(prepared)
    assert.equal(created.request.kind, 'image')
    assert.equal(created.request.holderShapeId, holderId)
    assert.equal(created.request.title, '生成图片 · FLUX.2 Klein')

    // "自动" leaves the template to the agent and the confirm card to name it.
    const auto = await prepare({ kind: 'image', holderShapeId: holderId, prompt: '一只猫', model: 'auto', count: 1 })
    assert.match(auto.structuredContent.text, /Model: 自动（由你按需求挑选）/)
    const autoRequest = await sendTagged(auto)
    const notes = (await call('get_cowart_request', { id: autoRequest.request.id })).structuredContent.hostNotes
    assert.ok(notes.some((note) => note.includes('「自动」')), JSON.stringify(notes))

    // Krea 2 redraws from one reference only; Codex's own image generation is Codex-only.
    const krea = await prepare({ kind: 'image', holderShapeId: holderId, prompt: 'x', model: 'krea2', refs: [{ shapeId: imageShapeId }, { shapeId: imageShapeId }] })
    assert.match(text(krea), /Krea 2 最多 1 张参考图/)
    const codexOnly = await prepare({ kind: 'image', holderShapeId: holderId, prompt: 'x', model: 'codex-imagegen' })
    assert.match(text(codexOnly), /不支持所选的图片模型/)
  })

  await step('web reference: a local page is captured whole, and 照这个做 HTML names the page, its code and the annotations', async () => {
    // A scrolling page, served locally so the check needs no network.
    const page = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Smoke Long Page</title><body style="margin:0"><div style="height:2400px;background:linear-gradient(#fde,#def)">长页面</div></body>')
    })
    await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${page.address().port}/`
      const captured = await api('/api/tools/call', { name: 'capture_cowart_web_reference', arguments: { url, pageId: 'page:page', projectDir, canvasDir } })
      assert.ok(!captured.isError, JSON.stringify(captured))
      const shot = captured.structuredContent
      assert.equal(shot.title, 'Smoke Long Page')
      assert.equal(shot.width, 1440)
      assert.equal(shot.height, 2400)
      assert.ok((await stat(shot.screenshot.path)).size > 0)
      assert.match(await readFile(shot.html.path, 'utf8'), /长页面/)

      // The card as the page puts it on the canvas, plus the AI HTML holder beside it.
      const state = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir, canvasDir } })
      const snapshot = state.structuredContent.snapshot
      const store = {
        ...snapshot.store,
        'asset:smokeweb': {
          id: 'asset:smokeweb',
          typeName: 'asset',
          type: 'image',
          props: { name: shot.screenshot.fileName, src: shot.screenshot.assetUrl, w: 1440, h: 2400, mimeType: 'image/png', isAnimated: false, fileSize: shot.screenshot.fileSize },
          meta: {}
        },
        'shape:smokewebcard': {
          id: 'shape:smokewebcard',
          typeName: 'shape',
          type: 'image',
          x: 3000,
          y: 0,
          rotation: 0,
          index: 'b01',
          parentId: 'page:page',
          isLocked: false,
          opacity: 1,
          props: { assetId: 'asset:smokeweb', w: 1440, h: 2400, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' },
          meta: { cowartWebReference: true, cowartWebUrl: shot.url, cowartWebTitle: shot.title, cowartWebCapturedAt: shot.capturedAt, cowartWebHtmlAsset: shot.html.assetUrl, cowartWebViewport: 1440 }
        },
        // A 标注 arrow whose tip the 标注 tool bound to the card.
        'shape:smokenote': {
          id: 'shape:smokenote',
          typeName: 'shape',
          type: 'arrow',
          x: 2800,
          y: 40,
          rotation: 0,
          index: 'b03',
          parentId: 'page:page',
          isLocked: false,
          opacity: 1,
          props: {
            kind: 'arc',
            labelColor: 'red',
            color: 'red',
            fill: 'none',
            dash: 'draw',
            size: 'm',
            arrowheadStart: 'none',
            arrowheadEnd: 'arrow',
            font: 'draw',
            start: { x: 0, y: 0 },
            end: { x: 520, y: 60 },
            bend: 0,
            richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '导航改成深色' }] }] },
            labelPosition: 0,
            scale: 1,
            elbowMidPoint: 0.5
          },
          meta: { cowartAnnotationArrow: true }
        },
        'binding:smokenote': {
          id: 'binding:smokenote',
          typeName: 'binding',
          type: 'arrow',
          fromId: 'shape:smokenote',
          toId: 'shape:smokewebcard',
          props: { terminal: 'end', normalizedAnchor: { x: 0.22, y: 0.04 }, isExact: true, isPrecise: true, snap: 'none' },
          meta: {}
        }
      }
      const saved = await api('/api/tools/call', { name: 'save_cowart_canvas_state', arguments: { projectDir, canvasDir, snapshot: { ...snapshot, store } } })
      assert.ok(!(saved.structuredContent.skippedRecords ?? []).length, JSON.stringify(saved.structuredContent.skippedRecords))
      // The model's canvas summary says which card each annotation belongs to.
      assert.match(text(await call('get_cowart_canvas_state', {})), /shape:smokenote arrow .*「导航改成深色」.* 标注（修改要求） → shape:smokewebcard/)
      await addHolder('shape:smokewebholder', { x: 4480, w: 1440, h: 2400, index: 'b02', name: 'AI HTML' }, { cowartAiDraftHolder: true, cowartAiDraftHolderVersion: 1 })

      const prepared = await prepare({ kind: 'web', holderShapeId: 'shape:smokewebholder', sourceShapeId: 'shape:smokewebcard', prompt: '' })
      assert.ok(!prepared.isError, JSON.stringify(prepared))
      const webText = prepared.structuredContent.text
      assert.match(webText, /照网页做 HTML · Smoke Long Page/)
      assert.ok(webText.includes(`- URL: ${url}`))
      assert.ok(webText.includes(shot.screenshot.path))
      assert.ok(webText.includes(shot.html.path))
      assert.match(webText, /页面按 1440px 宽排版/)
      assert.ok(webText.includes('draftShapeId: "shape:smokewebholder"'))
      assert.match(webText, /Prompt:\n照这个网页的样式做一版。/)
      const created = await sendTagged(prepared)
      assert.equal(created.request.kind, 'web')
      const notes = (await call('get_cowart_request', { id: created.request.id })).structuredContent.hostNotes
      assert.ok(notes.some((note) => note.includes('网页复刻请求')), JSON.stringify(notes))

      // The 标注 arrows bound to the card travel along, each with the spot its tip points at
      // and a crop saved next to the page assets.
      const pngDataUrl = `data:image/png;base64,${(await readFile(join(FIXTURES, 'tiny.png'))).toString('base64')}`
      const annotated = await prepare({
        kind: 'web',
        holderShapeId: 'shape:smokewebholder',
        sourceShapeId: 'shape:smokewebcard',
        prompt: '',
        annotations: [
          { text: '导航改成深色', x: 320.4, y: 64, crop: pngDataUrl },
          { text: '', x: 700, y: 1800, crop: pngDataUrl },
          { note: true, text: '品牌色是 #FF5500', x: 40, y: 30, crop: pngDataUrl },
          { text: '没有位置的不算' }
        ]
      })
      assert.ok(!annotated.isError, JSON.stringify(annotated))
      const annotatedText = annotated.structuredContent.text
      assert.match(annotatedText, /照网页做 HTML · Smoke Long Page（带 2 处标注、1 条注释）/)
      assert.match(annotatedText, /1\. 「导航改成深色」 → 指向 \(320, 64\)；局部截图: .*ai-web-smokewebholder-note-1\.png/)
      assert.match(annotatedText, /2\. （箭头上没写字，看局部截图） → 指向 \(700, 1800\)；局部截图: /)
      assert.match(annotatedText, /注释（常驻在卡片上的说明：当背景参考，不是这次要改的地方；坐标同上）:\n- 「品牌色是 #FF5500」 → 指向 \(40, 30\)/)
      assert.doesNotMatch(annotatedText, /没有位置的不算/)
      assert.match(annotatedText, /不是网页内容/)
      assert.match(annotatedText, /Prompt:\n照这个网页做一版，按标注修改。/)
      assert.ok((await stat(/局部截图: (.+?\.png)/.exec(annotatedText)[1])).size > 0)
    } finally {
      page.close()
    }
  })
} finally {
  await client.close().catch(() => {})
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
