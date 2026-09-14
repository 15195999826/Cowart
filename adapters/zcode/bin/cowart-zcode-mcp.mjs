#!/usr/bin/env node
// Entry point ZCode runs as the `cowart` MCP server (see adapters/zcode/README.md): a thin
// per-session bridge to the machine-wide canvas service, the ZCode sibling of
// adapters/claude/bin/cowart-claude-mcp.mjs.
import { startZCodeBridge } from '../lib/bridge.mjs'

startZCodeBridge().catch((error) => {
  process.stderr.write(`[cowart-zcode] failed to start: ${error?.stack || error}\n`)
  process.exit(1)
})
