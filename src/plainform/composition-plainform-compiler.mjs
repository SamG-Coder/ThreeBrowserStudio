const clean = value => value.trim().replace(/[.;]+$/u, '').trim();
const slug = value => clean(value).toLowerCase().replace(/^(?:the|a|an)\s+/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function resolveSubject(scene, value) {
  const wanted = slug(value); const matches = Object.values(scene.entities).filter(entity => entity.id === clean(value) || slug(entity.name) === wanted || slug(entity.id.split('/').at(-1)) === wanted);
  if (matches.length !== 1) fail(matches.length ? 'plainform_composition_subject_ambiguous' : 'plainform_composition_subject_missing', `Composition subject “${value}” must resolve exactly once.`);
  return matches[0];
}
const lensFov = millimetres => 2 * Math.atan(36 / (2 * millimetres)) * 180 / Math.PI;

export class CompositionPlainformCompiler {
  compile(source, { project } = {}) {
    const scene = project?.scenes?.[project.activeSceneId]; if (!scene) fail('plainform_project_required', 'Composition Plainform requires an active scene.');
    const match = source.replace(/\s+/gu, ' ').trim().match(/^frame the whole (.+?) from (slightly below|eye level|slightly above) at a (\d+(?:\.\d+)?) millimetre lens\. use late afternoon sun from camera left, soft blue sky fill, a (.+?) ground, and enough depth of field to keep the (.+?) and (.+?) sharp\.?$/iu);
    if (!match) fail('plainform_composition_unsupported', 'Use the bounded hero-composition sentence with subject, angle, lens, ground, and sharp semantic extents.');
    const subject = resolveSubject(scene, match[1]); const lens = Number(match[3]); if (!(lens >= 12 && lens <= 300)) fail('plainform_composition_lens', 'Composition lens must be 12 to 300 millimetres.');
    const compositionSlug = slug(subject.name); const cameraId = scene.settings.activeCameraId ?? `camera/composition/${compositionSlug}`;
    const rigId = `entity/composition/${compositionSlug}/light-rig`; const groundId = `entity/composition/${compositionSlug}/ground`;
    const groundGeometryId = `geometry/composition/${compositionSlug}/ground`; const groundMaterialId = `material/composition/${compositionSlug}/ground`;
    const assetId = `asset/composition/${compositionSlug}`; const elevation = ({ 'slightly below': -0.12, 'eye level': 0, 'slightly above': 0.18 })[match[2].toLowerCase()];
    const diagnostics = [
      { code: 'PLAINFORM_COMPOSITION_DOF_FALLBACK', severity: 'information', hosts: ['native', 'browser'], message: 'Depth-of-field intent is stored canonically; raster preview keeps the resolved trunk-to-crown focus range sharp without a post-process blur.' },
      { code: 'PLAINFORM_COMPOSITION_ENVIRONMENT_FALLBACK', severity: 'information', hosts: ['browser'], message: 'Browser preview uses the same outdoor light entities and linear background; environment importance sampling remains a native capability difference.' },
    ];
    const presentation = {
      formatVersion: 1, kind: 'presentation', subject: { entityId: subject.id, semanticBounds: ['whole', slug(match[5]), slug(match[6])] },
      camera: { cameraId, angle: match[2].toLowerCase(), lensMillimetres: lens, fieldOfViewDegrees: lensFov(lens), lookTarget: 'semantic-bounds-center', aspect: 16 / 9 },
      lighting: { rigId, timeOfDay: 'lateAfternoon', key: { role: 'sun', direction: 'cameraLeft', unit: 'lux', illuminance: 32000 }, fill: { role: 'sky', color: [0.45, 0.65, 1], unit: 'relative', intensity: 0.75 } },
      environment: { ground: { entityId: groundId, description: clean(match[4]) }, backdrop: 'softBlueSky', fog: { mode: 'linear', near: 80, far: 450 }, exposure: 1 },
      depthOfField: { mode: 'semanticRange', nearSemantic: slug(match[5]), farSemantic: slug(match[6]), fallback: 'keep-range-sharp' }, diagnostics,
    };
    const operations = [];
    const createResources = [];
    if (!project.resources.geometries?.[groundGeometryId]) createResources.push({ resourceType: 'geometries', resource: { id: groundGeometryId, recipe: { kind: 'box', width: 30, height: 0.1, depth: 30 } } });
    if (!project.resources.materials?.[groundMaterialId]) createResources.push({ resourceType: 'materials', resource: { id: groundMaterialId, recipe: { kind: 'physical', color: '#8a7a49', roughness: 0.96, metalness: 0 } } });
    if (!project.resources.assets?.[assetId]) createResources.push({ resourceType: 'assets', resource: { id: assetId, kind: 'presentation', name: `${subject.name} Hero Composition`, presentation } });
    if (createResources.length) operations.push({ op: 'resource.createMany', items: createResources });
    else operations.push({ op: 'resource.patch', resourceType: 'assets', resourceId: assetId, patch: { presentation } });
    if (!scene.entities[cameraId]) operations.push({ op: 'entity.create', sceneId: scene.id, entity: { id: cameraId, kind: 'perspectiveCamera', name: `${subject.name} Hero Camera`, components: { camera: { fov: lensFov(lens), near: 0.1, far: 1000 } }, metadata: { compositionAssetId: assetId } } });
    else operations.push({ op: 'entity.patch', entityId: cameraId, patch: { components: { camera: { ...scene.entities[cameraId].components?.camera, fov: lensFov(lens) } }, metadata: { ...scene.entities[cameraId].metadata, compositionAssetId: assetId } } });
    if (!scene.entities[groundId]) operations.push({ op: 'entity.create', sceneId: scene.id, entity: { id: groundId, kind: 'mesh', name: `${clean(match[4])} ground`, transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: { mesh: { geometryId: groundGeometryId, materialId: groundMaterialId } }, metadata: { compositionAssetId: assetId } } });
    if (!scene.entities[rigId]) operations.push({ op: 'lighting.rig.create', sceneId: scene.id, rigId, preset: 'outdoor', center: [0, 0, 0], scale: 1, intensity: 1, rtx: 'auto' });
    operations.push({ op: 'camera.frame', cameraId, target: { targetIds: [subject.id] }, aspect: 16 / 9, padding: 1.12, view: { azimuth: -0.55, elevation, distanceScale: 1.15, targetOffset: [0, 0, 0], minHeight: 0.2 }, lockPreviewAspect: true });
    operations.push({ op: 'scene.setActiveCamera', sceneId: scene.id, cameraId });
    operations.push({ op: 'scene.settings.patch', sceneId: scene.id, patch: { background: { mode: 'color', color: [0.32, 0.52, 0.78], colorSpace: 'linear-srgb' }, fog: { mode: 'linear', color: [0.42, 0.58, 0.76], near: 80, far: 450 }, presentation: { assetId, exposure: 1, depthOfField: presentation.depthOfField } } });
    return Object.freeze({ language: 'plainform-v1', dialect: 'composition', source, operations: Object.freeze(operations), interpretation: Object.freeze([`Frame ${subject.id} at ${lens} mm from ${match[2].toLowerCase()}.`, 'Create a typed late-afternoon outdoor presentation with explicit host fallbacks.']), aliases: Object.freeze({}), requestedPreview: true, composition: Object.freeze({ assetId, cameraId, subjectId: subject.id, diagnostics: Object.freeze(diagnostics) }) });
  }
}
