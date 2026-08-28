import path from 'node:path';
import { LiveBridgeClient, defaultSessionMarkerPath, readSessionMarker } from '../src/bridge/index.mjs';

const args = process.argv.slice(2);
let markerPath = defaultSessionMarkerPath();
const markerIndex = args.indexOf('--marker');
if (markerIndex >= 0) {
  markerPath = path.resolve(args[markerIndex + 1]);
  args.splice(markerIndex, 2);
}
const method = args.shift();
if (!method) throw new Error('Usage: npm run call -- <tool-name> [json-params] [--marker path]');
const marker = await readSessionMarker(markerPath);
let params = {};
if (args[0]) {
  params = JSON.parse(args.join(' '));
  if (params.sessionId === undefined) params.sessionId = marker.sessionId;
}
const client = new LiveBridgeClient(marker);
try {
  await client.connect();
  const result = await client.request(method, params);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
