// Per-user secret shared by the canvas service, its pages, the session bridges and the
// request listener. Persisted so open canvas tabs keep working across service restarts.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Named after the first host; every bridge and the service share it.
export const RUNTIME_DIR = process.env.COWART_RUNTIME_DIR || join(homedir(), '.cowart-claude')
export const TOKEN_FILE = join(RUNTIME_DIR, 'token')
export const SERVICE_LOG = join(RUNTIME_DIR, 'service.log')
const TOKEN_PATTERN = /^[0-9a-f]{32,}$/

export async function readToken() {
  try {
    const token = (await readFile(TOKEN_FILE, 'utf8')).trim()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

export async function loadOrCreateToken() {
  const existing = await readToken()
  if (existing) return existing
  const token = randomBytes(24).toString('hex')
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
  return token
}
