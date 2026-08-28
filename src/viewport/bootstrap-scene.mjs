import * as THREE from "three/webgpu";

/**
 * The empty-project stage makes the persistent viewport useful before a
 * project is opened. It owns no authoring data and disappears after compile.
 */
export function createBootstrapScene() {
  const root = new THREE.Group();
  root.name = "Studio bootstrap stage";
  root.userData.studioBootstrap = true;

  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x171c24,
    roughness: 0.82,
    metalness: 0.08,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMaterial);
  floor.name = "Bootstrap floor";
  floor.rotation.x = -Math.PI * 0.5;
  floor.receiveShadow = true;
  root.add(floor);

  const plinthMaterial = new THREE.MeshPhysicalNodeMaterial({
    color: 0x263144,
    roughness: 0.28,
    metalness: 0.72,
    clearcoat: 0.62,
    clearcoatRoughness: 0.2,
  });
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 4.2, 0.72, 64), plinthMaterial);
  plinth.name = "Bootstrap plinth";
  plinth.position.y = 0.36;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  root.add(plinth);

  const markMaterial = new THREE.MeshPhysicalNodeMaterial({
    color: 0x52d9bf,
    emissive: 0x123e3a,
    emissiveIntensity: 0.8,
    roughness: 0.18,
    metalness: 0.62,
  });
  const ring = new THREE.Mesh(new THREE.TorusKnotGeometry(1.75, 0.34, 160, 24, 2, 3), markMaterial);
  ring.name = "Studio live mark";
  ring.position.y = 2.55;
  ring.castShadow = true;
  root.add(ring);

  const grid = new THREE.GridHelper(60, 60, 0x334255, 0x242d39);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.userData.studioHelper = true;
  root.add(grid);

  const sun = new THREE.DirectionalLight(0xdbe9ff, 4.2);
  sun.name = "Bootstrap key";
  sun.position.set(-8, 12, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 60;
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 16;
  sun.shadow.camera.bottom = -16;
  root.add(sun);

  const rim = new THREE.PointLight(0x56ddc3, 42, 24, 2);
  rim.name = "Bootstrap rim";
  rim.position.set(6, 5, -5);
  root.add(rim);

  const fill = new THREE.HemisphereLight(0x7186a9, 0x121821, 1.35);
  fill.name = "Bootstrap fill";
  root.add(fill);

  return {
    root,
    update(elapsed) {
      ring.rotation.x = elapsed * 0.19;
      ring.rotation.y = elapsed * 0.31;
      ring.position.y = 2.55 + Math.sin(elapsed * 0.8) * 0.12;
    },
    dispose() {
      root.traverse(object => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach(material => material.dispose?.());
        else object.material?.dispose?.();
      });
      root.removeFromParent();
      root.clear();
    },
  };
}
