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
 *           { component_id: "abc:123", name: "OnboardingShell" },
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
 *         applies_to: ["1:2", "3:4", ...]
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

  // { component_id: { name, pages: Set<node_id>, firstSeen: index } }
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
        });
      }
      byComponent.get(child.component_id).pages.add(page.node_id);
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

  return {
    layouts: [
      {
        name: toPascalCase(best.info.name),
        component_id: best.componentId,
        applies_to: appliesTo,
      },
    ],
    divergent: false,
  };
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
