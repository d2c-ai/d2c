#!/usr/bin/env node

/**
 * detect-shared-shell.js — Identify a shared layout shell across flow pages.
 *
 * Consumed by d2c-build-flow Phase 2a after per-page design contexts have
 * been fetched. A "shared shell" is a top-level component instance that
 * appears on a sufficient fraction of pages (threshold, default 75%) to be
 * worth hoisting into a Next.js App Router layout.
 *
 * Input:
 *   {
 *     pages: [
 *       {
 *         node_id: "1:2",
 *         top_level_children: [
 *           {
 *             component_id: "abc:123",
 *             name: "OnboardingShell",
 *             node_id: "9:10",                 // optional — instance node id on this page
 *             descendants: [                   // optional — nested instances for stepper-indicator detection
 *               {
 *                 component_id: "abc:124",
 *                 name: "StepIndicator",
 *                 node_id: "9:11",
 *                 variant: "step=1"
 *               },
 *               ...
 *             ]
 *           },
 *           ...
 *         ]
 *       },
 *       ...
 *     ],
 *     threshold: 0.75   // optional, default 0.75
 *   }
 *
 * Output:
 *   {
 *     layouts: [
 *       {
 *         name: "OnboardingShell",          // PascalCase, derived from component name
 *         component_id: "abc:123",
 *         applies_to: ["1:2", "3:4", ...],
 *         shell_node_ids_per_page: {        // instance node ids of the shell on each page
 *           "1:2": "9:10",
 *           "3:4": "9:20"
 *         },
 *         stepper_indicator: null | {
 *           component_id: "abc:124",
 *           name: "StepIndicator",
 *           node_ids_per_page: { "1:2": "9:11", "3:4": "9:21" },
 *           variants_per_page: { "1:2": "step=1", "3:4": "step=2" },
 *           ordered: true                   // true when the variant values across pages form an increasing sequence
 *         }
 *       }
 *     ],
 *     divergent: false                      // true when no component meets threshold
 *   }
 *
 * Contract:
 *   - When every page contains the same component, emit a single layout with
 *     applies_to listing every page.
 *   - When a component appears on >= threshold fraction of pages (but not
 *     all), emit a single layout with applies_to listing only matching pages.
 *     The caller decides whether to fire F-FLOW-SHELL-DIVERGENT on top of
 *     this (the partial case is a partial match, not a miss).
 *   - When no component appears on >= threshold fraction of pages, return
 *     layouts: [] and divergent: true. Caller fires F-FLOW-SHELL-DIVERGENT.
 *   - Ties (two components each at >= threshold) are broken by first-appearance
 *     order so the result is deterministic.
 *
 * Usage (CLI):
 *   node detect-shared-shell.js <pages.json> [threshold]
 *
 * Stdout (machine-readable):
 *   detect-shared-shell: ok
 *   layouts: <N>
 *   divergent: true | false
 *
 * Exit codes: 0 ok, 2 CLI misuse.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_THRESHOLD = 0.75;

function detectSharedShell({ pages, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError("pages must be a non-empty array");
  }
  if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
    throw new RangeError("threshold must be a number in (0, 1]");
  }

  const total = pages.length;
  const minMatches = Math.ceil(threshold * total);

  // { component_id: { name, pages: Set<node_id>, firstSeen: index, nodeByPage: Map<page_node_id, child_node_id> } }
  const byComponent = new Map();

  pages.forEach((page, idx) => {
    if (!page || !Array.isArray(page.top_level_children)) return;
    const seenOnPage = new Set();
    for (const child of page.top_level_children) {
      if (!child || typeof child.component_id !== "string") continue;
      // Count each component once per page (a page with the component twice
      // doesn't count twice).
      if (seenOnPage.has(child.component_id)) continue;
      seenOnPage.add(child.component_id);

      if (!byComponent.has(child.component_id)) {
        byComponent.set(child.component_id, {
          name: child.name || child.component_id,
          pages: new Set(),
          firstSeen: idx,
          nodeByPage: new Map(),
          childByPage: new Map(),
        });
      }
      const entry = byComponent.get(child.component_id);
      entry.pages.add(page.node_id);
      if (child.node_id) entry.nodeByPage.set(page.node_id, child.node_id);
      entry.childByPage.set(page.node_id, child);
    }
  });

  let best = null;
  for (const [componentId, info] of byComponent.entries()) {
    if (info.pages.size < minMatches) continue;
    if (
      !best ||
      info.pages.size > best.info.pages.size ||
      (info.pages.size === best.info.pages.size &&
        info.firstSeen < best.info.firstSeen)
    ) {
      best = { componentId, info };
    }
  }

  if (!best) {
    return { layouts: [], divergent: true };
  }

  const appliesTo = pages
    .map((p) => p.node_id)
    .filter((nodeId) => best.info.pages.has(nodeId));

  const shell_node_ids_per_page = {};
  for (const pageNodeId of appliesTo) {
    if (best.info.nodeByPage.has(pageNodeId)) {
      shell_node_ids_per_page[pageNodeId] = best.info.nodeByPage.get(pageNodeId);
    }
  }

  const stepper_indicator = detectStepperIndicator(pages, best, appliesTo);

  return {
    layouts: [
      {
        name: toPascalCase(best.info.name),
        component_id: best.componentId,
        applies_to: appliesTo,
        shell_node_ids_per_page,
        stepper_indicator,
      },
    ],
    divergent: false,
  };
}

/**
 * Within the shared shell found above, look for a repeated sub-instance whose
 * variant differs per page in an ordered way — the hallmark of a stepper
 * progress indicator ("step=1" → "step=2" → …). Returns a descriptor or null.
 *
 * Two sources of variant info are accepted on each descendant entry:
 *   - `variant` — a string like "step=1" or "state=2/4"
 *   - `properties` — an object whose values may include step/index/active keys
 *
 * We look for a component_id that appears inside the shell on every page where
 * the shell itself appears, with distinct variant values across pages. When
 * those values parse as integers (or form an a/b/c sequence) and the ordered
 * set matches the page order, we mark it `ordered: true`.
 */
function detectStepperIndicator(pages, best, appliesTo) {
  // component_id → { name, perPage: Map<page_node_id, {node_id, variant}> }
  const descendantByComponent = new Map();

  for (const pageNodeId of appliesTo) {
    const child = best.info.childByPage.get(pageNodeId);
    if (!child || !Array.isArray(child.descendants)) continue;
    const seen = new Set();
    for (const d of child.descendants) {
      if (!d || typeof d.component_id !== "string") continue;
      if (seen.has(d.component_id)) continue;
      seen.add(d.component_id);
      if (!descendantByComponent.has(d.component_id)) {
        descendantByComponent.set(d.component_id, {
          name: d.name || d.component_id,
          perPage: new Map(),
        });
      }
      descendantByComponent.get(d.component_id).perPage.set(pageNodeId, {
        node_id: d.node_id || null,
        variant: extractVariantSignal(d),
      });
    }
  }

  // Pick the descendant whose variant signal is distinct per page and ordered
  // in page order. If multiple candidates, prefer the one whose name looks
  // stepper-like (contains "step" or "progress") then first-appearance.
  let indicator = null;
  for (const [componentId, entry] of descendantByComponent.entries()) {
    if (entry.perPage.size !== appliesTo.length) continue; // must appear on every page the shell does
    const variants = appliesTo.map((p) => entry.perPage.get(p).variant);
    if (variants.some((v) => v === null || v === undefined)) continue;
    const distinctCount = new Set(variants).size;
    if (distinctCount < 2) continue;
    const ordered = isOrderedSequence(variants);
    const nameHint = /step|progress|indicator|wizard/i.test(entry.name);
    const score = (ordered ? 2 : 0) + (nameHint ? 1 : 0) + (distinctCount === appliesTo.length ? 1 : 0);
    if (!indicator || score > indicator.score) {
      indicator = {
        componentId,
        entry,
        score,
        ordered,
        variants,
      };
    }
  }

  if (!indicator) return null;

  const node_ids_per_page = {};
  const variants_per_page = {};
  for (const pageNodeId of appliesTo) {
    const v = indicator.entry.perPage.get(pageNodeId);
    if (v && v.node_id) node_ids_per_page[pageNodeId] = v.node_id;
    if (v) variants_per_page[pageNodeId] = v.variant;
  }

  return {
    component_id: indicator.componentId,
    name: indicator.entry.name,
    node_ids_per_page,
    variants_per_page,
    ordered: indicator.ordered,
  };
}

function extractVariantSignal(descendant) {
  if (typeof descendant.variant === "string" && descendant.variant.length > 0) {
    return descendant.variant;
  }
  const props = descendant.properties;
  if (props && typeof props === "object") {
    // Prefer step/index/current/active/state keys in that priority order.
    const keys = ["step", "index", "current", "active", "state"];
    for (const key of keys) {
      if (props[key] !== undefined && props[key] !== null) {
        return `${key}=${props[key]}`;
      }
    }
    // Fall back to a stable JSON of whatever was provided.
    try {
      return JSON.stringify(props);
    } catch (_e) {
      return null;
    }
  }
  return null;
}

function isOrderedSequence(variants) {
  // Extract trailing integer or letter from each value. If every one extracts
  // and the sequence is strictly increasing by 1, mark ordered.
  const nums = variants.map((v) => {
    const m = /(\d+)\s*$/.exec(String(v));
    return m ? parseInt(m[1], 10) : null;
  });
  if (nums.every((n) => n !== null)) {
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) return false;
    }
    return true;
  }
  const letters = variants.map((v) => {
    const m = /([A-Za-z])\s*$/.exec(String(v));
    return m ? m[1].toLowerCase().charCodeAt(0) : null;
  });
  if (letters.every((c) => c !== null)) {
    for (let i = 1; i < letters.length; i++) {
      if (letters[i] !== letters[i - 1] + 1) return false;
    }
    return true;
  }
  return false;
}

function toPascalCase(raw) {
  if (!raw) return "Shell";
  return String(raw)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Shell";
}

function runCli(argv) {
  if (argv.length < 1 || argv.length > 2) {
    process.stderr.write(
      "usage: detect-shared-shell.js <pages.json> [threshold]\n"
    );
    process.exit(2);
  }
  const [pagesPath, thresholdStr] = argv;
  const pages = JSON.parse(fs.readFileSync(path.resolve(pagesPath), "utf8"));
  const threshold = thresholdStr !== undefined ? Number(thresholdStr) : DEFAULT_THRESHOLD;

  const result = detectSharedShell({ pages, threshold });
  process.stdout.write("detect-shared-shell: ok\n");
  process.stdout.write(`layouts: ${result.layouts.length}\n`);
  process.stdout.write(`divergent: ${result.divergent}\n`);
  process.exit(0);
}

module.exports = { detectSharedShell, toPascalCase };

if (require.main === module) {
  runCli(process.argv.slice(2));
}
