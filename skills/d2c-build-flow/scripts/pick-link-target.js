#!/usr/bin/env node

/**
 * pick-link-target.js — Identify the interactive node on a page that should
 * carry the outgoing flow edge (the "Next" button) and describe the edge kind.
 *
 * Consumed by d2c-build-flow Phase 2. Given a page's component-match.json and
 * a target descriptor (either a sibling page's node_id for route navigation
 * or a stepper step_delta for in-place step advancement), returns the node_id
 * of the best-ranked interactive component to wire as the link_target, along
 * with the edge kind ("route" | "step_delta"), or null when nothing is
 * wireable.
 *
 * Heuristic (in order of preference):
 *   1. TEXT MATCH — node.figma_name matches /next|continue|proceed|get started|
 *                   sign up|submit|finish/i. First match in insertion order wins.
 *      For stepper Back buttons (step_delta < 0), match /back|previous|prev/i.
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
 * Programmatic (preferred) API:
 *   pickLinkTarget({
 *     componentMatch,
 *     toNodeId?: string,            // route-mode target
 *     stepDelta?: number,           // stepper-mode target (+1 = Next, -1 = Back)
 *     layout?: object,
 *   })
 *   → {
 *       nodeId: string,
 *       trigger: "onClick" | "onSubmit",
 *       reason: "text-match" | "primary-button",
 *       edge_kind: "route" | "step_delta",
 *       step_delta?: number,
 *       to_node_id?: string,
 *     } | null
 *
 * Usage (CLI):
 *   node pick-link-target.js <component-match.json> <to_node_id_or_delta> [layout.json]
 *   to_node_id_or_delta: a node id (e.g. "3:4") OR a signed integer prefixed
 *                        with "step:" (e.g. "step:+1", "step:-1"). When no
 *                        prefix is present, it's treated as a node id.
 *
 * Stdout (one line per key, machine-readable):
 *   pick-link-target: ok | none
 *   node_id: <id>         (only when ok)
 *   trigger: <t>          (only when ok)
 *   reason: <reason>      (only when ok)
 *   edge_kind: route | step_delta  (only when ok)
 *   step_delta: <n>       (only when edge_kind=step_delta)
 *
 * Exit codes:
 *   0 — always (no match is not an error)
 *   2 — CLI misuse
 */

"use strict";

const fs = require("fs");
const path = require("path");

const TEXT_NEXT_RE = /\b(next|continue|proceed|get\s*started|sign\s*up|submit|finish)\b/i;
const TEXT_BACK_RE = /\b(back|previous|prev|return)\b/i;
const PRIMARY_RE = /\bprimary\b/i;
const BUTTON_RE = /\bbutton\b/i;

function pickLinkTarget({
  componentMatch,
  toNodeId = null,
  stepDelta = null,
  layout = null,
} = {}) {
  if (!componentMatch || typeof componentMatch !== "object") {
    throw new TypeError("componentMatch must be an object");
  }
  // Exactly one of toNodeId | stepDelta must be supplied.
  const hasTo = typeof toNodeId === "string" && toNodeId.length > 0;
  const hasDelta = typeof stepDelta === "number" && Number.isFinite(stepDelta);
  if (hasTo === hasDelta) {
    throw new TypeError(
      "pickLinkTarget requires exactly one of { toNodeId, stepDelta }"
    );
  }

  const entries = Object.entries(componentMatch.nodes || {});

  // Back buttons only make sense for step_delta < 0. For route edges and for
  // Next/+1 step edges we look for forward text. This lets us pick the right
  // component when a stepper has both Back and Next visible.
  const primaryTextRe =
    hasDelta && stepDelta < 0 ? TEXT_BACK_RE : TEXT_NEXT_RE;

  // Pass 1: exact text match on figma_name.
  for (const [nodeId, node] of entries) {
    const name = (node && node.figma_name) || "";
    if (primaryTextRe.test(name)) {
      return buildResult({
        nodeId,
        trigger: inferTrigger(nodeId, layout),
        reason: "text-match",
        toNodeId,
        stepDelta,
      });
    }
  }

  // Pass 2: primary button fallback. Match when both of:
  //   - name mentions a button
  //   - name mentions "primary" OR the top candidate's source path suggests one
  // Only runs for forward edges — we don't want a primary button to pose as
  // a Back button.
  if (!hasDelta || stepDelta > 0) {
    for (const [nodeId, node] of entries) {
      const name = (node && node.figma_name) || "";
      if (!BUTTON_RE.test(name)) continue;

      const firstCandidateSource =
        node && node.candidates && node.candidates[0] && node.candidates[0].source;
      const sourceHint = firstCandidateSource ? String(firstCandidateSource) : "";

      if (PRIMARY_RE.test(name) || /primary/i.test(sourceHint)) {
        return buildResult({
          nodeId,
          trigger: inferTrigger(nodeId, layout),
          reason: "primary-button",
          toNodeId,
          stepDelta,
        });
      }
    }
  }

  return null;
}

function buildResult({ nodeId, trigger, reason, toNodeId, stepDelta }) {
  if (typeof stepDelta === "number") {
    return {
      nodeId,
      trigger,
      reason,
      edge_kind: "step_delta",
      step_delta: stepDelta,
    };
  }
  return {
    nodeId,
    trigger,
    reason,
    edge_kind: "route",
    to_node_id: toNodeId,
  };
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
      "usage: pick-link-target.js <component-match.json> <to_node_id_or_step_delta> [layout.json]\n" +
        "  to_node_id_or_step_delta: Figma node id (e.g. '3:4') OR 'step:+1'/'step:-1' for stepper edges.\n"
    );
    process.exit(2);
  }
  const [componentMatchPath, rawTarget, layoutPath] = argv;

  const componentMatch = JSON.parse(
    fs.readFileSync(path.resolve(componentMatchPath), "utf8")
  );
  const layout = layoutPath
    ? JSON.parse(fs.readFileSync(path.resolve(layoutPath), "utf8"))
    : null;

  const stepMatch = /^step:([+-]?\d+)$/i.exec(rawTarget);
  const args = stepMatch
    ? { componentMatch, stepDelta: parseInt(stepMatch[1], 10), layout }
    : { componentMatch, toNodeId: rawTarget, layout };

  const result = pickLinkTarget(args);
  if (!result) {
    process.stdout.write("pick-link-target: none\n");
    process.exit(0);
  }
  process.stdout.write("pick-link-target: ok\n");
  process.stdout.write(`node_id: ${result.nodeId}\n`);
  process.stdout.write(`trigger: ${result.trigger}\n`);
  process.stdout.write(`reason: ${result.reason}\n`);
  process.stdout.write(`edge_kind: ${result.edge_kind}\n`);
  if (result.edge_kind === "step_delta") {
    process.stdout.write(`step_delta: ${result.step_delta}\n`);
  }
  process.exit(0);
}

module.exports = { pickLinkTarget };

if (require.main === module) {
  runCli(process.argv.slice(2));
}
