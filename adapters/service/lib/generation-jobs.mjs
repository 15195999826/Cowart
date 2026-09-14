// Generation the canvas service runs itself (FORK.md, 画布直接生成). The AI 图片 / AI 视频
// panels choose the model and every parameter, so a click on 发送 is the whole order: the
// service writes the prompt (prompt-writer.mjs), uploads the materials, submits to the beast
// gateway, waits, downloads and puts the result where the holder was. No Claude session is
// involved and nobody is asked in a chat: the click is the user's own, in their own canvas.
// The request shows each step on the canvas and can be withdrawn until the result goes in.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { shapeSize } from '../../shared/canvas-model.mjs'
import { resolveGeneration } from '../../shared/generation-requests.mjs'
import { imageModelsForHost, imageTemplateParameters, nearestRatio, normalizeImageSettings } from '../../shared/image-models.mjs'
import { templateParameters } from '../../shared/video-models.mjs'
import { BeastCli, findBeastCli } from './beast-cli.mjs'
import { writePrompt } from './prompt-writer.mjs'

// 自动 picks among the free templates; cloud ones only when the user picks them in the panel.
const FREE_AUTO_TEMPLATES = ['krea2', 'flux2-klein', 'flux2-dev', 'ideogram4']
const SINGLE_REFERENCE_TEMPLATES = new Set(['krea2', 'ideogram4'])
// H3 lengths snap to its frame grid (h3-prompt.md): the second mark of the last frame.
const H3_END_MARKS = { 5: '5.17', 6: '5.88', 7: '7.29', 8: '8.00', 9: '8.71', 10: '10.13', 11: '10.83', 12: '12.25', 13: '12.96', 14: '14.38', 15: '15.08' }
const IMAGE_WAIT_SEC = 1800
const VIDEO_WAIT_SEC = 3600
const MATTE_WAIT_SEC = 600
// How often to look at a task, at the gateway's own pace (beast-gen: local images every
// 3–5 s, videos and cloud tasks every 20–30 s), so the canvas shows the queue moving.
const LOCAL_IMAGE_POLL_MS = 4_000
const SLOW_POLL_MS = 20_000
const MATTE_POLL_MS = 3_000
// Missed looks in a row (the gateway briefly unreachable) before the job gives up.
const MAX_MISSED_POLLS = 5

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function shorten(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function abortError() {
  return Object.assign(new Error('已撤销'), { name: 'AbortError' })
}

// krea2 / ideogram4 take one reference; more of them need a FLUX.2 model.
function coerceTemplate(template, referenceCount) {
  if (!SINGLE_REFERENCE_TEMPLATES.has(template) || referenceCount <= 1) return template
  return referenceCount > 4 ? 'flux2-dev' : 'flux2-klein'
}

function imagePlan(resolved, host) {
  const { settings, refs, holder } = resolved
  const auto = settings.model.id === 'auto'
  const template = auto ? 'auto' : settings.model.template
  const { w, h } = shapeSize(holder)
  const tag = (index) => {
    if (template === 'lib-image') return `图${index + 1}`
    if (SINGLE_REFERENCE_TEMPLATES.has(template)) return 'the reference image'
    return `image ${index + 1}`
  }
  const materials = refs.map((ref, index) => ({ tag: tag(index), mention: `@图${index + 1}`, role: '参考图', kind: 'images', path: ref.path }))
  const modelFor = (id) => (auto ? imageModelsForHost(host).find((model) => model.id === id) : settings.model)
  return {
    brief: {
      kind: 'image',
      template,
      allowedTemplates: FREE_AUTO_TEMPLATES.filter((id) => !(settings.transparent && id === 'ideogram4')),
      modelLabel: settings.model.label,
      mode: refs.length === 0 ? 'text-to-image' : template === 'krea2' || template === 'ideogram4' ? 'redraw the reference' : 'edit / composite the references',
      params: {
        canvasSlot: `${Math.round(w)} x ${Math.round(h)}`,
        count: settings.count,
        ...(auto ? {} : imageTemplateParameters(settings, settings.model.ratios ? nearestRatio(settings.model.ratios, w, h) : null))
      },
      materials,
      transparent: settings.transparent,
      userPrompt: resolved.prompt
    },
    // Settled once the template is known (自动 picks it while the prompt is written).
    forTemplate(chosen) {
      const model = modelFor(chosen) ?? modelFor('flux2-klein')
      const finalSettings = auto
        ? normalizeImageSettings({ model: model.id, resolution: settings.resolution, count: settings.count, transparent: settings.transparent }, host)
        : settings
      const ratio = model.ratios ? nearestRatio(model.ratios, w, h) : null
      const referenceParam = SINGLE_REFERENCE_TEMPLATES.has(model.template) ? 'image_name' : 'images'
      return {
        template: model.template,
        label: model.label,
        params: imageTemplateParameters(finalSettings, ratio),
        uploads: refs.length ? [{ param: referenceParam, single: referenceParam === 'image_name', paths: refs.map((ref) => ref.path) }] : [],
        transparent: finalSettings.transparent,
        pollMs: model.cloud ? SLOW_POLL_MS : LOCAL_IMAGE_POLL_MS
      }
    },
    waitSec: IMAGE_WAIT_SEC
  }
}

function videoPlan(resolved) {
  const { settings, mode, firstFrame, lastFrame, refs } = resolved
  const h3 = settings.model.template === 'minimax-h3'
  const materials = []
  const uploads = []
  let videoMode = mode === 'frames' ? (firstFrame || lastFrame ? '首尾帧' : '文生视频') : '参考素材'
  let firstLine = null
  if (mode === 'frames') {
    if (firstFrame) {
      materials.push({ tag: h3 ? '<Picture 1>' : '首帧', mention: '@首帧', role: '首帧', kind: 'images', path: firstFrame })
      uploads.push({ param: 'first_frame', single: true, paths: [firstFrame] })
    }
    if (lastFrame) {
      materials.push({ tag: h3 ? (firstFrame ? '<Picture 2>' : '<Picture 1>') : '尾帧', mention: '@尾帧', role: '尾帧', kind: 'images', path: lastFrame })
      uploads.push({ param: 'last_frame', single: true, paths: [lastFrame] })
    }
    if (h3) {
      const end = H3_END_MARKS[settings.duration] ?? Number(settings.duration).toFixed(2)
      if (firstFrame && lastFrame) {
        videoMode = 'FL2VA'
        firstLine = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${end}-second mark of the target video.`
      } else if (firstFrame) {
        videoMode = 'I2VA'
        firstLine = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
      } else if (lastFrame) {
        videoMode = 'L2VA'
        firstLine = `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${end}-second mark of the target video.`
      } else {
        videoMode = 'T2VA'
      }
    }
  } else {
    const kinds = {
      images: { tag: (n) => (h3 ? `<Picture ${n}>` : `图片${n}`), mention: '图', role: '参考图' },
      videos: { tag: (n) => (h3 ? `<Video ${n}>` : `视频${n}`), mention: '视频', role: '参考视频' },
      audios: { tag: (n) => (h3 ? `<Audio ${n}>` : `音频${n}`), mention: '音频', role: '参考音频' }
    }
    for (const [kind, naming] of Object.entries(kinds)) {
      const paths = refs.filter((ref) => ref.kind === kind).map((ref) => ref.path)
      paths.forEach((path, index) => materials.push({ tag: naming.tag(index + 1), mention: `@${naming.mention}${index + 1}`, role: naming.role, kind, path }))
      if (paths.length) uploads.push({ param: kind, single: false, paths })
    }
    if (h3) videoMode = materials.length ? 'Ref2VA' : 'T2VA'
  }
  const params = templateParameters(settings)
  return {
    brief: {
      kind: 'video',
      template: settings.model.template,
      allowedTemplates: [settings.model.template],
      modelLabel: settings.model.label,
      mode: videoMode,
      firstLine,
      params,
      materials,
      transparent: false,
      userPrompt: resolved.prompt
    },
    forTemplate: () => ({ template: settings.model.template, label: settings.model.label, params, uploads, transparent: false, pollMs: SLOW_POLL_MS }),
    waitSec: VIDEO_WAIT_SEC
  }
}

export class GenerationJobs {
  #upstream
  #ops
  #queue
  #log
  #onActivity
  // request id → { request, controller, beast, taskIds }
  #jobs = new Map()

  constructor({ upstream, ops, queue, log, onActivity }) {
    this.#upstream = upstream
    this.#ops = ops
    this.#queue = queue
    this.#log = log ?? (() => {})
    this.#onActivity = onActivity ?? (() => {})
  }

  get running() {
    return this.#jobs.size
  }

  // Without the beast command line the page hands the request to Claude instead.
  availability() {
    return findBeastCli() ? { ok: true } : { ok: false, reason: '本机没有 beast 命令行（猛兽生成网关的客户端），这次交给 Claude 处理。' }
  }

  // Reads what the panel sent, queues a request the canvas shows, and starts the job.
  async start({ args, host }) {
    if (host === 'codex' && args.kind === 'image' && args.model === 'codex-imagegen') {
      throw Object.assign(new Error('Codex imagegen 由该页负责的 Codex 会话生成。'), { fallback: true })
    }
    const cli = findBeastCli()
    if (!cli) throw Object.assign(new Error(this.availability().reason), { fallback: true })
    const resolved = await resolveGeneration({ upstream: this.#upstream, host, args })
    if (resolved.kind !== 'image' && resolved.kind !== 'video') throw new Error('这类请求要交给 Claude 处理。')
    const label = resolved.kind === 'image' ? 'AI 图片' : 'AI 视频'
    const request = this.#queue.create({
      text: resolved.prompt,
      kind: resolved.kind,
      executor: 'service',
      session: null,
      title: `${label} · ${resolved.settings.model.label}`,
      summary: shorten(resolved.prompt),
      projectDir: resolved.projectDir,
      canvasDir: resolved.canvasDir,
      pageId: resolved.pageId,
      pageName: resolved.pageName,
      holderShapeId: resolved.holderShapeId
    })
    const job = { request, controller: new AbortController(), beast: new BeastCli(cli), taskIds: [] }
    this.#jobs.set(request.id, job)
    this.#onActivity()
    this.#run(job, resolved, host).finally(() => {
      this.#jobs.delete(request.id)
      this.#onActivity()
    })
    return request
  }

  // The user withdrew it on the canvas: stop here, withdraw the gateway tasks still queued
  // (one already on a card runs to the end, its result just never goes in).
  cancel(id) {
    const request = this.#queue.cancel(id)
    const job = this.#jobs.get(request.id)
    if (job) {
      job.controller.abort()
      for (const taskId of job.taskIds) job.beast.cancel(taskId).catch(() => {})
    }
    return request
  }

  async #run(job, resolved, host) {
    const { request, controller, beast } = job
    const { signal } = controller
    const step = (message, options) => {
      if (signal.aborted) throw abortError()
      this.#queue.setProgress(request.id, message, options)
    }
    const notes = []
    let workDir = null
    try {
      workDir = await mkdtemp(join(tmpdir(), 'cowart-generation-'))
      const plan = resolved.kind === 'image' ? imagePlan(resolved, host) : videoPlan(resolved)
      step('写提示词…')
      const written = await writePrompt(plan.brief, { signal, log: this.#log })
      if (written.note) notes.push(written.note)
      const target = plan.forTemplate(coerceTemplate(written.template, plan.brief.materials.length))
      const inputs = { ...target.params, prompt: written.prompt }
      if (target.uploads.length) step('上传素材…')
      for (const upload of target.uploads) {
        const names = []
        for (const path of upload.paths) names.push((await beast.upload(path, { signal })).name)
        inputs[upload.param] = upload.single ? names[0] : names
      }
      step(`提交给 ${target.label}…`)
      const submitted = await beast.submit(target.template, inputs, { signal })
      job.taskIds.push(submitted.task_id)
      step(submitted.queue_position ? `排队中（第 ${submitted.queue_position} 位）· ${target.label}` : `生成中 · ${target.label}`)
      const view = await this.#waitForTask(beast, submitted.task_id, {
        signal,
        timeoutSec: plan.waitSec,
        intervalMs: target.pollMs,
        onView: (current) =>
          step(current.status === 'queued' ? `排队中（第 ${current.queue_position ?? '?'} 位）· ${target.label}` : `生成中 · ${target.label}`)
      })
      if (view.notice) notes.push(view.notice)
      if (view.status !== 'done') throw new Error(view.error ? `猛兽：${view.error}` : `生成没成功（${view.status}）`)
      step('下载结果…')
      const wanted = resolved.kind === 'image' ? 'image' : 'video'
      let files = ((await beast.output(submitted.task_id, workDir, { signal })).saved ?? [])
        .filter((file) => !file.type || file.type === wanted)
        .map((file) => file.path)
      if (files.length === 0) throw new Error('生成完了，但没拿到结果文件。')
      if (target.transparent) {
        step('抠成透明底…')
        files = await this.#matte(files, { job, signal, workDir })
      }
      step('放进画布…', { finishing: true })
      const count = resolved.kind === 'image' ? await this.#insertImages(resolved, files) : await this.#insertVideos(resolved, files)
      this.#queue.finishService(request.id, 'done', [`已放进画布${count > 1 ? `（${count} 个）` : ''}`, ...notes].join('；'))
    } catch (error) {
      if (signal.aborted) return
      this.#log(`generation #${request.id} failed: ${error?.stack || error}`)
      this.#queue.finishService(request.id, 'failed', error instanceof Error ? error.message : String(error))
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Looks at the task at the gateway's pace until it ends (the CLI's own `wait` says nothing
  // until then); onView hears each new state on the way.
  async #waitForTask(beast, taskId, { signal, timeoutSec, intervalMs, onView }) {
    const deadline = Date.now() + timeoutSec * 1000
    let shown = ''
    let missed = 0
    for (;;) {
      let view
      try {
        view = await beast.status(taskId, { signal })
        missed = 0
      } catch (error) {
        if (signal?.aborted || ++missed >= MAX_MISSED_POLLS) throw error
        await pause(intervalMs, signal)
        continue
      }
      if (['done', 'failed', 'unknown'].includes(view.status)) return view
      const state = `${view.status}:${view.queue_position ?? ''}`
      if (state !== shown) {
        shown = state
        onView?.(view)
      }
      if (Date.now() + intervalMs > deadline) {
        throw new Error(`等了 ${Math.round(timeoutSec / 60)} 分钟还没好：猛兽上的任务 ${taskId} 还在，好了可以在猛兽里找到。`)
      }
      await pause(intervalMs, signal)
    }
  }

  // Magenta ground → matte's default (smart cut-out, transparent), as transparent-asset.md says.
  async #matte(files, { job, signal, workDir }) {
    const out = []
    for (const [index, file] of files.entries()) {
      const name = (await job.beast.upload(file, { signal })).name
      const task = await job.beast.submit('matte', { image_name: name }, { signal })
      job.taskIds.push(task.task_id)
      const view = await this.#waitForTask(job.beast, task.task_id, { signal, timeoutSec: MATTE_WAIT_SEC, intervalMs: MATTE_POLL_MS })
      if (view.status !== 'done') throw new Error(`抠透明底没成功：${view.error || view.status}`)
      const saved = (await job.beast.output(task.task_id, join(workDir, `matte-${index + 1}`), { signal })).saved ?? []
      if (!saved[0]) throw new Error('抠透明底没拿到结果。')
      out.push(saved[0].path)
    }
    return out
  }

  // The first result takes the holder's place; the others line up to its right. A holder
  // the user deleted meanwhile leaves the results to upstream's placement on that page.
  async #insertImages(resolved, files) {
    const { projectDir, canvasDir, holderShapeId, pageId } = resolved
    const holderThere = Boolean(await this.#ops.shapeRecord({ projectDir, canvasDir }, holderShapeId))
    let anchor = holderThere ? holderShapeId : null
    for (const [index, file] of files.entries()) {
      const args = { projectDir, canvasDir, imagePath: file }
      if (anchor && index === 0) args.anchorShapeId = anchor
      else if (anchor) Object.assign(args, { anchorShapeId: anchor, replaceAiImageHolder: false, matchAnchor: false, placement: 'right' })
      else if (pageId) args.pageId = pageId
      const result = await this.#ops.callForModel('insert_cowart_image', args)
      if (result?.isError) throw new Error(`放进画布没成功：${textOf(result)}`)
      anchor = result?.structuredContent?.shapeId ?? anchor
    }
    return files.length
  }

  async #insertVideos(resolved, files) {
    const { projectDir, canvasDir, holderShapeId, pageId } = resolved
    const holderThere = Boolean(await this.#ops.shapeRecord({ projectDir, canvasDir }, holderShapeId))
    let anchor = null
    for (const [index, file] of files.entries()) {
      const args = { projectDir, canvasDir, videoPath: file }
      if (index === 0 && holderThere) args.replaceHolderShapeId = holderShapeId
      else if (anchor) Object.assign(args, { anchorShapeId: anchor, placement: 'right' })
      else if (pageId) args.pageId = pageId
      const result = await this.#ops.insertVideo(args)
      anchor = result?.structuredContent?.shapeId ?? anchor
    }
    return files.length
  }
}
