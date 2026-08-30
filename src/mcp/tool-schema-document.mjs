function cloneWithRootedRefs(value, toolName) {
  if (Array.isArray(value)) return value.map(item => cloneWithRootedRefs(item, toolName));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === '$id') continue;
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')) {
      result[key] = `#/$defs/toolSchemas/${toolName}/$defs/${child.slice('#/$defs/'.length)}`;
    } else result[key] = cloneWithRootedRefs(child, toolName);
  }
  return result;
}

/** Builds the checked-in aggregate schema exclusively from the registered tool schemas. */
export function buildToolSchemaDocument({ protocolVersion, toolNames, inputSchemas }) {
  const names = [...toolNames];
  const toolSchemas = Object.fromEntries(names.map(name => [
    name,
    cloneWithRootedRefs(inputSchemas[name], name),
  ]));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://threebrowser.local/schemas/tools-v1.schema.json',
    title: 'ThreeBrowser Studio MCP tool inputs',
    description: `Generated from the live ${protocolVersion} tool schemas. Do not edit by hand.`,
    type: 'object',
    additionalProperties: false,
    required: ['protocolVersion', 'tools'],
    properties: {
      protocolVersion: { const: protocolVersion },
      tools: {
        type: 'object',
        additionalProperties: false,
        required: names,
        properties: Object.fromEntries(names.map(name => [
          name,
          { $ref: `#/$defs/toolSchemas/${name}` },
        ])),
      },
    },
    $defs: { toolSchemas },
  };
}

