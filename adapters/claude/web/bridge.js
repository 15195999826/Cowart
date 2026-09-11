// Claude Code host bridge for the upstream Cowart widget. Upstream injects an MCP Apps
// bridge that exposes window.cowartMcp / window.openai; this provides the same surface
// over the adapter's localhost API, plus a status overlay for canvas requests. The
// features both hosts share (AI 视频, AI 图片, video playback) live in adapters/shared/web.
(() => {
  'use strict'

  const config = window.__COWART_CLAUDE__ || {}
  const TOKEN_HEADER = 'x-cowart-token'
  const FINAL_STATUSES = new Set(['done', 'failed', 'skipped', 'cancelled'])
  const FINAL_TOAST_MS = 12000
  const MAX_TOASTS = 4

  const hostCapabilities = { message: { text: {} }, serverTools: {}, host: 'claude-code' }
  const toolOutput = {
    version: 1,
    widget: 'cowart-canvas-widget',
    title: config.title || 'Cowart Canvas',
    rendering: 'claude-code-local-server',
    projectDir: config.projectDir,
    canvasDir: config.canvasDir,
    preferredDisplayMode: 'fullscreen'
  }

  window.openai = Object.assign(window.openai || {}, {
    toolOutput,
    toolResponseMetadata: {},
    rawToolResult: { structuredContent: toolOutput },
    hostCapabilities,
    hostInfo: { name: 'claude-code', version: config.version || '' },
    displayMode: 'fullscreen',
    availableDisplayModes: ['fullscreen']
  })

  let overlay = null

  async function postJson(path, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: config.token || '' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Cowart 本地服务响应超时。')
      if (overlay) overlay.setServiceOnline(false)
      throw new Error('连不上 Cowart 本地服务：回到 Claude Code 对话里说「打开 Cowart 画布」即可重新连接。')
    } finally {
      clearTimeout(timer)
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `Cowart 本地服务返回 ${response.status}`)
    return payload
  }

  function promptFromMessage(message) {
    if (typeof message === 'string') return message
    if (message && message.prompt) return String(message.prompt)
    if (message && typeof message.content === 'string') return message.content
    if (message && Array.isArray(message.content)) {
      return message.content
        .filter((item) => item && item.type === 'text')
        .map((item) => item.text)
        .join('\n\n')
    }
    return ''
  }

  window.cowartMcp = {
    callServerTool(request, options) {
      return postJson(
        '/api/tools/call',
        { name: request && request.name, arguments: (request && request.arguments) || {} },
        (options && options.timeoutMs) || 120000
      )
    },
    // Canvas messages become queued requests; the shared panels tag theirs with the kind
    // and holder so the overlay can hand the holder back when a request is skipped.
    async sendFollowUpMessage(message) {
      const text = promptFromMessage(message).trim()
      if (!text) throw new Error('Missing follow-up prompt.')
      const tag = (message && message.cowart) || {}
      const payload = await postJson(
        '/api/messages',
        { text, kind: tag.kind, holderShapeId: tag.holderShapeId, projectDir: config.projectDir, canvasDir: config.canvasDir },
        15000
      )
      if (overlay) overlay.upsert(payload.request)
      return {}
    },
    getHostCapabilities() {
      return hostCapabilities
    },
    async updateModelContext() {
      return {}
    },
    async requestDisplayMode() {
      return { mode: 'fullscreen' }
    },
    notifyResize() {}
  }

  function publishGlobals() {
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: window.openai } }))
  }
  publishGlobals()

  function stopCanvasEvents(root) {
    // Keep clicks inside host UI away from tldraw's shortcuts and tools.
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'copy', 'cut', 'paste']) {
      root.addEventListener(type, (event) => event.stopPropagation())
    }
  }

  // ---- Status overlay -----------------------------------------------------------------

  const OVERLAY_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .pill {
      display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px;
      background: rgba(255,255,255,0.96); border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      font-size: 12px; color: #1f2328; white-space: nowrap; pointer-events: auto;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
    .pill.agent .dot { background: #16a34a; }
    .pill.waiting .dot { background: #f59e0b; }
    .pill.offline { color: #b91c1c; }
    .pill.offline .dot { background: #dc2626; }
    .toasts { display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .toast {
      max-width: 420px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.97);
      border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 4px 14px rgba(0,0,0,0.1); font-size: 12px; color: #1f2328;
      pointer-events: auto; line-height: 1.5;
    }
    .toast .head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .toast .title { font-weight: 600; }
    .toast .status { color: #6b7280; white-space: nowrap; }
    .toast.running .status { color: #2f6fed; }
    .toast.done .status { color: #15803d; }
    .toast.failed .status { color: #b91c1c; }
    .toast.cancelled .status { color: #6b7280; }
    .toast .message { margin-top: 2px; color: #374151; word-break: break-all; }
    .toast .cancel {
      flex: none; height: 22px; padding: 0 8px; color: #2f6fed; font-size: 12px; background: #eef4ff; border: 0;
      border-radius: 6px; cursor: pointer;
    }
    .toast .cancel:hover { background: #dbe7ff; }
    .toast .cancel:disabled { color: #9ca3af; background: #f3f4f6; cursor: default; }
  `

  function statusLabel(request) {
    switch (request.status) {
      case 'running':
        return '⚙️ Claude 处理中…'
      case 'done':
        return '✅ 已完成'
      case 'failed':
        return '❌ 失败'
      case 'skipped':
        return '⏭️ 已跳过'
      case 'cancelled':
        return '↩️ 已撤销'
      default:
        return request.delivered ? '👉 请到 Claude 对话里点「执行」' : '📥 已排队，等 Claude 连上'
    }
  }

  function createOverlay() {
    const hostElement = document.createElement('div')
    hostElement.id = 'cowart-claude-overlay'
    hostElement.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483000;pointer-events:none;'
    const root = hostElement.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="wrap">
        <div class="pill"><span class="dot"></span><span class="label">正在连接 Cowart 本地服务…</span></div>
        <div class="toasts"></div>
      </div>`
    document.body.appendChild(hostElement)
    stopCanvasEvents(root)

    const pill = root.querySelector('.pill')
    const pillLabel = root.querySelector('.label')
    const toastList = root.querySelector('.toasts')
    const state = { serviceOnline: null, agentOnline: false, requests: new Map() }

    function renderPill() {
      pill.classList.remove('agent', 'waiting', 'offline')
      if (state.serviceOnline === false) {
        pill.classList.add('offline')
        pillLabel.textContent = 'Cowart 服务未连接：回到 Claude Code 说「打开 Cowart 画布」'
      } else if (state.serviceOnline === null) {
        pillLabel.textContent = '正在连接 Cowart 本地服务…'
      } else if (state.agentOnline) {
        pill.classList.add('agent')
        pillLabel.textContent = 'Claude 已连接'
      } else {
        pill.classList.add('waiting')
        pillLabel.textContent = 'Claude 未在监听 · 请求会排队'
      }
    }

    let shownToasts = ''
    function renderToasts() {
      const now = Date.now()
      const visible = [...state.requests.values()]
        .filter((request) => !FINAL_STATUSES.has(request.status) || now - (request.finishedAt || now) < FINAL_TOAST_MS)
        .sort((a, b) => b.id - a.id)
        .slice(0, MAX_TOASTS)
      // Redraw only on a change, so a click on 撤销 is not lost to the periodic refresh.
      const signature = JSON.stringify(visible.map((request) => [request.id, request.status, request.delivered, request.message]))
      if (signature === shownToasts) return
      shownToasts = signature
      toastList.replaceChildren(
        ...visible.map((request) => {
          const toast = document.createElement('div')
          toast.className = `toast ${request.status}`
          const head = document.createElement('div')
          head.className = 'head'
          const title = document.createElement('span')
          title.className = 'title'
          title.textContent = `#${request.id} ${request.title}`
          const status = document.createElement('span')
          status.className = 'status'
          status.textContent = statusLabel(request)
          head.append(title, status)
          // A request Claude has not started can be withdrawn (a mis-click, second thoughts).
          if (request.status === 'pending') {
            const cancel = document.createElement('button')
            cancel.className = 'cancel'
            cancel.type = 'button'
            cancel.textContent = '撤销'
            cancel.title = '撤回这条还没开始处理的请求'
            cancel.dataset.cancel = String(request.id)
            head.append(cancel)
          }
          toast.append(head)
          const detail = request.message || (request.status === 'pending' ? request.summary : '')
          if (detail) {
            const message = document.createElement('div')
            message.className = 'message'
            message.textContent = detail
            toast.append(message)
          }
          return toast
        })
      )
    }

    function upsert(request) {
      if (!request || typeof request.id !== 'number') return
      const previous = state.requests.get(request.id)
      const finishedAt = FINAL_STATUSES.has(request.status) ? (previous && previous.finishedAt) || Date.now() : null
      state.requests.set(request.id, { ...request, finishedAt })
      // A generation request that will not produce anything hands its holder back.
      if (request.holderShapeId && ['failed', 'skipped', 'cancelled'].includes(request.status) && window.__cowartKit) {
        window.__cowartKit.resetHolderName(request.holderShapeId)
      }
      renderToasts()
    }

    toastList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-cancel]')
      if (!button) return
      button.disabled = true
      try {
        const payload = await postJson('/api/requests/cancel', { id: Number(button.dataset.cancel) }, 10000)
        upsert(payload.request)
      } catch (error) {
        button.disabled = false
        button.textContent = '撤销失败'
        button.title = error instanceof Error ? error.message : String(error)
      }
    })

    setInterval(renderToasts, 2000)
    renderPill()

    return {
      upsert,
      setServiceOnline(online) {
        state.serviceOnline = online
        renderPill()
      },
      setAgentOnline(online) {
        state.agentOnline = online
        renderPill()
      }
    }
  }

  function connectEvents() {
    const source = new EventSource(`/api/page-events?token=${encodeURIComponent(config.token || '')}`)
    source.onopen = () => overlay.setServiceOnline(true)
    source.onerror = () => overlay.setServiceOnline(false)
    source.addEventListener('presence', (event) => overlay.setAgentOnline(Boolean(JSON.parse(event.data).agentOnline)))
    source.addEventListener('requests', (event) => {
      for (const request of JSON.parse(event.data).requests || []) overlay.upsert(request)
    })
    source.addEventListener('request', (event) => overlay.upsert(JSON.parse(event.data)))
  }

  function start() {
    overlay = createOverlay()
    connectEvents()
    publishGlobals()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
