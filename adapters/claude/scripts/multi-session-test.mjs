#!/usr/bin/env node
// Several Claude sessions on one canvas: one service for every bridge, session names, one
// session responsible for each page (the one that entered it last, from the session or
// from the canvas), requests routed to that session, delta saves from panes that edit the
// same canvas at once, model writes kept out of other sessions' pages, each session's own
// selection, a session ending and coming back, a changed checkout replacing the service
// (with more bridges starting meanwhile, all ending up on one service), one service per
// canvas, ports that do not answer yet waited for rather than skipped, idle exit, and the
// desktop-only switch. Bridges run over stdio like Claude Code runs them; canvas pages are
// played by event streams and the page API, on a test port.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PORT_ATTEMPTS, SERVICE_ENTRY, probeService } from '../../service/client.mjs'
import { canvasLockFile, canvasOwner } from '../../service/lib/canvas-lock.mjs'
import { EXIT_CANVAS_BUSY } from '../../service/lib/identity.mjs'
import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { EMPTY_CANVAS, FIXTURES, delay, finish, openEvents, serviceStatus, startBridge, step, stopTestService, text, waitFor } from './test-kit.mjs'

const PORT = Number(process.env.COWART_MULTI_PORT) || 43295
// Ports of their own for the checks of ports that do not answer and ports another program
// holds, and for services started by hand.
const QUIET_PORT = PORT + 40
const BUSY_PORT = PORT + 60
const HAND_PORTS = [PORT + 1, PORT + 70, PORT + 71]
// This checkout's code, for the replacement checks: writing another salt into the file is
// like changing the code on disk, for every bridge and service that starts afterwards.
const SALT_FILE = join(tmpdir(), `cowart-check-build-salt-${process.pid}.txt`)
// Short timers so the session and idle checks take seconds; bridges pass COWART_* on to
// the service they start.
const FAST = { COWART_SESSION_GRACE_MS: '300', COWART_SESSION_WAIT_MS: '1500', COWART_SERVICE_IDLE_MS: '1500', COWART_SERVICE_BUILD_SALT_FILE: SALT_FILE }

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-claude-multi-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

await stopTestService(PORT)
const origin = `http://127.0.0.1:${PORT}`
const bridges = []
const streams = []

async function bridgeFor(session, env = {}) {
  const bridge = await startBridge({ cwd: projectDir, port: PORT, session, env: { ...FAST, ...env } })
  bridges.push(bridge)
  return bridge
}

function events(path, headers) {
  const stream = openEvents(`${origin}${path}`, headers)
  streams.push(stream)
  return stream
}
// A canvas page: its event stream, with the pane id and canvas it shows.
const pane = (session, id) => events(`/api/page-events?${new URLSearchParams({ token, session, pane: id, canvasDir })}`)
const listener = (session) => events(`/api/agent-events?session=${session}`, { 'x-cowart-token': token })
// The listener program the way a session runs it: in the background, with --once.
const listenerRuns = []
function runListener(session) {
  const child = spawn(process.execPath, [join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-listen.mjs'), '--port', String(PORT), '--session', session, '--once'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })
  listenerRuns.push(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  return { child, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout }))) }
}

async function api(path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token, ...headers },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}
// A tool call as a canvas page makes it; without a pane id it is an older page (whole-canvas save).
const pageTool = (paneId, name, args = {}) =>
  api('/api/tools/call', { name, arguments: { projectDir, canvasDir, ...args } }, paneId ? { 'x-cowart-pane': paneId } : {})
const readSnapshot = async () => (await pageTool(null, 'get_cowart_canvas_state')).body.structuredContent.snapshot
const stored = async () => (await readSnapshot()).store
// The page tells the service which page it shows.
const showPage = (paneId, pageId, pageName) => api('/api/panes/page', { pane: paneId, pageId, pageName })
// A save the way the Claude page bridge makes it: the snapshot plus what changed in it.
const deltaSave = (paneId, snapshot, { put = [], remove = [] }) =>
  pageTool(paneId, 'save_cowart_canvas_state', { snapshot, protectImageRecords: true, acknowledgedImageShapeDeletes: [], cowartDelta: { put, remove } })
const holderIs = (pageId, session) => (item) => item.event === 'page-state' && (item.data.pages[pageId]?.holder ?? null) === session
const message = (session, paneId, pageId, pageName, body) => api('/api/messages', { text: body, session, pane: paneId, pageId, pageName, projectDir, canvasDir })
const sessionStatus = async (id) => (await serviceStatus(PORT))?.sessions.find((session) => session.id === id) ?? null

function frame(id, parentId, x) {
  return {
    id,
    typeName: 'shape',
    type: 'frame',
    x,
    y: 0,
    rotation: 0,
    index: 'a1',
    parentId,
    isLocked: false,
    opacity: 1,
    props: { w: 100, h: 100, name: id, color: 'blue' },
    meta: {}
  }
}

const connectedSessions = async () =>
  (await serviceStatus(PORT))?.sessions.filter((session) => session.bridge).map((session) => session.id).sort() ?? []

// The canvas services for a canvas on the test's ports: the main one and those bridges move on to.
async function servicesOn(canvas) {
  const found = []
  for (let port = PORT; port < PORT + PORT_ATTEMPTS; port += 1) {
    const probe = await probeService(port, token)
    if (probe.kind === 'cowart' && probe.status.canvasDir === canvas) found.push(probe.status)
  }
  return found
}

// A service started by hand for a canvas: { code } when it does not start, { status } once it answers.
async function runService(canvas, port) {
  const child = spawn(process.execPath, [SERVICE_ENTRY, '--port', String(port)], {
    env: { ...process.env, ...FAST, COWART_CANVAS_DIR: canvas, COWART_SESSION_NAMES_FILE: join(projectDir, 'hand-names.json') },
    stdio: 'ignore',
    windowsHide: true
  })
  let code = null
  child.on('exit', (exitCode) => {
    code = exitCode
  })
  return waitFor(async () => {
    if (code !== null) return { code }
    const status = await serviceStatus(port)
    return status?.pid === child.pid && { status }
  }, { timeoutMs: 15_000, what: `the service started by hand on ${port}` })
}

const listen = (server, port) => new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  const closed = new Promise((resolve) => server.close(() => resolve()))
  server.closeAllConnections?.()
  return closed
}

let a
let b
let paneA
let paneB
let listenA
let listenB
let firstPageId = ''
// 「角色设定」, created by session B entering it.
let ROLE = ''
let pendingForA = 0

try {
  await step('two sessions share one detached canvas service', async () => {
    a = await bridgeFor('multi-a')
    b = await bridgeFor('multi-b')
    await Promise.all([a.client.listTools(), b.client.listTools()])
    await waitFor(async () => (await connectedSessions()).join() === 'multi-a,multi-b', { what: 'both sessions' })
    const status = await serviceStatus(PORT)
    assert.equal(status.service, 'cowart-canvas')
    assert.notEqual(status.pid, process.pid)
    assert.ok(!(await a.client.listTools()).tools.some((tool) => tool.name === 'take_over_cowart_page'))

    // A card on the first page.
    const snapshot = await readSnapshot()
    firstPageId = Object.values(snapshot.store).find((record) => record.typeName === 'page').id
    const saved = await pageTool(null, 'save_cowart_canvas_state', { snapshot: { ...snapshot, store: { ...snapshot.store, 'shape:p1': frame('shape:p1', firstPageId, 0) } } })
    assert.equal(saved.body.structuredContent.ok, true, JSON.stringify(saved.body))
  })

  await step('sessions go by the names they gave themselves; entering a page by name creates it and makes the session responsible', async () => {
    const plain = await a.call('render_cowart_canvas_widget', { sessionName: '小川' })
    assert.equal(plain.structuredContent.sessionName, '小川')
    assert.equal(plain.structuredContent.page, null)
    assert.equal(plain.structuredContent.myPage, null)
    assert.match(text(plain), /你没负责任何页/)
    const taken = await b.call('render_cowart_canvas_widget', { sessionName: '小川' })
    assert.equal(taken.isError, true)
    assert.match(text(taken), /另一个会话的名字/)

    const opened = await b.call('render_cowart_canvas_widget', { sessionName: '阿满', page: '角色设定' })
    assert.ok(!opened.isError, text(opened))
    assert.equal(opened.structuredContent.sessionName, '阿满')
    assert.equal(opened.structuredContent.page, '角色设定')
    assert.equal(opened.structuredContent.pageCreated, true)
    const role = opened.structuredContent.pages.find((page) => page.name === '角色设定')
    assert.ok(role, JSON.stringify(opened.structuredContent.pages))
    ROLE = role.id
    assert.equal(role.holder, '阿满')
    assert.equal(role.mine, true)
    assert.equal(new URL(opened.structuredContent.url).searchParams.get('pageId'), ROLE)
    assert.match(text(opened), /你现在负责「角色设定」这一页（新建的）/)
    assert.ok((await stored())[ROLE], 'the page was not written to the canvas')
    assert.deepEqual((await serviceStatus(PORT)).sessions.map((session) => session.name).sort(), ['小川', '阿满'].sort())

    // A card on the new page (an older page saving the whole canvas).
    const snapshot = await readSnapshot()
    await pageTool(null, 'save_cowart_canvas_state', { snapshot: { ...snapshot, store: { ...snapshot.store, 'shape:r1': frame('shape:r1', ROLE, 0) } } })
  })

  await step('whoever enters a page last is responsible for it, and a session is responsible for one page at a time', async () => {
    const took = await a.call('render_cowart_canvas_widget', { page: '角色设定' })
    assert.equal(took.structuredContent.takenFrom, '阿满')
    assert.equal(took.structuredContent.pageCreated, false)
    assert.match(text(took), /从「阿满」那里接了过来/)
    assert.equal((await sessionStatus('multi-b')).page, null)

    const moved = await a.call('render_cowart_canvas_widget', { page: '分镜' })
    assert.equal(moved.structuredContent.pageCreated, true)
    const pages = moved.structuredContent.pages
    assert.equal(pages.find((page) => page.name === '分镜').mine, true)
    assert.equal(pages.find((page) => page.name === '角色设定').holder, null, '角色设定 should be free once A moved on')

    const back = await b.call('render_cowart_canvas_widget', { page: '角色设定' })
    assert.equal(back.structuredContent.takenFrom, null)
    assert.equal(back.structuredContent.myPage, '角色设定')
    const again = await b.call('render_cowart_canvas_widget', {})
    assert.equal(again.structuredContent.myPage, '角色设定', 'opening without a page must not release the page')
    assert.match(text(again), /你负责的还是「角色设定」/)
  })

  await step("a page's request goes to the session responsible for it, whichever pane it was clicked in; a free page goes to the pane's session", async () => {
    paneA = pane('multi-a', 'pane-a')
    paneB = pane('multi-b', 'pane-b')
    listenA = listener('multi-a')
    listenB = listener('multi-b')
    await Promise.all([paneA.ready, paneB.ready, listenA.ready, listenB.ready])
    const opening = await paneA.next((item) => item.event === 'page-state')
    assert.equal(opening.data.pages[ROLE].holder, 'multi-b')
    assert.equal(opening.data.names['multi-a'], '小川')
    await showPage('pane-a', ROLE, '角色设定')
    await showPage('pane-b', ROLE, '角色设定')

    // Clicked in A's pane on B's page: B gets it, both panes see it.
    const sent = await message('multi-a', 'pane-a', ROLE, '角色设定', '按标注修改\n\nPrompt:\n在小川的面板里点的')
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.request.session, 'multi-b')
    const delivered = await listenB.next((item) => item.event === 'request' && item.data.id === sent.body.request.id)
    assert.equal(delivered.data.page, '角色设定')
    assert.equal(await listenA.saw((item) => item.event === 'request' && item.data.id === sent.body.request.id), false)
    await paneA.next((item) => item.event === 'request' && item.data.id === sent.body.request.id)
    await paneB.next((item) => item.event === 'request' && item.data.id === sent.body.request.id)
    // Withdrawn from the other pane.
    const cancelled = await api('/api/requests/cancel', { id: sent.body.request.id })
    assert.equal(cancelled.body.request.status, 'cancelled')
    await listenB.next((item) => item.event === 'cancelled' && item.data.id === sent.body.request.id)

    // Clicked on a page nobody holds: A takes the page (and lets go of 分镜).
    paneB.clear()
    const free = await message('multi-a', 'pane-a', firstPageId, 'Page 1', 'AI 图片\n\nPrompt:\n没人负责的页')
    assert.equal(free.body.request.session, 'multi-a')
    pendingForA = free.body.request.id
    await listenA.next((item) => item.event === 'request' && item.data.id === pendingForA)
    await paneB.next(holderIs(firstPageId, 'multi-a'))
    const status = await serviceStatus(PORT)
    assert.equal(status.sessions.find((session) => session.id === 'multi-a').page.pageId, firstPageId)
    assert.ok(!(await b.call('render_cowart_canvas_widget', {})).structuredContent.pages.find((page) => page.name === '分镜').holder, '分镜 should be free')
  })

  await step("the page's button hands the page to the pane's session; 接管这页 does the same from the session", async () => {
    paneB.clear()
    const entered = await api('/api/pages/enter', { pane: 'pane-a' })
    assert.equal(entered.status, 200, JSON.stringify(entered.body))
    assert.equal(entered.body.previous, '阿满')
    await paneB.next(holderIs(ROLE, 'multi-a'))
    assert.equal((await sessionStatus('multi-a')).page.pageId, ROLE)
    assert.equal((await sessionStatus('multi-b')).page, null)

    paneA.clear()
    const shown = await b.call('render_cowart_canvas_widget', { shownPage: true })
    assert.ok(!shown.isError, text(shown))
    assert.equal(shown.structuredContent.page, '角色设定')
    assert.equal(shown.structuredContent.takenFrom, '小川')
    await paneA.next(holderIs(ROLE, 'multi-b'))

    // B's open pane goes to the page B entered, and B's canvas opens there whatever its URL says.
    assert.equal(shown.structuredContent.paneOpen, true)
    await paneB.next((item) => item.event === 'goto-page' && item.data.pageId === ROLE)
    assert.equal(await paneA.saw((item) => item.event === 'goto-page'), false, "another session's pane was moved")
    const html = await (await fetch(shown.structuredContent.url.replace(/pageId=[^&]+/, `pageId=${encodeURIComponent(firstPageId)}`))).text()
    assert.ok(html.includes(`"heldPageId":"${ROLE}"`), 'the canvas does not open on the page its session is responsible for')
    // A bare address (the pane's card keeping only the origin) shows the canvas opened last.
    const bare = await fetch(`${origin}/`, { redirect: 'manual' })
    assert.equal(bare.status, 302)
    assert.match(bare.headers.get('location') ?? '', /session=multi-b/)
  })

  await step('a page saves what changed in it: stale copies cannot undo others, pages never vanish, deletions propagate', async () => {
    const base = await readSnapshot()
    const r1 = base.store['shape:r1']

    // A's stale copy moves r1 while somebody else added p2 to the first page.
    const withP2 = structuredClone(base)
    withP2.store['shape:p2'] = frame('shape:p2', firstPageId, 300)
    await pageTool(null, 'save_cowart_canvas_state', { snapshot: withP2 })
    const fromA = structuredClone(base)
    fromA.store['shape:r1'] = { ...r1, x: 500 }
    const saved = await deltaSave('pane-a', fromA, { put: [fromA.store['shape:r1']] })
    assert.equal(saved.body.structuredContent.ok, true, JSON.stringify(saved.body))
    let store = await stored()
    assert.equal(store['shape:r1'].x, 500, "A's change was lost")
    assert.ok(store['shape:p2'], "A's stale copy dropped a card it never saw")

    // Both panes add a card to the same page, each unaware of the other's.
    const fromA2 = structuredClone(fromA)
    fromA2.store['shape:r2'] = frame('shape:r2', ROLE, 200)
    await deltaSave('pane-a', fromA2, { put: [fromA2.store['shape:r2']] })
    const fromB = structuredClone(base)
    fromB.store['shape:r3'] = frame('shape:r3', ROLE, 400)
    await deltaSave('pane-b', fromB, { put: [fromB.store['shape:r3']] })
    store = await stored()
    assert.ok(store['shape:r2'] && store['shape:r3'], 'one pane overwrote the other')
    assert.equal(store['shape:r1'].x, 500)

    // A deletes r1 (a delta with only the removal); B's copy still has it and moves r2: r1 stays gone.
    const fromA3 = structuredClone(fromA2)
    delete fromA3.store['shape:r1']
    await deltaSave('pane-a', fromA3, { remove: ['shape:r1'] })
    const fromB2 = structuredClone(fromB)
    fromB2.store['shape:r2'] = { ...frame('shape:r2', ROLE, 250) }
    await deltaSave('pane-b', fromB2, { put: [fromB2.store['shape:r2']] })
    store = await stored()
    assert.ok(!store['shape:r1'], 'a deleted card came back')
    assert.equal(store['shape:r2'].x, 250)

    // A page the user adds in B's pane is created, and a pane that never saw it cannot delete it.
    const adding = structuredClone(await readSnapshot())
    adding.store['page:new'] = { ...adding.store[firstPageId], id: 'page:new', name: '临时', index: 'a8' }
    adding.store['shape:n1'] = frame('shape:n1', 'page:new', 0)
    await deltaSave('pane-b', adding, { put: [adding.store['page:new'], adding.store['shape:n1']] })
    assert.ok((await stored())['page:new'], 'the new page was not created')
    const staleA = structuredClone(fromA3)
    staleA.store['shape:r2'] = { ...staleA.store['shape:r2'], x: 700 }
    await deltaSave('pane-a', staleA, { put: [staleA.store['shape:r2']] })
    store = await stored()
    assert.ok(store['page:new'] && store['shape:n1'], 'a page the pane never saw was deleted')
    assert.equal(store['shape:r2'].x, 700)

    // A takes the new page, then the user deletes it in B's pane: gone, every pane hears of
    // it, and nobody is responsible for it any more.
    await a.call('render_cowart_canvas_widget', { page: '临时' })
    assert.equal((await sessionStatus('multi-a')).page.pageId, 'page:new')
    paneA.clear()
    const removing = structuredClone(await readSnapshot())
    delete removing.store['page:new']
    delete removing.store['shape:n1']
    await deltaSave('pane-b', removing, { remove: ['page:new', 'shape:n1'] })
    assert.ok(!(await stored())['page:new'], 'the deleted page is still there')
    await paneA.next((item) => item.event === 'pages-deleted' && item.data.pageIds.includes('page:new'))
    await waitFor(async () => (await sessionStatus('multi-a')).page === null, { what: 'the deleted page to be released' })

    // A tldraw upgrade: the stored canvas was written by an older tldraw (its schema differs
    // from the page's), so the page saves the whole canvas, migrated in its memory.
    const current = structuredClone(await readSnapshot())
    for (const dir of await readdir(join(canvasDir, 'pages'), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const file = join(canvasDir, 'pages', dir.name, 'cowart-canvas.json')
      const older = JSON.parse(await readFile(file, 'utf8'))
      older.schema.sequences['com.tldraw.store'] -= 1
      await writeFile(file, JSON.stringify(older))
    }
    const upgraded = structuredClone(current)
    delete upgraded.store['shape:p2']
    const whole = await deltaSave('pane-a', upgraded, { put: [] })
    assert.equal(whole.body.structuredContent.ok, true, JSON.stringify(whole.body))
    assert.ok(!(await stored())['shape:p2'], 'a schema change must save the whole canvas')
    assert.deepEqual((await readSnapshot()).schema, current.schema)
    await pageTool(null, 'save_cowart_canvas_state', { snapshot: current })
  })

  await step('the model writes into the page its session is responsible for, else the page its pane shows, never into another session\'s page', async () => {
    // B holds 角色设定; A holds nothing and its pane shows 角色设定.
    assert.equal((await sessionStatus('multi-b')).page.pageId, ROLE)
    assert.equal((await sessionStatus('multi-a')).page, null)
    const refused = await a.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png'), pageId: ROLE })
    assert.equal(refused.isError, true)
    assert.match(text(refused), /「角色设定」这一页由「阿满」负责/)
    assert.equal((await a.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })).isError, true, 'the pane shows B\'s page')

    // A's pane moves to the free first page: the insert follows the pane, without taking the page.
    await showPage('pane-a', firstPageId, 'Page 1')
    const followed = await a.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })
    assert.ok(!followed.isError, text(followed))
    assert.equal((await stored())[followed.structuredContent.shapeId].parentId, firstPageId)
    assert.equal((await sessionStatus('multi-a')).page, null)

    // B's pane shows the first page, but B is responsible for 角色设定: the insert goes there.
    await showPage('pane-b', firstPageId, 'Page 1')
    const held = await b.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })
    assert.ok(!held.isError, text(held))
    assert.equal((await stored())[held.structuredContent.shapeId].parentId, ROLE)

    // B is handling a request from 角色设定 when A takes the page: B's result still goes in.
    const request = await message('multi-b', 'pane-b', ROLE, '角色设定', 'AI 图片\n\nPrompt:\n来自 B')
    assert.equal(request.body.request.session, 'multi-b')
    await a.call('render_cowart_canvas_widget', { page: '角色设定' })
    const result = await b.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png'), pageId: ROLE })
    assert.ok(!result.isError, text(result))
    await b.call('reply_cowart_request', { id: request.body.request.id, status: 'done', message: '放好了' })
    assert.equal((await b.call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png'), pageId: ROLE })).isError, true)
    const summary = await b.call('get_cowart_canvas_state', {})
    assert.match(text(summary), /角色设定 → 小川/)
  })

  await step('each session reads its own selection', async () => {
    await pageTool('pane-a', 'save_cowart_selection_state', { selection: { selectedShapes: [{ id: 'shape:r2', type: 'frame' }] } })
    await pageTool('pane-b', 'save_cowart_selection_state', { selection: { selectedShapes: [{ id: 'shape:p1', type: 'frame' }] } })
    const ofA = JSON.stringify(await a.call('get_cowart_selection', {}))
    assert.match(ofA, /shape:r2/)
    assert.doesNotMatch(ofA, /shape:p1/)
    assert.match(JSON.stringify(await b.call('get_cowart_selection', {})), /shape:p1/)
  })

  await step('every session works on the one canvas: a session from another project, and a page whose URL names its own canvas', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'cowart-claude-elsewhere-'))
    try {
      // This bridge would start a service on its project's canvas; the running one keeps its canvas.
      const d = await startBridge({ cwd: elsewhere, port: PORT, session: 'multi-d', env: FAST })
      bridges.push(d)
      const opened = await d.call('render_cowart_canvas_widget', { sessionName: '阿澈' })
      assert.ok(!opened.isError, text(opened))
      assert.equal(opened.structuredContent.canvasDir, canvasDir)
      assert.equal(opened.structuredContent.projectDir, elsewhere)
      assert.ok(opened.structuredContent.pages.some((page) => page.id === ROLE), JSON.stringify(opened.structuredContent.pages))
      assert.match(text(opened), /所有会话、所有项目共用这一张/)
      const insert = (await d.client.listTools()).tools.find((tool) => tool.name === 'insert_cowart_image')
      assert.ok(insert && !('projectDir' in insert.inputSchema.properties) && !('canvasDir' in insert.inputSchema.properties), 'the model is still asked for a canvas')

      // A page whose URL still names its project's own canvas gets the one canvas.
      const old = await api('/api/tools/call', { name: 'get_cowart_canvas_state', arguments: { projectDir: elsewhere, canvasDir: join(elsewhere, 'canvas') } })
      assert.ok(old.body.structuredContent.snapshot.store[ROLE], 'a page naming another canvas did not get the one canvas')
      assert.ok(!(await readdir(elsewhere)).includes('canvas'), 'a canvas was made in the other project')
      await d.close()
    } finally {
      await rm(elsewhere, { recursive: true, force: true }).catch(() => {})
    }
  })

  await step('a session that ends releases its page, and hears its pending requests again when it comes back', async () => {
    // A holds 角色设定 and has one unanswered request (from the first page, earlier).
    assert.equal((await sessionStatus('multi-a')).page.pageId, ROLE)
    paneA.clear()
    paneB.clear()
    await a.close()
    await paneA.next((item) => item.event === 'presence' && item.data.session === 'ended')
    await paneB.next(holderIs(ROLE, null))
    await listenA.next((item) => item.event === 'session-ended')
    assert.equal((await sessionStatus('multi-a')).state, 'ended')
    assert.equal((await sessionStatus('multi-a')).page, null)

    // Clicked in the ended session's pane: the page is free, but that pane's session is gone.
    const orphan = await message('multi-a', 'pane-a', ROLE, '角色设定', '按标注修改\n\nPrompt:\n没人接')
    assert.equal(orphan.status, 409)
    assert.match(orphan.body.error, /会话已经结束/)
    // Clicked in B's pane: B takes the free page.
    const taken = await message('multi-b', 'pane-b', ROLE, '角色设定', '按标注修改\n\nPrompt:\nB 接手')
    assert.equal(taken.body.request.session, 'multi-b')
    await listenB.next((item) => item.event === 'request' && item.data.id === taken.body.request.id)

    a = await bridgeFor('multi-a')
    await a.client.listTools()
    await paneA.next((item) => item.event === 'presence' && item.data.session === 'online')
    const resumed = listener('multi-a')
    await resumed.ready
    await resumed.next((item) => item.event === 'request' && item.data.id === pendingForA)
    const pending = await a.call('list_cowart_requests', {})
    assert.ok(pending.structuredContent.requests.some((entry) => entry.id === pendingForA), text(pending))
    assert.ok(!pending.structuredContent.requests.some((entry) => entry.session === 'multi-b'))
    assert.equal((await sessionStatus('multi-a')).page, null, 'an ended session does not get its page back by itself')
  })

  await step('changed code in this checkout replaces the service; responsibilities survive, bridges follow without replacing it back', async () => {
    const before = await serviceStatus(PORT)
    assert.equal(before.sessions.find((session) => session.id === 'multi-b').page.pageId, ROLE)
    // A request waiting in the queue outlives the service, number and all.
    const kept = await message('multi-b', 'pane-b', ROLE, '角色设定', '按标注修改\n\nPrompt:\n换了版本也还在')
    assert.equal(kept.status, 200, JSON.stringify(kept.body))
    // A listener run waiting in the background outlives the replacement, so the session is not
    // woken for it; the next request still reaches it.
    const waiting = runListener('multi-b')
    await listenB.next((item) => item.event === 'replaced')
    // The code changes: the session that starts next replaces the service.
    await writeFile(SALT_FILE, 'changed-code')
    const c = await bridgeFor('multi-c')
    await c.client.listTools()
    const after = await waitFor(async () => {
      const status = await serviceStatus(PORT)
      return status && status.pid !== before.pid && status
    }, { timeoutMs: 20_000, what: 'the replacement service' })
    assert.notEqual(after.build, before.build)
    await waitFor(async () => (await connectedSessions()).join() === 'multi-a,multi-b,multi-c', { timeoutMs: 15_000, what: 'bridges to reconnect' })
    assert.equal((await sessionStatus('multi-b')).page.pageId, ROLE, 'the restarted service forgot who is responsible')
    const listed = await b.call('list_cowart_requests', {})
    assert.ok(!listed.isError, text(listed))
    const again = await b.call('get_cowart_request', { id: kept.body.request.id })
    assert.ok(!again.isError, text(again))
    assert.equal(again.structuredContent.requestKey, kept.body.request.requestKey)
    assert.equal(again.structuredContent.status, 'pending')
    assert.equal(waiting.child.exitCode, null, 'the replacement ended the listener run')
    const next = await message('multi-b', 'pane-b', ROLE, '角色设定', '按标注修改\n\nPrompt:\n换版本后的第一条')
    assert.ok(next.body.request.id > kept.body.request.id, 'the replacement service numbered requests from 1 again')
    const woken = await Promise.race([waiting.done, delay(15_000).then(() => ({ code: 'still waiting', stdout: '' }))])
    assert.equal(woken.code, 0, woken.stdout)
    assert.match(woken.stdout, new RegExp(`^Cowart 画布请求 #${next.body.request.id}「`, 'm'))
    for (const id of [kept.body.request.id, next.body.request.id]) {
      const skipped = await b.call('reply_cowart_request', { id, status: 'skipped' })
      assert.ok(!skipped.isError, text(skipped))
    }
    await delay(1500)
    assert.equal((await serviceStatus(PORT)).pid, after.pid, 'an older bridge replaced the service back')
  })

  await step('bridges that start while the service is being replaced all end up on one service', async () => {
    const before = await serviceStatus(PORT)
    // The code changes again and several sessions start at once: each one replaces the
    // service at the same moment, while the connected bridges come back to whichever runs.
    await writeFile(SALT_FILE, 'changed-again')
    const herd = Array.from({ length: 6 }, (_, index) => `multi-herd-${index}`)
    const started = await Promise.all(herd.map((session) => bridgeFor(session)))
    await Promise.all(started.map((bridge) => bridge.client.listTools()))
    const everyone = ['multi-a', 'multi-b', 'multi-c', ...herd].sort().join()
    const after = await waitFor(async () => {
      const status = await serviceStatus(PORT)
      const connected = status?.sessions.filter((session) => session.bridge).map((session) => session.id).sort().join()
      return status && status.pid !== before.pid && connected === everyone && status
    }, { timeoutMs: 30_000, what: 'every bridge on one replacement service' }).catch(async (error) => {
      const services = (await servicesOn(canvasDir)).map((status) => `${status.port} (pid ${status.pid}): ${status.sessions.filter((session) => session.bridge).map((session) => session.id).join(', ')}`)
      throw new Error(`${error.message}; services on the canvas: ${services.join(' | ')}`)
    })
    assert.notEqual(after.build, before.build, 'the service does not run the changed code')
    await delay(1500)
    assert.equal((await serviceStatus(PORT)).pid, after.pid, 'the service was replaced again')
    assert.deepEqual((await servicesOn(canvasDir)).map((status) => status.port), [PORT], 'a second service runs on the canvas')
    assert.equal(canvasOwner(canvasDir)?.pid, after.pid, 'the canvas lock does not name the service')
  })

  await step('one service per canvas: a second one for the same canvas stays down; a lock left behind by a service that is gone does not', async () => {
    const running = await serviceStatus(PORT)
    const owner = canvasOwner(canvasDir)
    assert.deepEqual([owner?.pid, owner?.port], [running.pid, PORT])
    // What a bridge that moved on to the next port used to start: a second writer.
    const second = await runService(canvasDir, PORT + 1)
    assert.equal(second.code, EXIT_CANVAS_BUSY, 'a second service started on the canvas')
    assert.equal(canvasOwner(canvasDir)?.pid, running.pid)

    // Locks left behind an hour ago, answering nowhere: by a service whose process ended, and
    // one whose pid another program runs now (this check's own).
    const stale = join(projectDir, 'stale-canvas')
    await mkdir(stale, { recursive: true })
    const ended = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => ended.on('exit', resolve))
    const earlier = new Date(Date.now() - 3_600_000).toISOString()
    for (const [index, pid] of [ended.pid, process.pid].entries()) {
      const port = HAND_PORTS[1 + index]
      await writeFile(canvasLockFile(stale), JSON.stringify({ pid, port: port + 10, canvasDir: stale, startedAt: earlier, id: `left-${index}` }))
      const started = await runService(stale, port)
      assert.ok(started.status, `a lock left by pid ${pid} kept the service down (exit ${started.code})`)
      assert.equal(canvasOwner(stale)?.pid, started.status.pid)
      await stopTestService(port)
      assert.equal(canvasOwner(stale), null, 'a stopped service kept the canvas')
    }
  })

  await step('a port that is taken but does not answer yet is waited for, not skipped; a port another program answers on is skipped', async () => {
    // Like a canvas service that is stopping or starting, or other bridges testing the port:
    // taken, and every connection dropped.
    const dropping = net.createServer((socket) => socket.resetAndDestroy())
    const other = http.createServer((_, res) => res.writeHead(404).end('not a canvas service'))
    await Promise.all([listen(dropping, QUIET_PORT), listen(other, BUSY_PORT)])
    const projects = await Promise.all(['quiet', 'busy'].map((name) => mkdtemp(join(tmpdir(), `cowart-claude-${name}-`))))
    try {
      const waiting = await startBridge({ cwd: projects[0], port: QUIET_PORT, session: 'multi-quiet', env: FAST })
      const skipping = await startBridge({ cwd: projects[1], port: BUSY_PORT, session: 'multi-busy', env: FAST })
      bridges.push(waiting, skipping)
      const listed = Promise.all([waiting.client.listTools(), skipping.client.listTools()])
      await delay(1500)
      await closeServer(dropping)
      await listed
      const quiet = await serviceStatus(QUIET_PORT)
      assert.ok(quiet?.sessions.some((session) => session.id === 'multi-quiet' && session.bridge), 'the bridge did not wait for the port')
      assert.equal(await serviceStatus(QUIET_PORT + 1), null, 'the bridge moved on and started a service on the next port')
      const past = await serviceStatus(BUSY_PORT + 1)
      assert.ok(past?.sessions.some((session) => session.id === 'multi-busy' && session.bridge), 'the bridge did not move past the other program')
      await waiting.close()
      await skipping.close()
    } finally {
      await closeServer(dropping)
      await closeServer(other)
      for (const port of [QUIET_PORT, QUIET_PORT + 1, BUSY_PORT + 1]) await stopTestService(port)
      for (const dir of projects) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  await step('the service exits once no session and no page is left', async () => {
    for (const stream of streams) stream.close()
    for (const bridge of bridges) await bridge.close()
    await waitFor(async () => !(await serviceStatus(PORT)), { timeoutMs: 15_000, what: 'the idle service to exit' })
  })

  await step('outside the desktop app the bridge offers no tools and starts nothing', async () => {
    const cli = await bridgeFor('multi-cli', { CLAUDE_CODE_ENTRYPOINT: 'cli' })
    assert.deepEqual((await cli.client.listTools()).tools, [])
    assert.match(cli.client.getInstructions() ?? '', /只在 Claude Code 桌面版/)
    await delay(500)
    assert.equal(await serviceStatus(PORT), null)
    await cli.close()

    const allowed = await bridgeFor('multi-cli-allowed', { CLAUDE_CODE_ENTRYPOINT: 'cli', COWART_ALLOW_CLI: '1' })
    assert.ok((await allowed.client.listTools()).tools.some((tool) => tool.name === 'render_cowart_canvas_widget'))
    await allowed.close()
  })
} finally {
  for (const child of listenerRuns) child.kill()
  for (const stream of streams) stream.close()
  for (const bridge of bridges) await bridge.close()
  for (const status of await servicesOn(canvasDir)) await stopTestService(status.port)
  for (const port of HAND_PORTS) await stopTestService(port)
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  await rm(SALT_FILE, { force: true })
}

finish()
