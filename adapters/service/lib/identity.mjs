// What a canvas service is made of. There is one service per machine (FORK.md); a bridge
// compares the running service with its own code before reusing it.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { ADAPTERS_DIR, REPO_ROOT, UPSTREAM_RELEASE_MANIFEST } from '../../shared/paths.mjs'

export const SERVICE_NAME = 'cowart-canvas'
// Where bridges look first (COWART_CLAUDE_PORT overrides it); taken ports are skipped.
export const DEFAULT_PORT = 43240
// Bump when the API between bridges, pages and the service changes incompatibly.
// 2: page responsibility (分页负责制) and delta saves replaced per-pane editing locks.
export const PROTOCOL = 2
export const VERSION = JSON.parse(readFileSync(join(ADAPTERS_DIR, 'package.json'), 'utf8')).version

// Code the service process runs. Page scripts are read on every page load and bridges
// restart with their session, so neither needs a new service.
const MODULE_DIRS = [join(ADAPTERS_DIR, 'service', 'lib'), join(ADAPTERS_DIR, 'service', 'bin'), join(ADAPTERS_DIR, 'shared')]
const BUILD_FILES = [
  join(ADAPTERS_DIR, 'package.json'),
  join(ADAPTERS_DIR, 'package-lock.json'),
  join(REPO_ROOT, 'mcp', 'lib', 'canvas-storage.mjs'),
  join(ADAPTERS_DIR, 'shared', 'empty-canvas.json'),
  UPSTREAM_RELEASE_MANIFEST
]

function moduleFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

export function codeFingerprint() {
  const hash = createHash('sha256')
  for (const file of [...MODULE_DIRS.flatMap(moduleFiles), ...BUILD_FILES].sort()) {
    hash.update(relative(REPO_ROOT, file).replaceAll('\\', '/'))
    hash.update('\0')
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  // Lets tests stand in for "the code changed" without touching files.
  hash.update(process.env.COWART_SERVICE_BUILD_SALT ?? '')
  return hash.digest('hex').slice(0, 16)
}

export function localIdentity() {
  return { service: SERVICE_NAME, protocol: PROTOCOL, version: VERSION, build: codeFingerprint(), root: REPO_ROOT }
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0)
    if (diff) return Math.sign(diff)
  }
  return 0
}

function sameRoot(a, b) {
  if (!a || !b) return false
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(a) === normalize(b)
}

// reuse: keep the running service. replace: stop it and start this code. incompatible: the
// running service is newer and speaks another protocol, so this bridge cannot use it.
export function serviceVerdict(running, mine) {
  if (running.protocol === mine.protocol && running.build === mine.build) return 'reuse'
  // Same checkout, different code: the files on disk changed since the service started.
  if (sameRoot(running.root, mine.root)) return 'replace'
  // Another checkout (say Codex's plugin cache): the newer version wins and a tie keeps
  // the running one, so two checkouts never take turns restarting it.
  const order = compareVersions(mine.version, running.version) || Math.sign(mine.protocol - running.protocol)
  if (order > 0) return 'replace'
  return running.protocol === mine.protocol ? 'reuse' : 'incompatible'
}
