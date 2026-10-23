#!/usr/bin/env node
// UpstreamCowart (shared/upstream.mjs), the service's one connection to the upstream Cowart MCP
// server it runs as a child process. Pins what the service relies on today: a server that died is
// started again by the next call, calls that arrive together start one server, and close() leaves
// no server behind; and that a server idle for idleMs is stopped, the next call starting it again
// and listTools() answering from what it listed before. The servers are found as this process's children whose command line runs
// mcp/generated/cowart-mcp.mjs (Win32_Process on Windows, ps elsewhere); they keep a canvas of the
// check's own.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { delay, finish, step, text, waitFor } from '../../claude/scripts/test-kit.mjs'
import { UpstreamCowart } from '../../shared/upstream.mjs'

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'cowart-upstream-check-'))
const env = { ...process.env, COWART_CANVAS_DIR: join(root, 'canvas') }
delete env.COWART_PROJECT_DIR

// The upstream servers this process runs now, by pid.
async function upstreamServers() {
  if (process.platform === 'win32') {
    // $PID: this query's own PowerShell is a child too, with the pattern on its command line.
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*cowart-mcp.mjs*' } | ForEach-Object { $_.ProcessId }`
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    return stdout.split(/\s+/).filter(Boolean).map(Number)
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,args='])
  return stdout.split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[2]) === process.pid && match[3].includes('cowart-mcp.mjs'))
    .map((match) => Number(match[1]))
}

const stderr = []
function upstream(options = {}) {
  return new UpstreamCowart({ clientName: 'cowart-upstream-check', clientVersion: '0.0.0', cwd: root, env, onStderr: (chunk) => stderr.push(String(chunk)), ...options })
}

async function canvasState(server) {
  const result = await server.callTool('get_cowart_canvas_state', {})
  assert.ok(!result.isError, `get_cowart_canvas_state failed: ${text(result)}`)
  return result
}

await step('(a) after the upstream server dies, the next call starts it again and succeeds', async () => {
  const server = upstream()
  try {
    const tools = await server.listTools()
    assert.ok(tools.some((tool) => tool.name === 'get_cowart_canvas_state'), 'listTools lists get_cowart_canvas_state')
    const running = await upstreamServers()
    assert.equal(running.length, 1, `one upstream server after listTools, found ${running.join(', ') || 'none'}`)
    const [killed] = running
    process.kill(killed)
    await waitFor(async () => !(await upstreamServers()).includes(killed), { timeoutMs: 10_000, intervalMs: 200, what: `upstream server ${killed} to go` })
    await canvasState(server)
    const after = await upstreamServers()
    assert.equal(after.length, 1, `one upstream server after the call, found ${after.join(', ') || 'none'}`)
    assert.notEqual(after[0], killed, 'a new upstream server')
  } finally {
    await server.close()
  }
})

await step('(b) two calls that arrive together start one upstream server', async () => {
  const server = upstream()
  try {
    assert.deepEqual(await upstreamServers(), [], 'no upstream server before the calls')
    await Promise.all([canvasState(server), canvasState(server)])
    const running = await upstreamServers()
    assert.equal(running.length, 1, `one upstream server, found ${running.join(', ') || 'none'}`)
  } finally {
    await server.close()
  }
})

await step('(c) close() leaves no upstream server behind', async () => {
  const server = upstream()
  await canvasState(server)
  const running = await upstreamServers()
  assert.equal(running.length, 1, `one upstream server before close, found ${running.join(', ') || 'none'}`)
  await server.close()
  await waitFor(async () => (await upstreamServers()).length === 0, { timeoutMs: 3000, intervalMs: 200, what: 'the upstream server to go after close()' })
})

await step('(d) an upstream server idle for idleMs is stopped, and the next call starts it again', async () => {
  let idleStops = 0
  const server = upstream({ idleMs: 500, onIdleClose: () => { idleStops += 1 } })
  try {
    await canvasState(server)
    await delay(1500)
    const running = await upstreamServers()
    assert.deepEqual(running, [], `no upstream server 1.5 s after the call, found ${running.join(', ')}`)
    assert.equal(idleStops, 1, 'onIdleClose once')
    await canvasState(server)
    const after = await upstreamServers()
    assert.equal(after.length, 1, `one upstream server after the next call, found ${after.join(', ') || 'none'}`)
  } finally {
    await server.close()
  }
})

await step('(e) after an idle stop, listTools() answers without starting the upstream server', async () => {
  const server = upstream({ idleMs: 500 })
  try {
    const tools = await server.listTools()
    await delay(1500)
    const running = await upstreamServers()
    assert.deepEqual(running, [], `no upstream server 1.5 s after listTools, found ${running.join(', ')}`)
    const again = await server.listTools()
    assert.deepEqual(again.map((tool) => tool.name), tools.map((tool) => tool.name), 'the same tools')
    const after = await upstreamServers()
    assert.deepEqual(after, [], `listTools started no upstream server, found ${after.join(', ')}`)
  } finally {
    await server.close()
  }
})

await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
finish()
