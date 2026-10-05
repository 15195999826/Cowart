#!/usr/bin/env node
// The canvas pages' address. The service on the machine's canvas also listens on port 80, so
// the canvas opens at http://cowart.localhost: browsers send *.localhost to this machine by
// themselves (Node does not, so the check sends the Host header to 127.0.0.1 itself). Port 80
// is the machine's, so the check gives its services other ports through COWART_DOMAIN_PORT:
// the address names the page port; a page port another program has leaves the pages on the
// service's own port; only loopback names on the service's ports are let in.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CANVAS_DIR } from '../../shared/paths.mjs'
import { domainPort } from '../lib/identity.mjs'
import { loadOrCreateToken } from '../lib/token.mjs'
import { finish, rawGet, serviceStatus, startBridge, step, stopTestService, text } from '../../claude/scripts/test-kit.mjs'

const PORT = Number(process.env.COWART_ADDRESS_TEST_PORT) || 43387
const PAGE_PORT = PORT + 1
const OTHER_PORT = PORT + 2
const TAKEN_PORT = PORT + 3

const token = await loadOrCreateToken()
const root = await mkdtemp(join(tmpdir(), 'cowart-address-'))
await stopTestService(PORT)
await stopTestService(OTHER_PORT)

function ok(result) {
  assert.ok(!result.isError, text(result))
  return result
}
const get = (port, path, host, headers = {}) => rawGet(port, path, { host, ...headers })

const bridges = []
let other = null
try {
  await step('only the machine canvas service takes port 80; COWART_DOMAIN_PORT names another or turns it off', async () => {
    assert.equal(domainPort({}, DEFAULT_CANVAS_DIR), 80)
    assert.equal(domainPort({}, join(root, 'canvas')), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: '0' }, DEFAULT_CANVAS_DIR), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: 'off' }, DEFAULT_CANVAS_DIR), 0)
    assert.equal(domainPort({ COWART_DOMAIN_PORT: String(PAGE_PORT) }, join(root, 'canvas')), PAGE_PORT)
  })

  const claude = await startBridge({ cwd: root, port: PORT, session: 'address-claude', env: { COWART_DOMAIN_PORT: String(PAGE_PORT) } })
  bridges.push(claude)
  let opened

  await step('the canvas opens at cowart.localhost on the page port, with a short address', async () => {
    opened = ok(await claude.call('render_cowart_canvas_widget', { sessionName: '小址' })).structuredContent
    const url = new URL(opened.url)
    assert.equal(url.origin, `http://cowart.localhost:${PAGE_PORT}`)
    assert.equal(url.searchParams.get('session'), 'address-claude')
    assert.ok(!url.searchParams.has('canvasDir') && !url.searchParams.has('title'), opened.url)
    assert.equal(opened.localUrl, `http://127.0.0.1:${PORT}${url.pathname}${url.search}`)
    assert.equal((await serviceStatus(PORT)).address, `http://cowart.localhost:${PAGE_PORT}`)
  })

  await step('page, assets and API answer cowart.localhost on both ports', async () => {
    const path = new URL(opened.url).pathname + new URL(opened.url).search
    assert.equal((await get(PAGE_PORT, path, `cowart.localhost:${PAGE_PORT}`)).statusCode, 200)
    assert.equal((await get(PORT, path, `cowart.localhost:${PORT}`)).statusCode, 200)
    assert.equal((await get(PAGE_PORT, path, `127.0.0.1:${PAGE_PORT}`)).statusCode, 200)
    assert.equal((await get(PAGE_PORT, '/api/service', `cowart.localhost:${PAGE_PORT}`, { 'x-cowart-token': token })).statusCode, 200)
    assert.equal((await get(PAGE_PORT, '/api/service', `cowart.localhost:${PAGE_PORT}`)).statusCode, 403, 'the page port skips the token')
    // An older address (with the canvas in it) still opens.
    assert.equal((await get(PORT, `${path}&canvasDir=${encodeURIComponent(join(root, 'canvas'))}`, `127.0.0.1:${PORT}`)).statusCode, 200)
  })

  await step('a bare cowart.localhost goes to the canvas opened last', async () => {
    const bare = await get(PAGE_PORT, '/', `cowart.localhost:${PAGE_PORT}`)
    assert.equal(bare.statusCode, 302)
    assert.equal(bare.headers.location, new URL(opened.url).pathname + new URL(opened.url).search)
  })

  await step('other names and ports are turned away', async () => {
    for (const host of [`evil.example:${PAGE_PORT}`, `evil.localhost:${PAGE_PORT}`, `x.cowart.localhost:${PAGE_PORT}`, 'cowart.localhost', `cowart.localhost:${TAKEN_PORT}`, `cowart.localhost.evil.example:${PAGE_PORT}`]) {
      assert.equal((await get(PAGE_PORT, '/', host)).statusCode, 403, host)
    }
  })

  await step('a page port another program has leaves the pages on the service port', async () => {
    other = http.createServer((_req, res) => res.end('someone else'))
    await new Promise((resolve) => other.listen(TAKEN_PORT, '127.0.0.1', resolve))
    const cwd = join(root, 'other')
    await mkdir(cwd)
    const second = await startBridge({ cwd, port: OTHER_PORT, session: 'address-other', env: { COWART_DOMAIN_PORT: String(TAKEN_PORT) } })
    bridges.push(second)
    const reopened = ok(await second.call('render_cowart_canvas_widget', { sessionName: '小占' })).structuredContent
    const url = new URL(reopened.url)
    assert.equal(url.origin, `http://cowart.localhost:${OTHER_PORT}`)
    assert.equal((await get(OTHER_PORT, url.pathname + url.search, `cowart.localhost:${OTHER_PORT}`)).statusCode, 200)
    assert.equal((await get(OTHER_PORT, '/', `cowart.localhost:${TAKEN_PORT}`)).statusCode, 403)
    const answer = await fetch(`http://127.0.0.1:${TAKEN_PORT}/`).then((response) => response.text())
    assert.equal(answer, 'someone else')
  })
} finally {
  for (const bridge of bridges) await bridge.close()
  await stopTestService(PORT)
  await stopTestService(OTHER_PORT)
  other?.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
finish()
