#!/usr/bin/env node
// Exercise exactly the published files from a directory outside this checkout:
// no node_modules, source modules, npm, existing service, or real user canvas.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(ADAPTERS_DIR, '..')
const sandbox = await mkdtemp(join(tmpdir(), 'cowart-adapters-cold-'))
const pluginDir = join(sandbox, 'plugin')
const homeDir = join(sandbox, 'home')
const runtimeDir = join(homeDir, '.cowart-claude')
const canvasDir = join(homeDir, '.cowart', 'canvas')
const sentinelDir = join(sandbox, 'bin')
const sentinelFile = join(sandbox, 'npm-was-called')
const manifest = JSON.parse(await readFile(join(ADAPTERS_DIR, 'generated/release-manifest.json'), 'utf8'))
const children = []
let servicePort
let token
let fixture

try {
  for (const [file, expectedHash] of Object.entries({
    ...manifest.resources,
    ...Object.fromEntries(Object.entries(manifest.artifacts).map(([name, hash]) => [`adapters/generated/${name}`, hash]))
  })) {
    const source = join(REPO_ROOT, file)
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), expectedHash, `${file} must match the release manifest`)
    const target = join(pluginDir, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  await mkdir(homeDir, { recursive: true })
  await mkdir(sentinelDir, { recursive: true })
  const npm = join(sentinelDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  await writeFile(npm, process.platform === 'win32'
    ? '@echo called>%COWART_NPM_SENTINEL%\r\n@exit /b 99\r\n'
    : '#!/bin/sh\nprintf called > "$COWART_NPM_SENTINEL"\nexit 99\n')
  if (process.platform !== 'win32') await chmod(npm, 0o755)
  assert.equal(await exists(join(pluginDir, 'node_modules')), false)
  assert.equal(await exists(join(pluginDir, 'adapters/node_modules')), false)

  servicePort = await unusedPort()
  const env = {
    ...process.env,
    // Keep the OS user profile intact for Chrome/Edge. Every Cowart write has an
    // explicit isolated path below; replacing USERPROFILE breaks Chromium on Windows.
    COWART_RUNTIME_DIR: runtimeDir,
    COWART_CANVAS_DIR: canvasDir,
    COWART_SESSION_NAMES_FILE: join(runtimeDir, 'session-names.json'),
    COWART_PORT: String(servicePort),
    COWART_CLAUDE_PORT: String(servicePort),
    COWART_PROMPT_WRITER: 'off',
    COWART_BEAST_CLI: join(sandbox, 'missing-beast.mjs'),
    COWART_SERVICE_IDLE_MS: '30000',
    COWART_ALLOW_CLI: '1',
    COWART_NPM_SENTINEL: sentinelFile,
    NODE_PATH: '',
    PATH: `${sentinelDir}${delimiter}${process.env.PATH || ''}`
  }
  // A check run from a Codex task: its thread would make the command a Codex session.
  for (const key of ['COWART_ADAPTERS_ROOT', 'COWART_SERVICE_BUILD_SALT', 'COWART_SERVICE_ENTRY', 'COWART_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key]

  // The cowart command, the way a session runs it from its shell tool: a process per command,
  // through the file `install` writes. Nothing runs yet: the command starts the bundled service.
  const commandLink = join(homeDir, '.cowart', 'bin', 'cowart.mjs')
  const claudeEnv = {
    ...env,
    COWART_SESSION_ID: 'cold-claude',
    COWART_COMMAND_LINK: commandLink,
    // install also writes the service's entry and its start at logon: into the sandbox.
    COWART_SERVICE_LINK: join(homeDir, '.cowart', 'bin', 'cowart-service.mjs'),
    COWART_STARTUP_DIR: join(homeDir, 'Startup'),
    // and sets Codex up when its home is there: the sandbox's.
    CODEX_HOME: join(homeDir, '.codex')
  }
  await mkdir(claudeEnv.CODEX_HOME, { recursive: true })
  const runNode = (script, args, input = '') => new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: pluginDir, env: claudeEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdin.end(input)
    child.on('close', (code) => done({ code, stdout, stderr, child }))
  })
  const installed = await runNode(join(pluginDir, 'adapters/generated/cowart.mjs'), ['install'])
  assert.equal(installed.code, 0, installed.stderr)
  assert.ok((await readFile(commandLink, 'utf8')).includes('/adapters/generated/cowart.mjs"'), 'The command leads to the installed bundle')
  if (process.platform === 'win32') {
    assert.ok((await readFile(claudeEnv.COWART_SERVICE_LINK, 'utf8')).includes('/adapters/generated/cowart-service.mjs"'), 'The service started at logon is the installed bundle')
    assert.ok(await exists(join(claudeEnv.COWART_STARTUP_DIR, 'CowartCanvas.lnk')), 'install puts the service in the Startup folder')
  }
  assert.equal(await realpath(join(claudeEnv.CODEX_HOME, 'skills', 'cowart')), await realpath(join(pluginDir, 'adapters/claude/codex-skill/cowart')), "Codex gets the release's Codex skill")
  const codexHooks = JSON.parse(await readFile(join(claudeEnv.CODEX_HOME, 'hooks.json'), 'utf8')).hooks.UserPromptSubmit.flatMap((group) => group.hooks)
  assert.deepEqual(codexHooks.map((hook) => hook.command), [`"${process.execPath}" "${commandLink}" hook prompt || exit 0`], 'Codex runs the installed command as its prompt hook')
  const opening = await runNode(commandLink, ['call', 'render_cowart_canvas_widget', '--json', '-', '--out', 'json'], JSON.stringify({ page: '冷安装共享页', sessionName: '小暖' }))
  const openedClaude = payload(JSON.parse(opening.stdout || '{}'))
  token = (await readFile(join(runtimeDir, 'token'), 'utf8')).trim()
  const started = await serviceStatus()
  assert.equal(started.build, manifest.serviceBuild, 'A bundle must advertise the source build identity')
  assert.equal(resolve(started.root), resolve(pluginDir), 'Service identity uses the installed plugin root')
  assert.equal(resolve(started.canvasDir), resolve(canvasDir), 'The cold install uses only the isolated canvas')
  assert.equal(openedClaude.pageCreated, true, 'The command made the page on the isolated canvas')
  console.log('PASS  Cold cowart command bundle starts the bundled shared service without dependencies.')

  assert.equal(openedClaude.listenCommand, `node ${commandLink.replaceAll('\\', '/')} listen`, 'Claude is told to run the installed command')
  const html = await fetch(openedClaude.url).then((response) => {
    assert.equal(response.status, 200)
    return response.text()
  })
  for (const marker of ['cowartClaudeBridge', 'cowartShared-ai-video', 'cowartShared-web-reference']) assert.ok(html.includes(marker), `Claude page includes ${marker}`)
  // Its listener keeps the session online.
  const listening = runNode(commandLink, ['listen'])
  await waitUntil(async () => (await serviceStatus()).sessions.some((session) => session.id === 'cold-claude' && session.listener), 10000)
  children.at(-1).kill()
  await listening
  assert.equal((await serviceStatus()).pid, started.pid, 'Every command must reuse one service')
  console.log('PASS  Cold Claude command bundle serves the page with all extensions, and listens.')

  // Puppeteer is bundled too: exercising a real screenshot catches dependency or
  // browser-side source serialization failures that importing the service cannot.
  fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Cowart cold install</title><h1>Offline adapter fixture</h1><p>Shared page, installed resources.</p>')
  })
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const pageId = openedClaude.heldPageId
  assert.ok(pageId, 'The shared page has an id')
  const captureResponse = await fetch(`http://127.0.0.1:${servicePort}/api/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: JSON.stringify({ name: 'capture_cowart_web_reference', arguments: { url: `http://127.0.0.1:${fixture.address().port}/`, pageId } }),
    signal: AbortSignal.timeout(60000)
  })
  assert.equal(captureResponse.status, 200)
  const capture = payload(await captureResponse.json())
  assert.equal(capture.title, 'Cowart cold install')
  assert.ok((await stat(capture.screenshot.path)).size > 100, 'The bundled browser dependency produces a real PNG')
  assert.ok(resolve(capture.screenshot.path).startsWith(`${resolve(canvasDir)}${process.platform === 'win32' ? '\\' : '/'}`))
  console.log('PASS  Bundled Puppeteer captures a local webpage with no installed npm packages.')

  assert.equal(await exists(sentinelFile), false, 'Cold startup must never invoke npm')
  assert.equal(await hasNodeModules(pluginDir), false, 'Cold startup must never create node_modules')
  console.log('OK: The cowart command and the shared service work from the dependency-free release files.')
} catch (error) {
  const serviceLog = await readFile(join(runtimeDir, 'service.log'), 'utf8').catch(() => '')
  if (serviceLog) process.stderr.write(serviceLog)
  throw error
} finally {
  for (const child of children) child.kill()
  if (servicePort) {
    token ||= (await readFile(join(runtimeDir, 'token'), 'utf8').catch(() => '')).trim()
    if (token) await fetch(`http://127.0.0.1:${servicePort}/api/service/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify({ reason: 'cold install test cleanup' }), signal: AbortSignal.timeout(5000)
    }).catch(() => {})
    await waitUntil(async () => !(await serviceStatus().catch(() => null)), 5000).catch(() => {})
  }
  if (fixture) await new Promise((done) => fixture.close(done))
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}

function payload(result) {
  assert.ok(!result.isError, result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
  return result.structuredContent ?? result
}

async function serviceStatus() {
  const response = await fetch(`http://127.0.0.1:${servicePort}/api/service`, { headers: { 'x-cowart-token': token }, signal: AbortSignal.timeout(1000) })
  assert.equal(response.status, 200)
  return response.json()
}

async function unusedPort() {
  const server = http.createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function exists(file) {
  return stat(file).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function hasNodeModules(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || await hasNodeModules(join(dir, entry.name))) return true
  }
  return false
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the isolated service to exit')
    await new Promise((done) => setTimeout(done, 100))
  }
}
