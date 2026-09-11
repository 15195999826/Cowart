// Video models the canvas "AI 视频" panel offers, mirroring the beast-gen video templates
// (`beast gen templates --kind video`). Single source for the page's options and for
// validating what the page sends; update it when the gateway's templates change.
// New holders start on the free local model; each model remembers its own settings.
export const DEFAULT_VIDEO_MODEL_ID = 'h3'

const H3_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']
const SEEDANCE_LIMITS = { images: 30, videos: 10, audios: 10 }

function seedance(id, model, label, description, { resolutions, maxDuration }) {
  return {
    id,
    template: 'seedance',
    templateModel: model,
    label,
    description,
    cloud: true,
    ratios: SEEDANCE_RATIOS,
    resolutions,
    defaultResolution: '720P',
    durations: range(4, maxDuration),
    defaultDuration: 5,
    counts: [1, 2, 4],
    sound: true,
    qualities: null,
    limits: SEEDANCE_LIMITS
  }
}

export const VIDEO_MODELS = [
  {
    id: 'h3',
    template: 'minimax-h3',
    templateModel: null,
    label: 'MiniMax H3',
    description: '本地 · 免费 · 自带音效 · 最长 15 秒',
    cloud: false,
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: ['480P', '720P'],
    defaultResolution: '720P',
    durations: H3_DURATIONS,
    defaultDuration: 5,
    counts: null,
    sound: null,
    qualities: [
      { id: 'turbo', label: '草稿 · 快' },
      { id: 'full', label: '精细 · 约慢 3 倍' }
    ],
    limits: { images: 9, videos: 3, audios: 3 }
  },
  seedance('seedance-2.0-fast', 'Seedance 2.0 Fast VIP', 'Seedance 2.0 Fast', '云 · 消耗额度 · 出片快', {
    resolutions: ['480P', '720P'],
    maxDuration: 15
  }),
  seedance('seedance-2.0-vip', 'Seedance 2.0 VIP', 'Seedance 2.0 VIP', '云 · 消耗额度 · 可 1080P / 4K', {
    resolutions: ['480P', '720P', '1080P', '4K'],
    maxDuration: 15
  }),
  seedance('seedance-2.0-mini', 'Seedance 2.0 Mini', 'Seedance 2.0 Mini', '云 · 消耗额度 · 性价比', {
    resolutions: ['480P', '720P'],
    maxDuration: 15
  }),
  seedance('seedance-2.5', 'Seedance 2.5', 'Seedance 2.5', '云 · 消耗额度 · 最新 · 最长 30 秒', {
    resolutions: ['480P', '720P'],
    maxDuration: 30
  })
]

export const VIDEO_MATERIAL_KINDS = ['images', 'videos', 'audios']

export function videoModel(id) {
  return VIDEO_MODELS.find((model) => model.id === id) ?? VIDEO_MODELS.find((model) => model.id === DEFAULT_VIDEO_MODEL_ID)
}

// Clamps whatever the page sent to values the chosen model accepts.
export function normalizeVideoSettings(input = {}) {
  const model = videoModel(input.model)
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
  return {
    model,
    ratio: pick(input.ratio, model.ratios, model.ratios[0]),
    resolution: pick(input.resolution, model.resolutions, model.defaultResolution),
    duration: pick(Number(input.duration), model.durations, model.defaultDuration),
    quality: model.qualities ? pick(input.quality, model.qualities.map((quality) => quality.id), 'turbo') : null,
    count: model.counts ? pick(Number(input.count), model.counts, 1) : 1,
    sound: model.sound === null ? null : input.sound !== false
  }
}

// beast-gen parameters for the chosen settings (materials are filled in after upload).
export function templateParameters(settings) {
  const { model } = settings
  if (model.template === 'minimax-h3') {
    return { ratio: settings.ratio, resolution: settings.resolution, duration: settings.duration, turbo: settings.quality !== 'full' }
  }
  return {
    model: model.templateModel,
    ratio: settings.ratio,
    resolution: settings.resolution,
    duration: settings.duration,
    n: settings.count,
    sound: settings.sound
  }
}
