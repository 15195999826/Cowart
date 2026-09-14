#!/usr/bin/env node
// Installs the ZCode-side Cowart adapter into this machine's ZCode (see adapters/zcode/README.md):
// 1. registers the `cowart` MCP server (the ZCode bridge) in ~/.zcode/cli/config.json under
//    mcp.servers — every scope auto-connects, so new sessions get the tools;
// 2. links the ZCode cowart skill into ~/.zcode/skills/cowart (a junction on Windows);
// 3. links ~/.claude/skills/beast-gen into ~/.zcode/skills/beast-gen when present, since canvas
//    image/video work loads it with the Skill tool (best effort, skipped when absent).
// The server config uses absolute paths: ZCode does not expand ${...} in config-file servers.
// Usage: node install.mjs [--remove]
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ADAPTERS_DIR } from '../../shared/paths.mjs'

const SERVER_NAME = 'cowart'
const BRIDGE_ENTRY = join(ADAPTERS_DIR, 'zcode', 'bin', 'cowart-zcode-mcp.mjs')
const CONFIG_FILE = join(process.env.ZCODE_CONFIG_DIR || join(homedir(), '.zcode', 'cli'), 'config.json')
const SKILLS_DIR = process.env.ZCODE_SKILLS_DIR || join(homedir(), '.zcode', 'skills')
const BEAST_GEN_SOURCE = join(homedir(), '.claude', 'skills', 'beast-gen')
const remove = process.argv.includes('--remove')

function kindOf(path) {
  try {
    const stats = lstatSync(path)
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

function pointsAtTarget(path, target) {
  try {
    return realpathSync(path) === realpathSync(target)
  } catch {
    return false
  }
}

function removeLink(path) {
  // A junction or directory symlink on Windows goes with rmdir; unlink removes a POSIX symlink.
  if (process.platform === 'win32') rmdirSync(path)
  else unlinkSync(path)
}

// install: true → make the link (re-pointing a link that goes elsewhere), false → remove it.
function linkSkill(name, target, { required = false } = {}) {
  const link = join(SKILLS_DIR, name)
  const kind = kindOf(link)
  if (!remove) {
    if (!existsSync(join(target, 'SKILL.md'))) {
      if (required) {
        console.error(`找不到 ${join(target, 'SKILL.md')}`)
        process.exitCode = 1
      } else {
        console.log(`跳过 ${name}：${target} 不存在`)
      }
      return
    }
    mkdirSync(SKILLS_DIR, { recursive: true })
    if (kind === 'link' && pointsAtTarget(link, target)) {
      console.log(`已经链接：${link} → ${target}`)
      return
    }
    if (kind === 'link' || kind === 'missing') {
      if (kind === 'link') removeLink(link)
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      console.log(`${kind === 'link' ? '已改指向' : '已安装'} skill：${link} → ${target}`)
    } else {
      console.error(`${link} 已经是一个真实的${kind === 'directory' ? '目录' : '文件'}，不动它；要换成链接请先自己挪走。`)
      process.exitCode = 1
    }
  } else if (kind === 'link') {
    removeLink(link)
    console.log(`已移除 skill 链接 ${link}`)
  } else if (kind !== 'missing') {
    console.error(`${link} 是一个真实的${kind === 'directory' ? '目录' : '文件'}，不动它。`)
    process.exitCode = 1
  }
}

// Only the fields ZCode's strict server schema knows; unknown keys would drop the whole entry.
function serverEntry() {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [BRIDGE_ENTRY.replaceAll('\\', '/')],
    env: { COWART_HOST: 'zcode' },
    // First connect may have to start the canvas service (and its upstream child); the default
    // 30s tool-listing timeout is tight for that.
    timeoutMs: 300000
  }
}

function editServer() {
  let config = {}
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' && !remove) {
      console.error(`读不了 ${CONFIG_FILE}：${error.message}`)
      process.exit(1)
    }
  }
  config.mcp ??= {}
  config.mcp.servers ??= {}
  if (remove) {
    if (config.mcp.servers[SERVER_NAME]) {
      delete config.mcp.servers[SERVER_NAME]
      writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
      console.log(`已从 ${CONFIG_FILE} 移除 MCP 服务 ${SERVER_NAME}`)
    } else {
      console.log(`没有注册过：${CONFIG_FILE} 里没有 mcp.servers.${SERVER_NAME}`)
    }
    return
  }
  const previous = config.mcp.servers[SERVER_NAME]
  config.mcp.servers[SERVER_NAME] = serverEntry()
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  console.log(previous ? `已更新 ${CONFIG_FILE} 的 mcp.servers.${SERVER_NAME}` : `已把 mcp.servers.${SERVER_NAME} 写进 ${CONFIG_FILE}`)
}

editServer()
linkSkill('cowart', join(ADAPTERS_DIR, 'zcode', 'skills', 'cowart'), { required: true })
linkSkill('beast-gen', BEAST_GEN_SOURCE)
console.log(remove ? 'ZCode 侧的 cowart 已移除（正在跑的会话要重开才看得到变化）。' : '完成：新开的 ZCode 会话就能用 cowart 工具和 skill；已经开着的会话要重开。')
