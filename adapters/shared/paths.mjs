import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(ADAPTERS_DIR, '..')

// The machine's one canvas: the canvas service keeps it for every session, project and host
// (FORK.md 画布服务). COWART_CANVAS_DIR puts it elsewhere (tests, an isolated service).
export const SHARED_CANVAS_DIR = resolve(process.env.COWART_CANVAS_DIR || join(homedir(), '.cowart', 'canvas'))

// Upstream artifacts the adapters treat as a black box.
export const UPSTREAM_START_SCRIPT = join(REPO_ROOT, 'scripts', 'start-mcp.mjs')
export const UPSTREAM_SERVER_BUNDLE = join(REPO_ROOT, 'mcp', 'generated', 'cowart-mcp.mjs')
export const UPSTREAM_WIDGET_HTML = join(REPO_ROOT, 'mcp', 'generated', 'cowart-widget.html')
export const UPSTREAM_RELEASE_MANIFEST = join(REPO_ROOT, 'mcp', 'generated', 'release-manifest.json')
