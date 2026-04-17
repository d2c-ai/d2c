#!/usr/bin/env node

/**
 * flow-reuse-metric.js — Report the component-reuse figure shown in the
 * d2c-build-flow Phase 6 report.
 *
 * Walks every `<run-dir>/pages/<node_id>/component-match.json`, resolves
 * each node's chosen componentId to its source file path via that page's
 * candidates[], and counts how many distinct source paths appear on at
 * least two pages. The __NEW__ sentinel and null choices are skipped
 * (not yet real components).
 *
 * Usage:
 *   node flow-reuse-metric.js <run-dir>
 *
 * Stdout (machine-readable):
 *   reused: <N>     // distinct sources seen on >= 2 pages
 *   total:  <M>     // distinct sources seen overall
 *   percent: <P>    // round(100 * N / M); 0 when M == 0
 *
 * Exit codes: 0 ok, 1 fatal read error, 2 CLI misuse.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function computeReuseMetric(runDir) {
  const pagesDir = path.join(runDir, "pages");
  if (!fs.existsSync(pagesDir) || !fs.statSync(pagesDir).isDirectory()) {
    throw new Error(`pages directory not found: ${pagesDir}`);
  }

  const pageDirs = fs
    .readdirSync(pagesDir)
    .map((name) => path.join(pagesDir, name))
    .filter((p) => fs.statSync(p).isDirectory());

  // source -> Set<pageDir>
  const sourceToPages = new Map();

  for (const pageDir of pageDirs) {
    const matchPath = path.join(pageDir, "component-match.json");
    if (!fs.existsSync(matchPath)) continue;
    const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
    const nodes = match.nodes || {};
    for (const node of Object.values(nodes)) {
      if (!node || !node.chosen || node.chosen === "__NEW__") continue;
      const candidates = Array.isArray(node.candidates) ? node.candidates : [];
      const picked = candidates.find((c) => c && c.componentId === node.chosen);
      if (!picked || typeof picked.source !== "string" || !picked.source) continue;

      if (!sourceToPages.has(picked.source)) {
        sourceToPages.set(picked.source, new Set());
      }
      sourceToPages.get(picked.source).add(pageDir);
    }
  }

  const total = sourceToPages.size;
  let reused = 0;
  for (const pages of sourceToPages.values()) {
    if (pages.size >= 2) reused += 1;
  }
  const percent = total === 0 ? 0 : Math.round((100 * reused) / total);
  return { reused, total, percent };
}

function runCli(argv) {
  if (argv.length !== 1) {
    process.stderr.write("usage: flow-reuse-metric.js <run-dir>\n");
    process.exit(2);
  }
  const runDir = path.resolve(argv[0]);
  let result;
  try {
    result = computeReuseMetric(runDir);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`reused: ${result.reused}\n`);
  process.stdout.write(`total: ${result.total}\n`);
  process.stdout.write(`percent: ${result.percent}\n`);
  process.exit(0);
}

module.exports = { computeReuseMetric };

if (require.main === module) {
  runCli(process.argv.slice(2));
}
