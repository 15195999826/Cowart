#!/usr/bin/env node
// Before 0.2.9 the service gave every page it added past 'aZ' the index 'aa' (pages sorted
// with localeCompare, which ignores case), so the page menu showed those pages in no
// particular order. This gives pages that share an index their own indexes, in the gap the
// shared index sits in, ordered by when their page directory was made. The change goes
// through the running canvas service's save, under its write lock, so open pages pick it up.
// Usage: node fix-page-order.mjs [--port 43240] [--apply]   (without --apply it only shows the plan)
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { generateNKeysBetween } from 'fractional-indexing'

import { pageDirName } from '../../mcp/lib/canvas-storage.mjs'
import { DEFAULT_PORT } from '../service/lib/identity.mjs'
import { readToken } from '../service/lib/token.mjs'
import { compareIndex, pageRecords } from '../shared/canvas-model.mjs'

const apply = process.argv.includes('--apply')
const portAt = process.argv.indexOf('--port')
const port = portAt > 0 ? Number(process.argv[portAt + 1]) : Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT
const token = await readToken()
if (!token) throw new Error('没有画布服务的令牌：这台机器上还没跑过画布服务。')

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-cowart-token': token },
    body: body ? JSON.stringify(body) : undefined
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}
async function tool(name, args) {
  const result = await api('POST', '/api/tools/call', { name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  return result.structuredContent
}
async function readCanvas() {
  const { snapshot } = await tool('get_cowart_canvas_state', { hydrateAssets: false })
  return { snapshot, pages: pageRecords(snapshot) }
}

const service = await api('GET', '/api/service').catch(() => null)
if (!service) throw new Error(`端口 ${port} 上没有画布服务：先打开一次画布。`)
console.log(`画布服务 ${service.version}（build ${service.build}，端口 ${port}），画布 ${service.canvasDir}`)

const { snapshot, pages } = await readCanvas()
const indexes = [...new Set(pages.map((page) => page.index))].sort(compareIndex)
const changed = []
for (const [at, index] of indexes.entries()) {
  const group = pages.filter((page) => page.index === index)
  if (group.length < 2) continue
  const made = new Map()
  for (const page of group) {
    const info = await stat(join(service.canvasDir, 'pages', pageDirName(page.id))).catch(() => null)
    made.set(page.id, info ? info.birthtimeMs || info.ctimeMs : Number.MAX_SAFE_INTEGER)
  }
  group.sort((a, b) => made.get(a.id) - made.get(b.id) || compareIndex(a.id, b.id))
  const keys = generateNKeysBetween(indexes[at - 1] ?? null, indexes[at + 1] ?? null, group.length)
  console.log(`\n${group.length} 页共用 index ${index}，按建页时间排：`)
  group.forEach((page, i) => {
    console.log(`  ${new Date(made.get(page.id)).toLocaleString()}  ${index} → ${keys[i]}  ${page.name}`)
    changed.push({ ...page, index: keys[i] })
  })
}

if (changed.length === 0) {
  console.log(`\n${pages.length} 页，没有共用 index 的页，不用修。`)
} else if (!apply) {
  console.log(`\n要改 ${changed.length} 页；确认后加 --apply 再跑一次。`)
} else {
  const saved = await tool('save_cowart_canvas_state', {
    snapshot: { schema: snapshot.schema, store: Object.fromEntries(changed.map((page) => [page.id, page])) },
    cowartDelta: { put: changed, remove: [] }
  })
  if (saved?.ok === false) throw new Error(`画布服务没有保存：${JSON.stringify(saved)}`)
  const after = await readCanvas()
  const distinct = new Set(after.pages.map((page) => page.index)).size
  console.log(`\n已保存：${after.pages.length} 页，${distinct} 个不同的 index。`)
  if (distinct !== after.pages.length || after.pages.length !== pages.length) process.exitCode = 1
}
