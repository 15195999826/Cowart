// Moves the pages of per-project canvases (upstream keeps a canvas under <project>/canvas)
// into the machine's one canvas. Each page directory is copied as it is (its assets' URLs
// name the page directory, so they keep working), goes after the canvas's last page and into
// its pages manifest; a page the canvas already has is skipped, and the sources stay as they
// were. Only while no service serves the canvas: a whole-canvas save from a page that never
// saw the moved pages would take them out again.
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { generateKeyBetween } from 'fractional-indexing'

import { pageDirName } from '../../../mcp/lib/canvas-storage.mjs'

const PAGE_FILE = 'cowart-canvas.json'
const MANIFEST_FILE = 'manifest.json'

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

function exists(path) {
  return stat(path).then(
    () => true,
    () => false
  )
}

// Written the way upstream writes: a temp file renamed over the old one.
async function writeJson(filePath, value) {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, filePath)
}

// A canvas's pages as upstream reads them: those its manifest lists when it has one, else
// every page directory; in page order.
async function readCanvas(canvasDir) {
  const pagesDir = join(canvasDir, 'pages')
  const manifest = await readJson(join(pagesDir, MANIFEST_FILE))
  const names = Array.isArray(manifest?.pages)
    ? manifest.pages.map((entry) => pageDirName(entry.id))
    : (await readdir(pagesDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const pages = []
  for (const name of names) {
    const snapshot = await readJson(join(pagesDir, name, PAGE_FILE))
    const page = Object.values(snapshot?.store ?? {}).find((record) => record?.typeName === 'page')
    if (page) pages.push({ name, snapshot, page })
  }
  pages.sort((x, y) => (x.page.index < y.page.index ? -1 : x.page.index > y.page.index ? 1 : 0))
  return { manifest, pages }
}

// sources: canvas directories (a project directory stands for its canvas/). Returns one entry
// per page: { source, pageId, name, assets } when moved, with `skipped` (why) when not.
export async function importCanvasPages({ sources, into }) {
  const canvasDir = resolve(into)
  const pagesDir = join(canvasDir, 'pages')
  const { manifest, pages: present } = await readCanvas(canvasDir)
  const known = new Set(present.map(({ page }) => page.id))
  let last = present.map(({ page }) => page.index).filter((index) => typeof index === 'string').sort().at(-1) ?? null
  const added = []
  const results = []

  for (const given of sources) {
    const source = resolve(given)
    const sourceDir = (await exists(join(source, 'pages'))) ? source : join(source, 'canvas')
    if (sourceDir === canvasDir) {
      results.push({ source, skipped: '这就是那张画布' })
      continue
    }
    const { pages } = await readCanvas(sourceDir)
    if (pages.length === 0) {
      results.push({ source, skipped: '没找到页（不是 Cowart 画布或项目目录？）' })
      continue
    }
    for (const { name, snapshot, page } of pages) {
      const skip = (why) => results.push({ source, pageId: page.id, name: page.name, skipped: why })
      if (name !== pageDirName(page.id)) {
        skip(`页目录 ${name} 跟页 id 对不上`)
        continue
      }
      const destination = join(pagesDir, name)
      if (known.has(page.id) || (await exists(destination))) {
        skip('画布里已经有这一页')
        continue
      }
      await mkdir(pagesDir, { recursive: true })
      await cp(join(sourceDir, 'pages', name), destination, { recursive: true, errorOnExist: true, force: false })
      last = generateKeyBetween(last, null)
      const moved = { ...page, index: last }
      await writeJson(join(destination, PAGE_FILE), { ...snapshot, store: { ...snapshot.store, [page.id]: moved } })
      known.add(page.id)
      added.push(moved)
      results.push({ source, pageId: page.id, name: page.name, assets: (await readdir(join(destination, 'assets')).catch(() => [])).length })
    }
  }

  // Upstream reads only the pages its manifest lists; a canvas without one gets every directory.
  if (manifest && added.length > 0) {
    const entries = added.map((page) => ({ id: page.id, name: page.name, index: page.index, path: relative(canvasDir, join(pagesDir, pageDirName(page.id), PAGE_FILE)) }))
    await writeJson(join(pagesDir, MANIFEST_FILE), { ...manifest, pages: [...manifest.pages, ...entries] })
  }
  return results
}
