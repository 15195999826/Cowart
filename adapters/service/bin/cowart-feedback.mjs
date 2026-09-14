#!/usr/bin/env node
// The feedback inbox (FORK.md 反馈): what users recorded on this machine with
// send_cowart_feedback, to work through in this repository.
//   npm --prefix adapters run feedback                  open items
//   npm --prefix adapters run feedback -- --all         every item
//   npm --prefix adapters run feedback -- show 7        one item in full, with its files
//   npm --prefix adapters run feedback -- done 7 --commit abc1234 --note "改了什么"
//   npm --prefix adapters run feedback -- wontfix 7 --note "为什么不改"
//   npm --prefix adapters run feedback -- reopen 7
// --dir <folder> (or COWART_FEEDBACK_DIR) reads another inbox.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { FEEDBACK_DIR, FeedbackStore, feedbackLine, renderFeedback } from '../lib/feedback.mjs'

const USAGE = `用法：npm --prefix adapters run feedback -- [命令]
  （不写命令）       列出没处理的反馈；加 --all 连处理过的一起列
  show <编号>        看一条的全文、当时的情况和文件路径
  done <编号>        标成已处理：--commit <提交> --note "<改了什么>"
  wontfix <编号>     标成不改：--note "<为什么>"（必填）
  reopen <编号>      重新打开
  --dir <目录>       换一个反馈目录（默认 ${FEEDBACK_DIR}）
编号直接写数字：PowerShell 里 # 后面算注释。`

function fail(message) {
  console.error(message)
  process.exit(1)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      commit: { type: 'string' },
      note: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  })
} catch (error) {
  fail(`${error.message}\n\n${USAGE}`)
}
const { values, positionals } = parsed
const [command = 'list', id] = positionals
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
const store = new FeedbackStore({ dir: values.dir ? resolve(values.dir) : FEEDBACK_DIR })

async function item() {
  if (!id) fail(`${command} 要写编号，例如：npm --prefix adapters run feedback -- ${command} 7`)
  const found = await store.get(id)
  if (!found) fail(`没有编号为 ${id} 的反馈（${store.dir}）。`)
  return found
}

try {
  switch (command) {
    case 'list': {
      const items = (await store.list()).filter(({ record }) => values.all || record.status === 'open')
      if (items.length === 0) {
        console.log(`${values.all ? '还没有反馈' : '没有没处理的反馈'}（${store.dir}）。`)
        break
      }
      console.log(`${values.all ? '全部反馈' : '没处理的反馈'}（${store.dir}）：`)
      for (const { record } of items) console.log(feedbackLine(record))
      console.log('\n看全文：npm --prefix adapters run feedback -- show <编号>')
      break
    }
    case 'show': {
      const { record, dir } = await item()
      console.log(renderFeedback(record))
      console.log(`文件夹：${dir}`)
      for (const name of (await readdir(dir)).sort()) console.log(`- ${join(dir, name)}`)
      break
    }
    case 'done':
    case 'wontfix':
    case 'reopen': {
      await item()
      if (command === 'wontfix' && !values.note?.trim()) fail('wontfix 要用 --note 写明为什么不改。')
      const { record } = await store.setStatus(id, command === 'reopen' ? 'open' : command, { commit: values.commit, note: values.note })
      console.log(feedbackLine(record))
      break
    }
    default:
      fail(`不认识的命令：${command}\n\n${USAGE}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
