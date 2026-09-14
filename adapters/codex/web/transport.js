// MCP Apps is the only boundary here: no localhost fetch, credentials, or host UI SDKs.
(() => {
  window.__cowartCreateTransport = ({ config, pane }) => {
    const app = window.__COWART_MCP_APP__
    const nativeApi = { ...window.cowartMcp }
    const ready = app.ready
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
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer) }, { once: true })

    async function invoke(args, timeoutMs = 120000) {
      await ready
      const result = await nativeApi.callServerTool({ name: 'cowart_canvas_app', arguments: { ...args, pane } }, { timeoutMs })
      if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text || 'Cowart 服务调用失败')
      return result.structuredContent
    }

    async function postJson(path, body, timeoutMs) {
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
      async function poll() {
        if (stopped) return
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
        if (!stopped) timer = setTimeout(poll, 1200)
      }
      poll()
    }
    return { ready, nativeApi, postJson, connectEvents }
  }
})()
