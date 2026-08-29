import { clamp01 } from './procedural-texture-noise.mjs';

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function fract(value) {
  return value - Math.floor(value);
}

function mix(left, right, amount) {
  return left + ((right - left) * amount);
}

function color(value, length = 4) {
  if (Array.isArray(value)) {
    return Array.from({ length }, (_, index) => finite(value[index], index === 3 ? 1 : 0));
  }
  const component = finite(value);
  return Array.from({ length }, (_, index) => index === 3 ? 1 : component);
}

export function rgbToHsv(value) {
  const [red, green, blue] = color(value, 3);
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const delta = high - low;
  let hue = 0;
  if (delta > 1e-10) {
    if (high === red) hue = fract(((green - blue) / delta) / 6);
    else if (high === green) hue = (((blue - red) / delta) + 2) / 6;
    else hue = (((red - green) / delta) + 4) / 6;
  }
  return [hue, high > 1e-10 ? delta / high : 0, high];
}

export function hsvToRgb(value) {
  const [rawHue, rawSaturation, rawBrightness] = color(value, 3);
  const hue = fract(rawHue);
  const saturation = rawSaturation;
  const brightness = rawBrightness;
  const sector = hue * 6;
  const chroma = brightness * saturation;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0; let green = 0; let blue = 0;
  if (sector < 1) [red, green] = [chroma, intermediate];
  else if (sector < 2) [red, green] = [intermediate, chroma];
  else if (sector < 3) [green, blue] = [chroma, intermediate];
  else if (sector < 4) [green, blue] = [intermediate, chroma];
  else if (sector < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];
  const minimum = brightness - chroma;
  return [red + minimum, green + minimum, blue + minimum];
}

export function rgbToHsl(value) {
  const rgb = color(value, 3);
  const high = Math.max(...rgb);
  const low = Math.min(...rgb);
  const lightness = Math.min(1, (high + low) * 0.5);
  const denominator = Math.max(1 - Math.abs((lightness * 2) - 1), 1e-10);
  return [rgbToHsv(rgb)[0], (high - low) / denominator, lightness];
}

export function hslToRgb(value) {
  const [rawHue, saturation, lightness] = color(value, 3);
  const hue = fract(rawHue) * 6;
  const shape = [
    Math.min(1, Math.max(0, Math.abs(hue - 3) - 1)),
    Math.min(1, Math.max(0, 2 - Math.abs(hue - 2))),
    Math.min(1, Math.max(0, 2 - Math.abs(hue - 4))),
  ];
  const chroma = (1 - Math.abs((lightness * 2) - 1)) * saturation;
  return shape.map(component => ((component - 0.5) * chroma) + lightness);
}

export function mixHue(left, right, amount, interpolation = 'NEAR') {
  const delta = right - left;
  const direct = mix(left, right, amount);
  const increasing = fract(mix(left, right + 1, amount));
  const decreasing = fract(mix(left + 1, right, amount));
  switch (String(interpolation ?? 'NEAR').toUpperCase()) {
    case 'NEAR':
      if (delta > 0.5) return decreasing;
      if (delta < -0.5) return increasing;
      return direct;
    case 'FAR':
      if (delta > 0 && delta < 0.5) return decreasing;
      if (delta === 0 || (delta < 0 && delta > -0.5)) return increasing;
      return direct;
    case 'CW': return delta < 0 ? increasing : direct;
    case 'CCW': return delta > 0 ? decreasing : direct;
    default: throw new RangeError(`Unsupported hue interpolation ${interpolation}.`);
  }
}

function splineWeights(amount, interpolation) {
  const squared = amount * amount;
  const cubed = squared * amount;
  if (String(interpolation).toUpperCase() === 'CARDINAL') {
    const tension = 0.71;
    return [
      (-tension * cubed) + (2 * tension * squared) - (tension * amount),
      ((2 - tension) * cubed) + ((tension - 3) * squared) + 1,
      ((tension - 2) * cubed) + ((3 - (2 * tension)) * squared) + (tension * amount),
      (tension * cubed) - (tension * squared),
    ];
  }
  return [
    (-cubed / 6) + (squared * 0.5) - (amount * 0.5) + (1 / 6),
    (cubed * 0.5) - squared + (2 / 3),
    (-cubed * 0.5) + (squared * 0.5) + (amount * 0.5) + (1 / 6),
    cubed / 6,
  ];
}

function sampleSplineRamp(ordered, factor, interpolation) {
  const count = ordered.length;
  let region = count;
  if (factor < ordered[0].position) region = 0;
  else {
    for (let index = 1; index < count; index += 1) {
      if (factor < ordered[index].position) {
        region = index;
        break;
      }
    }
  }
  const right = ordered[Math.min(region, count - 1)];
  const left = ordered[Math.max(0, region - 1)];
  const next = ordered[Math.min(region + 1, count - 1)];
  const previous = ordered[Math.max(0, region - 2)];
  const rightPosition = region === count ? 1 : right.position;
  const leftPosition = region === 0 ? 0 : left.position;
  const width = leftPosition - rightPosition;
  const amount = Math.min(1, Math.max(0, Math.abs(width) < 1e-7
    ? (region === count ? 1 : 0)
    : (factor - rightPosition) / width));
  const weights = splineWeights(amount, interpolation);
  const sources = [next, right, left, previous].map(stop => color(stop.color));
  return Array.from({ length: 4 }, (_, channel) => clamp01(
    sources.reduce((sum, source, index) => sum + (source[channel] * weights[index]), 0),
  ));
}

export function sampleBlenderColorRamp(
  stops,
  factor,
  interpolation = 'LINEAR',
  colorMode = 'RGB',
  hueInterpolation = 'NEAR',
) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new RangeError('A colour ramp requires at least two stops.');
  }
  const ordered = stops.map((stop, index) => ({
    index,
    position: finite(stop?.position),
    color: color(stop?.color),
  })).sort((left, right) => left.position - right.position || left.index - right.index);
  const mode = String(colorMode ?? 'RGB').toUpperCase();
  const curve = String(interpolation ?? 'LINEAR').toUpperCase();
  if (!['RGB', 'HSV', 'HSL'].includes(mode)) throw new RangeError(`Unsupported Color Ramp mode ${colorMode}.`);
  if (!['CONSTANT', 'LINEAR', 'EASE', 'CARDINAL', 'B_SPLINE'].includes(curve)) {
    throw new RangeError(`Unsupported Color Ramp interpolation ${interpolation}.`);
  }
  if (!['NEAR', 'FAR', 'CW', 'CCW'].includes(String(hueInterpolation).toUpperCase())) {
    throw new RangeError(`Unsupported hue interpolation ${hueInterpolation}.`);
  }
  if (mode === 'RGB' && ['CARDINAL', 'B_SPLINE'].includes(curve)) {
    return sampleSplineRamp(ordered, finite(factor), curve);
  }

  let result = [...ordered[0].color];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const width = current.position - previous.position;
    let amount = Math.abs(width) < 1e-7
      ? (finite(factor) >= current.position ? 1 : 0)
      : clamp01((finite(factor) - previous.position) / width);
    if (mode === 'RGB' && curve === 'CONSTANT') amount = finite(factor) >= current.position ? 1 : 0;
    else if (mode === 'RGB' && curve === 'EASE') amount = amount * amount * (3 - (2 * amount));
    if (mode === 'RGB') {
      result = result.map((component, channel) => mix(component, current.color[channel], amount));
      continue;
    }
    const convertFrom = mode === 'HSV' ? rgbToHsv : rgbToHsl;
    const convertTo = mode === 'HSV' ? hsvToRgb : hslToRgb;
    const left = convertFrom(result);
    const right = convertFrom(current.color);
    const converted = convertTo([
      mixHue(left[0], right[0], amount, hueInterpolation),
      mix(left[1], right[1], amount),
      mix(left[2], right[2], amount),
    ]);
    result = [...converted, mix(result[3], current.color[3], amount)];
  }
  return result;
}

export function separateBlenderColor(value, mode = 'RGB') {
  const source = color(value);
  const normalizedMode = String(mode ?? 'RGB').toUpperCase();
  const channels = normalizedMode === 'RGB' ? source.slice(0, 3)
    : normalizedMode === 'HSV' ? rgbToHsv(source)
      : normalizedMode === 'HSL' ? rgbToHsl(source) : null;
  if (!channels) throw new RangeError(`Unsupported Separate Color mode ${mode}.`);
  return { red: channels[0], green: channels[1], blue: channels[2], alpha: source[3] };
}

export function combineBlenderColor(red, green, blue, alpha = 1, mode = 'RGB') {
  const source = [finite(red), finite(green), finite(blue)];
  const normalizedMode = String(mode ?? 'RGB').toUpperCase();
  const rgb = normalizedMode === 'RGB' ? source
    : normalizedMode === 'HSV' ? hsvToRgb(source)
      : normalizedMode === 'HSL' ? hslToRgb(source) : null;
  if (!rgb) throw new RangeError(`Unsupported Combine Color mode ${mode}.`);
  return [...rgb, finite(alpha, 1)];
}

function componentBlend(mode, left, right) {
  switch (mode) {
    case 'MIX': return right;
    case 'ADD': return left + right;
    case 'SUBTRACT': return left - right;
    case 'MULTIPLY': return left * right;
    case 'DIVIDE': return left / Math.max(right, 1e-7);
    case 'DIFFERENCE': return Math.abs(left - right);
    case 'DARKEN': return Math.min(left, right);
    case 'LIGHTEN': return Math.max(left, right);
    case 'SCREEN': return 1 - ((1 - left) * (1 - right));
    case 'EXCLUSION': return left + right - (2 * left * right);
    case 'DODGE': return left / Math.max(1 - right, 1e-7);
    case 'BURN': return 1 - ((1 - left) / Math.max(right, 1e-7));
    case 'LINEAR_LIGHT': return left + (2 * right) - 1;
    case 'OVERLAY': return left < 0.5
      ? 2 * left * right
      : 1 - (2 * (1 - left) * (1 - right));
    case 'SOFT_LIGHT': {
      const low = 2 * left * right;
      const high = 1 - (2 * (1 - left) * (1 - right));
      return mix(low, high, left);
    }
    default: throw new RangeError(`Unsupported Mix blend mode ${mode}.`);
  }
}

export function blendBlenderValues(leftValue, rightValue, mode = 'MIX', valueType = 'color') {
  const normalizedMode = String(mode ?? 'MIX').toUpperCase();
  const normalizedType = String(valueType ?? 'color').toUpperCase();
  const leftWasArray = Array.isArray(leftValue);
  const rightWasArray = Array.isArray(rightValue);
  const length = Math.max(leftWasArray ? leftValue.length : 1, rightWasArray ? rightValue.length : 1);
  const left = color(leftValue, length);
  const right = color(rightValue, length);
  if (['HUE', 'SATURATION', 'COLOR', 'VALUE'].includes(normalizedMode)) {
    if (!['COLOR', 'VEC3', 'VEC4'].includes(normalizedType)) return rightWasArray ? right : right[0];
    const leftRgb = left.slice(0, 3);
    const rightRgb = right.slice(0, 3);
    const leftHsv = rgbToHsv(leftRgb);
    const rightHsv = rgbToHsv(rightRgb);
    let target;
    if (normalizedMode === 'HUE') {
      target = rightHsv[1] <= 0
        ? leftRgb
        : hsvToRgb([rightHsv[0], leftHsv[1], leftHsv[2]]);
    } else if (normalizedMode === 'SATURATION') {
      target = leftHsv[1] <= 0
        ? leftRgb
        : hsvToRgb([leftHsv[0], rightHsv[1], leftHsv[2]]);
    } else if (normalizedMode === 'COLOR') {
      target = rightHsv[1] <= 0
        ? leftRgb
        : hsvToRgb([rightHsv[0], rightHsv[1], leftHsv[2]]);
    } else target = hsvToRgb([leftHsv[0], leftHsv[1], rightHsv[2]]);
    const output = normalizedType === 'VEC4' ? [...target, left[3]] : target;
    return length === 1 && !leftWasArray && !rightWasArray ? output[0] : output;
  }
  const output = left.map((component, index) => componentBlend(normalizedMode, component, right[index]));
  return length === 1 && !leftWasArray && !rightWasArray ? output[0] : output;
}

export function mixBlenderValues(
  leftValue,
  rightValue,
  amount,
  mode = 'MIX',
  valueType = 'color',
) {
  const target = blendBlenderValues(leftValue, rightValue, mode, valueType);
  const length = Math.max(
    Array.isArray(leftValue) ? leftValue.length : 1,
    Array.isArray(target) ? target.length : 1,
  );
  const left = color(leftValue, length);
  const right = color(target, length);
  const factor = finite(amount);
  const result = left.map((component, index) => mix(component, right[index], factor));
  return length === 1 && !Array.isArray(leftValue) && !Array.isArray(target) ? result[0] : result;
}
