#!/usr/bin/env node
// [fork-patch] Installed Codex plugins run release artifacts without npm install.
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const adapters = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = resolve(adapters, 'generated/cowart-codex-mcp.mjs')
await access(entry).catch(() => { throw new Error('Cowart adapter artifacts are missing. Run npm --prefix adapters run build:artifacts before publishing.') })
const manifest = JSON.parse(await readFile(resolve(adapters, 'generated/release-manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(resolve(adapters, 'package.json'), 'utf8'))
if (manifest.version !== pkg.version) throw new Error('Cowart adapter artifacts are stale. Run npm --prefix adapters run build:artifacts.')
process.env.COWART_ADAPTERS_ROOT = adapters
process.env.COWART_BUNDLED = '1'
await import(pathToFileURL(entry).href)
