import { StudioError } from './errors.mjs';

const DEFAULT_SHEAR_TOLERANCE = 1e-9;
const DEFAULT_RECONSTRUCTION_TOLERANCE = 1e-8;

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new StudioError('invalid_transform', `${label} must be a finite number.`, { label, value });
  }
  return value;
}

function vector3(value, fallback, label, { nonZero = false } = {}) {
  const source = value ?? fallback;
  if (!Array.isArray(source) || source.length !== 3) {
    throw new StudioError('invalid_transform', `${label} must contain exactly three numbers.`, { label });
  }
  const result = source.map((component, index) => assertFiniteNumber(component, `${label}[${index}]`));
  if (nonZero && result.some(component => component === 0)) {
    throw new StudioError('invalid_transform', `${label} components must be non-zero.`, { label });
  }
  return result;
}

function matrix16(value, label = 'matrix') {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new StudioError('invalid_transform_matrix', `${label} must contain exactly 16 numbers.`, { label });
  }
  if (value.length !== 16) {
    throw new StudioError('invalid_transform_matrix', `${label} must contain exactly 16 numbers.`, {
      label,
      length: value.length,
    });
  }
  return Array.from(value, (component, index) => {
    if (!Number.isFinite(component)) {
      throw new StudioError('invalid_transform_matrix', `${label}[${index}] must be finite.`, { label, index });
    }
    return component;
  });
}

function cleanNegativeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function determinant3(matrix) {
  const a = matrix[0];
  const b = matrix[4];
  const c = matrix[8];
  const d = matrix[1];
  const e = matrix[5];
  const f = matrix[9];
  const g = matrix[2];
  const h = matrix[6];
  const i = matrix[10];
  return (a * ((e * i) - (f * h)))
    - (b * ((d * i) - (f * g)))
    + (c * ((d * h) - (e * g)));
}

function columnLength(matrix, offset) {
  return Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2]);
}

function dotColumns(matrix, leftOffset, rightOffset) {
  return (matrix[leftOffset] * matrix[rightOffset])
    + (matrix[leftOffset + 1] * matrix[rightOffset + 1])
    + (matrix[leftOffset + 2] * matrix[rightOffset + 2]);
}

function assertTolerance(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new StudioError('invalid_transform_tolerance', `${label} must be a finite non-negative number.`, {
      label,
      value,
    });
  }
  return value;
}

/**
 * Compose the canonical ThreeBrowser entity transform into a Three.js-compatible
 * column-major T * R(XYZ Euler) * S matrix.
 */
export function composeTransformMatrix(transform = {}) {
  const [px, py, pz] = vector3(transform.position, [0, 0, 0], 'transform.position');
  const [rx, ry, rz] = vector3(transform.rotation, [0, 0, 0], 'transform.rotation');
  const [sx, sy, sz] = vector3(transform.scale, [1, 1, 1], 'transform.scale', { nonZero: true });

  // This is Quaternion.setFromEuler(order = 'XYZ') followed by Matrix4.compose,
  // matching scene-compiler.mjs assigning object.rotation before object.scale.
  const c1 = Math.cos(rx / 2);
  const c2 = Math.cos(ry / 2);
  const c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2);
  const s2 = Math.sin(ry / 2);
  const s3 = Math.sin(rz / 2);
  const qx = (s1 * c2 * c3) + (c1 * s2 * s3);
  const qy = (c1 * s2 * c3) - (s1 * c2 * s3);
  const qz = (c1 * c2 * s3) + (s1 * s2 * c3);
  const qw = (c1 * c2 * c3) - (s1 * s2 * s3);

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  const matrix = [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    px,
    py,
    pz,
    1,
  ];
  if (!matrix.every(Number.isFinite)) {
    throw new StudioError('invalid_transform_matrix', 'Transform composition produced a non-finite matrix.');
  }
  return matrix.map(cleanNegativeZero);
}

/** Multiply two column-major matrices, returning left * right. */
export function multiplyTransformMatrices(left, right) {
  const a = matrix16(left, 'leftMatrix');
  const b = matrix16(right, 'rightMatrix');
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[(column * 4) + row] += a[(index * 4) + row] * b[(column * 4) + index];
      }
    }
  }
  if (!result.every(Number.isFinite)) {
    throw new StudioError('invalid_transform_matrix', 'Matrix multiplication produced non-finite values.');
  }
  return result.map(cleanNegativeZero);
}

/**
 * Invert an affine column-major transform matrix. This accepts world matrices
 * that contain shear, because parent inversion must happen before the relative
 * local matrix is decomposed back into canonical TRS.
 */
export function invertTransformMatrix(matrix) {
  const source = matrix16(matrix);
  if (source[3] !== 0 || source[7] !== 0 || source[11] !== 0 || source[15] !== 1) {
    throw new StudioError(
      'non_invertible_transform',
      'Only affine transform matrices can be inverted for entity parenting.',
    );
  }

  const a00 = source[0];
  const a01 = source[4];
  const a02 = source[8];
  const a10 = source[1];
  const a11 = source[5];
  const a12 = source[9];
  const a20 = source[2];
  const a21 = source[6];
  const a22 = source[10];
  const determinant = determinant3(source);
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new StudioError(
      'non_invertible_transform',
      'Transform matrix is singular and cannot be used as a parent world transform.',
      { determinant },
    );
  }

  const inverseDeterminant = 1 / determinant;
  const i00 = ((a11 * a22) - (a12 * a21)) * inverseDeterminant;
  const i01 = ((a02 * a21) - (a01 * a22)) * inverseDeterminant;
  const i02 = ((a01 * a12) - (a02 * a11)) * inverseDeterminant;
  const i10 = ((a12 * a20) - (a10 * a22)) * inverseDeterminant;
  const i11 = ((a00 * a22) - (a02 * a20)) * inverseDeterminant;
  const i12 = ((a02 * a10) - (a00 * a12)) * inverseDeterminant;
  const i20 = ((a10 * a21) - (a11 * a20)) * inverseDeterminant;
  const i21 = ((a01 * a20) - (a00 * a21)) * inverseDeterminant;
  const i22 = ((a00 * a11) - (a01 * a10)) * inverseDeterminant;
  const [tx, ty, tz] = source.slice(12, 15);
  const result = [
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    -((i00 * tx) + (i01 * ty) + (i02 * tz)),
    -((i10 * tx) + (i11 * ty) + (i12 * tz)),
    -((i20 * tx) + (i21 * ty) + (i22 * tz)),
    1,
  ];
  if (!result.every(Number.isFinite)) {
    throw new StudioError(
      'non_invertible_transform',
      'Transform matrix inverse contains non-finite values.',
      { determinant },
    );
  }
  return result.map(cleanNegativeZero);
}

/**
 * Decompose an affine matrix into the canonical position / XYZ Euler / scale
 * representation. Matrices containing material shear are rejected because a
 * canonical TRS cannot represent them without visibly moving or deforming the
 * entity.
 */
export function decomposeTransformMatrix(matrix, options = {}) {
  const source = matrix16(matrix);
  const shearTolerance = assertTolerance(
    options.shearTolerance ?? DEFAULT_SHEAR_TOLERANCE,
    'shearTolerance',
  );
  const reconstructionTolerance = assertTolerance(
    options.reconstructionTolerance ?? DEFAULT_RECONSTRUCTION_TOLERANCE,
    'reconstructionTolerance',
  );

  const affineTolerance = Math.max(reconstructionTolerance, 1e-12);
  if (
    Math.abs(source[3]) > affineTolerance
    || Math.abs(source[7]) > affineTolerance
    || Math.abs(source[11]) > affineTolerance
    || Math.abs(source[15] - 1) > affineTolerance
  ) {
    throw new StudioError(
      'non_decomposable_transform',
      'Transform matrix is not affine and cannot be represented as entity TRS.',
    );
  }

  let sx = columnLength(source, 0);
  const sy = columnLength(source, 4);
  const sz = columnLength(source, 8);
  if (![sx, sy, sz].every(value => Number.isFinite(value) && value > Number.EPSILON)) {
    throw new StudioError(
      'non_decomposable_transform',
      'Transform matrix has a zero or non-finite scale axis.',
      { scaleMagnitudes: [sx, sy, sz] },
    );
  }
  if (determinant3(source) < 0) sx = -sx;

  const rotationMatrix = [...source];
  for (let row = 0; row < 3; row += 1) {
    rotationMatrix[row] /= sx;
    rotationMatrix[4 + row] /= sy;
    rotationMatrix[8 + row] /= sz;
  }
  rotationMatrix[3] = 0;
  rotationMatrix[7] = 0;
  rotationMatrix[11] = 0;
  rotationMatrix[12] = 0;
  rotationMatrix[13] = 0;
  rotationMatrix[14] = 0;
  rotationMatrix[15] = 1;

  const shear = [
    Math.abs(dotColumns(rotationMatrix, 0, 4)),
    Math.abs(dotColumns(rotationMatrix, 0, 8)),
    Math.abs(dotColumns(rotationMatrix, 4, 8)),
  ];
  if (shear.some(value => value > shearTolerance)) {
    throw new StudioError(
      'non_decomposable_transform',
      'Transform matrix contains shear that canonical entity TRS cannot preserve.',
      { normalizedAxisDotProducts: shear, shearTolerance },
    );
  }

  // Euler.setFromRotationMatrix(order = 'XYZ'), using Three.js column-major
  // element names: m13 = elements[8], m23 = elements[9], and so on.
  const clampedM13 = Math.max(-1, Math.min(1, rotationMatrix[8]));
  const ry = Math.asin(clampedM13);
  let rx;
  let rz;
  if (Math.abs(clampedM13) < 1 - 1e-12) {
    rx = Math.atan2(-rotationMatrix[9], rotationMatrix[10]);
    rz = Math.atan2(-rotationMatrix[4], rotationMatrix[0]);
  } else {
    rx = Math.atan2(rotationMatrix[6], rotationMatrix[5]);
    rz = 0;
  }

  const transform = {
    position: source.slice(12, 15).map(cleanNegativeZero),
    rotation: [rx, ry, rz].map(cleanNegativeZero),
    scale: [sx, sy, sz].map(cleanNegativeZero),
  };
  const reconstructed = composeTransformMatrix(transform);
  const magnitude = Math.max(1, ...source.map(Math.abs));
  const maximumError = Math.max(...source.map((value, index) => Math.abs(value - reconstructed[index])));
  if (maximumError > reconstructionTolerance * magnitude) {
    throw new StudioError(
      'non_decomposable_transform',
      'Transform matrix cannot be reconstructed as canonical entity TRS without drift.',
      { maximumError, reconstructionTolerance, magnitude },
    );
  }
  return transform;
}

/** Compose a parent local transform with a child local transform. */
export function composeEntityTransforms(parentTransform, childTransform, options = {}) {
  return decomposeTransformMatrix(
    multiplyTransformMatrices(
      composeTransformMatrix(parentTransform),
      composeTransformMatrix(childTransform),
    ),
    options,
  );
}

/** Recover canonical child-local TRS from parent and child world matrices. */
export function relativeEntityTransform(parentWorldMatrix, childWorldMatrix, options = {}) {
  return decomposeTransformMatrix(
    multiplyTransformMatrices(
      invertTransformMatrix(parentWorldMatrix),
      childWorldMatrix,
    ),
    options,
  );
}
