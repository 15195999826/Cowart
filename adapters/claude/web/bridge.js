// Claude Code host bridge for the upstream Cowart widget. Upstream injects an MCP Apps
// bridge that exposes window.cowartMcp / window.openai; this provides the same surface
// over the adapter's localhost API, plus a small status overlay and a video action.
(() => {
  'use strict'

  const config = window.__COWART_CLAUDE__ || {}
  const TOKEN_HEADER = 'x-cowart-token'
  const FINAL_STATUSES = new Set(['done', 'failed', 'skipped'])
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
    async sendFollowUpMessage(message) {
      const text = promptFromMessage(message).trim()
      if (!text) throw new Error('Missing follow-up prompt.')
      const payload = await postJson('/api/messages', { text, projectDir: config.projectDir, canvasDir: config.canvasDir }, 15000)
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

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .bar { display: flex; gap: 6px; pointer-events: auto; }
    .pill, .video-btn {
      display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px;
      background: rgba(255,255,255,0.96); border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      font-size: 12px; color: #1f2328; white-space: nowrap;
    }
    .video-btn { cursor: pointer; }
    .video-btn:hover { background: #f3f4f6; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
    .pill.agent .dot { background: #16a34a; }
    .pill.waiting .dot { background: #f59e0b; }
    .pill.offline { color: #b91c1c; }
    .pill.offline .dot { background: #dc2626; }
    .panel {
      width: 340px; padding: 12px; border-radius: 12px; background: #fff; border: 1px solid rgba(0,0,0,0.12);
      box-shadow: 0 8px 24px rgba(0,0,0,0.14); pointer-events: auto; font-size: 13px; color: #1f2328;
    }
    .panel[hidden], .error[hidden] { display: none; }
    .panel-title { font-weight: 600; margin-bottom: 6px; }
    .source { font-size: 12px; color: #6b7280; margin-bottom: 8px; line-height: 1.5; }
    textarea {
      width: 100%; min-height: 72px; resize: vertical; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 13px; color: #1f2328; outline: none;
    }
    textarea:focus { border-color: #2f6fed; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .actions button { height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-size: 13px; }
    .actions .send { background: #2f6fed; border-color: #2f6fed; color: #fff; }
    .actions button:disabled { opacity: 0.5; cursor: default; }
    .error { margin-top: 8px; color: #b91c1c; font-size: 12px; }
    .toasts { display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .toast {
      max-width: 420px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.97);
      border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 4px 14px rgba(0,0,0,0.1); font-size: 12px; color: #1f2328;
      pointer-events: auto; line-height: 1.5;
    }
    .toast .head { display: flex; gap: 8px; justify-content: space-between; }
    .toast .title { font-weight: 600; }
    .toast .status { color: #6b7280; white-space: nowrap; }
    .toast.running .status { color: #2f6fed; }
    .toast.done .status { color: #15803d; }
    .toast.failed .status { color: #b91c1c; }
    .toast .message { margin-top: 2px; color: #374151; word-break: break-all; }
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
      default:
        return request.delivered ? '👉 请到 Claude 对话里点「执行」' : '📥 已排队，等 Claude 连上'
    }
  }

  function selectedImageShape() {
    const editor = window.__cowartEditor
    const shapes = editor && typeof editor.getSelectedShapes === 'function' ? editor.getSelectedShapes() : []
    return shapes.length === 1 && shapes[0].type === 'image' ? shapes[0] : null
  }

  function createOverlay() {
    const hostElement = document.createElement('div')
    hostElement.id = 'cowart-claude-overlay'
    hostElement.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483000;pointer-events:none;'
    const root = hostElement.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="bar">
          <div class="pill"><span class="dot"></span><span class="label">正在连接 Cowart 本地服务…</span></div>
          <button class="video-btn" type="button" title="让 Claude 生成视频：选中一张图片就是图生视频，否则按文字生成">🎬 视频</button>
        </div>
        <div class="panel" hidden>
          <div class="panel-title">🎬 生成视频</div>
          <div class="source"></div>
          <textarea placeholder="描述想要的画面和运动，比如：镜头缓慢推近，角色转身挥手"></textarea>
          <div class="actions"><button type="button" class="cancel">取消</button><button type="button" class="send">发给 Claude</button></div>
          <div class="error" hidden></div>
        </div>
        <div class="toasts"></div>
      </div>`
    document.body.appendChild(hostElement)

    const pill = root.querySelector('.pill')
    const pillLabel = root.querySelector('.label')
    const panel = root.querySelector('.panel')
    const sourceLabel = root.querySelector('.source')
    const textarea = root.querySelector('textarea')
    const sendButton = root.querySelector('.send')
    const errorLabel = root.querySelector('.error')
    const toastList = root.querySelector('.toasts')

    // Keep typing and clicks inside the overlay away from tldraw's shortcuts and tools.
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'wheel', 'copy', 'cut', 'paste']) {
      root.addEventListener(type, (event) => event.stopPropagation())
    }

    const state = { serviceOnline: null, agentOnline: false, requests: new Map(), videoSource: null }

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

    function renderToasts() {
      const now = Date.now()
      const visible = [...state.requests.values()]
        .filter((request) => !FINAL_STATUSES.has(request.status) || now - (request.finishedAt || now) < FINAL_TOAST_MS)
        .sort((a, b) => b.id - a.id)
        .slice(0, MAX_TOASTS)
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
      const finishedAt =
        FINAL_STATUSES.has(request.status) ? (previous && previous.finishedAt) || Date.now() : null
      state.requests.set(request.id, { ...request, finishedAt })
      renderToasts()
    }

    function openPanel() {
      const shape = selectedImageShape()
      state.videoSource = shape ? shape.id : null
      sourceLabel.textContent = shape
        ? `图生视频：以选中的图片为素材（${shape.id}），结果放在原图右侧。`
        : '文生视频：没有选中单张图片。想用图生视频，先在画布里选中一张图片再点 🎬。'
      errorLabel.hidden = true
      panel.hidden = false
      textarea.focus()
    }

    function closePanel() {
      panel.hidden = true
    }

    async function sendVideoRequest() {
      const prompt = textarea.value.trim()
      if (!prompt) {
        errorLabel.textContent = '先写一句视频描述。'
        errorLabel.hidden = false
        return
      }
      sendButton.disabled = true
      try {
        const payload = await postJson(
          '/api/requests/video',
          { shapeId: state.videoSource, prompt, projectDir: config.projectDir, canvasDir: config.canvasDir },
          20000
        )
        upsert(payload.request)
        textarea.value = ''
        closePanel()
      } catch (error) {
        errorLabel.textContent = error.message
        errorLabel.hidden = false
      } finally {
        sendButton.disabled = false
      }
    }

    root.querySelector('.video-btn').addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()))
    root.querySelector('.cancel').addEventListener('click', closePanel)
    sendButton.addEventListener('click', sendVideoRequest)
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendVideoRequest()
      if (event.key === 'Escape') closePanel()
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
