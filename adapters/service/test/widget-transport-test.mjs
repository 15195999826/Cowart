// Isolated HTTP boundary checks: no installed plugin, real canvas, Beast or Claude process.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import test from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'cowart-widget-transport-'))
process.env.COWART_SESSION_NAMES_FILE = join(directory, 'names.json')
process.env.COWART_RUNTIME_DIR = join(directory, 'runtime')
process.env.COWART_WIDGET_LEASE_MS = '500'
process.env.COWART_DELIVERY_LEASE_MS = '120'
const { CanvasServer } = await import('../lib/server.mjs')
const { CanvasRequestQueue } = await import('../lib/requests.mjs')
const { WidgetPanes } = await import('../lib/widget-panes.mjs')
const { CanvasServiceClient } = await import('../client.mjs')
const { localIdentity } = await import('../lib/identity.mjs')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

test('widget event cursors replay, recover overflow and expire without exposing another pane', async () => {
  const expired = []
  const panes = new WidgetPanes({ leaseMs: 30, maxEvents: 2, onExpired: (pane) => expired.push(pane.id) })
  try {
    const { pane } = panes.touch({ pane: 'one', session: 'codex-a', canvasDir: directory })
    assert.throws(() => panes.touch({ pane: 'one', session: 'codex-b', canvasDir: directory }), /另一个会话/)
    const initial = await panes.poll(pane, null, () => [{ event: 'hello', data: { fresh: true } }])
    panes.send(pane, 'request', { id: 1 })
    const received = await panes.poll(pane, initial.cursor, () => assert.fail('valid cursor must replay'))
    assert.deepEqual(received.events, [{ event: 'request', data: { id: 1 } }])
    assert.deepEqual(await panes.poll(pane, initial.cursor, () => []), received, 'lost poll response must replay')
    assert.deepEqual((await panes.poll(pane, received.cursor, () => [])).events, [])
    panes.send(pane, 'request', { id: 2 })
    panes.send(pane, 'request', { id: 3 })
    const recovered = await panes.poll(pane, initial.cursor, () => [{ event: 'requests', data: { reset: true } }])
    assert.equal(recovered.events[0].data.reset, true)
    await delay(45)
    assert.deepEqual(expired, ['one'])
    const renewed = panes.touch({ pane: 'one', session: 'codex-a', canvasDir: directory }).pane
    const restarted = await panes.poll(renewed, recovered.cursor, () => [{ event: 'hello', data: {} }])
    assert.equal(restarted.events[0].event, 'hello')
    assert.notEqual(restarted.cursor, recovered.cursor)
  } finally {
    panes.close()
  }
})

test('mixed-host page transport and atomic native-message delivery', async (t) => {
  const canvasDir = join(directory, 'canvas')
  const queue = new CanvasRequestQueue()
  const ops = new EventEmitter()
  let pages = [{ id: 'page:first', name: 'First' }, { id: 'page:second', name: 'Second' }]
  const toolCalls = []
  ops.canvasPages = async () => pages
  ops.ensurePage = async (_args, name) => pages.find((page) => page.name === name)
  ops.callFromPage = async (name, args, context) => {
    toolCalls.push({ name, args, context })
    if (name === 'get_cowart_canvas_state') return { structuredContent: { snapshot: { store: Object.fromEntries(pages.map((page) => [page.id, { ...page, typeName: 'page' }])) } } }
    return { structuredContent: { ok: true } }
  }
  const generationCalls = []
  const jobs = {
    running: 0,
    availability: () => ({ ok: true }),
    start: async ({ args, host }) => {
      generationCalls.push({ args, host })
      return queue.create({ ...args, executor: 'service' })
    }
  }
  const server = new CanvasServer({
    token: 'isolated-test-token', identity: { service: 'cowart-canvas', protocol: 3, version: 'test', build: 'test' },
    canvasDir, queue, ops, jobs, renderPage: async () => '<html></html>'
  })
  const controllers = []
  await server.start({ port: 0 })
  const headers = { 'content-type': 'application/json', 'x-cowart-token': 'isolated-test-token' }
  const post = async (path, body, extra = {}) => {
    const result = await fetch(server.origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    return { status: result.status, body: await result.json() }
  }
  const call = async (session, op, args) => {
    const response = await post('/api/bridge/call', { session, cwd: directory, op, args })
    assert.equal(response.status, 200, JSON.stringify(response))
    return response.body.result
  }
  const action = (session, pane, path, body = {}) => call(session, 'widget-call', { pane, path, body })
  const poll = (session, pane, cursor) => call(session, 'widget-poll', { pane, cursor })
  async function stream(path) {
    const controller = new AbortController()
    controllers.push(controller)
    const response = await fetch(server.origin + path, { headers, signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    void (async () => { try { while (!(await reader.read()).done) {} } catch {} })()
  }
  try {
    for (const [session, host] of [['native-a', 'codex'], ['native-b', 'codex'], ['browser-c', 'claude']]) {
      await stream(`/api/bridge/session?${new URLSearchParams({ session, host })}`)
    }
    let cursorA
    let cursorB
    await t.test('registers native panes and sends authoritative page state', async () => {
      const a = await poll('native-a', 'pane-a')
      cursorA = a.cursor
      cursorB = (await poll('native-b', 'pane-b')).cursor
      assert.equal(a.events.find((item) => item.event === 'presence').data.agentOnline, true)
      assert.deepEqual(a.events.find((item) => item.event === 'page-state').data.allPageIds, ['page:first', 'page:second'])
      assert.equal(JSON.stringify(a).includes('isolated-test-token'), false)
      assert.equal(server.pageCount, 2)
      await action('native-a', 'pane-a', '/api/panes/page', { pageId: 'page:first', pageName: 'First' })
      await action('native-b', 'pane-b', '/api/panes/page', { pageId: 'page:second', pageName: 'Second' })
    })
    await t.test('forwards page tools and generation with bridge-owned host, pane and one canvas', async () => {
      const saved = await action('native-a', 'pane-a', '/api/tools/call', { name: 'save_cowart_canvas_state', arguments: { canvasDir: 'wrong', cowartDelta: { put: [], remove: [] } } })
      assert.equal(saved.status, 200)
      assert.equal(toolCalls.at(-1).args.canvasDir, canvasDir)
      assert.equal(toolCalls.at(-1).context.host, 'codex')
      assert.equal(toolCalls.at(-1).context.pane.session, 'native-a')
      assert.deepEqual(toolCalls.at(-1).args.cowartDelta, { put: [], remove: [] })
      await action('native-a', 'pane-a', '/api/generations', { kind: 'video', host: 'claude', canvasDir: 'wrong' })
      assert.equal(generationCalls.at(-1).host, 'codex')
      assert.equal(generationCalls.at(-1).args.canvasDir, canvasDir)
      assert.equal((await action('native-a', 'pane-a', '/api/messages', { text: 'forged', session: 'native-b' })).status, 403)
      assert.equal((await action('native-a', 'pane-a', '/api/panes/page', { pane: 'pane-b', pageId: 'page:first' })).status, 403)
      const forged = await post('/api/bridge/call', { session: 'native-b', op: 'widget-poll', args: { pane: 'pane-a' } })
      assert.equal(forged.status, 422)
      assert.equal((await action('native-a', 'pane-a', '/api/service/shutdown')).status, 404)
    })
    let requestId
    await t.test('claim atomically registers a page; automatic claim preserves another owner', async () => {
      const first = await action('native-a', 'fresh-claim-pane', '/api/pages/enter', { pageId: 'page:first', onlyIfFree: true })
      assert.equal(first.payload.claimed, true)
      const refused = await action('native-b', 'fresh-other-pane', '/api/pages/enter', { pageId: 'page:first', onlyIfFree: true })
      assert.equal(refused.payload.claimed, false)
      assert.equal(server.presence.holderOf(canvasDir, 'page:first'), 'native-a')
      assert.equal((await action('native-b', 'fresh-other-pane', '/api/pages/enter', { pageId: 'page:deleted' })).status, 404)
      server.presence.release('native-a')
    })
    await t.test('native views survive new panes and remain isolated per session', async () => {
      const view = { currentPageId: 'page:first', camera: { x: 71, y: -29, z: 0.75 }, cowartPlayback: { 'shape:video': { time: 3.5, paused: true } } }
      await action('native-a', 'pane-a', '/api/tools/call', { name: 'save_cowart_view_state', arguments: { viewState: view } })
      const load = (session, pane) => action(session, pane, '/api/tools/call', { name: 'get_cowart_canvas_state' })
      assert.deepEqual((await load('native-a', 'replacement-pane')).payload.structuredContent.viewState, view)
      assert.equal((await load('native-b', 'pane-b')).payload.structuredContent.viewState, undefined)
      await call('native-a', 'open-canvas', { page: 'Second' })
      assert.equal((await load('native-a', 'replacement-pane')).payload.structuredContent.viewState, undefined)
      // Leave responsibility as the later routing checks expect.
      server.presence.release('native-a')
    })
    await t.test('native message clicked elsewhere stays with its actual page owner', async () => {
      await action('native-b', 'pane-b', '/api/pages/enter')
      const sent = await action('native-a', 'pane-a', '/api/messages', { text: 'native owner request', pageId: 'page:second', pageName: 'Second' })
      assert.equal(sent.payload.request.session, 'native-b')
      assert.equal(sent.payload.request.delivered, false)
      requestId = sent.payload.request.id
      const received = await poll('native-b', 'pane-b', cursorB)
      assert.ok(received.events.some((item) => item.event === 'request' && item.data.id === requestId))
      assert.equal((await action('native-a', 'pane-a', '/api/requests/claim', { id: requestId })).status, 409)
      const opened = await call('native-b', 'open-canvas', { page: 'Second' })
      assert.equal(opened.heldPageId, 'page:second')
      assert.equal(opened.protocol, 3)
      assert.equal(opened.paneOpen, true)
      const moved = await poll('native-b', 'pane-b', received.cursor)
      assert.ok(moved.events.some((item) => item.event === 'goto-page' && item.data.pageId === 'page:second'))
    })
    await t.test('two native panes cannot both claim or acknowledge one delivery', async () => {
      await poll('native-b', 'pane-b-two')
      const claims = await Promise.all([
        action('native-b', 'pane-b', '/api/requests/claim', { id: requestId }),
        action('native-b', 'pane-b-two', '/api/requests/claim', { id: requestId })
      ])
      assert.equal(claims.filter((entry) => entry.payload.request).length, 1)
      const winner = claims[0].payload.request ? 'pane-b' : 'pane-b-two'
      const loser = winner === 'pane-b' ? 'pane-b-two' : 'pane-b'
      const deliveryToken = claims.find((entry) => entry.payload.request).payload.request.deliveryToken
      assert.equal(claims.find((entry) => entry.payload.request).payload.request.text, 'native owner request')
      assert.equal((await action('native-b', loser, '/api/requests/delivered', { id: requestId })).status, 409)
      assert.equal(queue.get(requestId).delivered, false)
      queue.update(requestId, { status: 'running' })
      await action('native-b', winner, '/api/requests/delivered', { id: requestId, deliveryToken })
      assert.equal(queue.get(requestId).delivered, true)
      assert.equal((await action('native-b', winner, '/api/requests/delivered', { id: requestId, deliveryToken })).status, 200, 'ack retry must be idempotent')
      assert.equal((await action('native-b', loser, '/api/requests/claim', { id: requestId })).payload.request, null)
    })
    await t.test('failed or expired delivery leases can be received by another pane', async () => {
      const sent = await action('native-a', 'pane-a', '/api/messages', { text: 'retry', pageId: 'page:second' })
      const id = sent.payload.request.id
      const first = await action('native-b', 'pane-b', '/api/requests/claim', { id })
      await action('native-b', 'pane-b', '/api/requests/release', { id, deliveryToken: first.payload.request.deliveryToken })
      const second = await action('native-b', 'pane-b-two', '/api/requests/claim', { id })
      assert.ok(second.payload.request)
      await delay(150)
      assert.ok((await action('native-b', 'pane-b', '/api/requests/claim', { id })).payload.request)
      assert.equal((await action('native-b', 'pane-b', '/api/requests/delivered', { id, deliveryToken: first.payload.request.deliveryToken })).status, 409, 'an old lease must not acknowledge a newer delivery')
      await action('native-a', 'pane-a', '/api/requests/cancel', { id })
      assert.equal((await action('native-b', 'pane-b', '/api/requests/claim', { id })).payload.request, null)
    })
    await t.test('Claude SSE listeners still receive routed widget requests', async () => {
      await stream('/api/agent-events?session=browser-c')
      await call('browser-c', 'open-canvas', { page: 'First' })
      const sent = await action('native-a', 'pane-a', '/api/messages', { text: 'Claude request', pageId: 'page:first' })
      assert.equal(sent.payload.request.session, 'browser-c')
      assert.equal(sent.payload.request.delivered, true)
      assert.equal((await action('native-a', 'pane-a', '/api/requests/claim', { id: sent.payload.request.id })).status, 409)
      const prior = queue.list().length
      const unsupported = await action('native-a', 'pane-a', '/api/messages', { text: 'native imagegen', requiredHost: 'codex', pageId: 'page:first' })
      assert.equal(unsupported.status, 409)
      assert.match(unsupported.payload.error, /接管/)
      assert.equal(queue.list().length, prior, 'unsupported request must not enter the Claude queue')
      assert.equal(server.presence.holderOf(canvasDir, 'page:first'), 'browser-c')
      const staleRead = await post('/api/bridge/call', { session: 'browser-c', op: 'request-get', args: { id: sent.payload.request.id, requestKey: 'old-service-request' } })
      assert.equal(staleRead.status, 422)
      assert.match(staleRead.body.error, /旧服务/)
    })
    await t.test('deleted-page events reach widgets and reset snapshots recover missed deletions', async () => {
      const before = await poll('native-a', 'pane-a', cursorA)
      pages = pages.filter((page) => page.id !== 'page:first')
      ops.emit('pages-deleted', { canvasDir, pageIds: ['page:first'] })
      const after = await poll('native-a', 'pane-a', before.cursor)
      assert.ok(after.events.some((item) => item.event === 'pages-deleted' && item.data.pageIds.includes('page:first')))
      const reset = await poll('native-a', 'pane-a', 'previous-service/123')
      assert.deepEqual(reset.events.find((item) => item.event === 'page-state').data.allPageIds, ['page:second'])
    })
    await t.test('native pane expiry removes its selection context and reports unavailable receiver', async () => {
      await delay(550)
      assert.equal(server.pageCount, 0)
      assert.equal(server.presence.pane('pane-a'), null)
      const reopened = await call('native-b', 'open-canvas', {})
      assert.equal(reopened.paneOpen, false)
      const recovered = await poll('native-b', 'pane-b', cursorB)
      assert.ok(recovered.events.some((item) => item.event === 'hello'))
    })
  } finally {
    for (const controller of controllers) controller.abort()
    await server.close()
  }
})

test('restarted service rejects old message keys and old native delivery acknowledgements', async () => {
  const servers = []
  const streams = []
  async function start() {
    const queue = new CanvasRequestQueue()
    const ops = new EventEmitter()
    ops.canvasPages = async () => []
    const server = new CanvasServer({ token: 'restart-token', identity: { service: 'cowart-canvas', protocol: 3, build: 'restart-test' }, canvasDir: directory, queue, ops, renderPage: async () => '' })
    servers.push(server)
    await server.start({ port: 0 })
    const controller = new AbortController()
    streams.push(controller)
    const headers = { 'content-type': 'application/json', 'x-cowart-token': 'restart-token' }
    const response = await fetch(server.origin + '/api/bridge/session?session=restart-native&host=codex', { headers, signal: controller.signal })
    const reader = response.body.getReader()
    void (async () => { try { while (!(await reader.read()).done) {} } catch {} })()
    const call = async (op, args) => {
      const result = await fetch(server.origin + '/api/bridge/call', { method: 'POST', headers, body: JSON.stringify({ session: 'restart-native', op, args }) })
      return { status: result.status, body: await result.json() }
    }
    const action = async (path, body) => (await call('widget-call', { pane: 'restart-pane', path, body })).body.result
    const cursor = (await call('widget-poll', { pane: 'restart-pane' })).body.result.cursor
    const request = (await action('/api/messages', { text: 'request from this service' })).payload.request
    const claimed = (await action('/api/requests/claim', { id: request.id, requestKey: request.requestKey })).payload.request
    return { server, call, action, cursor, request, claimed }
  }
  try {
    const old = await start()
    await old.server.close()
    const fresh = await start()
    assert.equal(old.request.id, fresh.request.id, 'this reproduces reused queue ids')
    assert.notEqual(old.request.requestKey, fresh.request.requestKey)
    const staleClaim = await fresh.action('/api/requests/claim', { id: old.request.id, requestKey: old.request.requestKey })
    assert.equal(staleClaim.status, 409)
    assert.match(staleClaim.payload.error, /旧服务/)
    const validClaim = await fresh.action('/api/requests/claim', { id: fresh.request.id, requestKey: fresh.request.requestKey })
    assert.equal(validClaim.payload.request.deliveryToken, fresh.claimed.deliveryToken, 'rejected old claim must leave the current lease intact')
    const read = await fresh.call('request-get', { id: old.request.id, requestKey: old.request.requestKey })
    assert.equal(read.status, 422)
    const reply = await fresh.call('request-reply', { id: old.request.id, requestKey: old.request.requestKey, status: 'running' })
    assert.equal(reply.status, 422)
    const ack = await fresh.action('/api/requests/delivered', { id: old.request.id, deliveryToken: old.claimed.deliveryToken })
    assert.equal(ack.status, 409)
    const current = await fresh.call('request-get', { id: fresh.request.id, requestKey: fresh.request.requestKey })
    assert.equal(current.body.result.request.delivered, false)
    const recovered = await fresh.call('widget-poll', { pane: 'restart-pane', cursor: old.cursor })
    assert.ok(recovered.body.result.events.some((item) => item.event === 'hello'))
    assert.notEqual(recovered.body.result.cursor, old.cursor)
  } finally {
    for (const controller of streams) controller.abort()
    for (const server of servers) await server.close()
  }
})

test('client start waits for session hello while leaving the established stream in the background', async () => {
  let registered = false
  let reachedSession
  const sessionReached = new Promise((resolve) => { reachedSession = resolve })
  const timers = []
  const server = http.createServer((req, res) => {
    if (req.url === '/api/service') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(localIdentity()))
    } else if (req.url.startsWith('/api/bridge/session?')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      reachedSession()
      timers.push(setTimeout(() => { registered = true; res.write('event: hello\ndata: {}\n\n') }, 70))
    } else if (req.url === '/api/bridge/call') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { registered } }))
    } else res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = new CanvasServiceClient({ host: 'codex', session: 'registration-test', cwd: directory, port: server.address().port })
  try {
    let settled = false
    const ready = client.start().then(() => { settled = true })
    await sessionReached
    await delay(20)
    assert.equal(settled, false, 'response headers alone must not signal registration')
    await ready
    assert.equal((await client.call('widget-poll', { pane: 'registered-pane' })).registered, true)
  } finally {
    client.close()
    for (const timer of timers) clearTimeout(timer)
    const closed = new Promise((resolve) => server.close(resolve))
    server.closeAllConnections()
    await closed
  }
})

test.after(async () => { await rm(directory, { recursive: true, force: true }) })
