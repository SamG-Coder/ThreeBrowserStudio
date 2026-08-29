import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '../core/errors.mjs';
import { MAX_PROJECT_PACK_BYTES } from '../core/project-pack.mjs';

const CHOOSER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
if ($env:THREE_STUDIO_DIALOG_MODE -eq 'save') {
  $dialog = New-Object System.Windows.Forms.SaveFileDialog
  $dialog.OverwritePrompt = $true
  $dialog.AddExtension = $true
  $dialog.DefaultExt = 'json'
  $dialog.FileName = [string]$env:THREE_STUDIO_DIALOG_NAME
  $dialog.Title = 'Export Studio project'
} else {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  $dialog.Title = 'Import Studio project'
}
$dialog.Filter = 'ThreeBrowser Studio (*.json)|*.json|All files (*.*)|*.*'
$dialog.FilterIndex = 1
$result = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  [Console]::Out.Write($dialog.FileName)
}
`;

function powershellPath(env = globalThis.process?.env ?? {}) {
  const root = String(env.SystemRoot ?? env.WINDIR ?? '').trim();
  return root
    ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
}

export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

export async function chooseNativeJsonPath({
  mode = 'open',
  fileName = '',
  spawn: spawnImpl = spawn,
  platform = globalThis.process?.platform,
  env = globalThis.process?.env ?? {},
} = {}) {
  if (platform !== 'win32') {
    throw new StudioError(
      'native_dialog_unsupported',
      'Desktop Import/Export uses a Windows file dialog.',
      { platform },
    );
  }
  const encoded = encodePowerShellCommand(CHOOSER_SCRIPT);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershellPath(env), [
      '-NoProfile',
      '-STA',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], {
      windowsHide: true,
      env: {
        ...env,
        THREE_STUDIO_DIALOG_MODE: mode === 'save' ? 'save' : 'open',
        THREE_STUDIO_DIALOG_NAME: String(fileName ?? ''),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => { stdout += chunk; });
    child.stderr?.on?.('data', chunk => { stderr += chunk; });
    child.on?.('error', reject);
    child.on?.('close', code => {
      const chosen = stdout.trim();
      if (chosen) {
        resolve(chosen);
        return;
      }
      if (code === 0) {
        resolve(null);
        return;
      }
      reject(new StudioError(
        'native_dialog_failed',
        stderr.trim() || `The file dialog exited with code ${code}.`,
        { code },
      ));
    });
  });
}

function packText(value) {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

export async function saveJsonWithNativeDialog(fileName, value, options = {}) {
  const chosen = await chooseNativeJsonPath({ ...options, mode: 'save', fileName });
  if (!chosen) return null;
  await (options.writeFile ?? writeFile)(chosen, packText(value), 'utf8');
  return { path: chosen, name: path.basename(chosen) };
}

export async function openJsonWithNativeDialog(options = {}) {
  const chosen = await chooseNativeJsonPath({ ...options, mode: 'open' });
  if (!chosen) return null;
  const info = await (options.stat ?? stat)(chosen);
  if (info.size > MAX_PROJECT_PACK_BYTES) {
    throw new StudioError('pack_too_large', `Project pack exceeds ${MAX_PROJECT_PACK_BYTES} bytes.`, {
      byteCount: info.size,
      maximum: MAX_PROJECT_PACK_BYTES,
    });
  }
  const text = await (options.readFile ?? readFile)(chosen, 'utf8');
  return {
    name: path.basename(chosen),
    size: info.size,
    text,
    path: chosen,
  };
}
