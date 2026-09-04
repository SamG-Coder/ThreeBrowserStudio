import { createHash } from 'node:crypto';
import { StudioError } from './errors.mjs';
import { assertStableId } from './ids.mjs';
import { validateIndexedMeshRecipe } from './indexed-mesh-editing.mjs';
import { decodePngRgba } from './png-rgba.mjs';
import { normalizeDataTextureResource, dataTextureSerializedByteLength, DATA_TEXTURE_LIMITS } from './image-texture.mjs';
import { decomposeTransformMatrix } from './transform-math.mjs';

export const SCENE_IMPORT_LIMITS = Object.freeze({ maxFileBytes: 64 * 1024 * 1024,
  maxJsonBytes: 4 * 1024 * 1024, maxNodes: 4096, maxEntities: 8192, maxPrimitives: 2048,
  maxVertices: 1_000_000, maxTriangles: 2_000_000, maxDepth: 128,
  maxTextureBytes: 16 * 1024 * 1024 });

const fail = (message, code = 'scene_import_unsupported') => { throw new StudioError(code, message); };
const list = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${name} must be an array.`, 'scene_import_invalid');
  return value;
};
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} is outside its supported range.`, 'scene_import_invalid');
  return value;
}
function finiteArray(value, count, name, min = -1e6, max = 1e6) {
  if (!Array.isArray(value) || value.length !== count || value.some(n => !Number.isFinite(n) || n < min || n > max)) fail(`${name} must contain ${count} bounded finite numbers.`, 'scene_import_invalid');
  return [...value];
}

function readGlb(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 20 || bytes.length > SCENE_IMPORT_LIMITS.maxFileBytes) fail('GLB file exceeds its size budget or is truncated.', 'scene_import_budget');
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('Expected a complete GLB version 2 file.', 'scene_import_invalid');
  let json; let binary = Buffer.alloc(0); let sawBinary = false;
  for (let offset = 12, chunk = 0; offset < bytes.length; chunk++) {
    if (offset + 8 > bytes.length) fail('Truncated GLB chunk.', 'scene_import_invalid');
    const length = bytes.readUInt32LE(offset); const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) fail('Invalid GLB chunk alignment or length.', 'scene_import_invalid');
    if (chunk === 0 && type !== 0x4e4f534a) fail('The first GLB chunk must be JSON.', 'scene_import_invalid');
    if (type === 0x4e4f534a) {
      if (json || length > SCENE_IMPORT_LIMITS.maxJsonBytes) fail('Duplicate or oversized GLB JSON chunk.', 'scene_import_budget');
      try { json = JSON.parse(bytes.toString('utf8', offset, offset + length)); }
      catch { fail('Invalid GLB JSON.', 'scene_import_invalid'); }
    } else if (type === 0x004e4942) {
      if (sawBinary) fail('Duplicate GLB binary chunk.', 'scene_import_invalid');
      binary = bytes.subarray(offset, offset + length); sawBinary = true;
    }
    offset += length;
  }
  if (json?.asset?.version !== '2.0') fail('Only glTF 2.0 assets are supported.');
  if (json.asset.minVersion && json.asset.minVersion !== '2.0') fail('The asset requires a newer glTF version.');
  const buffers = list(json.buffers, 'buffers');
  if (buffers.length > 1 || buffers.some(b => b.uri !== undefined)) fail('Only a self-contained GLB binary buffer is supported; external URIs are never fetched.');
  const byteLength = buffers.length ? integer(buffers[0].byteLength, 0, binary.length, 'buffer.byteLength') : 0;
  if (binary.length - byteLength > 3) fail('GLB binary length does not match its declared buffer.', 'scene_import_invalid');
  return { json, binary: binary.subarray(0, byteLength), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function transform(node) {
  if (node.matrix !== undefined) {
    if (node.translation || node.rotation || node.scale) fail('A node cannot contain both matrix and TRS.', 'scene_import_invalid');
    return decomposeTransformMatrix(finiteArray(node.matrix, 16, 'node.matrix'), { shearTolerance: 1e-6, reconstructionTolerance: 1e-6 });
  }
  const position = finiteArray(node.translation ?? [0, 0, 0], 3, 'node.translation');
  const scale = finiteArray(node.scale ?? [1, 1, 1], 3, 'node.scale');
  if (scale.some(n => n === 0)) fail('Zero-scale nodes cannot be represented by Studio.');
  const q = finiteArray(node.rotation ?? [0, 0, 0, 1], 4, 'node.rotation', -1, 1);
  if (Math.abs(Math.hypot(...q) - 1) > 1e-5) fail('Node quaternion must be normalized.', 'scene_import_invalid');
  const [x, y, z, w] = q; const s = scale;
  return decomposeTransformMatrix([
    (1 - 2 * (y*y + z*z))*s[0], 2*(x*y + z*w)*s[0], 2*(x*z - y*w)*s[0], 0,
    2*(x*y - z*w)*s[1], (1 - 2*(x*x + z*z))*s[1], 2*(y*z + x*w)*s[1], 0,
    2*(x*z + y*w)*s[2], 2*(y*z - x*w)*s[2], (1 - 2*(x*x + y*y))*s[2], 0,
    ...position, 1,
  ], { shearTolerance: 1e-5, reconstructionTolerance: 1e-5 });
}

/** Decode supported GLB content into canonical typed resources and a new scene.
 * No runtime UUIDs, JavaScript, local source paths, or external references survive.
 */
export function importGlbScene(input, { sceneId, idPrefix, name = 'Imported GLB', sourceName = 'asset.glb', expectedSha256 } = {}) {
  assertStableId(sceneId, 'sceneId'); assertStableId(idPrefix, 'idPrefix');
  if (idPrefix.length > 80) fail('Import ID prefix must be at most 80 characters.', 'scene_import_invalid');
  const { json: gltf, binary, sha256 } = readGlb(input);
  if (expectedSha256 && sha256 !== expectedSha256) fail('GLB checksum changed; inspect the intended file again.', 'scene_import_hash_mismatch');
  const supportedExtensions = ['KHR_materials_clearcoat', 'KHR_materials_ior', 'KHR_materials_transmission'];
  for (const ext of list(gltf.extensionsRequired, 'extensionsRequired')) if (!supportedExtensions.includes(ext)) fail(`Required extension ${ext} is not supported.`);
  if (list(gltf.animations, 'animations').length || list(gltf.skins, 'skins').length) fail('Animation and skin import are not implemented; export a static rigid-part asset.');
  const warnings = list(gltf.extensionsUsed, 'extensionsUsed').filter(e => !supportedExtensions.includes(e)).map(e => ({ code: 'scene_import_optional_extension', message: `Optional extension ${e} is omitted.` }));
  const nodes = list(gltf.nodes, 'nodes'); const views = list(gltf.bufferViews, 'bufferViews'); const accessors = list(gltf.accessors, 'accessors');
  if (nodes.length > SCENE_IMPORT_LIMITS.maxNodes) fail('GLB node budget exceeded.', 'scene_import_budget');
  const get = (items, index, label) => items[integer(index, 0, items.length - 1, label)];
  function viewBytes(index) {
    const view = get(views, index, 'bufferView');
    if (view.buffer !== 0) fail('Buffer view must reference GLB buffer 0.', 'scene_import_invalid');
    const start = integer(view.byteOffset ?? 0, 0, binary.length, 'bufferView.byteOffset');
    const length = integer(view.byteLength, 1, binary.length - start, 'bufferView.byteLength');
    return { bytes: binary.subarray(start, start + length), view, start };
  }
  const component = { 5120: [1, 'readInt8', 127], 5121: [1, 'readUInt8', 255], 5122: [2, 'readInt16LE', 32767], 5123: [2, 'readUInt16LE', 65535], 5125: [4, 'readUInt32LE', 4294967295], 5126: [4, 'readFloatLE', null] };
  const accessorCache = new Map();
  function accessor(index, type, allowed) {
    const a = get(accessors, index, 'accessor');
    if (a.type !== type || !allowed.includes(a.componentType)) fail(`Unsupported ${type} accessor component type.`, 'scene_import_invalid');
    if (a.sparse || a.bufferView === undefined) fail('Sparse and bufferless accessors are not implemented.');
    if (a.normalized && [5125, 5126].includes(a.componentType)) fail('This accessor component type cannot be normalized.', 'scene_import_invalid');
    if (type === 'SCALAR' && a.normalized) fail('Index accessors cannot be normalized.', 'scene_import_invalid');
    if (['VEC2','VEC3','VEC4'].includes(type) && a.componentType !== 5126 && a.normalized !== true) fail('Integer texture coordinates and colors must be normalized.', 'scene_import_invalid');
    if (accessorCache.has(index)) return accessorCache.get(index);
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const [size, read, divisor] = component[a.componentType];
    const { bytes, view, start } = viewBytes(a.bufferView);
    const count = integer(a.count, 1, type === 'SCALAR' ? SCENE_IMPORT_LIMITS.maxTriangles * 3 : SCENE_IMPORT_LIMITS.maxVertices, 'accessor.count');
    const stride = view.byteStride ?? width * size;
    integer(stride, width * size, 252, 'accessor stride');
    if (stride % size || (view.byteStride !== undefined && stride % 4)) fail('Invalid accessor stride alignment.', 'scene_import_invalid');
    const offset = integer(a.byteOffset ?? 0, 0, bytes.length, 'accessor.byteOffset');
    if ((start + offset) % size || offset + (count - 1) * stride + width * size > bytes.length) fail('Accessor is misaligned or overruns its buffer view.', 'scene_import_invalid');
    const result = new Array(count * width);
    for (let row = 0; row < count; row++) for (let col = 0; col < width; col++) {
      let value = bytes[read](offset + row * stride + col * size);
      if (a.normalized) value = Math.max(-1, value / divisor);
      if (!Number.isFinite(value)) fail('Accessor contains a non-finite number.', 'scene_import_invalid');
      result[row * width + col] = value;
    }
    accessorCache.set(index, result); return result;
  }
  const resources = []; const textures = new Map(); const materials = new Map(); const geometry = new Map();
  let textureBytes = 0; let textureSerializedBytes = 0; let vertexCount = 0; let triangleCount = 0; let primitiveCount = 0;
  function texture(info, colorSpace) {
    if (!info) return undefined;
    if ((info.texCoord ?? 0) !== 0 || info.extensions) fail('Only untransformed texture coordinate set 0 is supported.');
    const key = `${info.index}/${colorSpace}`;
    if (textures.has(key)) return textures.get(key);
    const tex = get(list(gltf.textures, 'textures'), info.index, 'texture');
    const img = get(list(gltf.images, 'images'), tex.source, 'image');
    if (img.uri !== undefined || img.mimeType !== 'image/png' || img.bufferView === undefined) fail('Only embedded RGB/RGBA PNG textures are supported.');
    const decoded = decodePngRgba(viewBytes(img.bufferView).bytes);
    if (decoded.width > 512 || decoded.height > 512 || decoded.rgba.length > DATA_TEXTURE_LIMITS.maxEncodedBytes) fail('Embedded texture exceeds Studio inline texture limits.', 'scene_import_budget');
    textureBytes += decoded.rgba.length;
    if (textureBytes > SCENE_IMPORT_LIMITS.maxTextureBytes) fail('Aggregate texture budget exceeded.', 'scene_import_budget');
    const sampler = tex.sampler === undefined ? {} : get(list(gltf.samplers, 'samplers'), tex.sampler, 'sampler');
    const wrap = value => ({ 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' }[value ?? 10497] ?? fail('Unsupported sampler wrap.', 'scene_import_invalid'));
    const minFilter = { 9728:'nearest',9729:'linear',9984:'nearestMipmapNearest',9985:'linearMipmapNearest',9986:'nearestMipmapLinear',9987:'linearMipmapLinear' }[sampler.minFilter ?? 9987];
    const magFilter = { 9728:'nearest',9729:'linear' }[sampler.magFilter ?? 9729];
    if (!minFilter || !magFilter) fail('Invalid sampler filter.', 'scene_import_invalid');
    const id = `${idPrefix}/texture-${info.index}-${colorSpace}`;
    const resource = { id, kind:'texture', name:img.name ?? `Texture ${info.index}`, recipe:{ kind:'dataTexture', width:decoded.width, height:decoded.height, channels:4, data:decoded.rgba.toString('base64'), colorSpace, flipY:false, wrapS:wrap(sampler.wrapS), wrapT:wrap(sampler.wrapT), minFilter, magFilter, generateMipmaps:true } };
    resource.recipe = normalizeDataTextureResource(resource.recipe);
    textureSerializedBytes += dataTextureSerializedByteLength(resource.recipe);
    if(textureSerializedBytes > DATA_TEXTURE_LIMITS.maxProjectSerializedBytes) fail('Aggregate serialized texture budget exceeded.', 'scene_import_budget');
    resources.push({ resourceType:'textures', resource }); textures.set(key,id); return id;
  }
  function material(index, vertexColors) {
    const key = `${index ?? 'default'}/${vertexColors}`;
    if (materials.has(key)) return materials.get(key);
    const m = index === undefined ? {} : get(list(gltf.materials,'materials'), index,'material');
    const pbr = m.pbrMetallicRoughness ?? {}; const color = finiteArray(pbr.baseColorFactor ?? [1,1,1,1],4,'baseColorFactor',0,1);
    const unit = (v, fallback, label) => { const n=v??fallback; if (!Number.isFinite(n)||n<0||n>1) fail(`Invalid ${label}.`,'scene_import_invalid'); return n; };
    const recipe = { kind:'physical', baseColor:color.slice(0,3), opacity:color[3], metalness:unit(pbr.metallicFactor,1,'metallicFactor'),roughness:unit(pbr.roughnessFactor,1,'roughnessFactor'),emissive:finiteArray(m.emissiveFactor??[0,0,0],3,'emissiveFactor',0,1),side:m.doubleSided?'double':'front',vertexColors };
    const alphaMode = m.alphaMode ?? 'OPAQUE';
    if (!['OPAQUE','MASK','BLEND'].includes(alphaMode)) fail('Invalid material alpha mode.', 'scene_import_invalid');
    recipe.transparent=alphaMode==='BLEND';
    if (alphaMode==='OPAQUE') recipe.opacity=1;
    if (alphaMode==='BLEND') recipe.transparent=true;
    if (alphaMode==='MASK') recipe.alphaTest=unit(m.alphaCutoff,0.5,'alphaCutoff');
    for (const [key, info, role] of [['baseColorMapId',pbr.baseColorTexture,'srgb'],['normalMapId',m.normalTexture,'none'],['emissiveMapId',m.emissiveTexture,'srgb'],['aoMapId',m.occlusionTexture,'none']]) if(info) recipe[key]=texture(info,role);
    if(pbr.metallicRoughnessTexture) recipe.roughnessMapId=recipe.metalnessMapId=texture(pbr.metallicRoughnessTexture,'none');
    if(m.normalTexture) recipe.normalScale=[m.normalTexture.scale??1,m.normalTexture.scale??1];
    if(m.occlusionTexture) recipe.aoMapIntensity=unit(m.occlusionTexture.strength,1,'occlusion strength');
    const ext=m.extensions??{}; const coat=ext.KHR_materials_clearcoat;
    if(coat){recipe.clearcoat=unit(coat.clearcoatFactor,0,'clearcoat');recipe.clearcoatRoughness=unit(coat.clearcoatRoughnessFactor,0,'clearcoat roughness');
      if(coat.clearcoatTexture)recipe.clearcoatMapId=texture(coat.clearcoatTexture,'none');
      if(coat.clearcoatRoughnessTexture)recipe.clearcoatRoughnessMapId=texture(coat.clearcoatRoughnessTexture,'none');
      if(coat.clearcoatNormalTexture){recipe.clearcoatNormalMapId=texture(coat.clearcoatNormalTexture,'none');recipe.clearcoatNormalScale=[coat.clearcoatNormalTexture.scale??1,coat.clearcoatNormalTexture.scale??1];}}
    if(ext.KHR_materials_ior) recipe.ior=ext.KHR_materials_ior.ior??1.5;
    if(ext.KHR_materials_transmission){recipe.transmission=unit(ext.KHR_materials_transmission.transmissionFactor,0,'transmission');if(ext.KHR_materials_transmission.transmissionTexture)recipe.transmissionMapId=texture(ext.KHR_materials_transmission.transmissionTexture,'none');}
    const id=`${idPrefix}/material-${index??'default'}${vertexColors?'-vertex':''}`;
    resources.push({resourceType:'materials',resource:{id,kind:'material',name:m.name??`Material ${index??'default'}`,recipe}});materials.set(key,id);return id;
  }
  function meshPrimitive(meshIndex, primitiveIndex) {
    const key=`${meshIndex}/${primitiveIndex}`;
    if(geometry.has(key))return geometry.get(key);
    const mesh=get(list(gltf.meshes,'meshes'),meshIndex,'mesh');const p=get(list(mesh.primitives,'primitives'),primitiveIndex,'primitive');
    if((p.mode??4)!==4 || p.targets?.length || mesh.weights?.length)fail('Only rigid triangle primitives without morph targets are supported.');
    if(p.extensions?.KHR_draco_mesh_compression)fail('Draco-compressed geometry is not supported.');
    const attrs=p.attributes??{};
    for(const attribute of Object.keys(attrs))if(!['POSITION','NORMAL','TEXCOORD_0','COLOR_0','TANGENT'].includes(attribute))fail(`Vertex attribute ${attribute} is not supported.`);
    if(attrs.TANGENT!==undefined)warnings.push({code:'scene_import_tangent_derived',message:`Mesh ${meshIndex} tangent frames are derived from normals and UVs at render time.`});
    const positions=accessor(attrs.POSITION,'VEC3',[5126]);const count=positions.length/3;
    const indices=p.indices===undefined?Array.from({length:count},(_,i)=>i):accessor(p.indices,'SCALAR',[5121,5123,5125]);
    const recipe={kind:'indexedMesh',positions,indices,computeNormals:attrs.NORMAL===undefined};
    if(attrs.NORMAL!==undefined)recipe.normals=accessor(attrs.NORMAL,'VEC3',[5126]);
    if(attrs.TEXCOORD_0!==undefined)recipe.uvs=accessor(attrs.TEXCOORD_0,'VEC2',[5121,5123,5126]);
    if(attrs.COLOR_0!==undefined){const a=get(accessors,attrs.COLOR_0,'color accessor');if(!['VEC3','VEC4'].includes(a.type))fail('Colors require VEC3 or VEC4.','scene_import_invalid');recipe.colors=accessor(attrs.COLOR_0,a.type,[5121,5123,5126]);}
    validateIndexedMeshRecipe(recipe);
    vertexCount+=count;triangleCount+=indices.length/3;primitiveCount++;
    if(vertexCount>SCENE_IMPORT_LIMITS.maxVertices||triangleCount>SCENE_IMPORT_LIMITS.maxTriangles||primitiveCount>SCENE_IMPORT_LIMITS.maxPrimitives)fail('Aggregate geometry budget exceeded.','scene_import_budget');
    const geometryId=`${idPrefix}/geometry-${meshIndex}-${primitiveIndex}`;const materialId=material(p.material,!!recipe.colors);
    const mat=resources.find(r=>r.resource.id===materialId).resource.recipe;
    if(!recipe.uvs&&Object.keys(mat).some(k=>k.endsWith('MapId')))fail('A textured primitive is missing TEXCOORD_0.','scene_import_invalid');
    resources.push({resourceType:'geometries',resource:{id:geometryId,kind:'geometry',name:`${mesh.name??'Mesh'} ${primitiveIndex}`,recipe}});
    const result={geometryId,materialId};geometry.set(key,result);return result;
  }
  const entities=[];const rootId=`${idPrefix}/root`;const root={id:rootId,kind:'group',name,children:[],metadata:{import:{format:'glb',sha256,sourceName:String(sourceName).split(/[\\/]/u).at(-1)}}};entities.push(root);
  const addEntity = entity => {
    if (entities.length >= SCENE_IMPORT_LIMITS.maxEntities) fail('Generated entity budget exceeded, including instanced primitives.', 'scene_import_budget');
    entities.push(entity);
  };
  const visited=new Set();
  function visit(index,parent,depth){
    if(depth>SCENE_IMPORT_LIMITS.maxDepth)fail('Node hierarchy exceeds depth budget.','scene_import_budget');
    if(visited.has(index))fail('Node hierarchy contains a cycle or multiple parents.','scene_import_invalid');
    const node=get(nodes,index,'node');visited.add(index);
    if(node.skin!==undefined||node.weights)fail('Skinned or morphed nodes are not supported.');
    const id=`${idPrefix}/node-${index}`;const entity={id,kind:'group',name:node.name??`Node ${index}`,parentId:parent.id,children:[],transform:transform(node)};
    parent.children.push(id);addEntity(entity);
    if(node.mesh!==undefined){const mesh=get(list(gltf.meshes,'meshes'),node.mesh,'mesh');const primitives=list(mesh.primitives,'primitives');if(!primitives.length)fail('Mesh has no primitives.','scene_import_invalid');
      for(let p=0;p<primitives.length;p++){const refs=meshPrimitive(node.mesh,p);if(primitives.length===1){entity.kind='mesh';entity.components={mesh:refs};}else{const pid=`${id}/primitive-${p}`;entity.children.push(pid);addEntity({id:pid,kind:'mesh',name:`${entity.name} ${p}`,parentId:id,components:{mesh:refs}});}}}
    if(node.camera!==undefined||node.extensions?.KHR_lights_punctual)warnings.push({code:'scene_import_presentation_omitted',message:`Camera/light presentation on node ${index} is omitted; its transform remains.`});
    for(const child of list(node.children,'node.children'))visit(child,entity,depth+1);
  }
  const scenes=list(gltf.scenes,'scenes');
  if(!scenes.length)fail('GLB must define a scene.','scene_import_invalid');
  const sourceScene=get(scenes,gltf.scene??0,'scene');
  for(const index of list(sourceScene.nodes,'scene.nodes'))visit(index,root,0);
  if(!primitiveCount)fail('The selected scene contains no supported mesh primitives.','scene_import_invalid');
  const scene={id:sceneId,name,entities,rootEntityIds:[rootId],metadata:{import:{format:'glb',sha256,sourceName:root.metadata.import.sourceName}}};
  const operations=[];
  for(let i=0;i<resources.length;i+=128)operations.push({op:'resource.createMany',items:resources.slice(i,i+128)});
  operations.push({op:'scene.create',scene},{op:'scene.setActive',sceneId});
  if(operations.length>128)fail('Import transaction budget exceeded.','scene_import_budget');
  return {operations,sha256,rootEntityId:rootId,sceneId,warnings,stats:{nodes:visited.size,entities:entities.length,primitives:primitiveCount,vertices:vertexCount,triangles:triangleCount,textures:textures.size,textureBytes,materials:materials.size}};
}
