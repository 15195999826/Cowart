// Canvas chrome tweaks for the Cowart host adapters:
//  - the main menu loses "创建嵌入" (external embeds show blank under the page's security
//    policy; web pages come in as screenshot cards instead) and "上传媒体文件" (the
//    toolbar's 媒体 button does the same), and Ctrl+I no longer opens the embed dialog;
//  - the context menu gains 截取当前帧 for a video (the frame it was showing becomes an image
//    card beside it), 拷贝索引 for whatever is selected (page, shape id, what it is and its
//    file, on the clipboard, to paste into a chat so the agent knows which card is meant),
//    and 在资源管理器中显示 (在访达中显示 on a Mac) for a card backed by a file of the canvas
//    (image, web reference, video, AI HTML): the canvas service, on this machine for every
//    host, opens the file's folder with the file selected;
//  - the style panel (color / fill / dash / size) only shows while it has something to
//    style: a drawing tool is active or styled shapes are selected, not all the time;
//  - the context menu is left for Radix to close, so it still opens after a drag that
//    started while it was open (tldraw 5.1 bug, see below).
(() => {
  'use strict'
  const kit = window.__cowartKit
  if (!kit || window.__cowartCanvasChrome) return
  window.__cowartCanvasChrome = true

  // Tools whose next shape takes the panel's styles, and shapes that carry those styles.
  const STYLE_TOOLS = new Set(['draw', 'highlight', 'geo', 'arrow', 'line', 'text', 'note', 'frame', 'cowart-annotation'])
  const STYLED_SHAPES = new Set(['draw', 'highlight', 'geo', 'arrow', 'line', 'text', 'note', 'frame'])

  const style = document.createElement('style')
  style.id = 'cowart-canvas-chrome'
  style.textContent = `
    [data-testid="main-menu.insert-embed"], [data-testid="main-menu.insert-media"] { display: none !important; }
    html[data-cowart-style-panel="hidden"] .tlui-style-panel__wrapper { display: none !important; }
    /* File names and paths have nowhere to break: without this they run past the toast. */
    .tlui-toast__description { overflow-wrap: anywhere; }
  `
  document.head.appendChild(style)

  function isEditable(target) {
    return Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'i') return
      if (isEditable(event.composedPath()[0])) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )

  // ---- 拖动卡片以后右键菜单还能打开 -------------------------------------------------------
  // tldraw 5.1 renders the context menu as {isOpen && <Portal>} off its own editor.menus, so
  // dropping it from there unmounts Radix's content without Radix ever hearing that it closed.
  // Radix's Root is uncontrolled: it only reports a change of value, so it keeps open: true,
  // every later right click sets it to true again, tldraw never gets onOpenChange(true), and
  // the context menu never opens again (until the page reloads). A left-button press that
  // starts a drag on a card while the menu is open does exactly that: MenuClickCapture calls
  // clearOpenMenus() inside flushSync, before the press reaches the document, where Radix's
  // DismissableLayer would have seen the click outside and closed itself. tldraw's own
  // right-click path avoids this on purpose ("We don't clearOpenMenus() — Radix's
  // DismissableLayer closes the menu via outside-click detection, keeping its internal state
  // in sync"), so clearOpenMenus leaves the context menu alone as well: Radix closes it on the
  // same press, in step with tldraw, and everything else (the drag included) is unchanged.
  const CONTEXT_MENU = 'context menu'

  function leaveTheContextMenuToRadix(editor) {
    const menus = editor.menus
    if (!menus || menus.cowartLeavesTheContextMenuToRadix) return
    menus.cowartLeavesTheContextMenuToRadix = true
    menus.clearOpenMenus = (contextId) => {
      const suffix = contextId ? `-${contextId}` : null
      for (const id of menus.getOpenMenus()) {
        // Removed one by one: rewriting the whole list would unmount and remount the menu,
        // and its new DismissableLayer would miss the press that is closing it.
        if (suffix && !id.endsWith(suffix)) continue
        if (id.startsWith(CONTEXT_MENU)) continue
        menus.deleteOpenMenu(id)
      }
    }
  }
  kit.onEditor(leaveTheContextMenuToRadix)

  // ---- 截取当前帧 --------------------------------------------------------------------
  // Canvas videos play in a loop, so the frame the user right-clicked on is long gone by the
  // time the menu item is clicked: the frame is grabbed when the menu opens and kept for it.
  // It is drawn at the video's own resolution and placed at the card's size, right of it.
  const FRAME_GAP = 40
  let grabbed = null

  function selectedVideo(shapes) {
    return shapes.length === 1 && shapes[0].type === 'video' ? shapes[0] : null
  }

  function grabFrame(shape) {
    const video = document.querySelector(`video.tl-video-shape-${CSS.escape(shape.id.slice('shape:'.length))}`)
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
    const still = document.createElement('canvas')
    still.width = video.videoWidth
    still.height = video.videoHeight
    const context = still.getContext('2d')
    if (!context) return null
    try {
      context.drawImage(video, 0, 0, still.width, still.height)
      return { shapeId: shape.id, time: Number(video.currentTime) || 0, w: still.width, h: still.height, dataUrl: still.toDataURL('image/png') }
    } catch {
      // A video the browser counts as another origin's taints the canvas it is drawn on.
      return null
    }
  }

  // tldraw selects the shape under the pointer before the menu opens.
  window.addEventListener(
    'contextmenu',
    () => {
      const editor = window.__cowartEditor
      const video = editor && selectedVideo(editor.getSelectedShapes())
      grabbed = video ? grabFrame(video) : null
    },
    true
  )

  function videoBaseName(editor, video) {
    const asset = video.props && video.props.assetId ? editor.getAsset(video.props.assetId) : null
    const name = asset && asset.props && typeof asset.props.name === 'string' ? asset.props.name.trim() : ''
    return (name || '视频').replace(/\.[^.]+$/, '')
  }

  // The still goes on the canvas from the page (not the service), so Ctrl+Z takes it back.
  function placeFrame(editor, video, frame, saved, seconds) {
    const bounds = editor.getShapePageBounds(video.id)
    const width = bounds ? bounds.w : frame.w
    const height = Math.round((width * frame.h) / frame.w)
    const spot = kit.freePosition(editor, {
      x: (bounds ? bounds.maxX : video.x + width) + FRAME_GAP,
      y: bounds ? bounds.minY : video.y,
      w: width,
      h: height
    })
    const name = `${videoBaseName(editor, video)} ${seconds}s`
    const assetId = `asset:${kit.randomKey()}`
    const stillId = kit.randomShapeId()
    editor.run(() => {
      editor.createAssets([
        {
          id: assetId,
          typeName: 'asset',
          type: 'image',
          props: { name: `${name}.png`, src: saved.assetUrl, w: frame.w, h: frame.h, mimeType: 'image/png', isAnimated: false, fileSize: saved.fileSize },
          meta: {}
        }
      ])
      editor.createShape({
        id: stillId,
        type: 'image',
        parentId: editor.getCurrentPageId(),
        x: spot.x,
        y: spot.y,
        props: { assetId, w: width, h: height, altText: name },
        meta: { cowartVideoFrame: true, cowartVideoFrameOf: video.id, cowartVideoFrameTime: Number(seconds) }
      })
    })
    editor.select(stillId)
    kit.revealRect(editor, { x: spot.x, y: spot.y, w: width, h: height })
    return stillId
  }

  kit.registerContextMenuItem({
    id: 'capture-video-frame',
    label: '截取当前帧',
    isFor: (shapes) => Boolean(selectedVideo(shapes)),
    async onSelect({ editor, shapes, addToast }) {
      const video = selectedVideo(shapes)
      if (!video) return
      const frame = grabbed && grabbed.shapeId === video.id ? grabbed : grabFrame(video)
      if (!frame) {
        addToast({ title: '截不下这一帧', description: '视频还没出画面（或者本机放不了它），等它播起来再试。', severity: 'error' })
        return
      }
      const seconds = frame.time.toFixed(1)
      try {
        const saved = await kit.callTool('save_cowart_reference_image', {
          ...kit.projectArgs(),
          pageId: editor.getCurrentPageId(),
          fileName: `frame-${seconds.replace('.', '-')}s.png`,
          dataUrl: frame.dataUrl,
          mimeType: 'image/png'
        })
        placeFrame(editor, video, frame, saved, seconds)
        // Upstream refuses a save that drops images the user deleted but its autosave has not
        // reported yet; its own save follows, so a refusal here is not the capture's failure.
        await kit.saveCanvasNow().catch(() => {})
        addToast({ title: `已截下 ${seconds}s 这一帧`, description: `${frame.w}×${frame.h}，放在视频右边。` })
      } catch (error) {
        addToast({ title: '截帧失败', description: error instanceof Error ? error.message : String(error), severity: 'error' })
      }
    }
  })

  // ---- 拷贝索引 ----------------------------------------------------------------------
  // Every shape carries tldraw's own id (shape:…), which is what the canvas summary shows the
  // model, so a reference needs no numbering of its own. The service words it and writes the
  // clipboard (copy-reference.mjs); the page only names the ids.
  kit.registerContextMenuItem({
    id: 'copy-reference',
    label: (shapes) => (shapes.length > 1 ? `拷贝索引（${shapes.length} 个）` : '拷贝索引'),
    isFor: (shapes) => shapes.length > 0,
    async onSelect({ editor, shapes, addToast }) {
      try {
        // The service reads the shapes off the stored canvas, so a just-drawn one goes first.
        await kit.saveCanvasNow().catch(() => {})
        const copied = await kit.callTool('copy_cowart_reference', { ...kit.projectArgs(), shapeIds: shapes.map((shape) => shape.id) })
        const items = Array.isArray(copied.items) ? copied.items : []
        const single = items.length === 1 ? items[0] : null
        addToast({
          title: single ? '已拷贝索引' : `已拷贝 ${items.length || shapes.length} 个图形的索引`,
          ...(single ? { description: `${single.kind}${single.name ? `「${single.name}」` : ''}` } : {})
        })
      } catch (error) {
        addToast({ title: '拷不了索引', description: error instanceof Error ? error.message : String(error), severity: 'error' })
      }
    }
  })

  // Images and videos have their file as the asset. An AI HTML draft (an embed) names its
  // file in meta.cowartHtmlDraftAssetUrl, older ones only by their virtual URL; its
  // props.url is often the page inlined as a data: URL (the app reads them in this order).
  const HTML_DRAFT_ORIGIN = 'http://cowart.local'
  const LOCAL_ASSET = /^\/(page-assets|assets)\//
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
  const REVEAL_LABEL = /mac/i.test(platform) ? '在访达中显示' : /win/i.test(platform) ? '在资源管理器中显示' : '在文件夹中显示'

  function draftAssetUrl(value) {
    if (typeof value !== 'string') return null
    if (LOCAL_ASSET.test(value)) return value
    try {
      const url = new URL(value)
      return url.origin === HTML_DRAFT_ORIGIN ? url.pathname : null
    } catch {
      return null
    }
  }

  function canvasFileOf(editor, shape) {
    const src =
      shape && shape.type === 'embed'
        ? draftAssetUrl(shape.meta && shape.meta.cowartHtmlDraftAssetUrl) || draftAssetUrl(shape.props.url)
        : kit.assetSrcForShape(editor, shape)
    return typeof src === 'string' && LOCAL_ASSET.test(src) ? src : null
  }

  kit.registerContextMenuItem({
    id: 'reveal-file',
    label: REVEAL_LABEL,
    isFor: (shapes, editor) => shapes.length === 1 && Boolean(canvasFileOf(editor, shapes[0])),
    async onSelect({ editor, shapes, addToast }) {
      try {
        await kit.callTool('reveal_cowart_file', { ...kit.projectArgs(), assetUrl: canvasFileOf(editor, shapes[0]) })
      } catch (error) {
        addToast({ title: `没能${REVEAL_LABEL}`, description: error instanceof Error ? error.message : String(error), severity: 'error' })
      }
    }
  })

  // Cards (AI 图片 / AI 视频) are frames too, but their color is not worth a panel; the AI
  // HTML holder keeps it for upstream's size / ratio controls.
  function styleWorth(shape) {
    if (!STYLED_SHAPES.has(shape.type)) return false
    if (shape.type !== 'frame') return true
    if (shape.meta && shape.meta.cowartAiDraftHolder === true) return true
    return !kit.holderTypeOf(shape)
  }

  function panelWanted(editor) {
    if (editor.getEditingShapeId()) return true
    if (STYLE_TOOLS.has(editor.getCurrentToolId())) return true
    return editor.getSelectedShapes().some(styleWorth)
  }

  let shown = null
  function frame() {
    requestAnimationFrame(frame)
    const editor = window.__cowartEditor
    if (!editor) return
    const wanted = panelWanted(editor)
    if (wanted === shown) return
    shown = wanted
    if (wanted) document.documentElement.removeAttribute('data-cowart-style-panel')
    else document.documentElement.setAttribute('data-cowart-style-panel', 'hidden')
  }
  requestAnimationFrame(frame)
})()
