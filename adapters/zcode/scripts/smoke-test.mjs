#!/usr/bin/env node
// End-to-end check of the ZCode adapter without ZCode: runs a session bridge over stdio
// against a throwaway project (the bridge starts its own canvas service on a test port) and
// exercises the ZCode-specific parts — the host it registers as, the page wording, the
// --once listener (Claude Code runs the same one), and a Claude Code session sharing the
// same service. The shared canvas behavior is covered by the Claude adapter's checks.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { INSTRUCTIONS, INSTRUCTIONS_LIMIT } from '../lib/bridge.mjs'
import { EMPTY_CANVAS, FIXTURES, delay, finish, serviceStatus, startBridge, step, stopTestService, text, waitFor } from '../../claude/scripts/test-kit.mjs'

const PORT = Number(process.env.COWART_ZCODE_SMOKE_PORT) || 43291
const SESSION = 'zsmoke'
const CLAUDE_SESSION = 'zsmoke-claude'
const LISTENER = join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-listen.mjs')

const token = await loadOrCreateToken()
const projectDir = await mkdtemp(join(tmpdir(), 'cowart-zcode-smoke-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

// The ZCode bridge the way ZCode runs it (its MCP config env says which host it is).
async function startZCodeBridge({ session }) {
  const inherited = { ...process.env }
  delete inherited.CLAUDE_CODE_ENTRYPOINT
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ADAPTERS_DIR, 'zcode', 'bin', 'cowart-zcode-mcp.mjs')],
    cwd: projectDir,
    env: { ...inherited, COWART_HOST: 'zcode', COWART_CLAUDE_PORT: String(PORT), COWART_SESSION_ID: session, COWART_CANVAS_DIR: canvasDir },
    stderr: 'pipe'
  })
  const client = new Client({ name: `cowart-check-${session}`, version: '0.0.0' })
  await client.connect(transport)
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }), close: () => client.close().catch(() => {}) }
}

// Runs the real listener with --once and resolves with { code, stdout } once it exits.
const listeners = []
function runOnceListener() {
  const child = spawn(process.execPath, [LISTENER, '--port', String(PORT), '--session', SESSION, '--once'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  listeners.push(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', () => {})
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })))
  return { done, kill: () => child.kill() }
}

await stopTestService(PORT)
const bridge = await startZCodeBridge({ session: SESSION })
const { call, client } = bridge
let origin = ''

try {
  await step('bridge instructions fit the budget and say how ZCode gets woken up; the skill exists', async () => {
    assert.ok(INSTRUCTIONS.length <= INSTRUCTIONS_LIMIT, `bridge instructions are ${INSTRUCTIONS.length} characters, budget is ${INSTRUCTIONS_LIMIT}`)
    assert.match(INSTRUCTIONS, /run_in_background/)
    assert.match(INSTRUCTIONS, /AskUserQuestion/)
    assert.match(INSTRUCTIONS, /看画布/)
    assert.match(INSTRUCTIONS, /Skill 工具加载 cowart/)
    const { readFile } = await import('node:fs/promises')
    const skill = await readFile(join(ADAPTERS_DIR, 'zcode', 'skills', 'cowart', 'SKILL.md'), 'utf8')
    assert.match(skill, /^name: cowart$/m)
    assert.match(skill, /^description: .+/m)
    assert.match(skill, /run_in_background/)
  })

  await step('tool list: same canvas tools as the Claude host, page-only tools hidden', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of [
      'render_cowart_canvas_widget',
      'get_cowart_canvas_state',
      'get_cowart_selection',
      'insert_cowart_image',
      'insert_cowart_html_draft',
      'insert_cowart_video',
      'get_cowart_request',
      'reply_cowart_request',
      'list_cowart_requests'
    ]) {
      assert.ok(names.includes(name), `missing ${name}`)
    }
    for (const name of ['save_cowart_canvas_state', 'track_cowart_analytics_event', 'read_cowart_page_asset']) {
      assert.ok(!names.includes(name), `should hide ${name}`)
    }
  })

  await step('the bridge started the canvas service and registered as a zcode session', async () => {
    const status = await serviceStatus(PORT)
    assert.ok(status, 'no canvas service on the test port')
    const session = status.sessions.find((entry) => entry.id === SESSION)
    assert.ok(session?.bridge, JSON.stringify(status.sessions))
    assert.equal(session.host, 'zcode')
    assert.equal(session.state, 'online')
  })

  let listenCommand = ''
  await step('render returns a session URL and a --once listener command', async () => {
    const result = await call('render_cowart_canvas_widget', { projectDir, sessionName: '小 Z' })
    assert.ok(!result.isError, text(result))
    const opened = result.structuredContent
    assert.equal(opened.port, PORT)
    assert.match(opened.url, new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?session=${SESSION}&projectDir=`))
    assert.equal(opened.sessionName, '小 Z')
    listenCommand = opened.listenCommand
    assert.match(listenCommand, new RegExp(`cowart-listen\\.mjs" --port ${PORT} --session ${SESSION} --once$`))
    assert.equal(opened.listenerConnected, false)
    assert.match(text(result), /Markdown 链接发给用户/)
    assert.match(text(result), /run_in_background/)
    origin = `http://127.0.0.1:${opened.port}`
  })

  await step('a zcode session gets the canvas page with ZCode wording', async () => {
    const page = await fetch(`${origin}/?${new URLSearchParams({ session: SESSION, projectDir, canvasDir })}`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('id="cowartClaudeBridge"'), 'host bridge missing')
    assert.ok(html.includes('"hostLabel":"ZCode"'), 'page config does not name the host')
    assert.ok(html.includes('"hostName":"ZCode"'), 'shared kit does not name the host')
    for (const script of ['kit', 'canvas-chrome', 'video-playback', 'ai-video', 'ai-image', 'web-reference']) {
      assert.ok(html.includes(`id="cowartShared-${script}"`), `missing ${script}`)
    }
  })

  await step('a Claude Code session on the same service keeps the Claude wording', async () => {
    const claude = await startBridge({ cwd: projectDir, port: PORT, session: CLAUDE_SESSION })
    try {
      const entry = await waitFor(
        async () => (await serviceStatus(PORT)).sessions.find((item) => item.id === CLAUDE_SESSION && item.host === 'claude'),
        { what: 'the claude session to register' }
      )
      assert.ok(entry.bridge)
      const page = await fetch(`${origin}/?${new URLSearchParams({ session: CLAUDE_SESSION, projectDir, canvasDir })}`)
      const html = await page.text()
      assert.ok(!html.includes('"hostLabel":"ZCode"'), 'claude page carries the zcode label')
      assert.ok(!html.includes('"hostName"'), 'claude page names a host')
    } finally {
      await claude.close()
    }
  })

  const api = (path, body) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify(body)
    }).then((response) => response.json())
  const sendMessage = (message) => api('/api/messages', { text: message, session: SESSION, projectDir, canvasDir })

  await step('canvas requests reach the --once listener in one batch per wake-up, nothing lost between runs', async () => {
    // Two requests queue up before any listener exists; one wake-up carries both.
    const first = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 生成图片\n\nPrompt:\n一只猫')
    const second = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 生成图片\n\nPrompt:\n两只猫')
    const run1 = runOnceListener()
    const batch = await run1.done
    assert.equal(batch.code, 0, `listener exit ${batch.code}: ${batch.stdout}`)
    assert.match(batch.stdout, new RegExp(`Cowart 画布请求 #${first.request.id}「生成图片」`))
    assert.match(batch.stdout, new RegExp(`Cowart 画布请求 #${second.request.id}`))
    assert.match(batch.stdout, /AskUserQuestion/)

    // A request that arrives while no listener runs waits, undelivered; the next run gets it.
    const third = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 生成图片\n\nPrompt:\n三只猫')
    const run2 = runOnceListener()
    const later = await run2.done
    assert.equal(later.code, 0, `listener exit ${later.code}: ${later.stdout}`)
    assert.match(later.stdout, new RegExp(`Cowart 画布请求 #${third.request.id}`))
    assert.ok(!later.stdout.includes(`#${first.request.id}`), 'a delivered request was re-sent')

    // A quiet run stays connected instead of exiting (ZCode kills it with the session).
    const idle = runOnceListener()
    const stayed = await Promise.race([idle.done.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 1500))])
    assert.ok(stayed, 'the --once listener exited with nothing to report')
    idle.kill()
  })

  await step('with no listener running, 看画布 lists a queued request with its question and hands it over', async () => {
    const noListener = async () => !(await serviceStatus(PORT)).sessions.find((entry) => entry.id === SESSION)?.listener
    await waitFor(noListener, { what: 'the last listener to go' })
    const queued = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 生成 AI HTML\n\nPrompt:\n排队的')
    const listed = await call('list_cowart_requests', {})
    assert.match(text(listed), new RegExp(`Cowart 画布请求 #${queued.request.id}「.+AskUserQuestion`))
    assert.match(text(listed), new RegExp(`监听没在跑.+--session ${SESSION} --once`))
    const idle = runOnceListener()
    const stayed = await Promise.race([idle.done.then(() => false), delay(1500).then(() => true)])
    assert.ok(stayed, 'a listed request was announced again')
    idle.kill()
    await waitFor(noListener, { what: 'the listener to go' })
    const skipped = await call('reply_cowart_request', { id: queued.request.id, status: 'skipped' })
    assert.match(text(skipped), /监听没在跑/)
  })

  await step('request details come with ZCode host notes', async () => {
    const created = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 按标注修改\n\nPrompt:\n改背景')
    const details = await call('get_cowart_request', { id: created.request.id })
    assert.ok(!details.isError, text(details))
    assert.match(text(details), /—— ZCode 宿主说明 ——/)
    assert.ok(details.structuredContent.hostNotes.some((note) => note.includes('AskUserQuestion')))
    assert.ok(details.structuredContent.hostNotes.some((note) => note.includes('beast-gen')))
    assert.ok(details.structuredContent.hostNotes.some((note) => note.includes('用户选「照标注处理」时')))
    await call('reply_cowart_request', { id: created.request.id, status: 'skipped', message: '测试跳过' })
  })

  await step('按标注修改 wakes the listener with its 标注 words; AI HTML is not asked about image models', async () => {
    const edit = await sendMessage([
      '[@Cowart](plugin://cowart@cowart-github) 按标注修改',
      '',
      'Included annotation shapes: 2',
      'Change requests (标注 arrows bound to this shape; each spot is where the tip points, in % of the shape width and height from its top-left):',
      '1. 「lobby服务器跟你左下角的功能是不是重复了？」 → (12%, 80%)',
      '2. 「去掉 headscale，要么内网要么本机」 → (60%, 40%)'
    ].join('\n'))
    const draft = await sendMessage('[@Cowart](plugin://cowart@cowart-github) 生成 AI HTML\n\nPrompt:\n一个登录页')
    const { code, stdout } = await runOnceListener().done
    assert.equal(code, 0, `listener exit ${code}: ${stdout}`)
    const lineOf = ({ request }) => stdout.split('\n').find((line) => line.startsWith(`Cowart 画布请求 #${request.id}「`)) ?? ''
    assert.match(lineOf(edit), /：2 条标注：①「lobby服务器跟你左下角的功能是不是重复了？」②「去掉 headscale，要么内网要么本机」 → /)
    assert.match(lineOf(edit), /照标注处理（答疑、改当前项目，不生图）\/ 按标注出新图（免费本地模型）/)
    assert.match(lineOf(draft), /AskUserQuestion 问用户一句（执行 \/ 跳过）/)
    for (const { request } of [edit, draft]) await call('reply_cowart_request', { id: request.id, status: 'skipped', message: '测试跳过' })
  })

  await step('canvas inserts work through the zcode bridge like on claude', async () => {
    const inserted = await call('insert_cowart_image', { imagePath: join(FIXTURES, 'tiny.png') })
    assert.ok(!inserted.isError, text(inserted))
    const summary = await call('get_cowart_canvas_state', {})
    assert.match(text(summary), /tiny\.png → .*assets[\\/]tiny\.png/)
  })

  await step('the installer writes a strict-schema ZCode server entry and links the skills', async () => {
    const { mkdtemp: mkdtempAsync } = await import('node:fs/promises')
    const home = await mkdtempAsync(join(tmpdir(), 'cowart-zcode-install-'))
    const { spawnSync } = await import('node:child_process')
    try {
      const run = spawnSync(process.execPath, [join(ADAPTERS_DIR, 'zcode', 'scripts', 'install.mjs')], {
        env: { ...process.env, ZCODE_CONFIG_DIR: join(home, 'cli'), ZCODE_SKILLS_DIR: join(home, 'skills') },
        encoding: 'utf8'
      })
      assert.equal(run.status, 0, run.stderr)
      const { readFile } = await import('node:fs/promises')
      const config = JSON.parse(await readFile(join(home, 'cli', 'config.json'), 'utf8'))
      const server = config.mcp.servers.cowart
      assert.ok(server, 'no cowart server entry')
      assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'env', 'timeoutMs', 'type'])
      assert.equal(server.type, 'stdio')
      assert.equal(server.env.COWART_HOST, 'zcode')
      assert.equal(server.args[0], join(ADAPTERS_DIR, 'zcode', 'bin', 'cowart-zcode-mcp.mjs').replaceAll('\\', '/'))
      const skill = await readFile(join(home, 'skills', 'cowart', 'SKILL.md'), 'utf8')
      assert.match(skill, /^name: cowart$/m)
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
} finally {
  // A listener run keeps waiting for a service that went away: end the ones still running.
  for (const child of listeners) child.kill()
  await bridge.close()
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

finish()
