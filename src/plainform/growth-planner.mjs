function axisIndex(axis, fail) {
  const index = axis.findIndex(value => Math.abs(value) > 0.999999);
  if (index < 0) fail('plainform_axis_not_cardinal', 'Growth axes must be cardinal.');
  return index;
}

/** Stores growth-axis meaning and derives inherited length/thickness scaling. */
export class PlainformGrowthPlanner {
  constructor({ anchors, fail }) {
    this.anchors = anchors;
    this.fail = fail;
    this.axes = new Map();
  }

  setAxis(records, axis) {
    for (const record of records) this.axes.set(record.entity.id, [...axis]);
  }

  axis(record) {
    const explicit = this.axes.get(record.entity.id);
    if (explicit) return [...explicit];
    const recipe = this.anchors.dimensions(record, [0, 1, 0]).recipe;
    if (recipe.kind === 'cylinder') return [0, 1, 0];
    this.fail('plainform_growth_axis_required', `${record.entity.id} needs an explicit growth axis.`);
  }

  inheritedScale(record, parent, lengthFactor, thicknessFactor) {
    const childAxis = this.axis(record);
    const parentAxis = this.axis(parent);
    const child = this.anchors.dimensions(record, childAxis);
    const source = this.anchors.dimensions(parent, parentAxis);
    const lengthScale = source.length * lengthFactor / child.raw.size[child.axisIndex];
    const thicknessScale = source.thickness * thicknessFactor / child.raw.thickness;
    const scale = [thicknessScale, thicknessScale, thicknessScale];
    scale[axisIndex(childAxis, this.fail)] = lengthScale;
    return scale;
  }
}
