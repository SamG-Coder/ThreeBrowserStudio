param(
  [Parameter(Mandatory = $true)]
  [int]$TargetPid,
  [ValidateRange(5, 180)]
  [int]$DurationSeconds = 28,
  [string]$OutputDirectory = 'C:\example Videos'
)

$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$obsScript = Join-Path $PSScriptRoot 'obs-showcase.mjs'
$studioCall = Join-Path $PSScriptRoot 'studio-call.mjs'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ThreeBrowserRecordingWindow {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Invoke-NodeJson([string[]]$Arguments) {
  $text = & node @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($text -join [Environment]::NewLine) }
  return ($text -join [Environment]::NewLine) | ConvertFrom-Json
}

function Get-TargetProcess {
  $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $process -or $process.HasExited -or $process.MainWindowHandle -eq [IntPtr]::Zero) { return $null }
  return $process
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) {
  throw "Recording directory does not exist: $outputRoot"
}

$target = Get-TargetProcess
if (-not $target) { throw "ThreeBrowser target process $TargetPid has no live window." }
$windowHandle = $target.MainWindowHandle
[void][ThreeBrowserRecordingWindow]::ShowWindowAsync($windowHandle, 3)
[void][ThreeBrowserRecordingWindow]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 900
if (-not [ThreeBrowserRecordingWindow]::IsZoomed($windowHandle)) {
  throw 'ThreeBrowser window did not maximize; recording was not started.'
}

$windowSelector = "$($target.MainWindowTitle):ThreeBrowser.WebGPU:$([IO.Path]::GetFileName($target.Path))"
$setup = Invoke-NodeJson @($obsScript, 'setup', '--output', $outputRoot, '--window', $windowSelector)
if (-not $setup.success) { throw 'OBS setup did not complete.' }

$status = Invoke-NodeJson @($studioCall, 'three_studio_status')
$playParams = @{
  action = 'enter'
  projectId = $status.projectId
  baseRevision = $status.revision
  idempotencyKey = "record-rainy-window-$([Guid]::NewGuid())"
  label = 'Restart showcase animation for guarded OBS recording'
} | ConvertTo-Json -Compress

$recordStarted = $false
$cancelled = $false
$cancelReason = $null
$outputPath = $null
try {
  $started = Invoke-NodeJson @($obsScript, 'start')
  if (-not $started.recording) { throw 'OBS did not start recording.' }
  $recordStarted = $true
  [void](Invoke-NodeJson @($studioCall, 'three_studio_play', $playParams))

  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt $DurationSeconds) {
    Start-Sleep -Milliseconds 200
    $current = Get-TargetProcess
    if (-not $current -or $current.MainWindowHandle -ne $windowHandle -or -not [ThreeBrowserRecordingWindow]::IsWindow($windowHandle)) {
      $cancelled = $true
      $cancelReason = 'ThreeBrowser window closed or was replaced during recording.'
      break
    }
    if (-not [ThreeBrowserRecordingWindow]::IsZoomed($windowHandle)) {
      $cancelled = $true
      $cancelReason = 'ThreeBrowser window stopped being maximized during recording.'
      break
    }
  }
} finally {
  if ($recordStarted) {
    $stopped = Invoke-NodeJson @($obsScript, 'stop')
    $outputPath = [IO.Path]::GetFullPath([string]$stopped.outputPath)
  }
}

if (-not $outputPath -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw 'OBS stopped without producing a recording file.'
}

if ($cancelled) {
  $allowedPrefix = $outputRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $outputPath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove cancelled recording outside the dedicated directory: $outputPath"
  }
  Remove-Item -LiteralPath $outputPath -Force
  [pscustomobject]@{ Success = $false; Cancelled = $true; Reason = $cancelReason; Removed = $outputPath } | ConvertTo-Json -Compress
  exit 2
}

$file = Get-Item -LiteralPath $outputPath
[pscustomobject]@{
  Success = $true
  Cancelled = $false
  OutputPath = $file.FullName
  Bytes = $file.Length
  DurationSeconds = $DurationSeconds
  Profile = $setup.profile
  Scene = $setup.scene
  Width = $setup.video.width
  Height = $setup.video.height
  Fps = $setup.video.fps
} | ConvertTo-Json -Compress
