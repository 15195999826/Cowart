import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { inlineWidget } from '../../../mcp/lib/widget-resource.mjs'
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

test('partial native host updates preserve the active display mode and widget identity', async () => {
  const listeners = new Map()
  class App {
    addEventListener(name, callback) { listeners.set(name, callback) }
    async connect() {}
    getHostContext() { return { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], widgetInstanceId: 'native-one', theme: 'light' } }
  }
  const window = new EventTarget()
  const context = vm.createContext({ window, document: { documentElement: {}, body: {} }, setTimeout, clearTimeout, CustomEvent, __COWART_MCP_APPS__: { App } })
  const html = inlineWidget({ html: '<html><head></head></html>', appVersion: 'test' })
  const script = html.match(/<script id="cowartMcpHostBridge">([\s\S]*?)<\/script>/)[1]
  vm.runInContext(script, context)
  await context.__COWART_MCP_APP__.ready
  listeners.get('hostcontextchanged')({ theme: 'dark', containerDimensions: { width: 1200 } })
  assert.equal(window.openai.displayMode, 'fullscreen')
  assert.equal(window.openai.widgetInstanceId, 'native-one')
  assert.equal(window.openai.hostContext.theme, 'dark')
  assert.equal(window.openai.hostContext.displayMode, 'fullscreen')
  listeners.get('hostcontextchanged')({ displayMode: 'inline' })
  assert.equal(window.openai.displayMode, 'inline', 'an explicit collapse still suspends the canvas')
})
