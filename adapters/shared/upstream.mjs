// Runs the upstream Cowart MCP server (mcp/generated bundle) as a child process
// and talks to it as an MCP client, so adapters never have to modify upstream code.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { REPO_ROOT, UPSTREAM_SERVER_BUNDLE } from './paths.mjs'

export class UpstreamCowart {
  #client = null
  #connecting = null
  #tools = null

  constructor({ clientName, clientVersion, cwd = process.cwd(), env = process.env, onStderr } = {}) {
    this.clientName = clientName
    this.clientVersion = clientVersion
    this.cwd = cwd
    this.env = env
    this.onStderr = onStderr
  }

  async client() {
    if (this.#client) return this.#client
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #connect() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [UPSTREAM_SERVER_BUNDLE],
      cwd: this.cwd,
      env: { ...this.env, COWART_PLUGIN_ROOT: REPO_ROOT },
      stderr: 'pipe'
    })
    transport.stderr?.on('data', (chunk) => this.onStderr?.(chunk))

    const client = new Client({ name: this.clientName, version: this.clientVersion })
    client.onclose = () => {
      if (this.#client === client) this.#client = null
    }
    await client.connect(transport)
    this.#client = client
    return client
  }

  async listTools() {
    if (this.#tools) return this.#tools
    const client = await this.client()
    const { tools } = await client.listTools()
    this.#tools = tools
    return tools
  }

  async callTool(name, args = {}, { timeoutMs = 120_000 } = {}) {
    const client = await this.client()
    return client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
  }

  async close() {
    const client = this.#client
    this.#client = null
    await client?.close().catch(() => {})
  }
}

// Unwraps a CallToolResult into its structured payload, throwing on tool errors.
export function structuredOrThrow(result, toolName) {
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text
    throw new Error(message || `Cowart tool failed: ${toolName}`)
  }
  return result?.structuredContent ?? {}
}
