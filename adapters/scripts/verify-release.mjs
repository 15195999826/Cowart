#!/usr/bin/env node
// Checks a release from disk the way Codex will run it: a local release copy
// (make-release-copy.mjs) or an installed Codex plugin cache
// (~/.codex/plugins/cache/<marketplace>/cowart/<plugin version>). It reports the plugin and
// adapters versions and the build, checks every file of the release manifest against its
// sha256 (and the cache's .mcp.json entry), then starts the release's Codex bridge on a random
// port in 43600–43699 with its own token directory and canvas, and makes sure the service it
// starts runs this release. The machine's service (43240, ~/.cowart/canvas) is never touched.
//
//   node adapters/scripts/verify-release.mjs <dir> [--like <previous copy>] [--port <n>]
//
// --like also requires the same file layout as an earlier release copy.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args.splice(at, 2)[1]
}
const like = option('--like')
const port = Number(option('--port') ?? 43600 + Math.floor(Math.random() * 100))
const [dirArg] = args
if (!dirArg) throw new Error('usage: verify-release.mjs <dir> [--like <previous copy>] [--port <n>]')
const dir = resolve(dirArg)

const root = await mkdtemp(join(tmpdir(), 'cowart-release-verify-'))
// Set before the test kit loads: its token module reads the runtime directory once.
process.env.COWART_RUNTIME_DIR = join(root, 'runtime')
const kit = await import(pathToFileURL(join(ADAPTERS_DIR, 'claude', 'scripts', 'test-kit.mjs')).href)

const json = async (file) => JSON.parse(await readFile(join(dir, file), 'utf8'))
const samePath = (a, b) => relative(resolve(a), resolve(b)) === ''
async function files(top) {
  const out = []
  for (const entry of await readdir(top, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(top, join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
  }
  return out.sort()
}

try {
  const manifest = await json('adapters/generated/release-manifest.json')
  const plugin = await json('.codex-plugin/plugin.json')
  const adapters = await json('adapters/package.json')
  const origin = existsSync(join(dir, 'release-origin.json')) ? await json('release-origin.json') : null
  console.log(`plugin ${plugin.version}; adapters ${adapters.version}; manifest ${manifest.version} build ${manifest.serviceBuild}${origin ? `; commit ${origin.commit.slice(0, 7)}` : ''}`)
  if (adapters.version !== manifest.version) throw new Error('adapters/package.json and the release manifest disagree')
  if (existsSync(join(dir, '.mcp.json'))) {
    const entry = (await json('.mcp.json')).mcpServers?.cowart_mcp
    console.log(`.mcp.json cowart_mcp: ${entry?.command} ${entry?.args?.join(' ')}`)
    if (!entry?.args?.includes('./adapters/codex/bin/start.mjs')) throw new Error('.mcp.json does not start adapters/codex/bin/start.mjs')
  }

  const expected = {
    ...manifest.resources,
    ...Object.fromEntries(Object.entries(manifest.artifacts).map(([name, hash]) => [`adapters/generated/${name}`, hash]))
  }
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash('sha256').update(await readFile(join(dir, file))).digest('hex') !== hash) throw new Error(`${file}: hash mismatch`)
  }
  console.log(`${Object.keys(expected).length} manifest files match`)
  if (like) {
    const mine = await files(dir)
    const theirs = await files(like)
    if (mine.join('\n') !== theirs.join('\n')) throw new Error(`layout differs from ${like}:\n${mine.join('\n')}\n--\n${theirs.join('\n')}`)
    console.log(`${mine.length} files, same layout as ${like}`)
  }

  const project = join(root, 'project')
  await mkdir(join(project, 'canvas', 'pages', 'page'), { recursive: true })
  await copyFile(kit.EMPTY_CANVAS, join(project, 'canvas', 'pages', 'page', 'cowart-canvas.json'))
  let bridge
  try {
    await kit.stopTestService(port)
    bridge = await kit.startBridge({
      cwd: project,
      port,
      session: 'release-verify',
      env: { COWART_DOMAIN_PORT: '0', COWART_PROMPT_WRITER: 'off' },
      entry: join(dir, 'adapters', 'codex', 'bin', 'start.mjs')
    })
    const tools = (await bridge.client.listTools()).tools
    const status = await kit.waitFor(() => kit.serviceStatus(port), { timeoutMs: 15000, what: 'the service' })
    console.log(`port ${port}: ${tools.length} tools; service ${status.version} build ${status.build}; root ${status.root}; canvas ${status.canvasDir}`)
    if (status.version !== manifest.version || status.build !== manifest.serviceBuild) throw new Error('the service does not run this release')
    if (!samePath(status.root, dir)) throw new Error(`the service runs from ${status.root}, not ${dir}`)
  } finally {
    await bridge?.close()
    await kit.stopTestService(port)
  }
  console.log('OK')
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
