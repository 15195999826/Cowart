#!/usr/bin/env node
// Entry point Claude Code runs as the `cowart` MCP server (see adapters/claude/README.md):
// a thin per-session bridge to the machine-wide canvas service.
import { startClaudeBridge } from '../lib/bridge.mjs'

startClaudeBridge().catch((error) => {
  process.stderr.write(`[cowart-claude] failed to start: ${error?.stack || error}\n`)
  process.exit(1)
})
