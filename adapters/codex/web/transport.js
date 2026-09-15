// MCP Apps is the only boundary here: no localhost fetch, credentials, or host UI SDKs.
(() => {
  window.__cowartCreateTransport = ({ config, pane }) => {
    const app = window.__COWART_MCP_APP__
    const nativeApi = { ...window.cowartMcp }
    const ready = app.ready
    let active = false
    let bootstrapDone = false
    let onActivity = () => {}
    const activeWaiters = new Set()
    const bootstraps = new Set()
    window.openai = window.openai || {}
    window.openai.openExternal = async ({ href }) => {
      await ready
      return app.openLink({ url: href })
    }
    const pending = new Map()
    const sent = new Set()
    let stopped = false
    let cursor = null
    let timer = null
    function updateActivity() {
      // The MCP Apps SDK owns the merged context. Compatibility globals may
      // still come from an older bridge that publishes partial notifications.
      const mode = app.getHostContext?.()?.displayMode ?? window.openai?.displayMode
      const next = !stopped && !document.hidden && mode === 'fullscreen'
      if (active === next) return
      if (!next) window.__cowartFlushView?.().catch(() => {})
      active = next
      window.dispatchEvent(new CustomEvent('cowart:activity', { detail: { active } }))
      if (active) for (const resolve of [...activeWaiters]) resolve()
      onActivity()
    }

    function waitUntilActive(signal) {
      if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
      if (active && bootstrapDone) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const finish = () => {
          if (!active || !bootstrapDone) return
          cleanup(); resolve()
        }
        const abort = () => { cleanup(); reject(new DOMException('The operation was aborted.', 'AbortError')) }
        const cleanup = () => { activeWaiters.delete(finish); signal?.removeEventListener('abort', abort) }
        activeWaiters.add(finish)
        signal?.addEventListener('abort', abort, { once: true })
        finish()
      })
    }

    async function bootstrap() {
      await ready
      updateActivity()
      bootstrapDone = true
      for (const resolve of [...activeWaiters]) resolve()
      const payload = window.openai?.toolOutput
      const renderId = payload?.widget === 'cowart-canvas-widget' && payload.renderId
      if (!renderId || bootstraps.has(renderId)) return
      bootstraps.add(renderId)
      try {
        const { autoExpand } = await invoke({ op: 'bootstrap', renderId }, 15000)
        if (autoExpand && !active) await nativeApi.requestDisplayMode('fullscreen')
      } catch { bootstraps.delete(renderId) }
      updateActivity()
    }
    window.addEventListener('openai:set_globals', () => { updateActivity(); bootstrap().catch(() => {}) })
    document.addEventListener('visibilitychange', updateActivity)
    window.addEventListener('pagehide', () => { window.__cowartFlushView?.().catch(() => {}); stopped = true; clearTimeout(timer); updateActivity() })
    window.addEventListener('pageshow', () => { stopped = false; updateActivity() })
    app.onteardown = async () => {
      await Promise.allSettled([window.__cowartFlushView?.(), window.__cowartKit?.saveCanvasNow?.()])
      stopped = true; clearTimeout(timer); updateActivity()
      return {}
    }
    bootstrap().catch(() => {})

    async function invoke(args, timeoutMs = 120000) {
      await ready
      const result = await nativeApi.callServerTool({ name: 'cowart_canvas_app', arguments: { ...args, pane } }, { timeoutMs })
      if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text || 'Cowart 服务调用失败')
      return result.structuredContent
    }

    async function postJson(path, body, timeoutMs) {
      // Reads may wait for a visible canvas. Writes already initiated by the user
      // and the final state flush must finish even while the host tears it down.
      if (path === '/api/tools/call' && ['get_cowart_canvas_state', 'read_cowart_page_asset'].includes(body?.name)) await waitUntilActive()
      const { status, payload } = await invoke({ op: 'call', path, body }, timeoutMs)
      if (status >= 400) throw Object.assign(new Error(payload.error || `Cowart ${status}`), { status, payload })
      return payload
    }

    async function deliver(request) {
      const key = request.requestKey || request.id
      if (request.session !== config.session || request.executor === 'service' || request.status !== 'pending' || request.delivered || pending.has(key)) return
      const run = (async () => {
        const claimed = await postJson('/api/requests/claim', { id: request.id, requestKey: request.requestKey }, 15000)
        if (!claimed.request) return
        try {
          // A successful ui/message is never repeated by this widget if its acknowledgement
          // is lost. The service lease prevents two widgets sending the same request at once.
          if (!sent.has(key)) {
            await nativeApi.sendFollowUpMessage({ prompt: `Cowart 画布请求 #${request.id}：${request.title}\n请先用 get_cowart_request({id:${request.id},requestKey:"${claimed.request.requestKey}"}) 读取完整要求、pageId 和状态；已完成或撤销则不重复执行。reply_cowart_request 同样传入这个 requestKey，执行前标记 running，完成后标记 done/failed。` })
            sent.add(key)
          }
          await postJson('/api/requests/delivered', { id: request.id, deliveryToken: claimed.request.deliveryToken }, 15000)
        } catch (error) {
          await postJson('/api/requests/release', { id: request.id, deliveryToken: claimed.request.deliveryToken }, 15000).catch(() => {})
          throw error
        }
      })()
      pending.set(key, run)
      try { await run } finally { pending.delete(key) }
    }

    function connectEvents(onEvent, onOnline) {
      let polling = false
      async function poll() {
        clearTimeout(timer)
        if (stopped || !active || polling) return
        polling = true
        try {
          const result = await invoke({ op: 'poll', cursor }, 20000)
          onOnline(true)
          for (const item of result.events || []) {
            onEvent(item.event, item.data)
            if (item.event === 'requests') for (const request of item.data.requests || []) deliver(request).catch(() => {})
            if (item.event === 'request') deliver(item.data).catch(() => {})
          }
          cursor = result.cursor
        } catch { onOnline(false) }
        finally { polling = false }
        if (!stopped && active) timer = setTimeout(poll, 1200)
      }
      onActivity = () => { clearTimeout(timer); if (active) timer = setTimeout(poll, 0) }
      poll()
    }
    return { ready, nativeApi, postJson, connectEvents, waitUntilActive, isActive: () => active }
  }
})()
