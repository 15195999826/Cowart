import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const script = await readFile(new URL('../web/asset-cache.js', import.meta.url), 'utf8')
const video = { assetUrl: '/page-assets/test/video.mp4', version: 'v1', dataBase64: 'AAAA', nextOffset: null, totalBytes: 3 }
function setup(indexedDB) {
  const window = { __COWART_SERVICE_PAGE__: { canvasDir: 'isolated' }, addEventListener() {} }
  const context = vm.createContext({ window, indexedDB, setTimeout, clearTimeout })
  vm.runInContext(script, context)
  return window.__cowartReadCachedVideo
}
const within = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Optional cache blocked video delivery')), ms) })]).finally(() => clearTimeout(timer))
}

test('a cache open that never responds cannot prevent the media request', async () => {
  const read = setup({ open: () => ({}) })
  let requests = 0
  const result = await within(read({ assetUrl: video.assetUrl }, async () => { requests++; return { structuredContent: video } }), 2500)
  assert.equal(requests, 1)
  assert.equal(result.structuredContent.dataBase64, video.dataBase64)
})

test('cache read stalls or errors fall back; stalled writes do not delay playable bytes', async (t) => {
  for (const scenario of ['read-stall', 'read-error', 'write-stall']) {
    await t.test(scenario, async () => {
      const read = setup({ open() {
        const request = {}
        setTimeout(() => request.onsuccess?.({ target: request }), 0)
        request.result = {
          close() {},
          transaction(_names, mode) {
            const tx = { abort() {}, objectStore() { return {
              get() {
                const result = {}
                if (scenario !== 'read-stall') setTimeout(() => scenario === 'read-error' ? result.onerror?.() : result.onsuccess?.(), 0)
                return result
              },
              getAll: () => ({}), put() {}, delete() {}
            } } }
            assert.ok(mode === undefined || mode === 'readwrite')
            return tx
          }
        }
        return request
      } })
      const result = await within(read({ assetUrl: video.assetUrl }, async () => ({ structuredContent: video })), scenario === 'write-stall' ? 200 : 2500)
      assert.equal(result.structuredContent.dataBase64, video.dataBase64)
    })
  }
})
