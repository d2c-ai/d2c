#!/usr/bin/env node

/**
 * validate-honor-flow.js — Bucket F enforcement for files emitted directly
 * by /d2c-build-flow (orchestrator page.tsx, state context, shared layout,
 * navigation smoke spec, flow-walker spec). The per-step bodies are emitted
 * by /d2c-build dispatches and get their own Bucket F coverage from
 * validate-honor.js — this script covers the orchestration-layer files that
 * /d2c-build never sees.
 *
 * Mirrors skills/d2c-build/scripts/validate-honor.js — same CLI shape, same
 * exit codes, same stdout format. Five buckets:
 *
 *   F1-Flow — every component import in the file resolves to either
 *             flow-graph.layouts[].component_id (shared shell), an entry in
 *             design-tokens.components[] (project component reuse), or a
 *             path under app/<route>/steps/ (delegated step body). Anything
 *             else is unauthorized.
 *
 *   F2-Flow — every Tailwind / inline-style hardcoded value in the file has
 *             a matching design-tokens.json entry. Same scanning logic as
 *             validate-honor.js's F2.
 *
 *   F3-Flow — orchestrator + state context honor the prop contract from
 *             framework-react-next.md §"Step component prop contract":
 *             - orchestrator imports each step from app/<group_route>/steps/Step<N>.tsx
 *             - orchestrator passes onNext / onBack / data / setField as props
 *             - state context exports the standard provider shape
 *               (next, back, goTo, data, setField; markStepValid when
 *                validation_enabled)
 *
 *   F4-Flow — nav-smoke spec asserts every edge in flow-graph.edges[].
 *             Missing edge = inform-tier violation.
 *
 *   F5-Flow — flow-walker spec covers every host (every routes-mode page +
 *             every stepper step's loaded slot) at every required viewport
 *             (desktop + mobile when mobile_variant is set).
 *
 * Usage:
 *   node validate-honor-flow.js <run-dir> <file1> [file2 ...] [--tokens <path>]
 *
 * Files are auto-categorised by filename pattern (see ROLE_PATTERNS below).
 *
 * Exit codes:
 *   0 — ok (no violations found)
 *   1 — fail (violations found)
 *   2 — CLI misuse
 *
 * Stdout (machine-readable, one key per line):
 *   validate-honor-flow: ok | fail
 *   files-scanned: <N>
 *   f1-violations: <N>
 *   f2-violations: <N>
 *   f3-violations: <N>
 *   f4-violations: <N>
 *   f5-violations: <N>
 *   violation: F1-Flow <file>:<line> — import "<source>" not authorized
 *   violation: F2-Flow <file>:<line> — token class "<class>" matches token "<path>" but not in design-tokens.json
 *   violation: F3-Flow <file> — <description>
 *   violation: F4-Flow <file> — edge <from>→<to> not asserted in nav-smoke spec
 *   violation: F5-Flow <file> — host <node_id> (<route>) not covered by walker spec
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------- File-role detection ----------

// Path-pattern fragments (case-insensitive) that classify each emitted file.
// Multiple roles can apply to one file (e.g. an orchestrator IS also a flow
// emission, so both F1/F2-Flow AND F3-Flow run). Roles are additive.
const ROLE_PATTERNS = {
  orchestrator: /(?:^|\/)app\/[^/]+\/page\.(?:tsx|jsx)$|(?:^|\/)pages\/[^/]+\.(?:tsx|jsx)$/i,
  state_context: /(?:^|\/)state\/.*context\.(?:tsx|jsx|ts|js)$/i,
  layout: /(?:^|\/)layout\.(?:tsx|jsx)$|(?:^|\/)layouts\/[^/]+\.(?:tsx|jsx)$/i,
  walker_spec: /flow-walker\.spec\.(?:tsx?|jsx?)$/i,
  nav_smoke_spec: /flow-navigation\.spec\.(?:tsx?|jsx?)$|(?:^|\/)tests\/flow\/.*navigation.*\.spec\.(?:tsx?|jsx?)$/i,
};

function rolesFor(filePath) {
  const roles = new Set();
  for (const [role, pattern] of Object.entries(ROLE_PATTERNS)) {
    if (pattern.test(filePath)) roles.add(role);
  }
  return roles;
}

// ---------- IR loading ----------

function loadFlowIR(runDir) {
  const flowDir = path.join(runDir, "flow");
  const graphPath = path.join(flowDir, "flow-graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error(`flow-graph.json not found at ${graphPath}`);
  }
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  const lockPath = path.join(flowDir, "flow-decisions-lock.json");
  const lock = fs.existsSync(lockPath)
    ? JSON.parse(fs.readFileSync(lockPath, "utf8"))
    : null;
  return { graph, lock };
}

function loadDesignTokens(tokensPath) {
  if (!tokensPath || !fs.existsSync(tokensPath)) return null;
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
  } catch (_e) {
    return null;
  }
  if (tokens.split_files === true) {
    const dir = path.dirname(tokensPath);
    for (const name of [
      "tokens-core.json",
      "tokens-colors.json",
      "tokens-components.json",
      "tokens-conventions.json",
    ]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          Object.assign(tokens, JSON.parse(fs.readFileSync(p, "utf8")));
        } catch (_e) {
          /* ignore */
        }
      }
    }
  }
  return tokens;
}

// ---------- Shared helpers (mirror validate-honor.js patterns) ----------

function normalizeImportPath(p) {
  let normalized = p
    .replace(/^\.\//, "")
    .replace(/\.(tsx?|jsx?|vue|svelte|astro)$/, "");
  if (normalized.startsWith("@/")) normalized = "src/" + normalized.slice(2);
  return normalized;
}

function extractImports(content) {
  const imports = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const importMatch = line.match(/import\s+.*?\s+from\s+['"](.+?)['"]/);
    if (importMatch) {
      const source = importMatch[1];
      if (
        !source.startsWith(".") &&
        !source.startsWith("@/") &&
        !source.startsWith("~/")
      ) {
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

function extractTokenUsage(content) {
  const usages = [];
  const lines = content.split("\n");
  const tokenPatterns = [
    /(?:bg|text|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/g,
    /(?:bg|text|border)-\[rgba?\([^)]+\)\]/g,
    /(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy]|w|h|min-w|min-h|max-w|max-h)-\[\d+px\]/g,
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of tokenPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(lines[i])) !== null) {
        usages.push({ line: i + 1, tokenClass: match[0] });
      }
    }
  }
  return usages;
}

function buildTokenReverseLookup(tokens) {
  const lookup = new Map();
  if (!tokens) return lookup;
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
      out.set(value.trim().toLowerCase(), p);
    }
  }
}

// ---------- F1-Flow: authorized component imports ----------

function buildAuthorizedFlowComponents(graph, tokens) {
  // Three sources of authorization:
  //   1. flow-graph.layouts[].component_id / .figma_node_id  (shared shells)
  //   2. design-tokens.components[].source                    (project reuse)
  //   3. <any path> matching app/<route>/steps/Step<N>.<ext>  (delegated steps)
  // We track the normalised paths so import resolution can match them.
  const authorized = new Set();
  for (const layout of graph.layouts || []) {
    if (layout.component_id) authorized.add(normalizeImportPath(layout.component_id));
    if (layout.source) authorized.add(normalizeImportPath(layout.source));
    if (layout.name) authorized.add(layout.name); // bare name fallback for relative imports
  }
  if (tokens && Array.isArray(tokens.components)) {
    for (const c of tokens.components) {
      if (c.source) authorized.add(normalizeImportPath(c.source));
      if (c.name) authorized.add(c.name);
    }
  }
  return authorized;
}

const STEPS_DIR_PATTERN = /(?:^|\/)steps\/[A-Z][A-Za-z0-9]*$/;
const STATE_DIR_PATTERN = /(?:^|\/)state\/[A-Za-z][A-Za-z0-9]*$/;

function checkF1Flow(filePath, content, authorized) {
  const violations = [];
  const imports = extractImports(content);
  for (const imp of imports) {
    let resolvedNormalized = imp.normalized;
    if (imp.source.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), imp.source);
      resolvedNormalized = normalizeImportPath(
        path.relative(process.cwd(), resolved)
      );
    }

    if (authorized.has(resolvedNormalized)) continue;
    if (STEPS_DIR_PATTERN.test(resolvedNormalized)) continue; // delegated step body
    if (STATE_DIR_PATTERN.test(resolvedNormalized)) continue; // flow-emitted state context
    // Bare-name fallback: import '../OnboardingShell' might normalise to
    // '../OnboardingShell' relative to cwd, but the layout was authorised by
    // its bare name 'OnboardingShell'. Check the basename.
    const base = path.basename(resolvedNormalized);
    if (authorized.has(base)) continue;

    // Heuristic: only flag imports that LOOK like component imports.
    // PascalCase basename = a React/Vue/Svelte component. lowercase = likely
    // a hook / util / module — don't flag (would produce noise on every
    // useState / useEffect / clsx import).
    if (!/^[A-Z]/.test(base)) continue;

    violations.push({
      file: filePath,
      line: imp.line,
      source: imp.source,
      resolvedPath: resolvedNormalized,
    });
  }
  return violations;
}

// ---------- F2-Flow: token usage ----------

function checkF2Flow(filePath, content, reverseLookup) {
  const violations = [];
  const usages = extractTokenUsage(content);
  for (const usage of usages) {
    const hexMatch = usage.tokenClass.match(/#[0-9a-fA-F]{3,8}/);
    if (hexMatch) {
      const hex = hexMatch[0].toLowerCase();
      const tokenPath = reverseLookup.get(hex);
      if (tokenPath) {
        // Token exists in design-tokens.json but the value is hardcoded
        // inline here instead of being expressed via a semantic class.
        violations.push({
          file: filePath,
          line: usage.line,
          tokenClass: usage.tokenClass,
          matchedToken: tokenPath,
        });
      }
    }
  }
  return violations;
}

// ---------- F3-Flow: orchestrator + state-context prop contract ----------

function checkF3FlowOrchestrator(filePath, content, graph) {
  const violations = [];
  // Orchestrators only matter for stepper-mode / hybrid-mode flows. For pure
  // routes-mode, this file is just a regular page and only F1/F2 apply.
  if (!["stepper", "hybrid"].includes(graph.mode)) return violations;

  // Find the matching stepper group — orchestrator path includes the group's
  // route segment.
  const group = (graph.stepper_groups || []).find((g) =>
    new RegExp(`(?:^|/)${g.route.replace(/^\//, "").replace(/\//g, "\\/")}/page\\.`).test(filePath)
  );
  if (!group) return violations; // orchestrator for a different group; skip

  const stepCount = (group.steps || []).length;
  if (stepCount === 0) return violations;

  // Required: each step is imported from ./steps/Step<N>.tsx (or .jsx) OR
  // ./steps/Step<Title>.tsx (title-based naming used by the framework
  // reference's example outputs). We accept either the numeric or title
  // form — both are documented patterns.
  const stepImports = [];
  // Accept both numeric (Step1, Step2) and title-based (StepEmail, StepVerify)
  // suffixes — both naming patterns appear in the framework reference.
  const importRe = /from\s+['"]\.\/steps\/(Step(?:[A-Z][A-Za-z0-9_]*|\d+))['"]/g;
  let importMatch;
  while ((importMatch = importRe.exec(content)) !== null) {
    stepImports.push(importMatch[1]);
  }
  if (new Set(stepImports).size < stepCount) {
    violations.push({
      file: filePath,
      description: `orchestrator imports ${new Set(stepImports).size} unique step component(s) from ./steps/, but group "${group.name}" declares ${stepCount} steps. Got: [${stepImports.join(", ")}]`,
    });
  }

  // Required: each step's JSX call passes onNext + onBack as props.
  // Use a non-greedy match up to the closing /> so arrow functions inside
  // props (e.g. onNext={() => next()}) don't truncate the captured tag.
  const stepJsxPattern = /<Step[A-Z][A-Za-z0-9_]*\b[\s\S]*?\/>/g;
  let match;
  while ((match = stepJsxPattern.exec(content)) !== null) {
    const tag = match[0];
    if (!/\bonNext\s*=\s*\{/.test(tag)) {
      violations.push({
        file: filePath,
        description: `step JSX missing onNext prop: ${tag.slice(0, 80)}…`,
      });
    }
    if (!/\bonBack\s*=\s*\{/.test(tag)) {
      violations.push({
        file: filePath,
        description: `step JSX missing onBack prop: ${tag.slice(0, 80)}…`,
      });
    }
  }

  // Required when validation_enabled: orchestrator wires onValidityChange.
  if (group.validation_enabled === true) {
    if (!/onValidityChange\s*=\s*\{/.test(content)) {
      violations.push({
        file: filePath,
        description: `group "${group.name}" has validation_enabled=true but orchestrator never wires onValidityChange to markStepValid`,
      });
    }
  }

  return violations;
}

function stripComments(content) {
  // Remove /* … */ block comments and // … line comments. Quick-and-dirty —
  // strings with `//` inside survive unchanged because we only strip from
  // start-of-comment tokens that aren't already inside a string.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function checkF3FlowStateContext(filePath, content, graph) {
  const violations = [];
  if (!["stepper", "hybrid"].includes(graph.mode)) return violations;

  const group = (graph.stepper_groups || []).find((g) =>
    new RegExp(
      `(?:^|/)${g.route.replace(/^\//, "").replace(/\//g, "\\/")}/state/`
    ).test(filePath)
  );
  if (!group) return violations;

  // Required exports / methods. Check by name presence; we don't enforce full
  // signatures here (validate-honor-flow is a static checker, not a type
  // checker — F3-Flow flags missing names so the AI sees the gap).
  const required = ["next", "back", "goTo", "data", "setField"];
  if (group.validation_enabled === true) {
    required.push("markStepValid");
  }
  // Strip comments first so a `// TODO: wire markStepValid` line doesn't
  // satisfy the "name present" check.
  const code = stripComments(content);
  for (const name of required) {
    // Match either `name(` (function), `name:` (object property),
    // or `name = ` (assignment / arrow function).
    const present = new RegExp(`\\b${name}\\s*[(:=]`).test(code);
    if (!present) {
      violations.push({
        file: filePath,
        description: `state context missing "${name}" — required by step prop contract (see framework-react-next.md §"Step component prop contract")`,
      });
    }
  }
  return violations;
}

// ---------- F4-Flow: nav-smoke spec edge coverage ----------

function checkF4Flow(filePath, content, graph) {
  const violations = [];
  for (const edge of graph.edges || []) {
    if (!edge.from_node_id || !edge.to_node_id) continue;
    // Each edge must produce at least one assertion in the spec. We accept
    // any of these shapes:
    //   - the to_node_id route appears in a page.goto / expect URL
    //   - the from + to node ids appear in a comment near a click+wait pair
    const toPage = (graph.pages || []).find((p) => p.node_id === edge.to_node_id);
    const toRoute = toPage?.route;
    if (toRoute) {
      const escaped = toRoute.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`['"]${escaped}['"]`).test(content)) continue;
    }
    if (
      content.includes(`/* edge ${edge.from_node_id}->${edge.to_node_id} */`) ||
      content.includes(`// edge ${edge.from_node_id}->${edge.to_node_id}`)
    ) {
      continue;
    }
    violations.push({
      file: filePath,
      from: edge.from_node_id,
      to: edge.to_node_id,
      route: toRoute ?? null,
    });
  }
  return violations;
}

// ---------- F5-Flow: walker spec host coverage ----------

function checkF5Flow(filePath, content, graph) {
  const violations = [];

  // Build the canonical set of (host_node_id, viewport) tuples the walker
  // must screenshot.
  const required = [];
  for (const page of graph.pages || []) {
    if (page.page_type === "stepper_group") continue; // covered by per-step entries below
    const viewports = page.mobile_variant ? ["desktop", "mobile"] : ["desktop"];
    for (const v of viewports) {
      required.push({
        node_id: page.node_id,
        route: page.route,
        viewport: v,
        scope: "page",
      });
    }
  }
  for (const group of graph.stepper_groups || []) {
    for (const step of group.steps || []) {
      const viewports = step.mobile_variant
        ? ["desktop", "mobile"]
        : ["desktop"];
      for (const v of viewports) {
        required.push({
          node_id: step.node_id,
          route: `${group.route}#step-${step.order}`,
          viewport: v,
          scope: "step",
        });
      }
    }
  }

  for (const need of required) {
    // Acceptance: the walker references the host's node_id either in a
    // diffAgainstFigma() call (template's helper) or in a `// host <id>`
    // comment near a screenshot block. Viewport tag must appear in the
    // surrounding test() block.
    const idQuoted = `"${need.node_id}"`;
    const idSingle = `'${need.node_id}'`;
    const hostMentioned = content.includes(idQuoted) || content.includes(idSingle);
    const viewportMentioned = new RegExp(`\\b${need.viewport}\\b`).test(content);
    if (!(hostMentioned && viewportMentioned)) {
      violations.push({
        file: filePath,
        node_id: need.node_id,
        route: need.route,
        viewport: need.viewport,
        scope: need.scope,
      });
    }
  }
  return violations;
}

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

function main(argv = process.argv.slice(2)) {
  const { runDir, files, tokensPath } = parseArgs(argv);

  if (!runDir || files.length === 0) {
    console.error(
      "Usage: node validate-honor-flow.js <run-dir> <file1> [file2 ...] [--tokens <path>]"
    );
    return 2;
  }

  if (!fs.existsSync(runDir)) {
    console.log("validate-honor-flow: fail");
    console.log("files-scanned: 0");
    console.log("f1-violations: 0");
    console.log("f2-violations: 0");
    console.log("f3-violations: 0");
    console.log("f4-violations: 0");
    console.log("f5-violations: 0");
    console.log("errors: 1");
    console.log(`error: run-dir not found: ${runDir}`);
    return 1;
  }

  let ir;
  try {
    ir = loadFlowIR(runDir);
  } catch (e) {
    console.log("validate-honor-flow: fail");
    console.log("files-scanned: 0");
    console.log("f1-violations: 0");
    console.log("f2-violations: 0");
    console.log("f3-violations: 0");
    console.log("f4-violations: 0");
    console.log("f5-violations: 0");
    console.log("errors: 1");
    console.log(`error: ${e.message}`);
    return 1;
  }

  const resolvedTokensPath =
    tokensPath || path.join(".claude", "d2c", "design-tokens.json");
  const tokens = loadDesignTokens(resolvedTokensPath);
  const authorized = buildAuthorizedFlowComponents(ir.graph, tokens);
  const reverseLookup = buildTokenReverseLookup(tokens);

  const existingFiles = files.filter((f) => fs.existsSync(f));

  const f1 = [];
  const f2 = [];
  const f3 = [];
  const f4 = [];
  const f5 = [];

  for (const filePath of existingFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    const roles = rolesFor(filePath);

    f1.push(...checkF1Flow(filePath, content, authorized));
    f2.push(...checkF2Flow(filePath, content, reverseLookup));

    if (roles.has("orchestrator")) {
      f3.push(...checkF3FlowOrchestrator(filePath, content, ir.graph));
    }
    if (roles.has("state_context")) {
      f3.push(...checkF3FlowStateContext(filePath, content, ir.graph));
    }
    if (roles.has("nav_smoke_spec")) {
      f4.push(...checkF4Flow(filePath, content, ir.graph));
    }
    if (roles.has("walker_spec")) {
      f5.push(...checkF5Flow(filePath, content, ir.graph));
    }
  }

  const total = f1.length + f2.length + f3.length + f4.length + f5.length;
  const status = total === 0 ? "ok" : "fail";

  console.log(`validate-honor-flow: ${status}`);
  console.log(`files-scanned: ${existingFiles.length}`);
  console.log(`f1-violations: ${f1.length}`);
  console.log(`f2-violations: ${f2.length}`);
  console.log(`f3-violations: ${f3.length}`);
  console.log(`f4-violations: ${f4.length}`);
  console.log(`f5-violations: ${f5.length}`);

  for (const v of f1) {
    console.log(
      `violation: F1-Flow ${v.file}:${v.line} — import "${v.source}" not authorized (resolved: ${v.resolvedPath}; not in flow-graph.layouts[], design-tokens.components[], or app/<route>/steps/)`
    );
  }
  for (const v of f2) {
    console.log(
      `violation: F2-Flow ${v.file}:${v.line} — token class "${v.tokenClass}" matches token "${v.matchedToken}" but is hardcoded inline; use the semantic class instead`
    );
  }
  for (const v of f3) {
    console.log(`violation: F3-Flow ${v.file} — ${v.description}`);
  }
  for (const v of f4) {
    console.log(
      `violation: F4-Flow ${v.file} — edge ${v.from}→${v.to}${v.route ? ` (${v.route})` : ""} not asserted in nav-smoke spec`
    );
  }
  for (const v of f5) {
    console.log(
      `violation: F5-Flow ${v.file} — host ${v.node_id} (${v.route}, viewport=${v.viewport}, scope=${v.scope}) not covered by walker spec`
    );
  }

  return total === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  parseArgs,
  rolesFor,
  loadFlowIR,
  loadDesignTokens,
  buildAuthorizedFlowComponents,
  normalizeImportPath,
  extractImports,
  extractTokenUsage,
  checkF1Flow,
  checkF2Flow,
  checkF3FlowOrchestrator,
  checkF3FlowStateContext,
  checkF4Flow,
  checkF5Flow,
  ROLE_PATTERNS,
};
