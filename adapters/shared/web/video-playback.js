// Canvas video playback for the Cowart host adapters: autoplay that survives reduced
// motion and hidden tabs, and a control bar that keeps video shapes draggable.
(() => {
  'use strict'
  const kit = window.__cowartKit
  if (!kit || window.__cowartVideoPlayback) return
  window.__cowartVideoPlayback = true

  // Media failures belong to the card, not the connection pill. A connected
  // service does not mean a file transferred or decoded successfully.
  const failures = new Map()
  const notices = new Map()
  const failureStyle = document.createElement('style')
  failureStyle.textContent = `
    .cowart-video-failed .tl-video-container > :not(video) { display: none !important; }
    .cowart-video-error { position: fixed; z-index: 2147481900; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px; padding: 10px; box-sizing: border-box;
      background: #fff1f2; color: #9f1239; border: 1px solid #fda4af; border-radius: 6px;
      font: 13px/1.4 system-ui, sans-serif; text-align: center; overflow: hidden; }
    .cowart-video-error[hidden] { display: none; }
    .cowart-video-error button { padding: 4px 14px; cursor: pointer; }
  `
  document.head.appendChild(failureStyle)

  function assetForVideo(video) {
    const name = [...video.classList].find((value) => value.startsWith('tl-video-shape-'))
    const shape = name && window.__cowartEditor?.getShape(`shape:${name.slice('tl-video-shape-'.length)}`)
    return shape?.props.assetId
  }

  function mediaFailed(video) {
    const assetId = assetForVideo(video)
    if (!assetId) return
    const message = video.error?.message || '视频被宿主阻止、文件损坏或格式不受支持。'
    failures.set(assetId, { message, src: window.__cowartEditor.getAsset(assetId)?.props.src })
  }

  window.addEventListener('cowart:asset-load', ({ detail }) => {
    if (!detail?.assetId) return
    const props = window.__cowartEditor?.getAsset(detail.assetId)?.props
    if (!props || detail.cacheKey !== [props.src ?? '', props.fileSize ?? '', props.mimeType ?? '', props.name ?? ''].join('\u001f')) return
    if (detail.error) failures.set(detail.assetId, { message: detail.error, src: props.src })
    else failures.delete(detail.assetId)
  })

  function renderFailures(editor) {
    const visible = new Set()
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'video') continue
      const assetId = shape.props.assetId
      const failure = failures.get(assetId)
      if (!failure) continue
      if (failure.src !== editor.getAsset(assetId)?.props.src) { failures.delete(assetId); continue }
      visible.add(shape.id)
      let notice = notices.get(shape.id)
      if (!notice) {
        const element = document.createElement('div')
        element.className = 'cowart-video-error'
        element.dataset.shapeId = shape.id
        element.setAttribute('role', 'status')
        const label = document.createElement('span')
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.textContent = '重试'
        element.append(label, retry)
        kit.stopCanvasEvents(element)
        retry.addEventListener('click', () => {
          const currentAssetId = editor.getShape(shape.id)?.props.assetId
          const current = failures.get(currentAssetId)
          if (!current) return
          current.retrying = true
          const src = editor.getAsset(currentAssetId)?.props.src || ''
          if (/^\/(page-assets|assets)\//.test(src)) {
            window.dispatchEvent(new CustomEvent('cowart:retry-asset', { detail: { assetId: currentAssetId } }))
          } else {
            videoElementForShape(shape.id)?.load()
          }
        })
        document.body.appendChild(element)
        notice = { element, label, retry, container: null }
        notices.set(shape.id, notice)
      }
      const container = document.getElementById(shape.id)
      notice.container?.classList.toggle('cowart-video-failed', notice.container === container)
      container?.classList.add('cowart-video-failed')
      notice.container = container
      notice.label.textContent = failure.retrying ? '正在重新加载视频…' : '视频加载失败'
      notice.element.title = failure.message
      notice.retry.disabled = Boolean(failure.retrying)
      const bounds = editor.getShapePageBounds(shape.id)
      const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
      const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
      Object.assign(notice.element.style, { left: `${topLeft.x}px`, top: `${topLeft.y}px`, width: `${bottomRight.x - topLeft.x}px`, height: `${bottomRight.y - topLeft.y}px` })
      notice.element.hidden = editor.getCulledShapes().has(shape.id)
    }
    for (const [id, notice] of notices) {
      if (visible.has(id)) continue
      notice.container?.classList.remove('cowart-video-failed')
      notice.element.remove()
      notices.delete(id)
    }
    for (const id of failures.keys()) if (!editor.getAsset(id)) failures.delete(id)
  }

  function formatTime(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  function videoElementForShape(shapeId) {
    const className = `tl-video-shape-${String(shapeId).split(':')[1] || ''}`
    for (const video of document.querySelectorAll('video.tl-video')) {
      if (video.classList.contains(className)) return video
    }
    return null
  }

  function togglePlayback(video) {
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.dataset.cowartUserPaused = '1'
      video.pause()
    }
  }

  // tldraw skips autoplay when the OS asks for reduced motion (common on Windows with
  // animations turned off), so canvas videos looked like still images. Play canvas videos
  // muted and looped like tldraw's default, resume them when the page becomes visible
  // again (browsers pause them in hidden tabs), and leave videos the user paused alone.
  function autoplayCanvasVideos() {
    const resume = (video) => {
      if (video.paused && !video.controls && !video.dataset.cowartUserPaused && !document.hidden) {
        video.play().catch(() => {})
      }
    }
    const startVideo = (video) => {
      if (video.dataset.cowartAutoplay) return
      video.dataset.cowartAutoplay = '1'
      // A <source> error does not bubble, so listen in capture phase as well.
      video.addEventListener('error', () => mediaFailed(video), true)
      video.addEventListener('loadeddata', () => failures.delete(assetForVideo(video)))
      if (video.error || video.networkState === 3) mediaFailed(video)
      video.addEventListener('pause', () => {
        if (video.controls) video.dataset.cowartUserPaused = '1'
      })
      video.addEventListener('play', () => {
        delete video.dataset.cowartUserPaused
      })
      if (video.readyState >= 2) resume(video)
      else video.addEventListener('loadeddata', () => resume(video), { once: true })
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) document.querySelectorAll('video.tl-video').forEach(resume)
    })
    const scan = (root) => {
      if (root.matches && root.matches('video.tl-video')) startVideo(root)
      if (root.querySelectorAll) root.querySelectorAll('video.tl-video').forEach(startVideo)
    }
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) if (node.nodeType === 1) scan(node)
      }
    }).observe(document.body, { childList: true, subtree: true })
    scan(document.body)
  }

  const VIDEO_BAR_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .bar {
      position: fixed; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px;
      border-radius: 10px; background: rgba(17, 24, 39, 0.88); color: #fff; font-size: 12px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22); pointer-events: auto; user-select: none;
    }
    .bar[hidden] { display: none; }
    button {
      width: 26px; height: 26px; flex: none; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: #fff; font-size: 13px; line-height: 26px; cursor: pointer;
    }
    button:hover { background: rgba(255, 255, 255, 0.16); }
    input[type=range] { flex: 1; min-width: 60px; margin: 0; accent-color: #60a5fa; cursor: pointer; }
    .time { flex: none; font-variant-numeric: tabular-nums; color: #e5e7eb; white-space: nowrap; }
  `

  // tldraw's video "editing" mode hands every pointer event to the native player, so the
  // shape can no longer be dragged until the user clicks elsewhere. Videos therefore never
  // enter editing here: double-click toggles playback, and a selected video gets a small
  // control bar below it that leaves dragging and resize handles untouched.
  function setupVideoControls() {
    const hostElement = document.createElement('div')
    hostElement.id = 'cowart-video-bar'
    hostElement.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147482000;'
    const root = hostElement.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>${VIDEO_BAR_CSS}</style>
      <div class="bar" hidden>
        <button class="play" type="button" title="播放 / 暂停（双击视频也可以）"></button>
        <input class="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="播放进度">
        <span class="time"></span>
        <button class="sound" type="button" title="开 / 关声音"></button>
      </div>`
    document.body.appendChild(hostElement)
    kit.stopCanvasEvents(root)

    const bar = root.querySelector('.bar')
    const playButton = root.querySelector('.play')
    const seek = root.querySelector('.seek')
    const timeLabel = root.querySelector('.time')
    const soundButton = root.querySelector('.sound')

    let video = null
    let seeking = false
    const shown = { play: '', sound: '', time: '' }

    playButton.addEventListener('click', () => togglePlayback(video))
    soundButton.addEventListener('click', () => {
      if (video) video.muted = !video.muted
    })
    seek.addEventListener('pointerdown', () => {
      seeking = true
    })
    seek.addEventListener('input', () => {
      if (video && Number.isFinite(video.duration)) video.currentTime = Number(seek.value)
    })
    seek.addEventListener('change', () => {
      seeking = false
    })
    window.addEventListener('pointerup', () => {
      seeking = false
    }, true)

    kit.onEditor((editor) => {
      editor.sideEffects.registerAfterChangeHandler('instance_page_state', (previous, next) => {
        const shapeId = next.editingShapeId
        if (!shapeId || shapeId === previous.editingShapeId || editor.getShape(shapeId)?.type !== 'video') return
        queueMicrotask(() => {
          if (editor.getEditingShapeId() === shapeId) editor.cancel()
          togglePlayback(videoElementForShape(shapeId))
        })
      })
    })

    function setText(element, key, value) {
      if (shown[key] === value) return
      shown[key] = value
      element.textContent = value
    }

    function frame() {
      requestAnimationFrame(frame)
      const editor = window.__cowartEditor
      if (!editor) return
      if (failures.size || notices.size) renderFailures(editor)

      const shape = editor.getOnlySelectedShape()
      const element = shape && shape.type === 'video' ? videoElementForShape(shape.id) : null
      const dragging = editor.inputs.getIsDragging ? editor.inputs.getIsDragging() : editor.inputs.isDragging
      if (!element || (dragging && !seeking)) {
        bar.hidden = true
        video = null
        return
      }

      video = element
      const bounds = editor.getShapePageBounds(shape.id)
      const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
      const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
      const width = Math.min(Math.max(bottomRight.x - topLeft.x, 240), 420)
      const left = Math.min(Math.max((topLeft.x + bottomRight.x) / 2 - width / 2, 8), window.innerWidth - width - 8)
      const top = Math.min(bottomRight.y + 10, window.innerHeight - 96)
      bar.style.left = `${Math.round(left)}px`
      bar.style.top = `${Math.round(top)}px`
      bar.style.width = `${Math.round(width)}px`

      const duration = Number.isFinite(element.duration) ? element.duration : 0
      setText(playButton, 'play', element.paused ? '▶' : '⏸')
      setText(soundButton, 'sound', element.muted ? '🔇' : '🔊')
      setText(timeLabel, 'time', `${formatTime(element.currentTime)} / ${formatTime(duration)}`)
      seek.max = String(duration || 1)
      if (!seeking) seek.value = String(element.currentTime)
      bar.hidden = false
    }

    requestAnimationFrame(frame)
  }

  function start() {
    autoplayCanvasVideos()
    setupVideoControls()
  }

  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
})()
