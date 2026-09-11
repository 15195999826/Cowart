// Reads the upstream single-file widget and injects host-specific scripts,
// mirroring what upstream's injectMcpHostBridge does for MCP Apps hosts.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ADAPTERS_DIR, UPSTREAM_WIDGET_HTML } from './paths.mjs'

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const SHARED_WEB_DIR = join(ADAPTERS_DIR, 'shared', 'web')
// Page scripts both hosts inject after their bridge; the kit comes first.
export const SHARED_WEB_SCRIPTS = ['kit.js', 'canvas-chrome.js', 'video-playback.js', 'ai-video.js', 'ai-image.js', 'web-reference.js']

export async function readUpstreamWidgetHtml() {
  return readFile(UPSTREAM_WIDGET_HTML, 'utf8')
}

export function scriptTag(source, id) {
  const safe = String(source).replaceAll('</script', '<\\/script').replaceAll('</SCRIPT', '<\\/SCRIPT')
  return `<script${id ? ` id="${id}"` : ''}>${safe}</script>`
}

export function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(LINE_SEPARATOR, '\\u2028')
    .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029')
}

export function injectIntoHead(html, markup) {
  if (html.includes('</head>')) return html.replace('</head>', () => `${markup}\n</head>`)
  return `${markup}\n${html}`
}

// window.__cowartHostConfig plus the shared page scripts (read fresh, so edits need no restart).
export async function sharedPageScripts(hostConfig) {
  const sources = await Promise.all(SHARED_WEB_SCRIPTS.map((file) => readFile(join(SHARED_WEB_DIR, file), 'utf8')))
  return [
    scriptTag(`window.__cowartHostConfig=${jsonForInlineScript(hostConfig)};`, 'cowartHostConfig'),
    ...sources.map((source, index) => scriptTag(source, `cowartShared-${SHARED_WEB_SCRIPTS[index].replace(/\.js$/, '')}`))
  ].join('\n')
}
