#!/usr/bin/env node
// The canvas service generating AI 图片 / AI 视频 on its own (FORK.md, 画布直接生成). The prompt
// writer and the beast command line are stand-ins (test/fixtures/fake-claude.mjs and
// fake-beast.mjs) that log what they were given. Checks what the gateway gets, that the
// result takes the holder's place, that nothing reaches the session, failing and withdrawing,
// the fallback to Claude without a beast CLI, and the prompt structure without a writer.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fallbackPrompt } from '../../service/lib/prompt-writer.mjs'
import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { EMPTY_CANVAS, FIXTURES, delay, finish, openEvents, startBridge, step, stopTestService, text } from './test-kit.mjs'

const PORT = Number(process.env.COWART_GENERATION_PORT) || 43290
const FALLBACK_PORT = PORT + 3
const SESSION = 'gen-a'

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-claude-generation-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))
const beastLog = join(projectDir, 'beast.log')
const claudeLog = join(projectDir, 'claude.log')
const ENV = {
  COWART_BEAST_CLI: join(FIXTURES, 'fake-beast.mjs'),
  COWART_CLAUDE_CLI: join(FIXTURES, 'fake-claude.mjs'),
  COWART_FAKE_BEAST_LOG: beastLog,
  COWART_FAKE_CLAUDE_LOG: claudeLog,
  COWART_FAKE_BEAST_SLOW_MS: '15000',
  COWART_PROMPT_WRITER: ''
}
const IMAGE_HOLDER = { cowartAiImageHolder: true, cowartAiImageHolderVersion: 1 }
const VIDEO_HOLDER = { cowartAiVideoHolder: true, cowartAiVideoHolderVersion: 2, cowartAiVideoRatio: '16:9' }

await stopTestService(PORT)
await stopTestService(FALLBACK_PORT)

let bridge = null
let origin = ''
const streams = []

async function api(path, body, base = origin) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}
const pageTool = (name, args = {}) => api('/api/tools/call', { name, arguments: { projectDir, canvasDir, ...args } })
const readStore = async () => (await pageTool('get_cowart_canvas_state')).body.structuredContent.snapshot.store
const shapesOf = (store, type) => Object.values(store).filter((record) => record.typeName === 'shape' && record.type === type)

async function addHolder(id, meta, w, h, x) {
  const { snapshot } = (await pageTool('get_cowart_canvas_state')).body.structuredContent
  const holder = {
    id,
    typeName: 'shape',
    type: 'frame',
    x,
    y: 0,
    rotation: 0,
    index: 'a5',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    props: { w, h, name: 'AI', color: 'blue' },
    meta
  }
  const saved = await pageTool('save_cowart_canvas_state', { snapshot: { ...snapshot, store: { ...snapshot.store, [id]: holder } } })
  assert.equal(saved.body.structuredContent.ok, true, JSON.stringify(saved.body))
}

async function logLines(file) {
  try {
    return (await readFile(file, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

let pane
let listener
const FINAL = new Set(['done', 'failed', 'cancelled'])
const finished = async (id) => (await pane.next((item) => item.event === 'request' && item.data.id === id && FINAL.has(item.data.status), 30_000)).data

let referenceId = ''

try {
  await step('the canvas service generates with the stand-in gateway and prompt writer', async () => {
    bridge = await startBridge({ cwd: projectDir, port: PORT, session: SESSION, env: ENV })
    const opened = await bridge.call('render_cowart_canvas_widget', { projectDir, sessionName: '小生' })
    assert.ok(!opened.isError, text(opened))
    origin = `http://127.0.0.1:${opened.structuredContent.port}`
    pane = openEvents(`${origin}/api/page-events?${new URLSearchParams({ token, session: SESSION, pane: 'pane-gen', canvasDir })}`)
    listener = openEvents(`${origin}/api/agent-events?session=${SESSION}`, { 'x-cowart-token': token })
    streams.push(pane, listener)
    await Promise.all([pane.ready, listener.ready])
  })

  await step('AI 图片 (Krea 2): the prompt is written, the panel settings go to the gateway, the result takes the holder\'s place, the session hears nothing', async () => {
    await addHolder('shape:gen_img1', IMAGE_HOLDER, 600, 800, 0)
    const started = await api('/api/generations', {
      kind: 'image',
      holderShapeId: 'shape:gen_img1',
      prompt: '一只橘猫在窗台上晒太阳',
      model: 'krea2',
      resolution: '1K',
      count: 1,
      transparent: false,
      refs: [],
      projectDir,
      canvasDir
    })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const { request } = started.body
    assert.equal(request.executor, 'service')
    assert.equal(request.session, null)
    assert.match(request.title, /AI 图片 · Krea 2/)
    const done = await finished(request.id)
    assert.equal(done.status, 'done', done.message)
    assert.match(done.message, /已放进画布/)

    const store = await readStore()
    assert.ok(!store['shape:gen_img1'], 'the holder is still there')
    assert.ok(shapesOf(store, 'image').some((shape) => shape.meta?.cowartGeneratedForAiImageHolder === 'shape:gen_img1'), 'no image in the holder\'s place')
    const submit = (await logLines(beastLog)).find((entry) => entry.cmd === 'submit' && entry.template === 'krea2')
    assert.ok(submit, 'nothing was submitted to krea2')
    assert.equal(submit.inputs.ratio, '3:4')
    assert.equal(submit.inputs.resolution, '1K')
    assert.equal(submit.inputs.n, 1)
    assert.equal(submit.inputs.prompt, 'FAKE: 一只橘猫在窗台上晒太阳')
    const writer = (await logLines(claudeLog)).at(-1)
    assert.equal(writer.model, 'haiku')
    assert.equal(writer.tools, '', 'the prompt writer must run without tools')
    assert.equal(writer.strictMcp, true)
    assert.equal(writer.brief.template, 'krea2')
    assert.match(writer.system, /krea2: Write one English prompt/)
    assert.equal(await listener.saw((item) => item.event === 'request'), false, 'the request reached the session')
  })

  await step('自动 with a reference and 透明底: the writer picks FLUX.2 Klein, sees the reference, and both results are cut out and lined up', async () => {
    const reference = await bridge.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })
    assert.ok(!reference.isError, text(reference))
    referenceId = reference.structuredContent.shapeId
    const imagesBefore = shapesOf(await readStore(), 'image').length
    await addHolder('shape:gen_img2', IMAGE_HOLDER, 800, 800, 2000)
    const started = await api('/api/generations', {
      kind: 'image',
      holderShapeId: 'shape:gen_img2',
      prompt: '把 @图1 放到海边',
      model: 'auto',
      resolution: '1K',
      count: 2,
      transparent: true,
      refs: [{ shapeId: referenceId }],
      projectDir,
      canvasDir
    })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const done = await finished(started.body.request.id)
    assert.equal(done.status, 'done', done.message)
    assert.match(done.message, /2 个/)

    const log = await logLines(beastLog)
    const submit = log.find((entry) => entry.cmd === 'submit' && entry.template === 'flux2-klein')
    assert.ok(submit, JSON.stringify(log.map((entry) => entry.template)))
    assert.equal(submit.inputs.images.length, 1)
    assert.match(submit.inputs.images[0], /^up_/)
    assert.equal(submit.inputs.ratio, '1:1')
    assert.equal(submit.inputs.n, 2)
    assert.equal(submit.inputs.quality, 'turbo')
    assert.match(submit.inputs.prompt, /magenta/)
    const mattes = log.filter((entry) => entry.cmd === 'submit' && entry.template === 'matte')
    assert.equal(mattes.length, 2)
    assert.ok(mattes.every((entry) => /^up_beast_flux2-klein_/.test(entry.inputs.image_name)), JSON.stringify(mattes))

    const writer = (await logLines(claudeLog)).at(-1)
    assert.match(writer.brief.template, /^auto \(choose one of krea2, flux2-klein, flux2-dev\)$/, 'ideogram4 cannot do a transparent background')
    assert.equal(writer.images, 1, 'the writer did not see the reference')
    assert.deepEqual(writer.brief.materials.map((material) => [material.tag, material.mention]), [['image 1', '@图1']])

    const store = await readStore()
    assert.ok(!store['shape:gen_img2'], 'the holder is still there')
    assert.equal(shapesOf(store, 'image').length, imagesBefore + 2)
  })

  await step('AI 视频 (MiniMax H3) with a first frame: the prompt opens with the I2VA line, the video replaces the holder', async () => {
    await addHolder('shape:gen_vid1', VIDEO_HOLDER, 1280, 720, 4000)
    const videosBefore = shapesOf(await readStore(), 'video').length
    const started = await api('/api/generations', {
      kind: 'video',
      holderShapeId: 'shape:gen_vid1',
      prompt: '@首帧 里的猫伸个懒腰',
      model: 'h3',
      ratio: '16:9',
      resolution: '480P',
      duration: 5,
      quality: 'turbo',
      mode: 'frames',
      firstFrame: { shapeId: referenceId },
      lastFrame: null,
      refs: [],
      projectDir,
      canvasDir
    })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const done = await finished(started.body.request.id)
    assert.equal(done.status, 'done', done.message)

    const submit = (await logLines(beastLog)).find((entry) => entry.cmd === 'submit' && entry.template === 'minimax-h3')
    assert.match(submit.inputs.first_frame, /^up_/)
    assert.equal(submit.inputs.duration, 5)
    assert.equal(submit.inputs.turbo, true)
    assert.equal(submit.inputs.resolution, '480P')
    assert.ok(
      submit.inputs.prompt.startsWith('For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n'),
      submit.inputs.prompt
    )
    const writer = (await logLines(claudeLog)).at(-1)
    assert.equal(writer.brief.mode, 'I2VA')
    assert.deepEqual(writer.brief.materials.map((material) => [material.tag, material.mention]), [['<Picture 1>', '@首帧']])
    assert.match(writer.system, /h3-prompt\.md|minimax-h3:/)

    const store = await readStore()
    assert.ok(!store['shape:gen_vid1'], 'the video holder is still there')
    assert.equal(shapesOf(store, 'video').length, videosBefore + 1)
  })

  await step('a failed task says so on the canvas and leaves the holder; a withdrawn one never lands', async () => {
    await addHolder('shape:gen_img3', IMAGE_HOLDER, 600, 600, 6000)
    await addHolder('shape:gen_img4', IMAGE_HOLDER, 600, 600, 7000)
    const failing = await api('/api/generations', { kind: 'image', holderShapeId: 'shape:gen_img3', prompt: 'FAIL 这一张', model: 'krea2', count: 1, projectDir, canvasDir })
    const failed = await finished(failing.body.request.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.message, /假装失败/)
    assert.ok((await readStore())['shape:gen_img3'], 'a failed generation removed its holder')

    const slow = await api('/api/generations', { kind: 'image', holderShapeId: 'shape:gen_img4', prompt: 'SLOW 慢慢来', model: 'flux2-klein', count: 1, projectDir, canvasDir })
    const id = slow.body.request.id
    // The canvas shows where the task stands in the gateway's queue.
    await pane.next((item) => item.event === 'request' && item.data.id === id && /^排队中（第 1 位）· FLUX\.2 Klein/.test(item.data.message ?? ''), 15_000)
    const withdrawn = await api('/api/requests/cancel', { id })
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body))
    assert.equal(withdrawn.body.request.status, 'cancelled')
    await delay(5500)
    const store = await readStore()
    assert.ok(store['shape:gen_img4'], 'the withdrawn generation replaced its holder')
    assert.ok(!shapesOf(store, 'image').some((shape) => shape.meta?.cowartGeneratedForAiImageHolder === 'shape:gen_img4'))
    assert.ok((await logLines(beastLog)).some((entry) => entry.cmd === 'cancel'), 'the queued task was not withdrawn at the gateway')
    assert.equal((await api('/api/requests/cancel', { id })).status, 409)
  })

  await step('without a beast command line the panel is told to send the request to Claude', async () => {
    const other = await startBridge({ cwd: projectDir, port: FALLBACK_PORT, session: 'gen-fallback', env: { COWART_BEAST_CLI: join(projectDir, 'no-beast.mjs') } })
    try {
      const opened = await other.call('render_cowart_canvas_widget', { projectDir })
      const answer = await api(
        '/api/generations',
        { kind: 'image', holderShapeId: 'shape:gen_img3', prompt: '一只猫', model: 'krea2', projectDir, canvasDir },
        `http://127.0.0.1:${opened.structuredContent.port}`
      )
      assert.equal(answer.status, 409)
      assert.equal(answer.body.fallback, true)
      assert.match(answer.body.error, /beast 命令行/)
    } finally {
      await other.close()
      await stopTestService(FALLBACK_PORT)
    }
  })

  await step('without a prompt writer the words go in as typed, inside the structure the template needs', async () => {
    const i2va = fallbackPrompt({
      template: 'minimax-h3',
      mode: 'I2VA',
      firstLine: 'FIRST LINE',
      materials: [{ tag: '<Picture 1>', mention: '@首帧', kind: 'images' }],
      userPrompt: '@首帧 里的猫跳起来',
      transparent: false
    })
    assert.equal(
      i2va,
      'FIRST LINE\n\nintegrated_multimodal_description: [Shot 1] <Picture 1> 里的猫跳起来\n\noverall_soundscape: Natural ambient sound that fits the scene.\n\nnon_diegetic_music: N/A'
    )
    const ref2va = fallbackPrompt({
      template: 'minimax-h3',
      mode: 'Ref2VA',
      firstLine: null,
      materials: [{ tag: '<Picture 1>', mention: '@图1', kind: 'images' }],
      userPrompt: '@图1 在跳舞',
      transparent: false
    })
    for (const field of ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
      assert.ok(ref2va.includes(`\n${field}`) || ref2va.startsWith(field), `${field} missing:\n${ref2va}`)
    }
    assert.match(ref2va, /<Subject 1> is the subject shown in <Picture 1>\./)
    const flux = fallbackPrompt({ template: 'flux2-klein', materials: [{ tag: 'image 1', mention: '@图1', kind: 'images' }], userPrompt: '把 @图1 的背景换掉', transparent: true })
    assert.equal(flux, '把 image 1 的背景换掉, flat solid pure magenta background, no cast shadow')
  })
} finally {
  for (const stream of streams) stream.close()
  await bridge?.close()
  await stopTestService(PORT)
  await stopTestService(FALLBACK_PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

finish()
