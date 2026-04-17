#!/usr/bin/env node

/**
 * parse-flow-prompt.js — Grammar parser for /d2c-build-flow invocations.
 *
 * Parses a natural-language prompt of the form:
 *
 *   /d2c-build-flow
 *   In these following pages we need to build the following flow,
 *   this is the route /onboarding
 *   These are the steps:
 *   Step 1: <figma-frame-url>
 *   Step 2: <figma-frame-url>  route: /signup/verify
 *
 * Produces an object describing base_route, parsed steps, resolved routes,
 * and a list of failure_ids matching the names in failure-modes.md:
 *
 *   F-FLOW-PARSE-AMBIGUOUS   step line did not match the grammar
 *   F-FLOW-STEP-GAP          step numbers are not contiguous from 1
 *   F-FLOW-FILE-URL          step URL missing node-id query parameter
 *   F-FLOW-NO-ROUTE          step has no route and no base_route
 *   F-FLOW-ROUTE-ESCAPES-BASE  explicit route is not under base_route (inform only)
 *   F-FLOW-TOO-FEW-STEPS     fewer than 2 step lines parsed
 *
 * This module is pure and deterministic; no IO, no Figma calls. Unit tests
 * drive every branch.
 *
 * Usage (programmatic):
 *   const { parseFlowPrompt } = require('./parse-flow-prompt');
 *   const result = parseFlowPrompt(promptText);
 *
 * Usage (CLI, for ad-hoc inspection):
 *   node parse-flow-prompt.js <path-to-prompt-file>
 */

"use strict";

// Candidate step lines start with "Step" followed by either a digit (Form A/B)
// or `:` / `-` (Form C). We use a permissive candidate matcher first so that
// malformed lines still surface as F-FLOW-PARSE-AMBIGUOUS rather than being
// silently ignored.
// Form A/B: `Step 1:` / `Step 3a:` — digit required, optional single lowercase
//           letter suffix for branching (B-FLOW-MULTI-BRANCH).
// Form C:   `Step: <url>` — no digit, exactly one step line, auto-discover
//                           the rest of the flow from Figma prototype edges.
const STEP_CANDIDATE_RE = /^\s*Step\s+\d+[a-z]?\b.*$|^\s*Step\s*[:\-]\s*\S+\s*$/i;

// Strict grammar for Form A/B. Captures: 1=number, 2=branch suffix (a/b/…),
// 3=url, 4=trailing directives.
// URL is anything non-whitespace; directives (`route:` / `state:`) are parsed
// separately from the trailing string so order is flexible.
// Branch suffix: a single lowercase letter immediately after the number (no
// whitespace) turns the step into a branch group — e.g. `Step 3a:` and
// `Step 3b:` are two outgoing branches from the same upstream page.
const STEP_STRICT_RE = /^\s*Step\s+(\d+)([a-z]?)\s*[:\-]\s*(\S+)(\s.*)?$/i;

// Directive matchers applied to the trailing string.
const ROUTE_DIRECTIVE_RE = /\broute:\s*(\/\S+)/i;
const STATE_DIRECTIVE_RE = /\bstate:\s*([^]*?)(?=\s+(?:route:|state:)|\s*$)/i;
const STATE_FIELD_RE = /^([a-z][A-Za-z0-9]*)\s*:\s*(string|number|boolean)$/;
// Mobile variant URL (B-FLOW-MOBILE-VARIANT). One mobile URL per step; must
// point at a frame (node-id required) in any Figma file.
const MOBILE_DIRECTIVE_RE = /\bmobile:\s*(\S+)/i;

// Strict grammar for Form C (auto-discovery). Captures: 1=url.
// Only legal when it is the sole step line and no Form A/B lines are present.
const STEP_DISCOVER_RE = /^\s*Step\s*[:\-]\s*(\S+)\s*$/i;

// Route token in the preamble: first occurrence of `route /<path>`.
const PREAMBLE_ROUTE_RE = /\broute\s+(\/\S+)/i;

// Figma URL must have a node-id query parameter to point at a specific frame.
const FIGMA_NODE_ID_RE = /[?&]node-id=([A-Za-z0-9%:\-]+)/;

// Figma file key — the path segment after `/design/` or `/file/` up to the
// next `/`. Used to group steps by file (B-FLOW-CROSS-FILE).
const FIGMA_FILE_KEY_RE = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/i;

/**
 * Parse a /d2c-build-flow prompt.
 *
 * @param {string} promptText
 * @returns {{
 *   ok: boolean,
 *   failures: Array<{id: string, severity: 'error'|'warning', detail: object}>,
 *   base_route: string | null,
 *   flow_name: string | null,
 *   auto_discovered: boolean,
 *   steps: Array<{step_number: number, figma_url: string, node_id: string, route: string, route_source: 'explicit'|'derived'}>
 * }}
 */
function parseFlowPrompt(promptText) {
  if (typeof promptText !== "string") {
    return {
      ok: false,
      failures: [
        {
          id: "F-FLOW-PARSE-AMBIGUOUS",
          severity: "error",
          detail: { reason: "prompt is not a string" },
        },
      ],
      base_route: null,
      flow_name: null,
      auto_discovered: false,
      steps: [],
    };
  }

  const lines = promptText.split(/\r?\n/);
  const failures = [];

  // Split the prompt at the first line matching the step-candidate regex.
  let firstStepIdx = lines.findIndex((l) => STEP_CANDIDATE_RE.test(l));
  if (firstStepIdx === -1) firstStepIdx = lines.length;

  const preamble = lines.slice(0, firstStepIdx).join("\n");
  const base_route = extractBaseRoute(preamble);

  // Collect step candidates and parse them strictly.
  // Each element: { lineIdx, raw, match, parsed: {step_number, figma_url, route_explicit} | null, form: 'A' | 'C' | null }
  const rawSteps = [];
  for (let i = firstStepIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!STEP_CANDIDATE_RE.test(line)) continue;

    const strict = STEP_STRICT_RE.exec(line);
    if (strict) {
      const step_number = parseInt(strict[1], 10);
      const branch = strict[2] ? strict[2].toLowerCase() : null;
      const figma_url = strict[3];
      const trailing = (strict[4] || "").trim();

      const directives = parseStepDirectives(trailing);
      if (directives.error) {
        failures.push({
          id: directives.error.id,
          severity: "error",
          detail: { line_number: i + 1, line, ...directives.error.detail },
        });
        rawSteps.push({ lineIdx: i, raw: line, match: strict, parsed: null, form: "A" });
        continue;
      }

      rawSteps.push({
        lineIdx: i,
        raw: line,
        match: strict,
        parsed: {
          step_number,
          branch,
          figma_url,
          route_explicit: directives.route,
          state_writes: directives.state_writes,
          mobile_url: directives.mobile_url || null,
        },
        form: "A",
      });
      continue;
    }

    const discover = STEP_DISCOVER_RE.exec(line);
    if (discover) {
      rawSteps.push({
        lineIdx: i,
        raw: line,
        match: discover,
        parsed: { figma_url: discover[1] },
        form: "C",
      });
      continue;
    }

    failures.push({
      id: "F-FLOW-PARSE-AMBIGUOUS",
      severity: "error",
      detail: { line_number: i + 1, line },
    });
    rawSteps.push({ lineIdx: i, raw: line, match: null, parsed: null, form: null });
  }

  // Detect Form C — exactly one step line, discover form, no Form A lines present.
  const formAStepCount = rawSteps.filter((s) => s.form === "A").length;
  const formCStepCount = rawSteps.filter((s) => s.form === "C").length;
  const auto_discovered = formCStepCount === 1 && formAStepCount === 0;

  // Mixing Form A and Form C is illegal — the grammars mean different things.
  if (formCStepCount > 0 && formAStepCount > 0) {
    failures.push({
      id: "F-FLOW-PARSE-AMBIGUOUS",
      severity: "error",
      detail: {
        reason:
          "mixed `Step: <url>` (auto-discover) and `Step N: <url>` (explicit) forms — pick one",
      },
    });
  }

  // Multiple Form C lines (more than one auto-discover step) is also illegal.
  if (formCStepCount > 1) {
    failures.push({
      id: "F-FLOW-PARSE-AMBIGUOUS",
      severity: "error",
      detail: {
        reason:
          "auto-discover grammar (`Step: <url>`) accepts exactly one starting frame — list multiple steps as `Step 1:`, `Step 2:`, …",
      },
    });
  }

  // Form A steps carry their own step_number. For Form C we synthesise a
  // single step_number=1 entry so downstream consumers see the same shape.
  let parsedSteps;
  if (auto_discovered) {
    const entry = rawSteps.find((s) => s.form === "C").parsed;
    parsedSteps = [
      {
        step_number: 1,
        figma_url: entry.figma_url,
        route_explicit: null,
        state_writes: null,
      },
    ];
  } else {
    parsedSteps = rawSteps
      .filter((s) => s.parsed !== null && s.form === "A")
      .map((s) => s.parsed);
  }

  // Too few steps? Only applies to Form A. Form C deliberately starts with one
  // step and expands during Phase 2a prototype-graph BFS.
  if (!auto_discovered && parsedSteps.length < 2) {
    failures.push({
      id: "F-FLOW-TOO-FEW-STEPS",
      severity: "error",
      detail: { count: parsedSteps.length },
    });
  }

  // Step-number contiguity with branch-group support.
  // Legal forms:
  //   [1, 2, 3]                                     — linear
  //   [1, 2, 3a, 3b, 4]                             — branch at step 3, merge at 4
  //   [1, 2a, 2b, 3]                                — branch at step 2
  // Rules:
  //   - Group consecutive parsed steps by step_number.
  //   - Outer numbers [1, 2, 3, …] must be strictly contiguous starting at 1.
  //   - Within a group:
  //       * 1 step  → no branch (null) is legal; a single `a` / `b` / … is
  //         F-FLOW-BRANCH-INCOMPLETE (lone branch is nonsense).
  //       * ≥2 steps → every member MUST carry a branch suffix and the
  //         suffixes MUST form [a, b, …, ] contiguously.
  // Form C synthesises a single step_number=1 entry — contiguity is trivially
  // satisfied, so skip the check.
  if (!auto_discovered && parsedSteps.length >= 1) {
    const groups = []; // Array<Array<parsed-step>>
    for (const s of parsedSteps) {
      const last = groups[groups.length - 1];
      if (last && last[0].step_number === s.step_number) {
        last.push(s);
      } else {
        groups.push([s]);
      }
    }

    const outerNumbers = groups.map((g) => g[0].step_number);
    const outerContiguous =
      outerNumbers.length > 0 &&
      outerNumbers.every((n, idx) => n === idx + 1);
    if (outerNumbers.length >= 2 && !outerContiguous) {
      failures.push({
        id: "F-FLOW-STEP-GAP",
        severity: "error",
        detail: { observed: outerNumbers },
      });
    }

    for (const group of groups) {
      if (group.length === 1) {
        if (group[0].branch !== null) {
          failures.push({
            id: "F-FLOW-BRANCH-INCOMPLETE",
            severity: "error",
            detail: {
              step_number: group[0].step_number,
              branch: group[0].branch,
              reason:
                "branch suffix requires at least two siblings (e.g. `Step 3a:` needs a `Step 3b:`).",
            },
          });
        }
      } else {
        const branches = group.map((s) => s.branch);
        const allUnlabelled = branches.every((b) => b === null);
        if (allUnlabelled) {
          // Bare duplicates (`Step 2:` twice without any suffix) — treat as a
          // classic step-number gap so existing prompts keep their meaning.
          failures.push({
            id: "F-FLOW-STEP-GAP",
            severity: "error",
            detail: { observed: parsedSteps.map((s) => s.step_number) },
          });
          break;
        }
        const allLabelled = branches.every(
          (b) => typeof b === "string" && /^[a-z]$/.test(b)
        );
        const expected = group.map((_, i) => String.fromCharCode(97 + i));
        const labelsContiguous =
          allLabelled && branches.every((b, i) => b === expected[i]);
        if (!labelsContiguous) {
          failures.push({
            id: "F-FLOW-BRANCH-INCOMPLETE",
            severity: "error",
            detail: {
              step_number: group[0].step_number,
              observed: branches,
              expected,
            },
          });
        }
      }
    }
  }

  // URL must carry a node-id.
  for (const s of parsedSteps) {
    const m = FIGMA_NODE_ID_RE.exec(s.figma_url);
    if (!m) {
      failures.push({
        id: "F-FLOW-FILE-URL",
        severity: "error",
        detail: { step_number: s.step_number, url: s.figma_url },
      });
    }
    if (s.mobile_url) {
      const mm = FIGMA_NODE_ID_RE.exec(s.mobile_url);
      if (!mm) {
        failures.push({
          id: "F-FLOW-FILE-URL",
          severity: "error",
          detail: {
            step_number: s.step_number,
            url: s.mobile_url,
            reason: "mobile: URL must also point at a specific frame (node-id required)",
          },
        });
      }
    }
  }

  // Resolve routes: explicit wins; else base_route + /step-<N>[<branch>]; else F-FLOW-NO-ROUTE.
  const resolvedSteps = [];
  const unrouted = [];
  for (const s of parsedSteps) {
    let route = s.route_explicit;
    let route_source = "explicit";
    if (!route) {
      if (base_route) {
        const suffix = s.branch ? `${s.step_number}${s.branch}` : `${s.step_number}`;
        route = `${trimTrailingSlash(base_route)}/step-${suffix}`;
        route_source = "derived";
      } else {
        unrouted.push(s.step_number);
        route = null;
        route_source = "missing";
      }
    }
    const nodeIdMatch = FIGMA_NODE_ID_RE.exec(s.figma_url);
    const node_id = nodeIdMatch ? decodeURIComponent(nodeIdMatch[1]).replace(/-/g, ":") : null;
    const fileKeyMatch = FIGMA_FILE_KEY_RE.exec(s.figma_url);
    const file_key = fileKeyMatch ? fileKeyMatch[1] : null;
    const resolved = {
      step_number: s.step_number,
      figma_url: s.figma_url,
      node_id,
      file_key,
      route,
      route_source,
    };
    if (s.branch) {
      resolved.branch = s.branch;
    }
    if (s.state_writes && s.state_writes.length > 0) {
      resolved.state_writes = s.state_writes;
    }
    if (s.mobile_url) {
      const mm = FIGMA_NODE_ID_RE.exec(s.mobile_url);
      const mobile_node_id = mm
        ? decodeURIComponent(mm[1]).replace(/-/g, ":")
        : null;
      const mfk = FIGMA_FILE_KEY_RE.exec(s.mobile_url);
      resolved.mobile_variant = {
        figma_url: s.mobile_url,
        node_id: mobile_node_id,
        file_key: mfk ? mfk[1] : null,
      };
    }
    resolvedSteps.push(resolved);
  }
  // F-FLOW-NO-ROUTE never fires in auto-discover mode: Phase 2a assigns routes
  // per frame once the prototype BFS enumerates the downstream pages.
  if (unrouted.length > 0 && !auto_discovered) {
    failures.push({
      id: "F-FLOW-NO-ROUTE",
      severity: "error",
      detail: { steps_without_route: unrouted },
    });
  }

  // Route-escapes-base check (warning only — inform tier).
  if (base_route) {
    const basePrefix = trimTrailingSlash(base_route) + "/";
    const escapees = [];
    for (const s of resolvedSteps) {
      if (s.route_source !== "explicit") continue;
      if (!s.route) continue;
      if (
        s.route !== base_route &&
        !s.route.startsWith(basePrefix)
      ) {
        escapees.push({ step_number: s.step_number, route: s.route });
      }
    }
    if (escapees.length > 0) {
      failures.push({
        id: "F-FLOW-ROUTE-ESCAPES-BASE",
        severity: "warning",
        detail: { base_route, escapees },
      });
    }
  }

  const flow_name = deriveFlowName(base_route);
  const hasError = failures.some((f) => f.severity === "error");

  // Cross-file dependencies (B-FLOW-CROSS-FILE): when steps span multiple
  // Figma file keys, surface the full set so Phase 2a can fetch metadata
  // per file and the Phase 6 report can highlight the dependency list.
  const fileKeys = [];
  for (const s of resolvedSteps) {
    if (s.file_key && !fileKeys.includes(s.file_key)) fileKeys.push(s.file_key);
  }
  const cross_file = fileKeys.length > 1;

  return {
    ok: !hasError,
    failures,
    base_route,
    flow_name,
    auto_discovered,
    cross_file,
    file_keys: fileKeys,
    steps: resolvedSteps,
  };
}

/**
 * Parse the trailing directive string of a Form A/B step line.
 * Accepts `route:` and `state:` directives in any order. Anything else
 * returns an F-FLOW-PARSE-AMBIGUOUS error payload.
 *
 * @param {string} trailing
 * @returns {{
 *   error: null | { id: string, detail: object },
 *   route: string | null,
 *   state_writes: Array<{name: string, type: 'string'|'number'|'boolean'}> | null
 * }}
 */
function parseStepDirectives(trailing) {
  if (!trailing) return { error: null, route: null, state_writes: null, mobile_url: null };

  let route = null;
  let stateRaw = null;
  let mobile_url = null;
  let remainder = trailing;

  const routeMatch = ROUTE_DIRECTIVE_RE.exec(remainder);
  if (routeMatch) {
    route = routeMatch[1];
    remainder = remainder.replace(routeMatch[0], "").trim();
  }

  const mobileMatch = MOBILE_DIRECTIVE_RE.exec(remainder);
  if (mobileMatch) {
    mobile_url = mobileMatch[1];
    remainder = remainder.replace(mobileMatch[0], "").trim();
  }

  const stateMatch = /\bstate:\s*(.*)$/i.exec(remainder);
  if (stateMatch) {
    stateRaw = stateMatch[1].trim();
    remainder = remainder.replace(stateMatch[0], "").trim();
  }

  if (remainder.length > 0) {
    return {
      error: {
        id: "F-FLOW-PARSE-AMBIGUOUS",
        detail: {
          reason: `unrecognised directive(s) after URL: "${remainder}"`,
        },
      },
      route,
      state_writes: null,
      mobile_url,
    };
  }

  let state_writes = null;
  if (stateRaw !== null) {
    const fields = stateRaw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const parsed = [];
    const unsupported = [];
    for (const field of fields) {
      const m = STATE_FIELD_RE.exec(field);
      if (!m) {
        unsupported.push(field);
        continue;
      }
      parsed.push({ name: m[1], type: m[2] });
    }
    if (unsupported.length > 0) {
      return {
        error: {
          id: "F-FLOW-STATE-TYPE-UNSUPPORTED",
          detail: { unsupported, supported_types: ["string", "number", "boolean"] },
        },
        route,
        state_writes: null,
      };
    }
    if (parsed.length === 0) {
      return {
        error: {
          id: "F-FLOW-PARSE-AMBIGUOUS",
          detail: { reason: "`state:` directive declared with no fields" },
        },
        route,
        state_writes: null,
      };
    }
    state_writes = parsed;
  }

  return { error: null, route, state_writes, mobile_url };
}

function extractBaseRoute(preamble) {
  const m = PREAMBLE_ROUTE_RE.exec(preamble);
  if (!m) return null;
  // Strip any trailing punctuation characters sometimes pasted with the route
  // (comma, period, semicolon, closing parenthesis, quotes). Internal / is kept.
  return m[1].replace(/[,.;:)\]"']+$/g, "");
}

function trimTrailingSlash(s) {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

function deriveFlowName(base_route) {
  if (!base_route) return null;
  const trimmed = trimTrailingSlash(base_route);
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

// ---------- CLI ----------

if (require.main === module) {
  const fs = require("fs");
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: parse-flow-prompt.js <prompt-file>");
    process.exit(2);
  }
  const text = fs.readFileSync(args[0], "utf8");
  const result = parseFlowPrompt(text);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

module.exports = { parseFlowPrompt };
