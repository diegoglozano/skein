#!/usr/bin/env node
// Regression-ratio gate for the native micro-benchmarks (DECISIONS.md D5).
// Compares a fresh `cargo run --release --example bench` JSON line against the
// committed baseline; fails on >20% slowdown in any timed metric.
//
// Usage:
//   cargo run --release --example bench | node bench/compare-bench.mjs [--warn-only]
//   node bench/compare-bench.mjs --update   # rewrite baseline from stdin
//
// Baselines are machine-class specific: refresh with --update when the CI
// runner class changes, never to paper over a regression.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baselines', 'native-bench.json');
const THRESHOLD = 1.2;

const warnOnly = process.argv.includes('--warn-only');
const update = process.argv.includes('--update');

const input = readFileSync(0, 'utf8').trim().split('\n').at(-1);
const current = JSON.parse(input);

if (update) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`baseline updated: ${BASELINE}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
let failed = false;
for (const key of Object.keys(baseline).filter((k) => k.endsWith('_secs'))) {
  const ratio = current[key] / baseline[key];
  const verdict = ratio > THRESHOLD ? 'REGRESSION' : 'ok';
  if (ratio > THRESHOLD) failed = true;
  console.log(
    `${key}: baseline ${baseline[key]}s → current ${current[key]}s (${ratio.toFixed(2)}x) ${verdict}`,
  );
}

if (failed && !warnOnly) {
  console.error(`\nbenchmark regression >${((THRESHOLD - 1) * 100).toFixed(0)}% — investigate or (justifiedly) refresh the baseline with --update`);
  process.exit(1);
}
