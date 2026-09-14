// Page-side toolkit shared by the Cowart host adapters (Claude Code and Codex): helpers,
// registration through the app's extension hook (window.__cowartExtensions), holder
// ("card") behavior on the canvas, and the generation panel behind "AI 视频" and the
// taken-over "AI 图片". Loaded as a classic inline script before the app bundle; the host
// provides window.__cowartHostConfig and a window.cowartMcp bridge (callServerTool /
// sendFollowUpMessage).
(() => {
  'use strict'
  if (window.__cowartKit) return

  const hostConfig = window.__cowartHostConfig || {}
  const HOST = hostConfig.host === 'codex' ? 'codex' : 'claude'
  const HOST_NAME = hostConfig.hostName || (HOST === 'codex' ? 'Codex' : 'Claude')
  const PREPARE_REQUEST_TOOL = 'prepare_cowart_generation_request'
  const HOLDER_GAP = 40
  // Same geometry as upstream's AI image panel (getAiImageGenerationPanelLayout).
  const PANEL_OFFSET = 14
  const PANEL_MIN_W = 580
  const PANEL_MAX_W = 660
  const PANEL_MARGIN = 16
  const PANEL_H = 240
  const PICKER_LIMIT = 40
  const PROMPT_TIP = '敲 / 从画布选素材 · 敲 @ 在描述里引用已选的素材'
  // Material references in the prompt: roles (首帧 / 尾帧) stay as typed, numbered ones
  // (图N / 视频N / 音频N) are renumbered when materials are removed or reordered.
  const TOKEN_PATTERN = /@(首帧|尾帧|图\d+|视频\d+|音频\d+)( ?)/g
  const TOKEN_TEXT = /@(首帧|尾帧|图\d+|视频\d+|音频\d+)/g
  const TOKEN_BEFORE_CARET = /@(?:首帧|尾帧|图\d+|视频\d+|音频\d+)$/
  const TOKEN_AFTER_CARET = /^@(?:首帧|尾帧|图\d+|视频\d+|音频\d+)/
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b)

  const icon = (paths, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  const ICONS = {
    image: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>'),
    film: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    music: icon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    plus: icon('<path d="M12 5v14M5 12h14"/>'),
    arrow: icon('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    chevron: icon('<path d="M6 9l6 6 6-6"/>', 14),
    cpu: icon('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>', 14),
    cloud: icon('<path d="M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 8.5a4 4 0 0 1-1 9.5z"/>', 14),
    sparkle: icon('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>', 14),
    terminal: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>', 14),
    upload: icon('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>'),
    check: icon('<path d="M5 12l5 5L20 7"/>', 14)
  }

  // ---- Extension hook ------------------------------------------------------------------

  function extensions() {
    window.__cowartExtensions = window.__cowartExtensions || {}
    return window.__cowartExtensions
  }

  // Bottom toolbar tool: { id, label, iconSvg, onSelect(editor, source) }.
  function registerTool(tool) {
    const ext = extensions()
    ext.tools = [...(Array.isArray(ext.tools) ? ext.tools : []), tool]
  }

  // Stops the app from rendering one of its built-in panels (e.g. 'ai-image').
  function takeOverPanel(panelId) {
    const ext = extensions()
    ext.panels = [...(Array.isArray(ext.panels) ? ext.panels : []), panelId]
  }

  // A button in the selected image's toolbar, after the app's own:
  // { id, label, title?, iconSvg?, isFor(shape), onSelect({ editor, shape, anchor }) };
  // label and title may be functions of the shape.
  function registerImageToolbarItem(item) {
    const ext = extensions()
    ext.imageToolbar = [...(Array.isArray(ext.imageToolbar) ? ext.imageToolbar : []), item]
  }

  const editorListeners = []
  let knownEditor = null

  // Runs the listener for the app's editor now and whenever it is re-created.
  function onEditor(listener) {
    editorListeners.push(listener)
    if (knownEditor) listener(knownEditor)
  }

  setInterval(() => {
    const editor = window.__cowartEditor
    if (!editor || editor === knownEditor) return
    knownEditor = editor
    for (const listener of editorListeners) listener(editor)
  }, 250)

  // ---- Small helpers -------------------------------------------------------------------

  function stopCanvasEvents(root) {
    // Keep typing, clicks and slot drags inside host UI away from tldraw.
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'copy', 'cut', 'paste', 'dragover', 'drop']) {
      root.addEventListener(type, (event) => event.stopPropagation())
    }
  }

  function randomShapeId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return `shape:${Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 21)}`
  }

  function randomKey() {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function ratioNumbers(ratio) {
    const [w, h] = String(ratio).split(':').map(Number)
    return w > 0 && h > 0 ? [w, h] : null
  }

  function closestRatio(ratios, width, height) {
    let best = ratios[0]
    let bestScore = Infinity
    for (const ratio of ratios) {
      const numbers = ratioNumbers(ratio)
      if (!numbers) continue
      const score = Math.abs(Math.log(width / height / (numbers[0] / numbers[1])))
      if (score < bestScore) {
        best = ratio
        bestScore = score
      }
    }
    return best
  }

  function sizeForRatio(ratio, longSide) {
    const [w, h] = ratioNumbers(ratio) || [16, 9]
    return w >= h ? { w: longSide, h: Math.round((longSide * h) / w) } : { w: Math.round((longSide * w) / h), h: longSide }
  }

  // Slides the rect right until it covers no other top-level shape.
  function freePosition(editor, rect, ignoreId) {
    const pageId = editor.getCurrentPageId()
    const others = editor
      .getCurrentPageShapes()
      .filter((shape) => shape.parentId === pageId && shape.id !== ignoreId)
      .map((shape) => editor.getShapePageBounds(shape.id))
      .filter(Boolean)
    let { x } = rect
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const blocker = others.find(
        (bounds) => x < bounds.maxX && x + rect.w > bounds.minX && rect.y < bounds.maxY && rect.y + rect.h > bounds.minY
      )
      if (!blocker) break
      x = blocker.maxX + HOLDER_GAP
    }
    return { x, y: rect.y }
  }

  function revealRect(editor, rect) {
    const viewport = editor.getViewportPageBounds()
    const visible = rect.x >= viewport.minX && rect.y >= viewport.minY && rect.x + rect.w <= viewport.maxX && rect.y + rect.h <= viewport.maxY
    if (!visible) editor.centerOnPoint({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, { animation: { duration: 240 } })
  }

  function mediaKindOfShape(shape) {
    if (!shape) return null
    if (shape.type === 'image') return 'images'
    if (shape.type === 'video') return 'videos'
    return null
  }

  function assetOfShape(editor, shape) {
    return shape && shape.props && shape.props.assetId ? editor.getAsset(shape.props.assetId) : null
  }

  function assetSrcForShape(editor, shape) {
    const asset = assetOfShape(editor, shape)
    return asset && asset.props ? asset.props.src : null
  }

  // A material is a canvas shape or an uploaded file; the key survives reordering.
  function materialFromShape(shape) {
    return { key: randomKey(), source: 'shape', shapeId: shape.id, kind: mediaKindOfShape(shape) }
  }

  function materialForFile(file) {
    const kind = file.type.startsWith('image/') ? 'images' : file.type.startsWith('video/') ? 'videos' : file.type.startsWith('audio/') ? 'audios' : null
    if (!kind) return Promise.resolve(null)
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve({ key: randomKey(), source: 'file', kind, dataUrl: String(reader.result || ''), fileName: file.name || kind }))
      reader.addEventListener('error', () => resolve(null))
      reader.readAsDataURL(file)
    })
  }

  function materialPayload(material) {
    if (!material) return null
    return material.source === 'shape' ? { shapeId: material.shapeId } : { dataUrl: material.dataUrl, fileName: material.fileName }
  }

  // Thumbnails go through the app's asset resolver when it has one (Codex serves page
  // assets through the MCP bridge); the plain src works on the Claude host.
  const thumbUrls = new Map()
  const thumbListeners = new Set()

  function thumbForShape(editor, shape) {
    const asset = assetOfShape(editor, shape)
    if (!asset || shape.type !== 'image') return null
    const known = thumbUrls.get(asset.id)
    if (typeof known === 'string') return known || null
    if (!known && typeof editor.resolveAssetUrl === 'function') {
      thumbUrls.set(
        asset.id,
        Promise.resolve(editor.resolveAssetUrl(asset.id, { screenScale: 0.25, shouldResolveToOriginal: false }))
          .then((url) => url || asset.props.src || '')
          .catch(() => asset.props.src || '')
          .then((url) => {
            thumbUrls.set(asset.id, url)
            for (const listener of thumbListeners) listener()
          })
      )
    }
    const src = asset.props && asset.props.src
    return typeof src === 'string' && /^(\/|https?:|data:|blob:)/.test(src) ? src : null
  }

  function thumbnailHtml(editor, material) {
    if (material.kind === 'images') {
      const src = material.source === 'file' ? material.dataUrl : thumbForShape(editor, editor.getShape(material.shapeId))
      if (src) return `<img alt="" src="${escapeHtml(src)}">`
    }
    return material.kind === 'videos' ? ICONS.film : material.kind === 'audios' ? ICONS.music : ICONS.image
  }

  function shapeDisplayName(editor, shape) {
    const asset = assetOfShape(editor, shape)
    const name = asset && asset.props && typeof asset.props.name === 'string' ? asset.props.name.trim() : ''
    return name || (shape.type === 'video' ? '视频' : '图片')
  }

  // ---- Holders (AI 图片 / AI 视频 cards) -------------------------------------------------

  const holderTypes = []

  function registerHolderType(type) {
    holderTypes.push(type)
  }

  function holderTypeOf(shape) {
    return holderTypes.find((type) => type.isHolder(shape)) || null
  }

  // tldraw only saves changes it sees on an animation frame, and hidden pages get none, so
  // a rename made while the pane is hidden would be overwritten by the next remote sync.
  const pendingRenames = new Map()

  function renameHolder(shapeId, name) {
    if (document.hidden) {
      pendingRenames.set(shapeId, name)
      return
    }
    const editor = window.__cowartEditor
    const shape = editor && editor.getShape(shapeId)
    if (holderTypeOf(shape) && shape.props.name !== name) {
      editor.updateShape({ id: shape.id, type: 'frame', props: { name } })
    }
  }

  // A request that will not produce anything hands its holder back to the user.
  function resetHolderName(shapeId) {
    const editor = window.__cowartEditor
    const type = holderTypeOf(editor && editor.getShape(shapeId))
    if (type) renameHolder(shapeId, type.label)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    const renames = [...pendingRenames]
    pendingRenames.clear()
    for (const [shapeId, name] of renames) renameHolder(shapeId, name)
  })

  function focusHolder(editor, holderId) {
    const type = holderTypeOf(editor.getShape(holderId))
    if (!type) return
    editor.select(holderId)
    if (type.focusPrompt) type.focusPrompt(holderId)
  }

  function isEmptyRichText(node) {
    if (!node || typeof node !== 'object') return true
    if (typeof node.text === 'string' && node.text.length > 0) return false
    return !Array.isArray(node.content) || node.content.every(isEmptyRichText)
  }

  function holderAtPoint(editor, point) {
    return editor
      .getCurrentPageShapesSorted()
      .filter((shape) => holderTypeOf(shape))
      .reverse()
      .find((shape) => {
        const bounds = editor.getShapePageBounds(shape.id)
        return bounds && point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY
      })
  }

  function currentPagePoint(editor) {
    return editor.inputs.getCurrentPagePoint ? editor.inputs.getCurrentPagePoint() : editor.inputs.currentPagePoint
  }

  // Shown over a card while canvas media are dragged onto it.
  function createDropHint() {
    const element = document.createElement('div')
    element.id = 'cowart-drop-hint'
    element.style.cssText =
      'position:fixed;display:none;box-sizing:border-box;border:2px dashed #2f80ed;border-radius:6px;background:rgba(47,128,237,0.08);' +
      'pointer-events:none;z-index:2147480000;align-items:center;justify-content:center;'
    const label = document.createElement('span')
    label.style.cssText =
      'padding:6px 12px;border-radius:999px;background:#2f80ed;color:#fff;font:13px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 4px 14px rgba(15,23,42,0.18);white-space:nowrap;'
    element.appendChild(label)
    let attached = false
    return {
      show(editor, holder, text, blocked) {
        if (!attached && document.body) {
          document.body.appendChild(element)
          attached = true
        }
        const bounds = editor.getShapePageBounds(holder.id)
        const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
        const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
        element.style.left = `${Math.round(topLeft.x)}px`
        element.style.top = `${Math.round(topLeft.y)}px`
        element.style.width = `${Math.round(bottomRight.x - topLeft.x)}px`
        element.style.height = `${Math.round(bottomRight.y - topLeft.y)}px`
        element.style.borderColor = blocked ? '#f06449' : '#2f80ed'
        element.style.background = blocked ? 'rgba(240,100,73,0.08)' : 'rgba(47,128,237,0.08)'
        label.style.background = blocked ? '#f06449' : '#2f80ed'
        label.textContent = text
        element.style.display = 'flex'
      },
      hide() {
        element.style.display = 'none'
      }
    }
  }

  const dropHint = createDropHint()

  // Holders are tldraw frames. Frames are containers with a see-through inside, which made
  // no sense for generation cards: a click inside selected nothing, a double-click made a
  // stray text in the card, and anything dragged onto a card became its child (and was
  // deleted with it when the result replaced the card). Cards now behave like cards:
  //  - a click anywhere selects them, a drag moves them, a double-click opens the prompt;
  //  - they never take children; canvas images / videos dropped on a card become its
  //    materials instead, and snap back to where they came from.
  onEditor((editor) => {
    // Hit-test a card's inside like a solid shape, but only where nothing else is hit, so
    // shapes above the card still take precedence. Covers hover, click and drag.
    if (!editor.__cowartSolidHolders) {
      editor.__cowartSolidHolders = true
      const getShapeAtPoint = editor.getShapeAtPoint.bind(editor)
      editor.getShapeAtPoint = (point, opts = {}) => {
        const hit = getShapeAtPoint(point, opts)
        if (hit || opts.hitFrameInside) return hit
        return getShapeAtPoint(point, {
          ...opts,
          hitFrameInside: true,
          filter: (shape) => Boolean(holderTypeOf(shape)) && (!opts.filter || opts.filter(shape))
        })
      }
    }

    // Cards take no children: not by dragging, pasting or drawing inside them.
    const frameUtil = editor.getShapeUtil('frame')
    if (frameUtil && !frameUtil.__cowartHolderNoChildren) {
      frameUtil.__cowartHolderNoChildren = true
      const canReceive = frameUtil.canReceiveNewChildrenOfType.bind(frameUtil)
      frameUtil.canReceiveNewChildrenOfType = (shape, type) => !holderTypeOf(shape) && canReceive(shape, type)
    }

    // Safety net: a double-click that still makes an empty text inside a card.
    editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
      if (source !== 'user' || shape.type !== 'text' || !isEmptyRichText(shape.props.richText)) return
      if (editor.getCurrentToolId() !== 'select') return
      const holder = holderTypeOf(editor.getShape(shape.parentId)) ? editor.getShape(shape.parentId) : holderAtPoint(editor, currentPagePoint(editor))
      if (!holder) return
      // Removing it before tldraw starts editing it leaves nothing behind (not even an undo step).
      editor.deleteShape(shape.id)
      queueMicrotask(() => focusHolder(editor, holder.id))
    })
    editor.sideEffects.registerAfterChangeHandler('instance_page_state', (previous, next) => {
      const shapeId = next.editingShapeId
      if (!shapeId || shapeId === previous.editingShapeId || !holderTypeOf(editor.getShape(shapeId))) return
      queueMicrotask(() => {
        if (editor.getEditingShapeId() === shapeId) editor.cancel()
        focusHolder(editor, shapeId)
      })
    })

    // Dropping canvas media on a card. tldraw reports events after handling them, so the
    // drag itself is undone afterwards: a history mark taken when the press starts is
    // bailed back to, which returns the media to their places without an undo step.
    let drag = null
    const dropTarget = () => {
      const holder = holderAtPoint(editor, currentPagePoint(editor))
      return holder && !drag.ids.includes(holder.id) && holderTypeOf(holder).dropMaterials ? holder : null
    }
    editor.on('event', (info) => {
      if (info.type !== 'pointer') return
      if (info.name === 'pointer_down') {
        const selected = editor.getSelectedShapes()
        const media = selected.filter((shape) => mediaKindOfShape(shape))
        drag =
          media.length > 0 && media.length === selected.length
            ? { ids: media.map((shape) => shape.id), mark: editor.markHistoryStoppingPoint('cowart-drop-materials'), moved: false }
            : null
        return
      }
      if (!drag) return
      if (info.name === 'pointer_move') {
        drag.moved = drag.moved || editor.isIn('select.translating')
        const holder = drag.moved && editor.isIn('select.translating') ? dropTarget() : null
        if (!holder) {
          dropHint.hide()
          return
        }
        const shapes = drag.ids.map((id) => editor.getShape(id)).filter(Boolean)
        const hint = holderTypeOf(holder).dropHint(holder.id, shapes)
        dropHint.show(editor, holder, hint.text, hint.blocked)
      } else if (info.name === 'pointer_up') {
        const current = drag
        const holder = current.moved ? dropTarget() : null
        drag = null
        dropHint.hide()
        if (!holder) return
        editor.bailToMark(current.mark)
        const shapes = current.ids.map((id) => editor.getShape(id)).filter(Boolean)
        holderTypeOf(holder).dropMaterials(holder.id, shapes)
      }
    })
  })

  // ---- Remembered settings (per panel, per model) --------------------------------------

  function readMemory(storageKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      return saved && typeof saved === 'object' && !saved.model ? saved : {}
    } catch {
      return {}
    }
  }

  function writeMemory(storageKey, settings, holderBound) {
    try {
      const memory = readMemory(storageKey)
      const kept = { ...settings }
      for (const key of holderBound) delete kept[key]
      memory[settings.model] = kept
      localStorage.setItem(storageKey, JSON.stringify(memory))
    } catch {
      // Remembering settings is a convenience only.
    }
  }

  // ---- Requests ------------------------------------------------------------------------

  // Page-only adapter tools get the canvas's project, like upstream's own tool calls.
  function projectArgs() {
    const output = (window.openai && window.openai.toolOutput) || {}
    return { projectDir: output.projectDir, canvasDir: output.canvasDir }
  }

  // Opens a web page outside the canvas (MCP Apps hosts may not allow window.open).
  function openLink(url) {
    if (window.openai && typeof window.openai.openExternal === 'function') {
      window.openai.openExternal({ href: url })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function callTool(name, args) {
    const bridge = window.cowartMcp
    if (!bridge || typeof bridge.callServerTool !== 'function') throw new Error('画布还没连上宿主，稍后再试。')
    const result = await bridge.callServerTool({ name, arguments: args }, { timeoutMs: 120000 })
    if (result && result.isError) {
      const message = (result.content || []).find((item) => item && item.type === 'text')
      throw new Error((message && message.text) || `${name} 调用失败。`)
    }
    return (result && result.structuredContent) || result || {}
  }

  // Saves the canvas right away. Upstream's autosave runs off store listeners that tldraw
  // flushes on animation frames, and a hidden page gets none: a shape added after a slow
  // step (a web capture) while the user looks elsewhere would stay unsaved, and the next
  // remote sync would remove it. Image records the page has not seen yet stay protected.
  async function saveCanvasNow() {
    const editor = window.__cowartEditor
    if (!editor) return
    await callTool('save_cowart_canvas_state', {
      ...projectArgs(),
      snapshot: editor.store.getStoreSnapshot(),
      protectImageRecords: true,
      acknowledgedImageShapeDeletes: []
    })
  }

  // A host that generates by itself (the Claude canvas service) takes the panel's choices
  // and runs the model on the click: { direct: true, request }. Otherwise, or when it cannot
  // (no generation gateway on this machine), the adapter turns the choices into request text
  // (saving uploaded materials) and the host delivers it to the agent like any other canvas
  // message: { direct: false, text }.
  async function sendGenerationRequest({ kind, holderShapeId, body }) {
    const args = { ...body, kind, holderShapeId, ...projectArgs() }
    const bridge = window.cowartMcp
    // A just-created holder may not be autosaved yet; give the page one more save cycle.
    const retryUnsaved = async (call) => {
      try {
        return await call()
      } catch (error) {
        if (!/还没保存/.test(error.message)) throw error
        await delay(1500)
        return call()
      }
    }
    if (kind !== 'web' && bridge && typeof bridge.startGeneration === 'function') {
      try {
        return { direct: true, request: await retryUnsaved(() => bridge.startGeneration(args)) }
      } catch (error) {
        if (!error || !error.fallback) throw error
      }
    }
    const prepared = await retryUnsaved(() => callTool(PREPARE_REQUEST_TOOL, args))
    if (!prepared.text) throw new Error('生成请求是空的。')
    if (!bridge || typeof bridge.sendFollowUpMessage !== 'function') throw new Error(`${HOST_NAME} 没有可用的消息通道。`)
    const delivered = await bridge.sendFollowUpMessage({ prompt: prepared.text, cowart: { kind, holderShapeId, pageId: prepared.pageId, pageName: prepared.pageName, requiredHost: body.model === 'codex-imagegen' ? 'codex' : undefined } })
    return { ...prepared, direct: false, recipient: delivered?.recipient }
  }

  // ---- Prompt triggers (/ and @) -------------------------------------------------------

  // A trigger starts the text or follows whitespace / punctuation, so "a/b" or an e-mail
  // address does not open a picker.
  function triggerAt(text, caret) {
    const match = /(^|[\s，。、；：！？（）()“”"'`,.!?;:])([/@])([^\s/@]*)$/.exec(text.slice(0, caret))
    if (!match) return null
    return { char: match[2], start: caret - match[3].length - 1, end: caret, query: match[3] }
  }

  // ---- Generation panel ----------------------------------------------------------------

  // Styling mirrors upstream's AI generation panel (.cowart-ai-generation-panel in styles.css).
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .panel {
      position: fixed; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: ${PANEL_H}px;
      padding: 14px 16px; gap: 10px; color: #1f2430; background: rgba(255, 255, 255, 0.97); border: 1px solid #d5dbe5;
      border-radius: 18px; pointer-events: auto; backdrop-filter: blur(18px) saturate(1.08);
      box-shadow: 0 30px 74px rgba(15, 23, 42, 0.1), 0 10px 30px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.85);
    }
    .panel[hidden] { display: none; }
    .panel[data-status="error"] { border-color: #f06449; }
    .materials { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .seg { display: inline-flex; flex: none; padding: 2px; gap: 2px; background: #f4f5f7; border-radius: 10px; }
    .seg[hidden] { display: none; }
    .seg button { height: 28px; padding: 0 10px; color: #647080; font-size: 12px; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
    .seg button[aria-pressed="true"] { color: #1f2430; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12); }
    .slots { display: flex; align-items: center; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; padding: 5px 2px 2px; }
    .slots::-webkit-scrollbar { display: none; }
    .slot {
      position: relative; display: inline-flex; flex: 0 0 52px; width: 52px; height: 52px; flex-direction: column; align-items: center;
      justify-content: center; gap: 3px; padding: 0; color: #a5abb4; font-size: 11px; line-height: 1; background: #f4f5f7;
      border: 1px dashed #d5dbe5; border-radius: 12px; cursor: pointer;
    }
    .slot:hover { color: #6f7784; background: #edeff2; }
    .slot.filled { border-style: solid; border-color: #e4e7ec; cursor: grab; }
    .slot.over { border-color: #f5a58f; }
    .slot.drop-target { border-color: #2f80ed; box-shadow: 0 0 0 2px rgba(47, 128, 237, 0.25); }
    .slot img { width: 100%; height: 100%; object-fit: cover; border-radius: 11px; pointer-events: none; }
    .slot .remove {
      position: absolute; top: -5px; right: -5px; width: 18px; height: 18px; padding: 0; color: #25282d; font-size: 11px;
      line-height: 18px; background: #fff; border: 0; border-radius: 999px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(15, 23, 42, 0.07);
    }
    .slot .tag { position: absolute; left: 4px; bottom: 3px; padding: 1px 4px; color: #fff; font-size: 10px; background: rgba(17, 24, 39, 0.66); border-radius: 4px; pointer-events: none; }
    .between { color: #b3b8c1; flex: none; display: inline-flex; }
    /* The prompt is a textarea over a mirror of its text: the mirror draws the text (with
       @ references as tags), the textarea on top keeps the caret, selection and editing.
       Both need the exact same box and font so the caret lines up with the drawn text. */
    .prompt { position: relative; min-height: 0; }
    .prompt-mirror, textarea {
      box-sizing: border-box; width: 100%; height: 100%; margin: 0; padding: 0 2px; border: 0;
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 15px; font-weight: 400;
      line-height: 1.5; letter-spacing: normal; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; tab-size: 4;
      overflow-y: auto; scrollbar-width: none;
    }
    .prompt-mirror::-webkit-scrollbar, textarea::-webkit-scrollbar { display: none; }
    .prompt-mirror { position: absolute; inset: 0; overflow: hidden; color: #1f2430; pointer-events: none; }
    textarea {
      position: relative; z-index: 1; display: block; resize: none; color: transparent; caret-color: #1f2430;
      background: transparent; outline: 0;
    }
    textarea::placeholder { color: #b3b8c1; }
    textarea::selection { color: transparent; background: rgba(47, 128, 237, 0.24); }
    /* Tags must not change the text width, so the pill comes from a spread shadow. */
    .token { color: #1d4ed8; background: #e8f0fe; border-radius: 4px; box-shadow: 0 0 0 2px #e8f0fe; }
    .token.unknown { color: #c2410c; background: #fdece6; box-shadow: 0 0 0 2px #fdece6; }
    .footer { display: flex; align-items: center; gap: 8px; min-height: 36px; position: relative; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; color: #18181b; font-size: 13px;
      white-space: nowrap; background: #fff; border: 1px solid #e4e4e7; border-radius: 10px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); cursor: pointer;
    }
    .chip:hover, .chip[aria-expanded="true"] { background: #fafafa; border-color: #d4d4d8; }
    .chip .muted { color: #71717a; }
    .estimate { flex: 1 1 auto; min-width: 0; overflow: hidden; color: #8b93a0; font-size: 12px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .panel[data-status="error"] .estimate { color: #c2410c; }
    .panel[data-status="sent"] .estimate { color: #1f8f4d; }
    .send { flex: none; min-width: 72px; height: 36px; padding: 0 16px; color: #fff; font-size: 14px; background: #2f80ed; border: 0; border-radius: 14px; cursor: pointer; }
    .send:hover:not(:disabled) { background: #226fda; }
    .send:disabled { opacity: 0.5; cursor: default; }
    .popover {
      position: absolute; bottom: calc(100% + 8px); z-index: 2; box-sizing: border-box; padding: 6px; background: #fff;
      border: 1px solid #e4e4e7; border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.06);
    }
    .popover[hidden] { display: none; }
    .model-option { display: flex; width: 100%; gap: 10px; align-items: flex-start; padding: 8px 10px; text-align: left; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
    .model-option:hover { background: #f4f4f5; }
    .model-option .mark { width: 14px; flex: none; color: #2f80ed; padding-top: 2px; }
    .model-option b { display: block; color: #18181b; font-size: 13px; font-weight: 500; }
    .model-option small { display: block; margin-top: 2px; color: #71717a; font-size: 12px; }
    .param { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; }
    .param-name { width: 44px; flex: none; color: #71717a; font-size: 12px; }
    .option { height: 28px; padding: 0 9px; color: #3f3f46; font-size: 12px; background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; cursor: pointer; }
    .option[aria-pressed="true"] { color: #1d4ed8; background: #eff6ff; border-color: #93c5fd; }
    .duration { display: flex; align-items: center; gap: 10px; flex: 1; }
    .duration input { flex: 1; accent-color: #2f80ed; }
    .duration output { min-width: 42px; color: #18181b; font-size: 12px; text-align: right; }
    .param-note { padding: 2px 8px 6px 58px; color: #a1a1aa; font-size: 11px; }
    .picker {
      position: absolute; left: 12px; right: 12px; bottom: calc(100% + 8px); z-index: 3; display: flex; flex-direction: column;
      max-height: 260px; padding: 6px; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
    }
    .picker[hidden] { display: none; }
    .picker-head { padding: 4px 8px 6px; color: #71717a; font-size: 12px; }
    .picker-list { overflow-y: auto; }
    .pick {
      display: flex; width: 100%; gap: 10px; align-items: center; padding: 6px 8px; text-align: left; color: #18181b;
      font-size: 13px; background: transparent; border: 0; border-radius: 8px; cursor: pointer;
    }
    .pick[aria-selected="true"] { background: #eff6ff; }
    .pick[disabled] { color: #a1a1aa; cursor: default; }
    .pick .thumb {
      display: inline-flex; flex: none; width: 36px; height: 36px; align-items: center; justify-content: center; overflow: hidden;
      color: #71717a; background: #f4f5f7; border-radius: 8px;
    }
    .pick .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .pick .text { min-width: 0; flex: 1; }
    .pick .text b { display: block; overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .pick .text small { display: block; color: #71717a; font-size: 11px; }
    .picker-empty { padding: 10px 8px; color: #a1a1aa; font-size: 12px; }
    .picker-foot { padding: 6px 8px 2px; color: #a1a1aa; font-size: 11px; }
    input[type=file] { display: none; }
  `

  function optionButtons(name, values, selected, label = (value) => value) {
    return values
      .map(
        (value) =>
          `<button class="option" type="button" data-param="${name}" data-value="${escapeHtml(value)}" aria-pressed="${String(value) === String(selected)}">${escapeHtml(label(value))}</button>`
      )
      .join('')
  }

  function slotHtml(editor, material, { label, role, index, tag, title, over }) {
    const at = `data-role="${role}" data-index="${index ?? ''}"`
    if (!material) {
      return `<button class="slot" type="button" data-add="${role}" ${at} title="${escapeHtml(title || label)}">${ICONS.plus}<span>${escapeHtml(label)}</span></button>`
    }
    const tagHtml = tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ''
    return (
      `<div class="slot filled${over ? ' over' : ''}" draggable="true" ${at} title="${escapeHtml(title || tag || '')}">` +
      `${thumbnailHtml(editor, material)}${tagHtml}<button class="remove" type="button" data-remove="${role}" data-index="${index ?? ''}" title="移除">✕</button></div>`
    )
  }

  function modelChipHtml(model) {
    const glyph = model.id === 'auto' ? ICONS.sparkle : model.hosts ? ICONS.terminal : model.cloud ? ICONS.cloud : ICONS.cpu
    return `${glyph}<span>${escapeHtml(model.label)}</span><span class="muted">${escapeHtml(model.tag || (model.cloud ? '云' : '本地免费'))}</span>${ICONS.chevron}`
  }

  // A prompt panel under the selected holder, placed like upstream's AI image panel. The
  // spec supplies the models, the materials (slots, labels, add / remove / move rules), the
  // parameter rows and the request body.
  function createGenerationPanel(spec) {
    const models = spec.models
    const modelById = (id) => models.find((model) => model.id === id) || models.find((model) => model.id === spec.defaultModelId) || models[0]
    const storageKey = `cowart.ai-${spec.id}.settings`
    const holderBound = spec.holderBound || []
    const drafts = new Map()
    // Set by a double-click on a holder: focus the prompt once its panel is showing.
    let pendingFocus = null

    function settingsFor(modelId, base = {}) {
      const model = modelById(modelId)
      return spec.clampSettings({ ...base, ...readMemory(storageKey)[model.id], model: model.id }, model)
    }

    function newDraft(settings, patch = {}) {
      return {
        settings,
        mode: spec.modes ? spec.modes[0].id : null,
        prompt: '',
        status: '',
        statusKind: '',
        ...(spec.emptyMaterials ? spec.emptyMaterials() : {}),
        ...patch
      }
    }

    function contextFor(editor, holder) {
      if (!editor || !spec.isHolder(holder)) return null
      let draft = drafts.get(holder.id)
      if (!draft) {
        draft = newDraft(settingsFor(spec.defaultModelId, spec.holderSettings ? spec.holderSettings(holder) : {}))
        drafts.set(holder.id, draft)
      }
      return { editor, holder, draft, model: modelById(draft.settings.model), kit }
    }

    const hostElement = document.createElement('div')
    hostElement.id = `cowart-${spec.id}-panel`
    hostElement.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147481000;'
    const root = hostElement.attachShadow({ mode: 'open' })
    const modesHtml = (spec.modes || [])
      .map((mode) => `<button type="button" data-mode="${mode.id}" title="${escapeHtml(mode.title || '')}">${escapeHtml(mode.label)}</button>`)
      .join('')
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="panel" hidden>
        <div class="materials">
          <div class="seg" role="group" aria-label="素材模式"${spec.modes ? '' : ' hidden'}>${modesHtml}</div>
          <div class="slots"></div>
        </div>
        <div class="prompt">
          <div class="prompt-mirror" aria-hidden="true"></div>
          <textarea aria-label="${escapeHtml(spec.label)}描述" aria-autocomplete="list" aria-expanded="false"></textarea>
        </div>
        <div class="footer">
          <button class="chip model-chip" type="button" aria-expanded="false"></button>
          <button class="chip params-chip" type="button" aria-expanded="false"></button>
          <span class="estimate"></span>
          <button class="send" type="button">发送</button>
          <div class="popover model-popover" hidden style="left:0;width:320px"></div>
          <div class="popover params-popover" hidden style="left:0;width:400px"></div>
        </div>
        <div class="picker" hidden><div class="picker-head"></div><div class="picker-list" role="listbox"></div><div class="picker-foot"></div></div>
        <input type="file" class="file">
      </div>`

    const panel = root.querySelector('.panel')
    const modeButtons = [...root.querySelectorAll('.seg button')]
    const slots = root.querySelector('.slots')
    const textarea = root.querySelector('textarea')
    const mirror = root.querySelector('.prompt-mirror')
    const modelChip = root.querySelector('.model-chip')
    const paramsChip = root.querySelector('.params-chip')
    const estimate = root.querySelector('.estimate')
    const sendButton = root.querySelector('.send')
    const modelPopover = root.querySelector('.model-popover')
    const paramsPopover = root.querySelector('.params-popover')
    const picker = root.querySelector('.picker')
    const pickerHead = root.querySelector('.picker-head')
    const pickerList = root.querySelector('.picker-list')
    const pickerFoot = root.querySelector('.picker-foot')
    const fileInput = root.querySelector('.file')

    let holderId = null
    let fileTarget = null
    // { mode: 'canvas' | 'mention', trigger: '/' | '@' | 'slot', role, start, end, items, index }
    let pick = null

    function current() {
      const editor = window.__cowartEditor
      return contextFor(editor, editor && holderId ? editor.getShape(holderId) : null)
    }

    // Any edit makes the last status / error stale, so the footer goes back to the estimate.
    function clearStatus(draft) {
      draft.status = ''
      draft.statusKind = ''
    }

    function setError(draft, message) {
      draft.status = message
      draft.statusKind = 'error'
    }

    // Runs a change to the materials and renumbers the @图N / @视频N / @音频N references in
    // the prompt to match (a reference to a removed material is dropped).
    function changeMaterials(ctx, change) {
      const labelsOf = () => new Map(spec.materialItems(ctx.draft).filter((item) => item.numbered).map((item) => [item.material.key, item.label]))
      const before = labelsOf()
      const result = change()
      const after = labelsOf()
      const renamed = new Map([...before].map(([key, label]) => [label, after.get(key) || null]))
      if ([...renamed].some(([from, to]) => from !== to)) {
        ctx.draft.prompt = ctx.draft.prompt.replace(TOKEN_PATTERN, (match, label, space) => {
          if (!renamed.has(label)) return match
          const next = renamed.get(label)
          return next ? `@${next}${space}` : ''
        })
      }
      return result
    }

    function addMaterials(ctx, materials, role) {
      clearStatus(ctx.draft)
      let added = 0
      for (const material of materials) {
        const error = changeMaterials(ctx, () => spec.addMaterial(ctx, material, role))
        if (error) setError(ctx.draft, error)
        else added += 1
      }
      return added
    }

    function renderMaterials(ctx) {
      for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === ctx.draft.mode))
      const { html, placeholder } = spec.renderMaterials(ctx, slotHtml)
      slots.innerHTML = html
      textarea.placeholder = `${placeholder}\n${PROMPT_TIP}`
    }

    // The footer's right-hand text shows the estimate, or the latest status / error instead.
    function renderFooter(ctx) {
      modelChip.innerHTML = modelChipHtml(ctx.model)
      paramsChip.innerHTML = `<span>${escapeHtml(spec.summary(ctx))}</span>${ICONS.chevron}`
      estimate.textContent = ctx.draft.status || spec.estimate(ctx)
      estimate.title = estimate.textContent
      panel.dataset.status = ctx.draft.status ? ctx.draft.statusKind : ''
    }

    function renderModelPopover(ctx) {
      modelPopover.innerHTML = models
        .map(
          (model) =>
            `<button class="model-option" type="button" data-model="${model.id}"><span class="mark">${model.id === ctx.model.id ? ICONS.check : ''}</span>` +
            `<span><b>${escapeHtml(model.label)}</b><small>${escapeHtml(model.description)}</small></span></button>`
        )
        .join('')
    }

    function renderParamsPopover(ctx) {
      paramsPopover.innerHTML = spec.paramRows(ctx, optionButtons)
    }

    // Draws the prompt text behind the textarea, with @ references as tags: blue when they
    // name a chosen material, orange when nothing matches.
    function renderMirror(ctx) {
      const text = textarea.value
      const labels = new Set(spec.materialItems(ctx.draft).map((item) => item.label))
      let html = ''
      let last = 0
      for (const match of text.matchAll(TOKEN_TEXT)) {
        html += escapeHtml(text.slice(last, match.index))
        html += `<span class="token${labels.has(match[1]) ? '' : ' unknown'}">${escapeHtml(match[0])}</span>`
        last = match.index + match[0].length
      }
      // A trailing newline needs something after it to take up its own line.
      mirror.innerHTML = html + escapeHtml(text.slice(last)) + ZERO_WIDTH_SPACE
      mirror.scrollTop = textarea.scrollTop
    }

    function unknownReferences(draft) {
      const labels = new Set(spec.materialItems(draft).map((item) => item.label))
      return [...new Set([...draft.prompt.matchAll(TOKEN_TEXT)].map((match) => match[1]).filter((label) => !labels.has(label)))]
    }

    function render() {
      const ctx = current()
      if (!ctx) return
      renderMaterials(ctx)
      renderFooter(ctx)
      if (!modelPopover.hidden) renderModelPopover(ctx)
      if (!paramsPopover.hidden) renderParamsPopover(ctx)
      if (pick) renderPicker(ctx)
      if (textarea.value !== ctx.draft.prompt) textarea.value = ctx.draft.prompt
      renderMirror(ctx)
    }

    thumbListeners.add(() => {
      if (!panel.hidden) render()
    })

    function closePopovers() {
      modelPopover.hidden = true
      paramsPopover.hidden = true
      modelChip.setAttribute('aria-expanded', 'false')
      paramsChip.setAttribute('aria-expanded', 'false')
    }

    function togglePopover(popover, chip) {
      const opening = popover.hidden
      closePopovers()
      closePicker()
      if (!opening) return
      const ctx = current()
      if (!ctx) return
      if (popover === modelPopover) renderModelPopover(ctx)
      else renderParamsPopover(ctx)
      popover.style.left = `${chip.offsetLeft}px`
      popover.hidden = false
      chip.setAttribute('aria-expanded', 'true')
    }

    // Switching models brings back that model's remembered settings (never holder-bound
    // ones, so those carry over from the current model).
    function updateSettings(ctx, patch) {
      const previous = ctx.draft.settings
      const switching = patch.model && patch.model !== previous.model
      const next = switching ? settingsFor(patch.model, previous) : spec.clampSettings({ ...previous, ...patch }, modelById(previous.model))
      ctx.draft.settings = next
      writeMemory(storageKey, next, holderBound)
      clearStatus(ctx.draft)
      const updated = current()
      if (spec.afterSettingsChange) spec.afterSettingsChange(updated, previous)
      render()
    }

    async function addFiles(files, role) {
      const ctx = current()
      if (!ctx) return
      const materials = (await Promise.all(files.map(materialForFile))).filter(Boolean)
      addMaterials(ctx, materials, role)
      render()
    }

    // ---- Pickers: "/" or an empty slot lists canvas media, "@" lists chosen materials ----

    function canvasItems(ctx, query) {
      const { editor, holder, draft } = ctx
      const kinds = spec.acceptedKinds(ctx)
      const chosen = new Set(spec.materialItems(draft).map((item) => item.material.shapeId).filter(Boolean))
      const center = editor.getShapePageBounds(holder.id).center
      const needle = query.trim().toLowerCase()
      return editor
        .getCurrentPageShapes()
        .filter((shape) => kinds.includes(mediaKindOfShape(shape)))
        .map((shape) => {
          const bounds = editor.getShapePageBounds(shape.id)
          return { shape, name: shapeDisplayName(editor, shape), distance: bounds ? Math.hypot(bounds.center.x - center.x, bounds.center.y - center.y) : Infinity, bounds }
        })
        .filter((item) => !needle || item.name.toLowerCase().includes(needle))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, PICKER_LIMIT)
        .map(({ shape, name, bounds }) => ({
          type: 'canvas',
          shape,
          name,
          detail: `${shape.type === 'video' ? '视频' : '图片'}${bounds ? ` · ${Math.round(bounds.w)}×${Math.round(bounds.h)}` : ''}`,
          disabled: chosen.has(shape.id)
        }))
    }

    function mentionItems(ctx, query) {
      const needle = query.trim()
      return spec
        .materialItems(ctx.draft)
        .filter((item) => !needle || item.label.includes(needle))
        .map((item) => ({ type: 'mention', label: item.label, material: item.material, detail: item.detail || '' }))
    }

    function openPicker(options) {
      const ctx = current()
      if (!ctx) return
      closePopovers()
      pick = { index: 0, ...options }
      renderPicker(ctx)
    }

    function closePicker() {
      if (!pick) return
      pick = null
      picker.hidden = true
      textarea.setAttribute('aria-expanded', 'false')
    }

    function renderPicker(ctx) {
      if (!pick) return
      const query = pick.trigger === 'slot' ? '' : ctx.draft.prompt.slice(pick.start + 1, pick.end)
      pick.items = pick.mode === 'mention' ? mentionItems(ctx, query) : canvasItems(ctx, query)
      if (pick.trigger === 'slot') pick.items = [{ type: 'upload', name: '上传本地文件…', detail: '图片、视频或音频文件' }, ...pick.items]
      pick.index = Math.min(pick.index, Math.max(0, pick.items.length - 1))
      if (pick.items[pick.index] && pick.items[pick.index].disabled) {
        const next = pick.items.findIndex((item) => !item.disabled)
        pick.index = next >= 0 ? next : 0
      }
      pickerHead.textContent =
        pick.mode === 'mention'
          ? '引用已选的素材'
          : pick.trigger === 'slot'
            ? spec.slotPickerTitle(ctx, pick.role)
            : `从画布选${spec.acceptedKinds(ctx).includes('videos') ? '图片或视频' : '图片'}（离卡片近的在前）`
      pickerList.innerHTML = pick.items.length
        ? pick.items
            .map((item, index) => {
              const thumb =
                item.type === 'upload'
                  ? ICONS.upload
                  : item.type === 'mention'
                    ? thumbnailHtml(ctx.editor, item.material)
                    : thumbnailHtml(ctx.editor, { kind: mediaKindOfShape(item.shape), source: 'shape', shapeId: item.shape.id })
              const title = item.type === 'mention' ? `@${item.label}` : item.name
              const detail = item.disabled ? '已在素材里' : item.detail
              return (
                `<button class="pick" type="button" role="option" data-pick="${index}" aria-selected="${index === pick.index}"${item.disabled ? ' disabled' : ''}>` +
                `<span class="thumb">${thumb}</span><span class="text"><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></span></button>`
              )
            })
            .join('')
        : `<div class="picker-empty">${pick.mode === 'mention' ? '还没有素材：先敲 / 从画布选，或把画布上的图拖到卡片上' : '画布上没有能用的素材'}</div>`
      pickerFoot.textContent = pick.items.length ? '↑↓ 选择 · 回车确认 · Esc 关闭' : 'Esc 关闭'
      picker.hidden = false
      textarea.setAttribute('aria-expanded', 'true')
      const selected = pickerList.querySelector('[aria-selected="true"]')
      if (selected) selected.scrollIntoView({ block: 'nearest' })
    }

    function movePick(step) {
      if (!pick || !pick.items.length) return
      for (let tries = 0; tries < pick.items.length; tries += 1) {
        pick.index = (pick.index + step + pick.items.length) % pick.items.length
        if (!pick.items[pick.index].disabled) break
      }
      renderPicker(current())
    }

    function choosePick(index) {
      const ctx = current()
      if (!ctx || !pick) return
      const item = pick.items[index]
      if (!item || item.disabled) return
      const { trigger, role, start, end } = pick
      closePicker()
      if (item.type === 'upload') {
        openFileDialog(ctx, role)
        return
      }
      if (item.type === 'mention') {
        const prompt = ctx.draft.prompt
        const token = `@${item.label} `
        ctx.draft.prompt = prompt.slice(0, start) + token + prompt.slice(end).replace(/^ /, '')
        render()
        textarea.focus()
        textarea.setSelectionRange(start + token.length, start + token.length)
        return
      }
      if (trigger === '/') ctx.draft.prompt = ctx.draft.prompt.slice(0, start) + ctx.draft.prompt.slice(end)
      addMaterials(ctx, [materialFromShape(item.shape)], trigger === 'slot' ? role : null)
      render()
      if (trigger === '/') {
        textarea.focus()
        textarea.setSelectionRange(start, start)
      }
    }

    // Opens or refreshes the "/" / "@" picker for the text around the caret.
    function syncTrigger() {
      const ctx = current()
      if (!ctx) return
      if (pick && pick.trigger === 'slot') return
      const trigger = textarea.selectionStart === textarea.selectionEnd ? triggerAt(textarea.value, textarea.selectionStart) : null
      const labels = spec.materialItems(ctx.draft).map((item) => item.label)
      // A finished reference like "@图1" does not reopen the list.
      if (!trigger || (trigger.char === '@' && labels.includes(trigger.query))) {
        closePicker()
        return
      }
      const mode = trigger.char === '@' ? 'mention' : 'canvas'
      if (pick && pick.mode === mode && pick.start === trigger.start) {
        pick.end = trigger.end
        renderPicker(ctx)
      } else {
        openPicker({ mode, trigger: trigger.char, start: trigger.start, end: trigger.end })
      }
    }

    function openFileDialog(ctx, role) {
      fileTarget = role
      const { accept, multiple } = spec.fileInput(ctx, role || 'ref')
      fileInput.accept = accept
      fileInput.multiple = multiple
      fileInput.click()
    }

    // ---- Events -----------------------------------------------------------------------

    modeButtons.forEach((button) =>
      button.addEventListener('click', () => {
        const ctx = current()
        if (!ctx) return
        ctx.draft.mode = button.dataset.mode
        clearStatus(ctx.draft)
        closePicker()
        render()
      })
    )
    slots.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add]')
      const remove = event.target.closest('[data-remove]')
      const ctx = current()
      if (!ctx) return
      if (remove) {
        changeMaterials(ctx, () => spec.removeMaterial(ctx, remove.dataset.remove, Number(remove.dataset.index)))
        clearStatus(ctx.draft)
        render()
      } else if (add) {
        if (pick && pick.trigger === 'slot' && pick.role === add.dataset.add) closePicker()
        else openPicker({ mode: 'canvas', trigger: 'slot', role: add.dataset.add })
      }
    })

    // Dragging a slot onto another swaps the first / last frames or reorders references.
    let slotDrag = null
    slots.addEventListener('dragstart', (event) => {
      const slot = event.target.closest('.slot.filled')
      if (!slot) return
      slotDrag = { role: slot.dataset.role, index: Number(slot.dataset.index) }
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', 'cowart-slot')
    })
    slots.addEventListener('dragover', (event) => {
      const slot = event.target.closest('.slot')
      if (!slotDrag || !slot) return
      event.preventDefault()
      for (const other of slots.querySelectorAll('.drop-target')) if (other !== slot) other.classList.remove('drop-target')
      slot.classList.add('drop-target')
    })
    slots.addEventListener('dragleave', (event) => {
      const slot = event.target.closest('.slot')
      if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove('drop-target')
    })
    slots.addEventListener('drop', (event) => {
      const slot = event.target.closest('.slot')
      const from = slotDrag
      slotDrag = null
      if (!from || !slot) return
      event.preventDefault()
      const ctx = current()
      if (!ctx) return
      const to = { role: slot.dataset.role, index: slot.dataset.index === '' ? null : Number(slot.dataset.index) }
      changeMaterials(ctx, () => spec.moveMaterial(ctx, from, to))
      render()
    })
    slots.addEventListener('dragend', () => {
      slotDrag = null
      for (const slot of slots.querySelectorAll('.drop-target')) slot.classList.remove('drop-target')
    })

    fileInput.addEventListener('change', () => {
      addFiles([...(fileInput.files || [])], fileTarget)
      fileInput.value = ''
    })
    root.addEventListener('paste', (event) => {
      const files = [...((event.clipboardData && event.clipboardData.files) || [])]
      if (files.length > 0) {
        event.preventDefault()
        addFiles(files, null)
      }
    })
    textarea.addEventListener('input', () => {
      const ctx = current()
      if (!ctx) return
      ctx.draft.prompt = textarea.value
      renderMirror(ctx)
      if (ctx.draft.status && !sendButton.disabled) {
        clearStatus(ctx.draft)
        renderFooter(ctx)
      }
      syncTrigger()
    })
    textarea.addEventListener('scroll', () => {
      mirror.scrollTop = textarea.scrollTop
    })
    textarea.addEventListener('click', syncTrigger)
    textarea.addEventListener('keyup', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') syncTrigger()
    })
    // A reference is deleted as a whole, like a tag: Backspace right after it, or Delete
    // right before it (through execCommand, so Ctrl+Z still brings it back).
    textarea.addEventListener('keydown', (event) => {
      if ((event.key !== 'Backspace' && event.key !== 'Delete') || textarea.selectionStart !== textarea.selectionEnd) return
      const caret = textarea.selectionStart
      const match =
        event.key === 'Backspace' ? TOKEN_BEFORE_CARET.exec(textarea.value.slice(0, caret)) : TOKEN_AFTER_CARET.exec(textarea.value.slice(caret))
      if (!match) return
      event.preventDefault()
      const from = event.key === 'Backspace' ? caret - match[0].length : caret
      textarea.setSelectionRange(from, from + match[0].length)
      if (!document.execCommand('delete')) {
        textarea.setRangeText('', from, from + match[0].length, 'end')
        textarea.dispatchEvent(new Event('input'))
      }
    })
    textarea.addEventListener('keydown', (event) => {
      if (pick && pick.trigger !== 'slot') {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          movePick(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
          if (pick.items && pick.items.length) {
            event.preventDefault()
            choosePick(pick.index)
          }
          return
        }
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send()
    })
    // Rows are chosen on pointerdown so the prompt keeps its focus and caret.
    picker.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      const row = event.target.closest('[data-pick]')
      if (row) choosePick(Number(row.dataset.pick))
    })
    modelChip.addEventListener('click', () => togglePopover(modelPopover, modelChip))
    paramsChip.addEventListener('click', () => togglePopover(paramsPopover, paramsChip))
    modelPopover.addEventListener('click', (event) => {
      const option = event.target.closest('[data-model]')
      const ctx = current()
      if (!option || !ctx) return
      closePopovers()
      updateSettings(ctx, { model: option.dataset.model })
    })
    paramsPopover.addEventListener('click', (event) => {
      const option = event.target.closest('.option')
      const ctx = current()
      if (!option || !ctx) return
      const { param, value } = option.dataset
      // Some parameters live on the holder rather than in the settings (the image ratio).
      if (spec.applyParam && spec.applyParam(ctx, param, value)) {
        clearStatus(ctx.draft)
        render()
        return
      }
      updateSettings(ctx, spec.paramPatch(ctx, param, value))
    })
    // Sliders update in place so the thumb keeps following the pointer.
    paramsPopover.addEventListener('input', (event) => {
      const input = event.target
      if (input.type !== 'range') return
      const ctx = current()
      if (!ctx) return
      ctx.draft.settings = spec.clampSettings({ ...ctx.draft.settings, [input.dataset.param]: Number(input.value) }, ctx.model)
      writeMemory(storageKey, ctx.draft.settings, holderBound)
      clearStatus(ctx.draft)
      const output = input.parentElement.querySelector('output')
      if (output && spec.rangeLabel) output.textContent = spec.rangeLabel(input.dataset.param, ctx.draft.settings[input.dataset.param])
      renderFooter(ctx)
    })
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      if (pick) {
        closePicker()
        return
      }
      if (!modelPopover.hidden || !paramsPopover.hidden) {
        closePopovers()
        return
      }
      // Esc leaves the prompt; the holder stays selected, so Delete and the canvas
      // shortcuts act on it again.
      if (root.activeElement === textarea) {
        textarea.blur()
        const editor = window.__cowartEditor
        if (editor) editor.focus()
      }
    })
    root.addEventListener('pointerdown', (event) => {
      const path = event.composedPath()
      if (!path.some((node) => node === modelPopover || node === paramsPopover || node === modelChip || node === paramsChip)) closePopovers()
      if (pick && !path.some((node) => node === picker || node === textarea || (node.dataset && node.dataset.add))) closePicker()
    })

    async function send() {
      const ctx = current()
      if (!ctx || sendButton.disabled) return
      const { holder, draft } = ctx
      closePopovers()
      closePicker()
      const unknown = unknownReferences(draft)
      const error = !draft.prompt.trim()
        ? spec.emptyPromptError
        : unknown.length
          ? `描述里的 @${unknown[0]} 没有对应的素材：删掉它，或先把素材加进来。`
          : spec.validate(ctx)
      if (error) {
        setError(draft, error)
        render()
        return
      }
      sendButton.disabled = true
      draft.status = '发送中…'
      draft.statusKind = ''
      render()
      try {
        const sent = await sendGenerationRequest({ kind: spec.kind, holderShapeId: holder.id, body: { prompt: draft.prompt.trim(), ...spec.payload(ctx) } })
        draft.status = sent.direct ? '开始生成了，进度看画布顶部' : `请求已提交给${sent.recipient || '负责会话'}，进度看画布顶部`
        draft.statusKind = 'sent'
        renameHolder(holder.id, `${spec.label} · ${sent.direct ? '生成中…' : '已发送'}`)
      } catch (sendError) {
        setError(draft, sendError instanceof Error ? sendError.message : String(sendError))
      } finally {
        sendButton.disabled = false
        render()
      }
    }
    sendButton.addEventListener('click', send)

    function frame() {
      requestAnimationFrame(frame)
      const editor = window.__cowartEditor
      if (!editor) return
      const shape = editor.getOnlySelectedShape()
      const dragging = editor.inputs.getIsDragging ? editor.inputs.getIsDragging() : editor.inputs.isDragging
      if (!spec.isHolder(shape) || dragging || editor.getEditingShapeId()) {
        if (!panel.hidden) {
          closePopovers()
          closePicker()
        }
        panel.hidden = true
        holderId = null
        return
      }

      const bounds = editor.getShapePageBounds(shape.id)
      const bottomLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.maxY })
      const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
      const screenWidth = Math.abs(bottomRight.x - bottomLeft.x)
      const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, screenWidth * 2.6), window.innerWidth - PANEL_MARGIN * 2)
      const left = Math.min(
        Math.max(bottomLeft.x + screenWidth / 2 - width / 2, PANEL_MARGIN),
        Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN)
      )
      const top = Math.min(Math.max(bottomLeft.y + PANEL_OFFSET, PANEL_MARGIN), Math.max(PANEL_MARGIN, window.innerHeight - PANEL_H - PANEL_MARGIN))
      panel.style.left = `${Math.round(left)}px`
      panel.style.top = `${Math.round(top)}px`
      panel.style.width = `${Math.round(width)}px`

      if (holderId !== shape.id) {
        holderId = shape.id
        closePopovers()
        closePicker()
        render()
      } else if (spec.watchHolder && spec.watchHolder(shape)) {
        render()
      }
      panel.hidden = false
      if (pendingFocus === shape.id) {
        pendingFocus = null
        textarea.focus()
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }
    }

    function start() {
      document.body.appendChild(hostElement)
      stopCanvasEvents(root)
      requestAnimationFrame(frame)
    }
    if (document.body) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })

    registerHolderType({
      isHolder: spec.isHolder,
      label: spec.label,
      focusPrompt: (shapeId) => {
        pendingFocus = shapeId
      },
      // What dropping these canvas shapes on the card would do, for the drag hint.
      dropHint(shapeId, shapes) {
        const editor = window.__cowartEditor
        const ctx = contextFor(editor, editor && editor.getShape(shapeId))
        if (!ctx) return { text: '', blocked: true }
        const chosen = new Set(spec.materialItems(ctx.draft).map((item) => item.material.shapeId).filter(Boolean))
        const fresh = shapes.filter((shape) => !chosen.has(shape.id))
        return fresh.length ? spec.dropHint(ctx, fresh.map(mediaKindOfShape)) : { text: '已经在素材里了', blocked: true }
      },
      // Canvas shapes dropped on the card become its materials; the card is then selected
      // so its panel shows the result.
      dropMaterials(shapeId, shapes) {
        const editor = window.__cowartEditor
        const ctx = contextFor(editor, editor && editor.getShape(shapeId))
        if (!ctx) return
        const chosen = new Set(spec.materialItems(ctx.draft).map((item) => item.material.shapeId).filter(Boolean))
        addMaterials(ctx, shapes.filter((shape) => !chosen.has(shape.id)).map(materialFromShape), null)
        editor.select(shapeId)
        if (holderId === shapeId) render()
      }
    })

    return {
      // Seeds a draft for a holder that is being created (materials from the selection).
      seedDraft(shapeId, patch, baseSettings = {}) {
        drafts.set(shapeId, newDraft(settingsFor(spec.defaultModelId, baseSettings), patch))
      },
      defaultSettings(baseSettings = {}) {
        return settingsFor(spec.defaultModelId, baseSettings)
      },
      hasDraft(shapeId) {
        return drafts.has(shapeId)
      }
    }
  }

  const kit = {
    host: HOST,
    hostName: HOST_NAME,
    hostConfig,
    ICONS,
    HOLDER_GAP,
    registerTool,
    takeOverPanel,
    registerImageToolbarItem,
    onEditor,
    stopCanvasEvents,
    randomShapeId,
    randomKey,
    escapeHtml,
    projectArgs,
    openLink,
    callTool,
    saveCanvasNow,
    sendGenerationRequest,
    registerHolderType,
    holderTypeOf,
    ratioNumbers,
    closestRatio,
    sizeForRatio,
    freePosition,
    revealRect,
    mediaKindOfShape,
    assetSrcForShape,
    materialFromShape,
    materialPayload,
    renameHolder,
    resetHolderName,
    createGenerationPanel
  }
  window.__cowartKit = kit
})()
