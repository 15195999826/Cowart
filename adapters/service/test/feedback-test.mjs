#!/usr/bin/env node
// send_cowart_feedback end to end: a Claude Code, a ZCode and a Codex session bridge share one
// test service and each records feedback into a throwaway inbox; then the inbox command
// (service/bin/cowart-feedback.mjs) lists, shows and closes the items.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { INSTRUCTIONS as CLAUDE_INSTRUCTIONS } from '../../claude/lib/bridge.mjs'
import { EMPTY_CANVAS, finish, startBridge, step, stopTestService, text, writePng } from '../../claude/scripts/test-kit.mjs'
import { INSTRUCTIONS as CODEX_INSTRUCTIONS } from '../../codex/lib/bridge.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { INSTRUCTIONS as ZCODE_INSTRUCTIONS } from '../../zcode/lib/bridge.mjs'

const PORT = Number(process.env.COWART_FEEDBACK_TEST_PORT) || 43294
const INBOX = join(ADAPTERS_DIR, 'service', 'bin', 'cowart-feedback.mjs')
const run = promisify(execFile)

const projectDir = await mkdtemp(join(tmpdir(), 'cowart-feedback-'))
const canvasDir = join(projectDir, 'canvas')
// The service the check starts writes feedback here, never into the machine's inbox.
const feedbackDir = join(projectDir, 'feedback')
await mkdir(join(canvasDir, 'pages', 'page'), { recursive: true })
await copyFile(EMPTY_CANVAS, join(canvasDir, 'pages', 'page', 'cowart-canvas.json'))

const env = { COWART_FEEDBACK_DIR: feedbackDir }
const inbox = async (...args) => (await run(process.execPath, [INBOX, ...args], { env: { ...process.env, ...env } })).stdout
async function itemDir(id) {
  const name = (await readdir(feedbackDir)).find((entry) => entry.startsWith(`${String(id).padStart(4, '0')}-`))
  assert.ok(name, `no folder for feedback #${id}`)
  return join(feedbackDir, name)
}
const record = async (id) => JSON.parse(await readFile(join(await itemDir(id), 'feedback.json'), 'utf8'))

await stopTestService(PORT)
const claude = await startBridge({ cwd: projectDir, port: PORT, session: 'fb-claude', env })
const zcode = await startBridge({ cwd: projectDir, port: PORT, session: 'fb-zcode', env, entry: join(ADAPTERS_DIR, 'zcode', 'bin', 'cowart-zcode-mcp.mjs') })
const codex = await startBridge({ cwd: projectDir, port: PORT, session: 'fb-codex', env, entry: join(ADAPTERS_DIR, 'codex', 'bin', 'cowart-codex-mcp.mjs') })

try {
  await step('every host lists send_cowart_feedback, and its instructions say when to use it', async () => {
    for (const [host, bridge, instructions] of [
      ['Claude Code', claude, CLAUDE_INSTRUCTIONS],
      ['ZCode', zcode, ZCODE_INSTRUCTIONS],
      ['Codex', codex, CODEX_INSTRUCTIONS]
    ]) {
      const tool = (await bridge.client.listTools()).tools.find((entry) => entry.name === 'send_cowart_feedback')
      assert.ok(tool, `the ${host} bridge does not list send_cowart_feedback`)
      assert.deepEqual(tool.inputSchema.required, ['text'])
      assert.match(instructions, /send_cowart_feedback/, `the ${host} instructions do not mention send_cowart_feedback`)
    }
  })

  await step('a Claude Code session records feedback with the situation around it', async () => {
    const opened = await claude.call('render_cowart_canvas_widget', { sessionName: '小反', page: '反馈页' })
    assert.ok(!opened.isError, text(opened))
    const shot = await writePng(join(projectDir, 'shot.png'), 8, 6)
    const result = await claude.call('send_cowart_feedback', {
      text: 'AI 视频框拖不动，很烦',
      title: 'AI 视频框拖不动',
      kind: 'friction',
      details: '在「反馈页」上拖 AI 视频框，框不跟手。',
      shapeIds: ['shape:holder1'],
      attachments: [shot, join(projectDir, 'missing.png')]
    })
    assert.ok(!result.isError, text(result))
    assert.match(text(result), /已记下反馈 #1「AI 视频框拖不动」/)
    assert.match(text(result), /missing\.png/)
    const item = await record(1)
    assert.equal(item.status, 'open')
    assert.equal(item.kind, 'friction')
    assert.equal(item.text, 'AI 视频框拖不动，很烦')
    assert.equal(item.source.host, 'claude')
    assert.equal(item.source.sessionName, '小反')
    assert.equal(basename(item.source.project ?? ''), basename(projectDir))
    assert.equal(item.canvas.heldPage?.name, '反馈页')
    assert.equal(item.canvas.page?.name, '反馈页')
    assert.deepEqual(item.canvas.shapeIds, ['shape:holder1'])
    assert.ok(item.code.version && item.code.build && /^[0-9a-f]{7,}$/.test(item.code.commit ?? ''), JSON.stringify(item.code))
    assert.deepEqual(item.attachments.map((file) => file.file), ['shot.png'])
    const dir = await itemDir(1)
    const files = await readdir(dir)
    for (const name of ['feedback.json', 'feedback.md', 'shot.png', 'canvas.txt', 'service-log.txt']) assert.ok(files.includes(name), `missing ${name}: ${files}`)
    assert.match(await readFile(join(dir, 'feedback.md'), 'utf8'), /^> AI 视频框拖不动，很烦$/m)
    assert.match(await readFile(join(dir, 'canvas.txt'), 'utf8'), /反馈页/)
  })

  await step('ZCode and Codex sessions record feedback too, numbered after it', async () => {
    const fromZCode = await zcode.call('send_cowart_feedback', { text: 'ZCode 里监听老断', kind: 'bug' })
    assert.ok(!fromZCode.isError, text(fromZCode))
    assert.match(text(fromZCode), /反馈 #2「ZCode 里监听老断」/)
    const fromCodex = await codex.call('send_cowart_feedback', { text: 'Codex 画布里找不到撤销\n第二行是细节' })
    assert.ok(!fromCodex.isError, text(fromCodex))
    assert.match(text(fromCodex), /反馈 #3「Codex 画布里找不到撤销」/)
    assert.equal((await record(2)).source.host, 'zcode')
    assert.equal((await record(3)).source.host, 'codex')
  })

  await step("feedback without the user's words is refused", async () => {
    const result = await claude.call('send_cowart_feedback', { text: '   ', title: '空的' })
    assert.ok(result.isError, text(result))
    assert.equal((await readdir(feedbackDir)).length, 3)
  })

  await step('the inbox lists, shows and closes feedback', async () => {
    const listed = await inbox()
    for (const line of [/^#1 \[friction\] AI 视频框拖不动 — 小反 · Claude Code/m, /^#2 \[bug\] ZCode 里监听老断 — /m, /^#3 Codex 画布里找不到撤销 — /m]) assert.match(listed, line)
    const shown = await inbox('show', '1')
    assert.match(shown, /^> AI 视频框拖不动，很烦$/m)
    assert.match(shown, /shot\.png/)
    await inbox('done', '1', '--commit', 'abc1234', '--note', '拖动改好了')
    const done = await record(1)
    assert.equal(done.status, 'done')
    assert.deepEqual([done.history.at(-1).commit, done.history.at(-1).note], ['abc1234', '拖动改好了'])
    assert.match(await readFile(join(await itemDir(1), 'feedback.md'), 'utf8'), /提交 abc1234 · 拖动改好了/)
    assert.doesNotMatch(await inbox(), /^#1 /m)
    assert.match(await inbox('--all'), /^#1 \[已处理\] \[friction\] AI 视频框拖不动/m)
    await assert.rejects(inbox('wontfix', '2'), /--note/)
    await inbox('wontfix', '2', '--note', 'ZCode 那边的问题')
    assert.equal((await record(2)).status, 'wontfix')
    await inbox('reopen', '2')
    assert.equal((await record(2)).status, 'open')
    await assert.rejects(inbox('show', '9'), /没有编号为 9 的反馈/)
  })
} finally {
  await Promise.all([claude.close(), zcode.close(), codex.close()])
  await stopTestService(PORT)
  await rm(projectDir, { recursive: true, force: true })
}

finish()
