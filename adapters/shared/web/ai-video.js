// "AI 视频" for the Cowart host adapters: a bottom-toolbar tool (through the app's
// extension hook) that drops a holder frame, and the prompt panel for it. The models come
// from the host config (adapters/shared/video-models.mjs).
(() => {
  'use strict'
  const kit = window.__cowartKit
  const VIDEO_MODELS = kit && Array.isArray(kit.hostConfig.videoModels) ? kit.hostConfig.videoModels : []
  if (!kit || VIDEO_MODELS.length === 0 || window.__cowartAiVideo) return
  window.__cowartAiVideo = true

  const TOOL_ID = 'ai-video'
  const LABEL = 'AI 视频'
  const DEFAULT_LONG_SIDE = 640
  const MATERIAL_NAMES = { images: '图', videos: '视频', audios: '音频' }
  const LIMIT_NAMES = { images: '张参考图', videos: '段参考视频', audios: '段参考音频' }
  // Local H3 wall time from the beast-gen measurements (seconds for 5 s and 15 s clips).
  const H3_ESTIMATES = { '480P': { turbo: [30, 180], full: [70, 420] }, '720P': { turbo: [120, 600], full: [300, 1800] } }
  const ICON =
    '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M13 3H4.5C3.67 3 3 3.67 3 4.5V25.5C3 26.33 3.67 27 4.5 27H25.5C26.33 27 27 26.33 27 25.5V17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M11.5 12.8V22.2C11.5 22.97 12.33 23.45 13 23.06L21.1 18.36C21.77 17.97 21.77 17.03 21.1 16.64L13 11.94C12.33 11.55 11.5 12.03 11.5 12.8Z" fill="currentColor"/>' +
    '<path d="M22.25 12.5C22.09 12.5 21.95 12.45 21.83 12.34C21.71 12.23 21.63 12.09 21.6 11.92C21.5 11.25 21.39 10.67 21.28 10.18C21.17 9.7 21.04 9.29 20.89 8.95C20.74 8.61 20.55 8.33 20.33 8.11C20.1 7.88 19.82 7.69 19.49 7.55C19.16 7.4 18.75 7.28 18.28 7.18C17.81 7.08 17.25 6.99 16.6 6.9C16.43 6.88 16.28 6.8 16.17 6.68C16.06 6.56 16 6.41 16 6.25C16 6.08 16.06 5.94 16.17 5.82C16.28 5.69 16.43 5.62 16.61 5.59C17.39 5.51 18.04 5.4 18.57 5.29C19.1 5.17 19.54 5 19.89 4.8C20.23 4.59 20.51 4.31 20.72 3.96C20.93 3.61 21.11 3.16 21.24 2.61C21.37 2.06 21.49 1.39 21.6 0.58C21.63 0.41 21.7 0.27 21.82 0.16C21.94 0.05 22.09 0 22.25 0C22.41 0 22.55 0.05 22.67 0.16C22.79 0.27 22.87 0.41 22.89 0.58C23.02 1.38 23.15 2.05 23.28 2.6C23.42 3.14 23.59 3.59 23.8 3.94C24.01 4.29 24.29 4.57 24.63 4.78C24.98 4.98 25.41 5.15 25.94 5.27C26.47 5.39 27.12 5.5 27.9 5.59C28.07 5.62 28.21 5.69 28.33 5.82C28.44 5.94 28.5 6.08 28.5 6.25C28.5 6.41 28.44 6.56 28.33 6.68C28.21 6.81 28.07 6.88 27.9 6.9C27.12 6.99 26.46 7.09 25.93 7.21C25.4 7.33 24.96 7.49 24.61 7.7C24.27 7.91 23.99 8.19 23.78 8.54C23.57 8.89 23.39 9.34 23.26 9.89C23.13 10.43 23.01 11.11 22.89 11.91C22.87 12.08 22.8 12.22 22.68 12.33C22.56 12.44 22.41 12.5 22.25 12.5Z" fill="currentColor"/>' +
    '</svg>'

  const modelById = (id) => VIDEO_MODELS.find((model) => model.id === id) || VIDEO_MODELS[0]
  const ratioLabel = (ratio) => (ratio === 'adaptive' ? '自适应' : ratio)

  function isVideoHolder(shape) {
    return Boolean(shape && shape.type === 'frame' && shape.meta && shape.meta.cowartAiVideoHolder === true)
  }

  // Fits settings to a model, keeping whatever still applies.
  function clampSettings(settings, model) {
    const nearest = (value, allowed) =>
      allowed.includes(value) ? value : allowed.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), allowed[0])
    return {
      model: model.id,
      ratio: model.ratios.includes(settings.ratio) ? settings.ratio : model.ratios[0],
      resolution: model.resolutions.includes(settings.resolution) ? settings.resolution : model.defaultResolution,
      duration: nearest(Number(settings.duration) || model.defaultDuration, model.durations),
      quality: model.qualities ? (model.qualities.some((quality) => quality.id === settings.quality) ? settings.quality : 'turbo') : null,
      count: model.counts ? (model.counts.includes(Number(settings.count)) ? Number(settings.count) : 1) : 1,
      sound: model.sound === null ? null : settings.sound !== false
    }
  }

  function materialCounts(refs) {
    const counts = { images: 0, videos: 0, audios: 0 }
    for (const ref of refs) counts[ref.kind] += 1
    return counts
  }

  function estimateLabel(settings) {
    const model = modelById(settings.model)
    if (model.cloud) return `消耗团队额度 · ${settings.count} 次`
    const anchors = (H3_ESTIMATES[settings.resolution] || H3_ESTIMATES['720P'])[settings.quality === 'full' ? 'full' : 'turbo']
    const seconds = anchors[0] + ((anchors[1] - anchors[0]) * (settings.duration - 5)) / 10
    const time = seconds < 90 ? `约 ${Math.max(10, Math.round(seconds / 10) * 10)} 秒` : `约 ${Math.round(seconds / 60)} 分钟`
    return `${time} · 免费`
  }

  const panel = kit.createGenerationPanel({
    id: 'video',
    kind: 'video',
    label: LABEL,
    isHolder: isVideoHolder,
    models: VIDEO_MODELS,
    defaultModelId: kit.hostConfig.defaultVideoModelId || 'h3',
    holderBound: ['ratio'],
    modes: [
      { id: 'frames', label: '首尾帧', title: '首尾帧：只放首帧＝从这张图开始；首尾都放＝控制起止画面；都不放＝纯文字生成' },
      { id: 'refs', label: '参考素材', title: '参考素材：用图、视频、音频锁定角色、道具、场景、声音' }
    ],
    emptyMaterials: () => ({ firstFrame: null, lastFrame: null, refs: [] }),
    holderSettings: (holder) => ({ ratio: holder.meta.cowartAiVideoRatio }),
    clampSettings,
    emptyPromptError: '先写一句视频描述。',

    renderMaterials(ctx, slotHtml) {
      const { editor, draft, model } = ctx
      if (draft.mode === 'frames') {
        return {
          html:
            slotHtml(editor, draft.firstFrame, { label: '首帧', role: 'first', tag: '首帧', title: '首帧：视频从这张图开始（拖到尾帧上可以互换）' }) +
            `<span class="between">${kit.ICONS.arrow}</span>` +
            slotHtml(editor, draft.lastFrame, { label: '尾帧', role: 'last', tag: '尾帧', title: '尾帧：视频收在这张图（拖到首帧上可以互换）' }),
          placeholder: '描述画面、动作、镜头运动；要说话就写上台词\n只放首帧＝从这张图开始 · 首尾都放＝控制起止画面 · 都不放＝纯文字生成'
        }
      }
      const counts = { images: 0, videos: 0, audios: 0 }
      const limits = `${model.label} 最多 ${model.limits.images} 图、${model.limits.videos} 段视频、${model.limits.audios} 段音频`
      return {
        html:
          draft.refs
            .map((ref, index) => {
              counts[ref.kind] += 1
              return slotHtml(editor, ref, {
                role: 'ref',
                index,
                tag: `${MATERIAL_NAMES[ref.kind]}${counts[ref.kind]}`,
                title: '拖动可以调整顺序',
                over: counts[ref.kind] > model.limits[ref.kind]
              })
            })
            .join('') + slotHtml(editor, null, { label: '添加', role: 'ref', title: `从画布选或上传参考图 / 视频 / 音频（${limits}）` }),
        placeholder: '例：@图1 的角色走进 @图2 的场景，沿用 @视频1 的运镜节奏\n参考素材用来锁定角色、道具、场景、声音'
      }
    },

    // Materials in slot order with the labels the prompt refers to them by.
    materialItems(draft) {
      if (draft.mode === 'frames') {
        return [
          draft.firstFrame && { label: '首帧', material: draft.firstFrame, numbered: false, detail: '视频从这张图开始' },
          draft.lastFrame && { label: '尾帧', material: draft.lastFrame, numbered: false, detail: '视频收在这张图' }
        ].filter(Boolean)
      }
      const counts = { images: 0, videos: 0, audios: 0 }
      return draft.refs.map((ref) => {
        counts[ref.kind] += 1
        return { label: `${MATERIAL_NAMES[ref.kind]}${counts[ref.kind]}`, material: ref, numbered: true, detail: '参考素材' }
      })
    },

    acceptedKinds: (ctx) => (ctx.draft.mode === 'frames' ? ['images'] : ['images', 'videos']),
    slotPickerTitle: (_ctx, role) => (role === 'first' ? '选首帧（画布上的图片）' : role === 'last' ? '选尾帧（画布上的图片）' : '选参考素材（画布上的图片或视频）'),
    fileInput: (_ctx, role) => ({ accept: role === 'ref' ? 'image/*,video/*,audio/*' : 'image/*', multiple: role === 'ref' }),

    // Frames fill in order: the first frame, then the last one.
    addMaterial(ctx, material, role) {
      const { draft, model } = ctx
      if (role === 'first' || role === 'last' || draft.mode === 'frames') {
        if (material.kind !== 'images') return '首帧、尾帧只能用图片。'
        const slot = role === 'last' ? 'lastFrame' : role === 'first' ? 'firstFrame' : !draft.firstFrame ? 'firstFrame' : !draft.lastFrame ? 'lastFrame' : null
        if (!slot) return '首帧、尾帧都有了，先移除一个。'
        draft[slot] = material
        return null
      }
      if (materialCounts(draft.refs)[material.kind] >= model.limits[material.kind]) {
        return `${model.label} 最多 ${model.limits[material.kind]} ${LIMIT_NAMES[material.kind]}。`
      }
      draft.refs.push(material)
      return null
    },

    removeMaterial(ctx, role, index) {
      if (role === 'first') ctx.draft.firstFrame = null
      else if (role === 'last') ctx.draft.lastFrame = null
      else ctx.draft.refs.splice(index, 1)
    },

    // Dragging a frame onto the other swaps them; a reference moves to where it is dropped.
    moveMaterial(ctx, from, to) {
      const { draft } = ctx
      if (from.role !== 'ref' && to.role !== 'ref') {
        if (from.role === to.role) return
        const first = draft.firstFrame
        draft.firstFrame = draft.lastFrame
        draft.lastFrame = first
        return
      }
      if (from.role !== 'ref' || to.role !== 'ref') return
      const [moved] = draft.refs.splice(from.index, 1)
      draft.refs.splice(to.index === null ? draft.refs.length : to.index, 0, moved)
    },

    // What dropping canvas media on the card would do.
    dropHint(ctx, kinds) {
      const { draft, model } = ctx
      if (draft.mode === 'frames') {
        if (kinds.some((kind) => kind !== 'images')) return { text: '首帧、尾帧只能用图片', blocked: true }
        const free = Number(!draft.firstFrame) + Number(!draft.lastFrame)
        if (free === 0) return { text: '首帧、尾帧都有了，先移除一个', blocked: true }
        if (kinds.length > free) return { text: `只剩 ${free} 个空位`, blocked: true }
        return { text: kinds.length === 2 ? '松手放进首帧和尾帧' : !draft.firstFrame ? '松手设为首帧' : '松手设为尾帧', blocked: false }
      }
      const counts = materialCounts(draft.refs)
      for (const kind of kinds) counts[kind] += 1
      const over = Object.keys(counts).find((kind) => counts[kind] > model.limits[kind])
      if (over) return { text: `${model.label} 最多 ${model.limits[over]} ${LIMIT_NAMES[over]}`, blocked: true }
      return { text: kinds.length > 1 ? `松手加为参考素材（${kinds.length} 个）` : '松手加为参考素材', blocked: false }
    },

    paramRows(ctx, optionButtons) {
      const { draft, model } = ctx
      const settings = draft.settings
      const rows = [
        `<div class="param"><span class="param-name">画幅</span>${optionButtons('ratio', model.ratios, settings.ratio, ratioLabel)}</div>`,
        `<div class="param"><span class="param-name">清晰度</span>${optionButtons('resolution', model.resolutions, settings.resolution)}</div>`,
        `<div class="param"><span class="param-name">时长</span><div class="duration"><input type="range" data-param="duration" min="${model.durations[0]}" max="${model.durations[model.durations.length - 1]}" step="1" value="${settings.duration}"><output>${settings.duration} 秒</output></div></div>`
      ]
      if (model.qualities) {
        rows.push(
          `<div class="param"><span class="param-name">质量</span>${optionButtons('quality', model.qualities.map((quality) => quality.id), settings.quality, (id) => model.qualities.find((quality) => quality.id === id).label)}</div>`,
          '<div class="param-note">草稿适合试构图；要交付的片子用精细再出一版</div>'
        )
      }
      if (model.counts) rows.push(`<div class="param"><span class="param-name">条数</span>${optionButtons('count', model.counts, settings.count, (count) => `${count} 条`)}</div>`)
      if (model.sound !== null) {
        rows.push(`<div class="param"><span class="param-name">声音</span>${optionButtons('sound', ['on', 'off'], settings.sound ? 'on' : 'off', (value) => (value === 'on' ? '有声' : '静音'))}</div>`)
      }
      if (!model.cloud) rows.push('<div class="param-note">耗时按猛兽实测估算，不含排队；720P 15 秒要 10 分钟以上</div>')
      return rows.join('')
    },

    paramPatch: (_ctx, param, value) => ({ [param]: param === 'count' ? Number(value) : param === 'sound' ? value === 'on' : value }),
    rangeLabel: (_param, value) => `${value} 秒`,

    summary(ctx) {
      const { settings } = ctx.draft
      const parts = [ratioLabel(settings.ratio), settings.resolution, `${settings.duration} 秒`]
      if (ctx.model.qualities) parts.push(settings.quality === 'full' ? '精细' : '草稿')
      if (ctx.model.counts) parts.push(`${settings.count} 条`)
      if (ctx.model.sound !== null) parts.push(settings.sound ? '有声' : '静音')
      return parts.join(' · ')
    },

    estimate: (ctx) => estimateLabel(ctx.draft.settings),

    // A ratio change reshapes the holder around its center.
    afterSettingsChange(ctx, previous) {
      const { ratio } = ctx.draft.settings
      if (ratio === previous.ratio || !kit.ratioNumbers(ratio)) return
      const { editor, holder } = ctx
      const size = kit.sizeForRatio(ratio, Math.max(holder.props.w, holder.props.h))
      editor.updateShape({
        id: holder.id,
        type: 'frame',
        x: holder.x + (holder.props.w - size.w) / 2,
        y: holder.y + (holder.props.h - size.h) / 2,
        props: { w: size.w, h: size.h },
        meta: { ...holder.meta, cowartAiVideoRatio: ratio }
      })
    },

    validate(ctx) {
      const { draft, model } = ctx
      if (draft.mode !== 'refs') return null
      const counts = materialCounts(draft.refs)
      const over = Object.keys(counts).find((kind) => counts[kind] > model.limits[kind])
      return over ? `${model.label} 最多 ${model.limits[over]} ${LIMIT_NAMES[over]}，先删掉一些。` : null
    },

    payload(ctx) {
      const { draft } = ctx
      return {
        ...draft.settings,
        mode: draft.mode,
        firstFrame: draft.mode === 'frames' ? kit.materialPayload(draft.firstFrame) : null,
        lastFrame: draft.mode === 'frames' ? kit.materialPayload(draft.lastFrame) : null,
        refs: draft.mode === 'refs' ? draft.refs.map(kit.materialPayload) : []
      }
    }
  })

  // Toolbar "AI 视频": a holder frame like upstream's "AI 图片", placed on free canvas so it
  // never hides other shapes. Selected media become its materials: one image is the first
  // frame, several images / videos become references.
  function createVideoHolder(editor) {
    const settings = panel.defaultSettings()
    const model = modelById(settings.model)
    const media = editor.getSelectedShapes().filter((shape) => kit.mediaKindOfShape(shape))
    const scale = typeof editor.getResizeScaleFactor === 'function' ? editor.getResizeScaleFactor() : 1
    let materials = {}
    let size
    let origin

    if (media.length === 1 && media[0].type === 'image') {
      const bounds = editor.getShapePageBounds(media[0].id)
      settings.ratio = kit.closestRatio(model.ratios, bounds.w, bounds.h)
      const [rw, rh] = kit.ratioNumbers(settings.ratio) || [16, 9]
      size = { w: Math.round((bounds.h * rw) / rh), h: Math.round(bounds.h) }
      origin = { x: bounds.maxX + kit.HOLDER_GAP, y: bounds.minY }
      materials = { mode: 'frames', firstFrame: kit.materialFromShape(media[0]) }
    } else if (media.length > 0) {
      const boxes = media.map((shape) => editor.getShapePageBounds(shape.id))
      size = kit.sizeForRatio(settings.ratio, DEFAULT_LONG_SIDE * scale)
      origin = { x: Math.max(...boxes.map((box) => box.maxX)) + kit.HOLDER_GAP, y: Math.min(...boxes.map((box) => box.minY)) }
      materials = { mode: 'refs', refs: media.map(kit.materialFromShape) }
    } else {
      size = kit.sizeForRatio(settings.ratio, DEFAULT_LONG_SIDE * scale)
      const center = editor.getViewportPageBounds().center
      origin = { x: center.x - size.w / 2, y: center.y - size.h / 2 }
    }

    const position = kit.freePosition(editor, { ...origin, ...size })
    const id = kit.randomShapeId()
    panel.seedDraft(id, materials, { ratio: settings.ratio })
    editor.createShape({
      id,
      type: 'frame',
      parentId: editor.getCurrentPageId(),
      x: position.x,
      y: position.y,
      props: { w: size.w, h: size.h, name: LABEL, color: 'blue' },
      meta: { cowartAiVideoHolder: true, cowartAiVideoHolderVersion: 2, cowartAiVideoRatio: settings.ratio }
    })
    editor.select(id)
    editor.setCurrentTool('select.idle')
    kit.revealRect(editor, { ...position, ...size })
  }

  // Register before the app module runs; the patched toolbar reads this at load time.
  kit.registerTool({ id: TOOL_ID, label: LABEL, iconSvg: ICON, onSelect: (editor) => createVideoHolder(editor) })
})()
