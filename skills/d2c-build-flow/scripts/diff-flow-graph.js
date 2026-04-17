#!/usr/bin/env node

/**
 * diff-flow-graph.js — Diff two flow-graph.json artifacts so re-run reports
 * highlight added/removed pages, renamed routes, and newly-wired edges
 * (B-FLOW-REPORT-DIFF).
 *
 * Usage:
 *   node diff-flow-graph.js <previous.json> <current.json>
 *
 * Stdout is a human-readable diff. Every section is skipped when empty — a
 * clean re-run emits `no changes`. Exits 0 on success, 1 on read error,
 * 2 on CLI misuse.
 *
 * Categories reported:
 *   - pages_added         pages present in current but not previous (by node_id)
 *   - pages_removed       pages present in previous but not current
 *   - routes_changed      same node_id, different route
 *   - branches_changed    same node_id, different branch letter
 *   - layouts_changed     layouts[] added/removed (by name) or applies_to changed
 *   - edges_added         (from,to) pair in current but not previous
 *   - edges_removed       (from,to) pair in previous but not current
 *   - edges_wired         edge with same (from,to) flipped from inferred=true
 *                         to inferred=false (or null → non-null source id)
 *   - edges_unwired       opposite of edges_wired — a regression
 *   - persistence_changed shared_state[i].persistence change (by name)
 *   - conditions_changed  edges[].condition added/removed/changed
 *
 * The script is pure and deterministic; no IO beyond reading both paths.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function diffFlowGraph(prev, curr) {
  if (!prev || !curr) throw new Error("both previous and current graphs are required");

  const prevPages = new Map((prev.pages || []).map((p) => [p.node_id, p]));
  const currPages = new Map((curr.pages || []).map((p) => [p.node_id, p]));

  const pages_added = [];
  const pages_removed = [];
  const routes_changed = [];
  const branches_changed = [];

  for (const [nodeId, page] of currPages) {
    if (!prevPages.has(nodeId)) {
      pages_added.push({
        node_id: nodeId,
        step_number: page.step_number,
        branch: page.branch ?? null,
        route: page.route,
      });
    } else {
      const before = prevPages.get(nodeId);
      if (before.route !== page.route) {
        routes_changed.push({
          node_id: nodeId,
          step_number: page.step_number,
          before: before.route,
          after: page.route,
        });
      }
      if ((before.branch ?? null) !== (page.branch ?? null)) {
        branches_changed.push({
          node_id: nodeId,
          step_number: page.step_number,
          before: before.branch ?? null,
          after: page.branch ?? null,
        });
      }
    }
  }
  for (const [nodeId, page] of prevPages) {
    if (!currPages.has(nodeId)) {
      pages_removed.push({
        node_id: nodeId,
        step_number: page.step_number,
        branch: page.branch ?? null,
        route: page.route,
      });
    }
  }

  const prevEdgeKey = (e) => `${e.from_node_id}=>${e.to_node_id}`;
  const prevEdges = new Map();
  for (const e of prev.edges || []) prevEdges.set(prevEdgeKey(e), e);
  const currEdges = new Map();
  for (const e of curr.edges || []) currEdges.set(prevEdgeKey(e), e);

  const edges_added = [];
  const edges_removed = [];
  const edges_wired = [];
  const edges_unwired = [];
  const conditions_changed = [];

  for (const [key, edge] of currEdges) {
    if (!prevEdges.has(key)) {
      edges_added.push({
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        inferred: edge.inferred,
        source_component_node_id: edge.source_component_node_id ?? null,
      });
      continue;
    }
    const before = prevEdges.get(key);
    const wasWired = before.inferred === false && before.source_component_node_id != null;
    const isWired = edge.inferred === false && edge.source_component_node_id != null;
    if (!wasWired && isWired) {
      edges_wired.push({
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        source_component_node_id: edge.source_component_node_id,
      });
    } else if (wasWired && !isWired) {
      edges_unwired.push({
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
      });
    }
    if (!deepEqual(before.condition ?? null, edge.condition ?? null)) {
      conditions_changed.push({
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        before: before.condition ?? null,
        after: edge.condition ?? null,
      });
    }
  }
  for (const [key, edge] of prevEdges) {
    if (!currEdges.has(key)) {
      edges_removed.push({
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
      });
    }
  }

  const layouts_changed = diffLayouts(prev.layouts || [], curr.layouts || []);
  const persistence_changed = diffSharedState(
    prev.shared_state || [],
    curr.shared_state || []
  );

  return {
    pages_added,
    pages_removed,
    routes_changed,
    branches_changed,
    layouts_changed,
    edges_added,
    edges_removed,
    edges_wired,
    edges_unwired,
    persistence_changed,
    conditions_changed,
  };
}

function diffLayouts(prev, curr) {
  const prevByName = new Map(prev.map((l) => [l.name, l]));
  const currByName = new Map(curr.map((l) => [l.name, l]));
  const out = [];
  for (const [name, layout] of currByName) {
    if (!prevByName.has(name)) {
      out.push({ kind: "added", name, applies_to: layout.applies_to });
      continue;
    }
    const before = prevByName.get(name);
    const a = [...(before.applies_to || [])].sort();
    const b = [...(layout.applies_to || [])].sort();
    if (!deepEqual(a, b)) {
      out.push({ kind: "applies_to_changed", name, before: a, after: b });
    }
  }
  for (const [name] of prevByName) {
    if (!currByName.has(name)) out.push({ kind: "removed", name });
  }
  return out;
}

function diffSharedState(prev, curr) {
  const prevByName = new Map(prev.map((s) => [s.name, s]));
  const currByName = new Map(curr.map((s) => [s.name, s]));
  const out = [];
  for (const [name, slice] of currByName) {
    const before = prevByName.get(name);
    if (!before) {
      out.push({ kind: "added", name, persistence: slice.persistence });
      continue;
    }
    if (before.persistence !== slice.persistence) {
      out.push({
        kind: "persistence_changed",
        name,
        before: before.persistence,
        after: slice.persistence,
      });
    }
    if ((before.ttl_seconds ?? null) !== (slice.ttl_seconds ?? null)) {
      out.push({
        kind: "ttl_changed",
        name,
        before: before.ttl_seconds ?? null,
        after: slice.ttl_seconds ?? null,
      });
    }
  }
  for (const [name] of prevByName) {
    if (!currByName.has(name)) out.push({ kind: "removed", name });
  }
  return out;
}

function isEmptyDiff(diff) {
  return Object.values(diff).every((arr) => Array.isArray(arr) && arr.length === 0);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function formatDiff(diff) {
  if (isEmptyDiff(diff)) return "no changes";

  const sections = [];
  const push = (title, items, fmt) => {
    if (items.length === 0) return;
    sections.push(`## ${title}`);
    for (const item of items) sections.push(`  - ${fmt(item)}`);
  };

  push("pages_added", diff.pages_added, (p) =>
    `step ${p.step_number}${p.branch ?? ""} → ${p.route} (node ${p.node_id})`
  );
  push("pages_removed", diff.pages_removed, (p) =>
    `step ${p.step_number}${p.branch ?? ""} → ${p.route} (node ${p.node_id})`
  );
  push("routes_changed", diff.routes_changed, (r) =>
    `step ${r.step_number} (node ${r.node_id}): ${r.before} → ${r.after}`
  );
  push("branches_changed", diff.branches_changed, (b) =>
    `step ${b.step_number} (node ${b.node_id}): ${b.before ?? "null"} → ${b.after ?? "null"}`
  );
  push("layouts_changed", diff.layouts_changed, (l) => {
    if (l.kind === "added") return `+ layout ${l.name} applies to [${l.applies_to.join(", ")}]`;
    if (l.kind === "removed") return `- layout ${l.name}`;
    return `~ layout ${l.name}: applies_to [${l.before.join(", ")}] → [${l.after.join(", ")}]`;
  });
  push("edges_added", diff.edges_added, (e) =>
    `${e.from_node_id} → ${e.to_node_id}${e.source_component_node_id ? ` (wired: ${e.source_component_node_id})` : ""}`
  );
  push("edges_removed", diff.edges_removed, (e) =>
    `${e.from_node_id} → ${e.to_node_id}`
  );
  push("edges_wired", diff.edges_wired, (e) =>
    `${e.from_node_id} → ${e.to_node_id} (now wired via ${e.source_component_node_id})`
  );
  push("edges_unwired", diff.edges_unwired, (e) =>
    `${e.from_node_id} → ${e.to_node_id} (regressed to inferred)`
  );
  push("persistence_changed", diff.persistence_changed, (p) => {
    if (p.kind === "added") return `+ state ${p.name} (persistence=${p.persistence})`;
    if (p.kind === "removed") return `- state ${p.name}`;
    if (p.kind === "persistence_changed")
      return `~ state ${p.name}: ${p.before} → ${p.after}`;
    return `~ state ${p.name} ttl_seconds: ${p.before} → ${p.after}`;
  });
  push("conditions_changed", diff.conditions_changed, (c) => {
    const fmt = (x) => (x === null ? "null" : JSON.stringify(x));
    return `${c.from_node_id} → ${c.to_node_id}: ${fmt(c.before)} → ${fmt(c.after)}`;
  });

  return sections.join("\n");
}

// ---------- CLI ----------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("usage: diff-flow-graph.js <previous.json> <current.json>\n");
    process.exit(2);
  }
  const prevPath = path.resolve(args[0]);
  const currPath = path.resolve(args[1]);
  let prev, curr;
  try {
    prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
  } catch (err) {
    process.stderr.write(`error: ${prevPath}: ${err.message}\n`);
    process.exit(1);
  }
  try {
    curr = JSON.parse(fs.readFileSync(currPath, "utf8"));
  } catch (err) {
    process.stderr.write(`error: ${currPath}: ${err.message}\n`);
    process.exit(1);
  }
  try {
    const diff = diffFlowGraph(prev, curr);
    process.stdout.write(formatDiff(diff) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { diffFlowGraph, formatDiff, isEmptyDiff };
