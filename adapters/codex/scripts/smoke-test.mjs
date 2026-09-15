#!/usr/bin/env node
// Real stdio bridge + service + Chromium with an MCP Apps host fixture. No generations
// are purchased; the fixture accepts ui/message without executing it in a conversation.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import puppeteer from 'puppeteer-core'
import { findBrowsers } from '../../shared/web-capture.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'

const root = await mkdtemp(join(tmpdir(), 'cowart-codex-check-'))
const tokenDir = join(root, 'runtime')
const probe = http.createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const session = `codex-check-${randomBytes(4).toString('hex')}`
const env = { ...process.env, COWART_RUNTIME_DIR: tokenDir, COWART_SESSION_NAMES_FILE: join(root, 'names.json'), COWART_CANVAS_DIR: join(root, 'canvas'), COWART_SESSION_ID: session, COWART_CLAUDE_PORT: String(port), COWART_BEAST_CLI: join(root, 'no-beast.mjs'), COWART_PROMPT_WRITER: 'off' }
delete env.COWART_BUNDLED
delete env.COWART_ADAPTERS_ROOT
const transport = new StdioClientTransport({ command: process.execPath, args: [join(ADAPTERS_DIR, 'codex/bin/cowart-codex-mcp.mjs')], cwd: root, env, stderr: 'pipe' })
let stderr = ''
transport.stderr?.on('data', (data) => { stderr += data })
const client = new Client({ name: 'cowart-native-widget-test', version: '1.0.0' })
let browser, hostServer, frame
const errors = []
const warnings = []
const failedRequests = []
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
const ok = (result) => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent }
const passed = (name) => console.log(`PASS  ${name}`)

// Match the native host's MCP resource boundary. The installed Codex host disables
// default domains and also includes resourceDomains in connect-src. Inline scripts,
// styles and embedded UI images/fonts remain available, but media and fetch require
// the resource's declared schemes. A permissive HTTP iframe hides these regressions.
function widgetCsp(metadata) {
  const csp = metadata?.ui?.csp || {}
  const resources = csp.resourceDomains || []
  const connects = [...new Set([...(csp.connectDomains || []), ...resources])]
  const sources = (values) => values.length ? values.join(' ') : "'none'"
  return [
    "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' ${resources.join(' ')}`,
    `style-src 'unsafe-inline' ${resources.join(' ')}`, `img-src data: ${resources.join(' ')}`,
    `font-src data: ${resources.join(' ')}`, `media-src ${sources(resources)}`,
    `connect-src ${sources(connects)}`, `frame-src ${sources(csp.frameDomains || [])}`,
    "worker-src blob:", "object-src 'none'", "base-uri 'none'"
  ].join('; ')
}

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.find((tool) => tool.name === 'cowart_canvas_app')._meta.ui.visibility, ['app'])
  assert.ok(tools.some((tool) => tool.name === 'insert_cowart_video'))
  assert.ok(!tools.some((tool) => tool.name === 'save_cowart_canvas_state'))
  passed('native bridge exposes model tools and keeps page transport app-only')
  const rendered = await call('render_cowart_canvas_widget', { page: '跨宿主验收', sessionName: '小墨' })
  const opened = ok(rendered)
  const pageId = opened.pages.find((page) => page.mine).id
  assert.equal(opened.rendering, 'native-widget')
  assert.equal(rendered._meta['openai/outputTemplate'], 'ui://widget/cowart/canvas.html')
  const resource = await client.readResource({ uri: 'ui://widget/cowart/canvas.html' })
  const widget = resource.contents[0].text
  const csp = widgetCsp(resource.contents[0]._meta)
  for (const marker of ['cowartCodexTransport', 'cowartServiceBridge', 'cowartShared-ai-video', 'cowartShared-ai-image', 'cowartShared-web-reference']) assert.ok(widget.includes(marker), marker)
  passed('native resource includes shared page runtime and all extensions')

  // Exercise actual chunking, rather than just a video small enough for one response.
  const videoPath = join(root, 'chunked-video.mp4')
  const videoBytes = Buffer.concat([await readFile(process.env.COWART_QA_VIDEO || join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.mp4')), Buffer.alloc(2 * 1024 * 1024)])
  await writeFile(videoPath, videoBytes)
  const insertedVideo = ok(await call('insert_cowart_video', { videoPath, pageId, videoWidth: 320, videoHeight: 180 }))
  ok(await call('insert_cowart_image', { imagePath: join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.png'), pageId }))

  const messages = []
  const methods = []
  const assetTransfers = []
  let initialMode = 'inline'
  let initialFailures = 0
  let canvasReads = 0
  let uploadGate = null
  let assetReadGate = null
  hostServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
      if (req.url?.startsWith('/widget')) {
      res.setHeader('content-security-policy', csp)
      return res.end(req.url.includes('cache-stalled') ? widget.replace('<head>', '<head><script>Object.defineProperty(window,"indexedDB",{value:{open:()=>({})},configurable:true})</script>') : widget)
    }
    res.end(`<!doctype html><title>Cowart MCP Apps host fixture</title><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><script>
      window.addEventListener('message', async e => {
        const m=e.data; if(!m || m.jsonrpc!=='2.0') return;
        const target=e.source;if(!target)return;
        const sourceFrame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===target);
        const requestDocument=sourceFrame?.contentDocument;
        if(m.id===undefined) return;
        try {const result=await window.hostRpc(m);if(sourceFrame && sourceFrame.contentDocument!==requestDocument)return;target.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
          if(m.method==='ui/initialize')target.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(rendered)}},'*');
          if(m.method==='ui/request-display-mode')target.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:result.mode}},'*');
          if(m.method==='tools/call' && m.params?.arguments?.body?.name==='read_cowart_page_asset')target.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light'}},'*');
        }
        catch(error){target.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:error.message}},'*')}
      });
    </script><iframe src="/widget" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"></iframe>`)
  })
  await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: findBrowsers()[0], headless: true, defaultViewport: { width: 1440, height: 900 }, args: ['--no-first-run', '--no-default-browser-check', '--mute-audio'] })
  const page = await browser.newPage()
  const directAssetRequests = []
  const htmlDataRequests = []
  page.on('request', (request) => {
    if (/\/page-assets\//.test(request.url())) directAssetRequests.push(request.url())
    if (request.url().startsWith('data:text/html')) htmlDataRequests.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url().slice(0, 200), frame: request.frame()?.url(), error: request.failure()?.errorText }))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
    if (message.type() === 'warn') warnings.push(message.text())
  })
  await page.exposeFunction('hostRpc', async (message) => {
    methods.push(message.method)
    switch (message.method) {
      case 'ui/initialize': return { protocolVersion: '2026-01-26', hostInfo: { name: 'Cowart test host', version: '1.0.0' }, hostCapabilities: { serverTools: {}, message: { text: {} }, openLinks: {} }, hostContext: { displayMode: initialMode, availableDisplayModes: ['inline', 'fullscreen'], theme: 'light' } }
      case 'tools/call': {
        const args = message.params.arguments
        const pageTool = message.params.name === 'cowart_canvas_app' && args?.path === '/api/tools/call' ? args.body : null
        if (pageTool?.name === 'get_cowart_canvas_state') {
          canvasReads++
          if (initialFailures > 0) { initialFailures--; throw new Error('Temporary host reconnection failure') }
        }
        if (uploadGate && pageTool?.name === 'save_cowart_reference_image' && pageTool.arguments?.holderShapeId === uploadGate.holderShapeId) {
          const gate = uploadGate
          uploadGate = null
          gate.entered(pageTool.arguments)
          await gate.resume
        }
        if (assetReadGate && pageTool?.name === 'read_cowart_page_asset' && pageTool.arguments?.assetUrl === assetReadGate.assetUrl) {
          const gate = assetReadGate
          assetReadGate = null
          const result = await call(message.params.name, args)
          gate.entered(result)
          await gate.resume
          return result
        }
        const result = await call(message.params.name, args)
        if (pageTool?.name === 'read_cowart_page_asset') {
          const data = result.structuredContent?.payload?.structuredContent
          assetTransfers.push({ url: pageTool.arguments.assetUrl, bytes: data?.dataBase64?.length || 0, notModified: data?.notModified === true })
        }
        return result
      }
      case 'ui/message': messages.push(message.params); return {}
      case 'ui/request-display-mode': return { mode: message.params.mode }
      case 'ui/update-model-context': return {}
      case 'ping': return {}
      default: throw new Error(`Unexpected host method ${message.method}`)
    }
  })
  await page.goto(`http://127.0.0.1:${hostServer.address().port}`, { waitUntil: 'domcontentloaded' })
  frame = page.frames().find((entry) => entry.url().endsWith('/widget'))
  await frame.waitForFunction(() => window.__cowartEditor && document.querySelector('#cowart-codex-overlay')?.shadowRoot.textContent.includes('小墨'), { timeout: 30000 })
  await frame.waitForFunction((id) => window.__cowartEditor.getCurrentPageId() === id, { timeout: 15000 }, pageId)
  assert.ok(await frame.$('[data-testid="tools.ai-video"]'))
  assert.ok(await frame.evaluate(() => window.__cowartHostConfig.imageModels.some((model) => model.id === 'codex-imagegen')))
  passed('MCP Apps handshake renders tldraw, owned page, model options and shared controls')
  await frame.evaluate(() => {
    window.openai.displayMode = undefined
    window.dispatchEvent(new CustomEvent('openai:set_globals'))
  })
  assert.equal(await frame.evaluate(() => window.cowartMcp.isActive()), true, 'the native SDK context remains authoritative when older compatibility globals omit displayMode')

  await frame.evaluate(async () => {
    const editor = window.__cowartEditor
    const html = (text) => `<!doctype html><meta charset="utf-8"><p>${text}</p>`
    const percent = html('中文编号 甲：长刀动作')
    const base64 = html('中文编号 乙：视频对照')
    editor.createShapes([
      { id: 'shape:csp-label-percent', type: 'embed', x: 20, y: 430, props: { w: 400, h: 60, url: `data:text/html;charset=utf-8,${encodeURIComponent(percent)}` }, meta: { cowartHtmlDraft: true } },
      { id: 'shape:csp-label-base64', type: 'embed', x: 440, y: 430, props: { w: 400, h: 60, url: `data:text/html;charset=utf-8;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(base64)))}` }, meta: { cowartHtmlDraft: true } },
      { id: 'shape:csp-label-raw', type: 'embed', x: 20, y: 510, props: { w: 820, h: 60, url: `data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><style>p{width:100%}</style><p>中文原文：50% off，进度 100%</p>` }, meta: { cowartHtmlDraft: true } }
    ])
    editor.zoomToFit({ animation: { duration: 0 } })
    await window.__cowartKit.saveCanvasNow()
  })
  await frame.waitForFunction(() => {
    const content = (id) => document.querySelector(`[data-cowart-html-draft-shape-id="${id}"]`)?.contentDocument?.body?.textContent
    return content('shape:csp-label-percent')?.includes('中文编号 甲：长刀动作') && content('shape:csp-label-base64')?.includes('中文编号 乙：视频对照') && content('shape:csp-label-raw')?.includes('中文原文：50% off，进度 100%')
  }, { timeout: 15000 })
  passed('percent-encoded, base64 and raw-percent Chinese HTML labels render under the native resource CSP')

  await frame.waitForFunction(() => [...document.querySelectorAll('video')].some((video) => video.readyState >= 2 && video.currentSrc.startsWith('blob:')), { timeout: 20000 })
  // The shared runtime restores the initial page/camera after the first snapshot settles.
  // Measure identity after that opening transition, then across subsequent edits/syncs.
  await new Promise((resolve)=>setTimeout(resolve,1500))
  const firstMedia = await frame.evaluate(() => { const v=document.querySelector('video'); window.__testVideo=v; return v.currentSrc })
  const loadedVideo = await frame.evaluate(async () => {
    const video = document.querySelector('video')
    const bytes = await (await fetch(video.currentSrc)).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { bytes: bytes.byteLength, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), time: video.currentTime }
  })
  assert.equal(loadedVideo.bytes, videoBytes.length, 'the decoded blob must contain every media chunk')
  assert.equal(loadedVideo.sha256, createHash('sha256').update(videoBytes).digest('hex'), 'the blob must be byte-identical to the inserted video')
  assert.equal(await frame.evaluate(async () => {
    const src = document.querySelector('video').currentSrc
    window.dispatchEvent(new Event('beforeunload'))
    return (await (await fetch(src)).arrayBuffer()).byteLength
  }), videoBytes.length, 'a cancelled or unfinished navigation must not revoke a still-live video URL')
  await frame.waitForFunction((time) => {
    const video = document.querySelector('video')
    return !video.paused && video.currentTime !== time
  }, { timeout: 5000 }, loadedVideo.time)
  await frame.evaluate(() => {
    const editor = window.__cowartEditor
    const shape = editor.getCurrentPageShapes().find((shape) => shape.type === 'video')
    editor.select(shape.id)
  })
  await frame.waitForFunction(() => !document.querySelector('#cowart-video-bar')?.shadowRoot.querySelector('.bar').hidden)
  await frame.evaluate(() => document.querySelector('#cowart-video-bar').shadowRoot.querySelector('.play').click())
  assert.equal(await frame.evaluate(() => document.querySelector('video').paused), true, 'the rendered playback control pauses video')
  const seekTime = await frame.evaluate(() => {
    const root = document.querySelector('#cowart-video-bar').shadowRoot
    const video = document.querySelector('video')
    const seek = root.querySelector('.seek')
    const value = video.duration * 0.5
    seek.value = String(value)
    seek.dispatchEvent(new Event('input', { bubbles: true }))
    seek.dispatchEvent(new Event('change', { bubbles: true }))
    return value
  })
  await frame.waitForFunction((time) => Math.abs(document.querySelector('video').currentTime - time) < 0.1, {}, seekTime)
  await frame.evaluate(() => document.querySelector('#cowart-video-bar').shadowRoot.querySelector('.play').click())
  await frame.waitForFunction(() => !document.querySelector('video').paused)
  const playbackScreenshot = join(tmpdir(), 'cowart-codex-playback-html-qa.png')
  await page.screenshot({ path: playbackScreenshot })
  passed('chunked video is byte-identical, advances playback, and supports pause and seeking')
  passed(`playback controls and decoded Chinese HTML screenshot ${playbackScreenshot}`)
  // User interaction, then a real queued ui/message accepted by the native host fixture.
  await frame.evaluate(async () => {
    const editor=window.__cowartEditor
    editor.createShapes([{id:'shape:codex-qa',type:'geo',x:10,y:300,props:{w:100,h:80}}])
    await window.__cowartKit.saveCanvasNow()
  })
  await frame.evaluate(() => window.cowartMcp.sendFollowUpMessage({ prompt: '验收请求：在本页放一张 HTML 卡片' }))
  const deadline=Date.now()+15000
  while (!messages.length && Date.now()<deadline) await new Promise((resolve)=>setTimeout(resolve,100))
  assert.equal(messages.length,1)
  assert.match(messages[0].content[0].text,/requestKey/)
  const queued=ok(await call('list_cowart_requests')).requests[0]
  assert.equal(queued.pageId,pageId)
  assert.equal(queued.session,session)
  const details=ok(await call('get_cowart_request',{id:queued.id,requestKey:queued.requestKey}))
  assert.match(details.text,/验收请求/)
  ok(await call('reply_cowart_request',{id:queued.id,requestKey:queued.requestKey,status:'done'}))
  assert.equal((await call('reply_cowart_request',{id:queued.id,requestKey:queued.requestKey,status:'running'})).isError,true)
  await new Promise((resolve)=>setTimeout(resolve,3500))
  assert.equal(messages.length,1)
  assert.deepEqual(await frame.evaluate(()=>({same:window.__testVideo===document.querySelector('video'),src:document.querySelector('video').currentSrc})),{same:true,src:firstMedia})
  assert.ok(ok(await call('get_cowart_canvas_state',{includeSnapshot:true})).snapshot.store['shape:codex-qa'])
  passed('delta save persists edit; own request reaches ui/message once; finished requests cannot restart')
  passed('video resolves through MCP to a stable blob and retains its DOM element across sync')

  const otherPageId = 'page:codex-async-send'
  const otherPageName = '异步请求期间翻页'
  async function changePageWhilePending() {
    await frame.evaluate(async ({ id, name }) => {
      const editor = window.__cowartEditor
      if (!editor.getPage(id)) editor.createPage({ id, name })
      editor.setCurrentPage(id)
      await window.__cowartKit.saveCanvasNow()
    }, { id: otherPageId, name: otherPageName })
    await frame.waitForFunction((id) => window.__cowartEditor.getCurrentPageId() === id, {}, otherPageId)
  }
  async function assertSourcePageRequest(sourceShapeId, expectedText) {
    const deadline = Date.now() + 15000
    let request
    while (Date.now() < deadline) {
      const pending = ok(await call('list_cowart_requests')).requests
      assert.ok(pending.length <= 1, 'one UI click must create at most one request')
      request = pending[0]
      if (request?.delivered && messages.some((message) => message.content?.some((item) => item.text?.includes(request.requestKey)))) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(request?.delivered, 'the actual UI request must reach its native session')
    assert.equal(request.pageId, pageId, 'an asynchronous sender must keep its source page')
    assert.equal(request.pageName, '跨宿主验收')
    assert.equal(request.session, session)
    const details = ok(await call('get_cowart_request', { id: request.id, requestKey: request.requestKey }))
    assert.ok(details.text.includes(sourceShapeId), 'request must identify the actual source card')
    assert.match(details.text, expectedText)
    const state = ok(await call('get_cowart_canvas_state'))
    assert.equal(state.responsibilities.pages[pageId]?.holder, session, 'source page ownership must be preserved')
    assert.equal(state.responsibilities.pages[otherPageId], undefined, 'browsing another page must not claim it')
    assert.equal(await frame.evaluate(() => window.__cowartEditor.getCurrentPageId()), otherPageId, 'delivery must not move the user back to the source page')
    ok(await call('reply_cowart_request', { id: request.id, requestKey: request.requestKey, status: 'done' }))
  }

  // Click the real image toolbar, let tldraw produce the real screenshot, then hold its
  // asynchronous result while the user changes pages. The request itself is never stubbed.
  const imageShapeId = await frame.evaluate(() => {
    const editor = window.__cowartEditor
    const image = editor.getCurrentPageShapes().find((shape) => shape.type === 'image')
    if (!image) throw new Error('Expected the image inserted through the real service')
    editor.setCurrentTool('select')
    editor.select(image.id)
    editor.zoomToSelection({ animation: { duration: 0 } })
    const original = editor.toImageDataUrl
    window.__testScreenshotGate = { entered: false, release: null }
    const gate = new Promise((resolve) => { window.__testScreenshotGate.release = resolve })
    editor.toImageDataUrl = async function (...args) {
      editor.toImageDataUrl = original
      const screenshot = await original.apply(this, args)
      window.__testScreenshotGate.entered = true
      await gate
      return screenshot
    }
    return image.id
  })
  await frame.waitForSelector('[data-testid="tool.cowart-annotation-edit"]', { visible: true })
  // Activate the rendered toolbar button itself: its floating positioning can change
  // between CDP's coordinate lookup and dispatch after zoomToSelection.
  await frame.$eval('[data-testid="tool.cowart-annotation-edit"]', (button) => button.click())
  await frame.waitForFunction(() => window.__testScreenshotGate.entered, { timeout: 15000 })
  await changePageWhilePending()
  assert.equal(ok(await call('list_cowart_requests')).requests.length, 0, 'the screenshot is still pending')
  await frame.evaluate(() => window.__testScreenshotGate.release())
  await assertSourcePageRequest(imageShapeId, /annotation|标注/i)
  passed('real annotation-edit UI keeps the source page while its screenshot completes after a page switch')

  // Upload a real reference file through the AI HTML form. Pause only the host RPC
  // carrying that file, change pages, then let the normal service and sender finish.
  await frame.evaluate((id) => {
    const editor = window.__cowartEditor
    editor.setCurrentPage(id)
    editor.selectNone()
  }, pageId)
  await frame.click('[data-testid="tools.ai-draft"]')
  await frame.waitForSelector('form[aria-label="AI HTML 生成"]', { visible: true })
  const draftShapeId = await frame.evaluate(async () => {
    const editor = window.__cowartEditor
    const holder = editor.getOnlySelectedShape()
    if (!holder || !editor.store.get(holder.id)?.meta?.cowartAiDraftHolder) throw new Error('Expected the AI HTML holder created by its real toolbar')
    await window.__cowartKit.saveCanvasNow()
    return holder.id
  })
  const htmlForm = 'form[aria-label="AI HTML 生成"]'
  const fileInput = await frame.$(`${htmlForm} input[type="file"]`)
  await fileInput.uploadFile(join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.png'))
  await frame.waitForSelector(`${htmlForm} img[alt="参考图 1"]`)
  await frame.type(`${htmlForm} textarea`, '异步翻页回归：参考上传图片生成 HTML 卡片')
  let reachedUpload
  let releaseUpload
  const uploadStarted = new Promise((resolve) => { reachedUpload = resolve })
  const uploadResume = new Promise((resolve) => { releaseUpload = resolve })
  uploadGate = { holderShapeId: draftShapeId, entered: reachedUpload, resume: uploadResume }
  await frame.$eval(`${htmlForm} button[type="submit"]`, (button) => button.click())
  let uploadTimer
  const uploadArgs = await Promise.race([
    uploadStarted,
    new Promise((_, reject) => { uploadTimer = setTimeout(() => reject(new Error('AI HTML form did not upload its reference image')), 15000) })
  ]).finally(() => clearTimeout(uploadTimer))
  assert.match(uploadArgs.dataUrl, /^data:image\/png;base64,/, 'the file input must reach the real page-tool upload')
  await changePageWhilePending()
  assert.equal(ok(await call('list_cowart_requests')).requests.length, 0, 'the reference upload is still pending')
  releaseUpload()
  await assertSourcePageRequest(draftShapeId, /异步翻页回归/)
  passed('real AI HTML file-upload UI keeps the source page without claiming the page opened during upload')
  await frame.evaluate((id) => window.__cowartEditor.setCurrentPage(id), pageId)

  await frame.click('[data-testid="tools.ai-image"]')
  await frame.waitForFunction(() => document.querySelector('[data-cowart-panel="ai-image"]') || [...document.querySelectorAll('*')].some((el) => el.shadowRoot?.querySelector('textarea')), { timeout: 10000 })
  assert.ok(await frame.evaluate(() => Object.values(window.__cowartEditor.store.getStoreSnapshot().store).some((record) => record.meta?.cowartAiImageHolder)))
  passed('clicking the AI image toolbar opens the shared generation panel and creates a holder')
  assert.deepEqual(warnings.filter((message) => message.startsWith('Cowart could not resolve local page asset through MCP.')), [], 'ordinary media loading must complete without resolver failures')
  assert.deepEqual(htmlDataRequests, [], 'inline HTML must be decoded locally instead of fetched through connect-src')

  // These failures use the real page tool and real files in this test's temporary
  // canvas. First the file is absent, then its bytes cannot be decoded; retry must
  // recover without persisting a fake URL/version or reloading a healthy neighbor.
  for (const kind of ['read', 'decode']) {
    const shapeId = `shape:retry-${kind}`
    const assetId = `asset:retry-${kind}`
    const fileName = `retry-${kind}.mp4`
    const assetUrl = `/page-assets/${pageId.slice('page:'.length)}/${fileName}`
    const assetPath = join(root, 'canvas', 'pages', pageId.slice('page:'.length), 'assets', fileName)
    if (kind === 'decode') await writeFile(assetPath, Buffer.from('This is deliberately not a video.'))
    await frame.evaluate(async ({ assetId, assetUrl, shapeId, originalAssetId, originalShapeId }) => {
      const editor = window.__cowartEditor
      const originalAsset = editor.getAsset(originalAssetId)
      const originalShape = editor.getShape(originalShapeId)
      editor.createAssets([{ ...originalAsset, id: assetId, props: { ...originalAsset.props, name: assetId, src: assetUrl } }])
      editor.createShapes([{ ...originalShape, id: shapeId, x: 20, y: 600, props: { ...originalShape.props, assetId } }])
      editor.selectNone()
      editor.zoomToFit({ animation: { duration: 0 } })
      await window.__cowartKit.saveCanvasNow()
    }, { assetId, assetUrl, shapeId, originalAssetId: insertedVideo.assetId, originalShapeId: insertedVideo.shapeId })
    const noticeSelector = `.cowart-video-error[data-shape-id="${shapeId}"]`
    await frame.waitForFunction((selector) => {
      const notice = document.querySelector(selector)
      return notice && !notice.hidden && notice.textContent.includes('视频加载失败')
    }, { timeout: 15000 }, noticeSelector)
    assert.equal(await frame.evaluate((id) => [...(document.getElementById(id)?.querySelectorAll('.tl-spinner') || [])].every((spinner) => getComputedStyle(spinner).display === 'none'), shapeId), true, 'a failed video must stop showing a loading spinner')
    if (kind === 'read') {
      const failureScreenshot = join(tmpdir(), 'cowart-codex-video-error-qa.png')
      await page.screenshot({ path: failureScreenshot })
      passed(`visible read failure and retry action screenshot ${failureScreenshot}`)
    }
    if (kind === 'decode') {
      const originalCamera = await frame.evaluate((id) => {
        const editor = window.__cowartEditor
        const { x, y, z } = editor.getCamera()
        const bounds = editor.getShapePageBounds(id)
        const viewport = editor.getViewportScreenBounds()
        const zoom = Math.max(2.1, z * 2.1)
        window.__testFailedBeforeZoom = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
        editor.setCamera({ x: viewport.w / (2 * zoom) - bounds.midX, y: viewport.h / (2 * zoom) - bounds.midY, z: zoom }, { animation: { duration: 0 } })
        return { x, y, z }
      }, shapeId)
      await new Promise((resolve) => setTimeout(resolve, 750))
      await frame.evaluate((camera) => window.__cowartEditor.setCamera(camera, { animation: { duration: 0 } }), originalCamera)
      await new Promise((resolve) => setTimeout(resolve, 750))
      assert.equal(await frame.evaluate((id) => document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`) === window.__testFailedBeforeZoom, shapeId), true, 'zoom must exercise the existing failed player without remounting it')
      passed('the failed video survives a zoom above 200% and back, including both resolver debounce windows')
    }
    const beforeRetry = await frame.evaluate(({ assetId, shapeId, originalShapeId }) => {
      const editor = window.__cowartEditor
      window.__testHealthyNeighbor = document.querySelector(`video.tl-video-shape-${originalShapeId.slice('shape:'.length)}`)
      return { asset: editor.getAsset(assetId), shape: editor.getShape(shapeId), healthySrc: window.__testHealthyNeighbor?.currentSrc }
    }, { assetId, shapeId, originalShapeId: insertedVideo.shapeId })
    assert.ok(beforeRetry.healthySrc?.startsWith('blob:'), 'the neighboring video stays loaded during the failure')
    await writeFile(assetPath, videoBytes)
    await frame.$eval(`${noticeSelector} button`, (button) => {
      if (button.textContent !== '重试') throw new Error('Expected the user-visible retry action')
      button.click()
    })
    await frame.waitForFunction(({ shapeId, selector }) => {
      const video = document.querySelector(`video.tl-video-shape-${shapeId.slice('shape:'.length)}`)
      return !document.querySelector(selector) && video?.readyState >= 2 && !video.paused
    }, { timeout: 20000 }, { shapeId, selector: noticeSelector })
    const afterRetry = await frame.evaluate(({ assetId, shapeId, originalShapeId }) => {
      const editor = window.__cowartEditor
      const healthy = document.querySelector(`video.tl-video-shape-${originalShapeId.slice('shape:'.length)}`)
      return { asset: editor.getAsset(assetId), shape: editor.getShape(shapeId), healthySrc: healthy?.currentSrc, sameHealthyNode: healthy === window.__testHealthyNeighbor }
    }, { assetId, shapeId, originalShapeId: insertedVideo.shapeId })
    assert.deepEqual(afterRetry.asset, beforeRetry.asset, 'retry must not mutate the saved media asset')
    assert.deepEqual(afterRetry.shape, beforeRetry.shape, 'retry must not mutate the saved video shape')
    assert.equal(afterRetry.sameHealthyNode, true, 'retry must preserve the neighboring video element')
    assert.equal(afterRetry.healthySrc, beforeRetry.healthySrc, 'retry must preserve the neighboring video blob')
    passed(`a real video ${kind} failure shows a Chinese error and retries without changing canvas records or healthy media`)
  }

  // Hold an actual old MCP response, switch the same asset to a working new URL,
  // then release the old error/success after the new video is already playing.
  // Neither an obsolete error nor an obsolete successful Blob may replace it.
  for (const outcome of ['error', 'success']) {
    const assetId = `asset:stale-${outcome}`
    const shapeId = `shape:stale-${outcome}`
    const pageSlug = pageId.slice('page:'.length)
    const oldName = `stale-${outcome}-old.mp4`
    const newName = `stale-${outcome}-new.mp4`
    const oldUrl = `/page-assets/${pageSlug}/${oldName}`
    const newUrl = `/page-assets/${pageSlug}/${newName}`
    if (outcome === 'success') await writeFile(join(root, 'canvas', 'pages', pageSlug, 'assets', oldName), await readFile(join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.mp4')))
    await writeFile(join(root, 'canvas', 'pages', pageSlug, 'assets', newName), videoBytes)
    let enteredOldRead, releaseOldRead
    const oldReadStarted = new Promise((resolve) => { enteredOldRead = resolve })
    const oldReadResume = new Promise((resolve) => { releaseOldRead = resolve })
    assetReadGate = { assetUrl: oldUrl, entered: enteredOldRead, resume: oldReadResume }
    await frame.evaluate(async ({ assetId, shapeId, oldUrl, originalAssetId, originalShapeId }) => {
      const editor = window.__cowartEditor
      const originalAsset = editor.getAsset(originalAssetId)
      const originalShape = editor.getShape(originalShapeId)
      const callServerTool = window.cowartMcp.callServerTool
      window.__testOldAssetReadSettled = false
      window.cowartMcp.callServerTool = async function (request, ...options) {
        try { return await callServerTool.call(this, request, ...options) }
        finally {
          if (request.name === 'read_cowart_page_asset' && request.arguments?.assetUrl === oldUrl) {
            window.__testOldAssetReadSettled = true
            window.cowartMcp.callServerTool = callServerTool
          }
        }
      }
      editor.createAssets([{ ...originalAsset, id: assetId, props: { ...originalAsset.props, name: assetId, src: oldUrl } }])
      editor.createShapes([{ ...originalShape, id: shapeId, x: 500, y: 600, props: { ...originalShape.props, assetId } }])
      editor.selectNone()
      editor.zoomToFit({ animation: { duration: 0 } })
      await window.__cowartKit.saveCanvasNow()
    }, { assetId, shapeId, oldUrl, originalAssetId: insertedVideo.assetId, originalShapeId: insertedVideo.shapeId })
    let oldReadTimer
    const oldReadResult = await Promise.race([
      oldReadStarted,
      new Promise((_, reject) => { oldReadTimer = setTimeout(() => reject(new Error('The old asset read did not reach the native host gate')), 15000) })
    ]).finally(() => clearTimeout(oldReadTimer))
    assert.equal(Boolean(ok(oldReadResult).payload.isError), outcome === 'error', 'the gate must preserve the real service read outcome')
    await frame.evaluate(async ({ assetId, newUrl }) => {
      const editor = window.__cowartEditor
      const asset = editor.getAsset(assetId)
      editor.updateAssets([{ ...asset, props: { ...asset.props, src: newUrl } }])
      await window.__cowartKit.saveCanvasNow()
    }, { assetId, newUrl })
    await frame.waitForFunction((id) => {
      const video = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
      return video?.readyState >= 2 && !video.paused
    }, { timeout: 20000 }, shapeId)
    const beforeOldSettled = await frame.evaluate((id) => {
      window.__testReplacementVideo = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
      return { src: window.__testReplacementVideo.currentSrc, time: window.__testReplacementVideo.currentTime }
    }, shapeId)
    releaseOldRead()
    await frame.waitForFunction(() => window.__testOldAssetReadSettled, { timeout: 15000 })
    await frame.waitForFunction(({ id, previousTime }) => {
      const video = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
      return video?.readyState >= 2 && !video.paused && video.currentTime !== previousTime
    }, { timeout: 5000 }, { id: shapeId, previousTime: beforeOldSettled.time })
    const afterOldSettled = await frame.evaluate((id) => {
      const video = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
      return { sameNode: video === window.__testReplacementVideo, src: video?.currentSrc, hasError: Boolean(document.querySelector(`.cowart-video-error[data-shape-id="${id}"]`)) }
    }, shapeId)
    assert.equal(afterOldSettled.sameNode, true, 'an obsolete response must not remount the replacement video')
    assert.equal(afterOldSettled.src, beforeOldSettled.src, 'an obsolete response must not replace the new blob URL')
    assert.equal(afterOldSettled.hasError, false, 'an obsolete response must not show an error over the new video')
    passed(`a late old ${outcome} response preserves the replacement video's playback, DOM, URL and error state`)
  }
  // A task switch really destroys the iframe. Restore state in a new document;
  // retain the browser profile so IndexedDB has the same lifetime as Codex's sandbox.
  const resumeState = await frame.evaluate(async (id) => {
    const editor = window.__cowartEditor
    const video = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
    video.dataset.cowartUserPaused = '1'
    video.pause()
    video.currentTime = video.duration * 0.4
    const camera = { x: 19, y: 27, z: 0.7 }
    editor.setCamera(camera, { immediate: true, force: true })
    await window.__cowartFlushView()
    return { pageId: editor.getCurrentPageId(), camera, time: video.currentTime }
  }, insertedVideo.shapeId)
  const transfersBeforeRemount = assetTransfers.length
  initialMode = 'fullscreen'
  initialFailures = 1
  const remounted = page.waitForFrame((entry) => entry.url().includes('/widget?remounted'))
  await page.evaluate(() => {
    document.querySelector('iframe').remove()
    const next = document.createElement('iframe')
    next.src = '/widget?remounted'
    next.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-forms')
    document.body.append(next)
  })
  frame = await remounted
  await frame.waitForFunction((id) => {
    const v = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
    return window.__cowartEditor && v?.readyState >= 2 && v.paused && v.currentTime > 0
  }, { timeout: 30000 }, insertedVideo.shapeId)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const restored = await frame.evaluate((id) => {
    const editor = window.__cowartEditor, { x, y, z } = editor.getCamera()
    const v = document.querySelector(`video.tl-video-shape-${id.slice('shape:'.length)}`)
    return { pageId: editor.getCurrentPageId(), camera: { x, y, z }, time: v.currentTime, paused: v.paused }
  }, insertedVideo.shapeId)
  assert.equal(restored.pageId, resumeState.pageId)
  assert.deepEqual(restored.camera, resumeState.camera)
  assert.ok(restored.paused && Math.abs(restored.time - resumeState.time) < 0.1)
  const playing = await frame.evaluate((id) => {
    const v = [...document.querySelectorAll('video.tl-video')].find((entry) => !entry.classList.contains(`tl-video-shape-${id.slice('shape:'.length)}`))
    window.__playingBeforeCollapse = v
    return { time: v.currentTime, paused: v.paused }
  }, insertedVideo.shapeId)
  assert.equal(playing.paused, false, 'videos that were playing must resume playing')
  const restoredTransfers = assetTransfers.slice(transfersBeforeRemount).filter((entry) => /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(entry.url))
  assert.ok(restoredTransfers.some((entry) => entry.notModified), 'reload must revalidate the cached file')
  assert.equal(restoredTransfers.reduce((sum, entry) => sum + entry.bytes, 0), 0, 'unchanged videos must not transfer base64 again')
  passed('destroy/remount recovers from a transient first read, restores page/camera/paused seek, and revalidates media with zero retransferred bytes')
  await page.screenshot({ path: join(tmpdir(), 'cowart-codex-remount-qa.png') })

  // Collapse the current frame, then rehydrate a historical inline card. Neither
  // may expand itself or keep fetching the full canvas and videos in the background.
  await frame.evaluate(() => window.cowartMcp.requestDisplayMode('inline'))
  await frame.waitForFunction(() => window.cowartMcp.isActive() === false)
  assert.equal(await frame.evaluate(() => window.__playingBeforeCollapse.paused), true)
  await frame.evaluate(() => window.cowartMcp.requestDisplayMode('fullscreen'))
  await frame.waitForFunction(() => window.__playingBeforeCollapse && !window.__playingBeforeCollapse.paused)
  assert.equal(await frame.evaluate(() => document.contains(window.__playingBeforeCollapse)), true, 'collapse/expand must retain the live media node')
  await frame.evaluate(() => window.cowartMcp.requestDisplayMode('inline'))
  await frame.waitForFunction(() => !window.cowartMcp.isActive())
  initialMode = 'inline'
  const readsBeforeHistory = canvasReads
  const assetsBeforeHistory = assetTransfers.length
  const expandsBeforeHistory = methods.filter((method) => method === 'ui/request-display-mode').length
  await page.evaluate(() => {
    const history = document.createElement('iframe')
    history.src = '/widget?history'
    history.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-forms')
    document.body.append(history)
  })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const history = page.frames().find((entry) => entry.url().includes('/widget?history'))
  assert.ok(history)
  assert.equal(await history.evaluate(() => Boolean(window.__cowartEditor)), false)
  assert.equal(canvasReads, readsBeforeHistory)
  assert.equal(assetTransfers.length, assetsBeforeHistory)
  assert.equal(methods.filter((method) => method === 'ui/request-display-mode').length, expandsBeforeHistory)
  await history.$eval('main button', (button) => button.click())
  await history.waitForFunction(() => window.__cowartEditor, { timeout: 20000 })
  passed('historical inline cards stay dormant without reads or auto-expansion, and open on an explicit click')
  frame = history
  await frame.waitForFunction(() => window.__cowartEditor?.getCamera().z === 0.7)
  await frame.evaluate(async (id) => {
    const editor = window.__cowartEditor
    editor.setCurrentPage(id)
    editor.setCamera({ x: 42, y: 33, z: 0.8 }, { immediate: true, force: true })
    await window.__cowartFlushView()
  }, otherPageId)
  initialMode = 'fullscreen'
  const viewedAgain = page.waitForFrame((entry) => entry.url().includes('/widget?viewed-again'))
  await page.evaluate(() => { document.querySelector('iframe[src="/widget?history"]').src = '/widget?viewed-again' })
  frame = await viewedAgain
  await frame.waitForFunction((id) => window.__cowartEditor?.getCurrentPageId() === id && window.__cowartEditor.getCamera().z === 0.8, { timeout: 20000 }, otherPageId)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(await frame.evaluate(() => window.__cowartEditor.getCurrentPageId()), otherPageId, 'the page being viewed survives independently of the page this session owns')
  passed('a task returns to the page it was viewing, even when it owns a different page')
  await frame.evaluate(async (id) => {
    window.__cowartEditor.setCurrentPage(id)
    window.__cowartEditor.zoomToFit({ animation: { duration: 0 } })
    await window.__cowartFlushView()
  }, pageId)
  const withoutCache = page.waitForFrame((entry) => entry.url().includes('/widget?cache-stalled'))
  await page.evaluate(() => { document.querySelector('iframe[src="/widget?viewed-again"]').src = '/widget?cache-stalled' })
  frame = await withoutCache
  await frame.waitForFunction(() => document.querySelector('video.tl-video')?.readyState >= 2, { timeout: 20000 })
  assert.equal(await frame.evaluate(() => window.cowartMcp.isActive()), true)
  passed('videos render with permanently stalled browser storage and partial host-context notifications during chunk transfers')
  assert.deepEqual(directAssetRequests, [], 'the native widget must never fall back to relative page-asset HTTP requests')
  const screenshot=join(tmpdir(),'cowart-codex-native-qa.png')
  await page.screenshot({path:screenshot})
  // The fork intentionally blocks upstream analytics in every host. The strict
  // CSP fixture now proves that policy, so these exact diagnostics are expected.
  const analyticsBlocked = (message) => message.includes("Loading the script 'https://www.googletagmanager.com/gtag/js?") && message.includes('Content Security Policy')
  assert.deepEqual(errors.filter((message) => !analyticsBlocked(message)),[], 'browser errors')
  assert.deepEqual(warnings.filter((message)=>!/allow-scripts.*allow-same-origin|can escape its sandbox/.test(message) && message !== 'Cowart analytics could not load the Google tag.' && !message.startsWith('Cowart could not resolve local page asset through MCP.')),[])
  passed(`rendered widget has no app console errors; screenshot ${screenshot}`)
  console.log('All Codex checks passed.')
} catch (error) {
  console.error({ errors, warnings, failedRequests })
  if (frame) console.error(await frame.evaluate(()=>({hostError:String(window.__COWART_MCP_HOST_ERROR__||''),body:document.body.innerText.slice(0,1500),videos:[...document.querySelectorAll('video')].map((v)=>({src:v.currentSrc,readyState:v.readyState,error:v.error?.message}))})).catch(()=>null))
  console.error(stderr)
  throw error
} finally {
  await browser?.close()
  await client.close().catch(()=>{})
  if (hostServer) await new Promise((resolve)=>hostServer.close(resolve))
  const token=await readFile(join(tokenDir,'token'),'utf8').catch(()=>null)
  if(token) await fetch(`http://127.0.0.1:${port}/api/service/shutdown`,{method:'POST',headers:{'x-cowart-token':token.trim(),'content-type':'application/json'},body:JSON.stringify({reason:'Codex smoke cleanup'})}).catch(()=>{})
  await new Promise((resolve)=>setTimeout(resolve,300))
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
