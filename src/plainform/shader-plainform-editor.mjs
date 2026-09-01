import { GRAPH_CATALOGS } from '../graphs/catalogs.mjs';
import { validateGraph } from '../graphs/index.mjs';
import { findShaderMaterialPreset } from './shader-material-presets.mjs';

const slug = value => String(value).trim().toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
const clean = value => value.trim().replace(/[.;]+$/u, '').trim();
const clone = value => structuredClone(value);
const fail = (code, message, details = {}) => { const error = new Error(message); error.name = 'ShaderPlainformError'; error.code = code; error.details = details; throw error; };

const TYPE_ALIASES = Object.freeze({
  'noise texture': 'blender.noiseTexture', noise: 'blender.noiseTexture',
  'value noise': 'noise.value', 'fractal noise': 'noise.fbm', color: 'constant.color', colour: 'constant.color', number: 'constant.float',
});

function resourceFor(project, value) {
  const query = clean(value); const normalized = slug(query);
  const resources = Object.values(project?.resources?.graphs ?? {});
  const matches = resources.filter(resource => resource.id === query || slug(resource.name) === normalized || slug(resource.id.split('/').at(-1)) === normalized);
  if (matches.length !== 1) fail(matches.length ? 'plainform_shader_edit_ambiguous' : 'plainform_shader_edit_missing', `Shader graph “${query}” must resolve to exactly one canonical graph.`);
  return matches[0];
}

function parseValue(source) {
  const color = source.match(/^#([0-9a-f]{6})$/iu);
  if (color) { const value = Number.parseInt(color[1], 16); return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1]; }
  const number = Number(source); if (Number.isFinite(number)) return number;
  fail('plainform_shader_edit_value', `Shader edit value “${source}” must be a finite number or #RRGGBB colour.`);
}

function port(definition, value, direction) {
  const ports = definition[direction]; const wanted = slug(value).replaceAll('-', '');
  const matches = Object.keys(ports).filter(name => slug(name).replaceAll('-', '') === wanted);
  if (matches.length !== 1) fail('plainform_shader_socket_unavailable', `${definition.type ?? 'Node'} has no unambiguous ${direction === 'inputs' ? 'input' : 'output'} “${value}”.`);
  return matches[0];
}

export function compileShaderPlainformEdit(source, { project, catalog = GRAPH_CATALOGS.shader } = {}) {
  if (!project) fail('plainform_project_required', 'Editing a shader graph requires the canonical project document.');
  const statements = source.split(/\r?\n/u).map(clean).filter(Boolean); const headerText = statements.shift();
  const inlineHeader = headerText.match(/^in (.+?),\s*(.+)$/iu);
  const header = headerText.match(/^edit (?:the )?(?:shader|material) graph (.+)$/iu) ?? (inlineHeader ? [inlineHeader[0], inlineHeader[1]] : headerText.match(/^in (.+?),?$/iu));
  if (!header) fail('plainform_shader_edit_header', 'Begin with “Edit shader graph <name or id>.”');
  if (inlineHeader) statements.unshift(clean(inlineHeader[2]));
  const resource = resourceFor(project, header[1]); const graph = clone(resource.graph);
  const priorPlainform = clone(resource.metadata?.plainform ?? {});
  const roles = { ...(priorPlainform.nodeRoles ?? {}) }; const owned = new Set(priorPlainform.ownedNodeIds ?? []);
  const exposed = [...(priorPlainform.exposedParameters ?? [])]; const interpretation = [`Edit shader graph ${resource.id} through a validated candidate.`];
  let requestedPreview = false;
  const nodeFor = (value) => {
    const query = clean(value); const roleId = roles[slug(query)];
    const matches = graph.nodes.filter(node => node.id === query || node.id === roleId || slug(node.id) === slug(query));
    if (matches.length !== 1) fail(matches.length ? 'plainform_shader_node_ambiguous' : 'plainform_shader_node_missing', `Shader node or semantic role “${query}” must resolve exactly once.`);
    return matches[0];
  };
  const definitionFor = node => catalog.nodes[node.type] ?? fail('plainform_shader_node_unavailable', `Node type ${node.type} is not in the shader catalog.`);

  for (const statement of statements) {
    if (/^(?:preview these changes|show me a preview)$/iu.test(statement)) { requestedPreview = true; continue; }
    const applyPreset = statement.match(/^apply preset (.+)$/iu);
    if (applyPreset) {
      const preset = findShaderMaterialPreset(applyPreset[1]);
      if (!preset) fail('plainform_shader_preset_missing', `No catalogued shader material preset matches “${applyPreset[1]}”.`);
      for (const sourceNode of preset.nodes) {
        if (graph.nodes.some(node => node.id === sourceNode.id)) fail('plainform_shader_node_exists', `Preset node ${sourceNode.id} already exists.`);
        graph.nodes.push({ id: sourceNode.id, type: sourceNode.type, params: clone(sourceNode.params), inputs: clone(sourceNode.inputs) });
        roles[slug(sourceNode.role)] = sourceNode.id; owned.add(sourceNode.id);
      }
      for (const sourceEdge of preset.edges) {
        const from = nodeFor(sourceEdge.fromRole); const to = nodeFor(sourceEdge.toRole);
        const fromPort = port(definitionFor(from), sourceEdge.fromPort, 'outputs'); const toPort = port(definitionFor(to), sourceEdge.toPort, 'inputs');
        graph.edges = graph.edges.filter(edge => !(edge.to.nodeId === to.id && edge.to.port === toPort));
        graph.edges.push({ from: { nodeId: from.id, port: fromPort }, to: { nodeId: to.id, port: toPort } });
      }
      for (const parameter of preset.exposedParameters) {
        const node = nodeFor(parameter.role); if (!exposed.some(item => slug(item.name) === slug(parameter.name))) exposed.push({ name: parameter.name, nodeId: node.id, input: parameter.input });
      }
      interpretation.push(`Apply catalogued ${preset.name} material preset.`); continue;
    }
    const narrower = statement.match(/^make (?:the )?(.+?) (\d+(?:\.\d+)?) percent narrower and expose (.+)$/iu);
    if (narrower) {
      const node = nodeFor(narrower[1]); const input = port(definitionFor(node), 'scale', 'inputs'); const fraction = Number(narrower[2]) / 100;
      if (!(fraction > 0 && fraction < 0.95)) fail('plainform_shader_edit_value', 'Narrower percentage must be above zero and below 95 percent.');
      const current = node.inputs?.[input] ?? definitionFor(node).inputs[input].default;
      if (!Number.isFinite(current)) fail('plainform_shader_edit_value', `${node.id}.${input} is not a scalar width control.`);
      node.inputs = { ...(node.inputs ?? {}), [input]: current / (1 - fraction) };
      const parameterName = clean(narrower[3]); if (!exposed.some(item => slug(item.name) === slug(parameterName))) exposed.push({ name: parameterName, nodeId: node.id, input });
      interpretation.push(`Make ${node.id} ${narrower[2]} percent narrower and expose ${parameterName}.`); continue;
    }
    const needleColor = statement.match(/^connect (.+?) to needle colou?r only,? not roughness$/iu);
    if (needleColor) {
      const from = nodeFor(needleColor[1]); const to = nodeFor('Principled Surface');
      const fromPort = port(definitionFor(from), 'color', 'outputs'); const colorPort = port(definitionFor(to), 'base color', 'inputs'); const roughnessPort = port(definitionFor(to), 'roughness', 'inputs');
      graph.edges = graph.edges.filter(edge => !((edge.to.nodeId === to.id && edge.to.port === colorPort) || (edge.from.nodeId === from.id && edge.to.nodeId === to.id && edge.to.port === roughnessPort)));
      graph.edges.push({ from: { nodeId: from.id, port: fromPort }, to: { nodeId: to.id, port: colorPort } });
      interpretation.push(`Connect ${from.id}.color only to needle color, explicitly excluding roughness.`); continue;
    }
    const insert = statement.match(/^insert (?:a |an )?(.+?) node with id ([a-z0-9][a-z0-9._/-]*) as (.+)$/iu);
    if (insert) {
      const type = TYPE_ALIASES[slug(insert[1]).replaceAll('-', ' ')] ?? insert[1];
      if (!catalog.nodes[type]) fail('plainform_shader_node_unavailable', `The shader catalog does not provide “${insert[1]}”.`);
      if (graph.nodes.some(node => node.id === insert[2])) fail('plainform_shader_node_exists', `Shader node ${insert[2]} already exists.`);
      graph.nodes.push({ id: insert[2], type, params: {} }); roles[slug(insert[3])] = insert[2]; owned.add(insert[2]);
      interpretation.push(`Insert owned ${type} node ${insert[2]} as ${insert[3]}.`); continue;
    }
    const connect = statement.match(/^connect (.+?) (\S+) to (.+?) (\S+?)(?: only,? not (\S+))?$/iu);
    if (connect) {
      const from = nodeFor(connect[1]); const to = nodeFor(connect[3]);
      const fromPort = port(definitionFor(from), connect[2], 'outputs'); const toPort = port(definitionFor(to), connect[4], 'inputs');
      graph.edges = graph.edges.filter(edge => !(edge.to.nodeId === to.id && edge.to.port === toPort));
      if (connect[5]) { const excluded = port(definitionFor(to), connect[5], 'inputs'); graph.edges = graph.edges.filter(edge => !(edge.from.nodeId === from.id && edge.to.nodeId === to.id && edge.to.port === excluded)); }
      graph.edges.push({ from: { nodeId: from.id, port: fromPort }, to: { nodeId: to.id, port: toPort } });
      interpretation.push(`Connect ${from.id}.${fromPort} to ${to.id}.${toPort}.`); continue;
    }
    const disconnect = statement.match(/^disconnect (.+?) from (.+?) (\S+)$/iu);
    if (disconnect) {
      const from = nodeFor(disconnect[1]); const to = nodeFor(disconnect[2]); const toPort = port(definitionFor(to), disconnect[3], 'inputs');
      const before = graph.edges.length; graph.edges = graph.edges.filter(edge => !(edge.from.nodeId === from.id && edge.to.nodeId === to.id && edge.to.port === toPort));
      if (graph.edges.length === before) fail('plainform_shader_edge_missing', `No matching connection from ${from.id} to ${to.id}.${toPort} exists.`);
      continue;
    }
    const set = statement.match(/^set (.+?) (\S+) to (.+)$/iu);
    if (set) {
      const node = nodeFor(set[1]); const input = port(definitionFor(node), set[2], 'inputs');
      node.inputs = { ...(node.inputs ?? {}), [input]: parseValue(set[3]) };
      graph.edges = graph.edges.filter(edge => !(edge.to.nodeId === node.id && edge.to.port === input));
      interpretation.push(`Set ${node.id}.${input} to a typed literal.`); continue;
    }
    const expose = statement.match(/^expose (.+?) (\S+) as (.+)$/iu);
    if (expose) {
      const node = nodeFor(expose[1]); const input = port(definitionFor(node), expose[2], 'inputs'); const name = clean(expose[3]);
      const prior = exposed.find(item => slug(item.name) === slug(name));
      if (prior && (prior.nodeId !== node.id || prior.input !== input)) fail('plainform_shader_exposure_conflict', `Exposed parameter “${name}” already targets another socket.`);
      if (!prior) exposed.push({ name, nodeId: node.id, input });
      continue;
    }
    const replace = statement.match(/^replace (.+?) with (?:a |an )?(.+?) node with id ([a-z0-9][a-z0-9._/-]*)$/iu);
    if (replace) {
      const old = nodeFor(replace[1]); if (!owned.has(old.id)) fail('plainform_shader_ownership_conflict', `Node ${old.id} is explicit user data and cannot be replaced by Plainform.`);
      const type = TYPE_ALIASES[slug(replace[2]).replaceAll('-', ' ')] ?? replace[2]; if (!catalog.nodes[type]) fail('plainform_shader_node_unavailable', `The shader catalog does not provide “${replace[2]}”.`);
      if (graph.nodes.some(node => node.id === replace[3] && node.id !== old.id)) fail('plainform_shader_node_exists', `Shader node ${replace[3]} already exists.`);
      graph.nodes[graph.nodes.indexOf(old)] = { id: replace[3], type, params: {} };
      graph.edges = graph.edges.map(edge => ({ from: { ...edge.from, ...(edge.from.nodeId === old.id ? { nodeId: replace[3] } : {}) }, to: { ...edge.to, ...(edge.to.nodeId === old.id ? { nodeId: replace[3] } : {}) } }));
      Object.keys(roles).forEach(role => { if (roles[role] === old.id) roles[role] = replace[3]; }); owned.delete(old.id); owned.add(replace[3]);
      continue;
    }
    const remove = statement.match(/^remove (.+?) if unused$/iu);
    if (remove) {
      const node = nodeFor(remove[1]); if (!owned.has(node.id)) fail('plainform_shader_ownership_conflict', `Node ${node.id} is explicit user data and cannot be removed by Plainform.`);
      if (graph.edges.some(edge => edge.from.nodeId === node.id || edge.to.nodeId === node.id) || Object.values(graph.outputs).some(output => output.nodeId === node.id)) fail('plainform_shader_node_in_use', `Node ${node.id} is still connected.`);
      graph.nodes.splice(graph.nodes.indexOf(node), 1); owned.delete(node.id); Object.keys(roles).forEach(role => { if (roles[role] === node.id) delete roles[role]; });
      continue;
    }
    fail('plainform_shader_edit_unsupported', `Shader edit Plainform does not understand “${statement}”.`);
  }
  const validation = validateGraph(graph);
  if (!validation.valid) fail('plainform_shader_graph_invalid', 'The edited shader candidate did not pass typed graph validation.', { errors: validation.errors });
  const metadata = { ...(resource.metadata ?? {}), plainform: { ...priorPlainform, nodeRoles: roles, ownedNodeIds: [...owned].sort(), exposedParameters: exposed.sort((a, b) => a.name.localeCompare(b.name)), lastEditSource: source } };
  return Object.freeze({
    language: 'plainform-v1', dialect: 'shader', requestedPreview,
    operations: Object.freeze([{ op: 'resource.patch', resourceType: 'graphs', resourceId: resource.id, patch: { graph: validation.graph, metadata } }]),
    interpretation: Object.freeze(interpretation), aliases: Object.freeze({}),
    shader: Object.freeze({ graphId: resource.id, edit: true, metrics: validation.metrics, exposedParameters: metadata.plainform.exposedParameters }),
  });
}
