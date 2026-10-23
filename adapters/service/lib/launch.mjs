// Starting a process that does not belong to the host that runs this one (Windows). Claude Code
// desktop runs a session's commands in a job object (so does Codex), and a process started from
// there with libuv's detached spawn stays in that job (libuv does not ask to break away from it):
// the canvas service ended with the host that closed the job, without a word in its log (54 of
// the 73 services from 2026-10-01 to 10-23). A process WMI creates (Win32_Process.Create) is in
// no job and in the same logon session, a child of WMI's own host process, with the environment
// it is given. Elsewhere there is no such thing: launchDetached returns null and callers spawn.
import { spawnSync } from 'node:child_process'

const LAUNCH_TIMEOUT_MS = 15_000

// Reads what to start from COWART_LAUNCH (base64 JSON: commandLine, cwd, env as K=V strings) and
// prints {"ret":…,"pid":…}. One statement per line: with -Command -, PowerShell runs what it reads
// line by line. ShowWindow 0: a console program gets a hidden console.
const SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'Stop'",
  'try { $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COWART_LAUNCH)) | ConvertFrom-Json; $properties = @{ ShowWindow = [uint16]0 }; if (@($launch.env).Count -gt 0) { $properties.EnvironmentVariables = [string[]]@($launch.env) }; $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property $properties; $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$launch.commandLine; CurrentDirectory = [string]$launch.cwd; ProcessStartupInformation = $startup }; [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ ret = [int]$made.ReturnValue; pid = [int]$made.ProcessId })) } catch { [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ ret = -1; error = [string]$_ })) }',
  ''
].join('\n')

// One argument of a Windows command line, the way the C runtime (and CommandLineToArgvW) reads it
// back: quoted when it is empty or has a space, tab or quote; backslashes doubled only where they
// come before a quote.
export function quoteWindowsArgument(value) {
  const text = String(value)
  if (text !== '' && !/[\s"]/.test(text)) return text
  let quoted = '"'
  let backslashes = 0
  for (const char of text) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

export function windowsCommandLine(execPath, args = []) {
  return [execPath, ...args].map(quoteWindowsArgument).join(' ')
}

// Starts execPath with args in cwd with exactly env, outside this process's job: { pid }, or
// null when it did not (not Windows, WMI refused or did not answer in time; onFailure hears why).
export function launchDetached({ execPath, args = [], cwd, env = process.env, onFailure = () => {} }) {
  if (process.platform !== 'win32') return null
  const variables = Object.entries(env)
    .filter(([key, value]) => key && !key.includes('=') && value !== undefined && value !== null && !String(value).includes('\0'))
    .map(([key, value]) => `${key}=${value}`)
  const payload = Buffer.from(JSON.stringify({ commandLine: windowsCommandLine(execPath, args), cwd, env: variables })).toString('base64')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: SCRIPT,
    env: { ...process.env, COWART_LAUNCH: payload },
    timeout: LAUNCH_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8'
  })
  if (result.error) {
    onFailure(result.error.code === 'ETIMEDOUT' ? `PowerShell did not answer within ${LAUNCH_TIMEOUT_MS / 1000} s` : result.error.message)
    return null
  }
  const answer = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{')).at(-1)
  let made = null
  try {
    made = JSON.parse(answer)
  } catch {
    // No answer: said below.
  }
  if (made?.ret === 0 && made.pid > 0) return { pid: made.pid }
  onFailure(made?.error || (made ? `Win32_Process.Create returned ${made.ret}` : `no answer from PowerShell (exit ${result.status}): ${String(result.stderr ?? '').trim().slice(0, 300)}`))
  return null
}
