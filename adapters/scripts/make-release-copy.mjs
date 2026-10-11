#!/usr/bin/env node
// Makes a local release copy for Codex to run (FORK.md, Codex 任务切换与恢复):
// ~/.cowart/releases/<adapters version>-<short commit>, taken from a commit's git objects rather
// than the working tree, so uncommitted or in-progress changes never reach it. It holds the
// resources and artifacts of adapters/generated/release-manifest.json, the manifest, the Codex
// start script and release-origin.json; every file is checked against the manifest's sha256
// before and after it is written. An existing copy is never touched.
//
//   node adapters/scripts/make-release-copy.mjs [<commit>]     (default HEAD)
//
// Then verify-release.mjs the copy and switch-codex-entry.mjs to it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RELEASES_DIR = join(homedir(), '.cowart', 'releases')
const [commit = 'HEAD'] = process.argv.slice(2)

const git = (args, options) => execFileSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 256 * 1024 * 1024, ...options })
const full = git(['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim()
const show = (path) => git(['cat-file', 'blob', `${full}:${path}`])
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const manifest = JSON.parse(show('adapters/generated/release-manifest.json'))
const pkg = JSON.parse(show('adapters/package.json'))
if (pkg.version !== manifest.version) throw new Error(`adapters/package.json ${pkg.version} != release manifest ${manifest.version} in ${full.slice(0, 7)}`)
const expected = {
  ...manifest.resources,
  ...Object.fromEntries(Object.entries(manifest.artifacts).map(([name, hash]) => [`adapters/generated/${name}`, hash]))
}
const extra = ['adapters/generated/release-manifest.json', 'adapters/codex/bin/start.mjs']
const target = join(RELEASES_DIR, `${manifest.version}-${full.slice(0, 7)}`)
if (existsSync(target)) throw new Error(`${target} already exists`)

// Written beside the target and renamed into place, so a failed run leaves no half copy.
const staging = `${target}.staging`
rmSync(staging, { recursive: true, force: true })
for (const file of [...Object.keys(expected), ...extra]) {
  const data = show(file)
  if (expected[file] && sha(data) !== expected[file]) throw new Error(`${file}: hash differs from the release manifest in ${full.slice(0, 7)}`)
  mkdirSync(dirname(join(staging, file)), { recursive: true })
  writeFileSync(join(staging, file), data)
  if (sha(readFileSync(join(staging, file))) !== sha(data)) throw new Error(`${file}: the written copy differs`)
}
writeFileSync(join(staging, 'release-origin.json'), `${JSON.stringify({ commit: full, version: manifest.version, build: manifest.serviceBuild }, null, 2)}\n`)
renameSync(staging, target)
console.log(`${target}: ${Object.keys(expected).length + extra.length + 1} files, adapters ${manifest.version}, build ${manifest.serviceBuild}`)
