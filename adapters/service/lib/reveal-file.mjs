// 在资源管理器中显示 (the canvas context menu): opens the folder of a canvas file in the
// system's file manager with the file selected. The service runs on the user's machine for
// every host, so Claude Code, ZCode and Codex pages all get it. The page names the card's
// asset URL, never a path, and only files inside the canvas are shown.
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { localPathForAssetSrc } from '../../shared/canvas-model.mjs'

export const REVEAL_FILE_TOOL = 'reveal_cowart_file'

export async function revealCanvasFile({ canvasDir, assetUrl }) {
  const filePath = localPathForAssetSrc(canvasDir, String(assetUrl || '').split(/[?#]/)[0])
  if (!filePath || !isInside(canvasDir, filePath)) throw new Error('这张卡片不是画布上的本地文件。')
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) throw new Error(`画布上找不到这个文件了：${filePath}`)
  // Checks look at the path without opening windows.
  if (process.env.COWART_REVEAL_DRY_RUN !== '1') openInFileManager(filePath)
  return { filePath }
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path)
}

// Windows: a window that a background process (this service) opens stays behind the app the
// user clicked in, since Windows blocks focus stealing, and Explorer's /select started from
// the service left the file unselected. So a hidden PowerShell script reuses the folder's
// Explorer window if one is open (else opens one), selects the file through the shell's COM
// objects, and brings the window to the front by joining the foreground thread's input. The
// path comes in through the environment, so nothing needs quoting. It targets Windows
// PowerShell 5.1, which every Windows has (its Split-Path cannot take -Leaf with -LiteralPath).
const WINDOWS_REVEAL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$path = $env:COWART_REVEAL_PATH
$folder = [IO.Path]::GetDirectoryName($path)
$name = [IO.Path]::GetFileName($path)
$shell = New-Object -ComObject Shell.Application
function Find-FolderWindow {
  foreach ($window in @($shell.Windows())) {
    try { if ($window.Document.Folder.Self.Path -eq $folder) { return $window } } catch {}
  }
}
$window = Find-FolderWindow
if (-not $window) {
  Start-Process explorer.exe -ArgumentList ('/select,"' + $path + '"')
  for ($i = 0; $i -lt 50 -and -not $window; $i++) { Start-Sleep -Milliseconds 100; $window = Find-FolderWindow }
}
if (-not $window) { exit }
$item = $window.Document.Folder.ParseName($name)
# Select it alone, scrolled into view and focused.
if ($item) { $window.Document.SelectItem($item, 29) }
Add-Type -Namespace Cowart -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
$hwnd = [IntPtr]$window.HWND
if ([Cowart.Win32]::IsIconic($hwnd)) { [void][Cowart.Win32]::ShowWindow($hwnd, 9) }
$foreground = [Cowart.Win32]::GetWindowThreadProcessId([Cowart.Win32]::GetForegroundWindow(), [IntPtr]::Zero)
$self = [Cowart.Win32]::GetCurrentThreadId()
$attached = [Cowart.Win32]::AttachThreadInput($self, $foreground, $true)
[void][Cowart.Win32]::SetForegroundWindow($hwnd)
[void][Cowart.Win32]::BringWindowToTop($hwnd)
if ($attached) { [void][Cowart.Win32]::AttachThreadInput($self, $foreground, $false) }
`

// macOS selects the file in Finder; Linux file managers have no common way to select a
// file, so its folder opens.
function openInFileManager(filePath) {
  const [command, args, env] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_REVEAL_SCRIPT, 'utf16le').toString('base64')], { ...process.env, COWART_REVEAL_PATH: filePath }]
      : process.platform === 'darwin'
        ? ['open', ['-R', filePath], process.env]
        : ['xdg-open', [dirname(filePath)], process.env]
  const child = spawn(command, args, { env, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}
