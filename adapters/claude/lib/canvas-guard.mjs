// Serializes canvas writes per canvas directory and keeps freshly inserted videos
// from being dropped by a stale page autosave. Upstream only protects image shapes
// this way (protectImageRecords), so videos need the same treatment here.
const FETCH_GRACE_MS = 5_000
const MAX_PENDING_MS = 10 * 60_000

export class CanvasGuard {
  #locks = new Map()
  #pending = new Map()

  async withLock(canvasDir, task) {
    const previous = this.#locks.get(canvasDir) ?? Promise.resolve()
    const run = previous.then(task)
    const tail = run.catch(() => {})
    this.#locks.set(canvasDir, tail)
    try {
      return await run
    } finally {
      if (this.#locks.get(canvasDir) === tail) this.#locks.delete(canvasDir)
    }
  }

  trackInsertedVideo(canvasDir, { shape, asset }) {
    const entries = this.#pending.get(canvasDir) ?? new Map()
    entries.set(shape.id, { shape, asset, addedAt: Date.now(), fetchedAt: null })
    this.#pending.set(canvasDir, entries)
  }

  // The page saves its whole store. Until the page has fetched a snapshot containing
  // a new video, a save without it is stale rather than a user delete.
  protectPageSave(canvasDir, snapshot) {
    const entries = this.#pending.get(canvasDir)
    if (!entries?.size || !snapshot?.store) return { snapshot, restored: [] }

    const now = Date.now()
    const restored = []
    let store = snapshot.store
    for (const [shapeId, entry] of entries) {
      const expired = now - entry.addedAt > MAX_PENDING_MS
      const seenAndRemoved = entry.fetchedAt !== null && now - entry.fetchedAt > FETCH_GRACE_MS
      if (store[shapeId] || expired || seenAndRemoved) {
        entries.delete(shapeId)
        continue
      }
      if (store === snapshot.store) store = { ...snapshot.store }
      store[shapeId] = entry.shape
      store[entry.asset.id] ??= entry.asset
      restored.push(shapeId)
    }
    if (entries.size === 0) this.#pending.delete(canvasDir)
    return restored.length > 0 ? { snapshot: { ...snapshot, store }, restored } : { snapshot, restored }
  }

  observePageFetch(canvasDir, snapshot) {
    const entries = this.#pending.get(canvasDir)
    if (!entries?.size || !snapshot?.store) return
    for (const [shapeId, entry] of entries) {
      if (entry.fetchedAt === null && snapshot.store[shapeId]) entry.fetchedAt = Date.now()
    }
  }
}
