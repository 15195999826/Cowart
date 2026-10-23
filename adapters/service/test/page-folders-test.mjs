#!/usr/bin/env node
// Page folders end to end (service/lib/page-folders.mjs): every host lists move_cowart_pages
// and opens a page into a folder; a Claude session sorts pages with `cowart folder` (pages
// another session is responsible for too), lists them as a tree with `cowart pages`, moves a
// whole folder, and takes one back to the top level. The folder is meta.cowartFolder on the
// stored page record; nothing on the pages changes. The service remembers when each page last
// changed (page-activity.mjs), for the page menu's 最近改过 order.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMPTY_CANVAS, ZCODE_BRIDGE, cliSession, finish, startBridge, step, stopTestService, text } from '../../claude/scripts/test-kit.mjs'
import { PAGE_ACTIVITY_FILE_NAME } from '../lib/page-activity.mjs'
import { normalizeFolder, pageTreeLines, planPageMoves } from '../lib/page-folders.mjs'
import { loadOrCreateToken } from '../lib/token.mjs'

const PORT = Number(process.env.COWART_FOLDERS_TEST_PORT) || 43389

const projectDir = await mkdtemp(join(tmpdir(), 'cowart-folders-'))
const canvasDir = join(projectDir, 'canvas')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

await stopTestService(PORT)
const claude = cliSession({ cwd: projectDir, port: PORT, session: 'folders-claude' })
const zcode = await startBridge({ cwd: projectDir, port: PORT, session: 'folders-zcode', entry: ZCODE_BRIDGE })
const codex = cliSession({ cwd: projectDir, port: PORT, session: 'folders-codex', env: { COWART_HOST: 'codex' } })

function ok(result) {
  assert.ok(!result.isError, text(result))
  return result
}
async function command(...argv) {
  const { code, stdout, stderr } = await claude.run(argv)
  return { code, out: stdout + stderr }
}
// The stored page records by name: { name: { id, folder, file } }.
async function storedPages() {
  const manifest = JSON.parse(await readFile(join(canvasDir, 'pages', 'manifest.json'), 'utf8'))
  const pages = {}
  for (const entry of manifest.pages) {
    const stored = JSON.parse(await readFile(join(canvasDir, entry.path), 'utf8'))
    pages[entry.name] = { id: entry.id, folder: stored.store[entry.id].meta?.cowartFolder ?? null, shapes: Object.values(stored.store).filter((record) => record.typeName === 'shape').length }
  }
  return pages
}

try {
  await step('folder paths are normalized, and the tree lists folders before pages', async () => {
    assert.equal(normalizeFolder(' 数码宝贝 / 参考/ '), '数码宝贝/参考')
    assert.equal(normalizeFolder('/'), '')
    assert.equal(normalizeFolder(undefined), '')
    assert.throws(() => normalizeFolder(3), /文字/)
    const pages = [
      { id: 'page:a', name: 'A', index: 'a1', meta: {} },
      { id: 'page:b', name: 'B', index: 'a2', meta: { cowartFolder: 'x/y' } },
      { id: 'page:c', name: 'C', index: 'a3', meta: { cowartFolder: 'x' } }
    ]
    assert.deepEqual(pageTreeLines(pages, (page) => page.name), ['x/（2 页）', '  y/（1 页）', '    - B', '  - C', '- A'])
    const plan = planPageMoves(pages, { fromFolder: 'x', folder: 'z' })
    assert.deepEqual(plan.moves.map((move) => [move.name, move.to]), [['B', 'z/y'], ['C', 'z']])
    assert.throws(() => planPageMoves(pages, { folder: 'x' }), /pages|fromFolder/)
    assert.throws(() => planPageMoves(pages, { pages: ['A'], fromFolder: 'x', folder: 'z' }), /只给一个/)
    assert.throws(() => planPageMoves(pages, { pages: ['A'] }), /folder/)
    assert.throws(() => planPageMoves([...pages, { id: 'page:d', name: 'A', index: 'a4', meta: {} }], { pages: ['A'], folder: 'q' }), /有 2 个/)
  })

  await step('every host lists move_cowart_pages and opens a page into a folder', async () => {
    for (const [host, bridge] of [['Claude Code', claude], ['ZCode', zcode], ['Codex', codex]]) {
      const tools = new Map((await bridge.listTools()).tools.map((tool) => [tool.name, tool]))
      assert.ok(tools.has('move_cowart_pages'), `${host} does not list move_cowart_pages`)
      assert.ok(tools.get('render_cowart_canvas_widget').inputSchema.properties.folder, `${host} cannot open a page into a folder`)
    }
  })

  await step('cowart take --folder makes the page in that folder', async () => {
    const { code, out } = await command('take', '角色 A', '--folder', ' 数码宝贝 / 参考/ ')
    assert.equal(code, 0, out)
    assert.match(out, /你现在负责「角色 A」这一页（新建的）（在文件夹「数码宝贝\/参考」里）/)
    assert.equal((await storedPages())['角色 A'].folder, '数码宝贝/参考')
  })

  await step('a page another session is responsible for goes into a folder too, its content untouched', async () => {
    ok(await zcode.call('render_cowart_canvas_widget', { page: '场景 B', sessionName: '小禾' }))
    ok(await zcode.call('insert_cowart_text', { items: [{ text: '场景 B 的说明', x: 0, y: 0 }] }))
    const before = (await storedPages())['场景 B']
    assert.equal(before.folder, null)
    const { code, out } = await command('folder', '数码宝贝', '场景 B', '角色 A')
    assert.equal(code, 0, out)
    assert.match(out, /2 页放进了「数码宝贝」/)
    assert.match(out, /「角色 A」（原来在「数码宝贝\/参考」）/)
    const after = await storedPages()
    assert.equal(after['场景 B'].folder, '数码宝贝')
    assert.equal(after['场景 B'].shapes, before.shapes)
    assert.match(text(await zcode.call('get_cowart_canvas_state', {})), /页面「场景 B」\(page:\S+\)：1 个图形，在文件夹「数码宝贝」里/)
    const again = await command('folder', '数码宝贝', '场景 B')
    assert.match(again.out, /本来就在「数码宝贝」的：「场景 B」/)
  })

  await step('cowart pages lists the pages under their folders', async () => {
    ok(await codex.call('render_cowart_canvas_widget', { page: '角色 C', folder: '数码宝贝/参考' }))
    const { code, out } = await command('pages')
    assert.equal(code, 0, out)
    const lines = out.split('\n')
    const at = (pattern) => lines.findIndex((line) => pattern.test(line))
    assert.ok(at(/^数码宝贝\/（3 页）$/) >= 0, out)
    assert.ok(at(/^ {2}参考\/（1 页）$/) > at(/^数码宝贝\//), out)
    assert.ok(at(/^ {4}- 「角色 C」/) > at(/^ {2}参考\//), out)
    assert.ok(at(/^ {2}- 「场景 B」.*小禾负责/) > at(/^ {4}- 「角色 C」/), out)
    assert.ok(at(/^- 「Page 1」/) > at(/^ {2}- 「角色 A」/), out)

    const one = await command('pages', '数码宝贝/参考')
    assert.equal(one.code, 0, one.out)
    assert.match(one.out, /文件夹「数码宝贝\/参考」里有 1 页（整张画布 4 页）/)
    assert.match(one.out, /「角色 C」/)
    assert.doesNotMatch(one.out, /场景 B|Page 1/)
    const none = await command('pages', '没有这个')
    assert.equal(none.code, 2)
    assert.match(none.out, /没有叫「没有这个」的文件夹（顶层的文件夹：数码宝贝）/)
  })

  await step('a whole folder moves with --from, subfolders and all', async () => {
    const moved = ok(await codex.call('move_cowart_pages', { fromFolder: '数码宝贝', folder: '项目/数码宝贝' }))
    assert.match(text(moved), /文件夹「数码宝贝」挪到了「项目\/数码宝贝」，3 页跟着走/)
    const pages = await storedPages()
    assert.equal(pages['角色 C'].folder, '项目/数码宝贝/参考')
    assert.equal(pages['场景 B'].folder, '项目/数码宝贝')
    const missing = await command('folder', '别处', '--from', '数码宝贝')
    assert.equal(missing.code, 1)
    assert.match(missing.out, /没有叫「数码宝贝」的文件夹（现有：项目\/数码宝贝、项目\/数码宝贝\/参考）/)
  })

  await step('/ takes a page back to the top level; an unknown page writes nothing', async () => {
    const back = await command('folder', '/', '角色 A')
    assert.equal(back.code, 0, back.out)
    assert.match(back.out, /1 页放进了顶层/)
    assert.equal((await storedPages())['角色 A'].folder, null)
    const before = await storedPages()
    const unknown = await command('folder', '别处', '角色 A', '没有这页')
    assert.equal(unknown.code, 1)
    assert.match(unknown.out, /画布上没有叫「没有这页」的页/)
    assert.deepEqual(await storedPages(), before)
    const usage = await command('folder')
    assert.equal(usage.code, 2)
    assert.match(usage.out, /folder <文件夹> <页名>…/)
  })

  await step('opening a page that is there with a folder moves it', async () => {
    const { code, out } = await command('take', '场景 B', '--folder', '其它')
    assert.equal(code, 0, out)
    assert.match(out, /你现在负责「场景 B」这一页，放进了文件夹「其它」，从「小禾」那里接了过来/)
    assert.equal((await storedPages())['场景 B'].folder, '其它')
  })

  await step('a new page at the top level comes with the folders there are to sort it into', async () => {
    const { code, out } = await command('take', '角色 D')
    assert.equal(code, 0, out)
    assert.match(out, /新页在页菜单的顶层。画布上的文件夹：其它、项目、项目\/数码宝贝、项目\/数码宝贝\/参考。.*folder <文件夹> "角色 D"/)
    const into = await command('take', '角色 E', '--folder', '其它')
    assert.doesNotMatch(into.out, /新页在页菜单的顶层/)
  })

  await step('pages remember when they last changed: model writes, page saves and new pages count, folders do not', async () => {
    const token = await loadOrCreateToken()
    // The service writes the times down a couple of seconds after a change.
    async function changedAt(until) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const pages = JSON.parse(await readFile(join(canvasDir, PAGE_ACTIVITY_FILE_NAME), 'utf8')).pages
          if (until(pages)) return pages
        } catch {
          // Not written yet.
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
      }
      throw new Error('the page times never got there')
    }
    const ids = Object.fromEntries(Object.entries(await storedPages()).map(([name, page]) => [name, page.id]))
    // 小禾 put a text on 场景 B (a model write); 角色 D was made by take.
    const first = await changedAt((pages) => pages[ids['场景 B']] && pages[ids['角色 D']])

    ok(await codex.call('move_cowart_pages', { pages: ['场景 B'], folder: '别处' }))
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500))
    assert.equal((await changedAt(() => true))[ids['场景 B']], first[ids['场景 B']], 'a folder move counted as a change')

    // A canvas page moving that text: its save carries the change as a delta.
    const snapshot = ok(await claude.call('get_cowart_canvas_state', { includeSnapshot: true })).structuredContent.snapshot
    const label = Object.values(snapshot.store).find((record) => record.typeName === 'shape' && record.parentId === ids['场景 B'])
    const moved = { ...label, x: label.x + 40 }
    const saved = await fetch(`http://127.0.0.1:${PORT}/api/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify({
        name: 'save_cowart_canvas_state',
        arguments: { projectDir, canvasDir, snapshot: { ...snapshot, store: { ...snapshot.store, [moved.id]: moved } }, cowartDelta: { put: [moved], remove: [] } }
      })
    }).then((response) => response.json())
    assert.ok(!saved.isError, JSON.stringify(saved))
    const after = await changedAt((pages) => pages[ids['场景 B']] > first[ids['场景 B']])
    assert.equal(after[ids['角色 C']], first[ids['角色 C']], 'a page the save did not touch counted')
  })
} finally {
  await Promise.all([claude.close(), zcode.close(), codex.close()])
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}
finish()
