// Canvas video playback for the Cowart host adapters: autoplay that survives reduced
// motion and hidden tabs, and a control bar that keeps video shapes draggable.
(() => {
  'use strict'
  const kit = window.__cowartKit
  if (!kit || window.__cowartVideoPlayback) return
  window.__cowartVideoPlayback = true

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
