import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importGlbScene } from '../src/core/scene-import.mjs';
import { createProjectDocument, exportSceneInterchange } from '../src/core/index.mjs';
import { applyOperations } from '../src/core/operations.mjs';
import { composeTransformMatrix } from '../src/core/transform-math.mjs';
import { encodePngRgba } from '../src/core/png-rgba.mjs';
import { jobSchema, applySchema } from '../src/mcp/tool-schemas.mjs';

const options = {sceneId:'scene/import',idPrefix:'asset/test',name:'Imported fixture'};
function fixture() {
  return createProjectDocument({projectId:'project/import-test',scenes:[{id:'scene/source',rootEntityIds:['entity/pivot'],entities:[
    {id:'entity/pivot',kind:'group',name:'Wheel pivot',children:['entity/mesh'],transform:{position:[1,2,3],rotation:[0.2,-0.3,0.4],scale:[-1,2,1]}},
    {id:'entity/mesh',kind:'mesh',parentId:'entity/pivot',components:{mesh:{geometryId:'geometry/triangle',materialId:'material/paint'}}},
  ]}],resources:{geometries:[{id:'geometry/triangle',kind:'geometry',recipe:{kind:'indexedMesh',positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,2],uvs:[0,0,1,0,0,1],normals:[0,0,1,0,0,1,0,0,1],colors:[1,0,0,0,1,0,0,0,1]}}],materials:[{id:'material/paint',kind:'material',recipe:{kind:'physical',baseColor:[0.1,0.4,0.8],metalness:0.7,roughness:0.2}}]}});
}
function unpack(bytes) {
  const b=Buffer.from(bytes);const length=b.readUInt32LE(12);const json=JSON.parse(b.toString('utf8',20,20+length));
  return {json,binary:b.subarray(28+length)};
}
function pack(json,binary=Buffer.alloc(0)) {
  const raw=Buffer.from(JSON.stringify(json));const j=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(j);
  const bin=Buffer.alloc(Math.ceil(binary.length/4)*4);binary.copy(bin);
  const head=Buffer.alloc(20);head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(28+j.length+bin.length,8);head.writeUInt32LE(j.length,12);head.writeUInt32LE(0x4e4f534a,16);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([head,j,bh,bin]);
}
const bytes=()=>Buffer.from(exportSceneInterchange(fixture(),{format:'glb'}).bytes);
test('GLB round trip preserves hierarchy, transforms, attributes and PBR in one reversible transaction',()=>{
  const source=bytes();const imported=importGlbScene(source,{...options,expectedSha256:createHash('sha256').update(source).digest('hex'),sourceName:'C:/private/vehicle.glb'});
  const original=createProjectDocument({projectId:'project/target',scenes:[{id:'scene/main'}]});
  const applied=applyOperations(original,imported.operations);
  const scene=applied.document.scenes[options.sceneId];
  const pivot=Object.values(scene.entities).find(e=>e.name==='Wheel pivot');
  const expected=composeTransformMatrix(fixture().scenes['scene/source'].entities['entity/pivot'].transform);
  composeTransformMatrix(pivot.transform).forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<1e-6));
  const mesh=Object.values(scene.entities).find(e=>e.kind==='mesh');assert.equal(mesh.parentId,pivot.id);
  const geometry=applied.document.resources.geometries[mesh.components.mesh.geometryId].recipe;
  assert.deepEqual(geometry.positions,[0,0,0,1,0,0,0,1,0]);assert.equal(geometry.uvs.length,6);assert.equal(geometry.colors.length,9);
  assert.equal(applied.document.resources.materials[mesh.components.mesh.materialId].recipe.metalness,0.7);
  assert.equal(JSON.stringify(imported.operations).includes('C:/private'),false);
  assert.equal(scene.metadata.import.sourceName,'vehicle.glb');
  const restored=applyOperations(applied.document,applied.inverseOperations,{allowInternal:true});assert.deepEqual(restored.document,original);
});
test('GLB import rejects changed checksums and malformed accessor bounds before changing a project',()=>{
  assert.throws(()=>importGlbScene(bytes(),{...options,expectedSha256:'0'.repeat(64)}),{code:'scene_import_hash_mismatch'});
  const {json,binary}=unpack(bytes());json.accessors[0].count=10000;
  assert.throws(()=>importGlbScene(pack(json,binary),options),/overruns/);
});
test('GLB import rejects unsupported skins, sparse accessors, external URIs and cyclic/shared hierarchies',()=>{
  const cases=[j=>j.skins=[{}],j=>j.accessors[0].sparse={},j=>j.buffers[0].uri='https://invalid.example/private',j=>j.nodes[0].children=[0],j=>j.extensionsRequired=['KHR_draco_mesh_compression']];
  for(const mutate of cases){const {json,binary}=unpack(bytes());mutate(json);assert.throws(()=>importGlbScene(pack(json,binary),options));}
});
test('GLB import reads interleaved normalized UVs and rejects invalid index normalization',()=>{
  const {json,binary}=unpack(bytes());const uv=Buffer.alloc(12);[0,0,65535,0,0,65535].forEach((n,i)=>uv.writeUInt16LE(n,i*2));
  const view=json.bufferViews.length;const acc=json.accessors.length;
  json.bufferViews.push({buffer:0,byteOffset:binary.length,byteLength:uv.length,byteStride:4});
  json.accessors.push({bufferView:view,componentType:5123,type:'VEC2',count:3,normalized:true});json.meshes[0].primitives[0].attributes.TEXCOORD_0=acc;
  json.buffers[0].byteLength=binary.length+uv.length;
  const result=importGlbScene(pack(json,Buffer.concat([binary,uv])),options);
  assert.deepEqual(result.operations.flatMap(o=>o.items??[]).find(i=>i.resourceType==='geometries').resource.recipe.uvs,[0,0,1,0,0,1]);
  json.accessors[json.meshes[0].primitives[0].indices].normalized=true;
  assert.throws(()=>importGlbScene(pack(json,Buffer.concat([binary,uv])),options),/normalized/);
});
test('shared multi-primitive meshes cannot expand past the entity budget',()=>{
  const {json,binary}=unpack(bytes());
  json.meshes[0].primitives=Array.from({length:32},()=>structuredClone(json.meshes[0].primitives[0]));
  json.nodes=Array.from({length:300},()=>({mesh:0}));json.scenes[0].nodes=Array.from({length:300},(_,i)=>i);
  assert.throws(()=>importGlbScene(pack(json,binary),options),{code:'scene_import_budget'});
});
test('GLB import decodes embedded PNG with correct color role and sampler without file references',()=>{
  const {json,binary}=unpack(bytes());const png=encodePngRgba(1,1,Buffer.from([128,64,32,255]));const index=json.bufferViews.length;
  json.bufferViews.push({buffer:0,byteOffset:binary.length,byteLength:png.length});json.buffers[0].byteLength=binary.length+png.length;
  json.images=[{bufferView:index,mimeType:'image/png'}];json.textures=[{source:0}];json.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
  const imported=importGlbScene(pack(json,Buffer.concat([binary,png])),options);
  const texture=imported.operations.flatMap(o=>o.items??[]).find(i=>i.resourceType==='textures').resource.recipe;
  assert.equal(texture.colorSpace,'srgb');assert.equal(texture.flipY,false);assert.equal(texture.wrapS,'repeat');assert.deepEqual([...Buffer.from(texture.data,'base64')],[128,64,32,255]);
  applyOperations(createProjectDocument({projectId:'project/png',scenes:[{id:'scene/main'}]}),imported.operations);
});
test('scene import schema requires source identity and rejects unrelated job options; camelCase components are supported',()=>{
  const base={protocolVersion:'three-studio/1',sessionId:'session/test',projectId:'project/test',baseRevision:0,idempotencyKey:'import-test',label:'Import'};
  assert.equal(jobSchema.safeParse({...base,action:'sceneImport',sourcePath:'C:/asset.glb',expectedFileSha256:'a'.repeat(64),sceneId:'scene/import',idPrefix:'asset/test',dryRun:true}).success,true);
  assert.equal(jobSchema.safeParse({...base,action:'sceneImport'}).success,false);
  assert.equal(jobSchema.safeParse({...base,action:'sceneExport',sourcePath:'C:/asset.glb'}).success,false);
  assert.equal(applySchema.safeParse({...base,operations:[{op:'entity.component.attach',entityId:'entity/car',component:'rigidBody',value:{bodyType:'dynamic'}}]}).success,true);
  assert.equal(applySchema.safeParse({...base,operations:[{op:'entity.component.attach',entityId:'entity/car',component:'invented',value:{}}]}).success,false);
});
