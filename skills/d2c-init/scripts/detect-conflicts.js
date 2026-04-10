#!/usr/bin/env node

/**
 * detect-conflicts.js — Token conflict detector for d2c-init Step 2b
 *
 * Usage:
 *   node detect-conflicts.js <design-tokens.json path>
 *
 * Scans design-tokens.json for within-category value collisions:
 * two or more tokens whose normalized value is identical within the
 * same category.  Outputs machine-readable conflict groups to stdout.
 *
 * Zero external dependencies (follows validate-ir.js / pixeldiff.js
 * pattern).
 *
 * Exit codes:
 *   0 — ok (no conflicts) or found (conflicts detected)
 *   1 — error (file not found, parse error, etc.)
 *   2 — CLI misuse (wrong args)
 *
 * Stdout format (one line per key, machine-readable):
 *
 *   detect-conflicts: ok | found | error
 *   categories: <N>
 *   tokens: <N>
 *   conflicts: <N>
 *   conflict: <category>:<normalized_value> — <path1>, <path2>, ...
 *   warning: <category> — >50% of tokens share a single value
 *   error: <message>
 */

const fs = require("fs");
const path = require("path");

// Token categories — matches validate-ir.js and d2c-init token schema.
const TOKEN_CATEGORIES = [
  "colors",
  "spacing",
  "typography",
  "breakpoints",
  "shadows",
  "borders",
];

// ---------- Core algorithm ----------

/**
 * Normalize a token value for comparison.
 *   - All values: trim + lowercase
 *   - Colors (hex): expand 3-digit to 6-digit (#abc → #aabbcc)
 *
 * Does NOT convert between formats (rgb ↔ hex) or units (px ↔ rem).
 * This is intentional: we only flag exact string collisions after
 * minimal normalization.
 */
function normalizeValue(value, category) {
  if (value === null || value === undefined) return null;

  const str = String(value).trim().toLowerCase();
  if (str === "") return null;

  // For colors: expand 3-digit hex to 6-digit
  if (category === "colors") {
    const m = str.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (m) {
      return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
    }
  }

  return str;
}

/**
 * Flatten a category object to leaf entries.
 * Handles nested objects (e.g., Tailwind color palettes).
 *
 * Returns an array of { path: "category.key.subkey", value: "raw" }.
 */
function flattenCategory(obj, category, prefix) {
  const leaves = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : `${category}.${key}`;
    if (isPlainObject(value)) {
      leaves.push(...flattenCategory(value, category, p));
    } else {
      leaves.push({ path: p, value });
    }
  }
  return leaves;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Detect within-category value collisions in a design tokens object.
 *
 * @param {object} tokens - parsed design-tokens.json
 * @returns {{ conflicts: Array, totalTokens: number, categoriesScanned: number, warnings: string[] }}
 */
function detectConflicts(tokens) {
  const allConflicts = [];
  const warnings = [];
  let totalTokens = 0;
  let categoriesScanned = 0;

  for (const category of TOKEN_CATEGORIES) {
    const categoryData = tokens[category];
    if (!categoryData || !isPlainObject(categoryData)) continue;

    categoriesScanned++;

    // Flatten to leaves
    const leaves = flattenCategory(categoryData, category);
    totalTokens += leaves.length;

    if (leaves.length === 0) continue;

    // Group by normalized value
    const valueGroups = new Map();
    for (const leaf of leaves) {
      const normalized = normalizeValue(leaf.value, category);
      if (normalized === null) continue;

      if (!valueGroups.has(normalized)) {
        valueGroups.set(normalized, []);
      }
      valueGroups.get(normalized).push(leaf.path);
    }

    // Find collisions (groups with 2+ paths)
    for (const [normalizedValue, paths] of valueGroups) {
      if (paths.length >= 2) {
        allConflicts.push({
          category,
          resolvedValue: normalizedValue,
          tokenPaths: paths.sort(), // deterministic order
        });
      }
    }

    // Warn if >50% of category tokens collapse to a single value
    const maxGroupSize = Math.max(
      ...Array.from(valueGroups.values()).map((g) => g.length)
    );
    if (leaves.length >= 3 && maxGroupSize / leaves.length > 0.5) {
      warnings.push(
        `${category} — >50% of tokens share a single value`
      );
    }
  }

  // Sort conflicts by category, then by first token path for determinism
  allConflicts.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.tokenPaths[0].localeCompare(b.tokenPaths[0]);
  });

  return {
    conflicts: allConflicts,
    totalTokens,
    categoriesScanned,
    warnings,
  };
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1 || args.includes("--help") || args.includes("-h")) {
    console.log("detect-conflicts: error");
    console.log("error: Usage: node detect-conflicts.js <design-tokens.json>");
    process.exit(2);
  }

  const tokensPath = path.resolve(args[0]);

  // Check file exists
  if (!fs.existsSync(tokensPath)) {
    console.log("detect-conflicts: error");
    console.log(`error: file not found: ${tokensPath}`);
    process.exit(1);
  }

  // Parse JSON
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
  } catch (e) {
    console.log("detect-conflicts: error");
    console.log(`error: failed to parse JSON: ${e.message}`);
    process.exit(1);
  }

  // Run detection
  const result = detectConflicts(tokens);

  // Output
  const status = result.conflicts.length > 0 ? "found" : "ok";
  console.log(`detect-conflicts: ${status}`);
  console.log(`categories: ${result.categoriesScanned}`);
  console.log(`tokens: ${result.totalTokens}`);
  console.log(`conflicts: ${result.conflicts.length}`);

  for (const conflict of result.conflicts) {
    console.log(
      `conflict: ${conflict.category}:${conflict.resolvedValue} — ${conflict.tokenPaths.join(", ")}`
    );
  }

  for (const warning of result.warnings) {
    console.log(`warning: ${warning}`);
  }

  process.exit(0);
}

// ---------- Exports (for testing) + CLI entry ----------

module.exports = { detectConflicts, normalizeValue, flattenCategory };

if (require.main === module) {
  main();
}
