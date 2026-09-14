// Writes the prompt a beast template expects from what the user typed into an AI 图片 / AI 视频
// panel (FORK.md, 画布直接生成). A headless Claude Code run gets the beast-gen writing guide for
// the template as its instructions, the brief as JSON and the reference images inline, and
// answers with the prompt. It has no tools, no MCP servers, no session and no thinking: it
// writes text and nothing else, the canvas service does the rest. COWART_PROMPT_WRITER=off
// turns it off, COWART_CLAUDE_CLI names the executable (default: claude on PATH) and
// COWART_PROMPT_MODEL the model (default haiku). Without it, or when it fails, the user's
// words go in as they are, inside the structure the template needs.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const WRITER_TIMEOUT_MS = 120_000
// The API takes images up to 5 MB after base64, which adds a third.
const MAX_INLINE_IMAGE_BYTES = 3_600_000
const MAX_INLINE_IMAGES = 8
const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
])
export const MAGENTA_BACKGROUND = 'flat solid pure magenta background, no cast shadow'

function skillDir() {
  return process.env.COWART_BEAST_SKILL_DIR || join(homedir(), '.claude', 'skills', 'beast-gen')
}

const FLUX_RULE =
  'Write an English instruction: what to do and what to keep (e.g. "Replace the background with a beach at dusk, keep the face and pose unchanged"). Refer to reference images as image 1, image 2 … in upload order. Without references, write an English text-to-image prompt.'

// Per template: the beast-gen guides to follow (kept current by `beast upgrade`) and the rule
// that matters most when the guide is long.
const TEMPLATES = {
  krea2: {
    guides: ['image.md'],
    rule: 'Write one English prompt: subject, style, composition, lighting. With a reference image the template redraws that image as a whole (it does not edit parts of it); call it "the reference image".'
  },
  'flux2-klein': { guides: ['image.md'], rule: FLUX_RULE },
  'flux2-dev': { guides: ['image.md'], rule: FLUX_RULE },
  ideogram4: {
    guides: ['ideogram4-caption.md'],
    rule: 'Write the complete structured caption the guide describes (key order, bbox, palette). Give the caption object itself as "prompt" (a JSON object, not a string).'
  },
  'lib-image': {
    guides: ['image-prompting.md'],
    rule: 'Write the prompt the guide describes, in the language that fits the user (Chinese is fine). Say what each reference image is for, as 图1, 图2 … in upload order.'
  },
  'minimax-h3': {
    guides: ['h3-prompt.md'],
    rule: 'Write the English prompt structure the guide prescribes for the mode in the brief (the three fields, or the six sections for Ref2VA). When the brief gives a firstLine, the prompt starts with exactly that line, then an empty line, then the fields. Use the material tags from the brief.'
  },
  seedance: {
    guides: ['seedance-prompt.md'],
    rule: 'Write the Chinese prompt the guide prescribes. Refer to materials with the tags from the brief (图片N / 视频N / 音频N; a first or last frame as 首帧 / 尾帧). Do not put ratio, duration, resolution or sound into the prompt.'
  }
}

const AUTO_RULE =
  'Pick the template first: krea2 for text-to-image, concept art and redrawing a single reference; flux2-klein for instruction edits and compositing with up to 4 references; flux2-dev for the strongest identity keeping, more than 4 references, complex compositions or text in the image; ideogram4 for posters, UI, logos and anything with lettering. Only pick from the templates the brief allows. Answer with "template" too, and write the prompt the way the chosen template needs.'

function abortError() {
  return Object.assign(new Error('已撤销'), { name: 'AbortError' })
}

async function guideText(files) {
  const parts = []
  for (const file of files) {
    try {
      parts.push(`--- ${file} ---\n${await readFile(join(skillDir(), 'references', file), 'utf8')}`)
    } catch {
      // No beast-gen skill here: the rules above still apply.
    }
  }
  return parts.join('\n\n')
}

async function systemPrompt(brief) {
  const auto = brief.template === 'auto'
  const templates = auto ? brief.allowedTemplates : [brief.template]
  const guides = [...new Set(templates.flatMap((id) => TEMPLATES[id]?.guides ?? []))]
  return [
    'You write the prompt for one generation job on the beast gateway. A user typed a description into a canvas panel; turn it into the prompt the template expects, following the writing guide below. You only write text: there are no tools and nothing else to do.',
    '',
    'Rules:',
    "- Keep the user's intent and every concrete requirement. Do not add characters, props, text, colors or story the user did not ask for; add only what the template needs to work (structure, composition, shot and sound fields).",
    '- Dialogue, lyrics and on-screen text stay in their original language, word for word.',
    "- The brief lists the materials in upload order with the tag to use for each; the user's @ mentions (like @图1 or @首帧) mean those materials. The images among them follow the brief, each after its tag.",
    ...(auto ? [`- ${AUTO_RULE}`] : []),
    ...templates.map((id) => `- ${id}: ${TEMPLATES[id]?.rule ?? 'Write the prompt the template expects.'}`),
    ...(brief.transparent ? [`- The background is removed afterwards: end the prompt with "${MAGENTA_BACKGROUND}".`] : []),
    `- Reply with one JSON object and nothing else (no code fence, no comment): {${auto ? '"template": "<id>", ' : ''}"prompt": …}.`,
    '',
    'Writing guide (from the beast-gen skill):',
    await guideText(guides)
  ].join('\n')
}

function briefForModel(brief) {
  return {
    template: brief.template === 'auto' ? `auto (choose one of ${brief.allowedTemplates.join(', ')})` : brief.template,
    model: brief.modelLabel,
    ...(brief.mode ? { mode: brief.mode } : {}),
    ...(brief.firstLine ? { firstLine: brief.firstLine } : {}),
    parameters: brief.params,
    materials: brief.materials.map(({ tag, mention, role, kind }) => ({ tag, mention, role, kind })),
    transparentBackground: Boolean(brief.transparent),
    userDescription: brief.userPrompt
  }
}

async function userContent(brief) {
  const content = [{ type: 'text', text: `Brief:\n${JSON.stringify(briefForModel(brief), null, 2)}` }]
  let shown = 0
  for (const material of brief.materials) {
    if (material.kind !== 'images' || shown >= MAX_INLINE_IMAGES) continue
    const mediaType = IMAGE_MEDIA_TYPES.get(extname(material.path).toLowerCase())
    if (!mediaType) continue
    try {
      if ((await stat(material.path)).size > MAX_INLINE_IMAGE_BYTES) continue
      const data = (await readFile(material.path)).toString('base64')
      content.push({ type: 'text', text: `${material.tag}（${material.role}）:` }, { type: 'image', source: { type: 'base64', media_type: mediaType, data } })
      shown += 1
    } catch {
      // Unreadable: the brief still names it.
    }
  }
  return content
}

function writerCommand() {
  const cli = process.env.COWART_CLAUDE_CLI || 'claude'
  return /\.(m?js|cjs)$/i.test(cli) ? { command: process.execPath, prefix: [cli] } : { command: cli, prefix: [] }
}

async function runWriter({ system, content, signal }) {
  const dir = await mkdtemp(join(tmpdir(), 'cowart-writer-'))
  try {
    const systemFile = join(dir, 'system-prompt.md')
    await writeFile(systemFile, system, 'utf8')
    const { command, prefix } = writerCommand()
    const args = [
      ...prefix,
      '-p',
      '--model',
      process.env.COWART_PROMPT_MODEL || 'haiku',
      '--settings',
      JSON.stringify({ alwaysThinkingEnabled: false }),
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--system-prompt-file',
      systemFile
    ]
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const child = spawn(command, args, {
        cwd: dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MAX_THINKING_TOKENS: '0' }
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        settle(value)
      }
      const onAbort = () => {
        child.kill()
        finish(reject, abortError())
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(reject, new Error('写提示词超时'))
      }, WRITER_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => finish(reject, new Error(`启动不了 claude：${error.message}`)))
      child.on('close', (code) => {
        for (const line of stdout.split(/\r?\n/)) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event?.type !== 'result') continue
          if (event.is_error) finish(reject, new Error(String(event.result || 'claude 报错').slice(0, 120)))
          else finish(resolve, String(event.result ?? ''))
          return
        }
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-2).join(' ')
        finish(reject, new Error(`claude 没有回答（退出码 ${code}）${tail ? `：${tail.slice(0, 120)}` : ''}`))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function parseAnswer(text, brief) {
  const raw = String(text ?? '').replace(/```(?:json)?/g, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const prompt =
    typeof parsed.prompt === 'string' ? parsed.prompt.trim() : parsed.prompt && typeof parsed.prompt === 'object' ? JSON.stringify(parsed.prompt) : ''
  if (!prompt) return null
  const template = brief.template === 'auto' ? (brief.allowedTemplates.includes(parsed.template) ? parsed.template : null) : brief.template
  return { prompt, template }
}

// The parts a template cannot do without, whoever wrote the rest.
function finishPrompt(prompt, template, brief) {
  let text = prompt
  if (template === 'minimax-h3' && brief.firstLine && !text.startsWith(brief.firstLine)) text = `${brief.firstLine}\n\n${text}`
  if (brief.transparent && template !== 'ideogram4' && !/magenta/i.test(text)) text = `${text.replace(/[\s,.;，。；]+$/, '')}, ${MAGENTA_BACKGROUND}`
  return text
}

export function fallbackTemplate(brief) {
  if (brief.template !== 'auto') return brief.template
  const references = brief.materials.length
  if (references === 0) return 'krea2'
  return references > 4 ? 'flux2-dev' : 'flux2-klein'
}

function h3Skeleton(brief, text) {
  const line = text.replace(/\s+/g, ' ').trim()
  if (brief.mode !== 'Ref2VA') {
    return [
      ...(brief.firstLine ? [brief.firstLine, ''] : []),
      `integrated_multimodal_description: [Shot 1] ${line}`,
      '',
      'overall_soundscape: Natural ambient sound that fits the scene.',
      '',
      'non_diegetic_music: N/A'
    ].join('\n')
  }
  const pictures = brief.materials.filter((material) => material.kind === 'images')
  const audios = brief.materials.filter((material) => material.kind === 'audios')
  return [
    'subject_definitions:',
    ...pictures.map((material, index) => `<Subject ${index + 1}> is the subject shown in ${material.tag}.`),
    ...audios.map((material) => `${material.tag} is a sound reference for the target video.`),
    '',
    'summary:',
    `[reference generation] ${line}`,
    '',
    'retention_analysis:',
    ...pictures.map((material, index) => `<Subject ${index + 1}> (appears in [Shot 1]): fully_preserved - identity and appearance as in ${material.tag}.`),
    ...audios.map((material) => `${material.tag}: reference - its sound guides the target video.`),
    '',
    'detailed_description:',
    `[Shot 1] ${line}`,
    '',
    'overall_soundscape:',
    'Natural ambient sound that fits the scene.',
    '',
    'non_diegetic_music:',
    'N/A'
  ].join('\n')
}

// The user's words with the @ mentions swapped for the template's tags.
export function fallbackPrompt(brief, template = fallbackTemplate(brief)) {
  let text = brief.userPrompt
  for (const material of brief.materials) if (material.mention) text = text.split(material.mention).join(material.tag)
  if (template === 'minimax-h3') text = h3Skeleton(brief, text)
  return finishPrompt(text, template, brief)
}

// brief: { kind, template ('auto' or a template id), allowedTemplates, modelLabel, mode,
// firstLine, params, materials: [{ tag, mention, role, kind, path }], transparent, userPrompt }.
// Returns { template, prompt, written, note }.
export async function writePrompt(brief, { signal, log } = {}) {
  if (process.env.COWART_PROMPT_WRITER === 'off') {
    const template = fallbackTemplate(brief)
    return { template, prompt: fallbackPrompt(brief, template), written: false, note: null }
  }
  try {
    const answer = parseAnswer(await runWriter({ system: await systemPrompt(brief), content: await userContent(brief), signal }), brief)
    if (!answer) throw new Error('没给出能用的提示词')
    const template = answer.template ?? fallbackTemplate(brief)
    return { template, prompt: finishPrompt(answer.prompt, template, brief), written: true, note: null }
  } catch (error) {
    if (signal?.aborted) throw abortError()
    log?.(`prompt writer failed: ${error.message}`)
    const template = fallbackTemplate(brief)
    return { template, prompt: fallbackPrompt(brief, template), written: false, note: `提示词没润色（${error.message.slice(0, 60)}），按原话生成` }
  }
}
