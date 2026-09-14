#!/usr/bin/env node
// Real stdio bridge + service + Chromium with an MCP Apps host fixture. No generations
// are purchased; the fixture accepts ui/message without executing it in a conversation.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
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
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
const ok = (result) => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent }
const passed = (name) => console.log(`PASS  ${name}`)

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
  for (const marker of ['cowartCodexTransport', 'cowartServiceBridge', 'cowartShared-ai-video', 'cowartShared-ai-image', 'cowartShared-web-reference']) assert.ok(widget.includes(marker), marker)
  passed('native resource includes shared page runtime and all extensions')

  // Exercise actual chunking, rather than just a video small enough for one response.
  const videoPath = join(root, 'chunked-video.mp4')
  await writeFile(videoPath, Buffer.concat([await readFile(join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.mp4')), Buffer.alloc(2 * 1024 * 1024)]))
  ok(await call('insert_cowart_video', { videoPath, pageId, videoWidth: 320, videoHeight: 180 }))
  ok(await call('insert_cowart_image', { imagePath: join(ADAPTERS_DIR, 'claude/test/fixtures/tiny.png'), pageId }))

  const messages = []
  const errors = []
  const warnings = []
  const methods = []
  let uploadGate = null
  hostServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/widget') return res.end(widget)
    res.end(`<!doctype html><title>Cowart MCP Apps host fixture</title><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><script>
      window.addEventListener('message', async e => {
        const m=e.data; if(!m || m.jsonrpc!=='2.0') return;
        if(m.id===undefined) return;
        try {const result=await window.hostRpc(m);e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*')}
        catch(error){e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:error.message}},'*')}
      });
    </script><iframe src="/widget" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"></iframe>`)
  })
  await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: findBrowsers()[0], headless: true, defaultViewport: { width: 1440, height: 900 }, args: ['--no-first-run', '--no-default-browser-check', '--mute-audio'] })
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
    if (message.type() === 'warn') warnings.push(message.text())
  })
  await page.exposeFunction('hostRpc', async (message) => {
    methods.push(message.method)
    switch (message.method) {
      case 'ui/initialize': return { protocolVersion: '2026-01-26', hostInfo: { name: 'Cowart test host', version: '1.0.0' }, hostCapabilities: { serverTools: {}, message: { text: {} }, openLinks: {} }, hostContext: { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], theme: 'light' } }
      case 'tools/call': {
        const args = message.params.arguments
        const pageTool = message.params.name === 'cowart_canvas_app' && args?.path === '/api/tools/call' ? args.body : null
        if (uploadGate && pageTool?.name === 'save_cowart_reference_image' && pageTool.arguments?.holderShapeId === uploadGate.holderShapeId) {
          const gate = uploadGate
          uploadGate = null
          gate.entered(pageTool.arguments)
          await gate.resume
        }
        return call(message.params.name, args)
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

  await frame.waitForFunction(() => [...document.querySelectorAll('video')].some((video) => video.readyState >= 2 && video.currentSrc.startsWith('blob:')), { timeout: 20000 })
  // The shared runtime restores the initial page/camera after the first snapshot settles.
  // Measure identity after that opening transition, then across subsequent edits/syncs.
  await new Promise((resolve)=>setTimeout(resolve,1500))
  const firstMedia = await frame.evaluate(() => { const v=document.querySelector('video'); window.__testVideo=v; return v.currentSrc })
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
  const screenshot=join(tmpdir(),'cowart-codex-native-qa.png')
  await page.screenshot({path:screenshot})
  assert.deepEqual(errors,[],`browser errors; methods=${methods.join(',')}`)
  assert.deepEqual(warnings.filter((message)=>!/allow-scripts.*allow-same-origin|can escape its sandbox/.test(message)),[])
  passed(`rendered widget has no app console errors; screenshot ${screenshot}`)
  console.log('All Codex checks passed.')
} catch (error) {
  if (frame) console.error(await frame.evaluate(()=>({hostError:String(window.__COWART_MCP_HOST_ERROR__||''),body:document.body.innerText.slice(0,1500)})).catch(()=>null))
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
