import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAINFORM_VISUAL_BENCHMARKS, runPlainformVisualBenchmark } from '../src/plainform/visual-benchmarks.mjs';
import { PLAINFORM_VISUAL_BENCHMARK_EXPECTATIONS } from './fixtures/plainform-visual-benchmark-expectations.mjs';

function contractSnapshot(actual) {
  return {
    id: actual.id,
    ast: actual.ast,
    dependencyGraph: { kinds: actual.dependencyGraph.kinds, hash: actual.dependencyGraph.hash },
    metrics: actual.metrics,
    semanticIds: actual.semanticIds,
    semanticIdentityHash: actual.semanticIdentityHash,
    operationHash: actual.operationHash,
    evidenceViews: actual.evidenceViews,
  };
}

test('Plainform visual benchmark suite pins all eight roadmap reference designs without a GPU', () => {
  assert.deepEqual(PLAINFORM_VISUAL_BENCHMARKS.map(item => item.id), ['face-patch', 'eye-assembly', 'hair-groom', 'branch-collar', 'pine-tree', 'shader-edit', 'event-sheet', 'hero-composition']);
  for (const benchmark of PLAINFORM_VISUAL_BENCHMARKS) {
    const actual = runPlainformVisualBenchmark(benchmark);
    assert.deepEqual(contractSnapshot(actual), PLAINFORM_VISUAL_BENCHMARK_EXPECTATIONS[benchmark.id], `${benchmark.id} changed its pinned Plainform contract`);
    assert.ok(actual.evidenceViews.every(view => view.id && view.hardGate && view.semanticTargets.length > 0));
    assert.ok(actual.dependencyGraph.nodes.length > 0, `${benchmark.id} must expose an inspectable dependency-graph sample`);
  }
});

test('Plainform benchmark lowering is byte deterministic for every canonical design', () => {
  for (const benchmark of PLAINFORM_VISUAL_BENCHMARKS) assert.deepEqual(runPlainformVisualBenchmark(benchmark), runPlainformVisualBenchmark(benchmark));
});
