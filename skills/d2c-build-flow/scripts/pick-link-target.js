#!/usr/bin/env node

/**
 * pick-link-target.js — Identify the interactive node on a page that should
 * carry the outgoing flow edge (the "Next" button).
 *
 * Consumed by d2c-build-flow Phase 2. Given a page's component-match.json and
 * the next page's node_id, returns the node_id of the best-ranked interactive
 * component to wire as the link_target, or null when nothing is wireable.
 *
 * Heuristic (in order of preference):
 *   1. TEXT MATCH — node.figma_name matches /next|continue|proceed|get started|
 *                   sign up|submit|finish/i. First match in insertion order wins.
 *   2. PRIMARY BUTTON — node.figma_name looks like a primary button (contains
 *                       "button" and either "primary" or its candidate source
 *                       path suggests a primary-button component).
 *   3. No match → null.
 *
 * Trigger selection defaults to "onClick". Pass an optional layout.json to
 * enable "onSubmit" when the chosen node sits inside a region explicitly
 * flagged as a form. Today the layout schema has no form flag, so the hook is
 * inert — it exists so a future schema extension switches this on without a
 * script rewrite.
 *
 * Usage (CLI):
 *   node pick-link-target.js <component-match.json> <to_node_id> [layout.json]
 *
 * Stdout (one line per key, machine-readable):
 *   pick-link-target: ok | none
 *   node_id: <id>       (only when ok)
 *   trigger: <t>        (only when ok)
 *   reason: <reason>    (only when ok)
 *
 * Exit codes:
 *   0 — always (no match is not an error)
 *   2 — CLI misuse
 */

"use strict";

const fs = require("fs");
const path = require("path");

const TEXT_RE = /\b(next|continue|proceed|get\s*started|sign\s*up|submit|finish)\b/i;
const PRIMARY_RE = /\bprimary\b/i;
const BUTTON_RE = /\bbutton\b/i;

function pickLinkTarget({ componentMatch, toNodeId, layout = null } = {}) {
  if (!componentMatch || typeof componentMatch !== "object") {
    throw new TypeError("componentMatch must be an object");
  }
  if (typeof toNodeId !== "string" || toNodeId.length === 0) {
    throw new TypeError("toNodeId must be a non-empty string");
  }

  const entries = Object.entries(componentMatch.nodes || {});

  // Pass 1: exact text match on figma_name.
  for (const [nodeId, node] of entries) {
    const name = (node && node.figma_name) || "";
    if (TEXT_RE.test(name)) {
      return {
        nodeId,
        trigger: inferTrigger(nodeId, layout),
        reason: "text-match",
      };
    }
  }

  // Pass 2: primary button fallback. Match when both of:
  //   - name mentions a button
  //   - name mentions "primary" OR the top candidate's source path suggests one
  for (const [nodeId, node] of entries) {
    const name = (node && node.figma_name) || "";
    if (!BUTTON_RE.test(name)) continue;

    const firstCandidateSource =
      node && node.candidates && node.candidates[0] && node.candidates[0].source;
    const sourceHint = firstCandidateSource ? String(firstCandidateSource) : "";

    if (PRIMARY_RE.test(name) || /primary/i.test(sourceHint)) {
      return {
        nodeId,
        trigger: inferTrigger(nodeId, layout),
        reason: "primary-button",
      };
    }
  }

  return null;
}

function inferTrigger(nodeId, layout) {
  if (!layout || typeof layout !== "object") return "onClick";
  const regions = layout.regions || {};
  for (const [, region] of Object.entries(regions)) {
    if (!region || typeof region !== "object") continue;
    const isForm =
      region.kind === "form" || region.type === "form" || region.form === true;
    if (!isForm) continue;
    const children = Array.isArray(region.children) ? region.children : [];
    if (children.includes(nodeId)) return "onSubmit";
  }
  return "onClick";
}

function runCli(argv) {
  if (argv.length < 2 || argv.length > 3) {
    process.stderr.write(
      "usage: pick-link-target.js <component-match.json> <to_node_id> [layout.json]\n"
    );
    process.exit(2);
  }
  const [componentMatchPath, toNodeId, layoutPath] = argv;

  const componentMatch = JSON.parse(
    fs.readFileSync(path.resolve(componentMatchPath), "utf8")
  );
  const layout = layoutPath
    ? JSON.parse(fs.readFileSync(path.resolve(layoutPath), "utf8"))
    : null;

  const result = pickLinkTarget({ componentMatch, toNodeId, layout });
  if (!result) {
    process.stdout.write("pick-link-target: none\n");
    process.exit(0);
  }
  process.stdout.write("pick-link-target: ok\n");
  process.stdout.write(`node_id: ${result.nodeId}\n`);
  process.stdout.write(`trigger: ${result.trigger}\n`);
  process.stdout.write(`reason: ${result.reason}\n`);
  process.exit(0);
}

module.exports = { pickLinkTarget };

if (require.main === module) {
  runCli(process.argv.slice(2));
}
