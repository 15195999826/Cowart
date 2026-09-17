#!/usr/bin/env node
// The layout tools end to end (service/lib/canvas-edit.mjs): a Claude Code session lays a page
// out with images placed at x, y and above, text labels, a group frame, moves, resizes and
// deletes, through its bridge, the canvas service and upstream's real saves. Every host's
// bridge lists the tools; a page another session is responsible for is refused; a record the
// canvas page could not show is refused before anything is written and marked in the summary.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadOrCreateToken } from '../lib/token.mjs'
import { EMPTY_CANVAS, FIXTURES, finish, startBridge, step, stopTestService, text, writePng } from '../../claude/scripts/test-kit.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'

const PORT = Number(process.env.COWART_EDIT_TEST_PORT) || 43385
const LAYOUT_TOOLS = ['insert_cowart_text', 'insert_cowart_frame', 'update_cowart_shapes', 'delete_cowart_shapes']

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-edit-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

await stopTestService(PORT)
const claude = await startBridge({ cwd: projectDir, port: PORT, session: 'edit-claude' })
const zcode = await startBridge({ cwd: projectDir, port: PORT, session: 'edit-zcode', entry: join(ADAPTERS_DIR, 'zcode', 'bin', 'cowart-zcode-mcp.mjs') })
const codex = await startBridge({ cwd: projectDir, port: PORT, session: 'edit-codex', entry: join(ADAPTERS_DIR, 'codex', 'bin', 'cowart-codex-mcp.mjs') })

function ok(result) {
  assert.ok(!result.isError, text(result))
  return result
}
const summary = async (bridge = claude) => ok(await bridge.call('get_cowart_canvas_state', {})).structuredContent
const snapshot = async () => ok(await claude.call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot
const shapeOf = (state, id) => state.pages.flatMap((page) => page.shapes).find((shape) => shape.id === id)
const place = (shape) => [shape.x, shape.y, shape.w, shape.h]
// What a canvas page saves (the page API), for records no model tool makes.
const pageSave = (store, base) =>
  fetch(`http://127.0.0.1:${PORT}/api/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify({ name: 'save_cowart_canvas_state', arguments: { projectDir, canvasDir, snapshot: { ...base, store } } })
  }).then((response) => response.json())

let pageId = ''
let first = ''
let second = ''
let third = ''
let a1 = null
let a2 = null
let frameId = ''
const arrowId = 'shape:editnote'
const bindingId = 'binding:editnote'

try {
  await step('every host lists the layout tools, and the insert tools take x, y and placement above', async () => {
    for (const [host, bridge] of [['Claude Code', claude], ['ZCode', zcode], ['Codex', codex]]) {
      const tools = new Map((await bridge.client.listTools()).tools.map((tool) => [tool.name, tool]))
      for (const name of LAYOUT_TOOLS) assert.ok(tools.has(name), `${host} does not list ${name}`)
      for (const name of ['insert_cowart_image', 'insert_cowart_html_draft', 'insert_cowart_video']) {
        const properties = tools.get(name).inputSchema.properties
        assert.ok(properties.x && properties.y, `${host} ${name} takes no x, y`)
        assert.ok(properties.placement.enum.includes('above'), `${host} ${name} cannot go above`)
      }
    }
  })

  await step('images go exactly to x, y, and above their anchor', async () => {
    ok(await claude.call('render_cowart_canvas_widget', { sessionName: '小整', page: '整理' }))
    pageId = (await summary()).pages.find((page) => page.name === '整理').id
    const png = await writePng(join(projectDir, 'card.png'), 400, 300)
    first = ok(await claude.call('insert_cowart_image', { imagePath: png, x: 100, y: 200 })).structuredContent.shapeId
    second = ok(await claude.call('insert_cowart_image', { imagePath: png, x: 600, y: 200 })).structuredContent.shapeId
    const above = ok(await claude.call('insert_cowart_image', { imagePath: png, anchorShapeId: first, placement: 'above', matchAnchor: false, displayWidth: 200, displayHeight: 150 }))
    third = above.structuredContent.shapeId
    const state = await summary()
    assert.deepEqual(place(shapeOf(state, first)), [100, 200, 400, 300])
    assert.deepEqual(place(shapeOf(state, second)), [600, 200, 400, 300])
    assert.deepEqual(place(shapeOf(state, third)), [100, 10, 200, 150], text(above))
  })

  await step('insert_cowart_text puts labels right below cards and a title at x, y, as tldraw 5.1 records', async () => {
    const result = ok(
      await claude.call('insert_cowart_text', {
        items: [
          { text: 'A1', anchorShapeId: first, textAlign: 'middle' },
          { text: 'A2', anchorShapeId: second, placement: 'below', textAlign: 'middle', size: 'l', color: 'red' },
          { text: '风格融合\n第二行', x: 100, y: -200, size: 'xl', font: 'draw' }
        ]
      })
    )
    ;[a1, a2] = result.structuredContent.texts
    const title = result.structuredContent.texts[2]
    assert.deepEqual([a1.bounds.x, a1.bounds.y, a1.bounds.w], [100, 512, 400])
    assert.deepEqual([a2.bounds.x, a2.bounds.y], [600, 512])
    assert.deepEqual([title.bounds.x, title.bounds.y], [100, -200])

    const store = (await snapshot()).store
    const label = store[a1.shapeId]
    assert.equal(label.type, 'text')
    assert.equal(label.parentId, pageId)
    assert.deepEqual(Object.keys(label.props).sort(), ['autoSize', 'color', 'font', 'richText', 'scale', 'size', 'textAlign', 'w'])
    assert.deepEqual(label.props, {
      color: 'black',
      size: 'm',
      font: 'sans',
      textAlign: 'middle',
      w: 400,
      richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A1' }] }] },
      scale: 1,
      autoSize: false
    })
    assert.equal(store[title.shapeId].props.autoSize, true)
    assert.equal(store[title.shapeId].props.richText.content.length, 2)
    const state = await summary()
    assert.equal(shapeOf(state, a1.shapeId).text, 'A1')
    assert.ok(!state.pages.some((page) => page.invalid), JSON.stringify(state.pages.map((page) => page.invalid)))
  })

  await step('a text call with a bad style writes nothing', async () => {
    const before = Object.keys((await snapshot()).store).length
    const refused = await claude.call('insert_cowart_text', { items: [{ text: '好的', x: 0, y: 0 }, { text: '坏的', x: 0, y: 60, color: 'purple' }] })
    assert.ok(refused.isError)
    assert.match(text(refused), /items\[1\]\.color/)
    assert.equal(Object.keys((await snapshot()).store).length, before)
  })

  await step('insert_cowart_frame groups cards and labels where they are, behind the rest of the page', async () => {
    const before = await summary()
    const members = [first, second, a1.shapeId, a2.shapeId]
    const framed = ok(await claude.call('insert_cowart_frame', { name: '风格 A', shapeIds: members }))
    frameId = framed.structuredContent.frameId
    const after = await summary()
    for (const id of members) {
      assert.deepEqual(place(shapeOf(after, id)), place(shapeOf(before, id)), id)
      assert.equal(shapeOf(after, id).parentId, frameId)
    }
    const frame = shapeOf(after, frameId)
    assert.equal(frame.name, '风格 A')
    assert.equal(frame.children, 4)
    assert.deepEqual([frame.x, frame.y, frame.w], [60, 160, 980])
    const store = (await snapshot()).store
    const onPage = Object.values(store)
      .filter((record) => record.typeName === 'shape' && record.parentId === pageId)
      .sort((a, b) => (a.index < b.index ? -1 : 1))
    assert.equal(onPage[0].id, frameId)
    assert.match(text(await claude.call('get_cowart_canvas_state', {})), new RegExp(`${frameId} frame .*标题「风格 A」 内含 4 个图形`))
  })

  await step('moving a frame moves what is inside, and a card\'s 标注 arrow follows it', async () => {
    const base = await snapshot()
    const store = {
      ...base.store,
      [arrowId]: {
        id: arrowId,
        typeName: 'shape',
        type: 'arrow',
        x: 1100,
        y: 100,
        rotation: 0,
        index: 'b99',
        parentId: pageId,
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
          end: { x: -300, y: 150 },
          bend: 0,
          richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '换成夜景' }] }] },
          labelPosition: 0.5,
          scale: 1,
          elbowMidPoint: 0.5
        },
        meta: { cowartAnnotationArrow: true }
      },
      [bindingId]: {
        id: bindingId,
        typeName: 'binding',
        type: 'arrow',
        fromId: arrowId,
        toId: second,
        props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.17 }, isExact: true, isPrecise: true, snap: 'none' },
        meta: {}
      }
    }
    const saved = await pageSave(store, base)
    assert.equal(saved.structuredContent?.ok, true, JSON.stringify(saved))
    assert.deepEqual(saved.structuredContent.skippedRecords, [])

    const moved = ok(await claude.call('update_cowart_shapes', { updates: [{ shapeId: frameId, dx: 50, dy: 1000 }] }))
    assert.deepEqual(moved.structuredContent.followedAnnotations, [arrowId])
    const state = await summary()
    assert.deepEqual(place(shapeOf(state, second)), [650, 1200, 400, 300])
    assert.deepEqual(place(shapeOf(state, a1.shapeId)).slice(0, 2), [150, 1512])
    const arrow = (await snapshot()).store[arrowId]
    assert.deepEqual([arrow.x, arrow.y], [1150, 1100])
  })

  await step('update_cowart_shapes resizes, rewrites, retitles, regroups and fits frames in one call', async () => {
    const result = ok(
      await claude.call('update_cowart_shapes', {
        updates: [
          { shapeId: first, w: 200 },
          { shapeId: frameId, name: '风格 A · 定稿' },
          { shapeId: a1.shapeId, text: 'A1 · 选中' },
          { shapeId: third, frameId }
        ]
      })
    )
    // The image moved into the frame keeps its place, far above the frame: it gets clipped.
    assert.match(text(result), new RegExp(`${third} 超出了分组框 ${frameId}`))
    let state = await summary()
    assert.deepEqual(place(shapeOf(state, first)).slice(2), [200, 150])
    assert.equal(shapeOf(state, frameId).name, '风格 A · 定稿')
    assert.equal(shapeOf(state, a1.shapeId).text, 'A1 · 选中')
    assert.deepEqual(place(shapeOf(state, third)), [100, 10, 200, 150])
    assert.equal(shapeOf(state, third).parentId, frameId)

    ok(await claude.call('update_cowart_shapes', { updates: [{ shapeId: frameId, fit: true, padding: 20 }] }))
    state = await summary()
    const frame = shapeOf(state, frameId)
    assert.deepEqual([frame.x, frame.y], [80, -10])
    assert.deepEqual(place(shapeOf(state, third)), [100, 10, 200, 150])
    assert.deepEqual(place(shapeOf(state, second)), [650, 1200, 400, 300])

    ok(await claude.call('update_cowart_shapes', { updates: [{ shapeId: third, frameId: 'page', x: 2000, y: 0 }] }))
    state = await summary()
    assert.equal(shapeOf(state, third).parentId, undefined)
    assert.deepEqual(place(shapeOf(state, third)), [2000, 0, 200, 150])
    const refused = await claude.call('update_cowart_shapes', { updates: [{ shapeId: a1.shapeId, h: 100 }] })
    assert.ok(refused.isError)
    assert.match(text(refused), /文字只能给 w/)
    // A layout that leaves a shape where it already is works; an entry that asks for nothing does not.
    const still = ok(await claude.call('update_cowart_shapes', { updates: [{ shapeId: third, x: 2000, y: 0 }, { shapeId: first, dx: 0 }] }))
    assert.match(text(still), /已经是这样，没动/)
    const empty = await claude.call('update_cowart_shapes', { updates: [{ shapeId: third }] })
    assert.ok(empty.isError)
    assert.match(text(empty), /没说要改/)
  })

  await step('deleting a frame leaves its contents in place; deleting an image takes its 标注 along and keeps its file', async () => {
    const before = await summary()
    const inside = [first, second, a1.shapeId, a2.shapeId]
    const dropped = ok(await claude.call('delete_cowart_shapes', { shapeIds: [frameId] }))
    assert.deepEqual([...dropped.structuredContent.released].sort(), [...inside].sort())
    let state = await summary()
    assert.equal(shapeOf(state, frameId), undefined)
    for (const id of inside) {
      assert.deepEqual(place(shapeOf(state, id)), place(shapeOf(before, id)), id)
      assert.equal(shapeOf(state, id).parentId, undefined)
    }

    const imageFile = shapeOf(state, second).asset.localPath
    const removed = ok(await claude.call('delete_cowart_shapes', { shapeIds: [second] }))
    assert.deepEqual(removed.structuredContent.deletedAnnotations, [arrowId])
    assert.ok(text(removed).includes(imageFile), text(removed))
    assert.match(text(removed), /Ctrl\+Z 撤不回/)
    assert.ok((await stat(imageFile)).isFile())
    const store = (await snapshot()).store
    for (const id of [second, arrowId, bindingId]) assert.equal(store[id], undefined, id)
    state = await summary()
    assert.ok(shapeOf(state, first))
  })

  await step('videos and HTML drafts go to x, y and above too', async () => {
    const video = ok(await claude.call('insert_cowart_video', { videoPath: join(FIXTURES, 'tiny.mp4'), x: 3000, y: 50 }))
    assert.deepEqual([video.structuredContent.bounds.x, video.structuredContent.bounds.y], [3000, 50])
    const above = ok(await claude.call('insert_cowart_video', { videoPath: join(FIXTURES, 'tiny.mp4'), anchorShapeId: video.structuredContent.shapeId, placement: 'above' }))
    const { x, y, h } = above.structuredContent.bounds
    assert.equal(x, 3000)
    assert.ok(Math.abs(y - (50 - 40 - h)) <= 1, JSON.stringify(above.structuredContent.bounds))
    const draft = ok(await claude.call('insert_cowart_html_draft', { htmlContent: '<p>草稿</p>', x: -900, y: 40, displayWidth: 320, displayHeight: 200 }))
    assert.deepEqual(draft.structuredContent.bounds, { x: -900, y: 40, w: 320, h: 200 })
  })

  await step('another session cannot lay out a page it is not responsible for; a call works on one page', async () => {
    ok(await zcode.call('render_cowart_canvas_widget', { sessionName: '阿泽', page: '别的页' }))
    const refused = await zcode.call('update_cowart_shapes', { updates: [{ shapeId: first, dx: 10 }] })
    assert.ok(refused.isError)
    assert.match(text(refused), /「整理」这一页由「小整」负责/)
    const own = ok(await zcode.call('insert_cowart_text', { items: [{ text: '阿泽的页', x: 0, y: 0 }] }))
    const zcodeText = own.structuredContent.texts[0].shapeId
    const otherPage = (await summary()).pages.find((page) => page.name === '别的页')
    assert.equal(own.structuredContent.pageId, otherPage.id)
    const mixed = await claude.call('update_cowart_shapes', { updates: [{ shapeId: first, dx: 1 }, { shapeId: zcodeText, dx: 1 }] })
    assert.ok(mixed.isError)
    assert.match(text(mixed), /一次调用只改一页/)

    ok(await codex.call('render_cowart_canvas_widget', { sessionName: '阿扣', page: 'Codex 页' }))
    const frame = ok(await codex.call('insert_cowart_frame', { name: '空框', x: 0, y: 0, w: 300, h: 200 }))
    const codexPage = (await summary()).pages.find((page) => page.name === 'Codex 页')
    assert.equal(frame.structuredContent.pageId, codexPage.id)
  })

  await step('a record the page cannot show is refused before writing and marked in the canvas summary', async () => {
    // What a model wrote by hand on 2026-09-17: text props of an older tldraw.
    const pageFile = join(canvasDir, 'pages', pageId.replace('page:', ''), 'cowart-canvas.json')
    const stored = JSON.parse(await readFile(pageFile, 'utf8'))
    stored.store['shape:badtext'] = {
      id: 'shape:badtext',
      typeName: 'shape',
      type: 'text',
      x: 500,
      y: -400,
      rotation: 0,
      index: 'b98',
      parentId: pageId,
      isLocked: false,
      opacity: 1,
      props: { text: '手写的', align: 'middle', verticalAlign: 'middle', wrap: true, size: 'm', color: 'black', font: 'draw', w: 200, scale: 1, autoSize: true },
      meta: {}
    }
    await writeFile(pageFile, JSON.stringify(stored, null, 2))

    const state = await summary()
    const page = state.pages.find((entry) => entry.id === pageId)
    assert.ok(page.invalid?.some((record) => record.id === 'shape:badtext'), JSON.stringify(page.invalid))
    assert.equal(shapeOf(state, 'shape:badtext'), undefined)
    assert.match(text(await claude.call('get_cowart_canvas_state', {})), /⚠ shape:badtext text 是无效记录/)

    const refused = await claude.call('update_cowart_shapes', { updates: [{ shapeId: 'shape:badtext', dx: 10 }] })
    assert.ok(refused.isError)
    assert.match(text(refused), /没有写入.*shape:badtext/)
    assert.equal(JSON.parse(await readFile(pageFile, 'utf8')).store['shape:badtext'].x, 500)
  })
} finally {
  await Promise.all([claude.close(), zcode.close(), codex.close()])
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}
finish()
