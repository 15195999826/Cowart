// Reads the upstream single-file widget and injects host-specific scripts,
// mirroring what upstream's injectMcpHostBridge does for MCP Apps hosts.
import { readFile } from 'node:fs/promises'

import { UPSTREAM_WIDGET_HTML } from './paths.mjs'

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

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
