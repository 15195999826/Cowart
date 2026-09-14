// Helpers for the Claude adapter's end-to-end checks: session bridges run the way Claude
// Code runs them (MCP over stdio), a small SSE reader, and cleanup of test services.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { probeService, stopService } from '../../service/client.mjs'
import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'

export const FIXTURES = join(ADAPTERS_DIR, 'claude', 'test', 'fixtures')
// The canvas the service starts a never-opened canvas from; the checks start from it too.
export const EMPTY_CANVAS = join(ADAPTERS_DIR, 'shared', 'empty-canvas.json')
const BRIDGE_ENTRY = join(ADAPTERS_DIR, 'claude', 'bin', 'cowart-claude-mcp.mjs')
// Session names the checks give out stay out of the user's own list (~/.cowart-claude),
// and each run starts from an empty list.
const NAMES_FILE = join(tmpdir(), `cowart-check-session-names-${process.pid}.json`)

let failures = 0
export async function step(name, run) {
  try {
    await run()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ') ?? error}`)
  }
}

export function finish() {
  rmSync(NAMES_FILE, { force: true })
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

export function text(result) {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// A plain gray PNG of the given size (the insert tools read the size from its header).
export async function writePng(filePath, width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const framed = Buffer.alloc(body.length + 8)
    framed.writeUInt32BE(data.length, 0)
    body.copy(framed, 4)
    framed.writeUInt32BE(crc32(body), body.length + 4)
    return framed
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 8-bit grayscale
  const row = width + 1 // filter byte, then a byte per pixel
  const pixels = Buffer.alloc(row * height, 0x99)
  for (let y = 0; y < height; y += 1) pixels[y * row] = 0
  await writeFile(filePath, Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]))
  return filePath
}

export async function waitFor(check, { timeoutMs = 5000, intervalMs = 100, what = 'a condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(intervalMs)
  }
}

// Minimal SSE reader over fetch; returns an async queue of { event, data }.
export function openEvents(url, headers = {}) {
  const controller = new AbortController()
  const events = []
  const waiters = []
  const ready = fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            let event = 'message'
            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!data) continue
            const item = { event, data: JSON.parse(data) }
            const waiter = waiters.findIndex((entry) => entry.match(item))
            if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(item)
            else events.push(item)
          }
        }
      } catch {
        // Aborted.
      }
    })()
  })
  return {
    ready,
    close: () => controller.abort(),
    next(match, timeoutMs = 5000) {
      const index = events.findIndex(match)
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: (item) => (clearTimeout(timer), resolve(item)) }
        // A waiter that timed out must not swallow the next matching event.
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at >= 0) waiters.splice(at, 1)
          reject(new Error('timed out waiting for event'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    // Forgets what arrived so far, so a following check only sees newer events.
    clear() {
      events.length = 0
    },
    // Whether a matching event arrived (or arrives within ms) — for "must not get it" checks.
    async saw(match, ms = 400) {
      return this.next(match, ms).then(() => true, () => false)
    }
  }
}

export function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res))
    })
    req.on('error', reject)
    req.end()
  })
}

// A session bridge the way Claude Code runs it: MCP over stdio, with its own session id.
export async function startBridge({ cwd, port, session, env = {} }) {
  const inherited = { ...process.env }
  // Checks run the same from any host; the desktop-only switch is tested on purpose.
  delete inherited.CLAUDE_CODE_ENTRYPOINT
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE_ENTRY],
    cwd,
    // A service a check starts keeps the check's canvas, never the machine's.
    env: { ...inherited, COWART_CLAUDE_PORT: String(port), COWART_SESSION_ID: session, COWART_SESSION_NAMES_FILE: NAMES_FILE, COWART_CANVAS_DIR: join(cwd, 'canvas'), ...env },
    stderr: 'pipe'
  })
  const client = new Client({ name: `cowart-check-${session}`, version: '0.0.0' })
  await client.connect(transport)
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }),
    close: () => client.close().catch(() => {})
  }
}

export async function serviceStatus(port) {
  const probe = await probeService(port, await loadOrCreateToken())
  return probe.kind === 'cowart' ? probe.status : null
}

// Stops the canvas service on exactly this port (a test's own, or one a failed run left).
export async function stopTestService(port) {
  const token = await loadOrCreateToken()
  if ((await probeService(port, token)).kind === 'cowart') await stopService(port, token, 'test cleanup')
}
