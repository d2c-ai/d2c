#!/usr/bin/env node

/**
 * validate-ir.js — IR validator for d2c-build Phase 2
 *
 * Usage:
 *   node validate-ir.js <run-dir> [--tokens <path>]
 *
 * Validates the four Intermediate Representation artifacts produced at the
 * start of Phase 2 before any code generation. Two-layer validation:
 *
 *   Layer 1 (structural) — JSON Schema check against each artifact's
 *     co-located schema file in ../schemas/. Uses a small inlined schema
 *     validator (no external deps, matching the pixeldiff.js pattern).
 *
 *   Layer 2 (semantic) — cross-references across artifacts and against
 *     design-tokens.json: token paths resolve, hash matches, chosen
 *     components exist in their own candidates[], layout.children cross-
 *     reference component-match.nodes, deferred[] is empty, schema
 *     versions are consistent across artifacts, chosen component source
 *     files exist on disk or in design-tokens.components[].
 *
 * Exit codes:
 *   0 — ok or skip (run-dir not present)
 *   1 — fail
 *   2 — CLI misuse
 *
 * Stdout format (one line per key, machine-readable):
 *
 *   validate-ir: ok | fail | skip
 *   artifacts: <N>
 *   nodes: <N>
 *   token-refs: <N>
 *   errors: <N>
 *   error: <file>:<path> — <message>
 *   ...
 *
 * On skip:
 *   validate-ir: skip
 *   reason: <why>
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ARTIFACT_FILES = [
  { key: "manifest", filename: "run-manifest.json", schema: "run-manifest.schema.json" },
  { key: "componentMatch", filename: "component-match.json", schema: "component-match.schema.json" },
  { key: "tokenMap", filename: "token-map.json", schema: "token-map.schema.json" },
  { key: "layout", filename: "layout.json", schema: "layout.schema.json" },
  { key: "lock", filename: "decisions.lock.json", schema: "decisions-lock.schema.json", optional: true },
];

// Token categories the model may reference. Matches d2c-init token schema.
const TOKEN_CATEGORIES = [
  "colors",
  "spacing",
  "typography",
  "breakpoints",
  "shadows",
  "borders",
];

// ---------- Layer 1: inlined minimal JSON Schema validator ----------

/**
 * Walks a data value against a schema and returns an array of error strings.
 * Supports a subset of JSON Schema draft-07 sufficient for IR schemas:
 *   type (string or array of strings, including "null")
 *   required, properties, items, enum, minimum, pattern, $ref,
 *   additionalProperties (false | schema)
 *
 * @param schema - the schema fragment
 * @param data - the value being validated
 * @param fieldPath - JSONPath-ish string for error messages
 * @param rootSchema - the top-level schema (for resolving $ref against its definitions)
 */
function validateSchema(schema, data, fieldPath = "", rootSchema = null) {
  const errors = [];
  const root = rootSchema || schema;

  // Resolve $ref first; everything else in this schema node is ignored per draft-07 behavior.
  if (schema.$ref) {
    const refKey = schema.$ref.replace(/^#\/definitions\//, "");
    const resolved = (root.definitions || {})[refKey];
    if (!resolved) {
      errors.push(`${fieldPath || "$"}: unresolved $ref ${schema.$ref}`);
      return errors;
    }
    return validateSchema(resolved, data, fieldPath, root);
  }

  // type (supports string or array of strings)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = jsonType(data);
    const matchesAny = types.some((t) => matchesType(t, data, actualType));
    if (!matchesAny) {
      errors.push(
        `${fieldPath || "$"}: expected ${types.join(" or ")}, got ${actualType}`
      );
      // If the type is wrong there's nothing more worth checking at this node.
      return errors;
    }
  }

  // enum
  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => deepEqual(v, data))) {
      errors.push(
        `${fieldPath || "$"}: value ${JSON.stringify(
          data
        )} not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`
      );
    }
  }

  // minimum (numbers only)
  if (schema.minimum !== undefined && typeof data === "number" && data < schema.minimum) {
    errors.push(`${fieldPath || "$"}: value ${data} is less than minimum ${schema.minimum}`);
  }

  // pattern (strings only)
  if (schema.pattern !== undefined && typeof data === "string") {
    let re;
    try {
      re = new RegExp(schema.pattern);
    } catch (_e) {
      errors.push(`${fieldPath || "$"}: invalid pattern ${schema.pattern}`);
    }
    if (re && !re.test(data)) {
      errors.push(
        `${fieldPath || "$"}: value ${JSON.stringify(data)} does not match pattern ${schema.pattern}`
      );
    }
  }

  // Object-level checks (required, properties, additionalProperties)
  if (isPlainObject(data)) {
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`${fieldPath || "$"}: missing required field '${field}'`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          errors.push(
            ...validateSchema(propSchema, data[key], joinPath(fieldPath, key), root)
          );
        }
      }
    }

    const definedKeys = new Set(Object.keys(schema.properties || {}));
    const extras = Object.keys(data).filter((k) => !definedKeys.has(k));
    if (schema.additionalProperties === false && extras.length > 0) {
      for (const key of extras) {
        errors.push(`${joinPath(fieldPath, key)}: unexpected field`);
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of extras) {
        errors.push(
          ...validateSchema(
            schema.additionalProperties,
            data[key],
            joinPath(fieldPath, key),
            root
          )
        );
      }
    }
  }

  // Array items
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      errors.push(...validateSchema(schema.items, data[i], `${fieldPath}[${i}]`, root));
    }
  }

  return errors;
}

function jsonType(data) {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  return typeof data;
}

function matchesType(declaredType, data, actualType) {
  if (declaredType === "integer") return typeof data === "number" && Number.isInteger(data);
  if (declaredType === "number") return typeof data === "number";
  if (declaredType === "null") return data === null;
  if (declaredType === "array") return Array.isArray(data);
  if (declaredType === "object") return isPlainObject(data);
  return declaredType === actualType;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function joinPath(base, key) {
  if (!base) return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : `["${key}"]`;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return `${base}.${key}`;
  return `${base}["${key}"]`;
}

// ---------- Layer 2: semantic validation ----------

/**
 * Cross-references and value-level semantic checks. Assumes all four
 * artifacts passed Layer 1 and are plain objects.
 */
function validateSemantic(artifacts, tokens, tokensPath) {
  const errors = [];
  const { manifest, componentMatch, tokenMap, layout } = artifacts;

  // Schema version consistency across all four files.
  const versions = [
    manifest.schema_version,
    componentMatch.schema_version,
    tokenMap.schema_version,
    layout.schema_version,
  ];
  if (new Set(versions).size > 1) {
    errors.push(
      `run-manifest.json:schema_version — schema_version mismatch across artifacts: ${versions.join(
        ", "
      )}`
    );
  }

  // Tokens file hash.
  let actualHash;
  try {
    actualHash = computeTokensHash(tokensPath, tokens);
  } catch (e) {
    errors.push(`run-manifest.json:tokens_file_hash — ${e.message}`);
  }
  if (actualHash && manifest.tokens_file_hash !== actualHash) {
    errors.push(
      `run-manifest.json:tokens_file_hash — hash mismatch (expected ${actualHash.slice(
        0,
        16
      )}..., got ${String(manifest.tokens_file_hash).slice(
        0,
        16
      )}...). Tokens file changed after IR was emitted.`
    );
  }

  // Build valid token path set by flattening design-tokens.json categories.
  const validTokenPaths = flattenTokens(tokens);

  // token-map.json: every value must resolve to a valid token path.
  // Values may be either a dotted token path (e.g., "colors.primary")
  // or a __LIBRARY_BOUNDARY__ marker (e.g., "__LIBRARY_BOUNDARY__:colors.primary:#2563EB")
  // which indicates the value must be hardcoded due to library API constraints.
  let tokenRefCount = 0;
  let libraryBoundaryCount = 0;
  for (const [nodeId, props] of Object.entries(tokenMap.nodes || {})) {
    for (const [prop, tokenRef] of Object.entries(props || {})) {
      tokenRefCount++;

      // Handle __LIBRARY_BOUNDARY__ markers: extract the embedded token path and validate it.
      if (tokenRef.startsWith("__LIBRARY_BOUNDARY__:")) {
        libraryBoundaryCount++;
        const parts = tokenRef.split(":");
        // Format: __LIBRARY_BOUNDARY__:<token_path>:<hex_value>
        const embeddedTokenPath = parts[1];
        if (embeddedTokenPath && !validTokenPaths.has(embeddedTokenPath)) {
          const hint = formatDidYouMean(embeddedTokenPath, validTokenPaths);
          errors.push(
            `token-map.json:nodes["${nodeId}"].${prop} — library boundary marker references unknown token "${embeddedTokenPath}"${hint}`
          );
        }
        continue;
      }

      if (!validTokenPaths.has(tokenRef)) {
        const hint = formatDidYouMean(tokenRef, validTokenPaths);
        errors.push(
          `token-map.json:nodes["${nodeId}"].${prop} — unknown token reference "${tokenRef}"${hint}`
        );
      }
    }
  }

  // layout.json: gap tokens must resolve; root.regions must exist in regions map;
  // leaf region children must exist in component-match.json.nodes.
  if (layout.root) {
    if (layout.root.gap && !validTokenPaths.has(layout.root.gap)) {
      const hint = formatDidYouMean(layout.root.gap, validTokenPaths);
      errors.push(
        `layout.json:root.gap — unknown token reference "${layout.root.gap}"${hint}`
      );
    }
    tokenRefCount += 1;
    for (const regionId of layout.root.regions || []) {
      if (!(layout.regions && regionId in layout.regions)) {
        errors.push(
          `layout.json:root.regions — region "${regionId}" not present in layout.regions map`
        );
      }
    }
  }
  for (const [regionId, region] of Object.entries(layout.regions || {})) {
    if (region.gap && !validTokenPaths.has(region.gap)) {
      const hint = formatDidYouMean(region.gap, validTokenPaths);
      errors.push(
        `layout.json:regions["${regionId}"].gap — unknown token reference "${region.gap}"${hint}`
      );
    }
    tokenRefCount += 1;
    for (const childId of region.children || []) {
      if (!(componentMatch.nodes && childId in componentMatch.nodes)) {
        errors.push(
          `layout.json:regions["${regionId}"].children — child nodeId "${childId}" not present in component-match.json.nodes`
        );
      }
    }
  }

  // layout.deferred must be empty.
  if (Array.isArray(layout.deferred) && layout.deferred.length > 0) {
    for (const d of layout.deferred) {
      errors.push(
        `layout.json:deferred — region "${d.nodeId}" deferred: ${
          d.reason || "(no reason given)"
        }`
      );
    }
  }

  // component-match.json: chosen validity + source existence.
  const isV2 = componentMatch.schema_version === 2;
  let nodeCount = 0;
  for (const [nodeId, node] of Object.entries(componentMatch.nodes || {})) {
    nodeCount++;
    const candidates = node.candidates || [];
    if (node.chosen === null) {
      errors.push(
        `component-match.json:nodes["${nodeId}"].chosen — chosen is null (ambiguous). Model could not decide among candidates.`
      );
      continue;
    }
    if (node.chosen === "__NEW__") {
      // Valid "create new component" signal; Item #4 (failure-modes) codifies user prompt.
      continue;
    }
    // chosen must be a componentId from candidates[]
    const match = candidates.find((c) => c.componentId === node.chosen);
    if (!match) {
      errors.push(
        `component-match.json:nodes["${nodeId}"].chosen — value "${node.chosen}" not in candidates[].componentId`
      );
      continue;
    }
    // Source must exist on disk OR be registered in design-tokens.components[].
    if (match.source) {
      const existsOnDisk = fs.existsSync(match.source);
      const inTokensComponents = Array.isArray(tokens.components)
        ? tokens.components.some((c) => c.path === match.source)
        : false;
      if (!existsOnDisk && !inTokensComponents) {
        errors.push(
          `component-match.json:nodes["${nodeId}"].chosen — component source "${match.source}" does not exist on disk and is not in design-tokens.json components[]`
        );
      }
    }

    // ── v2 scoring validation ──
    if (isV2) {
      // Candidates must be sorted by score descending.
      for (let i = 0; i < candidates.length - 1; i++) {
        if (
          typeof candidates[i].score === "number" &&
          typeof candidates[i + 1].score === "number" &&
          candidates[i].score < candidates[i + 1].score
        ) {
          errors.push(
            `component-match.json:nodes["${nodeId}"].candidates — not sorted by score descending (index ${i} score ${candidates[i].score} < index ${i + 1} score ${candidates[i + 1].score})`
          );
          break; // one sort error per node is enough
        }
      }

      // Validate each candidate's scoring fields.
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const prefix = `component-match.json:nodes["${nodeId}"].candidates[${i}]`;

        // score must be integer 0-100
        if (typeof c.score !== "number" || !Number.isInteger(c.score) || c.score < 0 || c.score > 100) {
          errors.push(`${prefix}.score — must be integer 0-100, got ${JSON.stringify(c.score)}`);
        }

        // score_breakdown must exist and sum correctly
        if (c.score_breakdown) {
          const bd = c.score_breakdown;
          const pm = bd.props_match;
          const uf = bd.usage_frequency;
          const al = bd.alignment;

          // Range checks
          if (typeof pm !== "number" || !Number.isInteger(pm) || pm < 0 || pm > 50) {
            errors.push(`${prefix}.score_breakdown.props_match — must be integer 0-50, got ${JSON.stringify(pm)}`);
          }
          if (typeof uf !== "number" || !Number.isInteger(uf) || uf < 0 || uf > 25) {
            errors.push(`${prefix}.score_breakdown.usage_frequency — must be integer 0-25, got ${JSON.stringify(uf)}`);
          }
          if (typeof al !== "number" || !Number.isInteger(al) || al < 0 || al > 25) {
            errors.push(`${prefix}.score_breakdown.alignment — must be integer 0-25, got ${JSON.stringify(al)}`);
          }

          // Sum check
          if (typeof pm === "number" && typeof uf === "number" && typeof al === "number" && typeof c.score === "number") {
            const sum = pm + uf + al;
            if (sum !== c.score) {
              errors.push(
                `${prefix}.score_breakdown — sum (${pm} + ${uf} + ${al} = ${sum}) does not equal score (${c.score})`
              );
            }
          }
        } else {
          errors.push(`${prefix}.score_breakdown — required in v2 but missing`);
        }

        // rejected_because: required for non-chosen candidates
        const isChosen = c.componentId === node.chosen;
        if (!isChosen) {
          if (typeof c.rejected_because !== "string" || c.rejected_because.trim() === "") {
            errors.push(`${prefix}.rejected_because — required for non-chosen candidates in v2`);
          }
        }
      }

      // Chosen must be highest-scoring candidate OR user_confirmed.
      if (candidates.length > 0) {
        const chosenCandidate = candidates.find((c) => c.componentId === node.chosen);
        if (chosenCandidate) {
          const isHighest = candidates[0].componentId === node.chosen;
          const isUserConfirmed = chosenCandidate.user_confirmed === true;
          if (!isHighest && !isUserConfirmed) {
            errors.push(
              `component-match.json:nodes["${nodeId}"].chosen — "${node.chosen}" is not the highest-scoring candidate and is not user_confirmed`
            );
          }
        }
      }
    }
  }

  return { errors, nodeCount, tokenRefCount };
}

/**
 * Semantic validation for decisions.lock.json (optional artifact).
 * Cross-references the lock against component-match.json and checks
 * internal consistency of failed-node metadata.
 */
function validateLockSemantic(lock, componentMatch) {
  const errors = [];

  // layout_locked must be true in v1.
  if (lock.layout_locked !== true) {
    errors.push(
      `decisions.lock.json:layout_locked — must be true in v1, got ${JSON.stringify(lock.layout_locked)}`
    );
  }

  // Schema version consistency with component-match.
  if (lock.schema_version !== componentMatch.schema_version) {
    errors.push(
      `decisions.lock.json:schema_version — mismatch with component-match.json (lock: ${lock.schema_version}, component-match: ${componentMatch.schema_version})`
    );
  }

  const cmNodes = componentMatch.nodes || {};

  for (const [nodeId, entry] of Object.entries(lock.nodes || {})) {
    // Every locked nodeId must exist in component-match.json.nodes.
    if (!(nodeId in cmNodes)) {
      errors.push(
        `decisions.lock.json:nodes["${nodeId}"] — node not present in component-match.json.nodes`
      );
      continue;
    }

    const cmChosen = cmNodes[nodeId].chosen;

    if (entry.status === "locked") {
      // For locked nodes: componentId must match component-match chosen.
      if (entry.componentId !== cmChosen) {
        errors.push(
          `decisions.lock.json:nodes["${nodeId}"].componentId — locked componentId "${entry.componentId}" does not match component-match.json chosen "${cmChosen}". Lock is stale.`
        );
      }
    } else if (entry.status === "failed") {
      // For failed nodes: failure metadata must all be present.
      if (!entry.failure_reason) {
        errors.push(
          `decisions.lock.json:nodes["${nodeId}"].failure_reason — required when status is "failed"`
        );
      }
      if (!entry.failed_at) {
        errors.push(
          `decisions.lock.json:nodes["${nodeId}"].failed_at — required when status is "failed"`
        );
      }
      if (!entry.failed_by) {
        errors.push(
          `decisions.lock.json:nodes["${nodeId}"].failed_by — required when status is "failed"`
        );
      }
      // For failed nodes: componentId may differ from component-match chosen
      // (re-decision happened). The new chosen must still be valid — that is
      // already checked by the core component-match semantic validation.
    }
  }

  return errors;
}

// ---------- Helpers: tokens, hashing, did-you-mean ----------

/**
 * Core token categories that MUST have at least one entry for a valid build.
 * An empty core category means d2c-init did not extract tokens for that
 * category — the model will invent workarounds (e.g., using border-radius
 * as spacing) if we don't catch it here.
 */
const CORE_TOKEN_CATEGORIES = ["colors", "spacing", "typography"];

/**
 * Load and merge design-tokens.json, handling split_files mode.
 *
 * When `split_files: true`, the main file is a lightweight pointer with
 * only `d2c_schema_version`, `split_files`, `framework`, `meta_framework`.
 * The actual token data lives in four split files in the same directory.
 * This function merges them into a single in-memory object.
 *
 * @param {string} tokensPath - path to design-tokens.json
 * @returns {object} the merged tokens object
 */
function loadTokens(tokensPath) {
  const raw = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));

  if (raw.split_files !== true) {
    return raw;
  }

  // Split-file mode: merge the four split files into the pointer object.
  const dir = path.dirname(tokensPath);
  const splitFiles = [
    "tokens-core.json",
    "tokens-colors.json",
    "tokens-components.json",
    "tokens-conventions.json",
  ];

  const merged = { ...raw };
  for (const name of splitFiles) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      throw new Error(
        `split_files=true but missing ${name} in ${dir}. Run /d2c-init to regenerate split files.`
      );
    }
    const splitData = JSON.parse(fs.readFileSync(p, "utf-8"));
    Object.assign(merged, splitData);
  }

  return merged;
}

function flattenTokens(tokens) {
  const paths = new Set();
  for (const cat of TOKEN_CATEGORIES) {
    const node = tokens[cat];
    if (isPlainObject(node)) {
      walkTokens(node, cat, paths);
    }
  }
  return paths;
}

/**
 * Check that core token categories (colors, spacing, typography) are
 * non-empty. An empty core category means d2c-init did not populate it,
 * and the model will be forced to invent workarounds or skip token mapping.
 *
 * Returns an array of warning/error strings. These are NOT added to the
 * main errors array by default — the caller decides severity.
 */
function checkCoreTokenCategories(tokens) {
  const warnings = [];
  for (const cat of CORE_TOKEN_CATEGORIES) {
    const node = tokens[cat];
    if (!node || !isPlainObject(node) || Object.keys(node).length === 0) {
      warnings.push(
        `design-tokens.json:${cat} — STOP AND ASK: token category "${cat}" is empty. ` +
        `The model cannot map Figma ${cat} values to tokens. ` +
        `Run \`/d2c-init --force\` to populate, or manually add ${cat} tokens.`
      );
    }
  }
  return warnings;
}

function walkTokens(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const p = `${prefix}.${key}`;
    if (isPlainObject(value)) {
      walkTokens(value, p, out);
    } else {
      out.add(p);
    }
  }
}

/**
 * Compute the tokens-file hash per the run-manifest contract:
 *   - split_files=false → SHA-256 of raw design-tokens.json bytes
 *   - split_files=true  → SHA-256 of core|colors|components|conventions
 *                         split files concatenated (raw bytes) in that order
 */
function computeTokensHash(tokensPath, tokens) {
  if (tokens && tokens.split_files === true) {
    const dir = path.dirname(tokensPath);
    const order = [
      "tokens-core.json",
      "tokens-colors.json",
      "tokens-components.json",
      "tokens-conventions.json",
    ];
    const hash = crypto.createHash("sha256");
    for (const name of order) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) {
        throw new Error(`split_files=true but missing ${p}`);
      }
      hash.update(fs.readFileSync(p));
    }
    return hash.digest("hex");
  }
  return crypto.createHash("sha256").update(fs.readFileSync(tokensPath)).digest("hex");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function didYouMean(target, candidateSet, maxDistance = 2) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const c of candidateSet) {
    const d = levenshtein(target, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function formatDidYouMean(target, candidateSet) {
  const suggestion = didYouMean(target, candidateSet);
  return suggestion ? ` (did you mean "${suggestion}"?)` : "";
}

// ---------- CLI / main ----------

function parseArgs(argv) {
  const out = { runDir: null, tokensPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tokens") {
      out.tokensPath = argv[++i];
    } else if (!out.runDir) {
      out.runDir = argv[i];
    }
  }
  return out;
}

function resolveLatestPointer(pointerPath) {
  const stat = fs.lstatSync(pointerPath);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(pointerPath);
    return path.isAbsolute(target) ? target : path.join(path.dirname(pointerPath), target);
  }
  return fs.readFileSync(pointerPath, "utf-8").trim();
}

function resolveRunDir(rawRunDir) {
  if (rawRunDir === "latest") {
    const pointer = path.join(".claude", "d2c", "runs", "latest");
    if (!fs.existsSync(pointer)) return null;
    try {
      return resolveLatestPointer(pointer);
    } catch (_e) {
      return null;
    }
  }
  return rawRunDir;
}

function locateSchemasDir() {
  // Primary: sibling of scripts/
  const primary = path.join(__dirname, "..", "schemas");
  if (fs.existsSync(primary)) return primary;
  return null;
}

function main(argv = process.argv.slice(2)) {
  const { runDir: rawRunDir, tokensPath: rawTokensPath } = parseArgs(argv);

  if (!rawRunDir) {
    console.error("Usage: node validate-ir.js <run-dir> [--tokens <path>]");
    return 2;
  }

  const runDir = resolveRunDir(rawRunDir);
  if (!runDir || !fs.existsSync(runDir)) {
    console.log("validate-ir: skip");
    console.log("reason: run-dir not found");
    return 0;
  }

  const tokensPath =
    rawTokensPath || path.join(".claude", "d2c", "design-tokens.json");

  const schemasDir = locateSchemasDir();
  if (!schemasDir) {
    console.log("validate-ir: fail");
    console.log("artifacts: 0");
    console.log("nodes: 0");
    console.log("token-refs: 0");
    console.log("errors: 1");
    console.log(`error: schemas/ directory not found next to scripts/`);
    return 1;
  }

  const errors = [];
  const artifacts = {};

  // Layer 1: load + structurally validate each artifact.
  for (const { key, filename, schema: schemaFile, optional } of ARTIFACT_FILES) {
    const filePath = path.join(runDir, filename);
    if (!fs.existsSync(filePath)) {
      if (optional) {
        artifacts[key] = null;
        continue;
      }
      errors.push(`${filename}: file not found in run-dir`);
      artifacts[key] = null;
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      errors.push(`${filename}: JSON parse error: ${e.message}`);
      artifacts[key] = null;
      continue;
    }
    artifacts[key] = data;

    const schemaPath = path.join(schemasDir, schemaFile);
    if (!fs.existsSync(schemaPath)) {
      errors.push(`${filename}: schema file ${schemaFile} not found`);
      continue;
    }
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    } catch (e) {
      errors.push(`${filename}: schema parse error (${schemaFile}): ${e.message}`);
      continue;
    }
    const schemaErrors = validateSchema(schema, data, "", schema);
    for (const err of schemaErrors) {
      errors.push(`${filename}:${err}`);
    }
  }

  let nodeCount = 0;
  let tokenRefCount = 0;

  const requiredArtifacts = ARTIFACT_FILES.filter((a) => !a.optional);
  const allLoaded = requiredArtifacts.every(({ key }) => artifacts[key] !== null);
  const layer1Clean = errors.length === 0;

  if (allLoaded && layer1Clean) {
    if (!fs.existsSync(tokensPath)) {
      errors.push(`${tokensPath}: tokens file not found`);
    } else {
      let tokens;
      try {
        tokens = loadTokens(tokensPath);
      } catch (e) {
        errors.push(`${tokensPath}: ${e.message}`);
      }
      if (tokens) {
        // Check core token categories are non-empty before semantic validation.
        const coreWarnings = checkCoreTokenCategories(tokens);
        errors.push(...coreWarnings);

        const semantic = validateSemantic(artifacts, tokens, tokensPath);
        errors.push(...semantic.errors);
        nodeCount = semantic.nodeCount;
        tokenRefCount = semantic.tokenRefCount;

        // Lock semantic validation (only if the lock file was loaded).
        if (artifacts.lock) {
          const lockErrors = validateLockSemantic(artifacts.lock, artifacts.componentMatch);
          errors.push(...lockErrors);
        }
      }
    }
  } else if (allLoaded) {
    // Even on Layer 1 failure, try to count nodes/token-refs for the report.
    nodeCount = Object.keys(artifacts.componentMatch?.nodes || {}).length;
    tokenRefCount = Object.values(artifacts.tokenMap?.nodes || {}).reduce(
      (acc, props) => acc + Object.keys(props || {}).length,
      0
    );
  }

  const status = errors.length === 0 ? "ok" : "fail";
  const artifactCount = ARTIFACT_FILES.filter(
    ({ key, optional }) => artifacts[key] !== null || !optional
  ).length;
  console.log(`validate-ir: ${status}`);
  console.log(`artifacts: ${artifactCount}`);
  console.log(`nodes: ${nodeCount}`);
  console.log(`token-refs: ${tokenRefCount}`);
  console.log(`lock: ${artifacts.lock ? "validated" : "skipped"}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors) {
    console.log(`error: ${e}`);
  }

  return errors.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  validateSchema,
  validateSemantic,
  validateLockSemantic,
  flattenTokens,
  loadTokens,
  checkCoreTokenCategories,
  computeTokensHash,
  levenshtein,
  didYouMean,
  parseArgs,
  resolveRunDir,
};
