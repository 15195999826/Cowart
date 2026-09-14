#!/usr/bin/env node
// Stands in for `claude -p` (the canvas service's prompt writer) in the checks: reads the
// stream-json user message, logs what it got to COWART_FAKE_CLAUDE_LOG and answers the way
// the writer does, picking flux2-klein for 自动 when there are references and krea2 otherwise.
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  const message = JSON.parse(input.trim().split(/\r?\n/)[0])
  const content = message.message.content
  const brief = JSON.parse(content.find((item) => item.type === 'text').text.replace(/^Brief:\n/, ''))
  const system = readFileSync(option('--system-prompt-file'), 'utf8')
  if (process.env.COWART_FAKE_CLAUDE_LOG) {
    appendFileSync(
      process.env.COWART_FAKE_CLAUDE_LOG,
      `${JSON.stringify({
        model: option('--model'),
        tools: option('--tools'),
        strictMcp: args.includes('--strict-mcp-config'),
        images: content.filter((item) => item.type === 'image').length,
        brief,
        system: system.slice(0, 4000)
      })}\n`
    )
  }
  const auto = String(brief.template).startsWith('auto')
  const answer = { prompt: `${brief.firstLine ? `${brief.firstLine}\n\n` : ''}FAKE: ${brief.userDescription}` }
  if (auto) answer.template = brief.materials.length ? 'flux2-klein' : 'krea2'
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer) })}\n`)
})
