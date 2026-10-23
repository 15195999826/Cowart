// Installs this Cowart for the user (`cowart install` / `uninstall`, install-skill.mjs): the cowart
// command sessions run (~/.cowart/bin/cowart.mjs) and, on Windows, the canvas service at logon.
// CowartCanvas.lnk in the Startup folder (Task Manager's 启动应用 can turn it off) runs
// ~/.cowart/bin/start-service.vbs, which runs ~/.cowart/bin/cowart-service.mjs on the machine's port
// with no window, and again a minute later when it fails, the way the localhost front door's
// launcher runs Caddy. The two .mjs files are a few lines that lead to this checkout's or release's
// command and service, so installing another one rewrites them. Installing starts no service:
// sessions start it when they need it, as before. COWART_COMMAND_LINK, COWART_SERVICE_LINK and
// COWART_STARTUP_DIR put the files elsewhere (checks).
// On a machine with Codex (CODEX_HOME, else ~/.codex) it also sets Codex up to run the same command:
// its cowart skill (installCodex below), the prompt hook that reminds a session of its canvas
// requests, and without the cowart_mcp server its MCP bridge needed.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { SERVICE_ENTRY } from '../../service/client.mjs'
import { DEFAULT_PORT, EXIT_CANVAS_BUSY, EXIT_PORT_TAKEN, samePath } from '../../service/lib/identity.mjs'
import { SERVICE_LOG } from '../../service/lib/token.mjs'
import { ADAPTERS_DIR, REPO_ROOT } from '../../shared/paths.mjs'

export const ENTRY = process.env.COWART_BUNDLED === '1'
  ? join(ADAPTERS_DIR, 'generated', 'cowart.mjs')
  : join(ADAPTERS_DIR, 'claude', 'bin', 'cowart.mjs')
// The command the skill names: a small file `cowart install` writes, leading to ENTRY (wherever
// this checkout or release is). COWART_COMMAND_LINK moves it (tests).
export const COMMAND_LINK = process.env.COWART_COMMAND_LINK || join(homedir(), '.cowart', 'bin', 'cowart.mjs')
export const COMMAND_LINK_SHOWN = process.env.COWART_COMMAND_LINK ? COMMAND_LINK.replaceAll('\\', '/') : '~/.cowart/bin/cowart.mjs'
// The canvas service the launcher runs at logon, the same way: leading to SERVICE_ENTRY. The
// launcher sits beside it.
export const SERVICE_LINK = process.env.COWART_SERVICE_LINK || join(homedir(), '.cowart', 'bin', 'cowart-service.mjs')
const LAUNCHER = join(dirname(SERVICE_LINK), 'start-service.vbs')
const SHORTCUT_NAME = 'CowartCanvas.lnk'
const NOT_WINDOWS = '开机自启只在 Windows 上装'

// The file a link file (written below) leads to.
export function linkTarget(file = COMMAND_LINK) {
  try {
    const match = /^const target = (".*")$/m.exec(readFileSync(file, 'utf8'))
    return match ? JSON.parse(match[1]) : null
  } catch {
    return null
  }
}

export async function installCommandLink() {
  const target = ENTRY.replaceAll('\\', '/')
  const source = [
    '#!/usr/bin/env node',
    '// The cowart command of Claude Code sessions (see the cowart skill), written by `cowart install`.',
    '// It runs the Cowart checkout or release below; installing another one rewrites this file.',
    "import { existsSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    `const target = ${JSON.stringify(target)}`,
    'if (!existsSync(target)) {',
    "  process.stderr.write(`cowart 命令指向的 ${target} 不在了：重新安装 Cowart（cowart skill 里写了怎么装）。\\n`)",
    '  process.exit(2)',
    '}',
    'await import(pathToFileURL(target).href)',
    ''
  ].join('\n')
  await mkdir(dirname(COMMAND_LINK), { recursive: true })
  await writeFile(COMMAND_LINK, source)
  return { link: COMMAND_LINK, target }
}

// Only the link to this entry: another checkout's is left alone.
export async function removeCommandLink() {
  const target = linkTarget()
  if (!existsSync(COMMAND_LINK)) return { removed: false, reason: '没有安装过' }
  if (!samePath(target, ENTRY)) return { removed: false, reason: `它指向的是 ${target ?? '别的东西'}，不是这一份` }
  await rm(COMMAND_LINK, { force: true })
  return { removed: true }
}

// A Cowart that is gone has no service to run: it exits 0, so the launcher stops instead of trying
// again every minute.
function serviceLinkSource(target) {
  return [
    '#!/usr/bin/env node',
    '// The Cowart canvas service, written by `cowart install`: start-service.vbs beside it runs it at',
    '// logon (CowartCanvas.lnk in the Startup folder). It runs the Cowart checkout or release below;',
    '// installing another one rewrites this file.',
    "import { existsSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    `const target = ${JSON.stringify(target)}`,
    'if (!existsSync(target)) {',
    "  process.stderr.write(`画布服务入口指向的 ${target} 不在了：重新安装 Cowart（cowart skill 里写了怎么装）。\\n`)",
    '  process.exit(0)',
    '}',
    'await import(pathToFileURL(target).href)',
    ''
  ].join('\n')
}

// VBScript, saved as UTF-16 so any path reads right. A path that is gone ends it quietly: a script
// error would show a dialog at logon. It looks before every start, not once: uninstall leaves a
// running launcher alone, and node may move (an upgrade) while it waits for the service.
function launcherSource() {
  const text = (value) => `"${String(value).replaceAll('"', '""')}"`
  const quoted = (path) => `""${path}""`
  return [
    "' Cowart canvas service launcher, written by `cowart install` and started at logon by",
    "' CowartCanvas.lnk in the Startup folder: runs the machine's canvas service with no window.",
    "' When the service fails it starts it again a minute later; it ends when the service ends on its",
    `' own (0: stopped by hand, replaced by a newer one) or finds the port or the canvas served already`,
    `' (${EXIT_PORT_TAKEN}, ${EXIT_CANVAS_BUSY}). Only one launcher runs at a time.`,
    'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    `Set running = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'wscript.exe' AND CommandLine LIKE '%${basename(LAUNCHER)}%'")`,
    'If running.Count > 1 Then WScript.Quit 0',
    '',
    'Set files = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    `If files.FolderExists(${text(REPO_ROOT)}) Then shell.CurrentDirectory = ${text(REPO_ROOT)}`,
    `command = "${quoted(process.execPath)} ${quoted(SERVICE_LINK)} --port ${DEFAULT_PORT} --log ${quoted(SERVICE_LOG)}"`,
    'Do',
    `  If Not files.FileExists(${text(process.execPath)}) Or Not files.FileExists(${text(SERVICE_LINK)}) Then Exit Do`,
    '  code = shell.Run(command, 0, True)',
    `  If code = 0 Or code = ${EXIT_PORT_TAKEN} Or code = ${EXIT_CANVAS_BUSY} Then Exit Do`,
    '  WScript.Sleep 60000',
    'Loop',
    ''
  ].join('\r\n')
}

function powershell(script, env = {}) {
  const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true
  })
}

// The user's Startup folder (it can be moved, into OneDrive say): Windows knows where.
function startupDir() {
  if (process.env.COWART_STARTUP_DIR) return process.env.COWART_STARTUP_DIR
  try {
    const dir = powershell("[Console]::Out.WriteLine([Environment]::GetFolderPath('Startup'))").trim()
    if (dir) return dir
  } catch {
    // The usual place, then.
  }
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

const SHORTCUT_SCRIPT = [
  '$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:COWART_SHORTCUT)',
  "$link.TargetPath = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'",
  `$link.Arguments = '"' + $env:COWART_LAUNCHER + '"'`,
  '$link.WorkingDirectory = Split-Path -Parent $env:COWART_LAUNCHER',
  "$link.Description = 'Cowart canvas service (cowart install)'",
  '$link.Save()'
].join('\n')

// Windows only ({ skipped } elsewhere). Rewrites what an earlier install wrote.
export async function installServiceAutostart() {
  if (process.platform !== 'win32') return { skipped: NOT_WINDOWS }
  const target = SERVICE_ENTRY.replaceAll('\\', '/')
  await mkdir(dirname(SERVICE_LINK), { recursive: true })
  await writeFile(SERVICE_LINK, serviceLinkSource(target))
  await writeFile(LAUNCHER, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcherSource(), 'utf16le')]))
  const shortcut = join(startupDir(), SHORTCUT_NAME)
  await mkdir(dirname(shortcut), { recursive: true })
  powershell(SHORTCUT_SCRIPT, { COWART_SHORTCUT: shortcut, COWART_LAUNCHER: LAUNCHER })
  return { link: SERVICE_LINK, target, launcher: LAUNCHER, shortcut }
}

// What installServiceAutostart wrote, when the service entry leads to this Cowart (or is gone):
// another checkout's is left alone. A running service keeps running.
export async function removeServiceAutostart() {
  if (process.platform !== 'win32') return { skipped: NOT_WINDOWS }
  const target = linkTarget(SERVICE_LINK)
  if (existsSync(SERVICE_LINK) && !samePath(target, SERVICE_ENTRY)) {
    return { removed: false, reason: `${SERVICE_LINK} 指向的是 ${target ?? '别的东西'}，不是这一份` }
  }
  const files = [join(startupDir(), SHORTCUT_NAME), LAUNCHER, SERVICE_LINK].filter((file) => existsSync(file))
  for (const file of files) await rm(file, { force: true })
  return files.length > 0 ? { removed: true, files } : { removed: false, reason: '没有安装过' }
}

// ---- Codex ----------------------------------------------------------------------------
// Codex sessions run the cowart command too (D13 of docs/plan/codex-cli-resident.md). Its skill is
// linked into <home>/skills/cowart the way the Claude skill is into ~/.claude/skills; its hooks.json
// gets a UserPromptSubmit hook that runs `cowart hook prompt` (cli.mjs) through the command above;
// and what the Codex plugin's MCP bridge used goes: the cowart_mcp server in config.toml and the
// three skills beside the old cowart one. A file is backed up before it changes
// (<file>.bak-cowart-<time>); nothing is touched when Codex's home is not there.
export const CODEX_SKILL = join(ADAPTERS_DIR, 'claude', 'codex-skill', 'cowart')
const OLD_CODEX_SKILLS = ['cowart-image-edit', 'cowart-image-gen', 'cowart-open-canvas']
const HOOK_EVENT = 'UserPromptSubmit'
const HOOK_TIMEOUT_S = 5

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

// What the hook runs. Codex runs it through cmd /C "…" on Windows and $SHELL -lc elsewhere, and
// holds the user's message back when it exits 2 with something on stderr: what the command link
// does when the Cowart it leads to is gone, and an older cowart that knows no `hook`. So the hook
// ends with 0 whatever the command does (it prints nothing on stdout when it fails).
export function promptHookCommand() {
  return `"${process.execPath}" "${COMMAND_LINK}" hook prompt || exit 0`
}

const isCowartHook = (hook) => typeof hook?.command === 'string' && hook.command.includes('cowart') && hook.command.includes('hook prompt')

function kindOf(path) {
  try {
    const stats = lstatSync(path)
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

// Where a link leads, as written (a junction's target may come with \\?\ in front).
function linkLeadsTo(path) {
  try {
    return readlinkSync(path).replace(/^\\\\\?\\/, '')
  } catch {
    return null
  }
}

function pointsAt(link, target) {
  try {
    return samePath(realpathSync(link), realpathSync(target))
  } catch {
    return samePath(linkLeadsTo(link), target)
  }
}

// A junction on Windows (no admin rights needed), a symlink elsewhere; both go with rmdir there.
function makeLink(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function removeLink(link) {
  if (process.platform === 'win32') rmdirSync(link)
  else unlinkSync(link)
}

function stamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

async function backUp(file) {
  const base = `${file}.bak-cowart-${stamp()}`
  let backup = base
  for (let n = 2; existsSync(backup); n += 1) backup = `${base}-${n}`
  await copyFile(file, backup)
  return backup
}

const withoutBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

function isHooksFile(config) {
  const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  return object(config) && (config.hooks === undefined || (object(config.hooks) && (config.hooks[HOOK_EVENT] === undefined || Array.isArray(config.hooks[HOOK_EVENT]))))
}

// The UserPromptSubmit hooks with the cowart one in them once (hook) or not at all (null): an
// earlier cowart hook is replaced where it is, more of them go, and so do groups that held only them.
function withHook(config, hook) {
  const groups = config.hooks?.[HOOK_EVENT] ?? []
  if (!hook && !groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isCowartHook))) return config
  let placed = false
  const kept = []
  for (const group of groups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(isCowartHook)) {
      kept.push(group)
      continue
    }
    const hooks = group.hooks.flatMap((entry) => {
      if (!isCowartHook(entry)) return [entry]
      if (placed || !hook) return []
      placed = true
      return [hook]
    })
    if (hooks.length > 0) kept.push({ ...group, hooks })
  }
  if (hook && !placed) kept.push({ hooks: [hook] })
  const hooks = { ...config.hooks, [HOOK_EVENT]: kept }
  if (kept.length === 0) delete hooks[HOOK_EVENT]
  return { ...config, hooks }
}

// hooks.json changed by change(config); left alone when it is not JSON Codex would read.
async function editHooks(home, change) {
  const file = join(home, 'hooks.json')
  const original = existsSync(file) ? await readFile(file, 'utf8') : null
  let config = {}
  if (original !== null) {
    try {
      config = JSON.parse(withoutBom(original))
    } catch {
      return { ok: false, file, reason: '不是合法的 JSON' }
    }
    if (!isHooksFile(config)) return { ok: false, file, reason: `的格式认不出（要 {"hooks": {"${HOOK_EVENT}": [...]}}）` }
  }
  const next = change(config)
  if (JSON.stringify(next) === JSON.stringify(config)) return { ok: true, file, changed: false }
  const backup = original === null ? null : await backUp(file)
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, file, changed: true, backup }
}

// A line that leaves a value open (an array or inline table not closed on it, a multi-line
// string): the lines that follow are the value's, though one may read like a table header.
function opensValue(line) {
  if (/"""|'''/.test(line)) return true
  let depth = 0
  for (const char of line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '')) {
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth !== 0
}

// config.toml without the table [mcp_servers.cowart_mcp] and its subtables ([…cowart_mcp.env]),
// up to the next other table; every other byte as it was. null when a value in it goes on over
// lines: the table is cut line by line, and a line inside the value could pass for the next table.
export function withoutCowartMcp(text) {
  const table = /^[ \t]*\[\[?(.*?)\]\]?[ \t]*(#.*)?\r?\n?$/
  let dropping = false
  let tangled = false
  const kept = text
    .split(/(?<=\n)/)
    .filter((line) => {
      const header = table.exec(line)
      if (header) dropping = /^mcp_servers\.cowart_mcp(\.|$)/.test(header[1].replace(/[\s"']/g, ''))
      else if (dropping && opensValue(line)) tangled = true
      return !dropping
    })
    .join('')
  return tangled ? null : kept
}

async function dropCowartMcp(home) {
  const file = join(home, 'config.toml')
  if (!existsSync(file)) return { changed: false }
  const original = await readFile(file, 'utf8')
  const text = withoutCowartMcp(original)
  if (text === null) return { changed: false, tangled: true, file }
  if (text === original) return { changed: false }
  const backup = await backUp(file)
  await writeFile(file, text)
  return { changed: true, file, backup }
}

// The old plugin's skills: links into some checkout's adapters/codex/skills, nothing else.
function isOldCodexSkill(link) {
  return String(linkLeadsTo(link) ?? '').replaceAll('\\', '/').toLowerCase().includes('/adapters/codex/skills/')
}

// { skipped } when this machine has no Codex; else { ok, lines }.
export async function installCodex() {
  const home = codexHome()
  if (!existsSync(home)) return { skipped: `没找到 ${home}，这台机器像是没装 Codex` }
  const lines = []
  let ok = true
  const failed = (line) => {
    ok = false
    lines.push(line)
  }

  const link = join(home, 'skills', 'cowart')
  const kind = kindOf(link)
  if (!existsSync(join(CODEX_SKILL, 'SKILL.md'))) {
    failed(`Codex 的 cowart skill 没装：这一份 Cowart 里没有 ${join(CODEX_SKILL, 'SKILL.md')}。`)
  } else if (kind === 'link' && pointsAt(link, CODEX_SKILL)) {
    lines.push(`Codex 的 cowart skill 已经链接：${link} → ${CODEX_SKILL}`)
  } else if (kind === 'link' || kind === 'missing') {
    mkdirSync(dirname(link), { recursive: true })
    if (kind === 'link') removeLink(link)
    makeLink(CODEX_SKILL, link)
    lines.push(`${kind === 'link' ? '已把 Codex 的 cowart skill 改指向' : '已给 Codex 装上 cowart skill'}：${link} → ${CODEX_SKILL}`)
  } else {
    failed(`Codex 的 cowart skill 没装：${link} 是一个真实的${kind === 'directory' ? '目录' : '文件'}，不是链接，没动它；要换成链接请先自己挪走。`)
  }
  const old = OLD_CODEX_SKILLS.map((name) => join(home, 'skills', name)).filter((path) => kindOf(path) === 'link' && isOldCodexSkill(path))
  for (const path of old) removeLink(path)
  if (old.length > 0) lines.push(`已删掉以前 Codex 插件的 skill 链接：${old.map((path) => basename(path)).join('、')}（现在都在 cowart 这一个 skill 里）。`)

  const hook = await editHooks(home, (config) => withHook(config, { type: 'command', command: promptHookCommand(), timeout: HOOK_TIMEOUT_S }))
  if (!hook.ok) failed(`Codex 的提醒 hook 没装：${hook.file} ${hook.reason}，没动它。`)
  else if (!hook.changed) lines.push(`Codex 的提醒 hook 已经装好：${hook.file}`)
  else lines.push(`已在 ${hook.file} 装上 Codex 的提醒 hook（用户每发一句话跑一次 cowart hook prompt，画布上有请求在等时提醒会话）${hook.backup ? `，原文件备份在 ${hook.backup}` : ''}；Codex 第一次见到它时要在 Codex 里信任一次。`)

  const mcp = await dropCowartMcp(home)
  if (mcp.changed) lines.push(`已从 ${mcp.file} 去掉以前 Codex 插件的 cowart_mcp（备份在 ${mcp.backup}）；开着的 Codex 要重开才不再起它。`)
  else if (mcp.tangled) lines.push(`没从 ${mcp.file} 去掉以前 Codex 插件的 cowart_mcp：它那一段里有跨行的值，按行删可能删错，请自己删掉 [mcp_servers.cowart_mcp]（连同它的子表），再重开 Codex。`)
  return { ok, lines }
}

// The skill link when it leads to this Cowart, and the prompt hook unless another Cowart's command
// still answers at the command's place (the hook runs that). config.toml stays as it is.
export async function removeCodex() {
  const home = codexHome()
  if (!existsSync(home)) return { skipped: `没找到 ${home}` }
  const lines = []
  let ok = true
  const link = join(home, 'skills', 'cowart')
  const kind = kindOf(link)
  if (kind === 'link' && pointsAt(link, CODEX_SKILL)) {
    removeLink(link)
    lines.push(`已删掉 Codex 的 cowart skill 链接 ${link}。`)
  } else if (kind !== 'missing') {
    lines.push(`没删 ${link}：它不是指向这一份 Cowart 的链接。`)
  }
  const command = linkTarget(COMMAND_LINK)
  if (existsSync(COMMAND_LINK) && !samePath(command, ENTRY)) {
    lines.push(`Codex 的提醒 hook 没删：${COMMAND_LINK} 指向的是 ${command ?? '别的东西'}，hook 还在用它。`)
  } else {
    const hook = await editHooks(home, (config) => withHook(config, null))
    if (!hook.ok) {
      ok = false
      lines.push(`Codex 的提醒 hook 没删：${hook.file} ${hook.reason}，没动它。`)
    } else if (hook.changed) {
      lines.push(`已从 ${hook.file} 删掉 Codex 的提醒 hook（原文件备份在 ${hook.backup}）。`)
    }
  }
  return { ok, lines }
}

// Everything above, said line by line; ok: false when a part failed.
export async function installCowart() {
  const command = await installCommandLink()
  const lines = [`已安装 cowart 命令：${command.link} → ${command.target}`]
  let ok = true
  try {
    const autostart = await installServiceAutostart()
    lines.push(autostart.skipped
      ? `画布服务的开机自启没装：${autostart.skipped}。`
      : `已安装画布服务的开机自启：${autostart.shortcut}（登录时由 ${autostart.launcher} 在后台跑 ${autostart.link} → ${autostart.target}；任务管理器「启动应用」里能禁用）。这次没有启动它，会话用到画布时照旧拉起。`)
  } catch (error) {
    ok = false
    lines.push(`画布服务的开机自启没装上：${error.message}`)
  }
  try {
    const codex = await installCodex()
    if (codex.skipped) lines.push(`Codex 的 cowart skill 和提醒 hook 没装：${codex.skipped}。`)
    else {
      ok &&= codex.ok
      lines.push(...codex.lines)
    }
  } catch (error) {
    ok = false
    lines.push(`Codex 的 cowart skill 和提醒 hook 没装上：${error.message}`)
  }
  return { ok, lines }
}

export async function removeCowart() {
  const command = await removeCommandLink()
  const lines = [command.removed ? `已删掉 ${COMMAND_LINK}。` : `没删 ${COMMAND_LINK}：${command.reason}。`]
  let ok = true
  try {
    const autostart = await removeServiceAutostart()
    if (!autostart.skipped) {
      lines.push(autostart.removed
        ? `已删掉画布服务的开机自启：${autostart.files.join('、')}（正在跑的画布服务不停）。`
        : `画布服务的开机自启没删：${autostart.reason}。`)
    }
  } catch (error) {
    ok = false
    lines.push(`画布服务的开机自启没删掉：${error.message}`)
  }
  try {
    const codex = await removeCodex()
    if (!codex.skipped) {
      ok &&= codex.ok
      lines.push(...codex.lines)
    }
  } catch (error) {
    ok = false
    lines.push(`Codex 的 cowart skill 和提醒 hook 没删掉：${error.message}`)
  }
  return { ok, lines }
}
