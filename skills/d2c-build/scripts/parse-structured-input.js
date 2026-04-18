#!/usr/bin/env node

/**
 * parse-structured-input.js — Validate and normalise the JSON payload
 * /d2c-build-flow dispatches into /d2c-build when generating a state variant
 * (loaded / loading / empty / error / initial). Keeps Phase 1 Q&A deterministic
 * and parsable without a live user, and isolates the dispatch schema from the
 * skill prompt so both sides can evolve independently.
 *
 * Usage:
 *   node parse-structured-input.js <payload-file>
 *
 * Exit codes:
 *   0 — payload valid; normalised JSON on stdout
 *   1 — validation failure; one `error:` line per problem
 *   2 — CLI misuse
 *
 * Exports `parseStructuredInput(raw)` for tests.
 *
 * Required fields:
 *   figma_url          — string (must contain `?node-id=` or `&node-id=`)
 *   component_name     — PascalCase identifier
 *   output_path        — path relative to the project root
 *   semantic_role      — one of: loaded | loading | empty | error | initial
 *   project_conventions {
 *     component_type   — server | client | mixed
 *     error_boundary   { kind: next-file-convention | react-error-boundary
 *                              | custom-class | none, import_path: string|null }
 *     data_fetching    { kind: server-component-fetch | react-query | swr
 *                              | custom-hook | none, example_import: string|null }
 *   }
 *
 * Optional fields (defaults applied on normalisation):
 *   what               — page | section | component   (default: "component")
 *   mode               — functional | visual-only    (default: "functional")
 *   viewports          — desktop-only | multiple     (default: "desktop-only")
 *   components_to_reuse — string                     (default: "use what makes sense")
 *   has_api_calls      — yes | no                    (default: "no")
 *   trigger            — string | null               (default: null; REQUIRED when
 *                                                      semantic_role ∈ loading|error)
 *   parent_flow_run    — string path | null          (default: null)
 *   audit_path         — string path | null          (default: null; must end in
 *                                                      `audit.json` when provided.
 *                                                      When set, /d2c-build Phase 6
 *                                                      appends the variant's result
 *                                                      entry to that file — flow-level
 *                                                      pixel-diff aggregation.)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED_TOP = [
  "figma_url",
  "component_name",
  "output_path",
  "semantic_role",
  "project_conventions",
];

const SEMANTIC_ROLES = ["loaded", "loading", "empty", "error", "initial"];
const COMPONENT_TYPES = ["server", "client", "mixed"];
const ERROR_BOUNDARY_KINDS = [
  "next-file-convention",
  "react-error-boundary",
  "custom-class",
  "none",
];
const DATA_FETCHING_KINDS = [
  "server-component-fetch",
  "react-query",
  "swr",
  "custom-hook",
  "none",
];
const WHAT_VALUES = ["page", "section", "component"];
const MODE_VALUES = ["functional", "visual-only"];
const VIEWPORT_VALUES = ["desktop-only", "multiple"];
const API_VALUES = ["yes", "no"];

const DEFAULTS = {
  what: "component",
  mode: "functional",
  viewports: "desktop-only",
  components_to_reuse: "use what makes sense",
  has_api_calls: "no",
  trigger: null,
  parent_flow_run: null,
  audit_path: null,
};

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateFigmaUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return "figma_url — must be a non-empty string";
  }
  try {
    const u = new URL(url);
    const nodeId = u.searchParams.get("node-id");
    if (!nodeId) {
      return "figma_url — missing `node-id` query parameter (bare file URLs are not accepted)";
    }
  } catch (_) {
    return `figma_url — not a parseable URL: "${url}"`;
  }
  return null;
}

function validateComponentName(name) {
  if (typeof name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return `component_name — must be PascalCase (got "${name}")`;
  }
  return null;
}

function validateOutputPath(p) {
  if (typeof p !== "string" || p.length === 0) {
    return "output_path — must be a non-empty string";
  }
  if (path.isAbsolute(p)) {
    return `output_path — must be relative to the project root (got absolute "${p}")`;
  }
  if (p.includes("..")) {
    return `output_path — must not contain '..' segments (got "${p}")`;
  }
  return null;
}

function validateEnum(field, value, allowed) {
  if (!allowed.includes(value)) {
    return `${field} — expected one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`;
  }
  return null;
}

function validateProjectConventions(pc) {
  const errors = [];
  if (!isPlainObject(pc)) {
    return ["project_conventions — must be an object"];
  }
  const ct = validateEnum("project_conventions.component_type", pc.component_type, COMPONENT_TYPES);
  if (ct) errors.push(ct);

  if (!isPlainObject(pc.error_boundary)) {
    errors.push("project_conventions.error_boundary — must be an object");
  } else {
    const ebKind = validateEnum(
      "project_conventions.error_boundary.kind",
      pc.error_boundary.kind,
      ERROR_BOUNDARY_KINDS
    );
    if (ebKind) errors.push(ebKind);
    if (
      pc.error_boundary.import_path !== null &&
      pc.error_boundary.import_path !== undefined &&
      typeof pc.error_boundary.import_path !== "string"
    ) {
      errors.push(
        "project_conventions.error_boundary.import_path — must be a string or null"
      );
    }
  }

  if (!isPlainObject(pc.data_fetching)) {
    errors.push("project_conventions.data_fetching — must be an object");
  } else {
    const dfKind = validateEnum(
      "project_conventions.data_fetching.kind",
      pc.data_fetching.kind,
      DATA_FETCHING_KINDS
    );
    if (dfKind) errors.push(dfKind);
    if (
      pc.data_fetching.example_import !== null &&
      pc.data_fetching.example_import !== undefined &&
      typeof pc.data_fetching.example_import !== "string"
    ) {
      errors.push(
        "project_conventions.data_fetching.example_import — must be a string or null"
      );
    }
  }

  return errors;
}

function parseStructuredInput(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["payload — must be a JSON object"] };
  }

  // Error stubs are emitted directly by /d2c-build-flow Phase 3 (see
  // references/framework-react-next.md §"Error stub") and MUST NOT be
  // dispatched through /d2c-build. Reject up front with a pointer so a
  // misconfigured dispatch fails loud instead of tripping on missing figma_url.
  if (raw.stub === true) {
    return {
      ok: false,
      errors: [
        "stub — error stubs are handled by /d2c-build-flow Phase 3 directly and must not be dispatched to /d2c-build (see framework-react-next.md §\"Error stub\")",
      ],
    };
  }

  // Required fields present
  for (const key of REQUIRED_TOP) {
    if (!(key in raw)) {
      errors.push(`${key} — required`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // figma_url
  const urlErr = validateFigmaUrl(raw.figma_url);
  if (urlErr) errors.push(urlErr);

  // component_name
  const nameErr = validateComponentName(raw.component_name);
  if (nameErr) errors.push(nameErr);

  // output_path
  const pathErr = validateOutputPath(raw.output_path);
  if (pathErr) errors.push(pathErr);

  // semantic_role
  const roleErr = validateEnum("semantic_role", raw.semantic_role, SEMANTIC_ROLES);
  if (roleErr) errors.push(roleErr);

  // project_conventions
  errors.push(...validateProjectConventions(raw.project_conventions));

  // Optional fields with enum constraints
  if ("what" in raw) {
    const e = validateEnum("what", raw.what, WHAT_VALUES);
    if (e) errors.push(e);
  }
  if ("mode" in raw) {
    const e = validateEnum("mode", raw.mode, MODE_VALUES);
    if (e) errors.push(e);
  }
  if ("viewports" in raw) {
    const e = validateEnum("viewports", raw.viewports, VIEWPORT_VALUES);
    if (e) errors.push(e);
  }
  if ("has_api_calls" in raw) {
    const e = validateEnum("has_api_calls", raw.has_api_calls, API_VALUES);
    if (e) errors.push(e);
  }
  if ("components_to_reuse" in raw && typeof raw.components_to_reuse !== "string") {
    errors.push("components_to_reuse — must be a string");
  }
  if ("parent_flow_run" in raw && raw.parent_flow_run !== null && typeof raw.parent_flow_run !== "string") {
    errors.push("parent_flow_run — must be a string path or null");
  }
  if ("audit_path" in raw && raw.audit_path !== null && raw.audit_path !== undefined) {
    if (typeof raw.audit_path !== "string") {
      errors.push("audit_path — must be a string path or null");
    } else if (raw.audit_path.length === 0) {
      errors.push("audit_path — must be a non-empty string when provided");
    } else if (!raw.audit_path.endsWith("audit.json")) {
      errors.push(
        `audit_path — must end in 'audit.json' when provided (got "${raw.audit_path}")`
      );
    } else if (raw.audit_path.includes("..")) {
      errors.push(`audit_path — must not contain '..' segments (got "${raw.audit_path}")`);
    }
  }

  // Trigger requirement: mandatory for loading / error
  if (
    (raw.semantic_role === "loading" || raw.semantic_role === "error") &&
    (raw.trigger === undefined ||
      raw.trigger === null ||
      raw.trigger === "" ||
      raw.trigger === "MISSING")
  ) {
    errors.push(
      `trigger — required when semantic_role is ${raw.semantic_role} (cannot be empty or "MISSING")`
    );
  }
  if ("trigger" in raw && raw.trigger !== null && typeof raw.trigger !== "string") {
    errors.push("trigger — must be a string or null");
  }

  if (errors.length > 0) return { ok: false, errors };

  // Normalise: apply defaults for optional fields, strip unknown keys beyond
  // the documented set so downstream consumers can trust the shape.
  const normalised = {
    figma_url: raw.figma_url,
    component_name: raw.component_name,
    output_path: raw.output_path,
    semantic_role: raw.semantic_role,
    what: raw.what ?? DEFAULTS.what,
    mode: raw.mode ?? DEFAULTS.mode,
    viewports: raw.viewports ?? DEFAULTS.viewports,
    components_to_reuse: raw.components_to_reuse ?? DEFAULTS.components_to_reuse,
    has_api_calls: raw.has_api_calls ?? DEFAULTS.has_api_calls,
    trigger: raw.trigger ?? DEFAULTS.trigger,
    parent_flow_run: raw.parent_flow_run ?? DEFAULTS.parent_flow_run,
    audit_path: raw.audit_path ?? DEFAULTS.audit_path,
    project_conventions: {
      component_type: raw.project_conventions.component_type,
      error_boundary: {
        kind: raw.project_conventions.error_boundary.kind,
        import_path: raw.project_conventions.error_boundary.import_path ?? null,
      },
      data_fetching: {
        kind: raw.project_conventions.data_fetching.kind,
        example_import: raw.project_conventions.data_fetching.example_import ?? null,
      },
    },
  };

  return { ok: true, value: normalised };
}

// ---------- CLI ----------

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error("usage: parse-structured-input.js <payload-file>");
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  } catch (e) {
    console.error(`error: could not read/parse payload: ${e.message}`);
    process.exit(1);
  }
  const result = parseStructuredInput(raw);
  if (!result.ok) {
    for (const err of result.errors) console.log(`error: ${err}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result.value, null, 2));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseStructuredInput };
