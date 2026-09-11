// Canvas chrome tweaks for the Cowart host adapters:
//  - the main menu loses "创建嵌入" (external embeds show blank under the page's security
//    policy; web pages come in as screenshot cards instead) and "上传媒体文件" (the
//    toolbar's 媒体 button does the same), and Ctrl+I no longer opens the embed dialog;
//  - the style panel (color / fill / dash / size) only shows while it has something to
//    style: a drawing tool is active or styled shapes are selected, not all the time.
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
