// What Claude Code / ZCode hear about a canvas request before asking the user, and the host
// notes they read after: 按标注修改 comes with its 标注 word for word and may be handled as
// remarks instead of a new picture; AI HTML / Slides are not asked about image models. The
// queue keeps its requests across a service restart, and a page withdrawing a request hears
// when it is gone (a replaced service) or already started.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Before the service's modules load: the canvas server a check starts keeps its session names
// and runtime files here, never in the user's ~/.cowart-claude.
const scratch = await mkdtemp(join(tmpdir(), 'cowart-requests-check-'))
process.env.COWART_SESSION_NAMES_FILE = join(scratch, 'names.json')
process.env.COWART_RUNTIME_DIR = join(scratch, 'runtime')
const { hostNotes: claudeHostNotes } = await import('../../claude/lib/cli.mjs')
const { requestNotice } = await import('../../claude/lib/request-notice.mjs')
const { UPSTREAM_WIDGET_HTML } = await import('../../shared/paths.mjs')
const { hostNotes: zcodeHostNotes } = await import('../../zcode/lib/bridge.mjs')
const { CanvasRequestQueue, REQUESTS_FILE_NAME, requestAnnotations, requestTask } = await import('../lib/requests.mjs')
const { CanvasServer, agentEventPayload } = await import('../lib/server.mjs')

const MENTION = '[@Cowart](plugin://cowart@cowart-github)'

// Upstream's request buttons, by the first line they write (src/App.jsx).
const UPSTREAM_TASKS = {
  按标注修改: 'annotation-edit',
  '按标注生成 AI HTML': 'html',
  '按标注修改 AI HTML': 'html',
  按标注生图: 'generate-image',
  生成图片: 'generate-image',
  '生成 AI HTML': 'html',
  '生成 AI Slides': 'html',
  '按标注修改 AI Slides': 'html'
}

// Remarks on a screenshot of the user's game, the case that used to be asked about image models.
const REMARKS = [
  'DEV面板现在的各种功能，我有些看不懂都是干嘛的，特别是本地对局，既然没有AI，你的意思是我就是进去点东西，然后匹配到空对手，然后下一轮是吗？',
  'lobby服务器跟你左下角的功能是不是重复了？ / 直连roomserver又是干嘛的？',
  '这个功能我们这里设计的有点奇怪，为什么还要给我选headscale，完全取消这个链接方式，要么内网要么本机',
  '把「开始匹配」做成设计稿里的金属牌，DEV 嵌进按钮'
]

// The request src/App.jsx builds for 按标注修改, with the lines annotationNoteLines writes.
function annotationEditText(changes, notes = []) {
  return [
    `${MENTION} 按标注修改`,
    '本请求来自已经打开的 Cowart 画布；请复用当前画布，不要调用 render_cowart_canvas_widget，除非用户明确要求重新打开或刷新。',
    '',
    '请根据这张 Cowart 截图里的标注修改当前选中的图片：',
    '',
    'Cowart source image shape: shape:shot',
    `Included annotation shapes: ${changes.length + notes.length}`,
    'Change requests (标注 arrows bound to this shape; each spot is where the tip points, in % of the shape width and height from its top-left):',
    ...changes.map((words, index) => `${index + 1}. ${words ? `「${words}」` : '(no words on this arrow; see the screenshot)'} → (40%, 30%)`),
    ...(notes.length
      ? [
          'Standing notes (注释 arrows bound to this shape: background to keep in mind, not changes to make this time; spots as above):',
          ...notes.map((words) => `- 「${words}」 → (50%, 50%)`)
        ]
      : []),
    'Screenshot size: 1600x900',
    'Annotation screenshot local path: C:/canvas/pages/page/assets/annotation-edit.png'
  ].join('\n')
}

function queued(text) {
  return new CanvasRequestQueue().create({ text, pageId: 'page:kards', pageName: 'kards-tavern' })
}

test('upstream still writes the request titles the confirmation tells apart', async () => {
  const widget = await readFile(UPSTREAM_WIDGET_HTML, 'utf8')
  for (const [title, task] of Object.entries(UPSTREAM_TASKS)) {
    assert.ok(widget.includes(`"${MENTION} ${title}"`), `upstream no longer sends 「${title}」`)
    assert.equal(requestTask(queued(`${MENTION} ${title}\n说明`)), task, title)
  }
  // The panels tag their own requests; anything else upstream adds gets the plain question.
  for (const kind of ['image', 'video', 'web']) assert.equal(requestTask({ kind, title: '按标注修改' }), kind)
  assert.equal(requestTask(queued(`${MENTION} 生成视频\n说明`)), 'canvas')
})

test('按标注修改 keeps its 标注 and 注释 word for word, and the short summary the canvas shows', () => {
  const request = queued(annotationEditText([...REMARKS, ''], ['这是开发版主菜单']))
  assert.equal(request.title, '按标注修改')
  assert.equal(request.summary, '6 条标注')
  assert.deepEqual(request.annotations, [
    ...REMARKS.map((text) => ({ text, note: false })),
    { text: '', note: false },
    { text: '这是开发版主菜单', note: true }
  ])
  assert.deepEqual(requestAnnotations(`${MENTION} 生成 AI HTML\n\nPrompt:\n1. 「不是标注」 → (1%, 1%)`), [])
})

test('the notification quotes the 标注 and lets Claude offer to handle them as remarks', () => {
  const line = requestNotice(agentEventPayload(queued(annotationEditText(REMARKS, ['这是开发版主菜单']))))
  const quoted = `①「${REMARKS[0].slice(0, 60)}…」②「${REMARKS[1]}」③「${REMARKS[2]}」④「${REMARKS[3]}」`
  assert.ok(
    line.startsWith(`Cowart 画布请求 #1「按标注修改」（页「kards-tavern」）：4 条标注：${quoted}；1 条注释（常驻说明）：「这是开发版主菜单」 → 马上用 AskUserQuestion 问用户一句。`),
    line
  )
  assert.match(line, /是对图里界面、功能、设计的意见或问题.*就推荐照标注处理/)
  assert.match(line, /选项（推荐的放第一个）：照标注处理（答疑、改当前项目，不生图）\/ 按标注出新图（免费本地模型）\/ 按标注出新图（云端，消耗团队额度）\/ 跳过/)
  assert.ok(line.endsWith('用户明确选了要做的那项（或自己打字说要做）才再调 get_cowart_request {"id": 1} 看详情照做；答「无偏好」、没选、看不出要不要做都不算答应：不做、不回状态，跟用户说一句要做时再说'), line)

  const many = requestNotice(agentEventPayload(queued(annotationEditText(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 条`)))))
  assert.match(many, /10 条标注：①「第 1 条」.*⑧「第 8 条」… → /)
  assert.match(requestNotice(agentEventPayload(queued(annotationEditText(['', '改成红色'])))), /2 条标注：①（没写字）②「改成红色」 → /)
})

test('only image generation is asked about image models', () => {
  const notice = (text) => requestNotice(agentEventPayload(queued(text)))
  assert.match(notice(`${MENTION} 生成 AI HTML\n\nPrompt:\n一个登录页`), /：一个登录页 → 马上用 AskUserQuestion 问用户一句（执行 \/ 跳过）/)
  assert.match(notice(`${MENTION} 按标注修改 AI Slides\n\nIncluded annotation shapes: 1`), /问用户一句（执行 \/ 跳过）/)
  assert.match(notice(`${MENTION} 按标注生图\n\nIncluded annotation shapes: 1`), /（执行（免费本地模型）\/ 执行（云端，消耗团队额度）\/ 跳过）/)
  // A service from before annotations were listed: the line falls back to the summary.
  const old = agentEventPayload(queued(annotationEditText(['改成红色'])))
  delete old.annotations
  assert.match(requestNotice(old), /「按标注修改」（页「kards-tavern」）：1 条标注 → .*照标注处理/)
})

test('host notes say what to do with either choice, on all three hosts', () => {
  const edit = queued(annotationEditText(REMARKS))
  const html = queued(`${MENTION} 生成 AI HTML\n\nPrompt:\n一个登录页`)
  const image = queued(`${MENTION} 按标注生图\n\nIncluded annotation shapes: 1`)
  // Claude Code runs the cowart command (put html), ZCode the MCP tool.
  for (const [hostNotes, insertHtml] of [[claudeHostNotes, /put html/], [zcodeHostNotes, /insert_cowart_html_draft/]]) {
    const editNotes = hostNotes(edit).join('\n')
    assert.match(editNotes, /选项（推荐的放第一个）：照标注处理（答疑、改当前项目，不生图）/)
    assert.match(editNotes, /用户选「照标注处理」时：.*不生图、不往画布放图/)
    assert.match(editNotes, /用户选「按标注出新图」时：.*beast-gen/)
    const htmlNotes = hostNotes(html).join('\n')
    assert.match(htmlNotes, /选项给「执行」「跳过」/)
    assert.match(htmlNotes, insertHtml)
    assert.doesNotMatch(htmlNotes, /免费本地模型|insert_cowart_image|put image/)
    assert.match(hostNotes(image).join('\n'), /「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」/)
  }
  // Codex runs the cowart command too, and asks nothing in a dialog.
  const codexNotes = (request) => claudeHostNotes(request, 'cowart', 'codex').join('\n')
  assert.match(codexNotes(edit), /先读标注：是对图里界面、功能、设计的意见或问题.*不生图、不往画布放图/)
  assert.match(codexNotes(edit), /结果放进发出请求的那一页：put 带上 --page page:kards/)
  assert.doesNotMatch(codexNotes(html), /先读标注/)
})

test('the queue keeps its requests, numbers and statuses across a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cowart-requests-'))
  const saved = () => new Promise((resolve) => setImmediate(resolve))
  try {
    const file = join(directory, REQUESTS_FILE_NAME)
    const before = new CanvasRequestQueue({ file })
    const asked = before.create({ text: annotationEditText(REMARKS), session: 'kards', pageId: 'page:kards', pageName: 'kards-tavern' })
    before.markDelivered(asked.id)
    const started = before.create({ text: `${MENTION} 生成 AI HTML\n\nPrompt:\n登录页`, session: 'kards' })
    before.update(started.id, { status: 'running' })
    const job = before.create({ text: 'AI 图片', kind: 'image', executor: 'service', title: 'AI 图片' })
    before.setProgress(job.id, '排队中…')
    await saved()

    const after = new CanvasRequestQueue({ file })
    assert.deepEqual(after.get(asked.id), JSON.parse(JSON.stringify(before.get(asked.id))))
    assert.equal(after.get(started.id).status, 'running')
    // The old service's generation went with it.
    assert.equal(after.get(job.id).status, 'failed')
    assert.match(after.get(job.id).message, /画布服务重启了/)
    assert.equal(after.create({ text: '下一条', session: 'kards' }).id, job.id + 1)
    after.update(started.id, { status: 'done', message: '好了' })
    await saved()
    assert.equal(new CanvasRequestQueue({ file }).get(started.id).status, 'done')

    // A file that cannot be read starts an empty queue.
    await writeFile(file, '{oops')
    const fresh = new CanvasRequestQueue({ file })
    assert.deepEqual(fresh.list(), [])
    assert.equal(fresh.create({ text: '从头来', session: 'kards' }).id, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a withdrawal says when the request is gone or already started', async () => {
  const queue = new CanvasRequestQueue()
  const ops = new EventEmitter()
  ops.canvasPages = async () => [{ id: 'page:second', name: 'Second' }]
  const server = new CanvasServer({
    token: 'isolated-test-token', identity: { service: 'cowart-canvas', protocol: 3, version: 'test', build: 'test' },
    canvasDir: join(scratch, 'canvas'), queue, ops, renderPage: async () => '<html></html>'
  })
  await server.start({ port: 0 })
  // What a canvas page posts (the page API over HTTP).
  const action = async (path, body) => {
    const response = await fetch(server.origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cowart-token': 'isolated-test-token' }, body: JSON.stringify(body) })
    return { status: response.status, payload: await response.json() }
  }
  try {
    const sent = await action('/api/messages', { text: 'withdraw me', session: 'withdraw-a', pageId: 'page:second', pageName: 'Second' })
    assert.equal(sent.status, 200, JSON.stringify(sent))
    const { id, requestKey } = sent.payload.request
    // A page still showing a request from before a replaced service: nothing has its number,
    // or the number now belongs to another request.
    for (const body of [{ id: 9999 }, { id, requestKey: 'old-service-request' }]) {
      const gone = await action('/api/requests/cancel', body)
      assert.equal(gone.status, 410)
      assert.equal(gone.payload.gone, true)
    }
    queue.update(id, { status: 'running' })
    const late = await action('/api/requests/cancel', { id, requestKey })
    assert.equal(late.status, 409)
    assert.match(late.payload.error, /撤销不了/)
    assert.equal(late.payload.request.status, 'running')
    queue.update(id, { status: 'done' })
  } finally {
    await server.close()
  }
})

// Codex reads its requests with the cowart command (requests / request), as Claude Code does: the
// native widget's delivery (claim, acknowledge, release) is gone.
test('the service takes no Codex widget delivery', async () => {
  const queue = new CanvasRequestQueue()
  const ops = new EventEmitter()
  ops.canvasPages = async () => []
  const server = new CanvasServer({
    token: 'isolated-test-token', identity: { service: 'cowart-canvas', protocol: 3, version: 'test', build: 'test' },
    canvasDir: join(scratch, 'canvas'), queue, ops, renderPage: async () => '<html></html>'
  })
  await server.start({ port: 0 })
  const post = async (path, body) => {
    const response = await fetch(server.origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cowart-token': 'isolated-test-token' }, body: JSON.stringify(body) })
    return { status: response.status, payload: await response.json() }
  }
  try {
    const request = queue.create({ text: 'for a widget', session: 'widget-gone' })
    for (const path of ['/api/requests/claim', '/api/requests/delivered', '/api/requests/release']) {
      assert.equal((await post(path, { id: request.id, pane: 'pane-gone' })).status, 404, path)
    }
    assert.equal(queue.get(request.id).delivered, false)
    assert.equal(server.pageCount, 0)
  } finally {
    await server.close()
  }
})

test.after(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
