import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../src/bridge/protocol.mjs';
import {
  STUDIO_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
} from '../src/mcp/tool-schemas.mjs';
import { buildToolSchemaDocument } from '../src/mcp/tool-schema-document.mjs';

const document = buildToolSchemaDocument({
  protocolVersion: PROTOCOL_VERSION,
  toolNames: STUDIO_TOOL_NAMES,
  inputSchemas: TOOL_INPUT_SCHEMAS,
});
const destination = fileURLToPath(new URL('../schemas/tools-v1.schema.json', import.meta.url));
await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`Generated ${destination}`);

