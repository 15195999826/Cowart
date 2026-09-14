// Which session is responsible for which page of which canvas (FORK.md, 分页负责制), the
// names sessions go by, and which page each open pane (one canvas page load in a Browser
// pane) shows. A page is the responsibility of at most one session at a time and a session
// is responsible for at most one page: it takes a page when the user enters it in that
// session («打开 Cowart 画布 角色设定», «接管 角色设定») or clicks the page's button on the
// canvas; whoever held the page before loses it, and the page the session held before is
// released. Names and responsibilities are kept on disk, so a restarted service still
// knows them. Switching pages in a pane changes nothing here.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { RUNTIME_DIR } from './token.mjs'

// Tests keep their sessions out of the user's file.
const SESSIONS_FILE = process.env.COWART_SESSION_NAMES_FILE || join(RUNTIME_DIR, 'session-names.json')
// A session's name (and the page it holds) stays this long after the session was last seen.
const KEPT_MS = 7 * 24 * 60 * 60_000
const MAX_NAME_LENGTH = 12
// For a session that did not pick a name for itself.
const SPARE_NAMES = ['小川', '阿满', '林夏', '苏禾', '周野', '米粒', '小舟', '青禾', '安然', '若溪', '阿树', '知秋', '南风', '北辰', '小鹿', '星野']

function samePage(a, b) {
  return Boolean(a && b) && a.canvasDir === b.canvasDir && a.pageId === b.pageId
}

export class Presence extends EventEmitter {
  // session → { name, seenAt, page: { canvasDir, pageId } | null }
  #sessions = new Map()
  // pane → { id, session, canvasDir, pageId, pageName }
  #panes = new Map()
  #writing = Promise.resolve()

  // canvasDir: the service's one canvas. Responsibilities saved for other canvases (the
  // per-project canvases before, whose pages were moved into it) are taken to be on it; of
  // two sessions that held the same page, the one seen last keeps it.
  constructor({ canvasDir = null } = {}) {
    super()
    try {
      const saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
      const entries = Object.entries(saved.sessions ?? {}).sort(([, x], [, y]) => (x?.seenAt ?? 0) - (y?.seenAt ?? 0))
      for (const [session, entry] of entries) {
        if (!entry?.name || Date.now() - (entry.seenAt ?? 0) >= KEPT_MS) continue
        const page =
          entry.page && typeof entry.page.canvasDir === 'string' && typeof entry.page.pageId === 'string'
            ? { canvasDir: canvasDir ?? entry.page.canvasDir, pageId: entry.page.pageId }
            : null
        const earlier = page && this.holderOf(page.canvasDir, page.pageId)
        if (earlier) this.#sessions.get(earlier).page = null
        this.#sessions.set(session, { name: entry.name, seenAt: entry.seenAt ?? Date.now(), page })
      }
    } catch {
      // No sessions yet.
    }
  }

  #entry(session) {
    let entry = this.#sessions.get(session)
    if (!entry) {
      entry = { name: null, seenAt: Date.now(), page: null }
      this.#sessions.set(session, entry)
    }
    return entry
  }

  #persist() {
    const now = Date.now()
    const sessions = Object.fromEntries(
      [...this.#sessions].filter(([, entry]) => entry.name && now - entry.seenAt < KEPT_MS).map(([id, entry]) => [id, { name: entry.name, seenAt: entry.seenAt, page: entry.page }])
    )
    const payload = `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`
    this.#writing = this.#writing
      .then(() => mkdir(dirname(SESSIONS_FILE), { recursive: true }))
      .then(() => writeFile(SESSIONS_FILE, payload))
      .catch(() => {})
  }

  // ---- Names -------------------------------------------------------------------------

  nameOf(session) {
    return this.#sessions.get(session)?.name ?? null
  }

  setName(session, name) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH || [...trimmed].some((char) => char.charCodeAt(0) < 32)) {
      throw new Error(`名字「${trimmed}」不能用：要 1–${MAX_NAME_LENGTH} 个字。`)
    }
    for (const [other, entry] of this.#sessions) {
      if (other !== session && entry.name === trimmed) throw new Error(`「${trimmed}」已经是另一个会话的名字了，换一个。`)
    }
    const entry = this.#entry(session)
    const changed = entry.name !== trimmed
    entry.name = trimmed
    entry.seenAt = Date.now()
    this.#persist()
    if (changed) this.#changedWhereSeen(session)
    return trimmed
  }

  // The session's name, picking a spare one if it has none yet.
  ensureName(session) {
    const known = this.#sessions.get(session)
    if (known?.name) {
      known.seenAt = Date.now()
      this.#persist()
      return known.name
    }
    const taken = new Set([...this.#sessions.values()].map((entry) => entry.name))
    return this.setName(session, SPARE_NAMES.find((name) => !taken.has(name)) ?? `会话${String(session).slice(-4)}`)
  }

  #changedWhereSeen(session) {
    const canvases = new Set([...this.#panes.values()].filter((entry) => entry.session === session).map((entry) => entry.canvasDir))
    const page = this.#sessions.get(session)?.page
    if (page) canvases.add(page.canvasDir)
    for (const canvasDir of canvases) this.emit('changed', canvasDir)
  }

  // ---- Responsibility ----------------------------------------------------------------

  // Sessions that hold a page (a restarted service asks whether they are still around).
  sessionsWithPages() {
    return [...this.#sessions].filter(([, entry]) => entry.page).map(([id]) => id)
  }

  pageOf(session) {
    return this.#sessions.get(session)?.page ?? null
  }

  holderOf(canvasDir, pageId) {
    for (const [id, entry] of this.#sessions) if (samePage(entry.page, { canvasDir, pageId })) return id
    return null
  }

  // The session takes the page: the session holding it loses it, the page this session
  // held before is released. Returns who held it (null when nobody, or the session itself).
  enter(session, canvasDir, pageId) {
    const page = { canvasDir, pageId }
    const previous = this.holderOf(canvasDir, pageId)
    if (previous === session) {
      this.#entry(session).seenAt = Date.now()
      this.#persist()
      return { previous: session }
    }
    const changed = new Set([canvasDir])
    if (previous) this.#sessions.get(previous).page = null
    const entry = this.#entry(session)
    if (entry.page) changed.add(entry.page.canvasDir)
    entry.page = page
    entry.seenAt = Date.now()
    this.#persist()
    for (const dir of changed) this.emit('changed', dir)
    return { previous }
  }

  // The session gives up its page (it ended, or its page is gone).
  release(session) {
    const entry = this.#sessions.get(session)
    if (!entry?.page) return null
    const page = entry.page
    entry.page = null
    this.#persist()
    this.emit('changed', page.canvasDir)
    return page
  }

  // Pages the user deleted: nobody is responsible for them any more.
  releasePages(canvasDir, pageIds) {
    for (const pageId of pageIds) {
      const holder = this.holderOf(canvasDir, pageId)
      if (holder) this.release(holder)
    }
  }

  // ---- Panes -------------------------------------------------------------------------

  openPane({ pane, session, canvasDir }) {
    let entry = this.#panes.get(pane)
    if (!entry) {
      entry = { id: pane, session, canvasDir, pageId: null, pageName: null }
      this.#panes.set(pane, entry)
    }
    return entry
  }

  pane(pane) {
    return this.#panes.get(pane) ?? null
  }

  // What the pane shows now; only a default for the session's writes, never a claim.
  setPanePage(pane, { pageId, pageName }) {
    const entry = this.#panes.get(pane)
    if (!entry || !pageId) return
    entry.pageId = pageId
    entry.pageName = pageName ?? null
  }

  closePane(pane) {
    const entry = this.#panes.get(pane)
    if (!entry) return
    this.#panes.delete(pane)
    this.emit('changed', entry.canvasDir)
  }

  // The panes of a session on a canvas (all of them when canvasDir is left out).
  panesOf(session, canvasDir) {
    return [...this.#panes.values()].filter((entry) => entry.session === session && entry.pageId && (!canvasDir || entry.canvasDir === canvasDir))
  }

  // What the canvas pages show: who is responsible for each page, and the names of every
  // session that holds a page there or looks at it.
  view(canvasDir) {
    const pages = {}
    const names = {}
    for (const [id, entry] of this.#sessions) {
      if (entry.page?.canvasDir !== canvasDir) continue
      pages[entry.page.pageId] = { holder: id }
      names[id] = entry.name
    }
    for (const entry of this.#panes.values()) {
      if (entry.canvasDir === canvasDir) names[entry.session] = this.nameOf(entry.session)
    }
    return { pages, names }
  }
}
