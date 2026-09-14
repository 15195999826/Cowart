#!/usr/bin/env node
// End-to-end check of the Claude adapter without Claude Code: runs a session bridge over
// stdio against a throwaway project (the bridge starts its own canvas service on a test
// port) and exercises tools, the page API, video support and canvas requests.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importCanvasPages } from '../../service/lib/canvas-import.mjs'
import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { INSTRUCTIONS, INSTRUCTIONS_LIMIT } from '../lib/bridge.mjs'
import { EMPTY_CANVAS, FIXTURES, finish, openEvents, rawGet, serviceStatus, startBridge, step, stopTestService, text, writePng } from './test-kit.mjs'

const PORT = Number(process.env.COWART_SMOKE_PORT) || 43290
const SESSION = 'smoke'

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-claude-smoke-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

await stopTestService(PORT)
const bridge = await startBridge({ cwd: projectDir, port: PORT, session: SESSION })
const { call, client } = bridge

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
    session: SESSION,
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
      y: props.y ?? 0,
      rotation: props.rotation ?? 0,
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
  await step('bridge instructions fit what Claude Code keeps of them, and the skill they point to exists', async () => {
    assert.ok(INSTRUCTIONS.length <= INSTRUCTIONS_LIMIT, `bridge instructions are ${INSTRUCTIONS.length} characters, Claude Code keeps ${INSTRUCTIONS_LIMIT}`)
    assert.match(INSTRUCTIONS, /Skill 工具加载 cowart/)
    const skill = await readFile(join(ADAPTERS_DIR, 'claude', 'skills', 'cowart', 'SKILL.md'), 'utf8')
    assert.match(skill, /^name: cowart$/m)
    assert.match(skill, /^description: .+/m)
  })

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

  await step('the bridge started a detached canvas service that knows the session', async () => {
    const status = await serviceStatus(PORT)
    assert.ok(status, 'no canvas service on the test port')
    assert.equal(status.service, 'cowart-canvas')
    assert.notEqual(status.pid, process.pid)
    const session = status.sessions.find((entry) => entry.id === SESSION)
    assert.ok(session?.bridge, JSON.stringify(status.sessions))
    assert.equal(session.state, 'online')
  })

  await step('render returns a session URL and a listener command for this session', async () => {
    const result = await call('render_cowart_canvas_widget', { projectDir })
    const { url, port, listenCommand, listenerConnected, sessionName, page } = result.structuredContent
    assert.equal(port, PORT)
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?session=${SESSION}&projectDir=`))
    assert.match(listenCommand, new RegExp(`cowart-listen\\.mjs" --port ${PORT} --session ${SESSION}$`))
    assert.equal(listenerConnected, false)
    // A session that picks no name for itself gets a spare one.
    assert.ok(sessionName, 'no session name')
    assert.equal(page, null)
    origin = `http://127.0.0.1:${port}`
    pageUrl = url
  })

  await step('canvas page is served with the Claude bridge, its session and a CSP', async () => {
    const response = await fetch(pageUrl)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    const html = await response.text()
    assert.ok(html.includes('id="cowartClaudeBridge"'))
    assert.ok(html.includes('window.__COWART_CLAUDE__='))
    assert.ok(html.includes(`"session":"${SESSION}"`))
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
    assert.equal(analytics.structuredContent.skippedBy, 'cowart-canvas-service')
  })

  await step('insert_cowart_image via the bridge, summarized with local paths', async () => {
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
    const stale = JSON.parse(await readFile(EMPTY_CANVAS, 'utf8'))
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

  await step('canvas messages become requests delivered to the session listener', async () => {
    // A canvas page follows the requests of the canvas it shows (its query names the canvas).
    const pageEvents = openEvents(`${origin}/api/page-events?${new URLSearchParams({ token, session: SESSION, canvasDir })}`)
    const agent = openEvents(`${origin}/api/agent-events?session=${SESSION}`, { 'x-cowart-token': token })
    await Promise.all([pageEvents.ready, agent.ready])
    await pageEvents.next((item) => item.event === 'presence' && item.data.agentOnline === true && item.data.session === 'online')

    const text = '[@Cowart](plugin://cowart@cowart-github) 生成图片\n说明\n\nPrompt:\n一只猫'
    const created = await api('/api/messages', { text, session: SESSION, projectDir, canvasDir })
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

    const replacement = openEvents(`${origin}/api/agent-events?session=${SESSION}`, { 'x-cowart-token': token })
    await replacement.ready
    await agent.next((item) => item.event === 'replaced')
    replacement.close()
    agent.close()
    pageEvents.close()
  })

  await step('pages opened before sessions existed, and old listener commands, are told to reopen', async () => {
    const orphan = await fetch(`${origin}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify({ text: '旧页面', projectDir, canvasDir })
    })
    assert.equal(orphan.status, 409)
    assert.match((await orphan.json()).error, /重新打开画布/)
    const oldListener = await fetch(`${origin}/api/agent-events`, { headers: { 'x-cowart-token': token } })
    assert.equal(oldListener.status, 400)
  })

  await step('a pending request can be withdrawn on the canvas, and Claude hears about it', async () => {
    const agent = openEvents(`${origin}/api/agent-events?session=${SESSION}`, { 'x-cowart-token': token })
    await agent.ready
    const created = await api('/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 按标注修改\n\nPrompt:\n误点', session: SESSION, projectDir, canvasDir })
    await agent.next((item) => item.event === 'request' && item.data.id === created.request.id)

    const cancel = (id) =>
      fetch(`${origin}/api/requests/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cowart-token': token },
        body: JSON.stringify({ id, session: SESSION })
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

  await step('insert_cowart_image keeps the bitmap ratio: centered in an AI 图片 holder, from the top left beside an image', async () => {
    const imageHolder = { cowartAiImageHolder: true, cowartAiImageHolderVersion: 1 }
    const storedShapes = async () => (await call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot.store
    // krea2 answers 3:4 at 1K with 896 x 1152, a little wider than upstream's 3:4 holder (512 x 683).
    const portrait = await writePng(join(projectDir, 'krea2-3x4.png'), 896, 1152)
    await addHolder('shape:smokefitholder', { x: 8000, w: 512, h: 683, index: 'b10', name: 'AI 图片' }, imageHolder)
    const inserted = await call('insert_cowart_image', { imagePath: portrait, anchorShapeId: 'shape:smokefitholder' })
    assert.ok(!inserted.isError, text(inserted))
    assert.deepEqual(inserted.structuredContent.bounds, { x: 8000, y: 12.5, w: 512, h: 658 })
    assert.match(text(inserted), /896×1152）等比放进 512×683 的 AI 图片框并居中：512×658/)
    let store = await storedShapes()
    const fitted = store[inserted.structuredContent.shapeId]
    assert.ok(!store['shape:smokefitholder'], 'holder was not replaced')
    assert.deepEqual([fitted.x, fitted.y, fitted.props.w, fitted.props.h], [8000, 12.5, 512, 658])

    // A turned holder: the image stays centered on it (the offset turns with the shape).
    await addHolder('shape:smokefitturned', { x: 9500, w: 512, h: 683, rotation: Math.PI / 2, index: 'b11', name: 'AI 图片' }, imageHolder)
    const turned = (await call('insert_cowart_image', { imagePath: portrait, anchorShapeId: 'shape:smokefitturned' })).structuredContent.bounds
    assert.equal(turned.x, 9487.5)
    assert.ok(Math.abs(turned.y) < 1e-9, `y ${turned.y}`)
    assert.deepEqual([turned.w, turned.h], [512, 658])

    // Beside an image, matching its size as 按标注修改 does: a square result keeps its ratio from the box's top left.
    const square = await writePng(join(projectDir, 'square.png'), 1024, 1024)
    const beside = await call('insert_cowart_image', { imagePath: square, anchorShapeId: fitted.id, placement: 'right' })
    assert.ok(!beside.isError, text(beside))
    assert.match(text(beside), /等比放进 512×658 的范围，左上对齐：512×512/)
    store = await storedShapes()
    const next = store[beside.structuredContent.shapeId]
    assert.deepEqual([next.x, next.y, next.props.w, next.props.h], [8000 + 512 + 40, 12.5, 512, 512])

    // An image upstream already sized to its bitmap's ratio stays as upstream placed it.
    const plain = await call('insert_cowart_image', { imagePath: portrait, anchorShapeId: fitted.id, placement: 'below', matchAnchor: false, displayWidth: 256 })
    assert.ok(!plain.isError, text(plain))
    assert.doesNotMatch(text(plain), /等比放进/)
    assert.deepEqual([plain.structuredContent.bounds.w, plain.structuredContent.bounds.h], [256, 329])
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

  await step('an old per-project canvas moves into the one canvas: its page goes last, assets and all, the old canvas untouched', async () => {
    // A project's canvas the way upstream saved it: one page with an image, and the manifest.
    const oldProject = await mkdtemp(join(tmpdir(), 'cowart-claude-old-project-'))
    try {
      const pagesDir = join(oldProject, 'canvas', 'pages')
      await mkdir(join(pagesDir, 'oldpage', 'assets'), { recursive: true })
      await copyFile(join(FIXTURES, 'tiny.png'), join(pagesDir, 'oldpage', 'assets', 'old.png'))
      const template = JSON.parse(await readFile(EMPTY_CANVAS, 'utf8'))
      const store = {
        'document:document': template.store['document:document'],
        'page:oldpage': { ...template.store['page:page'], id: 'page:oldpage', name: '旧项目的页', index: 'a1' },
        'asset:oldimage': {
          id: 'asset:oldimage',
          typeName: 'asset',
          type: 'image',
          props: { name: 'old.png', src: '/page-assets/oldpage/old.png', w: 1, h: 1, mimeType: 'image/png', isAnimated: false, fileSize: 0 },
          meta: {}
        },
        'shape:oldimage': {
          id: 'shape:oldimage',
          typeName: 'shape',
          type: 'image',
          x: 0,
          y: 0,
          rotation: 0,
          index: 'a1',
          parentId: 'page:oldpage',
          isLocked: false,
          opacity: 1,
          props: { assetId: 'asset:oldimage', w: 100, h: 100, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' },
          meta: {}
        }
      }
      const oldFile = join(pagesDir, 'oldpage', 'cowart-canvas.json')
      await writeFile(oldFile, JSON.stringify({ schema: template.schema, store }))
      await writeFile(join(pagesDir, 'manifest.json'), JSON.stringify({ version: 1, source: 'cowart', pages: [{ id: 'page:oldpage', name: '旧项目的页', index: 'a1', path: 'pages/oldpage/cowart-canvas.json' }] }))
      const before = await readFile(oldFile, 'utf8')

      // A project directory stands for its canvas.
      const moved = await importCanvasPages({ sources: [oldProject], into: canvasDir })
      assert.deepEqual(moved, [{ source: oldProject, pageId: 'page:oldpage', name: '旧项目的页', assets: 1 }])
      const again = await importCanvasPages({ sources: [join(oldProject, 'canvas')], into: canvasDir })
      assert.equal(again[0].skipped, '画布里已经有这一页')

      const stored = (await call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot.store
      assert.equal(stored['page:oldpage']?.name, '旧项目的页', 'the moved page is not on the canvas')
      assert.ok(stored['page:oldpage'].index > stored['page:page'].index, 'the moved page does not come after the others')
      assert.ok(stored['shape:oldimage'] && stored['asset:oldimage'])
      assert.equal((await rawGet(PORT, '/page-assets/oldpage/old.png', { host: `127.0.0.1:${PORT}`, referer: pageUrl })).statusCode, 200)
      assert.equal(await readFile(oldFile, 'utf8'), before, 'the old canvas was changed')
    } finally {
      await rm(oldProject, { recursive: true, force: true }).catch(() => {})
    }
  })
} finally {
  await bridge.close()
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

finish()
