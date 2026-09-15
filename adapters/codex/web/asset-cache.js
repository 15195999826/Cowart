// Cache completed native video transfers across sandbox destruction. Every hit is
// revalidated by the service against the actual file; no stale file or half-read
// transfer is presented as a healthy cache entry. Storage denial falls back to MCP.
(() => {
  const LIMIT = 128 * 1024 * 1024
  const STORAGE_WAIT_MS = 1000
  let database
  let connection
  let disabled = false
  const inflight = new Map()
  const bypass = new Set()
  function disable() {
    disabled = true
    connection?.close()
    connection = null
  }
  function bounded(promise, cancel = () => {}) {
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { cancel() } catch { /* The transaction may already be finished. */ }
        reject(new Error('Optional media cache did not respond'))
      }, STORAGE_WAIT_MS)
    })
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
  }
  async function db() {
    if (disabled) return null
    if (!database) database = bounded(new Promise((resolve, reject) => {
      const request = indexedDB.open('cowart-native-media-v1', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('assets')
        request.result.createObjectStore('meta', { keyPath: 'key' })
      }
      request.onsuccess = () => {
        if (disabled) { request.result.close(); return }
        connection = request.result
        connection.onversionchange = disable
        resolve(connection)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Media cache unavailable'))
    })).catch(() => { disable(); return null })
    return database
  }
  const resultOf = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  async function get(key) {
    try {
      const store = await db()
      if (!store) return null
      const tx = store.transaction('assets')
      const value = await bounded(resultOf(tx.objectStore('assets').get(key)), () => tx.abort())
      return value?.version && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0 &&
        typeof value.dataBase64 === 'string' && value.dataBase64.length === 4 * Math.ceil(value.totalBytes / 3) ? value : null
    } catch { disable(); return null }
  }
  async function put(key, value, touchOnly = false) {
    try {
      const bytes = value.dataBase64.length
      if (bytes > LIMIT / 2) return
      const store = await db()
      if (!store) return
      const tx = store.transaction(touchOnly ? ['meta'] : ['assets', 'meta'], 'readwrite')
      await bounded(new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
        const meta = tx.objectStore('meta')
        if (touchOnly) { meta.put({ key, bytes, usedAt: Date.now() }); return }
        const assets = tx.objectStore('assets')
        const request = meta.getAll()
        request.onsuccess = () => {
          const entries = request.result.filter((entry) => entry.key !== key).sort((a, b) => a.usedAt - b.usedAt)
          let total = bytes + entries.reduce((sum, entry) => sum + entry.bytes, 0)
          for (const entry of entries) {
            if (total <= LIMIT) break
            assets.delete(entry.key); meta.delete(entry.key); total -= entry.bytes
          }
          assets.put(value, key)
          meta.put({ key, bytes, usedAt: Date.now() })
        }
      }), () => tx.abort())
    } catch { disable() }
  }
  window.addEventListener('cowart:retry-asset', ({ detail }) => {
    const src = window.__cowartEditor?.getAsset(detail?.assetId)?.props.src
    if (src) bypass.add(src)
  })
  window.__cowartReadCachedVideo = (args, read) => {
    const key = `${window.__COWART_SERVICE_PAGE__?.canvasDir}\n${args.assetUrl}`
    if (inflight.has(key)) return inflight.get(key)
    const work = (async () => {
      const cached = bypass.delete(args.assetUrl) ? null : await get(key)
      let result = await read({ ...args, ifVersion: cached?.version })
      if (result.isError) return result
      let data = result.structuredContent
      if (data?.notModified && cached) {
        void put(key, cached, true)
        return { ...result, structuredContent: cached }
      }
      if (!data?.version) return result
      const parts = [data.dataBase64]
      let offset = data.nextOffset
      while (offset != null) {
        const chunk = await read({ ...args, offset, expectedVersion: data.version })
        if (chunk.isError) return chunk
        const next = chunk.structuredContent
        if (next.version !== data.version || (next.nextOffset != null && next.nextOffset <= offset)) throw new Error('视频读取期间文件发生变化，请重试。')
        parts.push(next.dataBase64)
        offset = next.nextOffset
      }
      data = { ...data, dataBase64: parts.join(''), nextOffset: null }
      // Delivery never waits for optional storage. In native sandboxes even an
      // IndexedDB request without an error callback can remain pending forever.
      void put(key, data)
      return { ...result, structuredContent: data }
    })().finally(() => inflight.delete(key))
    inflight.set(key, work)
    return work
  }
})()
