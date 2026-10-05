#!/usr/bin/env node
// The canvas pages' address. Browsers send every *.localhost name to this machine by themselves
// and look on port 80 when the address names no port; the machine's front door there (Caddy)
// forwards cowart.localhost to the canvas service, Host header and all. So the canvas opens at
// http://cowart.localhost when the front door reaches this service, and at cowart.localhost
// with the service's port when it does not (nothing there, another program). Port 80 is the
// machine's, so the check names another front door port through COWART_DOMAIN_PORT and plays
// the front door with a small proxy. Node does not resolve *.localhost, so requests go to
// 127.0.0.1 with the Host header set. Only loopback names on these ports are let in.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CANVAS_DIR } from '../../shared/paths.mjs'
import { domainPort } from '../lib/identity.mjs'
import { loadOrCreateToken } from '../lib/token.mjs'
import { finish, rawGet, serviceStatus, startBridge, step, stopTestService, text } from '../../claude/scripts/test-kit.mjs'

const PORT = Number(process.env.COWART_ADDRESS_TEST_PORT) || 43387
const FRONT_PORT = PORT + 1
const OTHER_PORT = PORT + 3

const token = await loadOrCreateToken()
const root = await mkdtemp(join(tmpdir(), 'cowart-address-'))
await stopTestService(PORT)

function ok(result) {
  assert.ok(!result.isError, text(result))
  return result
}
const get = (port, path, host, headers = {}) => rawGet(port, path, { host, ...headers })

// What Caddy's reverse_proxy does here: everything, the Host header included, to the target.
function frontDoor(target) {
  return http.createServer((req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
  })
}
async function listen(server, port) {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}
function closeServer(server) {
  if (!server) return
  const closed = new Promise((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  return closed
}

const claude = await startBridge({ cwd: root, port: PORT, session: 'address-claude', env: { COWART_DOMAIN_PORT: String(FRONT_PORT) } })
const render = async () => new URL(ok(await claude.call('render_cowart_canvas_widget', { sessionName: '小址' })).structuredContent.url)
let door = null
try {
  await step('only the machine canvas service is reached through port 80; COWART_DOMAIN_PORT names another or turns it off', async () => {
    assert.equal(domainPort({}, DEFAULT_CANVAS_DIR), 80)
    assert.equal(domainPort({}, join(root, 'canvas')), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: '0' }, DEFAULT_CANVAS_DIR), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: 'off' }, DEFAULT_CANVAS_DIR), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: String(FRONT_PORT) }, join(root, 'canvas')), FRONT_PORT)
  })

  await step('no front door: the canvas opens at cowart.localhost on the service port, with a short address', async () => {
    const opened = ok(await claude.call('render_cowart_canvas_widget', { sessionName: '小址' })).structuredContent
    const url = new URL(opened.url)
    assert.equal(url.origin, `http://cowart.localhost:${PORT}`)
    assert.equal(url.searchParams.get('session'), 'address-claude')
    assert.ok(!url.searchParams.has('canvasDir') && !url.searchParams.has('title'), opened.url)
    assert.equal(opened.localUrl, `http://127.0.0.1:${PORT}${url.pathname}${url.search}`)
    assert.equal((await serviceStatus(PORT)).address, `http://cowart.localhost:${PORT}`)
    assert.equal((await get(PORT, url.pathname + url.search, `cowart.localhost:${PORT}`)).statusCode, 200)
    // The service leaves the front door's port alone.
    await assert.rejects(fetch(`http://127.0.0.1:${FRONT_PORT}/`))
    // An older address (with the canvas in it) still opens.
    assert.equal((await get(PORT, `${url.pathname}${url.search}&canvasDir=${encodeURIComponent(join(root, 'canvas'))}`, `127.0.0.1:${PORT}`)).statusCode, 200)
  })

  await step('another program on the front door port: the address keeps the service port', async () => {
    const other = await listen(http.createServer((_req, res) => res.end('someone else')), FRONT_PORT)
    try {
      assert.equal((await render()).origin, `http://cowart.localhost:${PORT}`)
    } finally {
      await closeServer(other)
    }
  })

  let url
  await step('a front door forwarding cowart.localhost here: the address names its port only', async () => {
    door = await listen(frontDoor(PORT), FRONT_PORT)
    url = await render()
    assert.equal(url.origin, `http://cowart.localhost:${FRONT_PORT}`)
    assert.equal((await serviceStatus(PORT)).address, `http://cowart.localhost:${FRONT_PORT}`)
  })

  await step('through the front door: page, bare address and API answer cowart.localhost', async () => {
    const host = `cowart.localhost:${FRONT_PORT}`
    assert.equal((await get(FRONT_PORT, url.pathname + url.search, host)).statusCode, 200)
    const bare = await get(FRONT_PORT, '/', host)
    assert.equal(bare.statusCode, 302)
    assert.equal(bare.headers.location, url.pathname + url.search)
    assert.equal((await get(FRONT_PORT, '/api/service', host, { 'x-cowart-token': token })).statusCode, 200)
    assert.equal((await get(FRONT_PORT, '/api/service', host)).statusCode, 403, 'the front door skips the token')
  })

  await step('other names and ports are turned away', async () => {
    for (const host of [`evil.example:${FRONT_PORT}`, `evil.localhost:${FRONT_PORT}`, `x.cowart.localhost:${FRONT_PORT}`, 'cowart.localhost', `cowart.localhost:${OTHER_PORT}`, `cowart.localhost.evil.example:${FRONT_PORT}`]) {
      assert.equal((await get(FRONT_PORT, '/', host)).statusCode, 403, host)
    }
  })

  await step('the front door gone: the next address names the service port again', async () => {
    await closeServer(door)
    door = null
    assert.equal((await render()).origin, `http://cowart.localhost:${PORT}`)
  })
} finally {
  await claude.close()
  await stopTestService(PORT)
  await closeServer(door)
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
finish()
