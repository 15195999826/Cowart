// Per-user secret shared by the adapter, its canvas page and the request listener.
// Persisted so an open canvas tab keeps working after the Claude session restarts.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TOKEN_FILE = join(homedir(), '.cowart-claude', 'token')
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
