#!/usr/bin/env node
// cowart-service.mjs --status / --stop when the machine runs more than one canvas service: two
// dev hosts, each with a service on a test port and a canvas of its own. A port given by hand is
// the only port --stop looks at (2026-09-15 it went on from an empty port to another session's
// dev host and stopped it); without one, --stop looks from 43240 upward the way bridges do but
// stops only the service on the machine's canvas; --status says where it found the service when
// that is not the port asked for. The check runs with a token of its own, so its command lines
// cannot see or stop the machine's own services on 43240 and on, only the check's.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { DEFAULT_PORT } from '../lib/identity.mjs'

const root = await mkdtemp(join(tmpdir(), 'cowart-stop-check-'))
// Before token.mjs loads: the check's bridges, services and command lines share this token.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
const { PORT_ATTEMPTS, probeService } = await import('../client.mjs')
const { finish, serviceStatus, startBridge, step, stopTestService, waitFor } = await import('../../claude/scripts/test-kit.mjs')
const { loadOrCreateToken } = await import('../lib/token.mjs')

// Within the ports --stop looks through without a port (43240 and the 19 after it), past the
// machine's services: nothing runs on ASKED, the dev hosts' services on the two after it.
const ASKED = Number(process.env.COWART_STOP_TEST_PORT) || DEFAULT_PORT + 10
const PORT_A = ASKED + 1
const PORT_B = ASKED + 2
const CLI = join(ADAPTERS_DIR, 'service', 'bin', 'cowart-service.mjs')
const run = promisify(execFile)
const token = await loadOrCreateToken()

// The command line as a person runs it. The machine's canvas it expects is one no service
// uses, unless a check names another.
async function cli(args, env = {}) {
  const base = { ...process.env, COWART_CANVAS_DIR: join(root, 'machine-canvas') }
  delete base.COWART_CLAUDE_PORT
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...base, ...env } })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const bridges = []
// A session's dev host: its bridge starts a service on the port, with a canvas of its own.
async function devHost(name, port) {
  const cwd = join(root, name)
  await mkdir(cwd)
  bridges.push(await startBridge({ cwd, port, session: `stop-${name}`, env: { COWART_SERVICE_IDLE_MS: '30000' } }))
  return { status: await waitFor(() => serviceStatus(port), { timeoutMs: 20_000, what: `the service on ${port}` }) }
}

// The session of a stopped service starts it again, as bridges do: the new one.
const restarted = (port, pid) =>
  waitFor(async () => {
    const status = await serviceStatus(port)
    return status?.pid !== pid && status
  }, { timeoutMs: 20_000, what: `a new service on ${port}` })

let a
let b
try {
  assert.ok(ASKED > DEFAULT_PORT && PORT_B < DEFAULT_PORT + PORT_ATTEMPTS, `COWART_STOP_TEST_PORT must leave three ports within ${DEFAULT_PORT + 1}–${DEFAULT_PORT + PORT_ATTEMPTS - 1}`)
  for (const port of [ASKED, PORT_A, PORT_B]) {
    assert.equal((await probeService(port, token)).kind, 'free', `port ${port} is taken: set COWART_STOP_TEST_PORT to other ports`)
  }
  a = await devHost('a', PORT_A)
  b = await devHost('b', PORT_B)

  await step('a port given by hand is the only port --stop looks at: nothing runs there, nothing is stopped', async () => {
    for (const [args, env] of [
      [['--stop'], { COWART_CLAUDE_PORT: String(ASKED) }],
      [['--stop', '--port', String(ASKED)], {}]
    ]) {
      const { code, stdout } = await cli(args, env)
      assert.equal(code, 0, stdout)
      assert.ok(stdout.includes(`端口 ${ASKED} 上没有在跑的 Cowart 画布服务，什么也没停`), stdout)
    }
    // A --port without a number does not pass for no port at all.
    const bare = await cli(['--stop', '--port'])
    assert.equal(bare.code, 1)
    assert.match(bare.stderr, /--port 后面要写端口号/)
    assert.equal((await serviceStatus(PORT_A))?.pid, a.status.pid)
    assert.equal((await serviceStatus(PORT_B))?.pid, b.status.pid)
  })

  await step('--status says where it found the service when that is not the port asked for', async () => {
    const [first, ...rest] = (await cli(['--status', '--port', String(ASKED)])).stdout.split('\n')
    assert.equal(first, `端口 ${ASKED} 上没有画布服务，往后找到的是端口 ${PORT_A} 上的画布服务（pid ${a.status.pid}，画布 ${a.status.canvasDir}）：`)
    assert.equal(JSON.parse(rest.join('\n')).port, PORT_A)
    // Without a port it looks from 43240; the machine's services there do not take the check's token.
    const fromDefault = (await cli(['--status'])).stdout
    assert.ok(fromDefault.startsWith(`端口 ${DEFAULT_PORT} 上没有画布服务，往后找到的是端口 ${PORT_A} 上的画布服务`), fromDefault)
    // On the port asked for, the status alone.
    assert.equal(JSON.parse((await cli(['--status', '--port', String(PORT_B)])).stdout).pid, b.status.pid)
  })

  await step('without a port, --stop leaves the service it finds alone when it keeps a canvas of its own', async () => {
    const { code, stdout } = await cli(['--stop'])
    assert.equal(code, 1, stdout)
    assert.ok(stdout.includes(`端口 ${PORT_A} 上的画布服务（pid ${a.status.pid}，画布 ${a.status.canvasDir}）用的不是这台机器的画布`), stdout)
    assert.ok(stdout.includes(`--port ${PORT_A}`), stdout)
    assert.equal((await serviceStatus(PORT_A))?.pid, a.status.pid)
  })

  await step("without a port, --stop goes past the ports before it to the service on the machine's canvas, says which one and stops it", async () => {
    const { code, stdout } = await cli(['--stop'], { COWART_CANVAS_DIR: a.status.canvasDir })
    assert.equal(code, 0, stdout)
    assert.ok(stdout.includes(`停止端口 ${PORT_A} 上的画布服务（pid ${a.status.pid}，画布 ${a.status.canvasDir}）`), stdout)
    assert.match(stdout, /已停止/)
    a.status = await restarted(PORT_A, a.status.pid)
    assert.equal((await serviceStatus(PORT_B))?.pid, b.status.pid)
  })

  await step('a port given by hand stops the service on exactly that port, whatever its canvas', async () => {
    const { code, stdout } = await cli(['--stop', '--port', String(PORT_B)])
    assert.equal(code, 0, stdout)
    assert.ok(stdout.includes(`停止端口 ${PORT_B} 上的画布服务（pid ${b.status.pid}，画布 ${b.status.canvasDir}）`), stdout)
    await restarted(PORT_B, b.status.pid)
    assert.equal((await serviceStatus(PORT_A))?.pid, a.status.pid)
  })
} finally {
  for (const bridge of bridges) await bridge.close()
  // The check's token reaches the check's services and no others.
  for (const port of [PORT_A, PORT_B]) await stopTestService(port)
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

finish()
