import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Windows folder launcher is portable, guarded, and failure-visible', async () => {
  const source = await readFile(path.join(root, 'Launch ThreeBrowser Studio.cmd'), 'utf8');
  const attributes = await readFile(path.join(root, '.gitattributes'), 'utf8');

  assert.match(source, /pushd "%~dp0"/i);
  assert.match(source, /process\.versions\.node/);
  assert.match(source, />= 24/);
  assert.match(source, /call npm ci/i);
  assert.match(source, /node "scripts\\launch\.mjs" %\*/i);
  assert.match(source, /if not "%EXIT_CODE%"=="0"/i);
  assert.match(source, /pause/i);
  assert.doesNotMatch(source, /[A-Z]:\\/);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);
});

test('Windows release exe finds Node 24 or offers an official download', async () => {
  const source = await readFile(path.join(root, 'packaging', 'win-launcher', 'Launcher.cs'), 'utf8');
  const project = await readFile(path.join(root, 'packaging', 'win-launcher', 'ThreeBrowserStudio.Launcher.csproj'), 'utf8');
  assert.match(source, /nodejs\.org\/dist/);
  assert.match(source, /SHASUMS256/);
  assert.match(source, /MinimumNodeMajor = 24/);
  assert.match(source, /THREE_STUDIO_NODE/);
  assert.match(source, /THREE_STUDIO_DOWNLOAD_NODE/);
  assert.match(source, /%LOCALAPPDATA%/);
  assert.doesNotMatch(source, /Bundled Node\.js is missing/);
  assert.doesNotMatch(source, /[A-Z]:\\Users\\/);
  assert.match(project, /<TargetFramework>net10\.0<\/TargetFramework>/);
  assert.match(project, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
  assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(project, /<PublishTrimmed>true<\/PublishTrimmed>/);
  assert.match(project, /<SelfContained>true<\/SelfContained>/);
});

test('package exposes a short terminal start alias', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node scripts/launch.mjs');
  assert.equal(packageJson.scripts.launch, 'node scripts/launch.mjs');
  assert.equal(packageJson.scripts['release:pack'], 'node scripts/package-release.mjs');
  const packager = await readFile(path.join(root, 'scripts', 'package-release.mjs'), 'utf8');
  assert.match(packager, /withNode: false/);
  assert.match(packager, /--with-node/);
  assert.match(packager, /dotnet/);
  assert.match(packager, /PublishSingleFile/);
  assert.match(packager, /PublishTrimmed/);
});
