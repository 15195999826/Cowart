#!/usr/bin/env node
// A Codex session runs the cowart command the way a Claude Code session does (FORK.md, D7 / D8 /
// D11 / D12 of docs/plan/codex-cli-resident.md): Codex gives the commands it runs CODEX_THREAD_ID
// and nothing of Claude's, and that is the session (codex-<thread>) and its host. Its texts send
// the user a link for Codex's built-in browser and never a listener (Codex has none); its canvas
// page keeps it online while open; that page names Codex and offers Codex imagegen. Its prompt hook
// (`cowart hook prompt`, D9 / D10) reminds the session of the requests waiting for it and says
// nothing otherwise: it finds the service through the canvas lock (whatever its port), and still
// knows the requests queued for a session after the service restarted. `cowart install` sets
// Codex up (D13: the skill, the hook, no cowart_mcp server). Without COWART_COMMAND_LINK, Codex is
// told to run "$HOME/.cowart/bin/cowart.mjs" (Windows PowerShell 5.1 leaves ~ as it is).
// The check runs with a runtime directory, a canvas, a Codex home and a port of its own.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const root = await mkdtemp(join(tmpdir(), 'cowart-codex-cli-check-'))
// Before token.mjs loads: the check's commands and the services they start use this token and
// runtime directory, never the machine's.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
const { loadOrCreateToken } = await import('../../service/lib/token.mjs')
const { ADAPTERS_DIR } = await import('../../shared/paths.mjs')
const { canvasLockFile } = await import('../../service/lib/canvas-lock.mjs')
const { REQUESTS_FILE_NAME } = await import('../../service/lib/requests.mjs')
const { COMMAND_LINK, EMPTY_CANVAS, cliSession, delay, finish, openEvents, serviceStatus, step, stopTestService, waitFor } = await import('./test-kit.mjs')

const PORT = Number(process.env.COWART_CODEX_CLI_TEST_PORT) || 43391
// Past the ports a command looks through from PORT (20): only the canvas lock says it is there.
const FAR_PORT = PORT + 30
const run = promisify(execFile)

const projectDir = join(root, 'project')
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))
const token = await loadOrCreateToken()

// What Codex gives a command: its thread, nothing of Claude Code's, no COWART_SESSION_ID.
function codexEnv(thread, more = {}) {
  const env = { COWART_SESSION_ID: undefined, CODEX_THREAD_ID: thread, ...more }
  for (const key of Object.keys(process.env)) if (/^CLAUDE_/i.test(key)) env[key] = undefined
  return env
}
const codexSession = (thread, more) => cliSession({ cwd: projectDir, port: PORT, session: `codex-${thread}`, env: codexEnv(thread, more) })

// What Codex gives its prompt hook (S3 ⓪): the thread in stdin's session_id, none in the environment.
async function promptHook(thread) {
  const env = { COWART_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }
  for (const key of Object.keys(process.env)) if (/^CLAUDE_/i.test(key)) env[key] = undefined
  const hook = cliSession({ cwd: projectDir, port: PORT, session: `codex-${thread}`, env })
  const input = { session_id: thread, turn_id: 'turn-1', cwd: projectDir, hook_event_name: 'UserPromptSubmit', model: 'gpt-5', prompt: '帮我看看这个函数' }
  const started = Date.now()
  const result = await hook.run(['hook', 'prompt'], { input: JSON.stringify(input) })
  return { ...result, ms: Date.now() - started }
}

// The lock a service writes on the canvas as it starts (canvas-lock.mjs), here for a stand-in on
// `port` that is no canvas service, run by this check's process: the hook goes where it says.
async function standInLock(port) {
  const file = canvasLockFile(canvasDir)
  await writeFile(file, `${JSON.stringify({ pid: process.pid, port, canvasDir, startedAt: new Date().toISOString(), id: randomUUID() })}\n`)
  return () => rm(file, { force: true })
}

const BANNED = [/Browser 面板/, /run_in_background/, /AskUserQuestion/, /mcp__Claude_Browser__/]
function noClaudeWords(text, what) {
  for (const word of BANNED) assert.doesNotMatch(text, word, `${what} says ${word}:\n${text}`)
}

const sessionOf = async (id) => (await serviceStatus(PORT))?.sessions.find((entry) => entry.id === id) ?? null
const api = (origin, path, body) =>
  fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cowart-token': token }, body: JSON.stringify(body) }).then((response) => response.json())

const thread = randomUUID()
const codex = codexSession(thread)
const SESSION = `codex-${thread}`
let opened = null
const origin = `http://127.0.0.1:${PORT}`

await step('(k) D7: the session and host from what the host gives a command', async () => {
  const { hostFromEnv, sessionIdFromEnv } = await import('../lib/cli.mjs')
  assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: 'a1b2-c3' }), 'codex-a1b2-c3')
  assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: 'a/b c' }), 'codex-abc', 'cleaned as the Codex bridge cleans it')
  assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: 'x'.repeat(200) }).length, 96)
  assert.equal(sessionIdFromEnv({ CLAUDE_CODE_HOST_SESSION_ID: 'local_1', CODEX_THREAD_ID: 't' }), 'local_1', "Claude Code's id first")
  assert.equal(sessionIdFromEnv({ COWART_SESSION_ID: 'mine', CODEX_THREAD_ID: 't' }), 'mine', 'COWART_SESSION_ID first of all')
  assert.equal(sessionIdFromEnv({}), null)
  assert.equal(hostFromEnv({ CODEX_THREAD_ID: 't' }), 'codex')
  assert.equal(hostFromEnv({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CODEX_THREAD_ID: 't' }), 'claude', 'CLAUDE_CODE_* before CODEX_THREAD_ID')
  assert.equal(hostFromEnv({ COWART_HOST: 'codex', CLAUDE_CODE_HOST_SESSION_ID: 'x' }), 'codex', 'COWART_HOST first of all')
  assert.equal(hostFromEnv({}), 'claude')
})

await step('(k) a CLAUDE_CODE_* set for the whole machine is no Claude Code session: only what Claude Code gives its commands is', async () => {
  const { hostFromEnv } = await import('../lib/cli.mjs')
  // Set by users on Windows for Claude Code to find Git Bash: Codex's commands inherit it.
  assert.equal(hostFromEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CODEX_THREAD_ID: 't' }), 'codex')
  assert.equal(hostFromEnv({ CLAUDE_CODE_USE_BEDROCK: '1', CODEX_THREAD_ID: 't' }), 'codex')
  assert.equal(hostFromEnv({ CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't' }), 'claude')
  assert.equal(hostFromEnv({ CLAUDE_CODE_HOST_SESSION_ID: 's', CODEX_THREAD_ID: 't' }), 'claude')
  assert.equal(hostFromEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' }), 'claude')
})

try {
  await stopTestService(PORT)
  await step('(k) with only CODEX_THREAD_ID, open works: the session is codex-<thread>, host codex, a command session', async () => {
    const result = await codex.run(['open', '--out', 'json'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    opened = JSON.parse(result.stdout)
    assert.equal(opened.structuredContent.port, PORT)
    const status = await run(process.execPath, [join(ADAPTERS_DIR, 'service', 'bin', 'cowart-service.mjs'), '--status', '--port', String(PORT)], { env: { ...process.env, COWART_RUNTIME_DIR: process.env.COWART_RUNTIME_DIR }, windowsHide: true })
    const json = JSON.parse(status.stdout.slice(status.stdout.indexOf('{')))
    const session = json.sessions.find((entry) => entry.id === SESSION)
    assert.ok(session, `no ${SESSION} in --status: ${JSON.stringify(json.sessions)}`)
    assert.equal(session.host, 'codex')
    assert.equal(session.cli, true)
    assert.equal(session.state, 'online')
  })

  await step('(k) a Codex session is not turned away by the Claude Code desktop switch', async () => {
    const other = codexSession(randomUUID(), { COWART_HOST: 'codex', CLAUDE_CODE_ENTRYPOINT: 'cli' })
    const result = await other.run(['pages'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal((await sessionOf(other.session))?.host, 'codex')
  })

  await step('(l) open: a link for the built-in browser, no Browser pane, no listener', async () => {
    const said = opened.content[0].text
    assert.match(said, /内置浏览器/)
    assert.ok(said.includes(`](${opened.structuredContent.url})`), `no clickable link:\n${said}`)
    assert.match(said, /Ctrl\+Shift\+B/)
    assert.match(said, /看画布/)
    noClaudeWords(said, 'open')
    assert.doesNotMatch(said, /listen|监听/, 'open names the listener')
  })

  await step('(u) without COWART_COMMAND_LINK, Codex is told to run "$HOME/.cowart/bin/cowart.mjs" (Windows PowerShell 5.1 leaves ~ as it is); Claude Code still ~/.cowart', async () => {
    // A home of the check's own, with the file install writes there leading to this checkout's command.
    const home = join(root, 'home')
    const link = join(home, '.cowart', 'bin', 'cowart.mjs')
    await mkdir(dirname(link), { recursive: true })
    await writeFile(link, `const target = ${JSON.stringify(join(ADAPTERS_DIR, 'claude', 'bin', 'cowart.mjs').replaceAll('\\', '/'))}\n`)
    const homeEnv = { COWART_COMMAND_LINK: undefined, USERPROFILE: home, HOME: home }
    const result = await codexSession(thread, homeEnv).run(['open'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /\$HOME\/\.cowart\/bin\/cowart\.mjs/, result.stdout)
    assert.doesNotMatch(result.stdout, /~\/\.cowart/)
    const help = await codexSession(thread, homeEnv).run(['help'])
    assert.doesNotMatch(help.stdout, /~\/\.cowart/, 'help names ~/.cowart')
    const claude = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-claude-home', env: homeEnv }).run(['open'])
    assert.equal(claude.code, 0, claude.stderr || claude.stdout)
    assert.match(claude.stdout, /node ~\/\.cowart\/bin\/cowart\.mjs listen/)
    assert.doesNotMatch(claude.stdout, /\$HOME/)
  })

  await step('(l) take: the page, the pane follows, no listener', async () => {
    const result = await codex.run(['take', 'Codex 页'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /你现在负责「Codex 页」这一页/)
    noClaudeWords(result.stdout, 'take')
    assert.doesNotMatch(result.stdout, /listen/)
  })

  await step("(s) take --shown before the session opened the canvas: the error speaks of Codex's built-in browser; Claude Code's of the Browser pane, as before", async () => {
    const fresh = await codexSession(randomUUID()).run(['take', '--shown'])
    assert.notEqual(fresh.code, 0, fresh.stdout)
    assert.match(fresh.stderr + fresh.stdout, /还没在 Codex 内置浏览器里打开这张画布/)
    noClaudeWords(fresh.stderr + fresh.stdout, 'take --shown')
    const claude = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-claude-shown' }).run(['take', '--shown'])
    assert.notEqual(claude.code, 0, claude.stdout)
    assert.match(claude.stderr + claude.stdout, /这个会话还没在 Browser 面板里打开这张画布/)
  })

  await step('(l) listen is not for Codex: it says so and exits 2', async () => {
    const result = await codex.run(['listen'])
    assert.equal(result.code, 2, result.stdout)
    assert.match(result.stderr + result.stdout, /Codex 不用 listen/)
    noClaudeWords(result.stderr + result.stdout, 'listen')
    const help = await codex.run(['help'])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout.split('\n')[0], /Codex/)
    noClaudeWords(help.stdout, 'help')
  })

  await step('(l) requests, request and reply: Codex wording, confirmation by 看画布 or the user saying yes', async () => {
    const created = await api(origin, '/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 生成 AI HTML\n\nPrompt:\n一个登录页', session: SESSION, projectDir, canvasDir })
    const id = created.request.id
    const listed = await codex.run(['requests'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.match(listed.stdout, new RegExp(`#${id}「`))
    assert.match(listed.stdout, new RegExp(`request ${id}`))
    noClaudeWords(listed.stdout, 'requests')
    assert.doesNotMatch(listed.stdout, /监听/)
    const details = await codex.run(['request', String(id)])
    assert.equal(details.code, 0, details.stderr)
    assert.match(details.stdout, /—— Codex 宿主说明 ——/)
    assert.doesNotMatch(details.stdout, /Claude Code 宿主说明/)
    assert.match(details.stdout, /看画布/)
    noClaudeWords(details.stdout, 'request')
    const replied = await codex.run(['reply', String(id), 'skipped'])
    assert.equal(replied.code, 0, replied.stderr)
    assert.doesNotMatch(replied.stdout, /监听|listen/)

    const edit = await api(origin, '/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 按标注修改\n\nPrompt:\n改成红色', session: SESSION, projectDir, canvasDir })
    const editDetails = await codex.run(['request', String(edit.request.id)])
    assert.match(editDetails.stdout, /按标注修改的标注不一定是改图要求/)
    noClaudeWords(editDetails.stdout, 'request (按标注修改)')
    await codex.run(['reply', String(edit.request.id), 'skipped'])
  })

  await step("(n) the Codex session's canvas page says Codex and offers Codex imagegen", async () => {
    const response = await fetch(opened.structuredContent.url.replace(/^http:\/\/[^/]+/, origin))
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.ok(html.includes(`"session":"${SESSION}"`))
    assert.ok(html.includes('"hostLabel":"Codex"'), 'the page does not say Codex')
    assert.ok(html.includes('"codex-imagegen"'), 'the page does not offer Codex imagegen')
  })

  await step('(m) a Codex session is online while its canvas page is open, and ends a lease after it closes', async () => {
    await stopTestService(PORT)
    // A lease of a second: a session with nothing open ends a second after its last command.
    const lease = { COWART_SESSION_LEASE_MS: '1000' }
    const warmup = cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-warmup', env: lease })
    assert.equal((await warmup.run(['pages'])).code, 0)
    const pageThread = randomUUID()
    const paged = codexSession(pageThread, lease)
    const page = openEvents(`${origin}/api/page-events?${new URLSearchParams({ token, session: paged.session, pane: 'pane-codex-cli', canvasDir })}`)
    try {
      await page.ready
      const result = await paged.run(['open'])
      assert.equal(result.code, 0, result.stderr || result.stdout)
      await delay(2500)
      assert.equal((await sessionOf(paged.session))?.state, 'online', 'ended with its canvas page open')
      page.close()
      const closed = Date.now()
      await delay(300)
      assert.equal((await sessionOf(paged.session))?.state, 'online', 'ended at once when its page closed')
      await waitFor(async () => (await sessionOf(paged.session))?.state === 'ended', { timeoutMs: 6000, what: 'the session to end after its page closed' })
      assert.ok(Date.now() - closed >= 800, `ended ${Date.now() - closed} ms after its page closed`)
    } finally {
      page.close()
    }
  })

  await step("(o) D9: the hook's session is the command's (D7), else codex-<stdin's session_id>", async () => {
    const { hookSessionId } = await import('../lib/cli.mjs')
    assert.equal(hookSessionId({}, { session_id: 'a1b2' }), 'codex-a1b2')
    assert.equal(hookSessionId({}, { session_id: 'a/b c' }), 'codex-abc')
    assert.equal(hookSessionId({ CODEX_THREAD_ID: 'from-env' }, { session_id: 'a1b2' }), 'codex-from-env')
    assert.equal(hookSessionId({ COWART_SESSION_ID: 'mine' }, { session_id: 'a1b2' }), 'mine')
    assert.equal(hookSessionId({}, {}), null)
    assert.equal(hookSessionId({}, null), null)
  })

  await step('(o) hook prompt with no service running, or one that never answers: nothing printed, exit 0, within 2.5 s', async () => {
    await stopTestService(PORT)
    const none = await promptHook(thread)
    assert.equal(none.code, 0, none.stderr)
    assert.equal(none.stdout + none.stderr, '')
    assert.ok(none.ms < 2500, `took ${none.ms} ms`)
    assert.equal(await serviceStatus(PORT), null, 'the hook started a service')
    // A port that takes the connection and never answers (the canvas lock leads there): the hook
    // gives up after 2.5 s.
    const sockets = new Set()
    const mute = net.createServer((socket) => {
      sockets.add(socket)
      // The hook's process goes away mid-connection.
      socket.on('error', () => {})
    })
    await new Promise((resolve) => mute.listen(PORT, '127.0.0.1', resolve))
    const unlock = await standInLock(PORT)
    try {
      const stuck = await promptHook(thread)
      assert.equal(stuck.code, 0, stuck.stderr)
      assert.equal(stuck.stdout + stuck.stderr, '')
      assert.ok(stuck.ms >= 2400 && stuck.ms < 4500, `took ${stuck.ms} ms`)
    } finally {
      await unlock()
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => mute.close(resolve))
    }
  })

  // Sessions end two seconds after their last command (D8 below).
  const lease = { COWART_SESSION_LEASE_MS: '2000' }
  await step('(o) hook prompt for a known Codex session: nothing when nothing waits; the requests, 看画布 and the commands when some do', async () => {
    const warmup = cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-hook-warmup', env: lease })
    assert.equal((await warmup.run(['pages'])).code, 0)
    assert.equal((await codex.run(['pages'])).code, 0)
    const quiet = await promptHook(thread)
    assert.equal(quiet.code, 0, quiet.stderr)
    assert.equal(quiet.stdout + quiet.stderr, '')

    const created = await api(origin, '/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 生成 AI HTML\n\nPrompt:\n一个设置页', session: SESSION, pageName: '设置页', projectDir, canvasDir })
    const id = created.request.id
    const told = await promptHook(thread)
    assert.equal(told.code, 0, told.stderr)
    assert.match(told.stdout, new RegExp(`#${id}「`))
    assert.match(told.stdout, /「设置页」/)
    assert.match(told.stdout, /看画布/)
    assert.match(told.stdout, /\.mjs"? requests\b/)
    assert.match(told.stdout, new RegExp(`\\.mjs"? request ${id}\\b`))
    noClaudeWords(told.stdout, 'hook prompt')
    assert.doesNotMatch(told.stdout, /listen|监听/)
    // A reminder only: the request is not taken as delivered.
    const listed = await api(origin, '/api/bridge/call', { session: SESSION, op: 'request-list', args: {} })
    assert.equal(listed.result.requests.find((request) => request.id === id)?.delivered, false)

    assert.equal((await codex.run(['reply', String(id), 'skipped'])).code, 0)
    assert.equal((await promptHook(thread)).stdout, '')
  })

  await step('(o) D8: the hook keeps a known Codex session online, as its commands do', async () => {
    await waitFor(async () => (await sessionOf(SESSION))?.state === 'ended', { timeoutMs: 8000, what: 'the Codex session to end (a lease of 2 s)' })
    const hooked = await promptHook(thread)
    assert.equal(hooked.code, 0, hooked.stderr)
    assert.equal((await sessionOf(SESSION))?.state, 'online', 'the hook did not bring the session back')
  })

  await step('(o) hook prompt for a thread that never ran a command: nothing printed, and no session for it', async () => {
    const stranger = randomUUID()
    const result = await promptHook(stranger)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout + result.stderr, '')
    assert.equal(await sessionOf(`codex-${stranger}`), null, 'the hook made a session for a thread it did not know')
  })

  await step("(o) hook-check leaves a Claude Code session a Claude Code one (a Codex started inside it asks with the session's id)", async () => {
    const claude = cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-claude-asked', env: lease })
    assert.equal((await claude.run(['pages'])).code, 0)
    assert.equal((await sessionOf(claude.session))?.host, 'claude')
    const asked = await api(origin, '/api/bridge/call', { session: claude.session, op: 'hook-check', cli: true, host: 'codex' })
    assert.deepEqual(asked.result, { requests: [] })
    assert.equal((await sessionOf(claude.session))?.host, 'claude', 'the hook made the Claude Code session a Codex one')
  })

  await step('(o) hook prompt asks no service older than the hook (0.3.0): one would take the thread for a session of its own', async () => {
    const { localIdentity } = await import('../../service/lib/identity.mjs')
    await stopTestService(PORT)
    const asked = []
    const older = http.createServer((req, res) => {
      if (req.url === '/api/service') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...localIdentity(), version: '0.2.16', pid: process.pid }))
      asked.push(req.url)
      res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '不认识的操作' }))
    })
    await new Promise((resolve) => older.listen(PORT, '127.0.0.1', resolve))
    const unlock = await standInLock(PORT)
    try {
      const result = await promptHook(thread)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout + result.stderr, '')
      assert.deepEqual(asked, [], 'the hook asked a 0.2.16 service')
    } finally {
      await unlock()
      older.closeAllConnections()
      await new Promise((resolve) => older.close(resolve))
    }
  })

  await step('(t) after the service restarts, the hook still reminds a Codex session of the requests queued for it before, and knows the session again', async () => {
    await stopTestService(PORT)
    // A request the user sent the session before the restart, in the queue the service keeps on the canvas.
    const waitingThread = randomUUID()
    const file = join(canvasDir, REQUESTS_FILE_NAME)
    const saved = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { version: 1, nextId: 1, requests: [] }
    const id = Math.max(Number(saved.nextId) || 1, ...saved.requests.map((request) => request.id + 1))
    const now = new Date().toISOString()
    saved.requests.push({
      id, requestKey: randomUUID(), session: `codex-${waitingThread}`, executor: 'session', pageId: null, pageName: '重启前', kind: 'canvas',
      title: '重启前点的', summary: '', annotations: [], text: '重启前点的', projectDir, canvasDir, holderShapeId: null,
      status: 'pending', message: '', delivered: false, finishing: false, createdAt: now, updatedAt: now
    })
    saved.nextId = id + 1
    await writeFile(file, `${JSON.stringify(saved)}\n`)
    // Another session's command starts the service again.
    assert.equal((await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-restarter', env: lease }).run(['pages'])).code, 0)
    assert.equal(await sessionOf(`codex-${waitingThread}`), null, 'the restarted service knew the session before the hook asked')
    const told = await promptHook(waitingThread)
    assert.equal(told.code, 0, told.stderr)
    assert.match(told.stdout, new RegExp(`#${id}「重启前点的」`))
    assert.match(told.stdout, /看画布/)
    const known = await sessionOf(`codex-${waitingThread}`)
    assert.equal(known?.host, 'codex', JSON.stringify(known))
    assert.equal(known?.cli, true)
  })

  await step('(v) the hook finds the service where the canvas lock says, past the ports a command looks through', async () => {
    await stopTestService(PORT)
    const farThread = randomUUID()
    const far = cliSession({ cwd: projectDir, port: FAR_PORT, session: `codex-${farThread}`, env: codexEnv(farThread) })
    try {
      const started = await far.run(['pages'])
      assert.equal(started.code, 0, started.stderr || started.stdout)
      assert.ok(await serviceStatus(FAR_PORT), `no service on ${FAR_PORT}`)
      const created = await api(`http://127.0.0.1:${FAR_PORT}`, '/api/messages', { text: '[@Cowart](plugin://cowart@cowart-github) 生成 AI HTML\n\nPrompt:\n远处的页', session: far.session, projectDir, canvasDir })
      // The hook runs with the port a command starts from (PORT): nothing answers there or in the 19 after it.
      const told = await promptHook(farThread)
      assert.equal(told.code, 0, told.stderr)
      assert.match(told.stdout, new RegExp(`#${created.request.id}「`), `no reminder: ${told.stdout}`)
    } finally {
      await stopTestService(FAR_PORT)
    }
  })

  await step('(p) install sets Codex up: the skill, the prompt hook once, no cowart_mcp server, backups; uninstall takes the skill and the hook away', async () => {
    const home = join(root, 'codex-home')
    const skills = join(home, 'skills')
    const junction = process.platform === 'win32' ? 'junction' : 'dir'
    // The old Codex skills (adapters/codex/skills of some checkout), linked the way Codex had them.
    const oldSkills = join(root, 'old-checkout', 'adapters', 'codex', 'skills')
    const OLD = ['cowart-image-edit', 'cowart-image-gen', 'cowart-open-canvas']
    await mkdir(skills, { recursive: true })
    for (const name of ['cowart', ...OLD]) {
      await mkdir(join(oldSkills, name), { recursive: true })
      await symlink(join(oldSkills, name), join(skills, name), junction)
    }
    // Hooks of the user's, and a cowart hook an earlier install wrote.
    const otherHooks = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo other', timeout: 3 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }]
    }
    const hooksFile = join(home, 'hooks.json')
    const hooksBefore = `${JSON.stringify({ hooks: { ...otherHooks, UserPromptSubmit: [...otherHooks.UserPromptSubmit, { hooks: [{ type: 'command', command: 'node "C:/old/.cowart/bin/cowart.mjs" hook prompt', timeout: 5 }] }] } }, null, 2)}\n`
    await writeFile(hooksFile, hooksBefore)
    // config.toml in CRLF: the cowart_mcp server and its subtable go, the rest stays byte for byte.
    const kept = ['model = "gpt-5"', '', '[mcp_servers.other]', 'command = "x"', '', ''].join('\r\n')
    const cowartMcp = ["[mcp_servers.cowart_mcp]", "command = 'C:\\Program Files\\nodejs\\node.exe'", "args = ['C:\\x\\start.mjs']", '', '[mcp_servers.cowart_mcp.env]', 'FOO = "1"', '', ''].join('\r\n')
    const after = ['[mcp_servers.cowart_mcp_two]', 'command = "y"', '', '[notice]', 'a = 1', ''].join('\r\n')
    const configFile = join(home, 'config.toml')
    await writeFile(configFile, kept + cowartMcp + after)

    const installer = cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-installer', env: { CODEX_HOME: home } })
    const first = await installer.run(['install'])
    assert.equal(first.code, 0, first.stderr || first.stdout)
    assert.match(first.stdout, /Codex/)
    const again = await installer.run(['install'])
    assert.equal(again.code, 0, again.stderr || again.stdout)

    const codexSkill = join(ADAPTERS_DIR, 'claude', 'codex-skill', 'cowart')
    assert.ok((await lstat(join(skills, 'cowart'))).isSymbolicLink(), 'skills/cowart is not a link')
    assert.equal(await realpath(join(skills, 'cowart')), await realpath(codexSkill))
    for (const name of OLD) {
      await assert.rejects(lstat(join(skills, name)), `the old ${name} link is still there`)
      assert.ok(existsSync(join(oldSkills, name)), `the directory the old ${name} link led to is gone`)
    }

    const hooks = JSON.parse(await readFile(hooksFile, 'utf8'))
    const ours = hooks.hooks.UserPromptSubmit.flatMap((group) => group.hooks).filter((hook) => hook.command.includes('cowart') && hook.command.includes('hook prompt'))
    assert.deepEqual(ours, [{ type: 'command', command: `"${process.execPath}" "${COMMAND_LINK}" hook prompt || exit 0`, timeout: 5 }])
    assert.deepEqual(hooks.hooks.UserPromptSubmit[0], otherHooks.UserPromptSubmit[0])
    assert.deepEqual(hooks.hooks.Stop, otherHooks.Stop)
    assert.equal(await readFile(configFile, 'utf8'), kept + after)

    const backups = await readdir(home)
    const configBackups = backups.filter((name) => /^config\.toml\.bak-cowart-\d{14}/.test(name))
    assert.equal(configBackups.length, 1, backups.join(', '))
    assert.equal(await readFile(join(home, configBackups[0]), 'utf8'), kept + cowartMcp + after)
    const hooksBackups = backups.filter((name) => /^hooks\.json\.bak-cowart-\d{14}/.test(name))
    assert.equal(hooksBackups.length, 1, `the second install changed nothing, so it backs nothing up: ${backups.join(', ')}`)
    assert.equal(await readFile(join(home, hooksBackups[0]), 'utf8'), hooksBefore)

    const removed = await installer.run(['uninstall'])
    assert.equal(removed.code, 0, removed.stderr || removed.stdout)
    await assert.rejects(lstat(join(skills, 'cowart')), 'uninstall left the skill link')
    assert.ok(existsSync(join(codexSkill, 'SKILL.md')), "uninstall took the checkout's skill away")
    assert.deepEqual(JSON.parse(await readFile(hooksFile, 'utf8')).hooks, otherHooks)
    assert.equal(await readFile(configFile, 'utf8'), kept + after, 'uninstall changed config.toml')
  })

  await step("(p) install with no Codex home leaves Codex alone; a hooks.json that is not JSON, and skills that are not the old plugin's, are left as they are", async () => {
    const missing = join(root, 'no-codex')
    const skipped = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-installer', env: { CODEX_HOME: missing } }).run(['install'])
    assert.equal(skipped.code, 0, skipped.stderr || skipped.stdout)
    assert.match(skipped.stdout, /Codex/)
    assert.equal(existsSync(missing), false, 'install made a Codex home')

    const broken = join(root, 'codex-broken')
    const skills = join(broken, 'skills')
    // A skill of the user's under an old name: one linked from elsewhere, one a real directory.
    const elsewhere = join(root, 'my-skills', 'cowart-image-edit')
    await mkdir(elsewhere, { recursive: true })
    await mkdir(join(skills, 'cowart-open-canvas'), { recursive: true })
    await writeFile(join(skills, 'cowart-open-canvas', 'SKILL.md'), 'mine')
    await symlink(elsewhere, join(skills, 'cowart-image-edit'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(broken, 'hooks.json'), '{ "hooks": ')
    const result = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-installer', env: { CODEX_HOME: broken } }).run(['install'])
    assert.notEqual(result.code, 0, 'install said it set the hook up')
    assert.match(result.stdout + result.stderr, /hooks\.json/)
    assert.equal(await readFile(join(broken, 'hooks.json'), 'utf8'), '{ "hooks": ')
    assert.equal((await readdir(broken)).some((name) => name.includes('.bak-cowart-')), false, 'a file left alone needs no backup')
    assert.equal(await realpath(join(skills, 'cowart-image-edit')), await realpath(elsewhere), 'a link to somewhere else was touched')
    assert.equal(await readFile(join(skills, 'cowart-open-canvas', 'SKILL.md'), 'utf8'), 'mine', 'a real directory was touched')
  })

  await step('(p) the prompt hook ends with 0 when the cowart command it runs is gone: Codex holds the message back on an exit 2', async () => {
    const home = join(root, 'codex-gone')
    await mkdir(home, { recursive: true })
    const link = join(root, 'gone', 'cowart.mjs')
    const installed = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-installer', env: { CODEX_HOME: home, COWART_COMMAND_LINK: link } }).run(['install'])
    assert.equal(installed.code, 0, installed.stderr || installed.stdout)
    const [hook] = JSON.parse(await readFile(join(home, 'hooks.json'), 'utf8')).hooks.UserPromptSubmit.flatMap((group) => group.hooks)
    // The Cowart the command leads to was removed (a release folder deleted, a clone moved).
    const source = await readFile(link, 'utf8')
    await writeFile(link, source.replace(/^const target = ".*"$/m, `const target = ${JSON.stringify(join(root, 'removed', 'cowart.mjs').replaceAll('\\', '/'))}`))
    const gone = await run(process.execPath, [link, 'hook', 'prompt'], { windowsHide: true }).catch((error) => error)
    assert.equal(gone.code, 2, 'the command whose Cowart is gone no longer exits 2: the check needs another way to fail it')
    // The way Codex runs a hook: cmd /C "<command>" on Windows, $SHELL -lc elsewhere (codex-rs hooks).
    const child = process.platform === 'win32'
      ? spawn(process.env.COMSPEC || 'cmd.exe', ['/C', `"${hook.command}"`], { windowsVerbatimArguments: true, windowsHide: true })
      : spawn(process.env.SHELL || '/bin/sh', ['-lc', hook.command])
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stdin.end(JSON.stringify({ session_id: randomUUID(), hook_event_name: 'UserPromptSubmit', prompt: '你好' }))
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(code, 0, `Codex would ${code === 2 ? 'hold back' : 'report a failed hook on'} every message (exit ${code})`)
    assert.equal(stdout, '')
  })

  await step('(p) a cowart_mcp table with a value over several lines is left for the user: config.toml as it was, and install says so', async () => {
    const home = join(root, 'codex-multiline')
    await mkdir(home, { recursive: true })
    const config = ['model = "gpt-5"', '', '[mcp_servers.cowart_mcp]', 'command = "node"', 'args = [', '  "start.mjs",', '  ["nested"]', ']', 'env = { A = "1" }', '', '[mcp_servers.other]', 'command = "x"', ''].join('\n')
    await writeFile(join(home, 'config.toml'), config)
    const result = await cliSession({ cwd: projectDir, port: PORT, session: 'codex-cli-installer', env: { CODEX_HOME: home } }).run(['install'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config, 'install cut the table at a line inside its value')
    assert.match(result.stdout, /cowart_mcp/)
    assert.equal((await readdir(home)).some((name) => name.startsWith('config.toml.bak-cowart-')), false, 'a file left alone needs no backup')
    const { withoutCowartMcp } = await import('../lib/install.mjs')
    assert.equal(withoutCowartMcp('[mcp_servers.cowart_mcp]\nargs = ["a", "b"]\nenv = { A = "[" }\n\n[x]\ny = 1\n'), '[x]\ny = 1\n', 'one-line values are cut out as before')
  })
} finally {
  // Each on its own: one that fails must not keep the others, and finish(), from cleaning up.
  await codex.close().catch(() => {})
  await stopTestService(PORT).catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
finish()
