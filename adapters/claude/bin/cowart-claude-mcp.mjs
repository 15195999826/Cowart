#!/usr/bin/env node
// Entry point Claude Code runs as the `cowart` MCP server (see adapters/claude/README.md).
import { startClaudeAdapter } from '../lib/adapter.mjs'

startClaudeAdapter().catch((error) => {
  process.stderr.write(`[cowart-claude] failed to start: ${error?.stack || error}\n`)
  process.exit(1)
})
