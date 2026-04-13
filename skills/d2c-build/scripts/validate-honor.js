#!/usr/bin/env node

/**
 * validate-honor.js — IR honor checker for d2c-build Phase 5, Bucket F
 *
 * Usage:
 *   node validate-honor.js <run-dir> <file1.tsx> [file2.tsx ...] [--tokens <path>]
 *
 * Validates that generated code honors the frozen IR:
 *   F1. Every component import in touched files corresponds to a `chosen`
 *       entry in component-match.json (by source path) or is a __NEW__
 *       component.
 *   F2. Every design token class/value used in touched files is referenced
 *       by at least one entry in token-map.json.
 *
 * Exit codes:
 *   0 — ok (no violations found)
 *   1 — fail (violations found)
 *   2 — CLI misuse
 *
 * Stdout format:
 *   validate-honor: ok | fail
 *   files-scanned: <N>
 *   f1-violations: <N>
 *   f2-violations: <N>
 *   violation: F1 <file>:<line> — import "<source>" not in component-match.json.chosen
 *   violation: F2 <file>:<line> — token class "<class>" not in token-map.json
 */

const fs = require("fs");
const path = require("path");

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { runDir: null, files: [], tokensPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tokens") {
      out.tokensPath = argv[++i];
    } else if (!out.runDir) {
      out.runDir = argv[i];
    } else {
      out.files.push(argv[i]);
    }
  }
  return out;
}

// ---------- IR Loading ----------

function loadIR(runDir) {
  const cmPath = path.join(runDir, "component-match.json");
  const tmPath = path.join(runDir, "token-map.json");

  if (!fs.existsSync(cmPath)) throw new Error(`component-match.json not found in ${runDir}`);
  if (!fs.existsSync(tmPath)) throw new Error(`token-map.json not found in ${runDir}`);

  const componentMatch = JSON.parse(fs.readFileSync(cmPath, "utf-8"));
  const tokenMap = JSON.parse(fs.readFileSync(tmPath, "utf-8"));

  return { componentMatch, tokenMap };
}

// ---------- F1: Component Import Validation ----------

/**
 * Extract the set of authorized component source paths from component-match.json.
 * Returns a Map of source path -> { nodeId, componentId }.
 */
function buildAuthorizedComponents(componentMatch) {
  const authorized = new Map();
  const newComponentNodes = new Set();

  for (const [nodeId, node] of Object.entries(componentMatch.nodes || {})) {
    if (node.chosen === "__NEW__") {
      newComponentNodes.add(nodeId);
      continue;
    }
    if (node.chosen === null) continue;

    const candidates = node.candidates || [];
    const match = candidates.find((c) => c.componentId === node.chosen);
    if (match && match.source) {
      authorized.set(normalizeImportPath(match.source), {
        nodeId,
        componentId: node.chosen,
      });
    }
  }

  return { authorized, newComponentNodes };
}

/**
 * Normalize an import path for comparison:
 * - Remove leading ./ or ../
 * - Remove file extension
 * - Resolve @/ alias to src/
 */
function normalizeImportPath(p) {
  let normalized = p
    .replace(/^\.\//, "")
    .replace(/\.(tsx?|jsx?|vue|svelte|astro)$/, "");

  // Handle @/ alias -> src/
  if (normalized.startsWith("@/")) {
    normalized = "src/" + normalized.slice(2);
  }

  return normalized;
}

/**
 * Extract import source paths from a file's content.
 * Returns array of { line, source, normalized }.
 */
function extractImports(content) {
  const imports = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: import ... from "..."  or  import ... from '...'
    const importMatch = line.match(/import\s+.*?\s+from\s+['"](.+?)['"]/);
    if (importMatch) {
      const source = importMatch[1];
      // Skip external packages (no . or @ prefix, or starts with @scope/)
      if (!source.startsWith(".") && !source.startsWith("@/") && !source.startsWith("~/")) {
        continue;
      }
      imports.push({
        line: i + 1,
        source,
        normalized: normalizeImportPath(source),
      });
    }

    // Match: const ... = require("...")
    const requireMatch = line.match(/require\s*\(\s*['"](.+?)['"]\s*\)/);
    if (requireMatch) {
      const source = requireMatch[1];
      if (!source.startsWith(".") && !source.startsWith("@/") && !source.startsWith("~/")) {
        continue;
      }
      imports.push({
        line: i + 1,
        source,
        normalized: normalizeImportPath(source),
      });
    }
  }

  return imports;
}

/**
 * Check F1 violations: imports in touched files must match component-match.json.chosen.
 */
function checkF1(files, componentMatch) {
  const { authorized } = buildAuthorizedComponents(componentMatch);
  const violations = [];

  // Also build a set of known UI component paths (from candidates, not just chosen)
  // to distinguish "unauthorized IR component" from "utility import"
  const allCandidateSources = new Set();
  for (const node of Object.values(componentMatch.nodes || {})) {
    for (const c of node.candidates || []) {
      if (c.source) allCandidateSources.add(normalizeImportPath(c.source));
    }
  }

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const imports = extractImports(content);

    for (const imp of imports) {
      // Resolve relative imports against the file's directory
      let resolvedNormalized = imp.normalized;
      if (imp.source.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filePath), imp.source);
        resolvedNormalized = normalizeImportPath(
          path.relative(process.cwd(), resolved)
        );
      }

      // Check if this import is an authorized component
      const isAuthorized = authorized.has(resolvedNormalized);

      // Only flag as F1 violation if the import looks like a component import
      // (exists in candidate sources but was not the chosen one)
      if (!isAuthorized && allCandidateSources.has(resolvedNormalized)) {
        violations.push({
          file: filePath,
          line: imp.line,
          source: imp.source,
          resolvedPath: resolvedNormalized,
        });
      }
    }
  }

  return violations;
}

// ---------- F2: Token Usage Validation ----------

/**
 * Build the set of authorized token values from token-map.json.
 * Returns a Set of token paths (e.g., "colors.primary", "spacing.md").
 */
function buildAuthorizedTokens(tokenMap) {
  const tokens = new Set();

  for (const props of Object.values(tokenMap.nodes || {})) {
    for (const tokenRef of Object.values(props || {})) {
      // Handle __LIBRARY_BOUNDARY__ markers
      if (tokenRef.startsWith("__LIBRARY_BOUNDARY__:")) {
        const parts = tokenRef.split(":");
        if (parts[1]) tokens.add(parts[1]);
        continue;
      }
      tokens.add(tokenRef);
    }
  }

  return tokens;
}

/**
 * Extract design token usage from file content.
 * Looks for Tailwind semantic classes that map to design tokens.
 * Returns array of { line, tokenClass }.
 */
function extractTokenUsage(content) {
  const usages = [];
  const lines = content.split("\n");

  // Patterns that indicate design token usage in Tailwind
  // These map to token categories: colors, spacing, typography, borders, shadows
  const tokenPatterns = [
    // Hardcoded hex colors in Tailwind arbitrary values
    /(?:bg|text|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/g,
    // Hardcoded rgba in Tailwind arbitrary values
    /(?:bg|text|border)-\[rgba?\([^)]+\)\]/g,
    // Hardcoded pixel values in spacing contexts
    /(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy]|w|h|min-w|min-h|max-w|max-h)-\[\d+px\]/g,
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of tokenPatterns) {
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(lines[i])) !== null) {
        usages.push({
          line: i + 1,
          tokenClass: match[0],
        });
      }
    }
  }

  return usages;
}

/**
 * Load tokens and build a reverse lookup: hex value -> token path.
 */
function buildTokenReverseLookup(tokensPath) {
  if (!tokensPath || !fs.existsSync(tokensPath)) return new Map();

  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
  } catch (_e) {
    return new Map();
  }

  // If split_files, try to load and merge
  if (tokens.split_files === true) {
    const dir = path.dirname(tokensPath);
    const splitFiles = [
      "tokens-core.json",
      "tokens-colors.json",
      "tokens-components.json",
      "tokens-conventions.json",
    ];
    for (const name of splitFiles) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          Object.assign(tokens, JSON.parse(fs.readFileSync(p, "utf-8")));
        } catch (_e) {
          /* skip corrupt split file */
        }
      }
    }
  }

  const lookup = new Map();
  const categories = ["colors", "spacing", "typography", "shadows", "borders"];

  for (const cat of categories) {
    const node = tokens[cat];
    if (node && typeof node === "object") {
      walkForReverse(node, cat, lookup);
    }
  }

  return lookup;
}

function walkForReverse(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const p = `${prefix}.${key}`;
    if (typeof value === "object" && value !== null) {
      walkForReverse(value, p, out);
    } else if (typeof value === "string") {
      // Normalize hex values for lookup
      const normalized = value.trim().toLowerCase();
      out.set(normalized, p);
    }
  }
}

/**
 * Check F2 violations: hardcoded values in touched files that have exact
 * token matches but are not in token-map.json.
 */
function checkF2(files, tokenMap, tokensPath) {
  const authorizedTokens = buildAuthorizedTokens(tokenMap);
  const reverseLookup = buildTokenReverseLookup(tokensPath);
  const violations = [];

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const usages = extractTokenUsage(content);

    for (const usage of usages) {
      // Extract the raw value from the Tailwind arbitrary class
      const hexMatch = usage.tokenClass.match(/#[0-9a-fA-F]{3,8}/);
      if (hexMatch) {
        const hex = hexMatch[0].toLowerCase();
        const tokenPath = reverseLookup.get(hex);
        if (tokenPath && !authorizedTokens.has(tokenPath)) {
          violations.push({
            file: filePath,
            line: usage.line,
            tokenClass: usage.tokenClass,
            matchedToken: tokenPath,
          });
        }
      }
    }
  }

  return violations;
}

// ---------- Main ----------

function main(argv = process.argv.slice(2)) {
  const { runDir, files, tokensPath } = parseArgs(argv);

  if (!runDir || files.length === 0) {
    console.error(
      "Usage: node validate-honor.js <run-dir> <file1.tsx> [file2.tsx ...] [--tokens <path>]"
    );
    return 2;
  }

  if (!fs.existsSync(runDir)) {
    console.log("validate-honor: fail");
    console.log("files-scanned: 0");
    console.log("f1-violations: 0");
    console.log("f2-violations: 0");
    console.log("errors: 1");
    console.log(`error: run-dir not found: ${runDir}`);
    return 1;
  }

  let ir;
  try {
    ir = loadIR(runDir);
  } catch (e) {
    console.log("validate-honor: fail");
    console.log("files-scanned: 0");
    console.log("f1-violations: 0");
    console.log("f2-violations: 0");
    console.log("errors: 1");
    console.log(`error: ${e.message}`);
    return 1;
  }

  const resolvedTokensPath =
    tokensPath || path.join(".claude", "d2c", "design-tokens.json");

  const existingFiles = files.filter((f) => fs.existsSync(f));

  const f1Violations = checkF1(existingFiles, ir.componentMatch);
  const f2Violations = checkF2(existingFiles, ir.tokenMap, resolvedTokensPath);

  const totalViolations = f1Violations.length + f2Violations.length;
  const status = totalViolations === 0 ? "ok" : "fail";

  console.log(`validate-honor: ${status}`);
  console.log(`files-scanned: ${existingFiles.length}`);
  console.log(`f1-violations: ${f1Violations.length}`);
  console.log(`f2-violations: ${f2Violations.length}`);

  for (const v of f1Violations) {
    console.log(
      `violation: F1 ${v.file}:${v.line} — import "${v.source}" not in component-match.json.chosen (resolved: ${v.resolvedPath})`
    );
  }

  for (const v of f2Violations) {
    console.log(
      `violation: F2 ${v.file}:${v.line} — token class "${v.tokenClass}" matches token "${v.matchedToken}" but is not authorized in token-map.json`
    );
  }

  return totalViolations === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  parseArgs,
  loadIR,
  buildAuthorizedComponents,
  buildAuthorizedTokens,
  normalizeImportPath,
  extractImports,
  extractTokenUsage,
  checkF1,
  checkF2,
};
