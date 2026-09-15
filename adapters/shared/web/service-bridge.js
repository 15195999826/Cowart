// Shared service-backed page lifecycle: delta saves, page responsibility and request UI.
(() => {
  'use strict'

  const config = window.__COWART_SERVICE_PAGE__ || window.__COWART_CLAUDE__ || {}
  // Wording per host (the service sets hostLabel for non-Claude hosts, say ZCode).
  const HOST_LABEL = config.hostLabel || 'Claude Code'
  const AGENT_LABEL = config.hostLabel || 'Claude'
  const TOKEN_HEADER = 'x-cowart-token'
  const PANE_HEADER = 'x-cowart-pane'
  // This page load.
  const PANE = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const hostLabel = config.host === 'codex' ? 'Codex' : 'Claude'
  const transport = window.__cowartCreateTransport?.({ config, pane: PANE }) || null
  const FINAL_STATUSES = new Set(['done', 'failed', 'skipped', 'cancelled'])
  const FINAL_TOAST_MS = 12000
  const MAX_TOASTS = 4
  const RESTART_WAIT_MS = 20000
  const PAGE_CHECK_MS = 400

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

  if (!transport) window.openai = Object.assign(window.openai || {}, {
    toolOutput,
    toolResponseMetadata: {},
    rawToolResult: { structuredContent: toolOutput },
    hostCapabilities,
    hostInfo: { name: 'claude-code', version: config.version || '' },
    displayMode: 'fullscreen',
    availableDisplayModes: ['fullscreen']
  })

  if (transport) {
    window.openai = window.openai || {}
    window.openai.toolOutput = { ...toolOutput, ...config, rendering: 'native-widget' }
  }

  let overlay = null

  async function postJson(path, body, timeoutMs) {
    if (transport) return transport.postJson(path, body, timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: config.token || '', [PANE_HEADER]: PANE },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Cowart 本地服务响应超时。')
      if (overlay) overlay.setServiceOnline(false)
      throw new Error(`连不上 Cowart 本地服务：回到 ${HOST_LABEL} 对话里说「打开 Cowart 画布」即可重新连接。`)
    } finally {
      clearTimeout(timer)
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(payload.error || `Cowart 本地服务返回 ${response.status}`), { status: response.status, payload })
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

  // ---- Delta saves -----------------------------------------------------------------------
  // Upstream saves the whole canvas it holds in memory and, while it has unsaved changes,
  // leaves remote changes unapplied; two pages editing the same canvas would overwrite each
  // other. This page remembers, per record, the last version the stored canvas and its own
  // store agreed on, and a save carries only the records that differ (and the ids that are
  // gone). The service lays that over the stored canvas.

  const sync = (() => {
    let editor = null
    let lastFetched = null
    // record id → stable JSON of the version the stored canvas agreed with.
    const base = new Map()

    function stable(value) {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
      if (value && typeof value === 'object') {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
          .join(',')}}`
      }
      const json = JSON.stringify(value)
      return json === undefined ? 'null' : json
    }

    function attach(found) {
      editor = found
      if (lastFetched) note(lastFetched)
    }

    // A fetched snapshot, right after upstream applied it: every record the store agrees
    // with is common ground; records gone from both sides are forgotten.
    function note(snapshot) {
      lastFetched = snapshot
      if (!editor || !snapshot || !snapshot.store) return
      for (const [id, record] of Object.entries(snapshot.store)) {
        const local = editor.store.get(id)
        if (!local) continue
        const remote = stable(record)
        if (stable(local) === remote) base.set(id, remote)
      }
      for (const id of [...base.keys()]) {
        if (!snapshot.store[id] && !editor.store.get(id)) base.delete(id)
      }
    }

    function delta(snapshot) {
      if (!snapshot || !snapshot.store) return null
      const put = []
      const remove = []
      const values = new Map()
      for (const [id, record] of Object.entries(snapshot.store)) {
        const current = stable(record)
        if (base.get(id) === current) continue
        put.push(record)
        values.set(id, current)
      }
      for (const id of base.keys()) if (!snapshot.store[id]) remove.push(id)
      return {
        put,
        remove,
        commit() {
          for (const [id, value] of values) base.set(id, value)
          for (const id of remove) base.delete(id)
        }
      }
    }

    return { attach, note, delta }
  })()

  // ---- Pages ---------------------------------------------------------------------------
  // Which page this pane shows (a default for its session's writes), which page its session
  // is responsible for, and who is responsible for the page on screen.

  const pages = (() => {
    let editor = null
    let loaded = false
    let snapshotArrived = false
    let connected = false
    let reported = null
    // From the service: { pages: { [pageId]: { holder } }, names: { [session]: name } }
    let state = null
    // A page the session entered while this pane was open (goto-page), shown once it synced.
    let pendingGoto = null
    // Pages this pane has shown: tldraw remembers their cameras, new ones get fitted to content.
    const visited = new Set()
    let restoredPageId = null

    window.addEventListener('cowart:canvas-ready', ({ detail }) => {
      editor = detail.editor
      sync.attach(editor)
      finishInitialLoad()
      applyRole()
    })

    function randomPageId() {
      return `page:${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
    }

    // The page to open: the one this pane's session is responsible for, else where the URL
    // says (the page it showed before a reload), else a page by name (older URLs; the service
    // creates the pages it hands to sessions).
    function requestedPage() {
      const all = editor.getPages()
      for (const id of [restoredPageId, config.heldPageId, config.pageId]) {
        const page = id && all.find((entry) => entry.id === id)
        if (page) return page
      }
      return (config.page && all.find((entry) => entry.name === config.page)) || null
    }

    function show(pageId) {
      if (editor.getCurrentPageId() !== pageId) editor.setCurrentPage(pageId)
      if (!visited.has(pageId) && editor.getCurrentPageShapeIds().size > 0) editor.zoomToFit({ animation: { duration: 0 } })
      visited.add(pageId)
    }

    function openRequestedPage() {
      let target = requestedPage()
      if (!target && config.page) {
        const id = randomPageId()
        editor.createPage({ id, name: config.page })
        target = editor.getPage(id)
      }
      if (target) show(target.id)
    }

    // Upstream restores the view saved last (one per canvas, from whichever pane saved it) on
    // its first animation frame, which a hidden Browser pane only gets once it is shown: the
    // pane would jump back to that page long after opening the requested one. So when the
    // URL asks for a page, the saved view only stays if it is of that very page.
    function adjustFirstView(structured) {
      const store = structured && structured.snapshot && structured.snapshot.store
      if (structured?.sessionViewState && store?.[structured.viewState?.currentPageId]) {
        restoredPageId = structured.viewState.currentPageId
        visited.add(restoredPageId)
        pendingGoto = null
        return
      }
      if (!store || !(config.heldPageId || config.pageId || config.page)) return
      const byName = config.page && Object.values(store).find((record) => record && record.typeName === 'page' && record.name === config.page)
      const wanted = [config.heldPageId, config.pageId].find((id) => id && store[id]) || (byName && byName.id) || null
      const saved = structured.viewState && structured.viewState.currentPageId
      if (!wanted || saved !== wanted) structured.viewState = null
      else visited.add(wanted)
    }

    function goTo(pageId, initial = false) {
      if (initial && restoredPageId) return
      if (!initial) restoredPageId = null
      pendingGoto = pageId
      check()
    }

    function canvasLoaded() {
      snapshotArrived = true
      finishInitialLoad()
    }

    function finishInitialLoad() {
      if (loaded || !snapshotArrived || !editor) return
      loaded = true
      openRequestedPage()
      check()
    }

    function send(pageId) {
      const page = editor.getPage(pageId)
      postJson('/api/panes/page', { pane: PANE, pageId, pageName: page ? page.name : null }, 8000).catch(() => {})
    }

    function syncUrl(pageId) {
      try {
        const url = new URL(window.location.href)
        if (url.searchParams.get('pageId') === pageId) return
        url.searchParams.set('pageId', pageId)
        url.searchParams.delete('page')
        window.history.replaceState(window.history.state, '', url)
      } catch {
        // Without it a reload opens the page the canvas saved last.
      }
    }

    function check() {
      if (!editor || !loaded) return
      if (pendingGoto && editor.getPage(pendingGoto)) {
        const target = pendingGoto
        pendingGoto = null
        show(target)
      }
      const pageId = editor.getCurrentPageId()
      visited.add(pageId)
      if (pageId !== reported) {
        reported = pageId
        syncUrl(pageId)
        if (connected) send(pageId)
      }
      applyRole()
    }
    setInterval(check, PAGE_CHECK_MS)

    function setConnected(online) {
      connected = online
      if (online && reported) send(reported)
    }

    function names() {
      return (state && state.names) || {}
    }

    function applyRole() {
      if (!editor || !overlay) return
      const known = names()
      const held = state && state.pages ? Object.keys(state.pages).find((pageId) => state.pages[pageId].holder === config.session) : null
      const heldPage = held ? editor.getPage(held) : null
      const pageId = editor.getCurrentPageId()
      const holder = state && state.pages && state.pages[pageId] ? state.pages[pageId].holder : null
      overlay.setRole({
        myName: known[config.session] || null,
        myPage: held ? (heldPage ? heldPage.name : held) : null,
        thisPage: { mine: holder === config.session, holderName: holder ? known[holder] || '另一个会话' : null }
      })
    }

    function setState(next) {
      if (editor && Array.isArray(next.allPageIds)) removePages(editor.getPages().map((page) => page.id).filter((id) => !next.allPageIds.includes(id)))
      state = next
      applyRole()
    }

    // Pages the user deleted in another pane.
    function removePages(pageIds) {
      if (!editor) return
      const gone = pageIds.filter((id) => editor.getPage(id))
      if (gone.length === 0 || gone.length >= editor.getPages().length) return
      editor.store.mergeRemoteChanges(() => {
        if (gone.includes(editor.getCurrentPageId())) {
          const other = editor.getPages().find((page) => !gone.includes(page.id))
          if (other) editor.setCurrentPage(other.id)
        }
        for (const id of gone) editor.deletePage(id)
      })
    }

    function current() {
      if (!editor) return { pageId: null, pageName: null }
      const pageId = editor.getCurrentPageId()
      const page = editor.getPage(pageId)
      return { pageId, pageName: page ? page.name : null }
    }

    // This pane's session takes the page on screen.
    async function enter() {
      return postJson('/api/pages/enter', { pane: PANE }, 8000)
    }

    return { canvasLoaded, adjustFirstView, goTo, setConnected, setState, removePages, current, enter, applyRole, names }
  })()

  let firstStateSeen = false

  function installApi() {
  window.cowartMcp = {
    ...(transport?.nativeApi || {}),
    getStorageTarget: () => ({ projectDir: config.projectDir, canvasDir: config.canvasDir }),
    ...(transport ? { waitUntilActive: transport.waitUntilActive, isActive: transport.isActive } : {}),
    async callServerTool(request, options) {
      const name = request && request.name
      let args = (request && request.arguments) || {}
      let delta = null
      if (transport && name === 'save_cowart_view_state') {
        if (!transport.isActive()) return { structuredContent: { ok: true, inactive: true } }
        args = { ...args, viewState: { ...args.viewState, cowartPlayback: window.__cowartVideoState?.capture() } }
      }
      if (name === 'save_cowart_canvas_state') {
        delta = sync.delta(args.snapshot)
        if (delta) args = { ...args, cowartDelta: { put: delta.put, remove: delta.remove } }
      }
      const read = (input) => postJson('/api/tools/call', { name, arguments: input }, (options && options.timeoutMs) || 120000)
      const result = transport && name === 'read_cowart_page_asset' && /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(args.assetUrl || '')
        ? await window.__cowartReadCachedVideo(args, read)
        : await read(args)
      if (name === 'read_cowart_page_asset' && !result.isError && result.structuredContent?.nextOffset != null) {
        const parts = [result.structuredContent.dataBase64]
        let next = result.structuredContent.nextOffset
        while (next != null) {
          const chunk = await postJson('/api/tools/call', { name, arguments: { ...args, offset: next } }, 120000)
          if (chunk.isError) return chunk
          if (chunk.structuredContent.nextOffset != null && chunk.structuredContent.nextOffset <= next) throw new Error('视频读取未能继续。')
          parts.push(chunk.structuredContent.dataBase64)
          next = chunk.structuredContent.nextOffset
        }
        result.structuredContent = { ...result.structuredContent, dataBase64: parts.join(''), nextOffset: null }
      }
      if (delta && !result.isError && (result.structuredContent || {}).ok !== false) delta.commit()
      if (name === 'get_cowart_canvas_state' && !result.isError) {
        if (!firstStateSeen) {
          firstStateSeen = true
          pages.adjustFirstView(result.structuredContent)
          window.__cowartVideoState?.restore(result.structuredContent?.viewState?.cowartPlayback)
        }
        pages.canvasLoaded()
        // Upstream applies the snapshot as soon as this returns; look at what it kept then.
        const snapshot = (result.structuredContent || {}).snapshot
        setTimeout(() => sync.note(snapshot), 0)
      }
      return result
    },
    // Canvas messages become queued requests for the session responsible for the page
    // they were sent from; the shared panels tag theirs with the kind and holder so the
    // overlay can hand the holder back when a request is skipped.
    async sendFollowUpMessage(message) {
      const text = promptFromMessage(message).trim()
      if (!text) throw new Error('Missing follow-up prompt.')
      const tag = (message && message.cowart) || {}
      const { pageId, pageName } = tag.pageId ? tag : pages.current()
      const payload = await postJson(
        '/api/messages',
        {
          text,
          kind: tag.kind,
          requiredHost: tag.requiredHost,
          holderShapeId: tag.holderShapeId,
          session: config.session,
          pane: PANE,
          pageId,
          pageName,
          projectDir: config.projectDir,
          canvasDir: config.canvasDir
        },
        15000
      )
      if (overlay) overlay.upsert(payload.request)
      return { request: payload.request, recipient: pages.names()[payload.request.session] || '负责会话' }
    },
    // AI 图片 / AI 视频: the canvas service generates on the click (no request to Claude).
    // An error with `fallback` means it cannot here: the panel sends the request instead.
    async startGeneration(args) {
      const { pageId, pageName } = pages.current()
      try {
        const payload = await postJson('/api/generations', { ...args, pageId, pageName }, 60000)
        if (overlay) overlay.upsert(payload.request)
        return payload.request
      } catch (error) {
        if (error && error.payload && error.payload.fallback) error.fallback = true
        throw error
      }
    },
    getHostCapabilities() {
      return transport ? transport.nativeApi.getHostCapabilities() : hostCapabilities
    },
    async updateModelContext(...args) {
      return transport ? transport.nativeApi.updateModelContext(...args) : {}
    },
    async requestDisplayMode(...args) {
      return transport ? transport.nativeApi.requestDisplayMode(...args) : { mode: 'fullscreen' }
    },
    notifyResize() { transport?.nativeApi.notifyResize?.() }
  }
  }
  installApi()
  transport?.ready.then(installApi).catch(() => {})

  // View/media state is session-local and flushes before native sandbox teardown.
  if (transport) {
    window.__cowartFlushView = async () => {
      if (!window.__cowartEditor || !transport.isActive() || !firstStateSeen) return
      const viewState = { ...window.__cowartViewState(), cowartPlayback: window.__cowartVideoState?.capture(), updatedAt: new Date().toISOString() }
      await postJson('/api/tools/call', { name: 'save_cowart_view_state', arguments: { viewState } }, 8000)
    }
    setInterval(() => window.__cowartFlushView().catch(() => {}), 1000)
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
    [hidden] { display: none !important; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .pill {
      display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px;
      background: rgba(255,255,255,0.96); border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      font-size: 12px; color: #1f2328; white-space: nowrap; pointer-events: auto;
    }
    .pill .me { font-weight: 700; color: #2f6fed; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
    .pill.agent .dot { background: #16a34a; }
    .pill.waiting .dot { background: #f59e0b; }
    .pill.offline { color: #b91c1c; }
    .pill.offline .dot { background: #dc2626; }
    .pill.outdated { cursor: pointer; color: #92400e; }
    .pill.outdated .dot { background: #f59e0b; }
    .page {
      display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 4px 0 12px; border-radius: 999px;
      background: rgba(255,255,255,0.92); border: 1px solid rgba(0,0,0,0.08); font-size: 12px; color: #4b5563;
      white-space: nowrap; pointer-events: auto;
    }
    .page .holder { font-weight: 700; color: #c2410c; }
    .enter {
      height: 20px; padding: 0 10px; color: #fff; font-size: 12px; background: #2f6fed; border: 0;
      border-radius: 999px; cursor: pointer;
    }
    .enter:hover { background: #1d5bd8; }
    .enter:disabled { background: #9ca3af; cursor: default; }
    .toasts { display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .toast {
      max-width: 420px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.97);
      border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 4px 14px rgba(0,0,0,0.1); font-size: 12px; color: #1f2328;
      pointer-events: auto; line-height: 1.5;
    }
    .toast .head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .toast .title { font-weight: 600; }
    .toast .title .to { font-weight: 400; color: #c2410c; }
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

  function createOverlay() {
    const hostElement = document.createElement('div')
    hostElement.id = config.host === 'codex' ? 'cowart-codex-overlay' : 'cowart-claude-overlay'
    hostElement.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483000;pointer-events:none;'
    const root = hostElement.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="wrap">
        <div class="pill"><span class="dot"></span><span class="label">正在连接 Cowart 本地服务…</span></div>
        <div class="page" hidden>
          <span class="page-label"></span>
          <button class="enter" type="button" hidden title="这一页的 AI 请求改由这个会话处理"></button>
        </div>
        <div class="toasts"></div>
      </div>`
    document.body.appendChild(hostElement)
    stopCanvasEvents(root)

    const pill = root.querySelector('.pill')
    const pillLabel = root.querySelector('.label')
    const pageLine = root.querySelector('.page')
    const pageLabel = root.querySelector('.page-label')
    const enterButton = root.querySelector('.enter')
    const toastList = root.querySelector('.toasts')
    // session: online (its Claude session is connected) / waiting (reconnecting) / ended.
    // role: { myName, myPage, thisPage: { mine, holderName } }.
    const state = {
      serviceOnline: null,
      restarting: false,
      outdated: false,
      session: 'online',
      agentOnline: false,
      role: null,
      requests: new Map()
    }
    let restartTimer = null

    function me() {
      return (state.role && state.role.myName) || AGENT_LABEL
    }

    function pillState() {
      if (state.serviceOnline === false) {
        return state.restarting
          ? ['waiting', '画布服务在重启，正在重新连接…']
          : ['offline', `Cowart 服务未连接：回到 ${HOST_LABEL} 说「打开 Cowart 画布」`]
      }
      if (state.serviceOnline === null) return ['', '正在连接 Cowart 本地服务…']
      if (state.outdated) return ['outdated', '画布服务已更新：点这里刷新页面']
      const name = me()
      if (state.session === 'ended') return ['offline', `${name} 的会话已结束：回到 ${HOST_LABEL} 重新打开画布才能接上`, name]
      if (state.session === 'waiting') return ['waiting', `${name} · 等 ${AGENT_LABEL} 会话重新连上…`, name]
      const duty = state.role && state.role.myPage ? `负责「${state.role.myPage}」` : '没负责任何页'
      if (!state.agentOnline) return ['waiting', `${name} · ${duty} · ${AGENT_LABEL} 未在监听 · 请求会排队`, name]
      return ['agent', `${name} · ${duty} · ${AGENT_LABEL} 已连接`, name]
    }

    function renderPill() {
      const [kind, text, name] = pillState()
      pill.classList.remove('agent', 'waiting', 'offline', 'outdated')
      if (kind) pill.classList.add(kind)
      pillLabel.replaceChildren()
      if (name && text.startsWith(name)) {
        const strong = document.createElement('span')
        strong.className = 'me'
        strong.textContent = name
        pillLabel.append(strong, document.createTextNode(text.slice(name.length)))
      } else {
        pillLabel.textContent = text
      }
      renderPageLine()
    }

    // Who is responsible for the page on screen, when it is not this pane's session.
    function renderPageLine() {
      const role = state.role
      const show = state.serviceOnline === true && !state.outdated && role && !role.thisPage.mine
      pageLine.hidden = !show
      if (!show) return
      pageLabel.replaceChildren()
      if (role.thisPage.holderName) {
        const holder = document.createElement('span')
        holder.className = 'holder'
        holder.textContent = role.thisPage.holderName
        pageLabel.append(document.createTextNode('这一页由'), holder, document.createTextNode('负责'))
      } else {
        pageLabel.textContent = '这一页还没人负责'
      }
      const canEnter = state.session !== 'ended'
      enterButton.hidden = !canEnter
      enterButton.textContent = role.thisPage.holderName ? `换成${me()}` : `${me()}来负责`
    }

    pill.addEventListener('click', () => {
      if (state.outdated) window.location.reload()
    })

    enterButton.addEventListener('click', async () => {
      enterButton.disabled = true
      try {
        await pages.enter()
        enterButton.title = '这一页的 AI 请求改由这个会话处理'
      } catch (error) {
        enterButton.title = error instanceof Error ? error.message : String(error)
      } finally {
        enterButton.disabled = false
      }
    })

    function sessionName(session) {
      return pages.names()[session] || '另一个会话'
    }

    function statusLabel(request) {
      if (request.executor === 'service') {
        switch (request.status) {
          case 'running':
            return `⚙️ ${request.message || '生成中…'}`
          case 'done':
            return '✅ 完成'
          case 'failed':
            return '❌ 没成功'
          case 'cancelled':
            return '↩️ 已撤销'
          default:
            return '⏳ 准备中…'
        }
      }
      switch (request.status) {
        case 'running':
          return `⚙️ ${sessionName(request.session)}处理中…`
        case 'done':
          return '✅ 已完成'
        case 'failed':
          return '❌ 失败'
        case 'skipped':
          return '⏭️ 已跳过'
        case 'cancelled':
          return '↩️ 已撤销'
        default:
          if (!request.delivered) return `📥 已排队，等${sessionName(request.session)}连上`
          return request.session === config.session
            ? transport ? '📨 已发送给 Codex' : `👉 请到 ${HOST_LABEL} 对话里点「执行」`
            : `📨 已发送给${sessionName(request.session)}的对话`
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
      const signature = JSON.stringify(visible.map((request) => [request.id, request.status, request.delivered, request.message, request.finishing, sessionName(request.session)]))
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
          if (request.session && request.session !== config.session) {
            const to = document.createElement('span')
            to.className = 'to'
            to.textContent = ` → ${sessionName(request.session)}`
            title.append(to)
          }
          const status = document.createElement('span')
          status.className = 'status'
          status.textContent = statusLabel(request)
          head.append(title, status)
          // A request nobody started can be withdrawn (a mis-click, second thoughts), and so
          // can a generation until its result goes into the canvas.
          const withdrawable = request.status === 'pending' || (request.executor === 'service' && request.status === 'running' && !request.finishing)
          if (withdrawable) {
            const cancel = document.createElement('button')
            cancel.className = 'cancel'
            cancel.type = 'button'
            cancel.textContent = '撤销'
            cancel.title = request.executor === 'service' ? '停下这次生成，结果不放进画布' : '撤回这条还没开始处理的请求'
            cancel.dataset.cancel = String(request.id)
            head.append(cancel)
          }
          toast.append(head)
          const detail =
            request.executor === 'service'
              ? FINAL_STATUSES.has(request.status)
                ? request.message
                : request.summary
              : request.message || (request.status === 'pending' ? request.summary : '')
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
        if (online) {
          state.restarting = false
          clearTimeout(restartTimer)
        }
        renderPill()
      },
      // The service is going away (a newer version replaces it): reconnect quietly for a while.
      setRestarting() {
        state.restarting = true
        clearTimeout(restartTimer)
        restartTimer = setTimeout(() => {
          state.restarting = false
          renderPill()
        }, RESTART_WAIT_MS)
        renderPill()
      },
      setOutdated(outdated) {
        state.outdated = outdated
        renderPill()
      },
      setPresence(presence) {
        // A service without sessions (an older adapter) only reports the listener.
        state.session = presence.session || 'online'
        state.agentOnline = Boolean(presence.agentOnline)
        renderPill()
      },
      setRole(role) {
        const signature = JSON.stringify(role)
        if (signature === JSON.stringify(state.role)) return
        state.role = role
        renderPill()
        renderToasts()
      }
    }
  }

  function handleServiceEvent(event, data) {
    switch (event) {
      case 'hello':
        overlay.setOutdated(Boolean(data.protocol && config.protocol && data.protocol !== config.protocol))
        pages.setConnected(true)
        break
      case 'stopping': overlay.setRestarting(); break
      case 'presence': overlay.setPresence(data); break
      case 'page-state': pages.setState(data); break
      case 'pages-deleted': pages.removePages(data.pageIds || []); break
      case 'goto-page': pages.goTo(data.pageId, data.initial === true); break
      case 'requests': for (const request of data.requests || []) overlay.upsert(request); break
      case 'request': overlay.upsert(data); break
    }
  }

  function connectEvents() {
    if (transport) {
      transport.connectEvents(handleServiceEvent, (online) => {
        overlay.setServiceOnline(online)
        if (!online) pages.setConnected(false)
      })
      return
    }
    const query = new URLSearchParams({ token: config.token || '', session: config.session || '', pane: PANE, canvasDir: config.canvasDir || '' })
    const source = new EventSource(`/api/page-events?${query}`)
    source.onopen = () => overlay.setServiceOnline(true)
    source.onerror = () => {
      overlay.setServiceOnline(false)
      pages.setConnected(false)
    }
    source.addEventListener('hello', (event) => {
      const { protocol } = JSON.parse(event.data)
      overlay.setOutdated(Boolean(protocol && config.protocol && protocol !== config.protocol))
      pages.setConnected(true)
    })
    source.addEventListener('stopping', () => overlay.setRestarting())
    source.addEventListener('presence', (event) => overlay.setPresence(JSON.parse(event.data)))
    source.addEventListener('page-state', (event) => pages.setState(JSON.parse(event.data)))
    source.addEventListener('pages-deleted', (event) => pages.removePages(JSON.parse(event.data).pageIds || []))
    source.addEventListener('goto-page', (event) => pages.goTo(JSON.parse(event.data).pageId))
    source.addEventListener('requests', (event) => {
      for (const request of JSON.parse(event.data).requests || []) overlay.upsert(request)
    })
    source.addEventListener('request', (event) => overlay.upsert(JSON.parse(event.data)))
  }

  function start() {
    overlay = createOverlay()
    connectEvents()
    publishGlobals()
    pages.applyRole()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
