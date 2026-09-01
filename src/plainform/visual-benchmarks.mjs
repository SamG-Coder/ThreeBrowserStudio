import { contentHash, createProjectDocument } from '../core/index.mjs';
import { PlainformCompiler } from './plainform-compiler.mjs';
import { parsePlainformProgram } from './plainform-front-end.mjs';

function baseProject(resources = {}, entities = []) {
  return createProjectDocument({
    projectId: 'project/plainform-benchmarks', resources: { materials: [{ id: 'material/leaf', recipe: { kind: 'physical', color: '#456b32' } }], ...resources },
    scenes: [{ id: 'scene/main', entities }],
  });
}

const BENCHMARKS = [
  {
    id: 'face-patch',
    source: `Design a face patch called Face Patch with id entity/face-patch.
Create a sphere called Head with id entity/head, with radius 10 centimetres.
Name the surface on Head around [0 metres, 0 metres, 10 centimetres] within 5 centimetres as cheek.
Subdivide the surface region cheek locally by 1 level, then relax it for 2 iterations with strength 40 percent.`,
    project: () => baseProject(), evidenceViews: [{ id: 'view/front', camera: 'front', semanticTargets: ['head', 'cheek'], hardGate: 'topology' }],
  },
  {
    id: 'eye-assembly',
    source: `Design a portrait called Eye Assembly with id entity/eye-assembly using the right-up-forward design frame.
Create a coordinated eye pair called Eyes with id entity/eyes, centred at [0 centimetres right, 3 centimetres up, 8 centimetres forward], separated by 7 centimetres, with eye width 3 centimetres, eye height 1.5 centimetres, and eye depth 1.8 centimetres, looking at [0 centimetres right, 3 centimetres up, 1 metre forward].`,
    project: () => baseProject(), evidenceViews: [{ id: 'view/gaze', camera: 'front-close', semanticTargets: ['eyes', 'gaze-target'], hardGate: 'identity' }],
  },
  {
    id: 'hair-groom',
    source: `Design a character called Hair Groom with id entity/hair-groom.
Create a sphere called Head with id entity/hair-head, with radius 10 centimetres.
Create a closed surface curve called scalp outline on Head through surface points nearest to design points [-8 centimetres, 5 centimetres, 10 centimetres], [8 centimetres, 5 centimetres, 10 centimetres], [8 centimetres, -5 centimetres, 10 centimetres], [-8 centimetres, -5 centimetres, 10 centimetres].
Name the surface enclosed by $scalp-outline as Scalp.
Groom short swept-back hair over Scalp using 24 guides, medium clumping, and seed 91; exclude the forehead and ears.`,
    project: () => baseProject(), evidenceViews: [{ id: 'view/groom', camera: 'three-quarter', semanticTargets: ['scalp'], hardGate: 'attachments' }],
  },
  {
    id: 'branch-collar',
    source: `Design a tree called Collar Study with id entity/collar-study.
Create a mature mountain pine named Collar Pine, 8 metres tall and about 30 years old.
Give it irregular whorled branches and seed 77.`,
    project: () => baseProject(), evidenceViews: [{ id: 'view/collar', camera: 'branch-close', semanticTargets: ['trunk', 'tier.01.branch.01'], hardGate: 'continuity' }],
  },
  {
    id: 'pine-tree',
    source: `Design a tree called Pine Benchmark with id entity/pine-benchmark.
Create a mature mountain pine named Mountain Pine, 12 metres tall and about 55 years old.
Give it irregular whorled branches and seed 914.
Place clusters of 9 centimetre pine needles along second- and third-order branches, denser near healthy tips and absent from deadwood.
Generate cylindrical bark coordinates along the trunk and branch hierarchy.`,
    project: () => baseProject(), evidenceViews: [{ id: 'view/pine-hero', camera: 'whole-tree', semanticTargets: ['trunk', 'crown'], hardGate: 'growth-budget' }],
  },
  {
    id: 'shader-edit',
    source: `Edit shader graph Rugged Bark.
Apply preset Rugged Bark.
Set Ridges scale to 10.
Expose Ridges scale as Ridge Width.`,
    project: () => baseProject({ graphs: [{
      id: 'graph/rugged-bark', kind: 'graph', name: 'Rugged Bark', metadata: { plainform: { kind: 'shader', nodeRoles: { 'principled-surface': 'principled-surface' }, ownedNodeIds: ['principled-surface'], exposedParameters: [] } },
      graph: { formatVersion: 1, id: 'graph/rugged-bark', domain: 'shader', nodes: [{ id: 'principled-surface', type: 'blender.principledBSDF', params: {} }], edges: [], outputs: { surface: { nodeId: 'principled-surface', port: 'surface' } } },
    }] }), evidenceViews: [{ id: 'view/material-ball', camera: 'material-ball', semanticTargets: ['ridges'], hardGate: 'graph-types' }],
  },
  {
    id: 'event-sheet',
    source: `For Player, when Left is held, move left at 5 metres per second.
When Player collides with Pine Trunk, stop horizontal movement.
When Player receives Chop with strength at least 3, add 1 to Damage and play the bark-hit animation. If Damage reaches 10, send Tree Fell once.`,
    project: () => baseProject({}, [{ id: 'entity/player', kind: 'gameObject', name: 'Player' }, { id: 'entity/pine-trunk', kind: 'gameObject', name: 'Pine Trunk' }]),
    evidenceViews: [{ id: 'view/event-sheet', camera: 'none', semanticTargets: ['row/001', 'row/002', 'row/003'], hardGate: 'execution-order' }],
  },
  {
    id: 'hero-composition',
    source: 'Frame the whole pine from slightly below at a 50 millimetre lens. Use late afternoon sun from camera left, soft blue sky fill, a dry grass ground, and enough depth of field to keep the trunk and crown sharp.',
    project: () => baseProject({ geometries: [{ id: 'geometry/trunk', recipe: { kind: 'cylinder', radius: 0.5, height: 8 } }, { id: 'geometry/crown', recipe: { kind: 'sphere', radius: 3 } }] }, [
      { id: 'entity/pine', kind: 'group', name: 'Pine', children: ['entity/pine/trunk', 'entity/pine/crown'] },
      { id: 'entity/pine/trunk', kind: 'mesh', name: 'Trunk', parentId: 'entity/pine', components: { mesh: { geometryId: 'geometry/trunk' } } },
      { id: 'entity/pine/crown', kind: 'mesh', name: 'Crown', parentId: 'entity/pine', transform: { position: [0, 7, 0] }, components: { mesh: { geometryId: 'geometry/crown' } } },
    ]), evidenceViews: [{ id: 'view/hero-16x9', camera: 'camera/composition/pine', aspect: 16 / 9, semanticTargets: ['pine', 'trunk', 'crown'], hardGate: 'composition' }],
  },
];

export const PLAINFORM_VISUAL_BENCHMARKS = Object.freeze(BENCHMARKS.map(value => Object.freeze({ ...value, evidenceViews: Object.freeze(value.evidenceViews.map(Object.freeze)) })));

function collectIds(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach(item => collectIds(item, output));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if ((key === 'id' || key.endsWith('Id')) && typeof child === 'string' && /^[a-z0-9][a-z0-9._/-]*$/u.test(child)) output.add(child);
    collectIds(child, output);
  }
  return output;
}

function metrics(compiled) {
  const resources = compiled.operations.flatMap(operation => operation.op === 'resource.createMany' ? operation.items.map(item => item.resource) : operation.op === 'resource.create' ? [operation.resource] : []);
  const entities = compiled.operations.flatMap(operation => operation.op === 'entity.createMany' ? operation.items.map(item => item.entity) : operation.op === 'entity.create' ? [operation.entity] : []);
  const graphNodes = resources.reduce((sum, resource) => sum + (resource.graph?.nodes?.length ?? 0), 0) + compiled.operations.reduce((sum, operation) => sum + (operation.patch?.graph?.nodes?.length ?? 0), 0);
  const estimatedTriangles = resources.reduce((sum, resource) => {
    const recipe = resource.recipe; if (!recipe) return sum;
    if (recipe.kind === 'indexedMesh') return sum + (recipe.indices?.length ?? 0) / 3;
    if (recipe.kind === 'tube') return sum + (recipe.tubularSegments ?? 64) * (recipe.radialSegments ?? 8) * 2;
    return sum;
  }, 0);
  return { operationCount: compiled.operations.length, resourceCount: resources.length, entityCount: entities.length, graphNodeCount: graphNodes, estimatedTriangles };
}

export function runPlainformVisualBenchmark(benchmark) {
  const project = benchmark.project(); const ast = parsePlainformProgram(benchmark.source); const compiled = new PlainformCompiler().compile(benchmark.source, { project });
  const allSemanticIds = [...collectIds(compiled.operations)].sort();
  const dependencyIds = allSemanticIds.filter(id => /^(?:geometry|material|graph|blueprint|asset|animation|event)\//u.test(id));
  const dependencyKinds = Object.fromEntries([...new Set(dependencyIds.map(id => id.split('/')[0]))].sort().map(kind => [kind, dependencyIds.filter(id => id.startsWith(`${kind}/`)).length]));
  const semanticIds = allSemanticIds.filter(id => id.split('/').length <= 3 && !id.includes('.foliage.')).slice(0, 8);
  const dependencyGraph = Object.freeze({ nodes: dependencyIds.slice(0, 6).map(id => ({ id, kind: id.split('/')[0] })), kinds: dependencyKinds, hash: contentHash(dependencyIds) });
  return Object.freeze({
    id: benchmark.id,
    ast: ast.statements.map(statement => ({ kind: statement.kind, semanticKey: statement.semanticKey })),
    dependencyGraph, metrics: metrics(compiled), semanticIds,
    semanticIdentityHash: contentHash(allSemanticIds), operationHash: contentHash(compiled.operations), evidenceViews: benchmark.evidenceViews,
  });
}
