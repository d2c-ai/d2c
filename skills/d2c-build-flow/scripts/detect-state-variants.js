#!/usr/bin/env node

/**
 * detect-state-variants.js — Fallback detector for state-variant sibling frames
 * in a Figma file.
 *
 * P1.5 of the d2c-build-flow state-variants work. When Phase 1b prompt
 * extraction yields a loaded URL but no URL for one or more of
 * loading/empty/error, the skill can call this detector on the loaded frame's
 * parent's children to surface siblings whose names match the canonical
 * state-keyword vocabulary ("Dashboard — Loaded" / "Dashboard — Skeleton" etc.).
 *
 * Contract:
 *   - Consumes the children of the primary frame's parent, each entry carrying
 *     at minimum { node_id, name } and optionally { file_key }.
 *   - Excludes the primary node itself from matching — the primary is always
 *     the `loaded` frame and the caller already has it.
 *   - Cross-file siblings (children whose file_key differs from the primary's)
 *     are rejected — BFS-over-one-parent always shares the primary's file key,
 *     so a mismatch is a red flag.
 *   - Vocabulary mirrors Phase 1b in SKILL.md:
 *       loading: loading | skeleton | fetching | pending | placeholder
 *                | shimmer | spinner
 *       empty:   empty | no data | zero state | null state | blank state
 *                | nothing to show
 *       error:   error | failed | failure | broken | crashed | fallback
 *                | something went wrong
 *       initial: initial | idle | pre fetch | pristine | untouched
 *                | not started
 *     `loaded` keywords are NOT matched — the primary is already the loaded
 *     frame, so matching would double-count it or mis-classify siblings.
 *   - Whole-word matches outrank substring matches (so "Skeleton" matches the
 *     `loading` slot via the "skeleton" keyword, but "PendingTasksCard" does
 *     NOT match via the "pending" substring). When no whole-word match exists,
 *     a longest-substring fallback applies so minor typos and concatenations
 *     (e.g. "emptyState") still resolve.
 *   - If two siblings claim the same slot, take the first by input order and
 *     surface the remaining collision candidates under `unmatched_siblings`
 *     with `collision: true` so the clarification phase can ask the user.
 *
 * Input:
 *   {
 *     primary_node_id:  "1:2",
 *     primary_figma_url: "https://www.figma.com/design/<key>/File?node-id=1-2",
 *     parent_context: {
 *       children: [
 *         { node_id: "1:2", name: "Dashboard — Loaded" },
 *         { node_id: "1:3", name: "Dashboard — Skeleton" },
 *         { node_id: "1:4", name: "Dashboard — Empty State" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Output:
 *   {
 *     found: {
 *       loading?: { node_id, figma_url, name },
 *       empty?:   { node_id, figma_url, name },
 *       error?:   { node_id, figma_url, name },
 *       initial?: { node_id, figma_url, name }
 *     },
 *     unmatched_siblings: [
 *       { node_id, name, collision?: true,
 *         slot?: "loading" | "empty" | "error" | "initial" }
 *     ]
 *   }
 *
 * Usage (CLI):
 *   node detect-state-variants.js <input.json>
 *
 * Exit codes:
 *   0 — parsed, JSON result on stdout
 *   1 — detection error (bad input)
 *   2 — CLI misuse
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Keyword vocabulary mirrors Phase 1b. Kept as a list of
// { slot, phrase, words } so we can rank by phrase length and check both
// whole-word and substring forms.
const VOCABULARY = [
  { slot: "loading", phrase: "loading" },
  { slot: "loading", phrase: "skeleton" },
  { slot: "loading", phrase: "fetching" },
  { slot: "loading", phrase: "pending" },
  { slot: "loading", phrase: "placeholder" },
  { slot: "loading", phrase: "shimmer" },
  { slot: "loading", phrase: "spinner" },
  { slot: "empty", phrase: "empty" },
  { slot: "empty", phrase: "no data" },
  { slot: "empty", phrase: "zero state" },
  { slot: "empty", phrase: "null state" },
  { slot: "empty", phrase: "blank state" },
  { slot: "empty", phrase: "nothing to show" },
  { slot: "error", phrase: "error" },
  { slot: "error", phrase: "failed" },
  { slot: "error", phrase: "failure" },
  { slot: "error", phrase: "broken" },
  { slot: "error", phrase: "crashed" },
  { slot: "error", phrase: "fallback" },
  { slot: "error", phrase: "something went wrong" },
  { slot: "initial", phrase: "initial" },
  { slot: "initial", phrase: "idle" },
  { slot: "initial", phrase: "pre fetch" },
  { slot: "initial", phrase: "pristine" },
  { slot: "initial", phrase: "untouched" },
  { slot: "initial", phrase: "not started" },
];

// Sort once, phrase length desc. Longer phrases match first so "zero state"
// wins over "state" alone when both would otherwise match.
const VOCAB_BY_LENGTH = [...VOCABULARY].sort(
  (a, b) => b.phrase.length - a.phrase.length
);

function normalise(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wholeWordMatch(haystack, phrase) {
  // Both are already normalised: lowercase, single-spaced, alphanumeric-only.
  const parts = haystack.split(" ");
  const phraseWords = phrase.split(" ");
  if (phraseWords.length === 1) {
    return parts.includes(phraseWords[0]);
  }
  // Multi-word phrase: scan for a contiguous run.
  for (let i = 0; i <= parts.length - phraseWords.length; i++) {
    let match = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (parts[i + j] !== phraseWords[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function substringMatch(haystack, phrase) {
  // Space-collapsed substring; handles concatenations like "emptyState" →
  // normalised to "empty state" which the whole-word path would already have
  // caught. The substring path catches the case where punctuation collapsed
  // the phrase into its neighbour, e.g. a name like "DashboardSkeletonView"
  // normalises to "dashboardskeletonview" … actually no, the normaliser splits
  // on non-alphanumeric only, so DashboardSkeleton stays "dashboardskeleton" as
  // one token. The substring path is what catches it.
  return haystack.replace(/\s+/g, "").includes(phrase.replace(/\s+/g, ""));
}

function classifyName(name) {
  const norm = normalise(name);
  if (!norm) return null;

  // Whole-word pass first.
  for (const entry of VOCAB_BY_LENGTH) {
    if (wholeWordMatch(norm, entry.phrase)) {
      return { slot: entry.slot, phrase: entry.phrase, mode: "whole" };
    }
  }
  // Substring fallback pass — same ordering (longest first).
  for (const entry of VOCAB_BY_LENGTH) {
    if (substringMatch(norm, entry.phrase)) {
      return { slot: entry.slot, phrase: entry.phrase, mode: "substring" };
    }
  }
  return null;
}

function replaceNodeId(url, newNodeId) {
  const nodeIdUrlForm = String(newNodeId).replace(":", "-");
  // Preserve existing query params and fragments; only swap the node-id value.
  return url.replace(/([?&]node-id=)[^&#]+/, `$1${nodeIdUrlForm}`);
}

function extractFileKey(url) {
  const m = String(url || "").match(
    /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/
  );
  return m ? m[1] : null;
}

function detectStateVariants(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }
  const { primary_node_id, primary_figma_url, parent_context } = input;
  if (typeof primary_node_id !== "string" || primary_node_id.length === 0) {
    throw new TypeError("primary_node_id must be a non-empty string");
  }
  if (typeof primary_figma_url !== "string" || primary_figma_url.length === 0) {
    throw new TypeError("primary_figma_url must be a non-empty string");
  }
  if (
    !parent_context ||
    typeof parent_context !== "object" ||
    !Array.isArray(parent_context.children)
  ) {
    throw new TypeError("parent_context.children must be an array");
  }

  const primaryFileKey = extractFileKey(primary_figma_url);
  if (!primaryFileKey) {
    throw new TypeError(
      `primary_figma_url — could not extract Figma file key from "${primary_figma_url}"`
    );
  }

  const found = {};
  const unmatched = [];

  for (const child of parent_context.children) {
    if (!child || typeof child !== "object") continue;
    if (typeof child.node_id !== "string" || child.node_id.length === 0) continue;

    // Skip the primary itself — it's the `loaded` frame by contract.
    if (child.node_id === primary_node_id) continue;

    // Cross-file rejection. When the sibling carries its own file_key and it
    // differs from the primary's, drop it silently. Siblings without a
    // file_key are assumed to share the primary's (BFS-over-one-parent case).
    if (
      typeof child.file_key === "string" &&
      child.file_key.length > 0 &&
      child.file_key !== primaryFileKey
    ) {
      continue;
    }

    const match = classifyName(child.name);
    if (!match) {
      unmatched.push({ node_id: child.node_id, name: child.name || "" });
      continue;
    }

    // `loaded` is filtered by vocabulary (loaded keywords are not in
    // VOCABULARY), so match.slot is always one of loading/empty/error.
    if (found[match.slot]) {
      // Collision — a sibling already filled this slot. Surface under
      // unmatched so the clarification phase can ask the user.
      unmatched.push({
        node_id: child.node_id,
        name: child.name || "",
        collision: true,
        slot: match.slot,
      });
      continue;
    }

    found[match.slot] = {
      node_id: child.node_id,
      figma_url: replaceNodeId(primary_figma_url, child.node_id),
      name: child.name || "",
    };
  }

  return { found, unmatched_siblings: unmatched };
}

// ---------- CLI ----------

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error("usage: detect-state-variants.js <input.json>");
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  } catch (e) {
    console.error(`error: could not read/parse input: ${e.message}`);
    process.exit(1);
  }
  let result;
  try {
    result = detectStateVariants(raw);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  detectStateVariants,
  classifyName,
  normalise,
  replaceNodeId,
  extractFileKey,
};
