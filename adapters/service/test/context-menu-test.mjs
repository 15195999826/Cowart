#!/usr/bin/env node
// 截取当前帧 and 拷贝索引 (the canvas context menu) end to end, on the service's side of them:
// the page grabs the frame in the browser, saves it into the page's assets through upstream's
// page tool and puts the image card on the canvas itself (canvas-chrome.js), so this checks
// that the record it writes survives tldraw's validation, that the reference every host's page
// copies names the page, the shape, what it is and its local file (copy-reference.mjs), and
// that a shape the canvas does not have is refused. The clipboard itself is left alone
// (COWART_CLIPBOARD_DRY_RUN), so a check never takes over what the user copied.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadOrCreateToken } from '../lib/token.mjs'
import { EMPTY_CANVAS, FIXTURES, finish, startBridge, step, stopTestService, text } from '../../claude/scripts/test-kit.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'

const PORT = Number(process.env.COWART_MENU_TEST_PORT) || 43386
process.env.COWART_CLIPBOARD_DRY_RUN = '1'

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-menu-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

await stopTestService(PORT)
const claude = await startBridge({ cwd: projectDir, port: PORT, session: 'menu-claude' })
const codex = await startBridge({ cwd: projectDir, port: PORT, session: 'menu-codex', entry: join(ADAPTERS_DIR, 'codex', 'bin', 'cowart-codex-mcp.mjs') })

function ok(result) {
  assert.ok(!result.isError, text(result))
  return result
}
// What a canvas page calls: the Claude and ZCode pages over HTTP, the Codex widget through
// its bridge's private transport.
const pageCall = (name, args) =>
  fetch(`http://127.0.0.1:${PORT}/api/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify({ name, arguments: { projectDir, canvasDir, ...args } })
  }).then((response) => response.json())
const widgetCall = async (name, args) => {
  const result = ok(await codex.call('cowart_canvas_app', { op: 'call', pane: 'menu-pane', path: '/api/tools/call', body: { name, arguments: { projectDir, canvasDir, ...args } } }))
  // The widget transport wraps the page API response: { status, payload }.
  return result.structuredContent.payload
}
const copyReference = (shapeIds) => pageCall('copy_cowart_reference', { shapeIds })
const snapshot = async () => ok(await claude.call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot

let pageId = ''
let videoId = ''
let still = null
const stillId = 'shape:videostill'
const stillAssetId = 'asset:videostill'

try {
  await step('a video card copies as page, shape id, 视频 and its file', async () => {
    const opened = ok(await claude.call('render_cowart_canvas_widget', { sessionName: '小帧', page: '截帧' }))
    pageId = opened.structuredContent.heldPageId
    const inserted = ok(await claude.call('insert_cowart_video', { videoPath: join(FIXTURES, 'tiny.mp4'), x: 100, y: 100 }))
    videoId = inserted.structuredContent.shapeId
    const copied = await copyReference([videoId])
    assert.ok(!copied.isError, JSON.stringify(copied))
    assert.equal(copied.structuredContent.pageName, '截帧')
    // The toast on the canvas page words itself from these (canvas-chrome.js).
    assert.deepEqual(copied.structuredContent.items, [
      { id: videoId, type: 'video', kind: '视频', name: 'tiny.mp4', localPath: join(canvasDir, 'pages', pageId.slice('page:'.length), 'assets', 'tiny.mp4') }
    ])
    assert.equal(
      copied.structuredContent.text,
      `Cowart 画布 页面「截帧」 ${videoId} 视频「tiny.mp4」 ${join(canvasDir, 'pages', pageId.slice('page:'.length), 'assets', 'tiny.mp4')}`
    )
  })

  await step('截取当前帧 saves the still into the page assets and the card it writes is valid', async () => {
    // What the page sends after drawing the video's current frame onto a canvas element.
    const png = await readFile(join(FIXTURES, 'tiny.png'))
    const saved = await pageCall('save_cowart_reference_image', {
      pageId,
      fileName: 'frame-1-2s.png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png'
    })
    assert.ok(!saved.isError, JSON.stringify(saved))
    still = saved.structuredContent
    assert.equal(still.fileName, 'frame-1-2s.png')
    assert.equal((await stat(still.assetPath)).size, png.length)
    assert.equal(still.assetPath, join(canvasDir, 'pages', pageId.slice('page:'.length), 'assets', 'frame-1-2s.png'))

    const base = await snapshot()
    const store = {
      ...base.store,
      [stillAssetId]: {
        id: stillAssetId,
        typeName: 'asset',
        type: 'image',
        props: { name: 'tiny 1.2s.png', src: still.assetUrl, w: 32, h: 32, mimeType: 'image/png', isAnimated: false, fileSize: still.fileSize },
        meta: {}
      },
      [stillId]: {
        id: stillId,
        typeName: 'shape',
        type: 'image',
        x: 700,
        y: 100,
        rotation: 0,
        index: 'a9',
        parentId: pageId,
        isLocked: false,
        opacity: 1,
        props: { w: 320, h: 320, playing: true, url: '', assetId: stillAssetId, crop: null, flipX: false, flipY: false, altText: 'tiny 1.2s' },
        meta: { cowartVideoFrame: true, cowartVideoFrameOf: videoId, cowartVideoFrameTime: 1.2 }
      }
    }
    const written = await fetch(`http://127.0.0.1:${PORT}/api/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify({ name: 'save_cowart_canvas_state', arguments: { projectDir, canvasDir, snapshot: { ...base, store } } })
    }).then((response) => response.json())
    assert.equal(written.structuredContent?.ok, true, JSON.stringify(written))
    assert.deepEqual(written.structuredContent.skippedRecords, [], `the still the page writes must survive tldraw validation: ${JSON.stringify(written.structuredContent.skippedRecords)}`)
    assert.match(text(await claude.call('get_cowart_canvas_state', {})), new RegExp(`${stillId} image .*素材 tiny 1.2s.png`))
  })

  await step('several shapes copy as a list, and a still says it is one', async () => {
    const copied = await copyReference([videoId, stillId])
    assert.ok(!copied.isError, JSON.stringify(copied))
    const lines = copied.structuredContent.text.split('\n')
    assert.equal(lines[0], 'Cowart 画布 页面「截帧」的 2 个图形：')
    assert.equal(lines[1], `- ${videoId} 视频「tiny.mp4」 ${join(canvasDir, 'pages', pageId.slice('page:'.length), 'assets', 'tiny.mp4')}`)
    assert.equal(lines[2], `- ${stillId} 视频截帧「tiny 1.2s.png」 ${still.assetPath}`)
  })

  await step('the Codex widget copies the same reference', async () => {
    const copied = await widgetCall('copy_cowart_reference', { shapeIds: [stillId] })
    assert.equal(copied.structuredContent.text, `Cowart 画布 页面「截帧」 ${stillId} 视频截帧「tiny 1.2s.png」 ${still.assetPath}`)
  })

  await step('a shape the canvas does not have is refused', async () => {
    const copied = await copyReference(['shape:gone'])
    assert.equal(copied.isError, true)
    assert.match(text(copied), /画布上还没有这个图形：shape:gone/)
    assert.equal((await copyReference([])).isError, true)
  })
} finally {
  await claude.close()
  await codex.close()
  await stopTestService(PORT)
  finish()
}
