#!/usr/bin/env node
// Sets Claude Code up for Cowart: links the Claude-side skill (adapters/claude/skills/cowart) into
// the user's Claude Code skills directory (~/.claude/skills/cowart, or
// $CLAUDE_CONFIG_DIR/skills/cowart) so every session can load it with the Skill tool, and writes
// the cowart command the skill names (~/.cowart/bin/cowart.mjs, leading to this checkout's
// adapters/claude/bin/cowart.mjs). The skill link is a directory junction on Windows (no admin
// rights needed), a symlink elsewhere: the skill stays in the repo and follows the checked-out code.
// Usage: node install-skill.mjs [--remove]
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { installCommandLink, removeCommandLink } from '../lib/cli.mjs'

const SKILL_NAME = 'cowart'
const target = join(ADAPTERS_DIR, 'claude', 'skills', SKILL_NAME)
const skillsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills')
const link = join(skillsDir, SKILL_NAME)
const remove = process.argv.includes('--remove')

function kindOf(path) {
  try {
    const stats = lstatSync(path)
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

function pointsAtTarget(path) {
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

function makeLink() {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

const kind = kindOf(link)
if (remove) {
  if (kind === 'missing') {
    console.log(`没有安装过：${link}`)
  } else if (kind === 'link') {
    removeLink(link)
    console.log(`已移除 ${link}`)
  } else {
    console.error(`${link} 是一个真实的${kind === 'directory' ? '目录' : '文件'}，不是链接，不动它；要换成链接请先自己挪走。`)
    process.exitCode = 1
  }
  const command = await removeCommandLink()
  console.log(command.removed ? '已删掉 cowart 命令（~/.cowart/bin/cowart.mjs）。' : `cowart 命令没删：${command.reason}。`)
} else {
  if (!existsSync(join(target, 'SKILL.md'))) {
    console.error(`找不到 ${join(target, 'SKILL.md')}`)
    process.exit(1)
  }
  mkdirSync(skillsDir, { recursive: true })
  if (kind === 'link' && pointsAtTarget(link)) {
    console.log(`skill 已经链接：${link} → ${target}`)
  } else if (kind === 'link' || kind === 'missing') {
    if (kind === 'link') removeLink(link)
    makeLink()
    console.log(`skill ${kind === 'link' ? '已改指向' : '已安装'}：${link} → ${target}`)
  } else {
    console.error(`${link} 已经是一个真实的${kind === 'directory' ? '目录' : '文件'}，不动它；要换成链接请先自己挪走。`)
    process.exit(1)
  }
  const command = await installCommandLink()
  console.log(`cowart 命令：${command.link} → ${command.target}`)
  console.log('新开的 Claude Code 会话就能用 Skill 工具加载 cowart、用 Bash 跑 node ~/.cowart/bin/cowart.mjs；已经开着的会话要重开才看得到 skill。')
}
