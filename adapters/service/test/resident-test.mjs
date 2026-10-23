#!/usr/bin/env node
// The canvas service as a resident process (FORK.md 画布服务): the service of the machine's canvas
// does not exit for being idle, a service of another canvas (a check's, a dev host's) still does
// after 10 minutes, and COWART_SERVICE_IDLE_MS sets the time for either. On Windows a session's
// command starts the service through WMI, out of the job its host runs it in (a host that closes
// its job ends everything in it), with no parent the host knows of; the service then keeps its
// own log (--log) and leaves its exit code in a file for the command that started it. A bridge
// (ZCode's) counts as connected once the service said hello on its session stream. The check
// runs with a token, a runtime directory and canvases of its own on ports of its own.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const root = await mkdtemp(join(tmpdir(), 'cowart-resident-check-'))
// Before token.mjs and paths.mjs load: the check's commands and the services they start share
// these, never the machine's.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
process.env.COWART_CANVAS_DIR = join(root, 'canvas')
process.env.COWART_SESSION_NAMES_FILE = join(root, 'names.json')
process.env.COWART_SERVICE_IDLE_MS = '60000'
// Where install puts the service's entry, its launcher and the shortcut at logon: never the user's.
process.env.COWART_SERVICE_LINK = join(root, 'bin', 'cowart-service.mjs')
process.env.COWART_STARTUP_DIR = join(root, 'Startup')
delete process.env.COWART_CLAUDE_PORT
const { CanvasServiceClient, SERVICE_ENTRY, spawnService } = await import('../client.mjs')
const { finish, serviceStatus, step, stopTestService, waitFor } = await import('../../claude/scripts/test-kit.mjs')
const { EXIT_PORT_TAKEN, localIdentity } = await import('../lib/identity.mjs')
const { serviceIdleMs } = await import('../lib/service.mjs')
const { RUNTIME_DIR, SERVICE_LOG } = await import('../lib/token.mjs')

const PORT = Number(process.env.COWART_RESIDENT_TEST_PORT) || 43392
// Held by a plain server for the service that finds its port taken.
const TAKEN_PORT = PORT + 1
const run = promisify(execFile)
const WINDOWS = process.platform === 'win32'

const powershell = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

// The processes in the job this check runs in (its host's), or null when it runs in none
// (Windows). Not IsProcessInJob of the service: every Node process that has started a child is in a
// job of its own (libuv puts itself in the job it keeps its children in), the service too. The
// list is of the job the asking process is in: it is started through cmd, whose children leave the
// job libuv keeps this check's children in (that job lets them), so it asks for the host's.
async function hostJobPids() {
  const script = [
    "Add-Type -Namespace CowartCheck -Name JobList -MemberDefinition '",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);',
    "'",
    '$size = 8 + 8 * 16384; $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)',
    'if ([CowartCheck.JobList]::QueryInformationJobObject([IntPtr]::Zero, 3, $buffer, $size, [IntPtr]::Zero)) {',
    '  $count = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 4)',
    '  $ids = for ($i = 0; $i -lt $count; $i++) { [Runtime.InteropServices.Marshal]::ReadInt64($buffer, 8 + 8 * $i) }',
    "  [Console]::Out.WriteLine('job ' + ($ids -join ','))",
    "} else { [Console]::Out.WriteLine('none') }"
  ].join('\n')
  const { stdout } = await run('cmd.exe', ['/d', '/c', 'powershell.exe', ...powershell(script)], { windowsHide: true })
  const line = stdout.split(/\r?\n/).find((text) => text.startsWith('job ') || text === 'none')
  return line?.startsWith('job ') ? line.slice(4).split(',').map(Number) : null
}

async function parentOf(pid) {
  const { stdout } = await run('powershell.exe', powershell(`[Console]::Out.WriteLine((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId)`), { windowsHide: true })
  return Number(stdout.trim()) || null
}

await step('(f) serviceIdleMs: never for the machine canvas, 10 minutes for another, COWART_SERVICE_IDLE_MS first', async () => {
  assert.equal(serviceIdleMs({}), Infinity, 'no COWART_CANVAS_DIR: the machine canvas, never idle')
  assert.equal(serviceIdleMs({ COWART_CANVAS_DIR: '' }), Infinity, 'an empty COWART_CANVAS_DIR is the machine canvas too')
  assert.equal(serviceIdleMs({ COWART_CANVAS_DIR: 'x' }), 600_000, 'another canvas: 10 minutes')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '5000' }), 5000, 'COWART_SERVICE_IDLE_MS for the machine canvas')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '5000', COWART_CANVAS_DIR: 'x' }), 5000, 'COWART_SERVICE_IDLE_MS for another canvas')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '0', COWART_CANVAS_DIR: 'x' }), 600_000, 'a COWART_SERVICE_IDLE_MS that is not above 0 is not used')
})

let started = null
try {
  await stopTestService(PORT)
  if (WINDOWS) {
    // A command starting the service, the way the cowart command does.
    const client = new CanvasServiceClient({ host: 'claude', session: 'resident-check', cwd: root, port: PORT, command: true })
    await client.start()
    started = await serviceStatus(PORT)
  }

  await step('(g) a service a command starts runs outside the job the command runs in', async () => {
    if (!WINDOWS) return console.log('      (skipped: jobs are a Windows thing)')
    assert.ok(started, `no service on ${PORT}`)
    const job = await hostJobPids()
    if (!job?.includes(process.pid)) return console.log(`      (skipped: this check runs in no job, so the service cannot leave one: ${job ? `pid ${process.pid} not among ${job.length}` : 'no job'})`)
    assert.ok(!job.includes(started.pid), `the service (pid ${started.pid}) runs in the job of the check (${job.length} processes)`)
  })

  await step('(h) the service is no child of the process that started it', async () => {
    if (!WINDOWS) return console.log('      (skipped: started through WMI on Windows only)')
    assert.ok(started, `no service on ${PORT}`)
    const parent = await parentOf(started.pid)
    assert.ok(parent, `no parent found for pid ${started.pid}`)
    assert.notEqual(parent, process.pid, 'the service is a child of the check')
  })
} finally {
  await stopTestService(PORT)
}

await step('(i) --log: the service writes its log there and leaves its exit code for the command that started it (3: port taken)', async () => {
  const holder = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => holder.once('error', reject).listen(TAKEN_PORT, '127.0.0.1', resolve))
  // A canvas no service has, so the port is what stops it.
  const canvas = process.env.COWART_CANVAS_DIR
  process.env.COWART_CANVAS_DIR = join(root, 'canvas-taken')
  try {
    // By hand, with --log.
    const log = join(root, 'by-hand.log')
    const child = spawn(process.execPath, [SERVICE_ENTRY, '--port', String(TAKEN_PORT), '--log', log], { stdio: 'ignore', windowsHide: true })
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(code, EXIT_PORT_TAKEN)
    assert.match(await readFile(log, 'utf8'), new RegExp(`port ${TAKEN_PORT} is taken`))
    const exitFile = join(RUNTIME_DIR, 'service-exit', String(child.pid))
    assert.equal((await readFile(exitFile, 'utf8')).trim(), String(EXIT_PORT_TAKEN))
    await rm(exitFile, { force: true })

    // The way a command starts it: the exit code comes back through that file, which is then gone.
    if (WINDOWS) {
      const launched = spawnService(TAKEN_PORT)
      assert.ok(launched.pid > 0)
      const exitCode = await waitFor(() => launched.exitCode !== null && launched.exitCode, { timeoutMs: 20_000, what: 'the launched service to exit' })
      assert.equal(exitCode, EXIT_PORT_TAKEN)
      assert.equal(existsSync(join(RUNTIME_DIR, 'service-exit', String(launched.pid))), false, 'the exit code file was not removed once read')
      assert.equal(launched.exitCode, EXIT_PORT_TAKEN, 'the exit code is kept once read')
      assert.match(await readFile(SERVICE_LOG, 'utf8'), new RegExp(`port ${TAKEN_PORT} is taken`))
    }
  } finally {
    process.env.COWART_CANVAS_DIR = canvas
    await new Promise((resolve) => holder.close(resolve))
  }
})

await step('(j) installServiceAutostart writes the service entry, its launcher and the shortcut at logon; removeServiceAutostart takes them away', async () => {
  const { installServiceAutostart, removeServiceAutostart } = await import('../../claude/lib/install.mjs')
  const entry = process.env.COWART_SERVICE_LINK
  const launcher = join(root, 'bin', 'start-service.vbs')
  const shortcut = join(process.env.COWART_STARTUP_DIR, 'CowartCanvas.lnk')
  const installed = await installServiceAutostart()
  if (!WINDOWS) {
    assert.ok(installed.skipped, JSON.stringify(installed))
    return
  }
  assert.equal(installed.shortcut, shortcut)
  for (const file of [entry, launcher, shortcut]) assert.ok(existsSync(file), `${file} was not written`)
  // The entry leads to this checkout's service: run it the way the launcher does, on a port with
  // nothing on it.
  assert.ok((await readFile(entry, 'utf8')).includes(`const target = ${JSON.stringify(SERVICE_ENTRY.replaceAll('\\', '/'))}`))
  const { stdout } = await run(process.execPath, [entry, '--stop', '--port', String(TAKEN_PORT)], { windowsHide: true })
  assert.match(stdout, new RegExp(`端口 ${TAKEN_PORT} 上没有在跑的 Cowart 画布服务`))
  // The launcher runs this node with the entry on the machine's port, logging (UTF-16: any path).
  const bytes = await readFile(launcher)
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'the launcher is not UTF-16 with a byte order mark')
  const source = bytes.subarray(2).toString('utf16le')
  for (const part of [`""${process.execPath}""`, `""${entry}""`, '--port 43240', `--log ""${SERVICE_LOG}""`]) assert.ok(source.includes(part), `the launcher lacks ${part}:\n${source}`)
  // The shortcut runs the launcher with wscript.
  const { stdout: link } = await run('powershell.exe', powershell(`$link = (New-Object -ComObject WScript.Shell).CreateShortcut('${shortcut}'); [Console]::Out.WriteLine($link.TargetPath + '|' + $link.Arguments)`), { windowsHide: true })
  const [target, args] = link.trim().split('|')
  assert.match(target, /\\wscript\.exe$/i)
  assert.equal(args, `"${launcher}"`)
  // Installing again rewrites them in place.
  assert.equal((await installServiceAutostart()).shortcut, shortcut)

  const removed = await removeServiceAutostart()
  assert.equal(removed.removed, true, JSON.stringify(removed))
  for (const file of [entry, launcher, shortcut]) assert.equal(existsSync(file), false, `${file} was left behind`)
  assert.equal((await removeServiceAutostart()).removed, false, 'nothing left to remove')
})

await step('a bridge (ZCode) is started once the service says hello on its session stream, which stays open in the background', async () => {
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
  const client = new CanvasServiceClient({ host: 'zcode', session: 'registration-test', cwd: root, port: server.address().port })
  try {
    let settled = false
    const ready = client.start().then(() => { settled = true })
    await sessionReached
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'response headers alone must not signal registration')
    await ready
    assert.equal((await client.call('pages')).registered, true)
  } finally {
    client.close()
    for (const timer of timers) clearTimeout(timer)
    const closed = new Promise((resolve) => server.close(resolve))
    server.closeAllConnections()
    await closed
  }
})

await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
finish()
