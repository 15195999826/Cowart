#!/usr/bin/env node
// Memory of the canvas service and the upstream Cowart server it runs as a child: a probe to
// compare before and after a change, not a check (nothing fails on a number). Two rounds, each
// with a service of its own on a test port and a token of its own: an empty canvas, then a copy
// of the machine canvas's page files (pages/**/*.json, no assets; skipped without a machine
// canvas). Each round prints both processes' working set and commit (private bytes) just after
// the service started, after 5 get_cowart_canvas_state and 20 `pages`, and 15 s after the
// upstream server was killed. Windows only.
//   npm --prefix adapters run probe:memory
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { DEFAULT_CANVAS_DIR } from '../../shared/paths.mjs'

if (process.platform !== 'win32') {
  console.log('probe:memory only measures on Windows; skipped.')
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'cowart-memory-probe-'))
// Before token.mjs loads: the probe's services and commands share this token and log, never the
// machine's.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
const { cliSession, delay, serviceStatus, stopTestService, waitFor } = await import('../../claude/scripts/test-kit.mjs')

const EMPTY_PORT = 43397
const MACHINE_PORT = 43398
const run = promisify(execFile)

async function powershell(script) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  return stdout
}

// The upstream servers a service runs ($PID: the query's own PowerShell is not one of them).
async function upstreamOf(servicePid) {
  const out = await powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid}" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*cowart-mcp.mjs*' } | ForEach-Object { $_.ProcessId }`)
  return out.split(/\s+/).filter(Boolean).map(Number)
}

// pid -> { ws, commit } in bytes, for the pids still running.
async function memory(pids) {
  const out = await powershell(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1} {2}' -f $_.Id, $_.WorkingSet64, $_.PrivateMemorySize64 }`).catch((error) => error.stdout ?? '')
  const result = new Map()
  for (const line of out.split('\n')) {
    const [pid, ws, commit] = line.trim().split(/\s+/).map(Number)
    if (pid) result.set(pid, { ws, commit })
  }
  return result
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function report(label, servicePid, upstreamPid) {
  const sizes = await memory([servicePid, upstreamPid].filter(Boolean))
  const part = (name, pid) => {
    const size = pid && sizes.get(pid)
    return size ? `${name} ${pid}: WS ${mb(size.ws)}, commit ${mb(size.commit)}` : `${name}: not running`
  }
  const total = [...sizes.values()].reduce((sum, size) => ({ ws: sum.ws + size.ws, commit: sum.commit + size.commit }), { ws: 0, commit: 0 })
  console.log(`  ${label.padEnd(30)} ${part('service', servicePid)} | ${part('upstream', upstreamPid)} | total WS ${mb(total.ws)}, commit ${mb(total.commit)}`)
}

// The machine canvas's page files, copied to the round's canvas: { pages, bytes }.
async function copyPages(from, to) {
  let pages = 0
  let bytes = 0
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'assets') await walk(path)
      } else if (entry.name.endsWith('.json')) {
        const target = join(to, relative(from, path))
        await mkdir(dirname(target), { recursive: true })
        await copyFile(path, target)
        bytes += (await stat(target)).size
        if (entry.name === 'cowart-canvas.json') pages += 1
      }
    }
  }
  await walk(join(from, 'pages'))
  return { pages, bytes }
}

async function round(name, port, prepare) {
  const cwd = join(root, name)
  const canvas = join(cwd, 'canvas')
  await mkdir(canvas, { recursive: true })
  const about = await prepare(canvas)
  console.log(`\n${name}${about ? ` (${about})` : ''}, port ${port}`)
  const session = cliSession({ cwd, port, session: `memory-probe-${name}`, env: { COWART_SESSION_NAMES_FILE: join(root, 'session-names.json') } })
  try {
    await session.listTools()
    const status = await waitFor(() => serviceStatus(port), { timeoutMs: 20_000, what: `the service on ${port}` })
    const servicePid = status.pid
    const [upstreamPid] = await waitFor(async () => {
      const found = await upstreamOf(servicePid)
      return found.length ? found : null
    }, { timeoutMs: 20_000, intervalMs: 300, what: 'the upstream server' })
    await report('just started', servicePid, upstreamPid)

    for (let i = 0; i < 5; i += 1) {
      const result = await session.call('get_cowart_canvas_state', {})
      if (result.isError) throw new Error(`get_cowart_canvas_state failed: ${JSON.stringify(result.content)}`)
    }
    for (let i = 0; i < 20; i += 1) {
      const { code, stderr, stdout } = await session.run(['pages'])
      if (code !== 0) throw new Error(`cowart pages exited ${code}: ${stderr || stdout}`)
    }
    await report('after 5 state + 20 pages', servicePid, upstreamPid)

    process.kill(upstreamPid)
    await delay(15_000)
    await report('15 s after killing upstream', servicePid, (await upstreamOf(servicePid))[0] ?? upstreamPid)
  } finally {
    await session.close()
    await stopTestService(port).catch(() => {})
  }
}

try {
  await round('empty', EMPTY_PORT, async () => 'empty canvas')
  if (existsSync(join(DEFAULT_CANVAS_DIR, 'pages'))) {
    await round('machine-copy', MACHINE_PORT, async (canvas) => {
      const { pages, bytes } = await copyPages(DEFAULT_CANVAS_DIR, canvas)
      return `copy of ${DEFAULT_CANVAS_DIR}: ${pages} pages, ${mb(bytes)} of JSON`
    })
  } else {
    console.log(`\nmachine-copy skipped: no canvas at ${DEFAULT_CANVAS_DIR}`)
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}
process.exit(0)
