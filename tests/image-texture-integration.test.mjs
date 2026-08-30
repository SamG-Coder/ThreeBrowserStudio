import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AuthoringKernel,
  assertMaterialTextureControls,
  buildProjectIndex,
  createProjectDocument,
  createResourceDocument,
  validateProjectDocument,
} from '../src/core/index.mjs';
import { DATA_TEXTURE_LIMITS } from '../src/core/image-texture.mjs';

function texture(id, colorSpace = 'srgb', overrides = {}) {
  return {
    id,
    kind: 'dataTexture',
    width: 1,
    height: 1,
    channels: 4,
    pixels: [64, 128, 192, 255],
    colorSpace,
    ...overrides,
  };
}

function sampledGraph(id, textureId, colorSpace = 'srgb') {
  return {
    id,
    kind: 'graph',
    graph: {
      formatVersion: 1,
      id,
      domain: 'shader',
      nodes: [
        { id: 'uv', type: 'input.uv', params: {} },
        { id: 'sample', type: 'texture.sample2d', params: { textureId, colorSpace } },
      ],
      edges: [{
        from: { nodeId: 'uv', port: 'uv' },
        to: { nodeId: 'sample', port: 'uv' },
      }],
      outputs: { baseColor: { nodeId: 'sample', port: 'color' } },
    },
  };
}

function blenderImageGraph(id, textureId, colorSpace = 'srgb') {
  return {
    id,
    kind: 'graph',
    graph: {
      formatVersion: 1,
      id,
      domain: 'shader',
      nodes: [{
        id: 'sample',
        type: 'ShaderNodeTexImage',
        params: {
          textureId,
          colorSpace,
          projection: 'FLAT',
          interpolation: 'LINEAR',
          extension: 'EXTEND',
        },
      }],
      edges: [],
      outputs: { baseColor: { nodeId: 'sample', port: 'Color' } },
    },
  };
}

function constantColorGraph(id, output = 'baseColor') {
  return {
    id,
    kind: 'graph',
    graph: {
      formatVersion: 1,
      id,
      domain: 'shader',
      nodes: [{ id: 'color', type: 'constant.color', params: { value: [0.2, 0.4, 0.6] } }],
      edges: [],
      outputs: { [output]: { nodeId: 'color', port: 'value' } },
    },
  };
}

function request(projectId, baseRevision, idempotencyKey, operations) {
  return {
    protocolVersion: 'three-studio/1',
    projectId,
    baseRevision,
    idempotencyKey,
    label: 'Author bounded image textures',
    operations,
  };
}

test('direct, parameters, and nested data textures canonicalize into one typed envelope', () => {
  const direct = createResourceDocument('texture', {
    ...texture('texture/direct'),
    name: 'Direct albedo',
  });
  const parameters = createResourceDocument('textures', {
    id: 'texture/parameters',
    name: 'Parameter albedo',
    parameters: {
      kind: 'dataTexture', width: 1, height: 1, channels: 4, pixels: [64, 128, 192, 255], colorSpace: 'srgb',
    },
  });
  const nested = createResourceDocument('textures', {
    id: 'texture/nested',
    name: 'Nested albedo',
    recipe: {
      kind: 'dataTexture', width: 1, height: 1, channels: 4, pixels: [64, 128, 192, 255], colorSpace: 'srgb',
    },
  });

  assert.equal(direct.kind, 'texture');
  assert.equal(direct.name, 'Direct albedo');
  assert.equal(direct.width, undefined);
  assert.equal(direct.pixels, undefined);
  assert.deepEqual(direct.recipe, {
    kind: 'dataTexture',
    name: 'Direct albedo',
    width: 1,
    height: 1,
    channels: 4,
    pixels: [64, 128, 192, 255],
    colorSpace: 'srgb',
    wrapS: 'clamp',
    wrapT: 'clamp',
    minFilter: 'linearMipmapLinear',
    magFilter: 'linear',
    anisotropy: 4,
    flipY: false,
    generateMipmaps: true,
  });
  assert.equal(parameters.parameters, undefined);
  assert.deepEqual(parameters.recipe, nested.recipe);
  assert.equal(parameters.recipe.name, undefined);
});

test('checked project schema keeps root live-raster discriminators out of the legacy texture branch', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../schemas/project-v1.schema.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(schema.$defs.dataTextureTable.additionalProperties.anyOf, [
    { $ref: '#/$defs/dataTextureResource' },
    { $ref: '#/$defs/legacyTextureResource' },
  ]);
  const exclusions = schema.$defs.legacyTextureResource.allOf
    .find(entry => entry.not)?.not?.anyOf;
  assert.ok(Array.isArray(exclusions));
  assert.deepEqual(exclusions.slice(0, 3), [
    { required: ['kind'], properties: { kind: { const: 'dataTexture' } } },
    { required: ['type'], properties: { type: { const: 'dataTexture' } } },
    { required: ['textureKind'], properties: { textureKind: { const: 'dataTexture' } } },
  ]);
});

test('material texture slots support canonical and legacy aliases but reject ambiguity and unsupported kinds', () => {
  const canonical = createResourceDocument('material', {
    id: 'material/canonical', kind: 'physical', baseColorMapId: 'texture/albedo', normalMapId: 'texture/normal',
  });
  const legacy = createResourceDocument('material', {
    id: 'material/legacy', kind: 'standard', mapId: 'texture/albedo',
  });
  const nested = createResourceDocument('material', {
    id: 'material/nested', recipe: {
      kind: 'physical', roughnessMapId: 'texture/roughness', clearcoatMapId: 'texture/clearcoat',
    },
  });
  assert.equal(canonical.baseColorMapId, 'texture/albedo');
  assert.equal(legacy.mapId, 'texture/albedo');
  assert.equal(nested.recipe.roughnessMapId, 'texture/roughness');
  assert.equal(nested.recipe.clearcoatMapId, 'texture/clearcoat');

  assert.throws(() => createResourceDocument('material', {
    id: 'material/ambiguous', kind: 'standard',
    baseColorMapId: 'texture/albedo', mapId: 'texture/albedo',
  }), error => error?.code === 'ambiguous_material_texture');
  assert.throws(() => createResourceDocument('material', {
    id: 'material/basic-normal', kind: 'basic', normalMapId: 'texture/normal',
  }), error => error?.code === 'material_texture_slot_unsupported');
  assert.throws(() => createResourceDocument('material', {
    id: 'material/unstable', kind: 'physical', baseColorMapId: '$texture',
  }), error => error?.code === 'invalid_material_texture_reference');
});

test('nested physical clearcoat maps validate through their canonical data-texture role', () => {
  const project = createProjectDocument({
    projectId: 'project/nested-clearcoat',
    resources: {
      textures: [texture('texture/clearcoat', 'none', { channels: 1, pixels: [192] })],
      materials: [{
        id: 'material/coated',
        recipe: { kind: 'physical', clearcoatMapId: 'texture/clearcoat' },
      }],
    },
  });
  assert.equal(validateProjectDocument(project).valid, true);
  assert.equal(project.resources.materials['material/coated'].recipe.kind, 'physical');
});

test('mapped material controls are strict and bounded before candidate compilation', () => {
  const valid = createProjectDocument({
    projectId: 'project/material-control-valid',
    resources: {
      textures: [texture('texture/control', 'none', { channels: 1, pixels: [255] })],
      materials: [{
        id: 'material/control',
        recipe: {
          kind: 'physical', clearcoatMapId: 'texture/control',
          metalness: 0, roughness: 1, opacity: 1, alphaTest: 0,
          clearcoat: 1, clearcoatRoughness: 0, transmission: 0,
          sheen: 1, sheenRoughness: 1, specularIntensity: 1,
          anisotropy: 1, iridescence: 1, thickness: 1_000_000,
          emissiveIntensity: 1_000_000, ior: 3, aoMapIntensity: 1,
          bumpScale: -1_000, displacementScale: 100_000,
          displacementBias: -100_000, normalScale: [-100, 100],
          clearcoatNormalScale: [100, -100], vertexColors: true,
        },
      }],
    },
  });
  assert.equal(validateProjectDocument(valid).valid, true);

  const invalidCases = [
    ['roughness', 1.01],
    ['metalness', -0.01],
    ['alphaTest', 1.01],
    ['ior', 0.99],
    ['thickness', -1],
    ['emissiveIntensity', -1],
    ['aoMapIntensity', 1.01],
    ['bumpScale', 1_001],
    ['displacementScale', 100_001],
    ['displacementBias', -100_001],
    ['normalScale', [101, 1]],
    ['clearcoatNormalScale', [1]],
    ['vertexColors', 'yes'],
  ];
  invalidCases.forEach(([key, value], index) => {
    const project = createProjectDocument({
      projectId: `project/material-control-invalid-${index}`,
      resources: {
        textures: [texture('texture/control', 'none', { channels: 1, pixels: [255] })],
        materials: [{
          id: 'material/control',
          recipe: { kind: 'physical', clearcoatMapId: 'texture/control', [key]: value },
        }],
      },
    });
    const validation = validateProjectDocument(project);
    assert.equal(validation.valid, false, `${key} unexpectedly validated`);
    assert.ok(validation.diagnostics.some(entry => entry.code === 'invalid_material_texture_control'), key);
  });
});

test('mapped material color controls accept bounded values and the exact Three r184 CSS subset', () => {
  const maximumLengthRgb = `rgb(${' '.repeat(118)}0,0,0)`;
  assert.equal(maximumLengthRgb.length, 128);
  const validCases = [
    ['baseColor', [0, 0.5, 1_000_000]],
    ['color', [0, 0.5, 1_000_000, 1]],
    ['emissive', 0xffffff],
    ['sheenColor', 'red'],
    ['specularColor', '#AbC'],
    ['baseColor', '#AabbCC'],
    ['color', 'rgb(0, 127, 255)'],
    ['emissive', 'rgb(0%, 50%, 100%)'],
    ['sheenColor', 'hsl(360, 50%, 25%)'],
    ['sheenColor', 'hsl(.5, 50.5%, 25.5%)'],
    ['specularColor', 'WHITE'],
    ['specularColor', maximumLengthRgb],
  ];
  const valid = createProjectDocument({
    projectId: 'project/material-color-controls-valid',
    resources: {
      textures: [texture('texture/color-control')],
      materials: validCases.map(([key, value], index) => ({
        id: `material/color-control-${index}`,
        kind: 'physical',
        baseColorMapId: 'texture/color-control',
        [key]: value,
      })),
    },
  });
  assert.equal(validateProjectDocument(valid).valid, true);

  assert.throws(
    () => assertMaterialTextureControls({
      id: 'material/nonfinite-color-control',
      kind: 'physical',
      baseColorMapId: 'texture/color-control',
      emissive: [0, Number.NaN, 1],
    }),
    error => error?.code === 'invalid_material_texture_control',
  );

  const invalidCases = [
    ['baseColor', { red: 1, green: 1, blue: 1 }],
    ['color', [1, 1]],
    ['emissive', [0, 1_000_001, 1]],
    ['sheenColor', [-0.01, 0, 1]],
    ['specularColor', [0, 0, 0, 1.01]],
    ['baseColor', -1],
    ['color', 0x1000000],
    ['emissive', 1.5],
    ['sheenColor', ''],
    ['specularColor', ' '],
    ['baseColor', 'red\u0000'],
    ['color', 'x'.repeat(129)],
    ['emissive', 'chartreuse'],
    ['sheenColor', 'rgb(256, 0, 0)'],
    ['specularColor', 'rgb(101%, 0%, 0%)'],
    ['baseColor', 'hsl(0, 101%, 50%)'],
    ['color', 'hsl(0, 50%, -1%)'],
    ['emissive', '#ffff'],
    ['sheenColor', '#ffffffff'],
    ['specularColor', 'rgb(+1, 0, 0)'],
    ['baseColor', 'rgb(-1, 0, 0)'],
    ['color', 'rgb(0, 0.5, 0)'],
    ['emissive', 'rgb(0%, 50.5%, 100%)'],
    ['sheenColor', 'hsl(+1, 50%, 50%)'],
    ['specularColor', 'hsl(1., 50%, 50%)'],
    ['baseColor', 'RGB(0, 0, 0)'],
    ['color', 'HSL(0, 0%, 0%)'],
  ];
  invalidCases.forEach(([key, value], index) => {
    assert.throws(
      () => assertMaterialTextureControls({
        id: 'material/color-control',
        kind: 'physical',
        baseColorMapId: 'texture/color-control',
        [key]: value,
      }),
      error => error?.code === 'invalid_material_texture_control',
      `${key}=${String(value)}`,
    );
    const project = createProjectDocument({
      projectId: `project/material-color-controls-invalid-${index}`,
      resources: {
        textures: [texture('texture/color-control')],
        materials: [{
          id: 'material/color-control',
          kind: 'physical',
          baseColorMapId: 'texture/color-control',
          [key]: value,
        }],
      },
    });
    const validation = validateProjectDocument(project);
    assert.equal(validation.valid, false, `${key}=${String(value)} unexpectedly validated`);
    assert.ok(
      validation.diagnostics.some(entry => entry.code === 'invalid_material_texture_control'),
      `${key}=${String(value)}`,
    );
  });
});

test('material texture validation enforces channel roles while accepting linear color maps', () => {
  const valid = createProjectDocument({
    projectId: 'project/material-map-roles-valid',
    resources: {
      textures: [
        texture('texture/linear-color', 'linear'),
        texture('texture/normal', 'none', { channels: 3, pixels: [128, 128, 255] }),
        texture('texture/data', 'none', { channels: 1, pixels: [192] }),
      ],
      materials: [{
        id: 'material/linear-colors', kind: 'physical',
        baseColorMapId: 'texture/linear-color',
        emissiveMapId: 'texture/linear-color',
        sheenColorMapId: 'texture/linear-color',
        specularColorMapId: 'texture/linear-color',
        normalMapId: 'texture/normal',
        roughnessMapId: 'texture/data',
      }],
    },
  });
  assert.equal(validateProjectDocument(valid).valid, true);

  const invalid = createProjectDocument({
    projectId: 'project/material-map-roles-invalid',
    resources: {
      textures: [
        texture('texture/srgb', 'srgb'),
        texture('texture/none-one', 'none', { channels: 1, pixels: [128] }),
        texture('texture/none-four', 'none'),
      ],
      materials: [
        { id: 'material/normal-channel', kind: 'physical', normalMapId: 'texture/none-one' },
        { id: 'material/roughness-space', kind: 'physical', roughnessMapId: 'texture/srgb' },
        { id: 'material/base-space', kind: 'physical', baseColorMapId: 'texture/none-four' },
        { id: 'material/sheen-channel', kind: 'physical', sheenRoughnessMapId: 'texture/none-one' },
      ],
    },
  });
  const validation = validateProjectDocument(invalid);
  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics.filter(entry => entry.code === 'material_texture_channel_mismatch').length, 2);
  assert.equal(validation.diagnostics.filter(entry => entry.code === 'material_texture_color_space_mismatch').length, 2);
});

test('direct material maps cannot silently conflict with equivalent graph outputs', () => {
  const project = createProjectDocument({
    projectId: 'project/material-graph-conflict',
    resources: {
      textures: [texture('texture/albedo')],
      graphs: [constantColorGraph('graph/albedo')],
      materials: [{
        id: 'material/conflict', kind: 'physical',
        graphId: 'graph/albedo', baseColorMapId: 'texture/albedo',
      }],
    },
  });
  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some(entry => entry.code === 'material_texture_graph_conflict'
    && entry.path.includes('baseColorMapId')));
});

test('project validation requires existing texture IDs and role-correct color spaces', () => {
  const project = createProjectDocument({
    projectId: 'project/texture-validation',
    resources: {
      textures: [
        texture('texture/albedo', 'srgb'),
        texture('texture/data', 'none'),
        texture('texture/linear', 'linear'),
      ],
      materials: [
        {
          id: 'material/valid', kind: 'physical',
          baseColorMapId: 'texture/albedo',
          roughnessMapId: 'texture/data',
        },
        { id: 'material/missing', kind: 'standard', normalMapId: 'texture/missing' },
        { id: 'material/wrong-color', kind: 'physical', normalMapId: 'texture/albedo' },
      ],
      graphs: [
        sampledGraph('graph/valid', 'texture/albedo', 'srgb'),
        sampledGraph('graph/missing', 'texture/missing', 'none'),
        sampledGraph('graph/wrong-color', 'texture/linear', 'srgb'),
      ],
    },
  });

  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, false);
  const codes = validation.diagnostics.map(entry => entry.code);
  assert.equal(codes.filter(code => code === 'missing_resource').length, 2);
  assert.equal(codes.includes('material_texture_color_space_mismatch'), true);
  assert.equal(codes.includes('graph_texture_color_space_mismatch'), true);
  assert.equal(codes.includes('invalid_data_texture_resource'), false);
});

test('project validation enforces the aggregate decoded image-texture budget', () => {
  const width = 512;
  const height = 341;
  const channels = 4;
  const decodedBytes = width * height * channels;
  assert.ok(decodedBytes < DATA_TEXTURE_LIMITS.maxEncodedBytes);
  const data = Buffer.alloc(decodedBytes).toString('base64');
  const textureCount = Math.floor(DATA_TEXTURE_LIMITS.maxProjectDecodedBytes / decodedBytes) + 1;
  const project = createProjectDocument({
    projectId: 'project/texture-budget',
    resources: {
      textures: Array.from({ length: textureCount }, (_, index) => ({
        id: `texture/budget-${index}`,
        kind: 'dataTexture', width, height, channels, data,
      })),
    },
  });

  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some(entry => entry.code === 'project_texture_budget_exceeded'));
});

test('project validation independently enforces aggregate serialized texture bytes', () => {
  const width = 512;
  const height = 320;
  const channels = 4;
  const decodedBytes = width * height * channels;
  const data = Buffer.alloc(decodedBytes).toString('base64');
  const textureCount = 10;
  assert.ok(decodedBytes * textureCount < DATA_TEXTURE_LIMITS.maxProjectDecodedBytes);
  const project = createProjectDocument({
    projectId: 'project/texture-serialized-budget',
    resources: {
      textures: Array.from({ length: textureCount }, (_, index) => ({
        id: `texture/serialized-${index}`,
        kind: 'dataTexture', width, height, channels, data,
      })),
    },
  });
  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some(entry => entry.code === 'project_texture_serialized_budget_exceeded'));
  assert.equal(validation.diagnostics.some(entry => entry.code === 'project_texture_budget_exceeded'), false);
});

test('direct texture source patches swap representations and survive undo, redo, and placeholder upgrade', async () => {
  const projectId = 'project/texture-source-patches';
  const originalPixels = [1, 2, 3, 4];
  const replacementBytes = [9, 8, 7, 6];
  const replacementData = Buffer.from(replacementBytes).toString('base64');
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId,
    resources: { textures: [
      texture('texture/live', 'srgb', { pixels: originalPixels }),
      {
        id: 'texture/legacy', kind: 'texture', name: 'Legacy placeholder',
        recipe: { kind: 'image', assetId: 'asset/old' },
      },
    ] },
  }));

  await kernel.apply(request(projectId, 0, 'texture-source-swap-0001', [{
    type: 'resource.patch', resourceType: 'texture', resourceId: 'texture/live',
    patch: { data: replacementData },
  }]));
  assert.equal(kernel.document.resources.textures['texture/live'].recipe.data, replacementData);
  assert.equal(Object.hasOwn(kernel.document.resources.textures['texture/live'].recipe, 'pixels'), false);

  await kernel.undo({
    baseRevision: 1, idempotencyKey: 'texture-source-undo-0001', label: 'Undo texture source swap',
  });
  assert.deepEqual(kernel.document.resources.textures['texture/live'].recipe.pixels, originalPixels);
  assert.equal(Object.hasOwn(kernel.document.resources.textures['texture/live'].recipe, 'data'), false);
  await kernel.redo({
    baseRevision: 2, idempotencyKey: 'texture-source-redo-0001', label: 'Redo texture source swap',
  });
  assert.equal(kernel.document.resources.textures['texture/live'].recipe.data, replacementData);

  await kernel.apply(request(projectId, 3, 'texture-placeholder-upgrade-0001', [{
    type: 'resource.patch', resourceType: 'texture', resourceId: 'texture/legacy',
    patch: {
      kind: 'dataTexture', width: 1, height: 1, channels: 4,
      pixels: [16, 32, 64, 255], colorSpace: 'srgb',
    },
  }]));
  const upgraded = kernel.document.resources.textures['texture/legacy'];
  assert.equal(upgraded.kind, 'texture');
  assert.equal(upgraded.name, 'Legacy placeholder');
  assert.equal(upgraded.recipe.kind, 'dataTexture');
  assert.deepEqual(upgraded.recipe.pixels, [16, 32, 64, 255]);
  assert.equal(Object.hasOwn(upgraded.recipe, 'assetId'), false);
  assert.equal(validateProjectDocument(kernel.document).valid, true);
});

test('legacy placeholder upgrades canonicalize root type aliases identically and reject undiscriminated direct fields', async () => {
  const upgradedRecipes = [];
  for (const [index, discriminator] of ['type', 'textureKind'].entries()) {
    const projectId = `project/texture-placeholder-${index}`;
    const kernel = new AuthoringKernel(createProjectDocument({
      projectId,
      resources: { textures: [{
        id: 'texture/legacy',
        kind: 'texture',
        name: 'Legacy placeholder',
        recipe: {
          kind: 'image',
          assetId: 'asset/old',
          legacySampler: { wrapping: 'opaque' },
          obsoleteField: true,
        },
      }] },
    }));
    await kernel.apply(request(projectId, 0, `texture-placeholder-${discriminator}-0001`, [{
      type: 'resource.patch',
      resourceType: 'texture',
      resourceId: 'texture/legacy',
      patch: {
        [discriminator]: 'dataTexture',
        width: 1,
        height: 1,
        channels: 4,
        pixels: [12, 34, 56, 255],
        colorSpace: 'linear',
      },
    }]));

    const upgraded = kernel.document.resources.textures['texture/legacy'];
    assert.equal(upgraded.kind, 'texture');
    assert.equal(upgraded.name, 'Legacy placeholder');
    assert.equal(Object.hasOwn(upgraded, 'type'), false);
    assert.equal(Object.hasOwn(upgraded, 'textureKind'), false);
    assert.equal(Object.hasOwn(upgraded.recipe, 'assetId'), false);
    assert.equal(Object.hasOwn(upgraded.recipe, 'legacySampler'), false);
    assert.equal(Object.hasOwn(upgraded.recipe, 'obsoleteField'), false);
    assert.equal(validateProjectDocument(kernel.document).valid, true);
    upgradedRecipes.push(upgraded.recipe);
  }
  assert.deepEqual(upgradedRecipes[0], upgradedRecipes[1]);

  const projectId = 'project/texture-placeholder-undiscriminated';
  const kernel = new AuthoringKernel(createProjectDocument({
    projectId,
    resources: { textures: [{
      id: 'texture/legacy', kind: 'texture',
      recipe: { kind: 'image', assetId: 'asset/old' },
    }] },
  }));
  await assert.rejects(
    kernel.apply(request(projectId, 0, 'texture-placeholder-undiscriminated-0001', [{
      type: 'resource.patch',
      resourceType: 'texture',
      resourceId: 'texture/legacy',
      patch: { width: 1, height: 1, channels: 4, pixels: [12, 34, 56, 255] },
    }])),
    error => error?.code === 'invalid_texture_patch',
  );
  assert.equal(kernel.revision, 0);
  assert.deepEqual(kernel.document.resources.textures['texture/legacy'].recipe, {
    kind: 'image', assetId: 'asset/old',
  });
});

test('whole-project validation reports malformed texture-sampler graphs without throwing', () => {
  const project = createProjectDocument({ projectId: 'project/malformed-texture-graph' });
  project.resources.graphs['graph/malformed'] = {
    id: 'graph/malformed', kind: 'graph', name: 'Malformed sampler', metadata: {},
    graph: {
      formatVersion: 1,
      id: 'graph/malformed',
      domain: 'shader',
      nodes: [{ id: 'sample', type: 'texture.sample2d', params: { colorSpace: 'srgb' } }],
      edges: [],
      outputs: { baseColor: { nodeId: 'sample', port: 'color' } },
    },
  };

  const validation = validateProjectDocument(project);
  assert.equal(validation.valid, false);
  const codes = validation.diagnostics.map(entry => entry.code);
  assert.ok(codes.includes('missing_parameter'));
  assert.ok(codes.includes('required_input_unconnected'));
  assert.ok(codes.includes('missing_resource'));
});

test('texture aliases resolve through material and shader graph references in one atomic kernel transaction', async () => {
  const projectId = 'project/texture-aliases';
  const kernel = new AuthoringKernel(createProjectDocument({ projectId }));
  const result = await kernel.apply(request(projectId, 0, 'texture-alias-create-0001', [
    {
      type: 'resource.create', resourceType: 'texture', alias: '$albedo',
      resource: texture('texture/albedo'),
    },
    {
      type: 'resource.create', resourceType: 'material',
      resource: { id: 'material/road', kind: 'physical', baseColorMapId: '$albedo' },
    },
    {
      type: 'resource.create', resourceType: 'graph',
      resource: sampledGraph('graph/road', '$albedo'),
    },
  ]));

  assert.equal(result.revision, 1);
  assert.equal(result.resolvedIds.$albedo, 'texture/albedo');
  assert.equal(kernel.document.resources.materials['material/road'].baseColorMapId, 'texture/albedo');
  assert.equal(
    kernel.document.resources.graphs['graph/road'].graph.nodes.find(node => node.id === 'sample').params.textureId,
    'texture/albedo',
  );
  assert.equal(validateProjectDocument(kernel.document).valid, true);
  assert.ok(result.invalidations.includes('materials'));
  assert.ok(result.invalidations.includes('renderer'));
});

test('material and graph indexes both guard a referenced texture from deletion', async () => {
  const projectId = 'project/texture-delete-guard';
  const project = createProjectDocument({
    projectId,
    resources: {
      textures: [texture('texture/albedo')],
      materials: [{ id: 'material/road', kind: 'physical', baseColorMapId: 'texture/albedo' }],
      graphs: [sampledGraph('graph/road', 'texture/albedo')],
    },
  });
  const references = buildProjectIndex(project).getReferencesTo('texture/albedo');
  assert.deepEqual(references.map(reference => reference.kind).sort(), ['graphTexture', 'materialTexture']);
  assert.deepEqual(references.map(reference => reference.sourceId).sort(), ['graph/road', 'material/road']);

  const kernel = new AuthoringKernel(project);
  await assert.rejects(kernel.apply(request(projectId, 0, 'texture-delete-guard-0001', [{
    type: 'resource.delete', resourceType: 'texture', resourceId: 'texture/albedo',
  }])), error => error?.code === 'resource_in_use'
    && error.details.references.some(reference => reference.kind === 'materialTexture')
    && error.details.references.some(reference => reference.kind === 'graphTexture'));
  assert.equal(kernel.revision, 0);
  assert.ok(kernel.document.resources.textures['texture/albedo']);
});

test('Blender Image Texture aliases participate in project validation and deletion guards', () => {
  const project = createProjectDocument({
    projectId: 'project/blender-image-texture-reference',
    resources: {
      textures: [texture('texture/albedo')],
      graphs: [blenderImageGraph('graph/blender-image', 'texture/albedo')],
    },
  });
  assert.equal(validateProjectDocument(project).valid, true);
  assert.deepEqual(buildProjectIndex(project).getReferencesTo('texture/albedo'), [{
    kind: 'graphTexture',
    sourceId: 'graph/blender-image',
    path: 'graph.nodes.sample.params.textureId',
  }]);

  project.resources.graphs['graph/blender-image'].graph.nodes[0].params.textureId = 'texture/missing';
  const validation = validateProjectDocument(project);
  assert.ok(validation.diagnostics.some(entry => (
    entry.code === 'missing_resource'
      && entry.path.endsWith('.graph.nodes.sample.params.textureId')
  )));
});
