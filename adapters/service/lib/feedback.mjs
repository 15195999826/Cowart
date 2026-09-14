// The user's feedback on Cowart itself (FORK.md 反馈). A session on any host records it with
// send_cowart_feedback: the canvas service lists that tool next to upstream's, so the Claude
// Code, ZCode and Codex bridges forward it like the others. It is worked through in the Cowart
// repository with the inbox command (service/bin/cowart-feedback.mjs). One folder per item
// under ~/.cowart/feedback, kept on this machine like the canvas:
//   feedback.json    the record; the inbox command updates its status
//   feedback.md      the same, for reading
//   canvas.txt       the page it is about, summarized as it was then
//   service-log.txt  the end of the canvas service log
// and the files the model attached (screenshots, outputs).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

import { SERVICE_LOG } from './token.mjs'

export const FEEDBACK_DIR = resolve(process.env.COWART_FEEDBACK_DIR || join(homedir(), '.cowart', 'feedback'))
export const FEEDBACK_TOOL = 'send_cowart_feedback'
export const FEEDBACK_KINDS = ['bug', 'friction', 'idea']
export const FEEDBACK_STATUSES = ['open', 'done', 'wontfix']

const STATUS_LABELS = { open: '未处理', done: '已处理', wontfix: '不改' }
const KIND_LABELS = { bug: '坏了或结果不对', friction: '能用但别扭', idea: '想要的新功能' }
const HOST_LABELS = { claude: 'Claude Code', zcode: 'ZCode', codex: 'Codex' }
const RECORD_FILE = 'feedback.json'
const READING_FILE = 'feedback.md'
const CANVAS_FILE = 'canvas.txt'
const LOG_FILE = 'service-log.txt'
// Item folders: the number, then the title (0007-AI-视频框拖不动).
const ITEM_DIR = /^(\d+)-/
const MAX_TEXT = 20_000
const MAX_TITLE = 60
const MAX_SHAPES = 50
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const LOG_LINES = 80
const LOG_TAIL_BYTES = 64 * 1024

export const FEEDBACK_TOOL_DEFINITION = {
  name: FEEDBACK_TOOL,
  title: 'Send Cowart Feedback',
  description:
    "Record the user's feedback on Cowart itself (the canvas, its panels and buttons, canvas requests, generation, these tools) so it gets worked on in the Cowart repository. Call it when the user says 「反馈：…」「记个反馈」「给 Cowart 提个意见」; when they only complain about Cowart, ask once whether to record it. text is the user's own words, verbatim. details is what you know of the situation: what they were doing, what happened, what they expected, how to reproduce it; leave out what you do not know and ask at most one question. The service adds the rest itself: machine, host, session, project, the page this session holds and the ones it shows, code version, this session's recent canvas requests and the service log. This only records it: do not change Cowart from here.",
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: "The user's own words, verbatim." },
      title: { type: 'string', description: "A short title in the user's language (about 20 characters)." },
      kind: {
        type: 'string',
        enum: FEEDBACK_KINDS,
        description: 'bug: broken or a wrong result; friction: works but is awkward, slow or confusing; idea: something they want that is not there.'
      },
      details: { type: 'string', description: 'What you know of the situation: what the user was doing, what happened, what they expected, steps to reproduce.' },
      pageId: { type: 'string', description: 'The canvas page it is about, when that is not the page this session holds or shows.' },
      shapeIds: { type: 'array', items: { type: 'string' }, description: 'Canvas shapes it is about (from get_cowart_selection or the canvas summary).' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Local files to keep with it: screenshots, generated outputs, logs.' }
    },
    required: ['text']
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asArray(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

function firstLine(text, max) {
  const line = text.split(/\r?\n/, 1)[0].trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// The title in a folder name: readable in a file browser, valid on every file system.
function slug(title) {
  const safe = [...title].map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? ' ' : char)).join('')
  return safe.replace(/[\s.]+/g, ' ').trim().slice(0, 24).trim().replaceAll(' ', '-') || 'feedback'
}

function uniqueName(taken, name) {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length) || 'file'
  let candidate = name
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${extension}`
  taken.add(candidate.toLowerCase())
  return candidate
}

function localTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function git(root, args) {
  return new Promise((done) => {
    execFile('git', ['-C', root, ...args], { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => done(error ? null : String(stdout)))
  })
}

// The commit the checkout the service runs from is on, and how many files differ from it.
async function gitState(root) {
  if (!root) return {}
  const [head, status] = await Promise.all([git(root, ['rev-parse', '--short', 'HEAD']), git(root, ['status', '--porcelain'])])
  if (!head?.trim()) return {}
  return { commit: head.trim(), uncommitted: status === null ? null : status.split('\n').filter(Boolean).length }
}

// The last lines of a log that may be large.
async function tail(file, lineCount) {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    // The first line was cut off.
    if (length < size) lines.shift()
    while (lines.length > 0 && !lines.at(-1)) lines.pop()
    return lines.slice(-lineCount).join('\n')
  } catch {
    return ''
  } finally {
    await handle?.close()
  }
}

// Copies of the files the model attached; one that cannot be copied is reported, not fatal.
async function copyAttachments(dir, paths) {
  const kept = []
  const skipped = []
  const taken = new Set([RECORD_FILE, READING_FILE, CANVAS_FILE, LOG_FILE])
  for (const [index, raw] of paths.entries()) {
    const from = nonEmpty(raw) && resolve(raw.trim())
    if (!from) continue
    if (index >= MAX_ATTACHMENTS) {
      skipped.push({ from, reason: `一次最多附 ${MAX_ATTACHMENTS} 个文件` })
      continue
    }
    try {
      const info = await stat(from)
      if (!info.isFile()) throw new Error('不是文件')
      if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
      const file = uniqueName(taken, basename(from))
      await copyFile(from, join(dir, file))
      kept.push({ file, from, bytes: info.size })
    } catch (error) {
      skipped.push({ from, reason: error.code === 'ENOENT' ? '找不到这个文件' : error.message })
    }
  }
  return { kept, skipped }
}

async function readRecord(dir) {
  try {
    return JSON.parse(await readFile(join(dir, RECORD_FILE), 'utf8'))
  } catch {
    return null
  }
}

async function writeRecord(dir, record) {
  await writeFile(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(dir, READING_FILE), renderFeedback(record))
}

function codeLine(code) {
  const parts = [code.version && `v${code.version}`, code.build && `build ${code.build}`]
  if (code.commit) parts.push(`仓库在 ${code.commit}${code.uncommitted ? `（另有 ${code.uncommitted} 个文件没提交）` : ''}`)
  parts.push(code.root)
  return parts.filter(Boolean).join(' · ') || '不知道'
}

// One line of the inbox list.
export function feedbackLine(record) {
  const source = record.source ?? {}
  const tags = [record.status !== 'open' && (STATUS_LABELS[record.status] ?? record.status), record.kind].filter(Boolean).map((tag) => `[${tag}]`)
  const from = [source.sessionName, HOST_LABELS[source.host] ?? source.host, source.project && basename(source.project), localTime(record.createdAt)].filter(Boolean)
  return `#${record.id} ${[...tags, record.title].join(' ')} — ${from.join(' · ')}`
}

// feedback.md: the record for reading.
export function renderFeedback(record) {
  const source = record.source ?? {}
  const canvas = record.canvas ?? {}
  const page = (entry) => `「${entry.name ?? entry.id}」`
  const pages = [
    canvas.page && `说的是${page(canvas.page)}`,
    canvas.heldPage && `会话负责${page(canvas.heldPage)}`,
    canvas.shownPages?.length > 0 && `画布面板在看${canvas.shownPages.map(page).join('、')}`
  ].filter(Boolean)
  const lines = [
    `# #${record.id} ${record.title}`,
    '',
    `- 状态：${STATUS_LABELS[record.status] ?? record.status}`,
    ...(record.kind ? [`- 类型：${record.kind}（${KIND_LABELS[record.kind] ?? record.kind}）`] : []),
    `- 时间：${localTime(record.createdAt)}`,
    `- 来自：${[source.sessionName ?? '没起名字的会话', HOST_LABELS[source.host] ?? source.host, source.project, source.machine && `机器 ${source.machine}`].filter(Boolean).join(' · ')}`,
    ...(pages.length > 0 ? [`- 页：${pages.join('；')}`] : []),
    `- 代码：${codeLine(record.code ?? {})}`,
    '',
    '## 用户原话',
    '',
    ...record.text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd())
  ]
  if (record.details) lines.push('', '## 记录时 AI 的整理', '', record.details)
  if (canvas.shapeIds?.length > 0) lines.push('', '## 相关图形', '', canvas.shapeIds.join('、'))
  if (record.requests?.length > 0) {
    lines.push('', '## 当时最近的画布请求', '')
    for (const request of record.requests) {
      lines.push(`- #${request.id} [${request.status}] ${request.title}${request.message ? ` — ${request.message}` : ''}${request.pageName ? `（${request.pageName}）` : ''} · ${localTime(request.updatedAt)}`)
    }
  }
  const files = [
    ...(record.attachments ?? []).map((file) => `- ${file.file}（原文件 ${file.from}）`),
    ...(record.files?.canvas ? [`- ${record.files.canvas}：说的那一页当时的画布摘要`] : []),
    ...(record.files?.serviceLog ? [`- ${record.files.serviceLog}：画布服务日志最后 ${LOG_LINES} 行`] : [])
  ]
  if (files.length > 0) lines.push('', '## 附件', '', ...files)
  if (record.history?.length > 0) {
    lines.push('', '## 处理记录', '')
    for (const change of record.history) {
      lines.push(`- ${localTime(change.at)} ${STATUS_LABELS[change.status] ?? change.status}${change.commit ? ` · 提交 ${change.commit}` : ''}${change.note ? ` · ${change.note}` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export class FeedbackStore {
  #queue = Promise.resolve()

  constructor({ dir = FEEDBACK_DIR, serviceLog = SERVICE_LOG } = {}) {
    this.dir = dir
    this.serviceLog = serviceLog
  }

  // One at a time, so feedback sent from two sessions at once gets two numbers.
  #serial(task) {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => {})
    return run
  }

  async #lastId() {
    const names = await readdir(this.dir).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
    return names.reduce((last, name) => Math.max(last, Number(ITEM_DIR.exec(name)?.[1] ?? 0)), 0)
  }

  // input: what the model sent. context: what the service knows of the session (server.mjs):
  // { source, canvas, code, requests, canvasText }.
  async create(input = {}, context = {}) {
    const text = clean(input.text, MAX_TEXT)
    if (!text) throw new Error('反馈得有内容：text 放用户的原话。')
    const title = clean(input.title, MAX_TITLE) || firstLine(text, 30)
    const kind = FEEDBACK_KINDS.includes(input.kind) ? input.kind : null
    const details = clean(input.details, MAX_TEXT)
    const shapeIds = asArray(input.shapeIds).map(nonEmpty).filter(Boolean).slice(0, MAX_SHAPES)
    const attachments = asArray(input.attachments)
    return this.#serial(async () => {
      await mkdir(this.dir, { recursive: true })
      const id = (await this.#lastId()) + 1
      const dir = join(this.dir, `${String(id).padStart(4, '0')}-${slug(title)}`)
      await mkdir(dir)
      const [copied, git, log] = await Promise.all([copyAttachments(dir, attachments), gitState(context.code?.root), tail(this.serviceLog, LOG_LINES)])
      const files = {}
      if (context.canvasText) {
        await writeFile(join(dir, CANVAS_FILE), `${context.canvasText}\n`)
        files.canvas = CANVAS_FILE
      }
      if (log) {
        await writeFile(join(dir, LOG_FILE), `${log}\n`)
        files.serviceLog = LOG_FILE
      }
      const record = {
        id,
        uid: randomUUID(),
        status: 'open',
        kind,
        title,
        text,
        details,
        createdAt: new Date().toISOString(),
        source: { machine: hostname(), ...context.source },
        canvas: { ...context.canvas, shapeIds },
        code: { ...context.code, ...git },
        requests: context.requests ?? [],
        attachments: copied.kept,
        files,
        history: []
      }
      await writeRecord(dir, record)
      return { record, dir, skipped: copied.skipped }
    })
  }

  // Every item, oldest first: [{ record, dir }].
  async list() {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && ITEM_DIR.test(entry.name))
        .map(async (entry) => {
          const dir = join(this.dir, entry.name)
          const record = await readRecord(dir)
          return record && { record, dir }
        })
    )
    return items.filter(Boolean).sort((a, b) => a.record.id - b.record.id)
  }

  // By number ("7" or "#7").
  async get(id) {
    const wanted = Number(String(id).trim().replace(/^#/, ''))
    return (await this.list()).find((item) => item.record.id === wanted) ?? null
  }

  // done / wontfix when it has been dealt with, open to reopen; each change is kept.
  async setStatus(id, status, { commit, note } = {}) {
    if (!FEEDBACK_STATUSES.includes(status)) throw new Error(`反馈没有「${status}」这个状态。`)
    return this.#serial(async () => {
      const item = await this.get(id)
      if (!item) throw new Error(`没有编号为 ${id} 的反馈（${this.dir}）。`)
      const change = { at: new Date().toISOString(), status }
      if (nonEmpty(commit)) change.commit = commit.trim()
      if (nonEmpty(note)) change.note = note.trim()
      item.record.status = status
      item.record.history = [...(item.record.history ?? []), change]
      await writeRecord(item.dir, item.record)
      return item
    })
  }
}
