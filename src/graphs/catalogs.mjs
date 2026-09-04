const VALUE_TYPES = Object.freeze([
  'boolean', 'integer', 'float', 'vec2', 'vec3', 'vec4', 'color', 'string',
  'entityId', 'resourceId', 'eventPayload',
]);

const NUMERIC_TYPES = Object.freeze(['integer', 'float', 'vec2', 'vec3', 'vec4', 'color']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

const port = (type, options = {}) => deepFreeze({ type, ...options });
const ports = (entries) => Object.freeze(Object.fromEntries(entries));
const param = (type, options = {}) => deepFreeze({ type, ...options });
const params = (entries = []) => Object.freeze(Object.fromEntries(entries));

function node(type, label, category, options = {}) {
  return deepFreeze({
    type,
    label,
    category,
    description: options.description ?? '',
    cost: options.cost ?? 1,
    stages: Object.freeze(options.stages ?? []),
    inputs: ports(options.inputs ?? []),
    outputs: ports(options.outputs ?? []),
    params: params(options.params ?? []),
    tags: Object.freeze(options.tags ?? []),
    ...(options.blenderId ? { blenderId: options.blenderId } : {}),
    ...(options.canonicalType ? { canonicalType: options.canonicalType } : {}),
    ...(options.aliases?.length ? { aliases: Object.freeze(options.aliases) } : {}),
  });
}

const blenderSocket = (type, blenderName, options = {}) => port(type, { blenderName, ...options });

function blenderNode(type, blenderId, label, category, options = {}) {
  return node(type, label, category, {
    ...options,
    blenderId,
    aliases: [blenderId, ...(options.aliases ?? [])],
    tags: ['blender', ...(options.tags ?? [])],
  });
}

const floatValue = ['value', param('number', { default: 0, min: -1e6, max: 1e6 })];
const colorValue = ['value', param('color', { default: [1, 1, 1] })];
const vectorValue = (length) => ['value', param('numberArray', { length, default: Array(length).fill(0), min: -1e6, max: 1e6 })];

const curveMappingParam = (channels, domainMin = 0, domainMax = 1) => ['mapping', param('curveMapping', {
  channels,
  extendValues: ['EXTRAPOLATED', 'HORIZONTAL'],
  handleTypes: ['AUTO', 'AUTO_CLAMPED', 'VECTOR'],
  minItems: 2,
  maxItems: 32,
  min: -100,
  max: 100,
  default: {
    extend: 'EXTRAPOLATED',
    clip: {
      enabled: true,
      min: [domainMin, domainMin],
      max: [domainMax, domainMax],
    },
    curves: Object.fromEntries(channels.map((channel) => [channel, [
      { location: [domainMin, domainMin], handleType: 'AUTO' },
      { location: [domainMax, domainMax], handleType: 'AUTO' },
    ]])),
  },
})];

const BLENDER_VECTOR_MATH_OPERATIONS = Object.freeze([
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'MULTIPLY_ADD', 'CROSS_PRODUCT',
  'PROJECT', 'REFLECT', 'REFRACT', 'FACEFORWARD', 'DOT_PRODUCT', 'DISTANCE',
  'LENGTH', 'SCALE', 'NORMALIZE', 'ABSOLUTE', 'MINIMUM', 'MAXIMUM', 'FLOOR',
  'CEIL', 'FRACTION', 'MODULO', 'WRAP', 'SNAP', 'SINE', 'COSINE', 'TANGENT',
]);

const BLENDER_MIX_MODES = Object.freeze([
  'MIX', 'DARKEN', 'MULTIPLY', 'BURN', 'LIGHTEN', 'SCREEN', 'DODGE', 'ADD',
  'OVERLAY', 'SOFT_LIGHT', 'LINEAR_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'SUBTRACT',
  'DIVIDE', 'HUE', 'SATURATION', 'COLOR', 'VALUE',
]);

const BLENDER_MATH_OPERATIONS = Object.freeze([
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'MULTIPLY_ADD', 'POWER', 'LOGARITHM',
  'SQRT', 'INVERSE_SQRT', 'ABSOLUTE', 'EXPONENT', 'MINIMUM', 'MAXIMUM',
  'LESS_THAN', 'GREATER_THAN', 'SIGN', 'COMPARE', 'SMOOTH_MIN', 'SMOOTH_MAX',
  'ROUND', 'FLOOR', 'CEIL', 'TRUNC', 'FRACT', 'MODULO', 'FLOORED_MODULO',
  'WRAP', 'SNAP', 'PINGPONG', 'SINE', 'COSINE', 'TANGENT', 'ARCSINE',
  'ARCCOSINE', 'ARCTANGENT', 'ARCTAN2', 'SINH', 'COSH', 'TANH',
  'RADIANS', 'DEGREES',
]);

function blenderUtilityNodes(stages = []) {
  const staged = (options = {}) => stages.length ? { ...options, stages } : options;
  const fragmentStages = stages.length ? ['fragment'] : [];
  return [
    blenderNode('blender.value', 'ShaderNodeValue', 'Value', 'input', staged({
      description: 'Blender scalar Value node.',
      outputs: [['value', blenderSocket('float', 'Value', { default: 0 })]],
      params: [['value', param('number', { default: 0, min: -1e6, max: 1e6 })]],
    })),
    blenderNode('blender.rgb', 'ShaderNodeRGB', 'RGB', 'input', staged({
      description: 'Blender constant RGB colour node.',
      outputs: [['color', blenderSocket('color', 'Color', { default: [0.5, 0.5, 0.5, 1] })]],
      params: [['value', param('color', { default: [0.5, 0.5, 0.5, 1] })]],
    })),
    blenderNode('blender.inputVector', 'FunctionNodeInputVector', 'Vector', 'input', staged({
      description: 'Blender constant vector with an authored 2D, 3D, or 4D socket dimension.',
      outputs: [['vector', blenderSocket('dimensionVector', 'Vector')]],
      params: [
        ['dimensions', param('integer', { default: 3, min: 2, max: 4 })],
        vectorValue(4),
      ],
    })),
    blenderNode('blender.inputInt', 'FunctionNodeInputInt', 'Integer', 'input', staged({
      description: 'Blender constant integer input with an exact signed 32-bit value.',
      outputs: [['integer', blenderSocket('integer', 'Integer')]],
      params: [['value', param('integer', { default: 0, min: -2147483648, max: 2147483647 })]],
    })),
    blenderNode('blender.cameraData', 'ShaderNodeCameraData', 'Camera Data', 'input', staged({
      description: 'Camera-space view direction, positive view depth, and Euclidean camera distance.',
      outputs: [
        ['viewVector', blenderSocket('vec3', 'View Vector')],
        ['viewZDepth', blenderSocket('float', 'View Z Depth')],
        ['viewDistance', blenderSocket('float', 'View Distance')],
      ],
    })),
    blenderNode('blender.uvMap', 'ShaderNodeUVMap', 'UV Map', 'input', staged({
      description: 'Reads the active render UV layer. Named layers and instancer UV inheritance remain explicit live boundaries.',
      outputs: [['uv', blenderSocket('vec3', 'UV')]],
      params: [
        ['uvMap', param('string', { default: '' })],
        ['fromInstancer', param('boolean', { default: false })],
      ],
    })),
    blenderNode('blender.tangent', 'ShaderNodeTangent', 'Tangent', 'input', {
      ...(fragmentStages.length ? { stages: fragmentStages } : {}),
      description: 'Reads the active UV tangent in fragment shading. Named UV and radial tangent modes remain explicit boundaries.',
      outputs: [['tangent', blenderSocket('vec3', 'Tangent')]],
      params: [
        ['directionType', param('enum', { values: ['RADIAL', 'UV_MAP'], default: 'RADIAL' })],
        ['axis', param('enum', { values: ['X', 'Y', 'Z'], default: 'Z' })],
        ['uvMap', param('string', { default: '' })],
      ],
    }),
    blenderNode('blender.rgbToBw', 'ShaderNodeRGBToBW', 'RGB to BW', 'converter', staged({
      description: 'Converts linear RGB to one luminance value in the project working colour space.',
      inputs: [['color', blenderSocket('color', 'Color', { default: [0.5, 0.5, 0.5, 1] })]],
      outputs: [['value', blenderSocket('float', 'Val')]],
    })),
    blenderNode('blender.math', 'ShaderNodeMath', 'Math', 'converter', staged({
      cost: 3,
      description: 'Blender scalar Math operations with up to three value sockets.',
      inputs: [
        ['value', blenderSocket('float', 'Value', { default: 0.5 })],
        ['valueB', blenderSocket('float', 'Value', { default: 0.5 })],
        ['valueC', blenderSocket('float', 'Value', { default: 0 })],
      ],
      outputs: [['value', blenderSocket('float', 'Value')]],
      params: [
        ['operation', param('enum', { values: BLENDER_MATH_OPERATIONS, default: 'ADD' })],
        ['clamp', param('boolean', { default: false })],
      ],
    })),
    blenderNode('blender.combineXYZ', 'ShaderNodeCombineXYZ', 'Combine XYZ', 'converter', staged({
      description: 'Combines X, Y, and Z scalar channels into a vector.',
      inputs: [
        ['x', blenderSocket('float', 'X', { default: 0 })],
        ['y', blenderSocket('float', 'Y', { default: 0 })],
        ['z', blenderSocket('float', 'Z', { default: 0 })],
      ],
      outputs: [['vector', blenderSocket('vec3', 'Vector')]],
    })),
    blenderNode('blender.separateColor', 'ShaderNodeSeparateColor', 'Separate Color', 'converter', staged({
      description: 'Separates a colour into RGB, HSV, or HSL channels.',
      inputs: [['color', blenderSocket('color', 'Color', { default: [0.8, 0.8, 0.8, 1] })]],
      outputs: [
        ['red', blenderSocket('float', 'Red')],
        ['green', blenderSocket('float', 'Green')],
        ['blue', blenderSocket('float', 'Blue')],
        ['alpha', blenderSocket('float', 'Alpha')],
      ],
      params: [['mode', param('enum', { values: ['RGB', 'HSV', 'HSL'], default: 'RGB' })]],
    })),
    blenderNode('blender.combineColor', 'ShaderNodeCombineColor', 'Combine Color', 'converter', staged({
      description: 'Combines RGB, HSV, or HSL channels into a colour.',
      inputs: [
        ['red', blenderSocket('float', 'Red', { default: 0 })],
        ['green', blenderSocket('float', 'Green', { default: 0 })],
        ['blue', blenderSocket('float', 'Blue', { default: 0 })],
        ['alpha', blenderSocket('float', 'Alpha', { default: 1 })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
      params: [['mode', param('enum', { values: ['RGB', 'HSV', 'HSL'], default: 'RGB' })]],
    })),
    blenderNode('blender.hueSaturation', 'ShaderNodeHueSaturation', 'Hue/Saturation/Value', 'color', staged({
      cost: 4,
      inputs: [
        ['hue', blenderSocket('float', 'Hue', { default: 0.5, min: 0, max: 1 })],
        ['saturation', blenderSocket('float', 'Saturation', { default: 1, min: 0, max: 2 })],
        ['value', blenderSocket('float', 'Value', { default: 1, min: 0, max: 2 })],
        ['factor', blenderSocket('float', 'Fac', { default: 1, min: 0, max: 1 })],
        ['color', blenderSocket('color', 'Color', { default: [0.8, 0.8, 0.8, 1] })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.brightnessContrast', 'ShaderNodeBrightContrast', 'Brightness/Contrast', 'color', staged({
      cost: 2,
      inputs: [
        ['color', blenderSocket('color', 'Color', { default: [0.8, 0.8, 0.8, 1] })],
        ['brightness', blenderSocket('float', 'Bright', { default: 0 })],
        ['contrast', blenderSocket('float', 'Contrast', { default: 0 })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.gamma', 'ShaderNodeGamma', 'Gamma', 'color', staged({
      cost: 2,
      inputs: [
        ['color', blenderSocket('color', 'Color', { default: [0.8, 0.8, 0.8, 1] })],
        ['gamma', blenderSocket('float', 'Gamma', { default: 1, min: 0.001 })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.invert', 'ShaderNodeInvert', 'Invert Color', 'color', staged({
      cost: 2,
      inputs: [
        ['factor', blenderSocket('float', 'Fac', { default: 1, min: 0, max: 1 })],
        ['color', blenderSocket('color', 'Color', { default: [0.8, 0.8, 0.8, 1] })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.floatCurve', 'ShaderNodeFloatCurve', 'Float Curve', 'converter', staged({
      cost: 8,
      description: 'Remaps a scalar through one bounded Blender CurveMapping channel and blends it with the source value.',
      inputs: [
        ['factor', blenderSocket('float', 'Factor', { default: 1, min: 0, max: 1 })],
        ['value', blenderSocket('float', 'Value', { default: 1 })],
      ],
      outputs: [['value', blenderSocket('float', 'Value')]],
      params: [curveMappingParam(['value'])],
    })),
    blenderNode('blender.rgbCurve', 'ShaderNodeRGBCurve', 'RGB Curves', 'color', staged({
      cost: 8,
      description: 'Remaps linear RGB through combined, red, green, and blue Blender CurveMapping channels.',
      inputs: [
        ['factor', blenderSocket('float', 'Factor', { blenderIdentifier: 'Fac', aliases: ['Factor'], default: 1, min: 0, max: 1 })],
        ['color', blenderSocket('color', 'Color', { default: [1, 1, 1, 1] })],
      ],
      outputs: [['color', blenderSocket('color', 'Color')]],
      params: [curveMappingParam(['red', 'green', 'blue', 'combined'])],
    })),
    blenderNode('blender.vectorCurve', 'ShaderNodeVectorCurve', 'Vector Curves', 'vector', staged({
      cost: 8,
      description: 'Remaps a vector through independent X, Y, and Z Blender CurveMapping channels.',
      inputs: [
        ['factor', blenderSocket('float', 'Factor', { blenderIdentifier: 'Fac', aliases: ['Factor'], default: 1, min: 0, max: 1 })],
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
      ],
      outputs: [['vector', blenderSocket('vec3', 'Vector')]],
      params: [curveMappingParam(['x', 'y', 'z'], -1, 1)],
    })),
    blenderNode('blender.clamp', 'ShaderNodeClamp', 'Clamp', 'converter', staged({
      inputs: [
        ['value', blenderSocket('float', 'Value', { default: 1 })],
        ['min', blenderSocket('float', 'Min', { default: 0 })],
        ['max', blenderSocket('float', 'Max', { default: 1 })],
      ],
      outputs: [['result', blenderSocket('float', 'Result')]],
      params: [['clampType', param('enum', { values: ['MINMAX', 'RANGE'], default: 'MINMAX' })]],
    })),
    blenderNode('blender.normalMap', 'ShaderNodeNormalMap', 'Normal Map', 'normal', {
      ...(fragmentStages.length ? { stages: fragmentStages } : {}),
      cost: 8,
      inputs: [
        ['strength', blenderSocket('float', 'Strength', { default: 1, min: 0 })],
        ['color', blenderSocket('color', 'Color', { default: [0.5, 0.5, 1, 1] })],
      ],
      outputs: [['normal', blenderSocket('vec3', 'Normal')]],
      params: [
        ['space', param('enum', { values: ['TANGENT', 'OBJECT', 'WORLD', 'BLENDER_OBJECT', 'BLENDER_WORLD'], default: 'TANGENT' })],
        ['uvMap', param('string', { default: '' })],
      ],
    }),
    blenderNode('blender.normal', 'ShaderNodeNormal', 'Normal', 'vector', staged({
      description: 'Normalizes an authored direction and returns its dot product with the live world-space shading normal.',
      inputs: [['normal', blenderSocket('vec3', 'Normal', { default: [0, 0, 1] })]],
      outputs: [
        ['normal', blenderSocket('vec3', 'Normal')],
        ['dot', blenderSocket('float', 'Dot')],
      ],
    })),
    blenderNode('blender.vectorTransform', 'ShaderNodeVectorTransform', 'Vector Transform', 'vector', staged({
      cost: 3,
      description: 'Transforms direction vectors between object and world space. Point, normal, and camera modes remain explicit live boundaries.',
      inputs: [['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })]],
      outputs: [['vector', blenderSocket('vec3', 'Vector')]],
      params: [
        ['vectorType', param('enum', { values: ['POINT', 'VECTOR', 'NORMAL'], default: 'POINT' })],
        ['convertFrom', param('enum', { values: ['WORLD', 'OBJECT', 'CAMERA'], default: 'WORLD' })],
        ['convertTo', param('enum', { values: ['WORLD', 'OBJECT', 'CAMERA'], default: 'OBJECT' })],
      ],
    })),
    blenderNode('blender.radialTiling', 'ShaderNodeRadialTiling', 'Radial Tiling', 'vector', staged({
      cost: 8,
      description: 'Exact sharp regular-segment coordinates for a constant integer side count. Rounded and irregular live tiling remain explicit boundaries.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0], dimensions: 2 })],
        ['sides', blenderSocket('float', 'Sides', { default: 5, min: 2, max: 1000 })],
        ['roundness', blenderSocket('float', 'Roundness', { default: 0, min: 0, max: 1 })],
      ],
      outputs: [
        ['segmentCoordinates', blenderSocket('vec3', 'Segment Coordinates')],
        ['segmentId', blenderSocket('float', 'Segment ID')],
        ['segmentWidth', blenderSocket('float', 'Segment Width')],
        ['segmentRotation', blenderSocket('float', 'Segment Rotation')],
      ],
      params: [['normalize', param('boolean', { default: false })]],
    })),
    blenderNode('blender.blackbody', 'ShaderNodeBlackbody', 'Blackbody', 'color', staged({
      cost: 8,
      description: 'Bounded analytic blackbody colour in the linear working colour space.',
      inputs: [['temperature', blenderSocket('float', 'Temperature', { default: 6500, min: 800, max: 12000, unit: 'kelvin' })]],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.wavelength', 'ShaderNodeWavelength', 'Wavelength', 'color', staged({
      cost: 12,
      description: 'Visible wavelength converted through analytic CIE XYZ fits into linear RGB.',
      inputs: [['wavelength', blenderSocket('float', 'Wavelength', { default: 500, min: 380, max: 780, unit: 'nanometers' })]],
      outputs: [['color', blenderSocket('color', 'Color')]],
    })),
    blenderNode('blender.vectorRotate', 'ShaderNodeVectorRotate', 'Vector Rotate', 'vector', staged({
      cost: 5,
      description: 'Rotates a vector around a center using Blender axis-angle, principal-axis, or XYZ Euler modes.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['center', blenderSocket('vec3', 'Center', { default: [0, 0, 0] })],
        ['axis', blenderSocket('vec3', 'Axis', { default: [0, 0, 1] })],
        ['angle', blenderSocket('float', 'Angle', { default: 0, unit: 'radians' })],
        ['rotation', blenderSocket('vec3', 'Rotation', { default: [0, 0, 0], unit: 'radians' })],
      ],
      outputs: [['vector', blenderSocket('vec3', 'Vector')]],
      params: [
        ['rotationType', param('enum', { values: ['AXIS_ANGLE', 'X_AXIS', 'Y_AXIS', 'Z_AXIS', 'EULER_XYZ'], default: 'AXIS_ANGLE' })],
        ['invert', param('boolean', { default: false })],
      ],
    })),
    blenderNode('blender.displacement', 'ShaderNodeDisplacement', 'Displacement', 'displacement', staged({
      cost: 2,
      description: 'Converts scalar height to a local-space displacement vector. World-space conversion remains an explicit boundary.',
      inputs: [
        ['height', blenderSocket('float', 'Height', { default: 0 })],
        ['midlevel', blenderSocket('float', 'Midlevel', { default: 0.5 })],
        ['scale', blenderSocket('float', 'Scale', { default: 1 })],
        ['normal', blenderSocket('vec3', 'Normal')],
      ],
      outputs: [['displacement', blenderSocket('vec3', 'Displacement')]],
      params: [['space', param('enum', { values: ['OBJECT'], default: 'OBJECT' })]],
    })),
    blenderNode('blender.vectorDisplacement', 'ShaderNodeVectorDisplacement', 'Vector Displacement', 'displacement', staged({
      cost: 2,
      description: 'Converts a vector field to a local-space displacement vector. Tangent and world spaces remain explicit boundaries.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['midlevel', blenderSocket('float', 'Midlevel', { default: 0 })],
        ['scale', blenderSocket('float', 'Scale', { default: 1 })],
      ],
      outputs: [['displacement', blenderSocket('vec3', 'Displacement')]],
      params: [['space', param('enum', { values: ['OBJECT'], default: 'OBJECT' })]],
    })),
  ];
}

/**
 * Blender-compatible procedural nodes shared by shader and texture graphs.
 *
 * The Studio type is stable and readable while `blenderId`/`aliases` retain
 * Blender's RNA identifier. Inputs intentionally are optional where Blender
 * exposes a socket default; the default and bounds remain discoverable on the
 * port definition and an agent can override the value with a typed edge.
 */
function blenderProceduralNodes(stages = []) {
  const staged = (options = {}) => stages.length ? { ...options, stages } : options;
  const fragmentStages = stages.length ? ['fragment'] : [];
  return [
    blenderNode('blender.textureCoordinate', 'ShaderNodeTexCoord', 'Texture Coordinate', 'input', staged({
      description: 'Blender Texture Coordinate outputs, including Generated coordinates used by object-space procedural materials.',
      outputs: [
        ['generated', blenderSocket('vec3', 'Generated')],
        ['normal', blenderSocket('vec3', 'Normal')],
        ['uv', blenderSocket('vec3', 'UV')],
        ['object', blenderSocket('vec3', 'Object')],
        ['camera', blenderSocket('vec3', 'Camera')],
        ['window', blenderSocket('vec3', 'Window')],
        ['reflection', blenderSocket('vec3', 'Reflection')],
      ],
      params: [['fromInstancer', param('boolean', { default: false })]],
    })),
    blenderNode('blender.imageTexture', 'ShaderNodeTexImage', 'Image Texture', 'texture', staged({
      cost: 8,
      description: 'Samples a canonical dataTexture with flat projection. Filtering and extension must match the texture resource sampler.',
      inputs: [['vector', blenderSocket('vec3', 'Vector')]],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['alpha', blenderSocket('float', 'Alpha')],
      ],
      params: [
        ['textureId', param('stableId', { required: true })],
        ['colorSpace', param('enum', { values: ['srgb', 'linear', 'none'], required: true })],
        ['projection', param('enum', { values: ['FLAT', 'BOX', 'SPHERE', 'TUBE'], default: 'FLAT' })],
        ['interpolation', param('enum', { values: ['LINEAR', 'CLOSEST', 'CUBIC', 'SMART'], default: 'LINEAR' })],
        ['extension', param('enum', { values: ['REPEAT', 'EXTEND', 'CLIP', 'MIRROR'], default: 'REPEAT' })],
      ],
      tags: ['sampler'],
    })),
    blenderNode('blender.separateXYZ', 'ShaderNodeSeparateXYZ', 'Separate XYZ', 'converter', staged({
      description: 'Separates a vector into its X, Y, and Z components.',
      inputs: [['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })]],
      outputs: [
        ['x', blenderSocket('float', 'X')],
        ['y', blenderSocket('float', 'Y')],
        ['z', blenderSocket('float', 'Z')],
      ],
    })),
    blenderNode('blender.mapping', 'ShaderNodeMapping', 'Mapping', 'vector', staged({
      cost: 3,
      description: 'Transforms texture coordinates with Blender-compatible location, XYZ rotation, and scale sockets.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['location', blenderSocket('vec3', 'Location', { default: [0, 0, 0] })],
        ['rotation', blenderSocket('vec3', 'Rotation', { default: [0, 0, 0], unit: 'radians' })],
        ['scale', blenderSocket('vec3', 'Scale', { default: [1, 1, 1] })],
      ],
      outputs: [['vector', blenderSocket('vec3', 'Vector')]],
      params: [['vectorType', param('enum', { values: ['POINT', 'TEXTURE', 'VECTOR', 'NORMAL'], default: 'POINT' })]],
    })),
    blenderNode('blender.checkerTexture', 'ShaderNodeTexChecker', 'Checker Texture', 'texture', staged({
      cost: 5,
      description: 'Blender checkerboard pattern with dynamic colours and scale.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['color1', blenderSocket('color', 'Color1', { aliases: ['Color 1'], default: [0.8, 0.8, 0.8, 1] })],
        ['color2', blenderSocket('color', 'Color2', { aliases: ['Color 2'], default: [0.2, 0.2, 0.2, 1] })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: -10000, max: 10000 })],
      ],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
      ],
    })),
    blenderNode('blender.gradientTexture', 'ShaderNodeTexGradient', 'Gradient Texture', 'texture', staged({
      cost: 4,
      description: 'Blender linear, quadratic, easing, diagonal, spherical, quadratic-sphere, or radial coordinate gradient.',
      inputs: [['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })]],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
      ],
      params: [['gradientType', param('enum', {
        values: ['LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL'],
        default: 'LINEAR',
      })]],
    })),
    blenderNode('blender.whiteNoiseTexture', 'ShaderNodeTexWhiteNoise', 'White Noise Texture', 'texture', staged({
      cost: 6,
      description: 'Deterministic white noise from scalar, 2D, 3D, or true 4D coordinate seeds.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['w', blenderSocket('float', 'W', { default: 0 })],
      ],
      outputs: [
        ['value', blenderSocket('float', 'Value')],
        ['color', blenderSocket('color', 'Color')],
      ],
      params: [['dimensions', param('enum', {
        values: ['1D', '2D', '3D', '4D'], default: '3D', newNodeDefault: '3D', rnaDefault: '1D',
      })]],
    })),
    blenderNode('blender.magicTexture', 'ShaderNodeTexMagic', 'Magic Texture', 'texture', staged({
      cost: 18,
      description: 'Blender psychedelic texture using its bounded nested sine/cosine sequence.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: -1000, max: 1000 })],
        ['distortion', blenderSocket('float', 'Distortion', { default: 1, min: -1000, max: 1000 })],
      ],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
      ],
      params: [['depth', param('integer', { default: 2, min: 0, max: 10, costMultiplier: 2 })]],
    })),
    blenderNode('blender.brickTexture', 'ShaderNodeTexBrick', 'Brick Texture', 'texture', staged({
      cost: 16,
      description: 'Blender-style alternating brick rows, mortar mask, colour bias, offset, and squash controls.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['color1', blenderSocket('color', 'Color1', { aliases: ['Color 1'], default: [0.8, 0.8, 0.8, 1] })],
        ['color2', blenderSocket('color', 'Color2', { aliases: ['Color 2'], default: [0.2, 0.2, 0.2, 1] })],
        ['mortar', blenderSocket('color', 'Mortar', { default: [0, 0, 0, 1] })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: -1000, max: 1000 })],
        ['mortarSize', blenderSocket('float', 'Mortar Size', { default: 0.02, min: 0, max: 0.125 })],
        ['mortarSmooth', blenderSocket('float', 'Mortar Smooth', { default: 0.1, min: 0, max: 1 })],
        ['bias', blenderSocket('float', 'Bias', { default: 0, min: -1, max: 1 })],
        ['brickWidth', blenderSocket('float', 'Brick Width', { default: 0.5, min: 0.01, max: 100 })],
        ['rowHeight', blenderSocket('float', 'Row Height', { default: 0.25, min: 0.01, max: 100 })],
      ],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
      ],
      params: [
        ['offset', param('number', { default: 0.5, min: 0, max: 1 })],
        ['offsetFrequency', param('integer', { default: 2, min: 1, max: 99 })],
        ['squash', param('number', { default: 1, min: 0, max: 99 })],
        ['squashFrequency', param('integer', { default: 2, min: 1, max: 99 })],
      ],
    })),
    blenderNode('blender.vectorMath', 'ShaderNodeVectorMath', 'Vector Math', 'vector', staged({
      cost: 3,
      description: 'Blender Vector Math operations. Vector and scalar result sockets are both declared because the active result depends on the operation.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['vectorB', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['vectorC', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['scale', blenderSocket('float', 'Scale', { default: 1 })],
      ],
      outputs: [
        ['vector', blenderSocket('vec3', 'Vector')],
        ['value', blenderSocket('float', 'Value')],
      ],
      params: [['operation', param('enum', { values: BLENDER_VECTOR_MATH_OPERATIONS, default: 'ADD' })]],
    })),
    blenderNode('blender.noiseTexture', 'ShaderNodeTexNoise', 'Noise Texture', 'texture', staged({
      cost: 20,
      description: 'Fractal Perlin noise with Blender dimensions, fractal modes, normalization, and socket defaults.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['w', blenderSocket('float', 'W', { default: 0 })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: 0 })],
        ['detail', blenderSocket('float', 'Detail', { default: 2, min: 0, max: 15 })],
        ['roughness', blenderSocket('float', 'Roughness', { default: 0.5, min: 0, max: 1 })],
        ['lacunarity', blenderSocket('float', 'Lacunarity', { default: 2, min: 0 })],
        ['offset', blenderSocket('float', 'Offset', { default: 0 })],
        ['gain', blenderSocket('float', 'Gain', { default: 1 })],
        ['distortion', blenderSocket('float', 'Distortion', { default: 0, min: 0 })],
      ],
      outputs: [
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
        ['color', blenderSocket('color', 'Color')],
      ],
      params: [
        ['dimensions', param('enum', { values: ['1D', '2D', '3D', '4D'], default: '3D', newNodeDefault: '3D', rnaDefault: '1D' })],
        ['noiseType', param('enum', { values: ['FBM', 'MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HETERO_TERRAIN'], default: 'FBM' })],
        ['normalize', param('boolean', { default: true, newNodeDefault: true, rnaDefault: false })],
        ['seed', param('integer', { default: 0, min: 0, max: 2147483647 })],
      ],
    })),
    blenderNode('blender.voronoiTexture', 'ShaderNodeTexVoronoi', 'Voronoi Texture', 'texture', staged({
      cost: 24,
      description: 'Live 1D-4D Blender Voronoi features, fractal controls, and Euclidean, Manhattan, Chebychev, or Minkowski distance metrics.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['w', blenderSocket('float', 'W', { default: 0 })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: 0 })],
        ['detail', blenderSocket('float', 'Detail', { default: 0, min: 0, max: 15 })],
        ['roughness', blenderSocket('float', 'Roughness', { default: 0.5, min: 0, max: 1 })],
        ['lacunarity', blenderSocket('float', 'Lacunarity', { default: 2, min: 0 })],
        ['smoothness', blenderSocket('float', 'Smoothness', { default: 1, min: 0, max: 1 })],
        ['exponent', blenderSocket('float', 'Exponent', { default: 0.5, min: 0 })],
        ['randomness', blenderSocket('float', 'Randomness', { default: 1, min: 0, max: 1 })],
      ],
      outputs: [
        ['distance', blenderSocket('float', 'Distance')],
        ['color', blenderSocket('color', 'Color')],
        ['position', blenderSocket('vec3', 'Position')],
        ['w', blenderSocket('float', 'W')],
        ['radius', blenderSocket('float', 'Radius')],
      ],
      params: [
        ['dimensions', param('enum', { values: ['1D', '2D', '3D', '4D'], default: '3D' })],
        ['feature', param('enum', { values: ['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'], default: 'F1' })],
        ['distanceMetric', param('enum', { values: ['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'], default: 'EUCLIDEAN' })],
        ['normalize', param('boolean', { default: false })],
        ['seed', param('integer', { default: 0, min: 0, max: 2147483647 })],
      ],
    })),
    blenderNode('blender.waveTexture', 'ShaderNodeTexWave', 'Wave Texture', 'texture', staged({
      cost: 18,
      description: 'Blender bands or rings with distortion controls and sine, saw, or triangle profiles.',
      inputs: [
        ['vector', blenderSocket('vec3', 'Vector', { default: [0, 0, 0] })],
        ['scale', blenderSocket('float', 'Scale', { default: 5, min: 0 })],
        ['distortion', blenderSocket('float', 'Distortion', { default: 0, min: 0 })],
        ['detail', blenderSocket('float', 'Detail', { default: 2, min: 0, max: 15 })],
        ['detailScale', blenderSocket('float', 'Detail Scale', { default: 1, min: 0 })],
        ['detailRoughness', blenderSocket('float', 'Detail Roughness', { default: 0.5, min: 0, max: 1 })],
        ['phaseOffset', blenderSocket('float', 'Phase Offset', { default: 0 })],
      ],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
      ],
      params: [
        ['waveType', param('enum', { values: ['BANDS', 'RINGS'], default: 'BANDS' })],
        ['bandsDirection', param('enum', { values: ['X', 'Y', 'Z', 'DIAGONAL'], default: 'X' })],
        ['ringsDirection', param('enum', { values: ['X', 'Y', 'Z', 'SPHERICAL'], default: 'X' })],
        ['profile', param('enum', { values: ['SIN', 'SAW', 'TRI'], default: 'SIN' })],
        ['seed', param('integer', { default: 0, min: 0, max: 2147483647 })],
      ],
    })),
    blenderNode('blender.colorRamp', 'ShaderNodeValToRGB', 'Color Ramp', 'converter', staged({
      cost: 6,
      description: 'Blender Color Ramp with ordered stops and its constant, linear, ease, cardinal, and B-spline interpolation modes.',
      inputs: [['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'], default: 0.5, min: 0, max: 1 })]],
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['alpha', blenderSocket('float', 'Alpha')],
      ],
      params: [
        ['stops', param('colorStops', { default: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ], minItems: 2, maxItems: 32 })],
        ['interpolation', param('enum', { values: ['CONSTANT', 'LINEAR', 'EASE', 'CARDINAL', 'B_SPLINE'], default: 'LINEAR' })],
        ['colorMode', param('enum', { values: ['RGB', 'HSV', 'HSL'], default: 'RGB' })],
        ['hueInterpolation', param('enum', { values: ['NEAR', 'FAR', 'CW', 'CCW'], default: 'NEAR' })],
      ],
    })),
    blenderNode('blender.mapRange', 'ShaderNodeMapRange', 'Map Range', 'converter', staged({
      cost: 5,
      description: 'Maps a scalar range using Blender linear, stepped, smoothstep, or smootherstep interpolation.',
      inputs: [
        ['value', blenderSocket('float', 'Value', { default: 1 })],
        ['fromMin', blenderSocket('float', 'From Min', { default: 0 })],
        ['fromMax', blenderSocket('float', 'From Max', { default: 1 })],
        ['toMin', blenderSocket('float', 'To Min', { default: 0 })],
        ['toMax', blenderSocket('float', 'To Max', { default: 1 })],
        ['steps', blenderSocket('float', 'Steps', { default: 4, min: 0 })],
      ],
      outputs: [['result', blenderSocket('float', 'Result')]],
      params: [
        ['interpolationType', param('enum', { values: ['LINEAR', 'STEPPED', 'SMOOTHSTEP', 'SMOOTHERSTEP'], default: 'LINEAR' })],
        ['clamp', param('boolean', { default: true, newNodeDefault: true, rnaDefault: false })],
      ],
    })),
    blenderNode('blender.mix', 'ShaderNodeMix', 'Mix', 'color', staged({
      cost: 4,
      description: 'Blender Mix node with blend modes including Linear Light. The valueType parameter resolves the typed A, B, and Result sockets.',
      inputs: [
        ['factor', blenderSocket('float', 'Factor', { aliases: ['Fac', 'Factor_Float', 'Factor_Vector'], default: 0.5, min: 0, max: 1 })],
        ['a', blenderSocket('sameNumeric', 'A', { aliases: ['A_Float', 'A_Vector', 'A_Color'], default: [0.5, 0.5, 0.5, 1] })],
        ['b', blenderSocket('sameNumeric', 'B', { aliases: ['B_Float', 'B_Vector', 'B_Color'], default: [0.5, 0.5, 0.5, 1] })],
      ],
      outputs: [['result', blenderSocket('sameNumeric', 'Result', { aliases: ['Result_Float', 'Result_Vector', 'Result_Color'] })]],
      params: [
        ['valueType', param('enum', { values: NUMERIC_TYPES, default: 'color' })],
        ['blendMode', param('enum', { values: BLENDER_MIX_MODES, default: 'MIX' })],
        ['clampFactor', param('boolean', { default: true, newNodeDefault: true, rnaDefault: false })],
        ['clampResult', param('boolean', { default: false })],
      ],
      aliases: ['ShaderNodeMixRGB'],
    })),
    blenderNode('blender.attribute', 'ShaderNodeAttribute', 'Attribute', 'input', staged({
      description: 'Reads a named Blender geometry, object, instancer, or view-layer attribute.',
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['vector', blenderSocket('vec3', 'Vector')],
        ['factor', blenderSocket('float', 'Fac', { blenderIdentifier: 'Fac', aliases: ['Factor'] })],
        ['alpha', blenderSocket('float', 'Alpha')],
      ],
      params: [
        ['name', param('string', { default: '' })],
        ['attributeType', param('enum', { values: ['GEOMETRY', 'OBJECT', 'INSTANCER', 'VIEW_LAYER'], default: 'GEOMETRY' })],
      ],
    })),
    blenderNode('blender.colorAttribute', 'ShaderNodeVertexColor', 'Color Attribute', 'input', staged({
      description: 'Reads a named mesh color attribute using Blender Color Attribute semantics.',
      outputs: [
        ['color', blenderSocket('color', 'Color')],
        ['alpha', blenderSocket('float', 'Alpha')],
      ],
      params: [['layerName', param('string', { default: 'Color' })]],
    })),
    blenderNode('blender.bump', 'ShaderNodeBump', 'Bump', 'normal', {
      ...(fragmentStages.length ? { stages: fragmentStages } : {}),
      cost: 12,
      description: 'Perturbs a surface normal from a scalar height field without changing geometry.',
      inputs: [
        ['strength', blenderSocket('float', 'Strength', { default: 1, min: 0, max: 1 })],
        ['distance', blenderSocket('float', 'Distance', { default: 0.001 })],
        ['height', blenderSocket('float', 'Height', { default: 1 })],
        ['normal', blenderSocket('vec3', 'Normal', { default: [0, 0, 1] })],
      ],
      outputs: [['normal', blenderSocket('vec3', 'Normal')]],
      params: [['invert', param('boolean', { default: false })]],
    }),
  ];
}

function blenderSurfaceNodes() {
  return [
    blenderNode('blender.fresnel', 'ShaderNodeFresnel', 'Fresnel', 'input', {
      cost: 5,
      stages: ['fragment'],
      description: 'Blender dielectric Fresnel facing ratio.',
      inputs: [
        ['ior', blenderSocket('float', 'IOR', { default: 1.45, min: 1, max: 1000 })],
        ['normal', blenderSocket('vec3', 'Normal', { default: [0, 0, 1] })],
      ],
      outputs: [['factor', blenderSocket('float', 'Fac')]],
    }),
    blenderNode('blender.layerWeight', 'ShaderNodeLayerWeight', 'Layer Weight', 'input', {
      cost: 5,
      stages: ['fragment'],
      description: 'Blender Fresnel and Facing layer-weight factors.',
      inputs: [
        ['blend', blenderSocket('float', 'Blend', { default: 0.5, min: 0, max: 1 })],
        ['normal', blenderSocket('vec3', 'Normal', { default: [0, 0, 1] })],
      ],
      outputs: [
        ['fresnel', blenderSocket('float', 'Fresnel')],
        ['facing', blenderSocket('float', 'Facing')],
      ],
    }),
    blenderNode('blender.principledBSDF', 'ShaderNodeBsdfPrincipled', 'Principled BSDF', 'shader', {
      cost: 36,
      stages: ['fragment'],
      description: 'Blender-compatible OpenPBR-style surface contract. Every PBR socket has a Blender default and may be overridden by a typed edge.',
      inputs: [
        ['baseColor', blenderSocket('color', 'Base Color', { default: [0.8, 0.8, 0.8, 1] })],
        ['metallic', blenderSocket('float', 'Metallic', { default: 0, min: 0, max: 1 })],
        ['roughness', blenderSocket('float', 'Roughness', { default: 0.5, min: 0, max: 1 })],
        ['ior', blenderSocket('float', 'IOR', { default: 1.5, min: 1, max: 1000 })],
        ['alpha', blenderSocket('float', 'Alpha', { default: 1, min: 0, max: 1 })],
        ['normal', blenderSocket('vec3', 'Normal', { default: [0, 0, 1] })],
        ['weight', blenderSocket('float', 'Weight', { default: 1, min: 0, max: 1 })],
        ['diffuseRoughness', blenderSocket('float', 'Diffuse Roughness', { default: 0, min: 0, max: 1 })],
        ['subsurfaceWeight', blenderSocket('float', 'Subsurface Weight', { default: 0, min: 0, max: 1 })],
        ['subsurfaceRadius', blenderSocket('vec3', 'Subsurface Radius', { default: [1, 0.2, 0.1] })],
        ['subsurfaceScale', blenderSocket('float', 'Subsurface Scale', { default: 0.05, min: 0 })],
        ['subsurfaceIor', blenderSocket('float', 'Subsurface IOR', { default: 1.4, min: 1, max: 1000 })],
        ['subsurfaceAnisotropy', blenderSocket('float', 'Subsurface Anisotropy', { default: 0, min: 0, max: 1 })],
        ['specularIorLevel', blenderSocket('float', 'IOR Level', { default: 0.5, min: 0, max: 1 })],
        ['specularTint', blenderSocket('color', 'Tint', { default: [1, 1, 1, 1] })],
        ['anisotropic', blenderSocket('float', 'Anisotropic', { default: 0, min: 0, max: 1 })],
        ['anisotropicRotation', blenderSocket('float', 'Anisotropic Rotation', { default: 0, min: 0, max: 1 })],
        ['tangent', blenderSocket('vec3', 'Tangent', { default: [0, 0, 0] })],
        ['transmissionWeight', blenderSocket('float', 'Transmission Weight', { default: 0, min: 0, max: 1 })],
        ['coatWeight', blenderSocket('float', 'Coat Weight', { default: 0, min: 0, max: 1 })],
        ['coatRoughness', blenderSocket('float', 'Coat Roughness', { default: 0.03, min: 0, max: 1 })],
        ['coatIor', blenderSocket('float', 'Coat IOR', { default: 1.5, min: 1, max: 4 })],
        ['coatTint', blenderSocket('color', 'Coat Tint', { default: [1, 1, 1, 1] })],
        ['coatNormal', blenderSocket('vec3', 'Coat Normal', { default: [0, 0, 1] })],
        ['sheenWeight', blenderSocket('float', 'Sheen Weight', { default: 0, min: 0, max: 1 })],
        ['sheenRoughness', blenderSocket('float', 'Sheen Roughness', { default: 0.5, min: 0, max: 1 })],
        ['sheenTint', blenderSocket('color', 'Sheen Tint', { default: [1, 1, 1, 1] })],
        ['emissionColor', blenderSocket('color', 'Emission Color', { default: [1, 1, 1, 1] })],
        ['emissionStrength', blenderSocket('float', 'Emission Strength', { default: 0, min: 0 })],
        ['thinFilmThickness', blenderSocket('float', 'Thin Film Thickness', { default: 0, min: 0, unit: 'nanometers' })],
        ['thinFilmIor', blenderSocket('float', 'Thin Film IOR', { default: 1.33, min: 1, max: 4 })],
      ],
      outputs: [['surface', blenderSocket('surface', 'BSDF')]],
      params: [
        ['distribution', param('enum', { values: ['MULTI_GGX', 'GGX'], default: 'MULTI_GGX' })],
        ['subsurfaceMethod', param('enum', { values: ['RANDOM_WALK', 'RANDOM_WALK_SKIN', 'BURLEY'], default: 'RANDOM_WALK' })],
      ],
      tags: ['surface'],
    }),
    blenderNode('blender.materialOutput', 'ShaderNodeOutputMaterial', 'Material Output', 'output', {
      cost: 1,
      stages: ['fragment'],
      description: 'Explicit material surface boundary. The pass-through surface output connects Blender node flow to the Studio graph surface output.',
      inputs: [['surface', blenderSocket('surface', 'Surface', { required: true })]],
      outputs: [['surface', blenderSocket('surface', 'Surface')]],
      params: [['target', param('enum', { values: ['ALL', 'EEVEE', 'CYCLES'], default: 'ALL' })]],
      tags: ['surface', 'graph-output'],
    }),
  ];
}

function blenderLayoutNodes(stages = []) {
  const staged = (options = {}) => stages.length ? { ...options, stages } : options;
  return [
    blenderNode('blender.frame', 'NodeFrame', 'Frame', 'layout', staged({
      description: 'Blender layout-only frame used to document and visually group a section of a node tree.',
      params: [
        ['labelSize', param('integer', { default: 0, min: 0, max: 64 })],
        ['shrink', param('boolean', { default: false })],
        ['text', param('string', { default: '' })],
      ],
      tags: ['layout', 'non-executable'],
    })),
    blenderNode('blender.reroute', 'NodeReroute', 'Reroute', 'layout', staged({
      description: 'Blender layout reroute with one polymorphic numeric input and any number of outgoing links.',
      inputs: [['input', blenderSocket('sameNumeric', 'Input')]],
      outputs: [['output', blenderSocket('sameNumeric', 'Output')]],
      params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })]],
      tags: ['layout', 'passthrough'],
    })),
  ];
}

const shaderNodes = [
  ...blenderLayoutNodes(['vertex', 'fragment']),
  node('constant.float', 'Float', 'constant', { stages: ['vertex', 'fragment'], outputs: [['value', port('float')]], params: [floatValue] }),
  node('constant.vec2', 'Vector 2', 'constant', { stages: ['vertex', 'fragment'], outputs: [['value', port('vec2')]], params: [vectorValue(2)] }),
  node('constant.vec3', 'Vector 3', 'constant', { stages: ['vertex', 'fragment'], outputs: [['value', port('vec3')]], params: [vectorValue(3)] }),
  node('constant.color', 'Colour', 'constant', { stages: ['vertex', 'fragment'], outputs: [['value', port('color')]], params: [colorValue] }),
  node('parameter.float', 'Float Parameter', 'parameter', { stages: ['vertex', 'fragment'], outputs: [['value', port('float')]], params: [['name', param('identifier', { required: true })], floatValue] }),
  node('parameter.vec2', 'Vector 2 Parameter', 'parameter', { stages: ['vertex', 'fragment'], outputs: [['value', port('vec2')]], params: [['name', param('identifier', { required: true })], vectorValue(2)] }),
  node('parameter.vec3', 'Vector 3 Parameter', 'parameter', { stages: ['vertex', 'fragment'], outputs: [['value', port('vec3')]], params: [['name', param('identifier', { required: true })], vectorValue(3)] }),
  node('parameter.color', 'Colour Parameter', 'parameter', { stages: ['vertex', 'fragment'], outputs: [['value', port('color')]], params: [['name', param('identifier', { required: true })], colorValue] }),
  node('input.uv', 'UV', 'input', { stages: ['vertex', 'fragment'], outputs: [['uv', port('vec2')]] }),
  node('input.worldPosition', 'World Position', 'input', { stages: ['vertex', 'fragment'], outputs: [['position', port('vec3')]] }),
  node('input.normal', 'Surface Normal', 'input', { stages: ['vertex', 'fragment'], outputs: [['normal', port('vec3')]] }),
  node('input.viewDirection', 'View Direction', 'input', { stages: ['fragment'], outputs: [['direction', port('vec3')]] }),
  node('input.time', 'Time', 'input', { stages: ['vertex', 'fragment'], outputs: [['seconds', port('float')]] }),
  node('texture.sample2d', 'Sample Texture', 'texture', { cost: 8, stages: ['vertex', 'fragment'], inputs: [['uv', port('vec2', { required: true })]], outputs: [['color', port('color')], ['alpha', port('float')]], params: [['textureId', param('stableId', { required: true })], ['colorSpace', param('enum', { values: ['srgb', 'linear', 'none'], required: true })]], tags: ['sampler'] }),
  node('pattern.gradient', 'Gradient', 'pattern', { cost: 2, stages: ['vertex', 'fragment'], inputs: [['coordinate', port('float', { required: true })]], outputs: [['value', port('float')]], params: [['start', param('number', { default: 0 })], ['end', param('number', { default: 1 })]] }),
  node('pattern.checker', 'Checker', 'pattern', { cost: 4, stages: ['vertex', 'fragment'], inputs: [['coordinate', port('vec2', { required: true })], ['a', port('color', { required: true })], ['b', port('color', { required: true })]], outputs: [['color', port('color')]], params: [['scale', param('number', { default: 8, min: 0.001, max: 4096 })]] }),
  node('noise.value', 'Value Noise', 'noise', { cost: 12, stages: ['vertex', 'fragment'], inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['value', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('noise.fbm', 'FBM', 'noise', { cost: 14, stages: ['vertex', 'fragment'], inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['value', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })], ['octaves', param('integer', { default: 4, min: 1, max: 8, costMultiplier: 8 })], ['lacunarity', param('number', { default: 2, min: 1, max: 8 })], ['gain', param('number', { default: 0.5, min: 0, max: 1 })]] }),
  node('noise.voronoi', 'Voronoi', 'noise', { cost: 18, stages: ['vertex', 'fragment'], inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['distance', port('float')], ['cell', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('ramp.color', 'Colour Ramp', 'convert', { cost: 6, stages: ['vertex', 'fragment'], inputs: [['value', port('float', { required: true })]], outputs: [['color', port('color')]], params: [['stops', param('colorStops', { required: true, minItems: 2, maxItems: 16 })], ['interpolation', param('enum', { values: ['linear', 'constant', 'smoothstep'], default: 'linear' })]] }),
  ...['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'power'].map((op) => node(`math.${op}`, op[0].toUpperCase() + op.slice(1), 'math', { cost: op === 'power' ? 3 : 1, stages: ['vertex', 'fragment'], inputs: [['a', port('sameNumeric', { required: true })], ['b', port('sameNumeric', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })]] })),
  node('math.abs', 'Absolute', 'math', { stages: ['vertex', 'fragment'], inputs: [['value', port('sameNumeric', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })]] }),
  node('math.saturate', 'Saturate', 'math', { stages: ['vertex', 'fragment'], inputs: [['value', port('sameNumeric', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })]] }),
  node('math.mix', 'Mix', 'math', { cost: 2, stages: ['vertex', 'fragment'], inputs: [['a', port('sameNumeric', { required: true })], ['b', port('sameNumeric', { required: true })], ['factor', port('float', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'color' })]] }),
  node('math.remap', 'Remap', 'math', { cost: 4, stages: ['vertex', 'fragment'], inputs: [['value', port('float', { required: true })]], outputs: [['value', port('float')]], params: [['inMin', param('number', { default: 0 })], ['inMax', param('number', { default: 1 })], ['outMin', param('number', { default: 0 })], ['outMax', param('number', { default: 1 })], ['clamp', param('boolean', { default: true })]] }),
  node('vector.dot', 'Dot Product', 'vector', { cost: 2, stages: ['vertex', 'fragment'], inputs: [['a', port('vec3', { required: true })], ['b', port('vec3', { required: true })]], outputs: [['value', port('float')]] }),
  node('vector.normalize', 'Normalize', 'vector', { cost: 2, stages: ['vertex', 'fragment'], inputs: [['value', port('vec3', { required: true })]], outputs: [['value', port('vec3')]] }),
  node('vector.combine3', 'Combine Vector 3', 'vector', { inputs: [['x', port('float', { required: true })], ['y', port('float', { required: true })], ['z', port('float', { required: true })]], outputs: [['value', port('vec3')]], stages: ['vertex', 'fragment'] }),
  node('normal.fromHeight', 'Normal From Height', 'normal', { cost: 10, stages: ['fragment'], inputs: [['height', port('float', { required: true })]], outputs: [['normal', port('vec3')]], params: [['strength', param('number', { default: 1, min: 0, max: 100 })]] }),
  node('lighting.fresnel', 'Fresnel', 'lighting', { cost: 5, stages: ['fragment'], inputs: [['normal', port('vec3', { required: true })], ['viewDirection', port('vec3', { required: true })]], outputs: [['value', port('float')]], params: [['power', param('number', { default: 5, min: 0.01, max: 64 })]] }),
  ...blenderUtilityNodes(['vertex', 'fragment']),
  ...blenderProceduralNodes(['vertex', 'fragment']),
  ...blenderSurfaceNodes(),
];

const textureNodes = [
  ...blenderLayoutNodes(),
  node('constant', 'Constant', 'source', { outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })], ['value', param('numericValue', { default: 0 })]] }),
  node('image', 'Image', 'source', { cost: 8, inputs: [['uv', port('vec2', { required: true })]], outputs: [['color', port('color')], ['alpha', port('float')]], params: [['assetId', param('stableId', { required: true })], ['colorSpace', param('enum', { values: ['srgb', 'none'], required: true })]], tags: ['sampler'] }),
  node('uv', 'UV', 'coordinate', { outputs: [['uv', port('vec2')]] }),
  node('worldPosition', 'World Position', 'coordinate', { outputs: [['position', port('vec3')]] }),
  node('gradient', 'Gradient', 'pattern', { cost: 2, inputs: [['coordinate', port('float', { required: true })]], outputs: [['value', port('float')]], params: [['start', param('number', { default: 0 })], ['end', param('number', { default: 1 })]] }),
  node('checker', 'Checker', 'pattern', { cost: 4, inputs: [['coordinate', port('vec2', { required: true })], ['a', port('color', { required: true })], ['b', port('color', { required: true })]], outputs: [['color', port('color')]], params: [['scale', param('number', { default: 8, min: 0.001, max: 4096 })]] }),
  node('valueNoise', 'Value Noise', 'noise', { cost: 12, inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['value', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('fbm', 'FBM', 'noise', { cost: 14, inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['value', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })], ['octaves', param('integer', { default: 4, min: 1, max: 12, costMultiplier: 8 })], ['lacunarity', param('number', { default: 2, min: 1, max: 8 })], ['gain', param('number', { default: 0.5, min: 0, max: 1 })]] }),
  node('voronoi', 'Voronoi', 'noise', { cost: 18, inputs: [['coordinate', port('numeric', { required: true })]], outputs: [['distance', port('float')], ['cell', port('float')]], params: [['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('colorRamp', 'Colour Ramp', 'convert', { cost: 6, inputs: [['value', port('float', { required: true })]], outputs: [['color', port('color')]], params: [['stops', param('colorStops', { required: true, minItems: 2, maxItems: 32 })], ['interpolation', param('enum', { values: ['linear', 'constant', 'smoothstep'], default: 'linear' })]] }),
  node('arithmetic', 'Arithmetic', 'math', { cost: 2, inputs: [['a', port('sameNumeric', { required: true })], ['b', port('sameNumeric', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['operation', param('enum', { values: ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'power'], required: true })], ['valueType', param('enum', { values: NUMERIC_TYPES, default: 'float' })]] }),
  node('mix', 'Mix', 'math', { cost: 2, inputs: [['a', port('sameNumeric', { required: true })], ['b', port('sameNumeric', { required: true })], ['factor', port('float', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'color' })]] }),
  node('remap', 'Remap', 'math', { cost: 4, inputs: [['value', port('float', { required: true })]], outputs: [['value', port('float')]], params: [['inMin', param('number', { default: 0 })], ['inMax', param('number', { default: 1 })], ['outMin', param('number', { default: 0 })], ['outMax', param('number', { default: 1 })], ['clamp', param('boolean', { default: true })]] }),
  node('warp', 'Warp', 'filter', { cost: 16, inputs: [['coordinate', port('vec2', { required: true })], ['offset', port('vec2', { required: true })]], outputs: [['coordinate', port('vec2')]], params: [['strength', param('number', { default: 1, min: -1000, max: 1000 })]] }),
  node('blur', 'Blur', 'filter', { cost: 24, inputs: [['value', port('sameNumeric', { required: true })]], outputs: [['value', port('sameNumeric')]], params: [['valueType', param('enum', { values: NUMERIC_TYPES, default: 'color' })], ['radius', param('integer', { default: 2, min: 1, max: 16, costMultiplier: 4 })]] }),
  node('normalFromHeight', 'Normal From Height', 'normal', { cost: 12, inputs: [['height', port('float', { required: true })]], outputs: [['normal', port('vec3')]], params: [['strength', param('number', { default: 1, min: 0, max: 100 })]] }),
  node('channelPack', 'Channel Pack', 'convert', { cost: 4, inputs: [['r', port('float')], ['g', port('float')], ['b', port('float')], ['a', port('float')]], outputs: [['value', port('vec4')]], params: [['defaults', param('numberArray', { length: 4, default: [0, 0, 0, 1], min: 0, max: 1 })]] }),
  ...blenderUtilityNodes(),
  ...blenderProceduralNodes(),
];

const execIn = ['in', port('exec', { required: true })];
const execOut = ['out', port('exec')];
const entityIn = ['entity', port('entityId', { required: true })];
const valueParam = ['valueType', param('enum', { values: VALUE_TYPES, default: 'float' })];

const audioIn = ['audio', port('audio', { required: true })];
const audioOut = ['audio', port('audio')];
const WAVEFORMS = Object.freeze(['sine', 'square', 'sawtooth', 'triangle', 'pulse']);
const NOISE_COLORS = Object.freeze(['white', 'pink', 'brown']);
const FILTER_TYPES = Object.freeze(['lowpass', 'highpass', 'bandpass']);

const audioNodes = [
  node('audio.oscillator', 'Oscillator', 'source', {
    description: 'Periodic waveform source.',
    outputs: [audioOut],
    inputs: [['frequency', port('float')], ['gain', port('float')]],
    params: [
      ['waveform', param('enum', { values: WAVEFORMS, default: 'sine' })],
      ['frequency', param('number', { default: 440, min: 16, max: 8000 })],
      ['gain', param('number', { default: 0.2, min: 0, max: 1 })],
      ['startTime', param('number', { default: 0, min: 0, max: 16 })],
    ],
  }),
  node('audio.noise', 'Noise', 'source', {
    description: 'Seeded noise source.',
    outputs: [audioOut],
    inputs: [['gain', port('float')]],
    params: [
      ['color', param('enum', { values: NOISE_COLORS, default: 'white' })],
      ['gain', param('number', { default: 0.12, min: 0, max: 1 })],
      ['seed', param('integer', { default: 1, min: 1, max: 2147483647 })],
    ],
  }),
  node('audio.sequence', 'Sequence', 'source', {
    description: 'Bounded note sequence rendered as a monophonic oscillator.',
    cost: 4,
    outputs: [audioOut],
    params: [
      ['pattern', param('string', { default: 'C4' })],
      ['waveform', param('enum', { values: WAVEFORMS, default: 'sine' })],
      ['noteDuration', param('number', { default: 0.5, min: 0.05, max: 4 })],
      ['gain', param('number', { default: 0.22, min: 0, max: 1 })],
      ['startTime', param('number', { default: 0, min: 0, max: 16 })],
    ],
  }),
  node('audio.lfo', 'LFO', 'control', {
    description: 'Low-frequency oscillator for control-rate modulation.',
    outputs: [['value', port('float')]],
    params: [
      ['waveform', param('enum', { values: WAVEFORMS, default: 'sine' })],
      ['frequency', param('number', { default: 4, min: 0.01, max: 40 })],
      ['depth', param('number', { default: 1, min: 0, max: 4000 })],
      ['offset', param('number', { default: 0, min: -8000, max: 8000 })],
    ],
  }),
  node('audio.adsr', 'ADSR Envelope', 'time', {
    description: 'Amplitude envelope applied to an audio signal.',
    inputs: [audioIn],
    outputs: [audioOut],
    params: [
      ['attack', param('number', { default: 0.01, min: 0, max: 4 })],
      ['decay', param('number', { default: 0.12, min: 0, max: 8 })],
      ['sustain', param('number', { default: 0.7, min: 0, max: 1 })],
      ['release', param('number', { default: 0.2, min: 0, max: 8 })],
      ['startTime', param('number', { default: 0, min: 0, max: 16 })],
      ['hold', param('number', { default: 0, min: 0, max: 16 })],
    ],
  }),
  node('audio.gain', 'Gain', 'process', {
    inputs: [audioIn, ['gain', port('float')]],
    outputs: [audioOut],
    params: [['gain', param('number', { default: 1, min: 0, max: 4 })]],
  }),
  node('audio.sum', 'Sum', 'process', {
    inputs: [['a', port('audio', { required: true })], ['b', port('audio', { required: true })]],
    outputs: [audioOut],
  }),
  node('audio.mix', 'Mix', 'process', {
    inputs: [['a', port('audio', { required: true })], ['b', port('audio', { required: true })], ['mix', port('float')]],
    outputs: [audioOut],
    params: [['mix', param('number', { default: 0.5, min: 0, max: 1 })]],
  }),
  node('audio.filter', 'Filter', 'process', {
    cost: 2,
    inputs: [audioIn, ['frequency', port('float')]],
    outputs: [audioOut],
    params: [
      ['type', param('enum', { values: FILTER_TYPES, default: 'lowpass' })],
      ['frequency', param('number', { default: 1200, min: 40, max: 8000 })],
      ['q', param('number', { default: 0.7, min: 0.1, max: 12 })],
    ],
  }),
  node('audio.formant', 'Vocal Formants', 'process', {
    description: 'Cascade glottal-tract resonators (F1–F4 plus a nasal pole) approximating a vocal tract.',
    cost: 5,
    inputs: [audioIn],
    outputs: [audioOut],
    params: [
      ['f1', param('number', { default: 700, min: 200, max: 1200 })],
      ['f2', param('number', { default: 1200, min: 600, max: 3000 })],
      ['f3', param('number', { default: 2500, min: 1500, max: 4000 })],
      ['q', param('number', { default: 6, min: 1, max: 12 })],
      ['dry', param('number', { default: 0.12, min: 0, max: 1 })],
    ],
  }),
  node('audio.delay', 'Delay', 'process', {
    cost: 3,
    inputs: [audioIn],
    outputs: [audioOut],
    params: [
      ['time', param('number', { default: 0.18, min: 0.001, max: 1 })],
      ['feedback', param('number', { default: 0.25, min: 0, max: 0.95 })],
      ['mix', param('number', { default: 0.2, min: 0, max: 1 })],
    ],
  }),
  node('audio.saturate', 'Saturate', 'process', {
    inputs: [audioIn],
    outputs: [audioOut],
    params: [['drive', param('number', { default: 1.4, min: 0.1, max: 8 })]],
  }),
  node('audio.pan', 'Pan', 'space', {
    inputs: [audioIn],
    outputs: [audioOut],
    params: [['pan', param('number', { default: 0, min: -1, max: 1 })]],
  }),
  node('audio.panner', 'Positional Panner', 'space', {
    description: 'Equal-power pan and distance attenuation from a listener-relative metre offset.',
    inputs: [audioIn],
    outputs: [audioOut],
    params: [
      ['x', param('number', { default: 0, min: -20, max: 20 })],
      ['y', param('number', { default: 0, min: -20, max: 20 })],
      ['z', param('number', { default: 0, min: -20, max: 20 })],
    ],
  }),
];

const blueprintNodes = [
  node('event.onStart', 'On Start', 'event', { outputs: [execOut], tags: ['event-root'] }),
  node('event.onActivate', 'On Activate', 'event', { outputs: [execOut], tags: ['event-root', 'controller-event'] }),
  node('event.onDeactivate', 'On Deactivate', 'event', { outputs: [execOut], tags: ['event-root', 'controller-event'] }),
  node('event.onFixedUpdate', 'On Fixed Update', 'event', { outputs: [execOut, ['delta', port('float')]], tags: ['event-root'] }),
  node('event.onUpdate', 'On Update', 'event', { outputs: [execOut, ['delta', port('float')]], tags: ['event-root'] }),
  node('event.onKeyPressed', 'On Key Pressed', 'event', { outputs: [execOut], params: [['key', param('identifier', { required: true })]], tags: ['event-root', 'controller-event'] }),
  node('event.onKeyDown', 'On Key Down', 'event', { outputs: [execOut, ['delta', port('float')]], params: [['key', param('identifier', { required: true })]], tags: ['event-root', 'controller-event'] }),
  node('event.onKeyUp', 'On Key Up', 'event', { outputs: [execOut], params: [['key', param('identifier', { required: true })]], tags: ['event-root', 'controller-event'] }),
  node('event.onCollisionEnter', 'On Collision Enter', 'event', { outputs: [execOut, ['other', port('entityId')], ['normal', port('vec3')]], tags: ['event-root', 'physics-event'] }),
  node('event.onCollisionExit', 'On Collision Exit', 'event', { outputs: [execOut, ['other', port('entityId')]], tags: ['event-root', 'physics-event'] }),
  node('event.onInput', 'On Input', 'event', { outputs: [execOut, ['pressed', port('boolean')], ['value', port('float')]], params: [['action', param('identifier', { required: true })]], tags: ['event-root'] }),
  node('event.onEvent', 'On Event', 'event', { outputs: [execOut, ['payload', port('eventPayload')]], params: [['eventId', param('stableId', { required: true })]], tags: ['event-root'] }),
  node('event.payloadNumber', 'Payload Number', 'event', { inputs: [['payload', port('eventPayload', { required: true })]], outputs: [['value', port('float')]], params: [['field', param('identifier', { required: true })]] }),
  node('time.delay', 'Delay', 'time', { cost: 2, inputs: [execIn, ['seconds', port('float', { required: true })]], outputs: [execOut], tags: ['time-boundary'] }),
  node('time.timer', 'Timer', 'time', { cost: 3, inputs: [execIn, ['seconds', port('float', { required: true })]], outputs: [['tick', port('exec')], ['complete', port('exec')]], params: [['repeatCount', param('integer', { default: 1, min: 1, max: 100000 })]], tags: ['time-boundary'] }),
  node('flow.branch', 'Branch', 'flow', { inputs: [execIn, ['condition', port('boolean', { required: true })]], outputs: [['true', port('exec')], ['false', port('exec')]] }),
  node('flow.boundedLoop', 'Bounded Loop', 'flow', { cost: 3, inputs: [execIn, ['count', port('integer', { required: true })]], outputs: [['body', port('exec')], ['index', port('integer')], ['complete', port('exec')]], params: [['maxIterations', param('integer', { default: 128, min: 1, max: 4096, costMultiplier: 1 })]], tags: ['bounded-loop'] }),
  node('compare.values', 'Compare', 'logic', { inputs: [['a', port('sameValue', { required: true })], ['b', port('sameValue', { required: true })]], outputs: [['result', port('boolean')]], params: [valueParam, ['operation', param('enum', { values: ['equal', 'notEqual', 'less', 'lessEqual', 'greater', 'greaterEqual'], required: true })]] }),
  node('value.constant', 'Constant', 'value', { outputs: [['value', port('sameValue')]], params: [valueParam, ['value', param('typedValue', { required: true })]] }),
  node('value.add', 'Add Numbers', 'value', { inputs: [['a', port('float', { required: true })], ['b', port('float', { required: true })]], outputs: [['value', port('float')]] }),
  node('value.math', 'Scalar Math', 'value', {
    description: 'Finite scalar arithmetic. clamp uses a as value and b/c as lower/upper bounds. Invalid division and square root return zero; results saturate to +/-1e12.',
    inputs: [['a', port('float', { required: true })], ['b', port('float')], ['c', port('float')]],
    outputs: [['value', port('float')]],
    params: [['operation', param('enum', { values: ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'clamp', 'abs', 'negate', 'sign', 'sqrt', 'sin', 'cos', 'tan', 'atan'], required: true })]],
  }),
  node('value.select', 'Select Value', 'value', { inputs: [['condition', port('boolean', { required: true })], ['whenTrue', port('sameValue', { required: true })], ['whenFalse', port('sameValue', { required: true })]], outputs: [['value', port('sameValue')]], params: [valueParam] }),
  node('vector.compose', 'Compose Vector', 'value', { inputs: [['x', port('float')], ['y', port('float')], ['z', port('float')]], outputs: [['vector', port('vec3')]] }),
  node('vector.component', 'Vector Component', 'value', { inputs: [['vector', port('vec3', { required: true })]], outputs: [['value', port('float')]], params: [['component', param('enum', { values: ['x', 'y', 'z'], required: true })]] }),
  node('input.keyHeld', 'Key Held', 'input', { description: 'Reads the transient controller input state; value is 1 while held and 0 otherwise.', outputs: [['held', port('boolean')], ['value', port('float')]], params: [['key', param('identifier', { required: true })]] }),
  node('state.get', 'Get State', 'state', { outputs: [['value', port('sameValue')]], params: [['key', param('stableId', { required: true })], valueParam] }),
  node('state.set', 'Set State', 'state', { inputs: [execIn, ['value', port('sameValue', { required: true })]], outputs: [execOut], params: [['key', param('stableId', { required: true })], valueParam] }),
  node('event.emit', 'Emit Event', 'event', { inputs: [execIn, ['payload', port('eventPayload')]], outputs: [execOut], params: [['eventId', param('stableId', { required: true })]] }),
  node('event.emitOnce', 'Emit Event Once', 'event', { inputs: [execIn, ['payload', port('eventPayload')]], outputs: [execOut], params: [['eventId', param('stableId', { required: true })]] }),
  node('entity.self', 'Self', 'entity', { outputs: [['entity', port('entityId')]] }),
  node('entity.reference', 'Entity Reference', 'entity', { outputs: [['entity', port('entityId')]], params: [['entityId', param('stableId', { required: true })]] }),
  node('component.has', 'Has Component', 'component', { inputs: [entityIn], outputs: [['value', port('boolean')]], params: [['component', param('enum', { values: ['logic', 'camera', 'rigidBody', 'collider', 'mesh', 'animation', 'audio'], required: true })]] }),
  node('entity.getProperty', 'Get Entity Property', 'entity', { inputs: [entityIn], outputs: [['value', port('entityProperty')]], params: [['property', param('enum', { values: ['position', 'rotation', 'scale', 'visible'], required: true })]] }),
  node('entity.setProperty', 'Set Entity Property', 'entity', { inputs: [execIn, entityIn, ['value', port('entityProperty', { required: true })]], outputs: [execOut], params: [['property', param('enum', { values: ['position', 'rotation', 'scale', 'visible'], required: true })]] }),
  node('transform.set', 'Set Transform', 'transform', { inputs: [execIn, entityIn, ['position', port('vec3')], ['rotation', port('vec3')], ['scale', port('vec3')]], outputs: [execOut] }),
  node('transform.translate', 'Translate', 'transform', { inputs: [execIn, entityIn, ['offset', port('vec3', { required: true })]], outputs: [execOut], params: [['space', param('enum', { values: ['local', 'world'], default: 'local' })]] }),
  node('transform.rotate', 'Rotate', 'transform', { inputs: [execIn, entityIn, ['radians', port('vec3', { required: true })]], outputs: [execOut], params: [['space', param('enum', { values: ['local', 'world'], default: 'local' })]] }),
  node('motion.setSpeed', 'Set Speed', 'motion', { inputs: [execIn, entityIn, ['speed', port('float', { required: true })]], outputs: [execOut] }),
  node('motion.getSpeed', 'Get Speed', 'motion', { description: 'Reads the transient commanded speed in metres per second; positive speed moves along local -Z.', inputs: [entityIn], outputs: [['speed', port('float')]] }),
  node('motion.addSpeed', 'Add Speed', 'motion', { inputs: [execIn, entityIn, ['speed', port('float', { required: true })]], outputs: [execOut] }),
  node('motion.setAngularSpeed', 'Set Angular Speed', 'motion', { inputs: [execIn, entityIn, ['radiansPerSecond', port('vec3', { required: true })]], outputs: [execOut] }),
  node('physics.getVelocity', 'Get Velocity', 'physics', { inputs: [entityIn], outputs: [['velocity', port('vec3')]] }),
  node('physics.setVelocity', 'Set Velocity', 'physics', { inputs: [execIn, entityIn, ['velocity', port('vec3', { required: true })]], outputs: [execOut] }),
  node('physics.setAngularVelocity', 'Set Angular Velocity', 'physics', { inputs: [execIn, entityIn, ['velocity', port('vec3', { required: true })]], outputs: [execOut] }),
  node('physics.addForce', 'Add Force', 'physics', { inputs: [execIn, entityIn, ['force', port('vec3', { required: true })]], outputs: [execOut], params: [['space', param('enum', { values: ['local', 'world'], default: 'world' })]] }),
  node('physics.addImpulse', 'Add Impulse', 'physics', { inputs: [execIn, entityIn, ['impulse', port('vec3', { required: true })]], outputs: [execOut], params: [['space', param('enum', { values: ['local', 'world'], default: 'world' })]] }),
  node('physics.setGravityScale', 'Set Gravity Scale', 'physics', { inputs: [execIn, entityIn, ['scale', port('float', { required: true })]], outputs: [execOut] }),
  node('visibility.set', 'Set Visibility', 'entity', { inputs: [execIn, entityIn, ['visible', port('boolean', { required: true })]], outputs: [execOut] }),
  node('entity.spawn', 'Spawn', 'entity', { cost: 4, inputs: [execIn, ['position', port('vec3')]], outputs: [execOut, ['entity', port('entityId')]], params: [['prefabId', param('stableId', { required: true })]] }),
  node('entity.destroy', 'Destroy', 'entity', { inputs: [execIn, entityIn], outputs: [execOut] }),
  node('entity.reparent', 'Reparent', 'entity', { inputs: [execIn, entityIn, ['parent', port('entityId', { required: true })]], outputs: [execOut] }),
  node('animation.play', 'Play Animation', 'animation', { inputs: [execIn, entityIn], outputs: [execOut, ['complete', port('exec')]], params: [['clipId', param('stableId', { required: true })], ['loop', param('boolean', { default: false })], ['speed', param('number', { default: 1, min: -16, max: 16 })], ['restart', param('boolean', { default: true })]] }),
  node('animation.stop', 'Stop Animation', 'animation', { inputs: [execIn, entityIn], outputs: [execOut], params: [['clipId', param('stableId', { required: true })]] }),
  node('audio.play', 'Play Audio', 'audio', { inputs: [execIn, entityIn], outputs: [execOut], params: [['audioId', param('stableId', { required: true })], ['volume', param('number', { default: 1, min: 0, max: 4 })]] }),
  node('audio.stop', 'Stop Audio', 'audio', { inputs: [execIn, entityIn], outputs: [execOut] }),
  node('camera.setActive', 'Set Active Camera', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })]], outputs: [execOut] }),
  node('camera.lookAt', 'Look At', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })], ['target', port('vec3', { required: true })]], outputs: [execOut] }),
  node('camera.lookAtEntity', 'Look At Entity', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })], ['target', port('entityId', { required: true })]], outputs: [execOut] }),
  node('camera.followEntity', 'Follow Entity', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })], ['target', port('entityId', { required: true })], ['offset', port('vec3')], ['smoothing', port('float')]], outputs: [execOut], params: [['space', param('enum', { values: ['local', 'world'], default: 'world' })]] }),
  node('camera.clearFollow', 'Clear Camera Follow', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })]], outputs: [execOut] }),
  node('camera.setFov', 'Set Camera FOV', 'camera', { inputs: [execIn, ['camera', port('entityId', { required: true })], ['degrees', port('float', { required: true })]], outputs: [execOut] }),
  node('material.setParameter', 'Set Material Parameter', 'material', { inputs: [execIn, ['value', port('sameValue', { required: true })]], outputs: [execOut], params: [['materialId', param('stableId', { required: true })], ['parameter', param('identifier', { required: true })], valueParam] }),
  node('layout.array', 'Seeded Array', 'layout', { cost: 8, inputs: [execIn], outputs: [execOut, ['entities', port('eventPayload')]], params: [['prefabId', param('stableId', { required: true })], ['count', param('integer', { required: true, min: 1, max: 8192 })], ['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('layout.grid', 'Grid', 'layout', { cost: 8, inputs: [execIn], outputs: [execOut, ['entities', port('eventPayload')]], params: [['prefabId', param('stableId', { required: true })], ['columns', param('integer', { required: true, min: 1, max: 1024 })], ['rows', param('integer', { required: true, min: 1, max: 1024 })], ['spacing', param('numberArray', { length: 2, default: [1, 1], min: 0, max: 1e6 })]] }),
  node('layout.scatter', 'Seeded Scatter', 'layout', { cost: 16, inputs: [execIn], outputs: [execOut, ['entities', port('eventPayload')]], params: [['prefabId', param('stableId', { required: true })], ['count', param('integer', { required: true, min: 1, max: 8192 })], ['seed', param('integer', { required: true, min: 0, max: 2147483647 })], ['generatorId', param('stableId', { required: true })]] }),
  node('layout.alongCurve', 'Along Curve', 'layout', { cost: 12, inputs: [execIn], outputs: [execOut, ['entities', port('eventPayload')]], params: [['prefabId', param('stableId', { required: true })], ['curveId', param('stableId', { required: true })], ['count', param('integer', { required: true, min: 1, max: 8192 })], ['seed', param('integer', { default: 0, min: 0, max: 2147483647 })]] }),
  node('prefab.instantiate', 'Instantiate Prefab', 'prefab', { cost: 4, inputs: [execIn, ['position', port('vec3')]], outputs: [execOut, ['entity', port('entityId')]], params: [['prefabId', param('stableId', { required: true })]] }),
  node('script.callExposed', 'Call Exposed Function', 'script', { cost: 4, inputs: [execIn, ['arguments', port('eventPayload')]], outputs: [execOut, ['result', port('eventPayload')]], params: [['functionId', param('stableId', { required: true })]], tags: ['capability-call'] }),
];

const output = (types, stage, colorSpace = null) => Object.freeze({ types: Object.freeze(types), stage, ...(colorSpace ? { colorSpace } : {}) });

export const GRAPH_OUTPUTS = Object.freeze({
  shader: Object.freeze({
    surface: output(['surface'], 'fragment'),
    baseColor: output(['color', 'vec3'], 'fragment'),
    roughness: output(['float'], 'fragment'),
    metalness: output(['float'], 'fragment'),
    normal: output(['vec3'], 'fragment'),
    emissive: output(['color', 'vec3'], 'fragment'),
    opacity: output(['float'], 'fragment'),
    alphaTest: output(['float'], 'fragment'),
    positionOffset: output(['vec3'], 'vertex'),
  }),
  texture: Object.freeze({
    albedo: output(['color', 'vec3', 'vec4'], 'texture', 'srgb'),
    emissive: output(['color', 'vec3', 'vec4'], 'texture', 'srgb'),
    normal: output(['vec3'], 'texture', 'none'),
    roughness: output(['float'], 'texture', 'none'),
    metalness: output(['float'], 'texture', 'none'),
    height: output(['float'], 'texture', 'none'),
    mask: output(['float'], 'texture', 'none'),
    data: output(['float', 'vec2', 'vec3', 'vec4', 'color'], 'texture', 'none'),
  }),
  blueprint: Object.freeze({}),
  audio: Object.freeze({
    mix: output(['audio'], 'audio'),
  }),
});

function expandCatalogNodes(nodes) {
  const expanded = new Map();
  const register = (type, definition) => {
    if (expanded.has(type)) throw new TypeError(`Duplicate graph node type or alias: ${type}`);
    expanded.set(type, definition);
  };
  for (const definition of nodes) {
    register(definition.type, definition);
    for (const alias of definition.aliases ?? []) {
      const aliases = [definition.type, ...(definition.aliases ?? []).filter((entry) => entry !== alias)];
      register(alias, deepFreeze({
        ...definition,
        type: alias,
        canonicalType: definition.canonicalType ?? definition.type,
        aliases: Object.freeze(aliases),
      }));
    }
  }
  return Object.freeze(Object.fromEntries(expanded));
}

const makeCatalog = (domain, nodes) => Object.freeze({
  domain,
  version: 1,
  nodes: expandCatalogNodes(nodes),
  outputs: GRAPH_OUTPUTS[domain],
});

export const GRAPH_CATALOGS = Object.freeze({
  shader: makeCatalog('shader', shaderNodes),
  texture: makeCatalog('texture', textureNodes),
  blueprint: makeCatalog('blueprint', blueprintNodes),
  audio: makeCatalog('audio', audioNodes),
});

export { VALUE_TYPES, NUMERIC_TYPES };

function compactPort(definition) {
  return definition.required ? `${definition.type}!` : definition.type;
}

function compactNode(definition, includeDescriptions) {
  const socketMetadata = (entries) => Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, {
    name: value.blenderName ?? name,
    identifier: value.blenderIdentifier ?? value.blenderName ?? name,
    type: value.type,
    ...(value.aliases?.length ? { aliases: value.aliases } : {}),
    ...(value.required ? { required: true } : {}),
    ...(Object.hasOwn(value, 'default') ? { default: value.default } : {}),
    ...(Object.hasOwn(value, 'newNodeDefault') ? { newNodeDefault: value.newNodeDefault } : {}),
    ...(Object.hasOwn(value, 'rnaDefault') ? { rnaDefault: value.rnaDefault } : {}),
    ...(Object.hasOwn(value, 'min') ? { min: value.min } : {}),
    ...(Object.hasOwn(value, 'max') ? { max: value.max } : {}),
    ...(value.unit ? { unit: value.unit } : {}),
  }]));
  const parameterMetadata = () => Object.fromEntries(Object.entries(definition.params).map(([name, value]) => [name, {
    type: value.type,
    ...(value.values ? { values: value.values } : {}),
    ...(value.channels ? { channels: value.channels } : {}),
    ...(value.extendValues ? { extendValues: value.extendValues } : {}),
    ...(value.handleTypes ? { handleTypes: value.handleTypes } : {}),
    ...(value.required ? { required: true } : {}),
    ...(Object.hasOwn(value, 'default') ? { default: value.default } : {}),
    ...(Object.hasOwn(value, 'min') ? { min: value.min } : {}),
    ...(Object.hasOwn(value, 'max') ? { max: value.max } : {}),
    ...(Object.hasOwn(value, 'minItems') ? { minItems: value.minItems } : {}),
    ...(Object.hasOwn(value, 'maxItems') ? { maxItems: value.maxItems } : {}),
  }]));
  return {
    type: definition.type,
    label: definition.label,
    category: definition.category,
    cost: definition.cost,
    ...(definition.stages.length ? { stages: definition.stages } : {}),
    inputs: Object.fromEntries(Object.entries(definition.inputs).map(([name, value]) => [name, compactPort(value)])),
    outputs: Object.fromEntries(Object.entries(definition.outputs).map(([name, value]) => [name, value.type])),
    params: Object.fromEntries(Object.entries(definition.params).map(([name, value]) => [name, value.type === 'enum' ? value.values : value.type])),
    ...(definition.blenderId ? {
      blender: {
        id: definition.blenderId,
        canonicalType: definition.canonicalType ?? definition.type,
        aliases: definition.aliases ?? [],
      },
      sockets: {
        inputs: socketMetadata(definition.inputs),
        outputs: socketMetadata(definition.outputs),
      },
      parameterMetadata: parameterMetadata(),
    } : {}),
    ...(includeDescriptions && definition.description ? { description: definition.description } : {}),
  };
}

export function queryGraphCatalog(domain, options = {}) {
  const catalog = GRAPH_CATALOGS[domain];
  if (!catalog) throw new TypeError(`Unknown graph domain: ${domain}`);
  const search = String(options.search ?? '').trim().toLowerCase();
  const categories = options.categories ? new Set(options.categories) : null;
  const types = options.types ? new Set(options.types) : null;
  const limit = Math.max(1, Math.min(64, Number.isInteger(options.limit) ? options.limit : 64));
  const matches = Object.values(catalog.nodes)
    .filter((entry) => !types || types.has(entry.type))
    .filter((entry) => !categories || categories.has(entry.category))
    .filter((entry) => !search || `${entry.type} ${entry.label} ${entry.category} ${entry.description} ${(entry.aliases ?? []).join(' ')} ${entry.tags.join(' ')}`.toLowerCase().includes(search))
    .sort((a, b) => {
      const compatibilityOrder = Number(Boolean(a.blenderId)) - Number(Boolean(b.blenderId));
      return compatibilityOrder || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
    })
    .slice(0, limit)
    .map((entry) => compactNode(entry, options.includeDescriptions === true));
  return {
    domain,
    version: catalog.version,
    total: Object.keys(catalog.nodes).length,
    returned: matches.length,
    nodes: matches,
    outputs: catalog.outputs,
    authoring: {
      resourceType: 'graphs',
      canonicalEnvelope: {
        id: 'graph/example',
        kind: 'graph',
        name: 'Example Graph',
        metadata: {},
        graph: {
          formatVersion: 1,
          id: 'graph/example',
          domain,
          nodes: [],
          edges: [],
          outputs: {},
        },
      },
      edgePortShape: {
        from: { nodeId: 'source-node', port: 'outputPort' },
        to: { nodeId: 'target-node', port: 'inputPort' },
      },
      guidance: 'Create graph resources with the graph control document nested under resource.graph. Every edge uses from/to objects with nodeId and port; use the returned node sockets exactly.',
    },
  };
}

export function getGraphNode(domain, type) {
  return GRAPH_CATALOGS[domain]?.nodes[type] ?? null;
}
