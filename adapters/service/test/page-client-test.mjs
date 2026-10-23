// The canvas page's reads (src/cowartClient.js, a fork patch point): a poll the service answers
// with 'unchanged' hands upstream nothing to apply, and an aborted first read never reaches the
// service. Plain Node with a stand-in window.
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCowartCanvasState, refreshCowartCanvasSnapshot } from '../../../src/cowartClient.js'

function host({ toolOutput = {}, read = async () => ({ structuredContent: { snapshot: { store: {} } } }) } = {}) {
  const events = new EventTarget()
  globalThis.window = {
    openai: { toolOutput },
    cowartMcp: { callServerTool: read },
    setTimeout, clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  }
}

test('a poll the service answers with unchanged gives upstream nothing to apply', async () => {
  const snapshot = { store: { 'page:a': { id: 'page:a', typeName: 'page' } } }
  let unchanged = false
  host({ toolOutput: { canvasDir: 'shared-canvas' }, read: async () => ({ structuredContent: unchanged ? { unchanged: true } : { snapshot } }) })
  assert.deepEqual(await refreshCowartCanvasSnapshot(), snapshot)
  unchanged = true
  assert.equal(await refreshCowartCanvasSnapshot(), null)
})

test('aborted initial reads never call the server', async () => {
  host({ read: () => assert.fail('aborted read') })
  const controller = new AbortController()
  const loading = loadCowartCanvasState(controller.signal)
  controller.abort()
  await assert.rejects(loading, { name: 'AbortError' })
})
