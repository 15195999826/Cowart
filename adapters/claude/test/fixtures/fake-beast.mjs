#!/usr/bin/env node
// Stands in for the beast command line in the checks (adapters/claude/scripts/generation-test.mjs):
// gen upload / submit / wait / output / cancel with --json, like the real one. Every call is
// appended to COWART_FAKE_BEAST_LOG as a JSON line (submit with the inputs it read from its
// --file arguments). A prompt containing FAIL makes the task fail; SLOW keeps it queued, then
// running, for COWART_FAKE_BEAST_SLOW_MS (default 4000). Results are copies of tiny.png / tiny.mp4.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = dirname(fileURLToPath(import.meta.url))
const VIDEO_TEMPLATES = new Set(['minimax-h3', 'seedance'])
const argv = process.argv.slice(2).filter((arg) => arg !== '--json')
const [domain, verb, ...rest] = argv

function log(entry) {
  if (process.env.COWART_FAKE_BEAST_LOG) appendFileSync(process.env.COWART_FAKE_BEAST_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function flag(name) {
  const index = rest.indexOf(`--${name}`)
  return index >= 0 ? rest[index + 1] : undefined
}

function inputs() {
  const values = {}
  for (let index = 0; index < rest.length; index += 1) {
    const [option, item] = [rest[index], rest[index + 1]]
    if (option !== '--file' && option !== '--in') continue
    index += 1
    const at = item.indexOf('=')
    let key = item.slice(0, at)
    const json = key.endsWith(':')
    if (json) key = key.slice(0, -1)
    const raw = option === '--file' ? readFileSync(item.slice(at + 1), 'utf8') : item.slice(at + 1)
    values[key] = json ? JSON.parse(raw) : raw
  }
  return values
}

// Task ids carry what later calls need: the template, how many results, how it ends, when
// it was submitted.
function taskId(template, count, mode) {
  return `t_fake_${template}_${count}_${mode}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function parseTask(id) {
  const match = /^t_fake_([a-z0-9.-]+)_(\d+)_(ok|fail|slow)_(\d+)_/.exec(id)
  if (!match) return null
  return { template: match[1], count: Number(match[2]), mode: match[3], created: Number(match[4]) }
}

function outputs(task, id) {
  const video = VIDEO_TEMPLATES.has(task.template)
  return Array.from({ length: task.count }, (_, index) => ({
    type: video ? 'video' : 'image',
    filename: `beast_${task.template}_${id}_0000${index + 1}_.${video ? 'mp4' : 'png'}`,
    url: `/api/view?filename=${id}-${index + 1}`
  }))
}

if (domain !== 'gen') {
  out({ code: 'USAGE', message: `fake beast only knows gen, got ${domain}` })
  process.exitCode = 2
} else if (verb === 'upload') {
  const path = resolve(rest[0])
  log({ cmd: 'upload', path })
  out({ name: `up_${basename(path)}`, kind: 'image', size: statSync(path).size })
} else if (verb === 'submit') {
  const template = rest[0]
  const values = inputs()
  const prompt = String(values.prompt ?? '')
  const mode = prompt.includes('FAIL') ? 'fail' : prompt.includes('SLOW') ? 'slow' : 'ok'
  const id = taskId(template, Number(values.n) || 1, mode)
  log({ cmd: 'submit', template, inputs: values, task: id })
  out({ task_id: id, instance: 'fake', resolved: values })
} else if (verb === 'wait' || verb === 'status') {
  const id = rest[0]
  const task = parseTask(id)
  log({ cmd: verb, task: id })
  if (!task) {
    out({ code: 'NOT_FOUND', message: `没有任务 ${id}` })
    process.exitCode = 1
  } else {
    const slowMs = Number(process.env.COWART_FAKE_BEAST_SLOW_MS) || 4000
    const age = Date.now() - task.created
    if (task.mode === 'slow' && age < slowMs && verb === 'wait') await new Promise((done) => setTimeout(done, slowMs - age))
    if (task.mode === 'slow' && age < slowMs && verb === 'status') {
      // Queued for the first third of its time, then on a card.
      out(
        age < slowMs / 3
          ? { task_id: id, template_id: task.template, status: 'queued', queue_position: 1, queue_reason: '等空位' }
          : { task_id: id, template_id: task.template, status: 'running' }
      )
    } else {
      const failed = task.mode === 'fail'
      out({ task_id: id, template_id: task.template, status: failed ? 'failed' : 'done', ...(failed ? { error: '假装失败' } : { outputs: outputs(task, id) }) })
      if (failed) process.exitCode = 1
    }
  }
} else if (verb === 'output') {
  const id = rest[0]
  const task = parseTask(id)
  const dir = resolve(flag('dir') ?? '.')
  mkdirSync(dir, { recursive: true })
  const saved = outputs(task, id).map((item) => {
    const path = join(dir, item.filename)
    copyFileSync(join(FIXTURES, item.type === 'video' ? 'tiny.mp4' : 'tiny.png'), path)
    return { path, type: item.type, filename: item.filename, bytes: statSync(path).size }
  })
  log({ cmd: 'output', task: id, dir })
  out({ task_id: id, saved })
} else if (verb === 'cancel') {
  log({ cmd: 'cancel', tasks: rest.filter((item) => !item.startsWith('--')) })
  out({ ok: true })
} else {
  out({ code: 'USAGE', message: `fake beast does not know gen ${verb}` })
  process.exitCode = 2
}
