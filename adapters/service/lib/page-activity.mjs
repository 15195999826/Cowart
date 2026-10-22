// When each page of the canvas last changed, for the page menu's 最近改过 order (FORK.md 页的文件夹).
// Upstream rewrites every page file on each save, so the files' times cannot tell: the service
// notes the pages a page save's delta touched and the pages the model's writes landed on
// (canvas-ops.mjs emits pages-changed), from 2026-10-22 on; older pages have no time. Kept in
// the canvas directory next to the request queue, so a restarted service keeps it.
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PAGE_ACTIVITY_FILE_NAME = '.cowart-page-activity.json'

// A page being worked on changes with every autosave: the file is written at most this often.
const SAVE_DELAY_MS = 2000

export class PageActivity extends EventEmitter {
  #times = new Map()
  #file = null
  #timer = null

  constructor({ file = null } = {}) {
    super()
    this.#file = file
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      for (const [pageId, at] of Object.entries(saved?.pages ?? {})) if (Number.isFinite(at)) this.#times.set(pageId, at)
    } catch {
      // Nothing saved yet, or not readable: no page has a time.
    }
  }

  // { [pageId]: ms since the epoch }.
  view() {
    return Object.fromEntries(this.#times)
  }

  touch(pageIds, at = Date.now()) {
    const ids = [...new Set(pageIds)].filter((id) => typeof id === 'string' && id.startsWith('page:'))
    if (ids.length === 0) return
    for (const id of ids) this.#times.set(id, at)
    this.#scheduleSave()
    this.emit('changed')
  }

  forget(pageIds) {
    if (!pageIds.some((id) => this.#times.delete(id))) return
    this.#scheduleSave()
    this.emit('changed')
  }

  #scheduleSave() {
    if (!this.#file || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.save()
    }, SAVE_DELAY_MS)
    this.#timer.unref?.()
  }

  // Now (on shutdown), instead of when the delay is up.
  save() {
    if (!this.#file) return
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const temporary = `${this.#file}.tmp`
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({ version: 1, pages: this.view() })}\n`)
      renameSync(temporary, this.#file)
    } catch {
      // The last good copy stays; the times keep counting in memory.
    }
  }
}
