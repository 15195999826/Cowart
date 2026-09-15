// Cache completed native video transfers across sandbox destruction. Every hit is
// revalidated by the service against the actual file; no stale file or half-read
// transfer is presented as a healthy cache entry. Storage denial falls back to MCP.
(() => {
  const LIMIT = 128 * 1024 * 1024
  let database
  const inflight = new Map()
  const bypass = new Set()
  async function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('cowart-native-media-v1', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('assets')
        request.result.createObjectStore('meta', { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Media cache unavailable'))
    }).catch(() => null)
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
      const value = await resultOf(store.transaction('assets').objectStore('assets').get(key))
      return value?.version && typeof value.dataBase64 === 'string' ? value : null
    } catch { return null }
  }
  async function put(key, value) {
    try {
      const bytes = value.dataBase64.length
      if (bytes > LIMIT / 2) return
      const store = await db()
      if (!store) return
      await new Promise((resolve, reject) => {
        const tx = store.transaction(['assets', 'meta'], 'readwrite')
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
        const assets = tx.objectStore('assets'), meta = tx.objectStore('meta')
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
      })
    } catch { /* Private/ephemeral sandboxes and quota failures still use MCP. */ }
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
        await put(key, cached)
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
      await put(key, data)
      return { ...result, structuredContent: data }
    })().finally(() => inflight.delete(key))
    inflight.set(key, work)
    return work
  }
})()
