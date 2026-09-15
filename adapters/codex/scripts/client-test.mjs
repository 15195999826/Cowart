import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCowartCanvasState } from '../../../src/cowartClient.js'

function host({ target, read = async () => ({ structuredContent: { snapshot: { store: {} } } }) } = {}) {
  const events = new EventTarget()
  globalThis.window = {
    openai: { toolOutput: {} },
    cowartMcp: { callServerTool: read, ...(target ? { getStorageTarget: () => target } : {}) },
    setTimeout, clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  }
  return () => events.dispatchEvent(new Event('openai:set_globals'))
}

test('initialization survives unrelated globals before storage arrives', async () => {
  const emit = host()
  const loading = loadCowartCanvasState()
  emit()
  window.openai.toolOutput = { canvasDir: 'correct-canvas' }
  emit()
  assert.deepEqual((await loading).snapshot, { store: {} })
})

test('adapter storage is not replaced by an error or historical tool result', async () => {
  let args
  host({ target: { canvasDir: 'shared-canvas' }, read: async (request) => {
    args = request.arguments
    return { structuredContent: { snapshot: { store: {} } } }
  } })
  window.openai.toolOutput = { isError: true, canvasDir: 'old-project-canvas' }
  await loadCowartCanvasState()
  assert.equal(args.canvasDir, 'shared-canvas')
})

test('aborted initial reads never call the server', async () => {
  host({ read: () => assert.fail('aborted read') })
  const controller = new AbortController()
  const loading = loadCowartCanvasState(controller.signal)
  controller.abort()
  await assert.rejects(loading, { name: 'AbortError' })
})
