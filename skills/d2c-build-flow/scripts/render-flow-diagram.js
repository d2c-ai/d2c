#!/usr/bin/env node

/**
 * render-flow-diagram.js — Render a flow-graph.json as a Mermaid or ASCII
 * diagram for the d2c-build-flow Phase 6 report (B-FLOW-REPORT-DIAGRAM).
 *
 * Usage:
 *   node render-flow-diagram.js <flow-graph-path> [--format mermaid|ascii]
 *
 * Stdout is the rendered diagram. No extra logging, so the output can be
 * piped straight into the report.
 *
 * Defaults to Mermaid (`flowchart LR`) which renders cleanly in Markdown
 * previewers, GitHub, and the d2c-build run report. The ASCII form is a
 * fallback for terminals that don't render Mermaid.
 *
 * Edge styling:
 *   - inferred: false + non-null source_component_node_id → solid arrow `-->`
 *   - inferred: true  (or null source_component_node_id)  → dashed arrow `-.->`
 *     labelled with "(inferred)"
 *   - edges with a `condition` object (B-FLOW-CONDITIONAL-NAV) are annotated
 *     with a compact summary of the condition kind/value
 *   - back-edges (loops) are rendered with a "loop" label so users see why the
 *     validator didn't flag the cycle
 */

"use strict";

const fs = require("fs");
const path = require("path");

function renderFlowDiagram(graph, { format = "mermaid" } = {}) {
  if (!graph || !Array.isArray(graph.pages) || !Array.isArray(graph.edges)) {
    throw new Error(
      "flow-graph must include arrays `pages` and `edges` (nothing to render)"
    );
  }
  if (format !== "mermaid" && format !== "ascii") {
    throw new Error(`unsupported format "${format}" — use "mermaid" or "ascii"`);
  }

  if (format === "mermaid") return renderMermaid(graph);
  return renderAscii(graph);
}

function renderMermaid(graph) {
  const lines = ["```mermaid", "flowchart LR"];

  for (const page of graph.pages) {
    const id = sanitizeId(page.node_id);
    const label = escapeMermaidLabel(pageLabel(page));
    lines.push(`  ${id}["${label}"]`);
  }

  for (const edge of graph.edges) {
    const from = sanitizeId(edge.from_node_id);
    const to = sanitizeId(edge.to_node_id);
    const arrow = isWiredEdge(edge) ? "-->" : "-.->";
    const parts = [];
    if (!isWiredEdge(edge)) parts.push("inferred");
    if (edge.condition) parts.push(`if ${summariseCondition(edge.condition)}`);
    if (edge.kind === "loop" || edge.is_loop === true) parts.push("loop");
    const label = parts.length > 0 ? `|${escapeMermaidLabel(parts.join(", "))}|` : "";
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function renderAscii(graph) {
  const lines = [];
  const pagesById = new Map(graph.pages.map((p) => [p.node_id, p]));

  lines.push("Pages:");
  for (const page of graph.pages) {
    lines.push(`  [${pageLabel(page)}]`);
  }
  lines.push("");
  lines.push("Edges:");
  if (graph.edges.length === 0) {
    lines.push("  (no edges)");
    return lines.join("\n");
  }
  for (const edge of graph.edges) {
    const from = pagesById.get(edge.from_node_id);
    const to = pagesById.get(edge.to_node_id);
    const fromLabel = from ? pageLabel(from) : edge.from_node_id;
    const toLabel = to ? pageLabel(to) : edge.to_node_id;
    const arrow = isWiredEdge(edge) ? "-->" : "-.->";
    const annotations = [];
    if (!isWiredEdge(edge)) annotations.push("inferred");
    if (edge.condition) annotations.push(`if ${summariseCondition(edge.condition)}`);
    if (edge.kind === "loop" || edge.is_loop === true) annotations.push("loop");
    const suffix = annotations.length > 0 ? `  [${annotations.join(", ")}]` : "";
    lines.push(`  [${fromLabel}] ${arrow} [${toLabel}]${suffix}`);
  }
  return lines.join("\n");
}

function pageLabel(page) {
  const parts = [];
  const step = page.branch
    ? `Step ${page.step_number}${page.branch}`
    : `Step ${page.step_number}`;
  parts.push(step);
  if (page.route) parts.push(page.route);
  if (page.page_type && page.page_type !== "page") parts.push(`(${page.page_type})`);
  return parts.join(" · ");
}

function isWiredEdge(edge) {
  return edge.inferred === false && edge.source_component_node_id != null;
}

function summariseCondition(cond) {
  if (!cond || typeof cond !== "object") return "?";
  if (cond.kind === "state-equals") {
    return `${cond.field} == ${JSON.stringify(cond.value)}`;
  }
  if (cond.kind === "state-truthy") return `${cond.field} truthy`;
  if (cond.kind === "state-falsy") return `${cond.field} falsy`;
  if (cond.kind) return String(cond.kind);
  return "?";
}

function sanitizeId(nodeId) {
  // Mermaid node ids can't contain colons, spaces, etc.; safe-encode.
  return String(nodeId).replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeMermaidLabel(s) {
  return String(s).replace(/"/g, "'").replace(/\n/g, " ");
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { format: "mermaid" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      opts.format = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

if (require.main === module) {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (positional.length !== 1) {
    process.stderr.write(
      "usage: render-flow-diagram.js <flow-graph-path> [--format mermaid|ascii]\n"
    );
    process.exit(2);
  }
  const graphPath = path.resolve(positional[0]);
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  } catch (err) {
    process.stderr.write(`error: could not read ${graphPath}: ${err.message}\n`);
    process.exit(1);
  }
  try {
    const out = renderFlowDiagram(graph, { format: opts.format });
    process.stdout.write(out + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { renderFlowDiagram };
