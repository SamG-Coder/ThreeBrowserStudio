export { createFallbackMaterial, createGeometry, createMaterial, ensureGeneratedCoordinateAttribute, normalizeGeometryRecipe } from './resource-factories.mjs';
export { compileSceneDocument } from './scene-compiler.mjs';
export {
  BLENDER_SHADER_NODE_ALIASES,
  ShaderGraphCompileError,
  compileShaderGraph,
  isCompiledSurface,
} from './shader-graph-compiler.mjs';
export { applyConstraintStacks, evaluateInstanceStack } from './object-evaluation.mjs';
export * from './rtx-scene-collector.mjs';
export * from './animation-runtime.mjs';
export * from './procedural-texture-compiler.mjs';
export * from './image-texture-resources.mjs';
export * from './blender-curve-mapping.mjs';
export { StudioApplication, startStudioApplication, translateToolOperation } from './studio-application.mjs';
