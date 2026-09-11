// "网页参考" for the Cowart host adapters: paste a web address on the canvas (or use the
// 网页 tool) and the adapter captures the page in a local browser; the full-page screenshot
// lands on the canvas as a card that remembers the address and the rendered page code.
// A selected card's image toolbar (the app's own row) gains two buttons: the site, which
// opens the original page, and "照这个做 HTML", which asks the agent for a single-file HTML
// version in an AI HTML holder beside the card, for side-by-side comparison; the 标注 arrows
// bound to the card go along. That button stands in for the row's 按标注生成 Html, and
// 替换 / 裁剪 leave the row (the card cannot be cropped either), so the screenshot keeps
// matching the page one to one.
(() => {
  'use strict'
  const kit = window.__cowartKit
  if (!kit || window.__cowartWebReference) return
  window.__cowartWebReference = true

  const TOOL_ID = 'web-reference'
  const LABEL = '网页'
  const CAPTURE_TOOL = 'capture_cowart_web_reference'
  const AI_HTML_LABEL = 'AI HTML'
  const PLACEHOLDER = { w: 1440, h: 900 }
  const OPEN_ITEM = 'web-open'
  const COPY_ITEM = 'web-copy'
  const POPOVER_GAP = 8
  // Crops sent along with each annotation: this much of the page around its spot (CSS px).
  const NOTE_CONTEXT = 280
  const NOTE_CROP_MAX = 1600
  const MAX_NOTES = 20
  const ICON =
    '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="3" y="5" width="24" height="20" rx="2.5" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M3 10.5H27" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="6.8" cy="7.8" r="1.1" fill="currentColor"/><circle cx="10" cy="7.8" r="1.1" fill="currentColor"/>' +
    '<path d="M9 15.5L12.5 19L9 22.5M15 22.5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'
  const GLOBE_ICON =
    '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M2 9H16M9 2C11 4 11.8 6.3 11.8 9S11 14 9 16C7 14 6.2 11.7 6.2 9S7 4 9 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '</svg>'
  const SPARKLE_ICON =
    '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8 2.5L9.3 6.7L13.5 8L9.3 9.3L8 13.5L6.7 9.3L2.5 8L6.7 6.7L8 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M14 11.5L14.6 13.4L16.5 14L14.6 14.6L14 16.5L13.4 14.6L11.5 14L13.4 13.4L14 11.5Z" fill="currentColor"/>' +
    '</svg>'

  function isWebCard(shape) {
    return Boolean(shape && shape.type === 'image' && shape.meta && shape.meta.cowartWebReference === true)
  }

  function isAiHtmlHolder(shape) {
    return Boolean(shape && shape.type === 'frame' && shape.meta && shape.meta.cowartAiDraftHolder === true)
  }

  // Web pages only: the app's own draft addresses (cowart.local) keep their handling.
  function isWebUrl(value) {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== 'cowart.local'
    } catch {
      return false
    }
  }

  function withScheme(value) {
    const text = String(value || '').trim()
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  }

  function hostOf(value) {
    try {
      return new URL(value).hostname.replace(/^www\./, '')
    } catch {
      return String(value || '')
    }
  }

  // AI HTML holders (upstream's) behave like the other cards and get their name back when
  // a request is skipped.
  kit.registerHolderType({ isHolder: isAiHtmlHolder, label: AI_HTML_LABEL })

  // In a card's image toolbar (recognized by the buttons added below), 照这个做 HTML stands
  // in for 按标注生成 Html, and 替换 / 裁剪 do not apply to a page screenshot.
  const pageStyle = document.createElement('style')
  pageStyle.id = 'cowart-web-reference-style'
  pageStyle.textContent = `
    .tlui-media__toolbar:has([data-testid="tool.cowart-extension-${COPY_ITEM}"])
      :is([data-testid="tool.image-replace"], [data-testid="tool.image-crop"], [data-testid="tool.cowart-annotation-html"]) {
      display: none !important;
    }
  `
  document.head.appendChild(pageStyle)

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .popover[hidden], .dialog[hidden], .toast[hidden] { display: none; }
    .act { height: 30px; padding: 0 10px; color: #18181b; font-size: 12px; white-space: nowrap; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
    .act:hover { background: #f4f4f5; }
    .act.primary { color: #fff; background: #2f80ed; }
    .act.primary:hover { background: #226fda; }
    .popover, .dialog {
      position: fixed; display: grid; gap: 10px; width: 440px; padding: 14px 16px; color: #1f2430; background: rgba(255, 255, 255, 0.98);
      border: 1px solid #d5dbe5; border-radius: 16px; pointer-events: auto;
      box-shadow: 0 30px 74px rgba(15, 23, 42, 0.12), 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    .title { font-size: 13px; font-weight: 600; }
    .note { color: #8b93a0; font-size: 12px; line-height: 1.5; }
    textarea, input {
      width: 100%; padding: 8px 10px; color: #1f2430; font-size: 14px; line-height: 1.5; background: #f7f8fa;
      border: 1px solid #e4e7ec; border-radius: 10px; outline: 0; resize: none;
    }
    textarea:focus, input:focus { border-color: #93c5fd; background: #fff; }
    .notes b { color: #1f2430; font-weight: 600; }
    .row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .status { flex: 1; min-width: 0; overflow: hidden; color: #c2410c; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .status.progress { color: #8b93a0; }
    .toast {
      position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%); max-width: 520px; padding: 8px 14px; color: #fff;
      font-size: 13px; background: rgba(17, 24, 39, 0.9); border-radius: 999px; pointer-events: none;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    }
    .toast.error { background: rgba(194, 65, 12, 0.94); }
    .loading {
      position: fixed; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      color: #5b6472; font-size: 13px; text-align: center; background: rgba(244, 246, 250, 0.92); border-radius: 4px;
      pointer-events: none; overflow: hidden;
    }
    .loading .spinner {
      width: 26px; height: 26px; border: 3px solid #d6e4fb; border-top-color: #2f80ed; border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .loading small { color: #8b93a0; font-size: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `

  const hostElement = document.createElement('div')
  hostElement.id = 'cowart-web-reference'
  hostElement.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147481500;'
  const root = hostElement.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>${UI_CSS}</style>
    <div class="popover" hidden>
      <div class="title">照这个网页做一版 HTML</div>
      <div class="note notes"></div>
      <textarea rows="3" placeholder="补充要求（可不填）：比如只要配色和排版、做成深色版、换成我们游戏的文案…"></textarea>
      <div class="row"><span class="status"></span><button class="act cancel" type="button">取消</button><button class="act primary send" type="button">发送</button></div>
    </div>
    <div class="dialog" hidden>
      <div class="title">网页参考</div>
      <input type="url" placeholder="粘贴或输入网址，例如 https://example.com">
      <div class="note">程序会在后台打开网页，截一张整页长图放到画布上，并存一份渲染后的页面代码，方便 AI 照着做。也可以直接在画布上粘贴网址。</div>
      <div class="row"><span class="status"></span><button class="act cancel" type="button">取消</button><button class="act primary go" type="button">截图放上画布</button></div>
    </div>
    <div class="toast" hidden></div>`

  const popover = root.querySelector('.popover')
  const popoverInput = popover.querySelector('textarea')
  const popoverNotes = popover.querySelector('.notes')
  const popoverStatus = popover.querySelector('.status')
  const sendButton = popover.querySelector('.send')
  const dialog = root.querySelector('.dialog')
  const dialogInput = dialog.querySelector('input')
  const dialogStatus = dialog.querySelector('.status')
  const toast = root.querySelector('.toast')

  let toastTimer = null
  function showToast(text, kind = '') {
    clearTimeout(toastTimer)
    toast.textContent = text
    toast.className = `toast${kind ? ` ${kind}` : ''}`
    toast.hidden = false
    toastTimer = setTimeout(() => {
      toast.hidden = true
    }, kind === 'error' ? 6000 : 3000)
  }

  // ---- Capture ------------------------------------------------------------------------

  // A placeholder frame holds the spot while the page is captured, then the card replaces it.
  async function captureToCanvas(editor, rawUrl, point) {
    const url = withScheme(rawUrl)
    if (!isWebUrl(url)) {
      showToast(`这不是网页地址：${rawUrl}`, 'error')
      return
    }
    const center = point || editor.getViewportPageBounds().center
    const position = kit.freePosition(editor, { x: center.x - PLACEHOLDER.w / 2, y: center.y - PLACEHOLDER.h / 2, ...PLACEHOLDER })
    const placeholderId = kit.randomShapeId()
    capturing.add(placeholderId)
    editor.createShape({
      id: placeholderId,
      type: 'frame',
      parentId: editor.getCurrentPageId(),
      x: position.x,
      y: position.y,
      props: { w: PLACEHOLDER.w, h: PLACEHOLDER.h, name: `网页 · 截图中… ${hostOf(url)}`, color: 'blue' },
      meta: { cowartWebCapturing: true, cowartWebUrl: url }
    })
    kit.revealRect(editor, { ...position, ...PLACEHOLDER })
    showToast(`正在打开并截图 ${hostOf(url)}，长页面要十几秒…`)
    // Saved explicitly: the capture takes a while and the page may be hidden by then.
    kit.saveCanvasNow().catch(() => {})
    try {
      const captured = await kit.callTool(CAPTURE_TOOL, { url, pageId: editor.getCurrentPageId(), ...kit.projectArgs() })
      const spot = editor.getShape(placeholderId) || position
      const assetId = `asset:${kit.randomKey()}`
      const cardId = kit.randomShapeId()
      editor.run(() => {
        // The placeholder goes first: a shape created inside a frame becomes its child, and
        // deleting the frame afterwards would take the new card with it.
        if (editor.getShape(placeholderId)) editor.deleteShape(placeholderId)
        editor.createAssets([
          {
            id: assetId,
            typeName: 'asset',
            type: 'image',
            props: {
              name: captured.screenshot.fileName,
              src: captured.screenshot.assetUrl,
              w: captured.imageWidth,
              h: captured.imageHeight,
              mimeType: 'image/png',
              isAnimated: false,
              fileSize: captured.screenshot.fileSize
            },
            meta: {}
          }
        ])
        editor.createShape({
          id: cardId,
          type: 'image',
          parentId: editor.getCurrentPageId(),
          x: spot.x,
          y: spot.y,
          props: { assetId, w: captured.width, h: captured.height, altText: captured.title || captured.url },
          meta: {
            cowartWebReference: true,
            cowartWebUrl: captured.url,
            cowartWebTitle: captured.title,
            cowartWebCapturedAt: captured.capturedAt,
            cowartWebHtmlAsset: captured.html.assetUrl,
            cowartWebViewport: captured.width,
            cowartWebTruncated: captured.truncated
          }
        })
      })
      editor.select(cardId)
      // Upstream refuses a save that drops images the user deleted but its autosave has not
      // reported yet; its own save follows, so a refusal here is not the capture's failure.
      await kit.saveCanvasNow().catch(() => {})
      showToast(`已放上画布：${captured.title || hostOf(captured.url)}${captured.truncated ? '（页面太长，只截了前一部分）' : ''}`)
    } catch (error) {
      if (editor.getShape(placeholderId)) {
        editor.deleteShape(placeholderId)
        kit.saveCanvasNow().catch(() => {})
      }
      showToast(`截图失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      capturing.delete(placeholderId)
    }
  }

  // Pasted or dropped web addresses become web reference cards instead of bookmarks / embeds.
  kit.onEditor((editor) => {
    const previous = editor.externalContentHandlers && editor.externalContentHandlers.url
    editor.registerExternalContentHandler('url', (info) => {
      if (isWebUrl(info.url)) return captureToCanvas(editor, info.url, info.point)
      return previous ? previous(info) : undefined
    })
    // Cropping (double-click, Enter, Ctrl + handle) would break the one-to-one match between
    // the screenshot and the page.
    const imageUtil = editor.getShapeUtil('image')
    const canCrop = imageUtil.canCrop.bind(imageUtil)
    imageUtil.canCrop = (shape) => !isWebCard(shape) && canCrop(shape)
  })

  // ---- The 网页 tool: a small dialog for an address --------------------------------------

  function openDialog() {
    closePopover()
    dialogStatus.textContent = ''
    dialogInput.value = ''
    dialog.hidden = false
    const width = Math.min(440, window.innerWidth - 32)
    dialog.style.width = `${width}px`
    dialog.style.left = `${Math.round((window.innerWidth - width) / 2)}px`
    dialog.style.top = `${Math.round(window.innerHeight - 330)}px`
    requestAnimationFrame(() => dialogInput.focus())
  }

  function closeDialog() {
    dialog.hidden = true
  }

  function submitDialog() {
    const editor = window.__cowartEditor
    const value = dialogInput.value.trim()
    if (!value) {
      dialogStatus.textContent = '先填一个网址。'
      return
    }
    if (!isWebUrl(withScheme(value))) {
      dialogStatus.textContent = '这不是网页地址。'
      return
    }
    closeDialog()
    if (editor) captureToCanvas(editor, value, null)
  }

  dialog.querySelector('.go').addEventListener('click', submitDialog)
  dialog.querySelector('.cancel').addEventListener('click', closeDialog)
  dialogInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitDialog()
    if (event.key === 'Escape') closeDialog()
  })

  // ---- Annotations on a card ------------------------------------------------------------

  // The 标注 arrows bound to the card (the app's 标注 tool binds an arrow's tip to the card it
  // was released on), in reading order of their tips; each one's words are its label.
  function cardAnnotations(editor, card) {
    const notes = []
    for (const binding of editor.getBindingsToShape(card.id, 'arrow')) {
      if (binding.props.terminal !== 'end') continue
      const arrow = editor.getShape(binding.fromId)
      if (!arrow || !arrow.meta || arrow.meta.cowartAnnotationArrow !== true) continue
      const tip = (editor.getShapeHandles(arrow) || []).find((handle) => handle.id === 'end')
      if (!tip) continue
      const util = editor.getShapeUtil(arrow)
      notes.push({
        arrowId: arrow.id,
        note: arrow.meta.cowartAnnotationNote === true,
        text: String(util.getText(arrow) || '').trim(),
        point: editor.getShapePageTransform(arrow.id).applyToPoint(tip),
        box: editor.getShapePageBounds(arrow.id)
      })
    }
    return notes.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x).slice(0, MAX_NOTES)
  }

  // Each note travels with a crop of the card around its spot, the arrow drawn on it, at the
  // page's own resolution; positions are in the captured page's CSS pixels.
  async function exportAnnotations(editor, card, notes) {
    const bounds = editor.getShapePageBounds(card.id)
    const Box = bounds.constructor
    const scale = (Number(card.meta.cowartWebViewport) || bounds.w) / bounds.w
    const exported = []
    for (const note of notes) {
      const reach = NOTE_CONTEXT / scale
      const minX = Math.min(note.point.x - reach, note.box.minX)
      const minY = Math.min(note.point.y - reach, note.box.minY)
      const maxX = Math.max(note.point.x + reach, note.box.maxX)
      const maxY = Math.max(note.point.y + reach, note.box.maxY)
      const region = new Box(minX, minY, maxX - minX, maxY - minY).expandBy(16 / scale)
      const image = await editor.toImageDataUrl([card.id, note.arrowId], {
        bounds: region,
        background: true,
        darkMode: false,
        format: 'png',
        padding: 0,
        pixelRatio: Math.min(2, scale, NOTE_CROP_MAX / Math.max(region.w, region.h))
      })
      exported.push({
        note: note.note,
        text: note.text,
        x: Math.round((note.point.x - bounds.minX) * scale),
        y: Math.round((note.point.y - bounds.minY) * scale),
        crop: image.url
      })
    }
    return exported
  }

  // ---- The toolbar buttons and the "照这个做 HTML" popover -------------------------------

  let popoverCardId = null

  function setPopoverStatus(text, kind = 'error') {
    popoverStatus.textContent = text
    popoverStatus.className = `status ${kind}`
  }

  function movePopover(centerX, top) {
    const width = Math.min(440, window.innerWidth - 16)
    popover.style.width = `${width}px`
    popover.style.left = `${Math.round(Math.min(Math.max(centerX - width / 2, 8), window.innerWidth - width - 8))}px`
    popover.style.top = `${Math.round(Math.max(Math.min(top, window.innerHeight - popover.offsetHeight - 8), 8))}px`
  }

  // Under the toolbar button that opens it. While the toolbar is off screen (the card is
  // being moved, or its middle is out of view) the popover stays where it is.
  function placePopover() {
    const button = document.querySelector(`[data-testid="tool.cowart-extension-${COPY_ITEM}"]`)
    const toolbar = button && button.closest('.tlui-contextual-toolbar')
    if (!toolbar || toolbar.dataset.visible === 'false') return false
    const row = toolbar.getBoundingClientRect()
    if (row.bottom <= 0 || row.top >= window.innerHeight) return false
    const anchor = button.getBoundingClientRect()
    movePopover(anchor.left + anchor.width / 2, row.bottom + POPOVER_GAP)
    return true
  }

  function openPopover(editor, card) {
    popoverCardId = card.id
    setPopoverStatus('')
    const annotations = cardAnnotations(editor, card)
    const requests = annotations.filter((note) => !note.note).length
    const notes = annotations.length - requests
    const noteText = notes ? `，另带 <b>${notes} 条注释</b>作背景参考` : ''
    popoverNotes.innerHTML = requests
      ? `会带上卡片上的 <b>${requests} 处标注</b>${noteText}：AI 按标注改，没标到的地方照原网页做。`
      : `照原网页复刻${noteText}。想改哪里，先用底部「标注」工具拖一根箭头，指到卡片上要改的地方松手、写上要求，再点这里。`
    popover.hidden = false
    if (!placePopover()) {
      const bounds = editor.getShapePageBounds(card.id)
      const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
      const topRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.minY })
      movePopover((topLeft.x + topRight.x) / 2, topLeft.y + POPOVER_GAP)
    }
    requestAnimationFrame(() => popoverInput.focus())
  }

  function closePopover() {
    popover.hidden = true
    popoverCardId = null
  }

  // A new AI HTML holder the size of the card, to its right (each version further right).
  function createHolder(editor, card) {
    const bounds = editor.getShapePageBounds(card.id)
    const size = { w: Math.round(bounds.w), h: Math.round(bounds.h) }
    const position = kit.freePosition(editor, { x: bounds.maxX + kit.HOLDER_GAP, y: bounds.minY, ...size })
    const id = kit.randomShapeId()
    editor.createShape({
      id,
      type: 'frame',
      parentId: editor.getCurrentPageId(),
      x: position.x,
      y: position.y,
      props: { ...size, name: AI_HTML_LABEL, color: 'blue' },
      meta: { cowartAiDraftHolder: true, cowartAiDraftHolderVersion: 1, cowartWebSourceShapeId: card.id }
    })
    return { id, rect: { ...position, ...size } }
  }

  async function sendCopyRequest() {
    const editor = window.__cowartEditor
    const card = editor && popoverCardId ? editor.getShape(popoverCardId) : null
    if (!isWebCard(card) || sendButton.disabled) return
    sendButton.disabled = true
    setPopoverStatus('')
    let holder = null
    try {
      const notes = cardAnnotations(editor, card)
      if (notes.length) setPopoverStatus(`正在截取 ${notes.length} 处标注…`, 'progress')
      const annotations = await exportAnnotations(editor, card, notes)
      holder = createHolder(editor, card)
      await kit.sendGenerationRequest({
        kind: 'web',
        holderShapeId: holder.id,
        body: { prompt: popoverInput.value.trim(), sourceShapeId: card.id, annotations }
      })
      kit.renameHolder(holder.id, `${AI_HTML_LABEL} · 已发送`)
      popoverInput.value = ''
      closePopover()
      kit.revealRect(editor, holder.rect)
      showToast(kit.host === 'codex' ? '已发送给 Codex' : `已发送，请到 ${kit.hostName} 对话里确认`)
    } catch (error) {
      if (holder && editor.getShape(holder.id)) editor.deleteShape(holder.id)
      setPopoverStatus(error instanceof Error ? error.message : String(error))
    } finally {
      sendButton.disabled = false
    }
  }

  // The card's own buttons, after the app's in its image toolbar.
  kit.registerImageToolbarItem({
    id: OPEN_ITEM,
    label: (shape) => hostOf(shape.meta.cowartWebUrl),
    title: (shape) => `打开原网页：${shape.meta.cowartWebUrl}`,
    iconSvg: GLOBE_ICON,
    isFor: isWebCard,
    onSelect: ({ shape }) => kit.openLink(shape.meta.cowartWebUrl)
  })
  kit.registerImageToolbarItem({
    id: COPY_ITEM,
    label: '照这个做 HTML',
    title: '照这个网页做一版 HTML，放在卡片右边对比（带上卡片上的标注）',
    iconSvg: SPARKLE_ICON,
    isFor: isWebCard,
    onSelect: ({ editor, shape }) => (!popover.hidden && popoverCardId === shape.id ? closePopover() : openPopover(editor, shape))
  })

  popover.querySelector('.cancel').addEventListener('click', closePopover)
  sendButton.addEventListener('click', sendCopyRequest)
  popoverInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendCopyRequest()
    if (event.key === 'Escape') closePopover()
  })

  // A spinner over each placeholder while its page is being captured; a placeholder whose
  // capture this page did not start (it reloaded mid-capture) says so instead of spinning.
  const loadingViews = new Map()
  const capturing = new Set()

  function renderLoading(editor) {
    const placeholders = editor.getCurrentPageShapes().filter((shape) => shape.type === 'frame' && shape.meta && shape.meta.cowartWebCapturing === true)
    const live = new Set()
    for (const shape of placeholders) {
      live.add(shape.id)
      let view = loadingViews.get(shape.id)
      const running = capturing.has(shape.id)
      if (view && view.dataset.running !== String(running)) {
        view.remove()
        view = null
      }
      if (!view) {
        view = document.createElement('div')
        view.className = 'loading'
        view.dataset.running = String(running)
        view.innerHTML = running
          ? '<div class="spinner"></div><div class="text"></div><small>长页面要十几秒，可以先去做别的</small>'
          : '<div class="text"></div><small>页面刷新时截图中断了：删掉这个框，重新粘贴网址</small>'
        view.querySelector('.text').textContent = running ? `正在打开并截图 ${hostOf(shape.meta.cowartWebUrl)}…` : `${hostOf(shape.meta.cowartWebUrl)} 没截完`
        root.appendChild(view)
        loadingViews.set(shape.id, view)
      }
      const bounds = editor.getShapePageBounds(shape.id)
      const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
      const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
      view.style.left = `${Math.round(topLeft.x + 1)}px`
      view.style.top = `${Math.round(topLeft.y + 1)}px`
      view.style.width = `${Math.max(0, Math.round(bottomRight.x - topLeft.x - 2))}px`
      view.style.height = `${Math.max(0, Math.round(bottomRight.y - topLeft.y - 2))}px`
    }
    for (const [id, view] of loadingViews) {
      if (live.has(id)) continue
      view.remove()
      loadingViews.delete(id)
    }
  }

  // Loading spinners follow their placeholders; the popover follows the toolbar and closes
  // once its card is no longer the selection.
  function frame() {
    requestAnimationFrame(frame)
    const editor = window.__cowartEditor
    if (!editor) return
    renderLoading(editor)
    if (popover.hidden) return
    const shape = editor.getOnlySelectedShape()
    if (!shape || shape.id !== popoverCardId) closePopover()
    else placePopover()
  }

  function start() {
    document.body.appendChild(hostElement)
    kit.stopCanvasEvents(root)
    requestAnimationFrame(frame)
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })

  // Register before the app module runs; the patched toolbar puts it after 媒体.
  kit.registerTool({ id: TOOL_ID, label: LABEL, iconSvg: ICON, after: 'asset', onSelect: () => openDialog() })
})()
