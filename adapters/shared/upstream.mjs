// Runs the upstream Cowart MCP server (mcp/generated bundle) as a child process
// and talks to it as an MCP client, so adapters never have to modify upstream code.
// The child process is stopped once no call has needed it for idleMs (COWART_UPSTREAM_IDLE_MS,
// 3 minutes by default); the next call starts it again, and listTools() answers from what it
// listed before.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { REPO_ROOT, UPSTREAM_SERVER_BUNDLE } from './paths.mjs'

export class UpstreamCowart {
  #client = null
  #connecting = null
  #tools = null
  // Calls using the child process right now, and the timer that stops it once there are none.
  #inFlight = 0
  #idleTimer = null

  constructor({
    clientName,
    clientVersion,
    cwd = process.cwd(),
    env = process.env,
    onStderr,
    idleMs = Number(process.env.COWART_UPSTREAM_IDLE_MS) || 180_000,
    onIdleClose
  } = {}) {
    this.clientName = clientName
    this.clientVersion = clientVersion
    this.cwd = cwd
    this.env = env
    this.onStderr = onStderr
    this.idleMs = idleMs
    this.onIdleClose = onIdleClose
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
    this.#begin()
    try {
      const client = await this.client()
      const { tools } = await client.listTools()
      this.#tools = tools
      return tools
    } finally {
      this.#end()
    }
  }

  async callTool(name, args = {}, { timeoutMs = 120_000 } = {}) {
    this.#begin()
    try {
      const client = await this.client()
      return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    } finally {
      this.#end()
    }
  }

  #begin() {
    this.#inFlight += 1
    clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  #end() {
    this.#inFlight -= 1
    if (this.#inFlight > 0 || !(this.idleMs > 0) || !Number.isFinite(this.idleMs)) return
    this.#idleTimer = setTimeout(() => this.#closeIdle().catch(() => {}), this.idleMs).unref()
  }

  // The tools listed stay: the next listTools() needs no child process.
  async #closeIdle() {
    this.#idleTimer = null
    if (this.#inFlight > 0 || !this.#client) return
    await this.#closeClient()
    this.onIdleClose?.()
  }

  async #closeClient() {
    const client = this.#client
    this.#client = null
    await client?.close().catch(() => {})
  }

  async close() {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = null
    await this.#closeClient()
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
