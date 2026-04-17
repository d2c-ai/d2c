#!/usr/bin/env node

/**
 * detect-mode.js — Figma-driven auto-detection of flow mode
 * (routes | stepper | hybrid) when the prompt does not declare one explicitly.
 *
 * Consumed by d2c-build-flow Phase 2a when parse-flow-prompt returns
 * mode='auto' (the default when the user omits `mode:`). Produces a terminal
 * mode decision plus a per-signal reason trace that the validator and the
 * Phase 6 report surface verbatim.
 *
 * Input:
 *   {
 *     pages: [
 *       {
 *         node_id: "1:2",
 *         figma_url: "...",
 *         frame_size: { width: 1440, height: 900 },
 *         top_level_children: [ ... ],           // consumed by detect-shared-shell
 *         differential_region: {                 // optional; computed by Phase 2a
 *           area_ratio: 0.35,                    // non-shared region's fraction of frame area
 *           bbox: { x, y, width, height }       // consistent position across pages = stepper signal
 *         },
 *         prototype_edges: [                    // optional; from Figma prototype metadata
 *           { to_node_id: "3:4", trigger_label: "Next" }
 *         ]
 *       },
 *       ...
 *     ],
 *     shell_result: <detectSharedShell output>,  // from the bumped-threshold run (0.90)
 *     explicit_groups: []                        // any `Stepper group` blocks already declared
 *   }
 *
 * Output:
 *   {
 *     detected_mode: "routes" | "stepper" | "hybrid",
 *     mode_confidence: number (0..1),
 *     mode_detection_reasons: [
 *       { signal: "frame_size_uniformity", score: 0.95, detail: "all 3 frames 1440×900 ±0px" },
 *       ...
 *     ],
 *     partition: {
 *       runs: [
 *         { kind: "stepper", page_indices: [0, 1, 2], confidence: 0.92 },
 *         { kind: "routes",  page_indices: [3, 4],    confidence: 0.88 }
 *       ]
 *     },
 *     aborted: false,                            // true when confidence < 0.55 — flow-graph must not be written
 *     abort_reason: null
 *   }
 *
 * Confidence bands (see plan file):
 *   ≥ 0.80  → silent auto-pick
 *   0.55–0.80 → advisory (still returns the decision; caller logs loudly)
 *   < 0.55  → abort (detected_mode still populated for debugging, but
 *             aborted=true and Phase 2a must fall through to an error that
 *             tells the user to pass `mode:` explicitly)
 */

"use strict";

const SILENT_THRESHOLD = 0.8;
const ABORT_THRESHOLD = 0.55;

const SIGNAL_WEIGHTS = {
  frame_size_uniformity: 0.15,
  shared_shell_coverage: 0.3,
  stepper_indicator_instance: 0.3,
  differential_region_geometry: 0.15,
  prototype_semantics: 0.1,
};

function detectMode({ pages, shell_result = null, explicit_groups = [] } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError("pages must be a non-empty array");
  }

  // If the user already declared Stepper group blocks explicitly, the mode is
  // locked to 'hybrid' (or 'stepper' if every page is inside a group). We
  // still run detection to populate the reason trace for observability.
  const allInGroup =
    explicit_groups.length > 0 &&
    pages.every((p) =>
      explicit_groups.some((g) =>
        Array.isArray(g.page_node_ids) && g.page_node_ids.includes(p.node_id)
      )
    );

  const reasons = [];

  const frameSizeSignal = scoreFrameSizeUniformity(pages);
  reasons.push(frameSizeSignal);

  const shellCoverageSignal = scoreSharedShellCoverage(pages, shell_result);
  reasons.push(shellCoverageSignal);

  const stepperIndicatorSignal = scoreStepperIndicator(shell_result);
  reasons.push(stepperIndicatorSignal);

  const differentialRegionSignal = scoreDifferentialRegion(pages);
  reasons.push(differentialRegionSignal);

  const prototypeSemanticsSignal = scorePrototypeSemantics(pages);
  reasons.push(prototypeSemanticsSignal);

  // Partition pages into contiguous runs where every pair of neighbouring
  // pages scores 'stepper-like' together. A pair is stepper-like when the
  // per-pair signals exceed the per-pair threshold.
  const partition = partitionPages(pages, shell_result);

  let detected_mode;
  if (partition.runs.length === 0) {
    detected_mode = "routes";
  } else if (
    partition.runs.length === 1 &&
    partition.runs[0].kind === "stepper" &&
    partition.runs[0].page_indices.length === pages.length
  ) {
    detected_mode = "stepper";
  } else if (partition.runs.every((r) => r.kind === "routes")) {
    detected_mode = "routes";
  } else {
    detected_mode = "hybrid";
  }

  // Overall confidence = weighted sum of signal scores in the direction of the
  // chosen mode. For routes the signals invert (low stepper signal = high
  // routes confidence); for stepper/hybrid we average the per-run confidence.
  let mode_confidence;
  if (detected_mode === "routes") {
    mode_confidence = Math.max(
      0,
      Math.min(1, 1 - weightedAverage(reasons))
    );
  } else if (detected_mode === "stepper") {
    mode_confidence = weightedAverage(reasons);
  } else {
    // hybrid: average the partition's per-run confidence so a mixed flow where
    // one run is very certain doesn't mask another run's ambiguity.
    const sum = partition.runs.reduce((a, r) => a + r.confidence, 0);
    mode_confidence = partition.runs.length > 0 ? sum / partition.runs.length : 0;
  }

  if (allInGroup && explicit_groups.length > 0) {
    // Explicit declaration overrides detection; trust it and mark 1.0.
    detected_mode = explicit_groups.length > 1 ? "hybrid" : "stepper";
    mode_confidence = 1.0;
    reasons.push({
      signal: "prototype_semantics",
      score: 1.0,
      detail: `explicit Stepper group block(s) in prompt — detection bypassed`,
    });
  } else if (explicit_groups.length > 0) {
    detected_mode = "hybrid";
    mode_confidence = Math.max(mode_confidence, 0.85);
    reasons.push({
      signal: "prototype_semantics",
      score: 0.9,
      detail: `${explicit_groups.length} explicit Stepper group block(s) + ${pages.length - countPagesInGroups(pages, explicit_groups)} standalone route page(s)`,
    });
  }

  const aborted = mode_confidence < ABORT_THRESHOLD;
  const abort_reason = aborted
    ? `Mode auto-detection confidence ${mode_confidence.toFixed(2)} below abort threshold ${ABORT_THRESHOLD}. Pass \`mode: routes | stepper | hybrid\` explicitly.`
    : null;

  return {
    detected_mode,
    mode_confidence,
    mode_detection_reasons: reasons,
    partition,
    aborted,
    abort_reason,
    band:
      mode_confidence >= SILENT_THRESHOLD
        ? "silent"
        : mode_confidence >= ABORT_THRESHOLD
        ? "advisory"
        : "abort",
  };
}

// ---------- Signal scorers ----------

function scoreFrameSizeUniformity(pages) {
  const sizes = pages
    .map((p) => (p && p.frame_size ? p.frame_size : null))
    .filter(Boolean);
  if (sizes.length < 2) {
    return {
      signal: "frame_size_uniformity",
      score: 0,
      detail: "frame_size missing on too many pages to measure uniformity",
    };
  }
  const first = sizes[0];
  const tolerance = 2; // px
  const allMatch = sizes.every(
    (s) =>
      Math.abs(s.width - first.width) <= tolerance &&
      Math.abs(s.height - first.height) <= tolerance
  );
  if (allMatch) {
    return {
      signal: "frame_size_uniformity",
      score: 1,
      detail: `all ${sizes.length} frames ${first.width}×${first.height} (±${tolerance}px)`,
    };
  }
  const widths = sizes.map((s) => s.width);
  const heights = sizes.map((s) => s.height);
  const maxWDiff = Math.max(...widths) - Math.min(...widths);
  const maxHDiff = Math.max(...heights) - Math.min(...heights);
  return {
    signal: "frame_size_uniformity",
    score: 0,
    detail: `frames vary by up to ${maxWDiff}×${maxHDiff}px — mixed sizes`,
  };
}

function scoreSharedShellCoverage(pages, shell_result) {
  if (!shell_result || !shell_result.layouts || shell_result.layouts.length === 0) {
    return {
      signal: "shared_shell_coverage",
      score: 0,
      detail: "no shared shell detected at 90% threshold",
    };
  }
  const layout = shell_result.layouts[0];
  const coverage = layout.applies_to.length / pages.length;
  if (coverage >= 0.9) {
    return {
      signal: "shared_shell_coverage",
      score: 1,
      detail: `shared shell "${layout.name}" covers ${layout.applies_to.length}/${pages.length} pages`,
    };
  }
  return {
    signal: "shared_shell_coverage",
    score: coverage,
    detail: `partial shared shell "${layout.name}" (${layout.applies_to.length}/${pages.length} pages)`,
  };
}

function scoreStepperIndicator(shell_result) {
  if (!shell_result || !shell_result.layouts || shell_result.layouts.length === 0) {
    return {
      signal: "stepper_indicator_instance",
      score: 0,
      detail: "no shared shell to search for indicator",
    };
  }
  const indicator = shell_result.layouts[0].stepper_indicator;
  if (!indicator) {
    return {
      signal: "stepper_indicator_instance",
      score: 0,
      detail: "no repeated indicator sub-instance with ordered variants",
    };
  }
  if (indicator.ordered) {
    return {
      signal: "stepper_indicator_instance",
      score: 1,
      detail: `indicator "${indicator.name}" variants advance in order across pages`,
    };
  }
  return {
    signal: "stepper_indicator_instance",
    score: 0.5,
    detail: `indicator "${indicator.name}" varies per page but not in a clear order`,
  };
}

function scoreDifferentialRegion(pages) {
  const ratios = pages
    .map((p) => (p && p.differential_region ? p.differential_region.area_ratio : null))
    .filter((r) => typeof r === "number");
  if (ratios.length < 2) {
    return {
      signal: "differential_region_geometry",
      score: 0,
      detail: "differential_region missing — cannot measure swap-in-place shape",
    };
  }
  const maxRatio = Math.max(...ratios);
  const minRatio = Math.min(...ratios);
  if (maxRatio <= 0.6 && maxRatio - minRatio <= 0.1) {
    return {
      signal: "differential_region_geometry",
      score: 1,
      detail: `non-shared content occupies ${(maxRatio * 100).toFixed(0)}% of frame (consistent across pages)`,
    };
  }
  if (maxRatio <= 0.6) {
    return {
      signal: "differential_region_geometry",
      score: 0.5,
      detail: `non-shared content fits the swap region (≤60%) but varies per page by ${((maxRatio - minRatio) * 100).toFixed(0)}%`,
    };
  }
  return {
    signal: "differential_region_geometry",
    score: 0,
    detail: `non-shared content ${(maxRatio * 100).toFixed(0)}% of frame — too large to swap in place`,
  };
}

function scorePrototypeSemantics(pages) {
  let advanceEdges = 0;
  let otherEdges = 0;
  for (const p of pages) {
    if (!Array.isArray(p.prototype_edges)) continue;
    for (const e of p.prototype_edges) {
      if (!e || typeof e.trigger_label !== "string") continue;
      if (/\b(next|continue|proceed|finish|submit|step)\b/i.test(e.trigger_label)) {
        advanceEdges += 1;
      } else {
        otherEdges += 1;
      }
    }
  }
  const total = advanceEdges + otherEdges;
  if (total === 0) {
    return {
      signal: "prototype_semantics",
      score: 0,
      detail: "no prototype edges in metadata",
    };
  }
  const ratio = advanceEdges / total;
  return {
    signal: "prototype_semantics",
    score: ratio,
    detail: `${advanceEdges}/${total} prototype edges read as step-advance (next/continue/…)`,
  };
}

// ---------- Partitioning ----------

function partitionPages(pages, shell_result) {
  if (pages.length < 2) {
    return { runs: [] };
  }

  const sharedShellPageIds = new Set(
    shell_result && shell_result.layouts && shell_result.layouts.length > 0
      ? shell_result.layouts[0].applies_to
      : []
  );
  const indicator =
    shell_result && shell_result.layouts && shell_result.layouts[0]
      ? shell_result.layouts[0].stepper_indicator
      : null;

  const pairScores = [];
  for (let i = 0; i < pages.length - 1; i++) {
    const a = pages[i];
    const b = pages[i + 1];
    const sameSize =
      a.frame_size &&
      b.frame_size &&
      Math.abs(a.frame_size.width - b.frame_size.width) <= 2 &&
      Math.abs(a.frame_size.height - b.frame_size.height) <= 2;
    const bothInShell =
      sharedShellPageIds.has(a.node_id) && sharedShellPageIds.has(b.node_id);
    const indicatorAdvances =
      indicator &&
      indicator.variants_per_page &&
      indicator.variants_per_page[a.node_id] !== undefined &&
      indicator.variants_per_page[b.node_id] !== undefined &&
      indicator.variants_per_page[a.node_id] !==
        indicator.variants_per_page[b.node_id];
    const score =
      (sameSize ? 0.3 : 0) +
      (bothInShell ? 0.4 : 0) +
      (indicatorAdvances ? 0.3 : 0);
    pairScores.push(score);
  }

  const runs = [];
  let cursor = 0;
  while (cursor < pages.length) {
    let end = cursor;
    while (end < pages.length - 1 && pairScores[end] >= 0.7) end += 1;
    if (end === cursor) {
      runs.push({
        kind: "routes",
        page_indices: [cursor],
        confidence: 1 - (pairScores[cursor] || 0),
      });
      cursor += 1;
    } else {
      const indices = [];
      for (let i = cursor; i <= end; i++) indices.push(i);
      const relevantScores = pairScores.slice(cursor, end);
      const avg = relevantScores.reduce((a, b) => a + b, 0) / relevantScores.length;
      runs.push({
        kind: "stepper",
        page_indices: indices,
        confidence: avg,
      });
      cursor = end + 1;
    }
  }

  // Single-step runs of kind "routes" surrounded by stepper runs are still
  // legitimately routes — leave them as-is. But if every run is routes and
  // pages all share a shell at high coverage, collapse to a single stepper run
  // so flows that lack prototype metadata don't fall to routes by default.
  if (
    runs.every((r) => r.kind === "routes") &&
    sharedShellPageIds.size === pages.length &&
    indicator &&
    indicator.ordered
  ) {
    return {
      runs: [
        {
          kind: "stepper",
          page_indices: pages.map((_, i) => i),
          confidence: 0.85,
        },
      ],
    };
  }

  return { runs };
}

function weightedAverage(reasons) {
  let total = 0;
  let weightSum = 0;
  for (const r of reasons) {
    const w = SIGNAL_WEIGHTS[r.signal] || 0;
    total += r.score * w;
    weightSum += w;
  }
  return weightSum === 0 ? 0 : total / weightSum;
}

function countPagesInGroups(pages, explicit_groups) {
  const inGroup = new Set();
  for (const g of explicit_groups) {
    if (!Array.isArray(g.page_node_ids)) continue;
    for (const id of g.page_node_ids) inGroup.add(id);
  }
  return pages.filter((p) => inGroup.has(p.node_id)).length;
}

// ---------- CLI ----------

function runCli(argv) {
  const fs = require("fs");
  const path = require("path");
  if (argv.length !== 1) {
    process.stderr.write("usage: detect-mode.js <input.json>\n");
    process.stderr.write(
      "  input.json: { pages, shell_result?, explicit_groups? }\n"
    );
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(argv[0]), "utf8"));
  const result = detectMode(input);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.aborted ? 1 : 0);
}

module.exports = {
  detectMode,
  SILENT_THRESHOLD,
  ABORT_THRESHOLD,
  SIGNAL_WEIGHTS,
};

if (require.main === module) {
  runCli(process.argv.slice(2));
}
