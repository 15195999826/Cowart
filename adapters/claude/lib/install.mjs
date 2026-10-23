// Installs this Cowart for the user (`cowart install` / `uninstall`, install-skill.mjs): the cowart
// command sessions run (~/.cowart/bin/cowart.mjs) and, on Windows, the canvas service at logon.
// CowartCanvas.lnk in the Startup folder (Task Manager's 启动应用 can turn it off) runs
// ~/.cowart/bin/start-service.vbs, which runs ~/.cowart/bin/cowart-service.mjs on the machine's port
// with no window, and again a minute later when it fails, the way the localhost front door's
// launcher runs Caddy. The two .mjs files are a few lines that lead to this checkout's or release's
// command and service, so installing another one rewrites them. Installing starts no service:
// sessions start it when they need it, as before. COWART_COMMAND_LINK, COWART_SERVICE_LINK and
// COWART_STARTUP_DIR put the files elsewhere (checks).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
// error would show a dialog at logon.
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
    `If Not files.FileExists(${text(process.execPath)}) Or Not files.FileExists(${text(SERVICE_LINK)}) Then WScript.Quit 0`,
    'Set shell = CreateObject("WScript.Shell")',
    `If files.FolderExists(${text(REPO_ROOT)}) Then shell.CurrentDirectory = ${text(REPO_ROOT)}`,
    `command = "${quoted(process.execPath)} ${quoted(SERVICE_LINK)} --port ${DEFAULT_PORT} --log ${quoted(SERVICE_LOG)}"`,
    'Do',
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
  return { ok, lines }
}
