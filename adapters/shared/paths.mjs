import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(ADAPTERS_DIR, '..')

// Upstream artifacts the adapters treat as a black box.
export const UPSTREAM_START_SCRIPT = join(REPO_ROOT, 'scripts', 'start-mcp.mjs')
export const UPSTREAM_WIDGET_HTML = join(REPO_ROOT, 'mcp', 'generated', 'cowart-widget.html')
export const UPSTREAM_RELEASE_MANIFEST = join(REPO_ROOT, 'mcp', 'generated', 'release-manifest.json')
