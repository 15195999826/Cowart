#!/usr/bin/env node
// Verifies the upstream surface the Claude adapter depends on. Run after every upstream
// sync (FORK.md): a failure means the adapter must be updated before merging to main.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO_ROOT, UPSTREAM_RELEASE_MANIFEST, UPSTREAM_SERVER_BUNDLE, UPSTREAM_WIDGET_HTML } from '../../shared/paths.mjs'
import { UpstreamCowart } from '../../shared/upstream.mjs'

// Page-side hooks the injected bridge and the shared page scripts rely on.
const WIDGET_MARKERS = [
  'cowartMcp',
  'callServerTool',
  'sendFollowUpMessage',
  'getHostCapabilities',
  'openai:set_globals',
  'toolOutput',
  '__cowartEditor',
  'cowart:canvas-ready',
  'getSelectedShapes',
  '__cowartExtensions?.tools',
  '__cowartExtensions?.panels',
  '__cowartExtensions?.imageToolbar',
  '__cowartExtensions?.contextMenu',
  // Service-served pages stream videos from the service instead of reading them through MCP.
  'directAssetUrl',
  'tool.cowart-extension-',
  'cowartAiImageHolder',
  // The annotation binding patch: the 标注 / 注释 tools bind arrows to cards, prompts list
  // them, cards clear their 标注.
  '要指向一张卡片',
  'Change requests (标注 arrows bound to this shape',
  'cowartAnnotationNote',
  // Requests keep the source page through asynchronous export/upload before routing.
  '来源卡片已不在画布上',
  '调整页面列表大小',
  'tool.cowart-clear-annotations',
  // Hidden or reused by the shared page scripts: a web card's image toolbar drops 替换 /
  // 裁剪 / 按标注生成 Html, annotations drawn with the 标注 tool go along with 照这个做
  // HTML, the style panel shows only when wanted, and two main menu items are dropped.
  'tlui-media__toolbar',
  'tool.image-replace',
  'tool.image-crop',
  'tool.cowart-annotation-html',
  'cowartAnnotationArrow',
  'tlui-style-panel__wrapper',
  'insert-embed',
  'insert-media',
  // The page leaves the context menu for Radix to close (canvas-chrome.js): tldraw's menu
  // registry, and the fact that its context menu is registered under this name.
  'clearOpenMenus',
  'deleteOpenMenu',
  'context menu'
]

// Records upstream's server writes that the canvas service reads: an image upstream put into
// an AI 图片 holder carries this meta, and the service centers it there when it fits the
// image back to its bitmap's ratio (canvas-ops.mjs).
const SERVER_MARKERS = ['cowartGeneratedForAiImageHolder']

// Upstream tools and the input properties the adapter passes.
const EXPECTED_TOOLS = {
  render_cowart_canvas_widget: ['projectDir', 'canvasDir'],
  get_cowart_canvas_state: ['projectDir', 'canvasDir', 'hydrateAssets'],
  save_cowart_canvas_state: ['projectDir', 'canvasDir', 'snapshot', 'protectImageRecords'],
  save_cowart_selection_state: ['selection'],
  save_cowart_view_state: ['viewState'],
  get_cowart_selection: ['projectDir'],
  read_cowart_page_asset: ['assetUrl'],
  save_cowart_reference_image: ['dataUrl', 'pageId', 'fileName'],
  download_cowart_file: ['fileName'],
  copy_cowart_image_to_clipboard: ['dataUrl'],
  insert_cowart_image: ['imagePath', 'anchorShapeId', 'replaceAiImageHolder'],
  insert_cowart_html_draft: ['htmlContent', 'draftShapeId'],
  track_cowart_analytics_event: ['eventName']
}

const STORAGE_EXPORTS = ['resolveCowartPaths', 'pageDirName', 'pageAssetUrl']

const problems = []
const notes = []

const packageVersion = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version
const manifest = JSON.parse(await readFile(UPSTREAM_RELEASE_MANIFEST, 'utf8'))
if (manifest.version !== packageVersion) {
  problems.push(`mcp/generated is ${manifest.version} but package.json is ${packageVersion}: run npm run build:artifacts`)
}

const widget = await readFile(UPSTREAM_WIDGET_HTML, 'utf8')
for (const marker of WIDGET_MARKERS) {
  if (!widget.includes(marker)) problems.push(`widget no longer references "${marker}"`)
}
if (!widget.includes('</head>')) problems.push('widget has no </head> to inject the bridge before')

const server = await readFile(UPSTREAM_SERVER_BUNDLE, 'utf8')
for (const marker of SERVER_MARKERS) {
  if (!server.includes(marker)) problems.push(`upstream server no longer writes "${marker}"`)
}

const storage = await import('../../../mcp/lib/canvas-storage.mjs')
for (const name of STORAGE_EXPORTS) {
  if (typeof storage[name] !== 'function') problems.push(`mcp/lib/canvas-storage.mjs no longer exports ${name}()`)
}

const upstream = new UpstreamCowart({ clientName: 'cowart-contract-check', clientVersion: '0.0.0' })
try {
  const tools = new Map((await upstream.listTools()).map((tool) => [tool.name, tool]))
  for (const [name, properties] of Object.entries(EXPECTED_TOOLS)) {
    const tool = tools.get(name)
    if (!tool) {
      problems.push(`upstream tool ${name} is gone`)
      continue
    }
    const known = Object.keys(tool.inputSchema?.properties ?? {})
    for (const property of properties) {
      if (!known.includes(property)) problems.push(`upstream ${name} lost input "${property}"`)
    }
  }
  for (const name of tools.keys()) {
    if (!(name in EXPECTED_TOOLS)) notes.push(`new upstream tool ${name}: decide whether the model should see it (PAGE_ONLY_TOOLS in adapters/service/lib/canvas-ops.mjs)`)
  }

  // The service checks what it writes (the layout tools, the canvas summary) by saving into a
  // scratch canvas and reading which records upstream's tldraw validation skipped.
  const scratch = await mkdtemp(join(tmpdir(), 'cowart-contract-'))
  try {
    const empty = JSON.parse(await readFile(join(REPO_ROOT, 'adapters', 'shared', 'empty-canvas.json'), 'utf8'))
    const broken = { id: 'shape:contract', typeName: 'shape', type: 'text', x: 0, y: 0, rotation: 0, index: 'b1', parentId: 'page:page', isLocked: false, opacity: 1, props: { text: 'old props' }, meta: {} }
    const saved = await upstream.callTool('save_cowart_canvas_state', { projectDir: scratch, canvasDir: scratch, snapshot: { ...empty, store: { ...empty.store, [broken.id]: broken } } })
    const skipped = saved?.structuredContent?.skippedRecords
    if (!Array.isArray(skipped) || !skipped.some((record) => record.id === broken.id)) {
      problems.push('upstream save_cowart_canvas_state no longer reports the records tldraw validation skipped (skippedRecords)')
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
} finally {
  await upstream.close()
}

for (const note of notes) console.log(`NOTE  ${note}`)
if (problems.length > 0) {
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  process.exit(1)
}
console.log(`OK    upstream ${packageVersion} matches what the Claude adapter expects`)
