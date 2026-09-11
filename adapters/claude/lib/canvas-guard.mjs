// Serializes canvas writes per canvas directory and keeps adapter-side edits from being
// undone by a stale page autosave: freshly inserted videos must not be dropped and
// replaced AI video holders must not come back. Upstream only protects image shapes
// this way (protectImageRecords), so these need the same treatment here.
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

  trackInsertedVideo(canvasDir, { shape, asset }) {
    this.#entries(this.#inserted, canvasDir).set(shape.id, { shape, asset, addedAt: Date.now(), fetchedAt: null })
  }

  trackRemovedShape(canvasDir, shapeId) {
    this.#entries(this.#removed, canvasDir).set(shapeId, { addedAt: Date.now(), fetchedAt: null })
  }

  // The page saves its whole store. Until the page has fetched a snapshot that reflects an
  // adapter edit, a save that contradicts it is stale rather than a user action.
  protectPageSave(canvasDir, snapshot) {
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
    for (const [shapeId, entry] of inserted ?? []) {
      if (store[shapeId] || this.#settled(entry, now)) {
        inserted.delete(shapeId)
        continue
      }
      writable()[shapeId] = entry.shape
      store[entry.asset.id] ??= entry.asset
      restored.push(shapeId)
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
    for (const [shapeId, entry] of this.#inserted.get(canvasDir) ?? []) {
      if (entry.fetchedAt === null && snapshot.store[shapeId]) entry.fetchedAt = now
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
