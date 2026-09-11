// Image models the canvas "AI 图片" panel offers: the beast-gen image templates
// (`beast gen templates --kind image`) on every host, plus Codex's built-in image
// generation on Codex. Single source for the page's options and for validating what the
// page sends; update it when the gateway's templates change.
export const DEFAULT_IMAGE_MODEL_ID = 'auto'

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const LIB_RATIOS = ['16:9', '1:1', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']
const COUNTS = [1, 2, 3, 4]
const LIB_QUALITIES = [
  { id: 'low', label: '低 · 日常够用' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '更高' },
  { id: 'max', label: '最高' }
]

function libImage(id, templateModel, label, description) {
  return {
    id,
    template: 'lib-image',
    templateModel,
    label,
    tag: '云',
    description,
    cloud: true,
    hosts: null,
    maxRefs: 14,
    ratios: LIB_RATIOS,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '1K',
    counts: [1, 2, 4],
    qualities: LIB_QUALITIES,
    defaultQuality: 'low',
    transparent: true,
    estimate: null,
    placeholder: '描述要生成或要改的内容，写清改什么、保留什么（例：把 @图1 的背景换成海边）\n参考图最多 14 张',
    promptGuide:
      '按 beast-gen 的 references/image-prompting.md 写提示词：需求、每张参考图的角色、改什么 / 保留什么；quality 与 resolution 按上面的参数，不要自行升档。'
  }
}

export const IMAGE_MODELS = [
  {
    id: 'auto',
    template: null,
    label: '自动',
    tag: '按需挑选',
    description: '由 AI 按需求挑：海选 Krea 2 · 改图 FLUX.2 · 带字设计 Ideogram · 优先免费',
    cloud: false,
    hosts: null,
    maxRefs: 10,
    ratios: RATIOS,
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    counts: COUNTS,
    qualities: null,
    transparent: true,
    estimate: '按所选模型 · 优先免费',
    placeholder: '描述你想要的图；有参考图就写清怎么用（例：@图1 的角色放进 @图2 的场景）\n不用选模型：AI 按需求挑，确认时会告诉你用哪个',
    promptGuide: null
  },
  {
    id: 'krea2',
    template: 'krea2',
    label: 'Krea 2',
    tag: '本地免费',
    description: '海选、整张重画、风格 LoRA · 约 4 秒',
    cloud: false,
    hosts: null,
    maxRefs: 1,
    ratios: RATIOS,
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    counts: COUNTS,
    qualities: null,
    transparent: true,
    estimate: '约 4 秒 · 免费',
    placeholder: '描述画面、风格和构图\n挂 1 张参考图＝照它整张重画（不是局部修改）；要改局部请换 FLUX.2',
    promptGuide:
      '写英文提示词。挂了参考图就是按它整张重画（参数 image_name，denoise 缺省 0.6，越大越不像原图）；描述里提到画风时可以去 beast lora shelf --base krea2 搜风格 LoRA。'
  },
  {
    id: 'flux2-klein',
    template: 'flux2-klein',
    label: 'FLUX.2 Klein',
    tag: '本地免费',
    description: '指令改图、多图合成 · 约 5 秒',
    cloud: false,
    hosts: null,
    maxRefs: 4,
    ratios: RATIOS,
    resolutions: ['768', '1K', '1.4K', '2K'],
    defaultResolution: '1K',
    counts: COUNTS,
    qualities: [
      { id: 'turbo', label: '快 · 约 5 秒' },
      { id: 'full', label: '精细 · 约 15 秒' }
    ],
    defaultQuality: 'turbo',
    transparent: true,
    estimate: { turbo: '约 5 秒 · 免费', full: '约 15 秒 · 免费' },
    placeholder: '例：把 @图1 的角色放进 @图2 的场景，保持脸和姿势不变\n写清改什么、保留什么；参考图建议不超过 4 张',
    promptGuide:
      '写英文指令式提示词：「做什么 + 保留什么」（例：Replace the background with …, keep the face and pose unchanged）；参考图按上传顺序用 image 1 / image 2 指代。'
  },
  {
    id: 'flux2-dev',
    template: 'flux2-dev',
    label: 'FLUX.2 Dev',
    tag: '本地免费',
    description: '最强保身份、参考图多、复杂构图 · 20 秒起',
    cloud: false,
    hosts: null,
    maxRefs: 10,
    ratios: RATIOS,
    resolutions: ['768', '1K', '1.4K', '2K'],
    defaultResolution: '1K',
    counts: COUNTS,
    qualities: [
      { id: 'full', label: '精细 · 20 秒～1 分钟' },
      { id: 'turbo', label: '快 · 约快 2.5 倍' }
    ],
    defaultQuality: 'full',
    transparent: true,
    estimate: { full: '约 20 秒～1 分钟 · 免费', turbo: '约 10～25 秒 · 免费' },
    placeholder: '例：@图1 的角色坐在 @图2 的沙发上，脸和衣服保持原样\n参考图最多 10 张',
    promptGuide:
      '写英文指令式提示词：「做什么 + 保留什么」；参考图按上传顺序用 image 1 / image 2 … 指代。'
  },
  {
    id: 'ideogram4',
    template: 'ideogram4',
    label: 'Ideogram 4',
    tag: '本地免费',
    description: '海报、UI、带字物料 · 约 20 秒',
    cloud: false,
    hosts: null,
    maxRefs: 1,
    ratios: RATIOS,
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    counts: COUNTS,
    qualities: [
      { id: 'default', label: '标准 · 约 20 秒' },
      { id: 'quality', label: '精细' },
      { id: 'turbo', label: '快' }
    ],
    defaultQuality: 'default',
    transparent: false,
    estimate: '约 20 秒 · 免费',
    placeholder: '写清要出现的文字、版式和配色（例：竖版海报，大标题「东坡夜市」）\n挂 1 张参考图＝在它的版面上重画、加字、换配色',
    promptGuide:
      '提示词写成 beast-gen 的 references/ideogram4-caption.md 规定的 JSON 标注（画面文字、版式、配色都写进去）；挂了参考图就是在它的版面上重画（参数 image_name，denoise 缺省 0.85）。'
  },
  libImage('lib-image-fast', 'Lib Image 2.5 Fast', 'Lib Image 2.5 Fast', '云端日常生成 · 消耗团队额度'),
  libImage('lib-image-pro', 'Lib Image 2.5 Pro', 'Lib Image 2.5 Pro', '云端复杂指令、多轮改图 · 消耗团队额度'),
  {
    id: 'codex-imagegen',
    template: null,
    label: 'Codex imagegen',
    tag: 'Codex',
    description: 'Codex 内置生图（上游原生能力）',
    cloud: false,
    hosts: ['codex'],
    maxRefs: 10,
    ratios: RATIOS,
    resolutions: null,
    defaultResolution: null,
    counts: COUNTS,
    qualities: null,
    transparent: false,
    estimate: 'Codex 内置生图',
    placeholder: '描述你想生成的图片（有参考图就写清怎么用，例：照 @图1 的画风）\n参考图最多 10 张',
    promptGuide: '使用 Codex 当前可用的图片生成能力（内置 imagegen）；参考图作为视觉参考，不要把文件名或界面元素画进图里。'
  }
]

export function imageModelsForHost(host) {
  return IMAGE_MODELS.filter((model) => !model.hosts || model.hosts.includes(host))
}

export function imageModel(id, host) {
  const models = imageModelsForHost(host)
  return models.find((model) => model.id === id) ?? models.find((model) => model.id === DEFAULT_IMAGE_MODEL_ID)
}

// Clamps whatever the page sent to values the chosen model accepts.
export function normalizeImageSettings(input = {}, host) {
  const model = imageModel(input.model, host)
  const pick = (value, allowed, fallback) => (allowed && allowed.includes(value) ? value : fallback)
  return {
    model,
    resolution: model.resolutions ? pick(input.resolution, model.resolutions, model.defaultResolution) : null,
    count: pick(Number(input.count), model.counts, 1),
    quality: model.qualities ? pick(input.quality, model.qualities.map((quality) => quality.id), model.defaultQuality) : null,
    transparent: model.transparent ? input.transparent === true : false
  }
}

// The model's supported ratio closest to the holder's shape.
export function nearestRatio(ratios, width, height) {
  let best = ratios[0]
  let bestScore = Infinity
  for (const ratio of ratios) {
    const [w, h] = ratio.split(':').map(Number)
    const score = Math.abs(Math.log(width / height / (w / h)))
    if (score < bestScore) {
      best = ratio
      bestScore = score
    }
  }
  return best
}

// beast-gen parameters for the chosen settings (reference images are filled in after upload).
export function imageTemplateParameters(settings, ratio) {
  const { model } = settings
  const parameters = {}
  if (model.templateModel) parameters.model = model.templateModel
  if (model.qualities) parameters.quality = settings.quality
  if (ratio) parameters.ratio = ratio
  if (settings.resolution) parameters.resolution = settings.resolution
  parameters.n = settings.count
  return parameters
}
