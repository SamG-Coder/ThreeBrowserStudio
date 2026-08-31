const EPSILON = 1e-5;
const MAX_INPUT_POLYGONS_PER_OPERAND = 512;
const MAX_INPUT_POLYGONS_TOTAL = 1_024;

function vector(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    clone() { return vector(this.x, this.y, this.z); },
    negated() { return vector(-this.x, -this.y, -this.z); },
    minus(other) { return vector(this.x - other.x, this.y - other.y, this.z - other.z); },
    plus(other) { return vector(this.x + other.x, this.y + other.y, this.z + other.z); },
    times(amount) { return vector(this.x * amount, this.y * amount, this.z * amount); },
    dot(other) { return this.x * other.x + this.y * other.y + this.z * other.z; },
    cross(other) {
      return vector(
        this.y * other.z - this.z * other.y,
        this.z * other.x - this.x * other.z,
        this.x * other.y - this.y * other.x,
      );
    },
    unit() {
      const length = Math.hypot(this.x, this.y, this.z);
      return length > EPSILON ? this.times(1 / length) : vector(0, 1, 0);
    },
    lerp(other, amount) { return this.plus(other.minus(this).times(amount)); },
  };
}

function vertex(position) {
  return {
    pos: position,
    clone() { return vertex(this.pos.clone()); },
    interpolate(other, amount) { return vertex(this.pos.lerp(other.pos, amount)); },
  };
}

function planeFromPoints(a, b, c) {
  const normal = b.minus(a).cross(c.minus(a)).unit();
  return plane(normal, normal.dot(a));
}

function plane(normal, w) {
  return {
    normal, w,
    clone() { return plane(this.normal.clone(), this.w); },
    flip() { this.normal = this.normal.negated(); this.w = -this.w; },
    splitPolygon(polygonValue, coplanarFront, coplanarBack, front, back) {
      const COPLANAR = 0;
      const FRONT = 1;
      const BACK = 2;
      const SPANNING = 3;
      let polygonType = COPLANAR;
      const types = polygonValue.vertices.map((entry) => {
        const distance = this.normal.dot(entry.pos) - this.w;
        const type = distance < -EPSILON ? BACK : distance > EPSILON ? FRONT : COPLANAR;
        polygonType |= type;
        return type;
      });
      if (polygonType === COPLANAR) {
        (this.normal.dot(polygonValue.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygonValue);
      } else if (polygonType === FRONT) front.push(polygonValue);
      else if (polygonType === BACK) back.push(polygonValue);
      else {
        const frontVertices = [];
        const backVertices = [];
        for (let index = 0; index < polygonValue.vertices.length; index += 1) {
          const next = (index + 1) % polygonValue.vertices.length;
          const type = types[index];
          const nextType = types[next];
          const current = polygonValue.vertices[index];
          const following = polygonValue.vertices[next];
          if (type !== BACK) frontVertices.push(current);
          if (type !== FRONT) backVertices.push(type === BACK ? current : current.clone());
          if ((type | nextType) === SPANNING) {
            const direction = following.pos.minus(current.pos);
            const denominator = this.normal.dot(direction);
            const amount = Math.abs(denominator) <= EPSILON ? 0 : (this.w - this.normal.dot(current.pos)) / denominator;
            const split = current.interpolate(following, Math.max(0, Math.min(1, amount)));
            frontVertices.push(split);
            backVertices.push(split.clone());
          }
        }
        if (frontVertices.length >= 3) front.push(polygon(frontVertices));
        if (backVertices.length >= 3) back.push(polygon(backVertices));
      }
    },
  };
}

function polygon(vertices) {
  return {
    vertices,
    plane: planeFromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos),
    clone() { return polygon(this.vertices.map(item => item.clone())); },
    flip() { this.vertices.reverse().forEach(() => {}); this.plane.flip(); },
  };
}

class BspNode {
  constructor(polygons = []) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons.length > 0) this.build(polygons);
  }

  clone() {
    const root = new BspNode();
    const pending = [[this, root]];
    while (pending.length > 0) {
      const [source, target] = pending.pop();
      target.plane = source.plane?.clone() ?? null;
      target.polygons = source.polygons.map(item => item.clone());
      if (source.front) { target.front = new BspNode(); pending.push([source.front, target.front]); }
      if (source.back) { target.back = new BspNode(); pending.push([source.back, target.back]); }
    }
    return root;
  }

  invert() {
    const pending = [this];
    while (pending.length > 0) {
      const node = pending.pop();
      node.polygons.forEach(item => item.flip());
      node.plane?.flip();
      [node.front, node.back] = [node.back, node.front];
      if (node.front) pending.push(node.front);
      if (node.back) pending.push(node.back);
    }
  }

  clipPolygons(polygons) {
    const pending = [{ node: this, polygons, stage: 0 }];
    let completed = [];
    while (pending.length > 0) {
      const frame = pending.at(-1);
      if (frame.stage === 0) {
        if (!frame.node.plane) { completed = frame.polygons.slice(); pending.pop(); continue; }
        frame.front = [];
        frame.back = [];
        frame.polygons.forEach(item => frame.node.plane.splitPolygon(item, frame.front, frame.back, frame.front, frame.back));
        frame.stage = 1;
        if (frame.node.front) { pending.push({ node: frame.node.front, polygons: frame.front, stage: 0 }); continue; }
        frame.frontResult = frame.front;
      }
      if (frame.stage === 1) {
        if (frame.node.front && frame.frontResult === undefined) frame.frontResult = completed;
        frame.stage = 2;
        if (frame.node.back) { pending.push({ node: frame.node.back, polygons: frame.back, stage: 0 }); continue; }
        frame.backResult = [];
      }
      if (frame.node.back && frame.backResult === undefined) frame.backResult = completed;
      completed = frame.frontResult.concat(frame.backResult);
      pending.pop();
    }
    return completed;
  }

  clipTo(other) {
    const pending = [this];
    while (pending.length > 0) {
      const node = pending.pop();
      node.polygons = other.clipPolygons(node.polygons);
      if (node.front) pending.push(node.front);
      if (node.back) pending.push(node.back);
    }
  }

  allPolygons() {
    const result = [];
    const pending = [this];
    while (pending.length > 0) {
      const node = pending.pop();
      result.push(...node.polygons);
      if (node.back) pending.push(node.back);
      if (node.front) pending.push(node.front);
    }
    return result;
  }

  build(polygons) {
    const pending = [{ node: this, polygons }];
    while (pending.length > 0) {
      const { node, polygons: current } = pending.pop();
      if (current.length === 0) continue;
      node.plane ??= current[0].plane.clone();
      const front = [];
      const back = [];
      current.forEach(item => node.plane.splitPolygon(item, node.polygons, node.polygons, front, back));
      if (back.length > 0) {
        node.back ??= new BspNode();
        pending.push({ node: node.back, polygons: back });
      }
      if (front.length > 0) {
        node.front ??= new BspNode();
        pending.push({ node: node.front, polygons: front });
      }
    }
  }
}

function union(left, right) {
  const a = new BspNode(left.map(item => item.clone()));
  const b = new BspNode(right.map(item => item.clone()));
  a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.allPolygons());
  return a.allPolygons();
}

function subtract(left, right) {
  const a = new BspNode(left.map(item => item.clone()));
  const b = new BspNode(right.map(item => item.clone()));
  a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.allPolygons()); a.invert();
  return a.allPolygons();
}

function intersect(left, right) {
  const a = new BspNode(left.map(item => item.clone()));
  const b = new BspNode(right.map(item => item.clone()));
  a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.allPolygons()); a.invert();
  return a.allPolygons();
}

function rotatePoint(point, rotation = [0, 0, 0]) {
  let [x, y, z] = point;
  const [rx = 0, ry = 0, rz = 0] = rotation;
  let cosine = Math.cos(rx); let sine = Math.sin(rx);
  [y, z] = [y * cosine - z * sine, y * sine + z * cosine];
  cosine = Math.cos(ry); sine = Math.sin(ry);
  [x, z] = [x * cosine + z * sine, -x * sine + z * cosine];
  cosine = Math.cos(rz); sine = Math.sin(rz);
  [x, y] = [x * cosine - y * sine, x * sine + y * cosine];
  return [x, y, z];
}

function transformedPoint(point, transform = {}) {
  const scale = transform.scale ?? [1, 1, 1];
  const position = transform.translation ?? transform.position ?? [0, 0, 0];
  const rotated = rotatePoint(point.map((value, axis) => value * (scale[axis] ?? 1)), transform.rotation);
  return rotated.map((value, axis) => value + (position[axis] ?? 0));
}

function geometryPolygons(geometry, transform) {
  const positions = geometry.getAttribute?.('position');
  if (!positions || positions.count < 3) throw new Error('CSG operand has no triangle positions.');
  const index = geometry.getIndex?.() ?? geometry.index;
  const indices = index
    ? Array.from({ length: index.count }, (_, offset) => index.getX?.(offset) ?? index.array[offset])
    : Array.from({ length: positions.count }, (_, offset) => offset);
  if (indices.length % 3 !== 0) throw new Error('CSG operands require triangle-list geometry.');
  const polygons = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const points = indices.slice(offset, offset + 3).map((entry) => transformedPoint([
      positions.getX?.(entry) ?? positions.array[entry * 3],
      positions.getY?.(entry) ?? positions.array[entry * 3 + 1],
      positions.getZ?.(entry) ?? positions.array[entry * 3 + 2],
    ], transform));
    const a = vector(...points[0]); const b = vector(...points[1]); const c = vector(...points[2]);
    if (b.minus(a).cross(c.minus(a)).dot(b.minus(a).cross(c.minus(a))) > EPSILON ** 2) {
      polygons.push(polygon([vertex(a), vertex(b), vertex(c)]));
    }
  }
  return polygons;
}

export function createCsgGeometry(THREE, recipe, createOperandGeometry) {
  if (!['union', 'subtract', 'intersect'].includes(recipe.operation)) {
    throw new Error('CSG operation must be union, subtract, or intersect.');
  }
  if (!Array.isArray(recipe.operands) || recipe.operands.length < 2 || recipe.operands.length > 32) {
    throw new Error('CSG requires 2 to 32 operands.');
  }
  const operandPolygons = recipe.operands.map((operand, index) => {
    if (!operand?.recipe || operand.recipe.kind === 'csg') throw new Error(`CSG operand ${index} requires one non-CSG geometry recipe.`);
    const geometry = createOperandGeometry(operand.recipe);
    try {
      const polygons = geometryPolygons(geometry, operand.transform);
      if (operand.recipe.kind === 'loft' && polygons.length > 64) {
        throw new Error('CSG loft operands exceed the 64-triangle curved-surface safety limit.');
      }
      if (polygons.length > MAX_INPUT_POLYGONS_PER_OPERAND) {
        throw new Error(`CSG operand ${index} exceeds the ${MAX_INPUT_POLYGONS_PER_OPERAND}-triangle input safety limit.`);
      }
      return polygons;
    }
    finally { geometry.dispose?.(); }
  });
  if (operandPolygons.reduce((total, polygons) => total + polygons.length, 0) > MAX_INPUT_POLYGONS_TOTAL) {
    throw new Error(`CSG operands exceed the ${MAX_INPUT_POLYGONS_TOTAL}-triangle aggregate input safety limit.`);
  }
  let result = operandPolygons[0];
  for (let index = 1; index < operandPolygons.length; index += 1) {
    result = recipe.operation === 'union' ? union(result, operandPolygons[index])
      : recipe.operation === 'subtract' ? subtract(result, operandPolygons[index])
        : intersect(result, operandPolygons[index]);
  }
  const output = [];
  for (const item of result) {
    for (let index = 2; index < item.vertices.length; index += 1) {
      for (const entry of [item.vertices[0], item.vertices[index - 1], item.vertices[index]]) {
        output.push(entry.pos.x, entry.pos.y, entry.pos.z);
      }
    }
  }
  if (output.length < 9) throw new Error('CSG operation produced an empty solid.');
  if (output.length / 9 > 2_000_000) throw new Error('CSG output exceeds the 2,000,000 triangle safety limit.');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(output, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
