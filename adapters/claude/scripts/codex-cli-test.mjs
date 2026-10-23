#!/usr/bin/env node
// A Codex session runs the cowart command the way a Claude Code session does (FORK.md, D7 / D8 /
// D11 / D12 of docs/plan/codex-cli-resident.md): Codex gives the commands it runs CODEX_THREAD_ID
// and nothing of Claude's, and that is the session (codex-<thread>) and its host. Its texts send
// the user a link for Codex's built-in browser and never a listener (Codex has none); its canvas
// page keeps it online while open; that page names Codex and offers Codex imagegen. The check runs
// with a runtime directory, a canvas and a port of its own.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const root = await mkdtemp(join(tmpdir(), 'cowart-codex-cli-check-'))
// Before token.mjs loads: the check's commands and the services they start use this token and
// runtime directory, never the machine's.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
const { loadOrCreateToken } = await import('../../service/lib/token.mjs')
const { ADAPTERS_DIR } = await import('../../shared/paths.mjs')
const { EMPTY_CANVAS, cliSession, delay, finish, openEvents, serviceStatus, step, stopTestService, waitFor } = await import('./test-kit.mjs')

const PORT = Number(process.env.COWART_CODEX_CLI_TEST_PORT) || 43391
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

await stopTestService(PORT)
try {
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

  await step('(l) take: the page, the pane follows, no listener', async () => {
    const result = await codex.run(['take', 'Codex 页'])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /你现在负责「Codex 页」这一页/)
    noClaudeWords(result.stdout, 'take')
    assert.doesNotMatch(result.stdout, /listen/)
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
} finally {
  await codex.close()
  await stopTestService(PORT)
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
finish()
