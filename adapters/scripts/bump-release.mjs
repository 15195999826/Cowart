#!/usr/bin/env node
// Bumps the adapters version for a release (FORK.md, 分支与同步), so the release's service
// outranks the ones already running (identity.mjs: of two checkouts the bigger version stays).
// The version string is counted where it should be, and nothing is written unless all match.
// Files keep their bytes apart from the version strings: line endings stay as git has them (LF).
// Rebuild the adapters' artifacts after.
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
const ADAPTERS_FILES = [['adapters/package.json', 1], ['adapters/package-lock.json', 2]]

const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8')
const versionOf = (file) => read(file).match(/"version": "([^"]+)"/)[1]
const parts = (version) => version.split('+')[0].split('-')[0].split('.').map(Number)

const adapters = versionOf('adapters/package.json')
const [major, minor, patch] = parts(adapters)
const nextAdapters = wanted ?? `${major}.${minor}.${patch + 1}`
if (!/^\d+\.\d+\.\d+$/.test(nextAdapters)) throw new Error(`adapters version ${nextAdapters} is not x.y.z`)
// The service with the bigger version stays when two checkouts meet (identity.mjs).
const newer = parts(nextAdapters).map((n, i) => n - parts(adapters)[i]).find((d) => d !== 0) > 0
if (!newer) throw new Error(`adapters ${nextAdapters} is not newer than ${adapters}`)

// A CRLF checkout would build artifacts that differ from upstream and commit every line (FORK.md).
const eol = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--eol', '--', ...ADAPTERS_FILES.map(([file]) => file)], { encoding: 'utf8' })
for (const line of eol.trim().split('\n')) {
  const [, index, tree, file] = line.match(/^i\/(\S*)\s+w\/(\S*)\s.*\t(.+)$/)
  if (index !== tree) throw new Error(`${file}: line endings are ${tree} here but ${index} in git; check out with core.eol=lf first`)
}

const writes = []
for (const [file, count] of ADAPTERS_FILES) {
  const text = read(file)
  const pieces = text.split(`"version": "${adapters}"`)
  if (pieces.length - 1 !== count) throw new Error(`${file}: ${pieces.length - 1} × "version": "${adapters}", expected ${count}`)
  writes.push([file, pieces.join(`"version": "${nextAdapters}"`), count])
}

for (const [file, text, count] of writes) {
  if (!DRY_RUN) writeFileSync(join(REPO_ROOT, file), text)
  console.log(`${DRY_RUN ? 'would change' : 'changed'} ${file} (${count})`)
}
console.log(`adapters ${adapters} → ${nextAdapters}${DRY_RUN ? ' (dry run, nothing written)' : ''}`)
if (!DRY_RUN) console.log('next: npm --prefix adapters run build:artifacts, then the checks in FORK.md')
