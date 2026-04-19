#!/usr/bin/env node

/**
 * write-flow-lock.js — Emit flow-decisions-lock.json from a validated
 * flow-graph.json. Called by /d2c-build-flow Phase 2a step 9 immediately
 * after validate-flow-graph.js exits 0. Mirrors the role of d2c-build's
 * decisions-lock.json: freezes every flow-level choice so Phase 3/4/5
 * retries converge instead of silently re-deciding.
 *
 * Usage:
 *   node write-flow-lock.js <flow-graph-path> [--out <lock-path>] [--locked-at <iso>]
 *
 * Defaults:
 *   --out         <run-dir>/flow/flow-decisions-lock.json (sibling of flow-graph.json)
 *   --locked-at   current ISO 8601 timestamp (with timezone)
 *
 * Determinism:
 *   Same input flow-graph.json + same --locked-at always produces a
 *   byte-identical lock file. Use --locked-at in tests to pin timestamps.
 *
 * Exit codes:
 *   0 — lock written; absolute path of the lock printed to stdout
 *   1 — flow-graph.json missing / unparseable / structurally invalid
 *   2 — CLI misuse
 *
 * Exports `buildFlowLock(graph, { lockedAt, flowGraphHash })` and
 * `readFlowLock(lockPath)` for tests and for items 2-4 of the parity plan.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_VERSION = 1;

function isoNow() {
  return new Date().toISOString();
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function lockEntry(value, lockedAt) {
  return { value, status: "locked", locked_at: lockedAt };
}

function buildFlowDecisions(graph, lockedAt) {
  const fd = {
    mode: lockEntry(graph.mode, lockedAt),
    mode_source: lockEntry(graph.mode_source ?? "explicit", lockedAt),
    shell_detected: lockEntry(
      Array.isArray(graph.layouts) && graph.layouts.length > 0,
      lockedAt
    ),
    project_conventions: {
      component_type: lockEntry(
        graph.project_conventions?.component_type ?? null,
        lockedAt
      ),
      error_boundary_kind: lockEntry(
        graph.project_conventions?.error_boundary?.kind ?? null,
        lockedAt
      ),
      data_fetching_kind: lockEntry(
        graph.project_conventions?.data_fetching?.kind ?? null,
        lockedAt
      ),
    },
    stepper_groups: lockEntry(
      (graph.stepper_groups || []).map((g) => ({
        name: g.name,
        route: g.route,
        validation_enabled: g.validation_enabled ?? false,
        persistence: g.persistence ?? null,
      })),
      lockedAt
    ),
  };

  if (graph.mode_source === "auto" && typeof graph.mode_confidence === "number") {
    fd.mode_confidence = lockEntry(graph.mode_confidence, lockedAt);
  }

  if (fd.shell_detected.value && graph.layouts[0]?.figma_node_id) {
    fd.shell_node_id = lockEntry(graph.layouts[0].figma_node_id, lockedAt);
  }

  return fd;
}

function buildPageDecisions(graph, lockedAt) {
  const out = {};
  for (const page of graph.pages || []) {
    if (!page.node_id) continue;
    const decisions = {
      route: lockEntry(page.route ?? null, lockedAt),
    };
    if (page.layout_applied !== undefined && page.layout_applied !== null) {
      decisions.layout_applied = lockEntry(page.layout_applied, lockedAt);
    } else {
      const layout = (graph.layouts || []).find(
        (l) => Array.isArray(l.applies_to) && l.applies_to.includes(page.node_id)
      );
      if (layout) {
        decisions.layout_applied = lockEntry(layout.name, lockedAt);
      }
    }
    if (page.mobile_variant && page.mobile_variant.figma_url) {
      decisions.mobile_variant_figma_url = lockEntry(
        page.mobile_variant.figma_url,
        lockedAt
      );
    }
    out[page.node_id] = decisions;
  }
  return out;
}

function buildEdgeDecisions(graph, lockedAt) {
  const out = {};
  for (const edge of graph.edges || []) {
    if (!edge.from_node_id || !edge.to_node_id) continue;
    const key = `${edge.from_node_id}__${edge.to_node_id}`;
    const decisions = {
      source_component_node_id: lockEntry(
        edge.source_component_node_id ?? null,
        lockedAt
      ),
      trigger: lockEntry(edge.trigger ?? null, lockedAt),
    };
    if (edge.condition && typeof edge.condition === "object") {
      decisions.condition_kind = lockEntry(edge.condition.kind ?? null, lockedAt);
      if (edge.condition.field !== undefined) {
        decisions.condition_field = lockEntry(edge.condition.field, lockedAt);
      }
      if (edge.condition.value !== undefined) {
        decisions.condition_value = lockEntry(edge.condition.value, lockedAt);
      }
    }
    out[key] = decisions;
  }
  return out;
}

function buildFlowLock(graph, { lockedAt = isoNow(), flowGraphHash } = {}) {
  if (!graph || typeof graph !== "object") {
    throw new Error("flow-graph must be a parsed JSON object");
  }
  if (!flowGraphHash || !/^[a-f0-9]{64}$/.test(flowGraphHash)) {
    throw new Error("flowGraphHash must be a 64-char SHA-256 hex string");
  }
  return {
    schema_version: SCHEMA_VERSION,
    locked_at: lockedAt,
    flow_graph_hash: flowGraphHash,
    flow_decisions: buildFlowDecisions(graph, lockedAt),
    page_decisions: buildPageDecisions(graph, lockedAt),
    edge_decisions: buildEdgeDecisions(graph, lockedAt),
  };
}

function readFlowLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    throw new Error(`flow-decisions-lock not found at ${lockPath}`);
  }
  const raw = fs.readFileSync(lockPath, "utf8");
  return JSON.parse(raw);
}

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function parseArgs(argv) {
  const out = { graphPath: null, outPath: null, lockedAt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outPath = argv[++i];
    else if (a === "--locked-at") out.lockedAt = argv[++i];
    else if (!out.graphPath) out.graphPath = a;
    else return null;
  }
  return out.graphPath ? out : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: write-flow-lock.js <flow-graph-path> [--out <lock-path>] [--locked-at <iso>]"
    );
    process.exit(2);
  }

  let raw, graph;
  try {
    raw = fs.readFileSync(args.graphPath);
    graph = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error(`error: could not read/parse flow-graph: ${e.message}`);
    process.exit(1);
  }

  const flowGraphHash = sha256Hex(raw);
  let lock;
  try {
    lock = buildFlowLock(graph, { lockedAt: args.lockedAt ?? isoNow(), flowGraphHash });
  } catch (e) {
    console.error(`error: could not build lock: ${e.message}`);
    process.exit(1);
  }

  const outPath =
    args.outPath ??
    path.join(path.dirname(args.graphPath), "flow-decisions-lock.json");

  atomicWrite(outPath, JSON.stringify(lock, null, 2));
  console.log(path.resolve(outPath));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { buildFlowLock, readFlowLock, sha256Hex, SCHEMA_VERSION };
