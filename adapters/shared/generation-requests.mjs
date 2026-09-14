// Turns what the canvas "AI 图片" / "AI 视频" panels send into the request text the agent
// receives (Claude Code: through the request queue; Codex: as a ui/message turn). Uploaded
// materials are saved next to the holder's page assets so the agent can read them locally.
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { pageDirName, resolveCowartPaths } from '../../mcp/lib/canvas-storage.mjs'
import { localPathForAssetSrc, pageIdOfShape, shapeSize } from './canvas-model.mjs'
import { MIME_EXTENSIONS, parseMediaDataUrl, uniqueFilePath } from './files.mjs'
import { imageModelsForHost, imageTemplateParameters, nearestRatio, normalizeImageSettings } from './image-models.mjs'
import { structuredOrThrow } from './upstream.mjs'
import { VIDEO_MATERIAL_KINDS, normalizeVideoSettings, templateParameters } from './video-models.mjs'

export const PREPARE_REQUEST_TOOL = 'prepare_cowart_generation_request'

const COWART_MENTION = '[@Cowart](plugin://cowart@cowart-github)'
const REUSE_CANVAS_LINE =
  '本请求来自已经打开的 Cowart 画布；请复用当前画布，不要调用 render_cowart_canvas_widget，除非用户明确要求重新打开或刷新。'
const BEAST_CLI_STEPS =
  '- 用 beast 命令行生成：beast gen submit <模板> --in 参数=值（中文参数值、JSON 数组都走 --file 参数=<文件>）→ beast gen wait <任务> → beast gen output <任务> --dir <临时目录> 下载（缺省落在当前目录，别落进项目仓库）。模板参数以 beast gen templates <模板> 现查为准；本机没有 beast 命令行时停下来告诉用户。'
// The panel lets the user refer to materials in the prompt as @图1 / @视频1 / @音频1 (in
// slot order per kind) and @首帧 / @尾帧; the lists below say which file each one is.
const MATERIAL_TITLES = {
  images: 'Reference images（依次是描述里的 @图1、@图2 …）',
  videos: 'Reference videos（依次是描述里的 @视频1、@视频2 …）',
  audios: 'Reference audios（依次是描述里的 @音频1、@音频2 …）'
}
const MATERIAL_NAMES = { images: '参考图', videos: '参考视频', audios: '参考音频' }

function mentionStep(dialect) {
  return `- 描述里的 @图1、@视频1、@首帧 这类标记指上面列出的素材：写提示词时换成${dialect}，不要把 @ 标记原样交给模型。`
}

// Listed by the adapters as a page-only tool: the canvas calls it, the model never sees it.
export const prepareRequestTool = {
  name: PREPARE_REQUEST_TOOL,
  title: 'Prepare Cowart Generation Request',
  description:
    'Used by the Cowart canvas AI 图片 / AI 视频 panels: saves uploaded materials next to the holder and returns the request text for the agent.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['image', 'video', 'web'] },
      holderShapeId: { type: 'string' },
      sourceShapeId: { type: 'string', description: 'For kind "web": the web reference card to copy.' },
      annotations: {
        type: 'array',
        description: 'For kind "web": the 标注 arrows bound to the card, in reading order.',
        items: {
          type: 'object',
          properties: {
            note: { type: 'boolean', description: 'A 注释 (a note that stays) rather than a 标注 (a change request).' },
            text: { type: 'string', description: 'The words on the arrow.' },
            x: { type: 'number', description: 'Where the tip points: page CSS pixels from the top left of the captured page.' },
            y: { type: 'number' },
            crop: { type: 'string', description: 'PNG data URL: the card around the spot, with the arrow.' }
          }
        }
      },
      prompt: { type: 'string' },
      model: { type: 'string' },
      projectDir: { type: 'string' },
      canvasDir: { type: 'string' }
    },
    required: ['kind', 'holderShapeId']
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatParameters(parameters) {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? `"${value}"` : value}`)
    .join(', ')
}

function numberedPaths(title, paths) {
  return paths.length > 0 ? [`${title}:`, ...paths.map((path, index) => `${index + 1}. ${path}`)] : []
}

function videoModeLabel({ mode, firstFrame, lastFrame }) {
  if (mode === 'refs') return '参考素材（锁定角色 / 道具 / 场景 / 声音）'
  if (firstFrame && lastFrame) return '首尾帧（控制起止画面）'
  if (firstFrame) return '首帧（从这张图开始）'
  if (lastFrame) return '尾帧（收在这张图）'
  return '文生视频'
}

export function buildVideoRequestText({ holderShapeId, settings, mode, firstFrame, lastFrame, refs, prompt }) {
  const { model } = settings
  const lines = [
    `${COWART_MENTION} 生成视频 · ${model.label}`,
    REUSE_CANVAS_LINE,
    '',
    '请用 beast-gen 按下面已选好的模型和参数生成视频，并替换画布里的 AI 视频框；最终画布里留下视频形状，不保留 AI 视频框。',
    `Cowart AI video holder shape: ${holderShapeId}`,
    `Model: ${model.label}（beast 模板 ${model.template}，${model.cloud ? '云端，消耗团队额度' : '本地，免费'}）`,
    `Parameters: ${formatParameters(templateParameters(settings))}`,
    `Mode: ${videoModeLabel({ mode, firstFrame, lastFrame })}`
  ]
  if (firstFrame) lines.push(`First frame（描述里的 @首帧）: ${firstFrame}`)
  if (lastFrame) lines.push(`Last frame（描述里的 @尾帧）: ${lastFrame}`)
  for (const kind of VIDEO_MATERIAL_KINDS) {
    lines.push(...numberedPaths(MATERIAL_TITLES[kind], refs.filter((ref) => ref.kind === kind).map((ref) => ref.path)))
  }
  const hasMaterials = Boolean(firstFrame || lastFrame || refs.length)
  lines.push(
    '',
    'Required steps:',
    '- 素材先用 beast gen upload 上传拿 name，再填进对应参数：首帧 first_frame、尾帧 last_frame、参考图 images、参考视频 videos、参考音频 audios（多个按上面的顺序）。',
    model.template === 'minimax-h3'
      ? '- 按 beast-gen skill 的 H3 提示词参考，把用户描述改写成英文结构化提示词（<Picture N> 等编号按上传顺序）；用户写的台词保留原文放进 <d>。'
      : '- 按 beast-gen skill 的 Seedance 提示词参考写中文提示词，素材按类型内顺序用「图片N / 视频N / 音频N」指代。',
    ...(hasMaterials ? [mentionStep(model.template === 'minimax-h3' ? ' H3 的 <Picture N> 编号' : ' Seedance 的「图片N / 视频N / 音频N」')] : []),
    BEAST_CLI_STEPS,
    settings.count > 1
      ? `- 会生成 ${settings.count} 条：第一条下载后调用 insert_cowart_video，videoPath 传本地文件路径，replaceHolderShapeId: "${holderShapeId}"；其余依次用上一条返回的 shapeId 作 anchorShapeId、placement: "right" 排开。`
      : `- 生成后下载到本地，调用 insert_cowart_video，videoPath 传本地文件路径，replaceHolderShapeId: "${holderShapeId}"。`,
    '',
    'Prompt:',
    prompt
  )
  return lines.join('\n')
}

// Holder sizes are rounded (upstream's 3:4 preset is 512 x 683), so name the nearest common ratio.
const COMMON_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']

function ratioText(width, height) {
  const ratio = nearestRatio(COMMON_RATIOS, width, height)
  const [w, h] = ratio.split(':').map(Number)
  return Math.abs(width / height / (w / h) - 1) < 0.015 ? ratio : `宽高比 ${(width / height).toFixed(3)}`
}

function autoModelGuide(host) {
  return [
    '- 模型由你按需求挑（beast-gen skill 的选型表）：没参考图的海选、概念稿 → krea2；指令改图、多图合成（参考图 ≤4）→ flux2-klein；最强保身份、参考图多、复杂构图 → flux2-dev；海报 / UI / 带字物料 → ideogram4；云端 lib-image（Lib Image 2.5，消耗团队额度）只在描述里点名或确有必要时用。',
    host === 'codex' ? '- 也可以用 Codex 内置 imagegen；拿不准时优先本地免费的 beast 模板。' : null,
    '- 画幅取上面 Target canvas slot 最接近、且所选模板支持的比例；分辨率、张数按上面的参数。',
    '- 按所选模板的提示词写法写提示词（flux2 系写英文指令「做什么 + 保留什么」，ideogram4 写 JSON 标注，lib-image 按 references/image-prompting.md）。'
  ].filter(Boolean)
}

export function buildImageRequestText({ holderShapeId, holder, settings, refs, prompt, host }) {
  const { model } = settings
  const { w, h } = shapeSize(holder)
  const ratio = model.ratios ? nearestRatio(model.ratios, w, h) : null
  const parameters = model.template ? imageTemplateParameters(settings, ratio) : { ratio, resolution: settings.resolution, n: settings.count }
  const channel = model.template
    ? `beast 模板 ${model.template}${model.templateModel ? ` · ${model.templateModel}` : ''}，${model.cloud ? '云端，消耗团队额度' : '本地，免费'}`
    : model.id === 'codex-imagegen'
      ? 'Codex 内置 imagegen'
      : '由你按需求挑选'
  const lines = [
    `${COWART_MENTION} 生成图片 · ${model.label}`,
    REUSE_CANVAS_LINE,
    '',
    `请按下面${model.id === 'auto' ? '的参数' : '已选好的模型和参数'}生成图片，并替换画布里的 AI 图片框；最终画布里留下普通图片形状，不保留 AI 图片框。`,
    `Cowart AI image holder shape: ${holderShapeId}`,
    `Target canvas slot: ${Math.round(w)} x ${Math.round(h)} canvas units（${ratioText(w, h)}），构图按这个比例，不要裁切或拉伸。`,
    `Model: ${model.label}（${channel}）`,
    `Parameters: ${formatParameters(Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== null && value !== undefined)))}`
  ]
  if (settings.transparent) {
    lines.push('Transparent background: 要透明底 PNG——出图时铺纯品红底（#FF00FF），再用 beast 的 matte 模板抠成透明，做法见 beast-gen 的 references/transparent-asset.md。')
  }
  lines.push(...numberedPaths(MATERIAL_TITLES.images, refs))
  lines.push('', 'Required steps:')
  if (refs.length > 0) {
    lines.push(mentionStep(model.id === 'codex-imagegen' ? '自然语言（如「第一张参考图」）' : '所选模型的写法（FLUX 系用 image 1 / image 2 …，其它模板按 beast-gen skill 的写法）'))
  }
  if (model.id === 'codex-imagegen') {
    lines.push(`- ${model.promptGuide}`)
  } else {
    if (refs.length > 0) {
      lines.push(
        model.maxRefs === 1
          ? '- 参考图先用 beast gen upload 上传拿 name，填进 image_name。'
          : '- 参考图先用 beast gen upload 上传拿 name，按上面的顺序填进 images（krea2 / ideogram4 只收一张，填 image_name）。'
      )
    }
    if (model.id === 'auto') lines.push(...autoModelGuide(host))
    else lines.push(`- 提示词：${model.promptGuide}`)
    lines.push(BEAST_CLI_STEPS)
  }
  lines.push(
    '- 产物用 Read 看一眼，确认没有明显问题再插入。',
    `- 调用 insert_cowart_image：imagePath 传本地文件路径，anchorShapeId: "${holderShapeId}"（默认替换 AI 图片框：图按原比例等比放进框里并居中，不用自己裁图、补边，也不用传尺寸）。`
  )
  if (settings.count > 1) {
    lines.push(
      `- 会出 ${settings.count} 张：第一张按上一步替换 AI 图片框；其余依次用上一张返回的 shapeId 作 anchorShapeId，并设置 replaceAiImageHolder: false、matchAnchor: false、placement: "right"。不要拼成一张图。`
    )
  }
  lines.push('', 'Prompt:', prompt)
  return lines.join('\n')
}

const MAX_ANNOTATIONS = 20

// 标注 are the changes to make; 注释 (notes that stay on the card) are background.
function annotationLines(notes, viewportWidth) {
  const describe = (note) => {
    const text = note.text ? `「${note.text.replace(/\s*\n\s*/g, ' / ')}」` : '（箭头上没写字，看局部截图）'
    return `${text} → 指向 (${note.x}, ${note.y})${note.cropPath ? `；局部截图: ${note.cropPath}` : ''}`
  }
  const requests = notes.filter((note) => !note.note)
  const standing = notes.filter((note) => note.note)
  return [
    ...(requests.length
      ? [
          `Annotations（用户用标注箭头指在网页截图上的修改要求：按标注改，没标到的地方照原网页做。坐标是箭头尖指的位置，按页面 ${viewportWidth}px 宽排版时的 CSS 像素，从页面左上角算起）:`,
          ...requests.map((note, index) => `${index + 1}. ${describe(note)}`)
        ]
      : []),
    ...(standing.length
      ? [
          '注释（常驻在卡片上的说明：当背景参考，不是这次要改的地方；坐标同上）:',
          ...standing.map((note) => `- ${describe(note)}`)
        ]
      : [])
  ]
}

// A web reference card (a captured page) as the model for a new single-file HTML draft,
// placed next to it for side-by-side comparison; annotations drawn on the card say what to
// change.
export function buildWebRequestText({ holderShapeId, holder, card, screenshotPath, htmlPath, notes = [], prompt }) {
  const meta = card.meta || {}
  const { w, h } = shapeSize(holder)
  const viewportWidth = Number(meta.cowartWebViewport) || Math.round(w)
  const host = (() => {
    try {
      return new URL(meta.cowartWebUrl).hostname
    } catch {
      return '网页'
    }
  })()
  const requestCount = notes.filter((note) => !note.note).length
  const noteCount = notes.length - requestCount
  const counts = [requestCount ? `${requestCount} 处标注` : '', noteCount ? `${noteCount} 条注释` : ''].filter(Boolean).join('、')
  const lines = [
    `${COWART_MENTION} 照网页做 HTML · ${meta.cowartWebTitle || host}${counts ? `（带 ${counts}）` : ''}`,
    REUSE_CANVAS_LINE,
    '',
    `请参考下面这个网页重新实现一个单文件 HTML${requestCount ? '，并按用户画在截图上的标注修改' : ''}，放进画布上网页参考卡片右边的 AI HTML 框，方便和原网页横向对比。`,
    `Cowart AI HTML holder shape: ${holderShapeId}`,
    `Target canvas slot: ${Math.round(w)} x ${Math.round(h)} canvas units（和网页参考卡片同尺寸；页面按 ${viewportWidth}px 宽排版）`,
    `Reference web page（画布上的网页参考卡片 ${card.id}）:`,
    `- URL: ${meta.cowartWebUrl || '（没记录）'}`,
    ...(meta.cowartWebTitle ? [`- Title: ${meta.cowartWebTitle}`] : []),
    `- Captured at: ${meta.cowartWebCapturedAt || '（没记录）'}${meta.cowartWebTruncated ? '，页面太长，截图只到前一部分' : ''}`,
    ...(screenshotPath ? [`- Screenshot（整页截图）: ${screenshotPath}`] : []),
    ...(htmlPath ? [`- Rendered HTML（截图时浏览器渲染后的页面代码）: ${htmlPath}`] : []),
    ...annotationLines(notes, viewportWidth),
    '',
    'Required steps:',
    '- 先看截图把握整体观感，再读渲染后的页面代码（或重新 fetch 原网址）提取结构和样式细节：配色、字体与字号层级、间距、圆角、阴影、动效。能开浏览器的话打开原网址对照着看。',
    ...(notes.length
      ? ['- 逐条看标注 / 注释和它的局部截图：截图里的箭头和上面的字是用户画上去的，不是网页内容。弄清每条指的是哪个元素（坐标可以在渲染后的页面代码或浏览器里对照定位）：标注要照着改，注释只当背景参考；做出来的页面里不要出现这些箭头和字。']
      : []),
    '- 复刻版式和视觉风格，做成完整、独立、可运行的单文件 HTML：CSS / JS 内联，不依赖外部文件；字体用系统字体近似，图片用 CSS 渐变、inline SVG 或 data URI 代替，不要盗链原网站的资源。',
    `- 页面按 ${viewportWidth}px 宽排版，内容长度大致对应截图，方便逐段对比。`,
    `- 调用 insert_cowart_html_draft：draftShapeId: "${holderShapeId}"，htmlContent 传完整 HTML，fileName 用简短的英文 .html 文件名（默认替换 AI HTML 框）。`,
    '',
    'Prompt:',
    prompt || (requestCount ? '照这个网页做一版，按标注修改。' : '照这个网页的样式做一版。')
  ]
  return lines.join('\n')
}

// Reads what a panel sent against the stored canvas: the holder and its page, the settings
// clamped to the model, and every material as a local file (uploads are saved next to the
// holder). The request text for an agent and the canvas service's own generation
// (adapters/service/lib/generation-jobs.mjs) both start from this.
export async function resolveGeneration({ upstream, host, args = {} }) {
  const kind = args.kind === 'image' || args.kind === 'video' || args.kind === 'web' ? args.kind : null
  if (!kind) throw new Error('不支持的生成类型。')
  const label = kind === 'image' ? 'AI 图片' : kind === 'video' ? 'AI 视频' : 'AI HTML'
  const prompt = nonEmpty(args.prompt)
  if (!prompt && kind !== 'web') throw new Error(kind === 'image' ? '先写一句图片描述。' : '先写一句视频描述。')
  const holderShapeId = nonEmpty(args.holderShapeId)
  if (!holderShapeId) throw new Error(`缺少${label}框。`)
  const { projectDir, canvasDir } = resolveCowartPaths(args)

  const state = structuredOrThrow(await upstream.callTool('get_cowart_canvas_state', { projectDir, canvasDir }), 'get_cowart_canvas_state')
  const store = state.snapshot?.store ?? {}
  const holder = store[holderShapeId]
  // The page retries once on this wording: a just-created holder is saved a moment later.
  if (!holder) throw new Error(`${label}框还没保存到画布文件里，等一两秒再发送。`)
  const pageId = pageIdOfShape(store, holder)
  const base = { kind, holderShapeId, holder, projectDir, canvasDir, pageId, pageName: store[pageId]?.name ?? null, prompt }
  const assetsDir = join(canvasDir, 'pages', pageDirName(pageId ?? 'page:page'), 'assets')
  const holderKey = holderShapeId.split(':')[1] || 'holder'

  async function resolveMaterial(material, role) {
    if (nonEmpty(material?.shapeId)) {
      const shape = store[material.shapeId]
      const materialKind = shape?.type === 'image' ? 'images' : shape?.type === 'video' ? 'videos' : null
      const path = materialKind ? localPathForAssetSrc(canvasDir, store[shape.props?.assetId]?.props?.src) : null
      if (!path) throw new Error('有素材还没保存到画布文件里，等一两秒再发送。')
      return { kind: materialKind, path }
    }
    if (nonEmpty(material?.dataUrl)) {
      const { mimeType, buffer, kind: materialKind } = parseMediaDataUrl(material.dataUrl)
      await mkdir(assetsDir, { recursive: true })
      const extension = MIME_EXTENSIONS.get(mimeType) || extname(String(material.fileName || '')) || '.bin'
      const { filePath } = await uniqueFilePath(assetsDir, `ai-${kind}-${holderKey}-${role}${extension}`)
      await writeFile(filePath, buffer)
      return { kind: materialKind, path: filePath }
    }
    return null
  }

  async function resolveRefs() {
    const refs = []
    for (const [index, material] of (Array.isArray(args.refs) ? args.refs : []).entries()) {
      const ref = await resolveMaterial(material, `ref-${index + 1}`)
      if (ref) refs.push(ref)
    }
    return refs
  }

  if (kind === 'web') {
    const card = store[nonEmpty(args.sourceShapeId) || '']
    if (!card || card.meta?.cowartWebReference !== true) throw new Error('找不到这张网页参考卡片，等一两秒再发送。')
    const notes = []
    for (const [index, note] of (Array.isArray(args.annotations) ? args.annotations : []).slice(0, MAX_ANNOTATIONS).entries()) {
      if (!Number.isFinite(note?.x) || !Number.isFinite(note?.y)) continue
      const crop = nonEmpty(note.crop) ? await resolveMaterial({ dataUrl: note.crop }, `note-${index + 1}`) : null
      if (crop && crop.kind !== 'images') throw new Error('标注截图只能是图片。')
      notes.push({ note: note.note === true, text: nonEmpty(note.text), x: Math.round(note.x), y: Math.round(note.y), cropPath: crop?.path ?? null })
    }
    return {
      ...base,
      card,
      notes,
      screenshotPath: localPathForAssetSrc(canvasDir, store[card.props?.assetId]?.props?.src),
      htmlPath: localPathForAssetSrc(canvasDir, card.meta.cowartWebHtmlAsset)
    }
  }

  if (kind === 'video') {
    const settings = normalizeVideoSettings(args)
    const mode = args.mode === 'refs' ? 'refs' : 'frames'
    let firstFrame = null
    let lastFrame = null
    let refs = []
    if (mode === 'frames') {
      const first = await resolveMaterial(args.firstFrame, 'first')
      const last = await resolveMaterial(args.lastFrame, 'last')
      if ([first, last].some((frame) => frame && frame.kind !== 'images')) throw new Error('首帧、尾帧只能用图片。')
      firstFrame = first?.path ?? null
      lastFrame = last?.path ?? null
    } else {
      refs = await resolveRefs()
      for (const materialKind of VIDEO_MATERIAL_KINDS) {
        const count = refs.filter((ref) => ref.kind === materialKind).length
        if (count > settings.model.limits[materialKind]) {
          throw new Error(`${settings.model.label} 最多 ${settings.model.limits[materialKind]} 个${MATERIAL_NAMES[materialKind]}。`)
        }
      }
    }
    return { ...base, settings, mode, firstFrame, lastFrame, refs }
  }

  if (!imageModelsForHost(host).some((model) => model.id === (args.model || 'auto'))) {
    throw new Error('这个宿主不支持所选的图片模型。')
  }
  const settings = normalizeImageSettings(args, host)
  const refs = await resolveRefs()
  if (refs.some((ref) => ref.kind !== 'images')) throw new Error('参考图只能用图片。')
  if (refs.length > settings.model.maxRefs) throw new Error(`${settings.model.label} 最多 ${settings.model.maxRefs} 张参考图。`)
  return { ...base, settings, refs }
}

// The request text an agent gets for a resolved panel request.
export function generationRequestText(resolved, host) {
  const { kind, holderShapeId, holder, prompt } = resolved
  if (kind === 'web') {
    const { card, screenshotPath, htmlPath, notes } = resolved
    return buildWebRequestText({ holderShapeId, holder, card, screenshotPath, htmlPath, notes, prompt })
  }
  if (kind === 'video') {
    const { settings, mode, firstFrame, lastFrame, refs } = resolved
    return buildVideoRequestText({ holderShapeId, settings, mode, firstFrame, lastFrame, refs, prompt })
  }
  return buildImageRequestText({ holderShapeId, holder, settings: resolved.settings, refs: resolved.refs.map((ref) => ref.path), prompt, host })
}

// Called for the page-only prepare tool; returns the text to send plus request metadata.
export async function prepareGenerationRequest({ upstream, host, args = {} }) {
  const resolved = await resolveGeneration({ upstream, host, args })
  const { kind, holderShapeId, projectDir, canvasDir, pageId, pageName } = resolved
  return { kind, holderShapeId, projectDir, canvasDir, pageId, pageName, text: generationRequestText(resolved, host) }
}
