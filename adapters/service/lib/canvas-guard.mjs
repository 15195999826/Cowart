// Serializes canvas writes per canvas directory and keeps service-side edits from being
// undone by a stale page autosave: records a tool just inserted (a video, a generated image,
// an HTML draft) must not be dropped, and replaced AI holders must not come back. Upstream
// only protects image shapes this way (protectImageRecords), so the rest needs it here.
const FETCH_GRACE_MS = 5_000
const MAX_PENDING_MS = 10 * 60_000

export class CanvasGuard {
  #locks = new Map()
  #inserted = new Map()
  #removed = new Map()

  async withLock(key, task) {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const run = previous.then(task)
    const tail = run.catch(() => {})
    this.#locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key)
    }
  }

  trackInsertedRecords(canvasDir, records) {
    const entries = this.#entries(this.#inserted, canvasDir)
    for (const record of records) {
      if (record?.id) entries.set(record.id, { record, addedAt: Date.now(), fetchedAt: null })
    }
  }

  trackInsertedVideo(canvasDir, { shape, asset }) {
    this.trackInsertedRecords(canvasDir, [shape, asset])
  }

  trackRemovedShape(canvasDir, shapeId) {
    this.#entries(this.#removed, canvasDir).set(shapeId, { addedAt: Date.now(), fetchedAt: null })
  }

  // Until the page has fetched a snapshot that reflects a service-side edit, a save that
  // contradicts it is stale rather than a user action. A page that saves a delta cannot
  // drop an inserted record it never saw, so only holders it may have kept are checked;
  // a whole-canvas save (an older page) gets the inserted records back too.
  protectPageSave(canvasDir, snapshot, { restoreInserted = true } = {}) {
    if (!snapshot?.store) return { snapshot, restored: [], dropped: [] }
    const now = Date.now()
    const restored = []
    const dropped = []
    let store = snapshot.store
    const writable = () => {
      if (store === snapshot.store) store = { ...snapshot.store }
      return store
    }

    const inserted = this.#inserted.get(canvasDir)
    for (const [id, entry] of inserted ?? []) {
      if (store[id] || this.#settled(entry, now)) {
        inserted.delete(id)
        continue
      }
      if (!restoreInserted) continue
      writable()[id] = entry.record
      restored.push(id)
    }

    const removed = this.#removed.get(canvasDir)
    for (const [shapeId, entry] of removed ?? []) {
      if (!store[shapeId] || this.#settled(entry, now)) {
        removed.delete(shapeId)
        continue
      }
      delete writable()[shapeId]
      dropped.push(shapeId)
    }

    const changed = restored.length > 0 || dropped.length > 0
    return { snapshot: changed ? { ...snapshot, store } : snapshot, restored, dropped }
  }

  observePageFetch(canvasDir, snapshot) {
    if (!snapshot?.store) return
    const now = Date.now()
    for (const [id, entry] of this.#inserted.get(canvasDir) ?? []) {
      if (entry.fetchedAt === null && snapshot.store[id]) entry.fetchedAt = now
    }
    for (const [shapeId, entry] of this.#removed.get(canvasDir) ?? []) {
      if (entry.fetchedAt === null && !snapshot.store[shapeId]) entry.fetchedAt = now
    }
  }

  // Settled once the page has seen the edit for a while (later saves are user intent) or it expired.
  #settled(entry, now) {
    return now - entry.addedAt > MAX_PENDING_MS || (entry.fetchedAt !== null && now - entry.fetchedAt > FETCH_GRACE_MS)
  }

  #entries(map, canvasDir) {
    let entries = map.get(canvasDir)
    if (!entries) {
      entries = new Map()
      map.set(canvasDir, entries)
    }
    return entries
  }
}
