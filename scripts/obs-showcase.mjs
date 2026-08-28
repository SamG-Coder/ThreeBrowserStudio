import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const OBS_EXE = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';
const OBS_CONFIG = path.join(os.homedir(), 'AppData', 'Roaming', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
const PROFILE_NAME = 'ThreeBrowser Showcase';
const COLLECTION_NAME = 'ThreeBrowser Showcase';
const SCENE_NAME = 'ThreeBrowser Showcase';
const INPUT_NAME = 'ThreeBrowser Window Capture';
const LEGACY_INPUT_NAME = 'ThreeBrowser Game Capture';
const DEFAULT_WINDOW = 'ThreeBrowser WebGPU:ThreeBrowser.WebGPU:node.exe';
const DEFAULT_OUTPUT = 'C:\\example Videos';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = value => createHash('sha256').update(value).digest();

export function createObsAuthentication(password, salt, challenge) {
  const secret = sha256(`${password}${salt}`).toString('base64');
  return sha256(`${secret}${challenge}`).toString('base64');
}

class ObsWebSocketClient {
  #socket;
  #pending = new Map();
  #identified;
  #identifyResolve;
  #identifyReject;

  constructor(socket, password) {
    this.#socket = socket;
    this.#identified = new Promise((resolve, reject) => {
      this.#identifyResolve = resolve;
      this.#identifyReject = reject;
    });
    socket.addEventListener('message', async event => {
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : Buffer.from(await event.data.arrayBuffer?.() ?? event.data).toString('utf8');
        const message = JSON.parse(raw);
        if (message.op === 0) {
          const authentication = message.d.authentication
            ? createObsAuthentication(password, message.d.authentication.salt, message.d.authentication.challenge)
            : undefined;
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(authentication ? { authentication } : {}) } }));
          return;
        }
        if (message.op === 2) {
          this.#identifyResolve(message.d);
          return;
        }
        if (message.op === 7) {
          const pending = this.#pending.get(message.d.requestId);
          if (!pending) return;
          this.#pending.delete(message.d.requestId);
          const status = message.d.requestStatus;
          if (status.result) pending.resolve(message.d.responseData ?? {});
          else pending.reject(new Error(`${pending.type} failed (${status.code}): ${status.comment ?? 'OBS rejected the request.'}`));
        }
      } catch (error) {
        this.#identifyReject(error);
      }
    });
    socket.addEventListener('error', () => this.#identifyReject(new Error('OBS WebSocket connection failed.')));
    socket.addEventListener('close', () => {
      const error = new Error('OBS WebSocket connection closed.');
      this.#identifyReject(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  async identify(timeoutMilliseconds = 8_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OBS WebSocket identification timed out.')), timeoutMilliseconds);
      timeout.unref?.();
      this.#identified.then(
        value => { clearTimeout(timeout); resolve(value); },
        error => { clearTimeout(timeout); reject(error); },
      );
    });
  }

  request(requestType, requestData = {}, timeoutMilliseconds = 10_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${requestType} timed out.`));
      }, timeoutMilliseconds);
      this.#pending.set(requestId, {
        type: requestType,
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      this.#socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() {
    this.#socket.close();
  }
}

async function readObsConnection() {
  const config = JSON.parse(await readFile(OBS_CONFIG, 'utf8'));
  return {
    port: Number(config.server_port ?? 4455),
    password: String(config.server_password ?? ''),
  };
}

async function connectOnce(connection) {
  const socket = new WebSocket(`ws://127.0.0.1:${connection.port}`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OBS WebSocket open timed out.')), 1_500);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('OBS WebSocket is unavailable.')); }, { once: true });
  });
  const client = new ObsWebSocketClient(socket, connection.password);
  await client.identify();
  return client;
}

async function launchObs() {
  await access(OBS_EXE);
  const child = spawn(OBS_EXE, ['--disable-shutdown-check', '--minimize-to-tray'], {
    cwd: path.dirname(OBS_EXE),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function connectObs({ launch = true } = {}) {
  const connection = await readObsConnection();
  try {
    return await connectOnce(connection);
  } catch (firstError) {
    if (!launch) throw firstError;
  }
  await launchObs();
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    try {
      return await connectOnce(connection);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('OBS did not become ready.');
}

export const collectObsNames = (values, field) => new Set((values ?? []).map(value => (
  typeof value === 'string' ? value : value?.[field]
)).filter(Boolean));

async function requestOptional(client, requestType, requestData) {
  try {
    return await client.request(requestType, requestData);
  } catch (error) {
    if (!/unknown request type|204|invalid request type/i.test(error.message)) throw error;
    return null;
  }
}

async function waitForObsFrontend(client) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await client.request('GetRecordStatus');
    } catch (error) {
      lastError = error;
      if (!/\(207\)|not ready/i.test(error.message)) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error('OBS frontend did not become ready.');
}

export function sanitizeRecordingName(value = 'ThreeBrowser-Showcase') {
  const normalized = String(value)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'ThreeBrowser-Showcase';
}

async function ensureProfile(client, outputDirectory, recordingName) {
  let profiles = await client.request('GetProfileList');
  if (!collectObsNames(profiles.profiles, 'profileName').has(PROFILE_NAME)) {
    await client.request('CreateProfile', { profileName: PROFILE_NAME });
    profiles = await client.request('GetProfileList');
  }
  if (profiles.currentProfileName !== PROFILE_NAME) {
    await client.request('SetCurrentProfile', { profileName: PROFILE_NAME });
  }

  const profileParameters = [
    ['Output', 'Mode', 'Simple'],
    ['Output', 'FilenameFormatting', `${sanitizeRecordingName(recordingName)}-%CCYY-%MM-%DD-%hh-%mm-%ss`],
    ['SimpleOutput', 'FilePath', outputDirectory],
    ['SimpleOutput', 'RecFormat2', 'mkv'],
    ['SimpleOutput', 'RecQuality', 'Small'],
    ['SimpleOutput', 'RecEncoder', 'x264'],
    ['SimpleOutput', 'RecTracks', '1'],
  ];
  for (const [parameterCategory, parameterName, parameterValue] of profileParameters) {
    await requestOptional(client, 'SetProfileParameter', { parameterCategory, parameterName, parameterValue });
  }
  await client.request('SetRecordDirectory', { recordDirectory: outputDirectory });
  await client.request('SetVideoSettings', {
    baseWidth: 2560,
    baseHeight: 1440,
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1,
  });
}

async function ensureScene(client, windowName) {
  let collections = await client.request('GetSceneCollectionList');
  if (!collectObsNames(collections.sceneCollections, 'sceneCollectionName').has(COLLECTION_NAME)) {
    await client.request('CreateSceneCollection', { sceneCollectionName: COLLECTION_NAME });
  } else if (collections.currentSceneCollectionName !== COLLECTION_NAME) {
    await client.request('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION_NAME });
  }

  let sceneList = await client.request('GetSceneList');
  if (!collectObsNames(sceneList.scenes, 'sceneName').has(SCENE_NAME)) {
    await client.request('CreateScene', { sceneName: SCENE_NAME });
  }

  let inputList = await client.request('GetInputList');
  const legacyInput = (inputList.inputs ?? []).find(input => input.inputName === LEGACY_INPUT_NAME);
  if (legacyInput) {
    await client.request('RemoveInput', { inputName: LEGACY_INPUT_NAME });
    inputList = await client.request('GetInputList');
  }

  const existingInput = (inputList.inputs ?? []).find(input => input.inputName === INPUT_NAME);
  if (existingInput && existingInput.inputKind !== 'window_capture') {
    await client.request('RemoveInput', { inputName: INPUT_NAME });
    inputList = await client.request('GetInputList');
  }

  if (!collectObsNames(inputList.inputs, 'inputName').has(INPUT_NAME)) {
    await client.request('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: INPUT_NAME,
      inputKind: 'window_capture',
      inputSettings: {
        window: windowName,
        method: 2,
        capture_cursor: false,
        client_area: true,
      },
      sceneItemEnabled: true,
    });
  } else {
    await client.request('SetInputSettings', {
      inputName: INPUT_NAME,
      inputSettings: {
        window: windowName,
        method: 2,
        capture_cursor: false,
        client_area: true,
      },
      overlay: true,
    });
  }

  const { sceneItemId } = await client.request('GetSceneItemId', { sceneName: SCENE_NAME, sourceName: INPUT_NAME });
  await client.request('SetSceneItemEnabled', { sceneName: SCENE_NAME, sceneItemId, sceneItemEnabled: true });
  await client.request('SetSceneItemTransform', {
    sceneName: SCENE_NAME,
    sceneItemId,
    sceneItemTransform: {
      positionX: 0,
      positionY: 35,
      alignment: 5,
      scaleX: 1.0007812976837158,
      scaleY: 1.0007305145263672,
    },
  });
  await client.request('SetCurrentProgramScene', { sceneName: SCENE_NAME });

  const refreshedInputs = await client.request('GetInputList');
  for (const input of refreshedInputs.inputs ?? []) {
    if (input.inputName === INPUT_NAME) continue;
    if (/audio|capture/i.test(input.inputKind) && input.inputName !== INPUT_NAME) {
      await requestOptional(client, 'SetInputMute', { inputName: input.inputName, inputMuted: true });
    }
  }
  return sceneItemId;
}

async function setup({ outputDirectory, windowName, recordingName }) {
  const client = await connectObs();
  try {
    const record = await waitForObsFrontend(client);
    if (record.outputActive) throw new Error('OBS is already recording; refusing to change its profile or scene.');
    await ensureProfile(client, outputDirectory, recordingName);
    const sceneItemId = await ensureScene(client, windowName);
    let sourceState = { videoActive: false, videoShowing: false };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      sourceState = await client.request('GetSourceActive', { sourceName: INPUT_NAME });
      if (sourceState.videoActive && sourceState.videoShowing) break;
      await delay(250);
    }
    if (!sourceState.videoActive || !sourceState.videoShowing) {
      throw new Error('OBS Window Capture did not become active for the ThreeBrowser window.');
    }
    const preview = await client.request('GetSourceScreenshot', {
      sourceName: INPUT_NAME,
      imageFormat: 'png',
      imageWidth: 640,
      imageHeight: 342,
      imageCompressionQuality: 50,
    });
    if (typeof preview.imageData !== 'string' || preview.imageData.length < 1_000) {
      throw new Error('OBS could not read a preview frame from ThreeBrowser Window Capture.');
    }
    const version = await client.request('GetVersion');
    const directory = await client.request('GetRecordDirectory');
    return {
      success: true,
      obsVersion: version.obsVersion,
      profile: PROFILE_NAME,
      collection: COLLECTION_NAME,
      scene: SCENE_NAME,
      input: INPUT_NAME,
      sceneItemId,
      recordDirectory: directory.recordDirectory,
      video: { width: 1920, height: 1080, fps: 60 },
      audioMuted: true,
      sourceActive: true,
      previewBytes: Buffer.byteLength(preview.imageData, 'utf8'),
    };
  } finally {
    client.close();
  }
}

async function start() {
  const client = await connectObs({ launch: false });
  try {
    const current = await client.request('GetRecordStatus');
    if (current.outputActive) throw new Error('OBS is already recording.');
    await client.request('StartRecord');
    let status = { outputActive: false };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await client.request('GetRecordStatus');
      if (status.outputActive) break;
      await delay(100);
    }
    if (!status.outputActive) throw new Error('OBS did not enter recording state.');
    return { success: true, recording: true, outputTimecode: status.outputTimecode };
  } finally {
    client.close();
  }
}

async function stop() {
  const client = await connectObs({ launch: false });
  try {
    const current = await client.request('GetRecordStatus');
    if (!current.outputActive) throw new Error('OBS is not recording.');
    const result = await client.request('StopRecord');
    return { success: true, recording: false, outputPath: result.outputPath };
  } finally {
    client.close();
  }
}

async function status() {
  const client = await connectObs({ launch: false });
  try {
    const record = await client.request('GetRecordStatus');
    const scene = await client.request('GetCurrentProgramScene');
    const profile = await client.request('GetProfileList');
    const collection = await client.request('GetSceneCollectionList');
    return {
      success: true,
      recording: record.outputActive,
      profile: profile.currentProfileName,
      collection: collection.currentSceneCollectionName,
      scene: scene.currentProgramSceneName,
    };
  } finally {
    client.close();
  }
}

async function preview(filePath) {
  if (!filePath) throw new Error('preview requires --file <png-path>.');
  const client = await connectObs({ launch: false });
  try {
    const sourceState = await client.request('GetSourceActive', { sourceName: INPUT_NAME });
    if (!sourceState.videoActive || !sourceState.videoShowing) throw new Error('ThreeBrowser Window Capture is not active.');
    const result = await client.request('GetSourceScreenshot', {
      sourceName: INPUT_NAME,
      imageFormat: 'png',
      imageWidth: 1280,
      imageHeight: 685,
      imageCompressionQuality: 100,
    });
    const match = /^data:image\/png;base64,(.+)$/s.exec(result.imageData ?? '');
    if (!match) throw new Error('OBS returned an invalid PNG preview.');
    const bytes = Buffer.from(match[1], 'base64');
    await writeFile(filePath, bytes);
    return { success: true, filePath, bytes: bytes.length, sourceActive: true };
  } finally {
    client.close();
  }
}

function parseArguments(argv) {
  const values = {
    command: argv[0] ?? 'status',
    outputDirectory: DEFAULT_OUTPUT,
    windowName: DEFAULT_WINDOW,
    recordingName: 'ThreeBrowser-Showcase',
    filePath: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--output') values.outputDirectory = path.resolve(argv[++index]);
    else if (argv[index] === '--window') values.windowName = argv[++index];
    else if (argv[index] === '--name') values.recordingName = sanitizeRecordingName(argv[++index]);
    else if (argv[index] === '--file') values.filePath = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return values;
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  try {
    const options = parseArguments(process.argv.slice(2));
    let result;
    if (options.command === 'setup') result = await setup(options);
    else if (options.command === 'start') result = await start();
    else if (options.command === 'stop') result = await stop();
    else if (options.command === 'status') result = await status();
    else if (options.command === 'preview') result = await preview(options.filePath);
    else throw new Error(`Unknown command: ${options.command}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
