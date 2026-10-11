#!/usr/bin/env node
// Points Codex's cowart_mcp entry at another local release copy (FORK.md, Codex 任务切换与恢复).
// $CODEX_HOME/config.toml (default ~/.codex) must name exactly one
// releases\<copy>\adapters\codex\bin\start.mjs; the file is backed up beside itself and only that
// copy's folder name changes, every other byte stays. Codex picks the new entry up when restarted.
//
//   node adapters/scripts/switch-codex-entry.mjs <copy> [--dry-run]
//
// <copy> is a folder in ~/.cowart/releases (0.2.13-e888f18), made by make-release-copy.mjs.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')
const [copyArg] = process.argv.slice(2).filter((arg) => arg !== '--dry-run')
if (!copyArg) throw new Error('usage: switch-codex-entry.mjs <copy> [--dry-run]')
const to = basename(copyArg)
const start = join(homedir(), '.cowart', 'releases', to, 'adapters', 'codex', 'bin', 'start.mjs')
if (!existsSync(start)) throw new Error(`${start} does not exist; make the copy first`)

const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
const text = readFileSync(file, 'utf8')
const entries = [...text.matchAll(/releases([\\/]+)([^\\/'"]+)([\\/]+)adapters[\\/]+codex[\\/]+bin[\\/]+start\.mjs/g)]
if (entries.length !== 1) throw new Error(`${file}: ${entries.length} release copy entries, expected 1`)
const [found, sep, from, sep2] = entries[0]
if (from === to) {
  console.log(`${file} already starts ${to}`)
  process.exit(0)
}
const replacement = found.replace(`releases${sep}${from}${sep2}`, `releases${sep}${to}${sep2}`)
const next = text.slice(0, entries[0].index) + replacement + text.slice(entries[0].index + found.length)
if (DRY_RUN) {
  console.log(`would change ${file}: ${from} → ${to} (dry run, nothing written)`)
} else {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${file}.backup-${stamp}`
  copyFileSync(file, backup)
  writeFileSync(file, next)
  console.log(`backup ${backup}; ${file}: ${from} → ${to}; restart Codex, then check codex mcp get cowart_mcp`)
}
