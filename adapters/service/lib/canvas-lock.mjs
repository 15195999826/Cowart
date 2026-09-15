// One canvas service per canvas. The port lets one service run per port; this lock keeps a
// second one off the same canvas when a bridge ends up on another port (at a replacement on
// 2026-09-15 one did, and the canvas had two writers). A service takes the lock before it
// listens and gives it up after its last write (FORK.md 画布服务); a lock whose service is
// gone, or whose pid another program has been given since, is taken over.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SERVICE_NAME } from './identity.mjs'

// In the canvas directory, beside the request queue the service keeps there.
const LOCK_FILE_NAME = '.cowart-service.lock'

// A starting service holds the lock before it answers on its port, and a stopping one still
// holds it after its port closed: this long the lock counts without an answer.
const QUIET_MS = 30_000
// Services that find a lock stale at the same moment all write theirs; the last one keeps it.
const SETTLE_MS = 150
const ANSWER_TIMEOUT_MS = 3_000

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export function canvasLockFile(canvasDir) {
  return join(canvasDir, LOCK_FILE_NAME)
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// { lock } as written, { missing }, or { broken } (being written this moment, or damaged).
function readLock(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { broken: true }
  }
  try {
    const lock = JSON.parse(text)
    if (lock && Number.isInteger(lock.pid) && typeof lock.id === 'string') return { lock }
  } catch {
    // Being written.
  }
  return { broken: true }
}

// The service that has the canvas, while its process runs; null when none does.
export function canvasOwner(canvasDir) {
  const { lock } = readLock(canvasLockFile(canvasDir))
  return lock && isAlive(lock.pid) ? lock : null
}

// A lock another service is writing right now reads broken for a moment.
async function settledLock(file) {
  let current = readLock(file)
  for (let attempt = 0; current.broken && attempt < 20; attempt += 1) {
    await delay(50)
    current = readLock(file)
  }
  return current
}

async function answersOnPort(port) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) })
      return (await response.json().catch(() => null))?.service === SERVICE_NAME
    } catch {
      // Refused, or no answer: ask once more.
    }
  }
  return false
}

// The service that wrote the lock still has the canvas: its process runs, and it answers on
// its port or is starting or stopping. An old lock whose pid runs but answers nothing is a
// pid another program got after the service was gone.
async function isLive(lock) {
  if (!isAlive(lock.pid)) return false
  if (Date.now() - Date.parse(lock.stoppingAt ?? lock.startedAt) < QUIET_MS) return true
  return answersOnPort(lock.port)
}

function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}

class CanvasLock {
  #file
  #record
  #released = false

  constructor(file, record) {
    this.#file = file
    this.#record = record
  }

  #mine() {
    return readLock(this.#file).lock?.id === this.#record.id
  }

  // A stopping service has the canvas until its last write: services that start meanwhile
  // wait for it instead of taking its closed port for a service that is gone.
  stopping() {
    try {
      if (this.#released || !this.#mine()) return
      this.#record = { ...this.#record, stoppingAt: new Date().toISOString() }
      writeFileSync(this.#file, serialize(this.#record))
    } catch {
      // The lock holds without the note.
    }
  }

  release() {
    if (this.#released) return
    this.#released = true
    try {
      if (this.#mine()) unlinkSync(this.#file)
    } catch {
      // Gone already.
    }
  }
}

// Takes the canvas for this service, which is about to listen on `port`, or throws
// ECANVASBUSY with the service that has it (error.owner).
export async function acquireCanvasLock(canvasDir, { port }) {
  const file = canvasLockFile(canvasDir)
  const record = { pid: process.pid, port, canvasDir, startedAt: new Date().toISOString(), id: randomUUID() }
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      writeFileSync(file, serialize(record), { flag: 'wx' })
      return new CanvasLock(file, record)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const current = await settledLock(file)
    if (current.missing) continue
    if (current.lock && (await isLive(current.lock))) {
      const error = new Error(`画布 ${canvasDir} 已经由端口 ${current.lock.port} 上的画布服务（pid ${current.lock.pid}）在用。`)
      error.code = 'ECANVASBUSY'
      error.owner = current.lock
      throw error
    }
    // Stale. Another service may have taken it over while this one was asking its owner.
    if (readLock(file).lock?.id !== current.lock?.id) continue
    writeFileSync(file, serialize(record))
    await delay(SETTLE_MS)
    if (readLock(file).lock?.id === record.id) return new CanvasLock(file, record)
  }
  throw new Error(`拿不到画布锁 ${file}。`)
}
