#!/usr/bin/env node
// Bumps the two versions a Codex plugin release needs (FORK.md, 分支与同步):
// - the plugin version gets a new +codex.<UTC YYYYMMDDHHMMSS> suffix, so an installed Codex does
//   not reuse its .codex/plugins/cache/<marketplace>/cowart/<plugin version> copy;
// - the adapters version goes up, so the release's service outranks the ones already running.
// Each version string is counted where it should be, and nothing is written unless all match.
// Files keep their bytes apart from the version strings: line endings stay as git has them
// (LF; upstream committed .codex-plugin/plugin.json with CRLF). Rebuild both artifact sets after.
//
//   node adapters/scripts/bump-release.mjs [<adapters version>] [--dry-run]
//
// Without a version the adapters patch number goes up by one.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRY_RUN = process.argv.includes('--dry-run')
const [wanted] = process.argv.slice(2).filter((arg) => arg !== '--dry-run')
const PLUGIN_FILES = [['.codex-plugin/plugin.json', 1], ['plugin.json', 1], ['package.json', 1], ['package-lock.json', 2]]
const ADAPTERS_FILES = [['adapters/package.json', 1], ['adapters/package-lock.json', 2]]

const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8')
const versionOf = (file) => read(file).match(/"version": "([^"]+)"/)[1]
const parts = (version) => version.split('+')[0].split('-')[0].split('.').map(Number)

const plugin = versionOf('.codex-plugin/plugin.json')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const nextPlugin = `${plugin.split('+')[0]}+codex.${stamp}`
const adapters = versionOf('adapters/package.json')
const [major, minor, patch] = parts(adapters)
const nextAdapters = wanted ?? `${major}.${minor}.${patch + 1}`
if (!/^\d+\.\d+\.\d+$/.test(nextAdapters)) throw new Error(`adapters version ${nextAdapters} is not x.y.z`)
// The service with the bigger version stays when two checkouts meet (identity.mjs).
const newer = parts(nextAdapters).map((n, i) => n - parts(adapters)[i]).find((d) => d !== 0) > 0
if (!newer) throw new Error(`adapters ${nextAdapters} is not newer than ${adapters}`)
if (nextPlugin === plugin) throw new Error(`plugin version is already ${plugin}`)

// A CRLF checkout would build artifacts that differ from upstream and commit every line (FORK.md).
const eol = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--eol', '--', ...[...PLUGIN_FILES, ...ADAPTERS_FILES].map(([file]) => file)], { encoding: 'utf8' })
for (const line of eol.trim().split('\n')) {
  const [, index, tree, file] = line.match(/^i\/(\S*)\s+w\/(\S*)\s.*\t(.+)$/)
  if (index !== tree) throw new Error(`${file}: line endings are ${tree} here but ${index} in git; check out with core.eol=lf first`)
}

const writes = []
function plan(files, from, to) {
  for (const [file, count] of files) {
    const text = read(file)
    const pieces = text.split(`"version": "${from}"`)
    if (pieces.length - 1 !== count) throw new Error(`${file}: ${pieces.length - 1} × "version": "${from}", expected ${count}`)
    writes.push([file, pieces.join(`"version": "${to}"`), count])
  }
}
plan(PLUGIN_FILES, plugin, nextPlugin)
plan(ADAPTERS_FILES, adapters, nextAdapters)

for (const [file, text, count] of writes) {
  if (!DRY_RUN) writeFileSync(join(REPO_ROOT, file), text)
  console.log(`${DRY_RUN ? 'would change' : 'changed'} ${file} (${count})`)
}
console.log(`plugin ${plugin} → ${nextPlugin}; adapters ${adapters} → ${nextAdapters}${DRY_RUN ? ' (dry run, nothing written)' : ''}`)
// The adapters manifest hashes mcp/generated, which carries the plugin version: root first.
if (!DRY_RUN) console.log('next: npm run build:artifacts, then npm --prefix adapters run build:artifacts, then the checks in FORK.md')
