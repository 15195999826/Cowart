// The beast command line (the company's generation gateway; its rules are in the beast-gen
// skill) as the canvas service drives it: one `node beast.mjs … --json` process per step.
// Found at COWART_BEAST_CLI, else where `beast` installs itself (~/.beast/bin/beast.mjs).
// Every input goes through a file (--file k=path, or k:=path for JSON): the CLI refuses
// non-ASCII argv values, and Windows mangles quotes.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const STEP_TIMEOUT_MS = 180_000

export class BeastError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function findBeastCli(env = process.env) {
  if (env.COWART_BEAST_CLI) return existsSync(env.COWART_BEAST_CLI) ? env.COWART_BEAST_CLI : null
  const installed = join(homedir(), '.beast', 'bin', 'beast.mjs')
  return existsSync(installed) ? installed : null
}

function abortError() {
  return Object.assign(new Error('已撤销'), { name: 'AbortError' })
}

function lastJsonLine(text) {
  for (const line of String(text).trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not the result line.
    }
  }
  return null
}

export class BeastCli {
  constructor(cli) {
    this.cli = cli
  }

  // Resolves with the command's --json output; a structured CLI error rejects as BeastError.
  // A task that ended badly still resolves (wait / status report it in `status`).
  run(args, { signal, timeoutMs = STEP_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const script = /\.(m?js|cjs)$/i.test(this.cli)
      const child = spawn(script ? process.execPath : this.cli, [...(script ? [this.cli] : []), ...args, '--json'], {
        cwd: tmpdir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const what = `beast ${args.slice(0, 2).join(' ')}`
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        settle(value)
      }
      const onAbort = () => {
        child.kill()
        finish(reject, abortError())
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(reject, new BeastError('TIMEOUT', `${what} 超时了。`))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => finish(reject, new BeastError('SPAWN', `启动不了 beast 命令行：${error.message}`)))
      child.on('close', (code) => {
        const parsed = lastJsonLine(stdout)
        if (parsed && typeof parsed.code === 'string' && typeof parsed.message === 'string' && !parsed.task_id) {
          finish(reject, new BeastError(parsed.code, `猛兽：${parsed.message}`, parsed.details))
          return
        }
        if (parsed) {
          finish(resolve, parsed)
          return
        }
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ')
        finish(reject, new BeastError('BAD_OUTPUT', `${what} 没有返回结果（退出码 ${code}）${tail ? `：${tail}` : ''}`))
      })
    })
  }

  upload(path, options) {
    return this.run(['gen', 'upload', path], options)
  }

  // inputs: { key: value }; strings go in as text files, everything else as JSON files.
  async submit(template, inputs, options) {
    const dir = await mkdtemp(join(tmpdir(), 'cowart-beast-'))
    try {
      const args = ['gen', 'submit', template]
      let index = 0
      for (const [key, value] of Object.entries(inputs)) {
        if (value === undefined || value === null) continue
        const file = join(dir, `input-${index++}.txt`)
        if (typeof value === 'string') {
          await writeFile(file, value, 'utf8')
          args.push('--file', `${key}=${file}`)
        } else {
          await writeFile(file, JSON.stringify(value), 'utf8')
          args.push('--file', `${key}:=${file}`)
        }
      }
      return await this.run(args, options)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // The CLI polls at the gateway's pace (images every few seconds, videos every 20–30 s).
  wait(taskId, { timeoutSec = 1800, ...options } = {}) {
    return this.run(['gen', 'wait', taskId, '--timeout', String(timeoutSec)], { ...options, timeoutMs: timeoutSec * 1000 + 60_000 })
  }

  // One look at a task: status queued (with queue_position), running, done or failed.
  status(taskId, options) {
    return this.run(['gen', 'status', taskId], options)
  }

  output(taskId, dir, options) {
    return this.run(['gen', 'output', taskId, '--dir', dir], { timeoutMs: 600_000, ...options })
  }

  // Only tasks still queued can be withdrawn; one already on a card runs to the end.
  cancel(taskId, options) {
    return this.run(['gen', 'cancel', taskId], options)
  }
}
