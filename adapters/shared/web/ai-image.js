// "AI 图片" for the Cowart host adapters: takes over the app's built-in prompt panel for
// AI image holders (through the extension hook) so the user picks a model and parameters
// from the host config (adapters/shared/image-models.mjs). With the panel taken over the
// app also hides the holder's size / ratio controls, so the ratio is picked here and
// lives on the holder itself; the holder and inserting the result stay upstream's.
(() => {
  'use strict'
  const kit = window.__cowartKit
  const IMAGE_MODELS = kit && Array.isArray(kit.hostConfig.imageModels) ? kit.hostConfig.imageModels : []
  if (!kit || IMAGE_MODELS.length === 0 || window.__cowartAiImage) return
  window.__cowartAiImage = true

  const PANEL_ID = 'ai-image'
  const LABEL = 'AI 图片'
  const MAX_SEEDED_REFS = 10
  const RATIO_TOLERANCE = 0.015

  function isImageHolder(shape) {
    return Boolean(shape && shape.type === 'frame' && shape.meta && shape.meta.cowartAiImageHolder === true)
  }

  function holderRatio(holder, model) {
    return kit.closestRatio(model.ratios, holder.props.w, holder.props.h)
  }

  function matchesRatio(holder, ratio) {
    const [w, h] = kit.ratioNumbers(ratio) || [1, 1]
    return Math.abs(holder.props.w / holder.props.h / (w / h) - 1) < RATIO_TOLERANCE
  }

  // Reshapes the holder around its center and locks its aspect ratio (upstream's lock), so
  // dragging a corner resizes it without changing the ratio picked in the panel.
  function applyRatio(editor, holder, ratio) {
    const size = kit.sizeForRatio(ratio, Math.max(holder.props.w, holder.props.h))
    editor.markHistoryStoppingPoint('cowart-ai-image-ratio')
    editor.updateShape({
      id: holder.id,
      type: 'frame',
      x: holder.x + (holder.props.w - size.w) / 2,
      y: holder.y + (holder.props.h - size.h) / 2,
      props: { w: size.w, h: size.h },
      meta: { ...holder.meta, cowartAiAspectLocked: true, cowartAiAspectRatio: size.w / size.h }
    })
  }

  // Fits settings to a model, keeping whatever still applies.
  function clampSettings(settings, model) {
    const pick = (value, allowed, fallback) => (allowed && allowed.includes(value) ? value : fallback)
    return {
      model: model.id,
      resolution: model.resolutions ? pick(settings.resolution, model.resolutions, model.defaultResolution) : null,
      count: pick(Number(settings.count), model.counts, 1),
      quality: model.qualities ? pick(settings.quality, model.qualities.map((quality) => quality.id), model.defaultQuality) : null,
      transparent: model.transparent ? settings.transparent === true : false
    }
  }

  function qualityLabel(model, id, short) {
    const quality = model.qualities && model.qualities.find((item) => item.id === id)
    if (!quality) return ''
    return short ? quality.label.split(' · ')[0] : quality.label
  }

  let watchedSize = ''

  const panel = kit.createGenerationPanel({
    id: 'image',
    kind: 'image',
    label: LABEL,
    isHolder: isImageHolder,
    models: IMAGE_MODELS,
    defaultModelId: kit.hostConfig.defaultImageModelId || 'auto',
    modes: null,
    emptyMaterials: () => ({ refs: [] }),
    clampSettings,
    emptyPromptError: '先写一句图片描述。',

    renderMaterials(ctx, slotHtml) {
      const { editor, draft, model } = ctx
      const add =
        draft.refs.length < model.maxRefs
          ? slotHtml(editor, null, { label: '参考图', role: 'ref', title: `从画布选或上传参考图（${model.label} 最多 ${model.maxRefs} 张）` })
          : ''
      return {
        html:
          draft.refs.map((ref, index) => slotHtml(editor, ref, { role: 'ref', index, tag: `图${index + 1}`, title: '拖动可以调整顺序', over: index >= model.maxRefs })).join('') +
          add,
        placeholder: model.placeholder
      }
    },

    // Materials in slot order with the labels the prompt refers to them by.
    materialItems: (draft) => draft.refs.map((ref, index) => ({ label: `图${index + 1}`, material: ref, numbered: true, detail: '参考图' })),

    acceptedKinds: () => ['images'],
    slotPickerTitle: () => '选参考图（画布上的图片）',
    fileInput: () => ({ accept: 'image/*', multiple: true }),

    addMaterial(ctx, material) {
      if (material.kind !== 'images') return '参考图只能用图片。'
      if (ctx.draft.refs.length >= ctx.model.maxRefs) return `${ctx.model.label} 最多 ${ctx.model.maxRefs} 张参考图。`
      ctx.draft.refs.push(material)
      return null
    },

    removeMaterial(ctx, _role, index) {
      ctx.draft.refs.splice(index, 1)
    },

    // A reference moves to where it is dropped among the slots.
    moveMaterial(ctx, from, to) {
      const [moved] = ctx.draft.refs.splice(from.index, 1)
      ctx.draft.refs.splice(to.index === null ? ctx.draft.refs.length : to.index, 0, moved)
    },

    // What dropping canvas media on the card would do.
    dropHint(ctx, kinds) {
      const { draft, model } = ctx
      if (kinds.some((kind) => kind !== 'images')) return { text: '参考图只能用图片', blocked: true }
      if (draft.refs.length + kinds.length > model.maxRefs) return { text: `${model.label} 最多 ${model.maxRefs} 张参考图`, blocked: true }
      return { text: kinds.length > 1 ? `松手加为参考图（${kinds.length} 张）` : '松手加为参考图', blocked: false }
    },

    paramRows(ctx, optionButtons) {
      const { draft, model, holder } = ctx
      const settings = draft.settings
      const rows = [`<div class="param"><span class="param-name">画幅</span>${optionButtons('ratio', model.ratios, holderRatio(holder, model))}</div>`]
      if (model.resolutions) rows.push(`<div class="param"><span class="param-name">清晰度</span>${optionButtons('resolution', model.resolutions, settings.resolution)}</div>`)
      rows.push(`<div class="param"><span class="param-name">张数</span>${optionButtons('count', model.counts, settings.count, (count) => `${count} 张`)}</div>`)
      if (model.qualities) {
        rows.push(
          `<div class="param"><span class="param-name">档位</span>${optionButtons('quality', model.qualities.map((quality) => quality.id), settings.quality, (id) => qualityLabel(model, id, false))}</div>`
        )
      }
      if (model.transparent) {
        rows.push(`<div class="param"><span class="param-name">背景</span>${optionButtons('transparent', ['off', 'on'], settings.transparent ? 'on' : 'off', (value) => (value === 'on' ? '透明底' : '正常'))}</div>`)
        if (settings.transparent) rows.push('<div class="param-note">先铺品红底出图，再自动抠成透明 PNG，适合做素材</div>')
      }
      return rows.join('')
    },

    // The ratio is the holder's shape: picking one reshapes the holder.
    applyParam(ctx, param, value) {
      if (param !== 'ratio') return false
      if (!matchesRatio(ctx.holder, value)) applyRatio(ctx.editor, ctx.holder, value)
      return true
    },

    paramPatch: (_ctx, param, value) => ({ [param]: param === 'count' ? Number(value) : param === 'transparent' ? value === 'on' : value }),

    // A model without the holder's ratio (Lib Image's 21:9 on FLUX.2, say) gets the closest one.
    afterSettingsChange(ctx, previous) {
      if (ctx.draft.settings.model === previous.model) return
      const ratio = holderRatio(ctx.holder, ctx.model)
      if (!matchesRatio(ctx.holder, ratio)) applyRatio(ctx.editor, ctx.holder, ratio)
    },

    summary(ctx) {
      const { draft, model, holder } = ctx
      const { settings } = draft
      const parts = [holderRatio(holder, model)]
      if (settings.resolution) parts.push(settings.resolution)
      parts.push(`${settings.count} 张`)
      if (model.qualities) parts.push(qualityLabel(model, settings.quality, true))
      if (settings.transparent) parts.push('透明底')
      return parts.join(' · ')
    },

    estimate(ctx) {
      const { model, draft } = ctx
      if (model.cloud) return `消耗团队额度 · ${draft.settings.count} 张`
      const { estimate } = model
      return typeof estimate === 'string' ? estimate : (estimate && (estimate[draft.settings.quality] || Object.values(estimate)[0])) || ''
    },

    // The ratio in the summary follows the holder, which dragging a corner can change.
    watchHolder(shape) {
      const size = `${shape.id}:${Math.round(shape.props.w)}x${Math.round(shape.props.h)}`
      if (size === watchedSize) return false
      watchedSize = size
      return true
    },

    validate(ctx) {
      const { draft, model } = ctx
      return draft.refs.length > model.maxRefs ? `${model.label} 最多 ${model.maxRefs} 张参考图，先删掉一些或换个模型。` : null
    },

    payload: (ctx) => ({ ...ctx.draft.settings, refs: ctx.draft.refs.map(kit.materialPayload) })
  })

  // Upstream's toolbar tool drops the holder at the viewport center. Like "AI 视频", put it
  // beside the selected images (which become its reference images) or on free canvas, so
  // it never covers other shapes. Holders made any other way (drag, paste) are left alone.
  kit.onEditor((editor) => {
    editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
      if (source !== 'user' || !isImageHolder(shape) || panel.hasDraft(shape.id)) return shape
      const center = editor.getViewportPageBounds().center
      const fromTool = Math.abs(shape.x + shape.props.w / 2 - center.x) < 0.5 && Math.abs(shape.y + shape.props.h / 2 - center.y) < 0.5
      if (!fromTool) return shape

      const images = editor.getSelectedShapes().filter((selected) => selected.type === 'image')
      let origin = { x: shape.x, y: shape.y }
      if (images.length > 0) {
        panel.seedDraft(shape.id, { refs: images.slice(0, MAX_SEEDED_REFS).map(kit.materialFromShape) })
        const boxes = images.map((image) => editor.getShapePageBounds(image.id))
        origin = { x: Math.max(...boxes.map((box) => box.maxX)) + kit.HOLDER_GAP, y: Math.min(...boxes.map((box) => box.minY)) }
      }
      const rect = { ...origin, w: shape.props.w, h: shape.props.h }
      const position = kit.freePosition(editor, rect, shape.id)
      queueMicrotask(() => kit.revealRect(editor, { ...rect, ...position }))
      const meta = { ...shape.meta, cowartAiAspectLocked: true, cowartAiAspectRatio: shape.props.w / shape.props.h }
      return { ...shape, x: position.x, y: position.y, meta }
    })
  })

  // Register before the app module runs; the patched overlay reads this when rendering.
  kit.takeOverPanel(PANEL_ID)
})()
