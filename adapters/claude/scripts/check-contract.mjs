#!/usr/bin/env node
// Verifies the upstream surface the Claude adapter depends on. Run after every upstream
// sync (FORK.md): a failure means the adapter must be updated before merging to main.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { REPO_ROOT, UPSTREAM_RELEASE_MANIFEST, UPSTREAM_WIDGET_HTML } from '../../shared/paths.mjs'
import { UpstreamCowart } from '../../shared/upstream.mjs'

// Page-side hooks the injected bridge and overlay rely on.
const WIDGET_MARKERS = [
  'cowartMcp',
  'callServerTool',
  'sendFollowUpMessage',
  'getHostCapabilities',
  'openai:set_globals',
  'toolOutput',
  '__cowartEditor',
  'getSelectedShapes'
]

// Upstream tools and the input properties the adapter passes.
const EXPECTED_TOOLS = {
  render_cowart_canvas_widget: ['projectDir', 'canvasDir'],
  get_cowart_canvas_state: ['projectDir', 'canvasDir', 'hydrateAssets'],
  save_cowart_canvas_state: ['projectDir', 'canvasDir', 'snapshot', 'protectImageRecords'],
  save_cowart_selection_state: ['selection'],
  save_cowart_view_state: ['viewState'],
  get_cowart_selection: ['projectDir'],
  read_cowart_page_asset: ['assetUrl'],
  save_cowart_reference_image: ['dataUrl'],
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
    if (!(name in EXPECTED_TOOLS)) notes.push(`new upstream tool ${name}: decide whether the model should see it (PAGE_ONLY_TOOLS in adapters/claude/lib/adapter.mjs)`)
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
