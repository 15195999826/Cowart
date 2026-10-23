// The checks' runtime directory (the token, the service log, exit codes): one of each check
// process's own, never the user's ~/.cowart-claude. The checks' services used to log there and leave
// their exit codes there (on 2026-10-23 the machine's service.log had zsmoke-claude's lines in it).
// Imported before anything that reads COWART_RUNTIME_DIR (service/lib/token.mjs reads it as it
// loads): first in test-kit.mjs, and first in each check that imports token.mjs or client.mjs before
// test-kit.mjs. A check that sets its own beforehand keeps it. Removed when the check exits; one that
// failed leaves it, for its services' log, and says where.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.COWART_RUNTIME_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'cowart-check-runtime-'))
  process.env.COWART_RUNTIME_DIR = dir
  process.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write(`(the check's runtime directory, with its services' log, is left at ${dir})\n`)
      return
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A service of the check's still has its log open: the system's temporary files keep it.
    }
  })
}
