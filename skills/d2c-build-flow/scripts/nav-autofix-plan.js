#!/usr/bin/env node

/**
 * nav-autofix-plan.js — Propose a fix when `flow-navigation.spec.ts` fails
 * (B-FLOW-NAV-AUTOFIX). This script does NOT patch code; it diagnoses the
 * failure and emits a machine-readable plan that the skill's Phase 4b auto-fix
 * loop executes.
 *
 * Usage:
 *   node nav-autofix-plan.js <flow-graph.json> <failure-report.json> [--max-rounds N]
 *
 *   failure-report.json shape (produced by the nav-test runner):
 *     {
 *       "round": 0,
 *       "failures": [
 *         { "from_node_id": "…", "to_node_id": "…", "level": "url" | "click",
 *           "error": "…" }
 *       ]
 *     }
 *
 * Exit codes:
 *   0   — plan emitted (check stdout)
 *   1   — read error
 *   2   — CLI misuse
 *   3   — budget exhausted (no plan; caller should escalate to F-FLOW-NAV-ASSERT-FAIL inform)
 *
 * Stdout is a JSON object:
 *   {
 *     "action": "relax-link-target" | "wire-next-best" | "rerun" | "escalate",
 *     "edge": { from_node_id, to_node_id, level },
 *     "candidates": [ { "source_component_node_id": "…", "reason": "…" }, … ],
 *     "max_rounds_remaining": N
 *   }
 *
 * Strategy per failure level:
 *   - "url":  auto-fix can't help (page-mount failure). Plan is "rerun"
 *             so the caller captures the stack trace and escalates.
 *   - "click": try in order:
 *       (a) relax-link-target  — re-run pick-link-target.js on the page's
 *           component-match with a wider regex (allow primary buttons whose
 *           text didn't match the default Next/Continue/… list).
 *       (b) wire-next-best     — take the second-ranked candidate from the
 *           page's component-match that still has `link_target`-eligible
 *           traits, suggest wiring it to the failed edge.
 *       (c) escalate           — nothing left; surface F-FLOW-NAV-ASSERT-FAIL.
 *
 * The script is pure: it reads the inputs, reasons about them, and writes a
 * plan. The caller (SKILL.md Phase 4b) performs the IO and re-runs Playwright.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const RELAXED_NEXT_REGEX = /next|continue|proceed|get started|sign up|submit|finish|ok|confirm|accept|yes|go|done|let's go|start/i;
const STRICT_NEXT_REGEX = /next|continue|proceed|get started|sign up|submit|finish/i;

function planNavAutofix({ graph, report, maxRounds = 2 }) {
  if (!graph || !Array.isArray(graph.pages) || !Array.isArray(graph.edges)) {
    throw new Error("flow-graph must include arrays `pages` and `edges`");
  }
  if (!report || !Array.isArray(report.failures)) {
    throw new Error("failure-report must include a `failures` array");
  }
  const round = Number.isInteger(report.round) ? report.round : 0;
  const remaining = maxRounds - round;
  if (remaining <= 0) {
    return { action: "escalate", reason: "max-rounds-exhausted", max_rounds_remaining: 0 };
  }

  const firstFailure = report.failures[0];
  if (!firstFailure) {
    return { action: "escalate", reason: "no-failures-reported", max_rounds_remaining: remaining };
  }

  if (firstFailure.level === "url") {
    // Mount-level failures are not link-wiring issues; stop here and let the
    // caller surface the stack trace.
    return {
      action: "escalate",
      reason: "url-level-failure-not-fixable-by-wiring",
      edge: {
        from_node_id: firstFailure.from_node_id,
        to_node_id: firstFailure.to_node_id,
        level: firstFailure.level,
      },
      max_rounds_remaining: remaining,
    };
  }

  const edge = graph.edges.find(
    (e) =>
      e.from_node_id === firstFailure.from_node_id &&
      e.to_node_id === firstFailure.to_node_id
  );
  if (!edge) {
    return {
      action: "escalate",
      reason: "failing-edge-not-found-in-flow-graph",
      max_rounds_remaining: remaining,
    };
  }

  // Round 1 (round === 0 in): relax the pick-link-target regex.
  if (round === 0) {
    return {
      action: "relax-link-target",
      edge: {
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        level: "click",
      },
      proposed_regex_source: RELAXED_NEXT_REGEX.source,
      strict_regex_source: STRICT_NEXT_REGEX.source,
      instructions:
        "Re-run skills/d2c-build-flow/scripts/pick-link-target.js on the source page's component-match.json with the relaxed regex. If a new candidate wins, update edges[i].source_component_node_id and re-emit the handler. Re-run the nav test.",
      max_rounds_remaining: remaining - 1,
    };
  }

  // Round 2: pick the next-best candidate from component-match.
  return {
    action: "wire-next-best",
    edge: {
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      level: "click",
    },
    instructions:
      "Read the source page's component-match.json. For each node where `score` ranks it ≥ 2nd among primary-button candidates, propose wiring it to the failing edge. Update edges[i].source_component_node_id, re-emit the handler, re-run the nav test. If still failing after this round, escalate to F-FLOW-NAV-ASSERT-FAIL.",
    max_rounds_remaining: remaining - 1,
  };
}

function runCli(argv) {
  const positional = [];
  let maxRounds = 2;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-rounds") {
      maxRounds = parseInt(argv[++i], 10);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) {
    process.stderr.write(
      "usage: nav-autofix-plan.js <flow-graph.json> <failure-report.json> [--max-rounds N]\n"
    );
    process.exit(2);
  }
  let graph, report;
  try {
    graph = JSON.parse(fs.readFileSync(path.resolve(positional[0]), "utf8"));
  } catch (err) {
    process.stderr.write(`error reading flow-graph: ${err.message}\n`);
    process.exit(1);
  }
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(positional[1]), "utf8"));
  } catch (err) {
    process.stderr.write(`error reading failure-report: ${err.message}\n`);
    process.exit(1);
  }
  let plan;
  try {
    plan = planNavAutofix({ graph, report, maxRounds });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exit(plan.action === "escalate" ? 3 : 0);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = { planNavAutofix, RELAXED_NEXT_REGEX, STRICT_NEXT_REGEX };
