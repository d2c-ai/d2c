#!/usr/bin/env node

/**
 * parse-flow-prompt.js — Grammar parser for /d2c-build-flow invocations.
 *
 * Parses a natural-language prompt of the form:
 *
 *   /d2c-build-flow
 *   In these following pages we need to build the following flow,
 *   this is the route /onboarding, mode: stepper
 *   These are the steps:
 *   Step 1: <figma-frame-url>  title: "Email"
 *   Step 2: <figma-frame-url>  route: /signup/verify
 *
 * Supported `mode:` values (preamble-level token):
 *   auto     — default when the token is omitted; Phase 2a runs detect-mode.js
 *              to pick routes/stepper/hybrid from Figma signals.
 *   routes   — every step is its own URL (original behaviour).
 *   stepper  — all steps share one URL, body swaps in place.
 *   hybrid   — explicit `Stepper group "<name>" at <route>:` blocks intermix
 *              with bare `Step N:` lines.
 *
 * Hybrid / stepper group grammar (indentation-sensitive):
 *
 *   Stepper group "intake" at /signup:
 *     Step 1: <url>  title: "Name"
 *     Step 2: <url>  title: "Email"  validate: form
 *   Step: <url>  route: /signup/verify
 *
 * Per-step directives (Form A/B trailing tokens, in any order):
 *   route:    explicit URL for this step (routes mode)
 *   state:    comma-separated `name:type` pairs
 *   mobile:   mobile variant URL
 *   title:    human-readable stepper label (quoted or unquoted)
 *   optional: true|false — stepper Skip button
 *   validate: none|form   — Next gate
 *
 * Produces an object describing base_route, parsed steps, resolved routes,
 * optional stepper groups, and a list of failure_ids matching the names in
 * failure-modes.md:
 *
 *   F-FLOW-PARSE-AMBIGUOUS   step line did not match the grammar
 *   F-FLOW-STEP-GAP          step numbers are not contiguous from 1
 *   F-FLOW-FILE-URL          step URL missing node-id query parameter
 *   F-FLOW-NO-ROUTE          step has no route and no base_route
 *   F-FLOW-ROUTE-ESCAPES-BASE  explicit route is not under base_route (inform only)
 *   F-FLOW-TOO-FEW-STEPS     fewer than 2 step lines parsed
 *   F-FLOW-MODE-UNKNOWN      mode: value was not auto|routes|stepper|hybrid
 *   F-FLOW-STEPPER-GROUP-EMPTY  `Stepper group` block had <2 steps
 *   F-FLOW-STEPPER-GROUP-DUP    two groups declared the same name
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

// Mode token: can appear anywhere in the preamble (including trailing the
// route line, e.g. `this is the route /onboarding, mode: stepper`).
// Permissive match — any word after `mode:`. Validity is checked against
// ALLOWED_MODES below; unknown values emit F-FLOW-MODE-UNKNOWN.
const MODE_DIRECTIVE_RE = /\bmode:\s*([A-Za-z_][A-Za-z0-9_-]*)\b/i;

const ALLOWED_MODES = new Set(["auto", "routes", "stepper", "hybrid"]);

// `Stepper group "name" at /route:` block header. Double- or single-quoted name.
const STEPPER_GROUP_RE =
  /^\s*Stepper\s+group\s+["']([^"']+)["']\s+at\s+(\/\S*?):\s*$/i;

// Per-step `title:` directive. Supports quoted ("Email") and unquoted (single
// word) values. Quoted values may contain spaces.
const TITLE_DIRECTIVE_RE = /\btitle:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const OPTIONAL_DIRECTIVE_RE = /\boptional:\s*(true|false)\b/i;
const VALIDATE_DIRECTIVE_RE = /\bvalidate:\s*(none|form)\b/i;

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
 *   mode: 'auto' | 'routes' | 'stepper' | 'hybrid',
 *   mode_source: 'explicit' | 'default',
 *   steps: Array<{step_number: number, figma_url: string, node_id: string, route: string, route_source: 'explicit'|'derived'}>,
 *   stepper_groups: Array<{name: string, route: string, steps: Array<object>}>
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
      mode: "auto",
      mode_source: "default",
      steps: [],
      stepper_groups: [],
    };
  }

  const lines = promptText.split(/\r?\n/);
  const failures = [];

  // Find the earliest anchor line that marks the start of the step section.
  // That's either a step candidate OR a `Stepper group` block header, whichever
  // comes first. Everything above is preamble (route, mode, prose).
  let firstAnchorIdx = lines.findIndex(
    (l) => STEP_CANDIDATE_RE.test(l) || STEPPER_GROUP_RE.test(l)
  );
  if (firstAnchorIdx === -1) firstAnchorIdx = lines.length;

  const preamble = lines.slice(0, firstAnchorIdx).join("\n");
  const base_route = extractBaseRoute(preamble);

  // Mode: explicit `mode:` token in the preamble wins; default is 'auto'. Any
  // other value is flagged F-FLOW-MODE-UNKNOWN so typos don't silently degrade
  // to auto-detection.
  const modeMatch = MODE_DIRECTIVE_RE.exec(preamble);
  let mode = "auto";
  let mode_source = "default";
  if (modeMatch) {
    const declared = modeMatch[1].toLowerCase();
    if (ALLOWED_MODES.has(declared)) {
      mode = declared;
      mode_source = "explicit";
    } else {
      failures.push({
        id: "F-FLOW-MODE-UNKNOWN",
        severity: "error",
        detail: { observed: modeMatch[1], allowed: [...ALLOWED_MODES] },
      });
    }
  }
  // Reject any `mode:` directive that appeared OUTSIDE the preamble (i.e. in
  // the step section). The parser grammar only recognises mode as a
  // preamble-level token; scattering it between Step lines is almost always
  // a typo and would be silently ignored otherwise.
  if (firstAnchorIdx < lines.length) {
    const stepSection = lines.slice(firstAnchorIdx).join("\n");
    // Strip trailing directives from Step lines so a `mode:` on a step line
    // (which would be a typo) still surfaces — but accept `title:`, `optional:`,
    // `validate:`, `route:`, `state:`, `mobile:` within trailing directives as
    // scoped to that step.
    if (!modeMatch && MODE_DIRECTIVE_RE.test(stepSection)) {
      failures.push({
        id: "F-FLOW-MODE-UNKNOWN",
        severity: "error",
        detail: {
          reason:
            "`mode:` appeared after the step section; declare it in the preamble (e.g. `route /onboarding, mode: stepper`)",
        },
      });
    }
  }

  // Collect step candidates and parse them strictly.
  // Each element: { lineIdx, raw, match, parsed: {step_number, figma_url, route_explicit} | null, form: 'A' | 'C' | null, group_name: string | null }
  const rawSteps = [];
  // Track the current Stepper group: steps in subsequent indented lines belong
  // to it until we hit another Stepper group header OR an unindented step OR a
  // blank line followed by an unindented step. We use indentation as the
  // grouping signal: lines indented more than the Stepper group header are
  // in-group.
  const stepperGroupsDecl = []; // { name, route, startLineIdx, headerIndent }
  const seenGroupNames = new Set();
  let currentGroup = null;

  for (let i = firstAnchorIdx; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = STEPPER_GROUP_RE.exec(line);
    if (headerMatch) {
      const name = headerMatch[1];
      const route = headerMatch[2];
      if (seenGroupNames.has(name)) {
        failures.push({
          id: "F-FLOW-STEPPER-GROUP-DUP",
          severity: "error",
          detail: { name, line_number: i + 1 },
        });
      }
      seenGroupNames.add(name);
      const headerIndent = line.match(/^\s*/)[0].length;
      currentGroup = { name, route, headerIndent, stepCount: 0 };
      stepperGroupsDecl.push({
        name,
        route,
        startLineIdx: i,
        headerIndent,
      });
      continue;
    }

    if (!STEP_CANDIDATE_RE.test(line)) {
      // If we're in a stepper group and hit a non-step, non-empty, non-indented
      // line, that closes the group. Blank lines are permissive (keep the
      // group open).
      if (currentGroup !== null && line.trim() !== "") {
        const thisIndent = line.match(/^\s*/)[0].length;
        if (thisIndent <= currentGroup.headerIndent) {
          currentGroup = null;
        }
      }
      continue;
    }

    // Step line: check if it belongs to the current stepper group by indent.
    let assignedGroup = null;
    if (currentGroup !== null) {
      const thisIndent = line.match(/^\s*/)[0].length;
      if (thisIndent > currentGroup.headerIndent) {
        assignedGroup = currentGroup.name;
        currentGroup.stepCount += 1;
      } else {
        // Less-or-equal indent than header → leaves the group.
        currentGroup = null;
      }
    }

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
        rawSteps.push({
          lineIdx: i,
          raw: line,
          match: strict,
          parsed: null,
          form: "A",
          group_name: assignedGroup,
        });
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
          title: directives.title || null,
          optional: directives.optional,
          validate: directives.validate || null,
        },
        form: "A",
        group_name: assignedGroup,
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
        group_name: assignedGroup,
      });
      continue;
    }

    failures.push({
      id: "F-FLOW-PARSE-AMBIGUOUS",
      severity: "error",
      detail: { line_number: i + 1, line },
    });
    rawSteps.push({
      lineIdx: i,
      raw: line,
      match: null,
      parsed: null,
      form: null,
      group_name: assignedGroup,
    });
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
  // Stepper-group-scoped steps are partitioned out of the top-level parsedSteps
  // array and tracked separately for per-group contiguity validation and for
  // emission in the returned `stepper_groups[]`.
  let parsedSteps;
  const groupedRawByName = {}; // { name: Array<{parsed, lineIdx}> }
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
    parsedSteps = [];
    for (const s of rawSteps) {
      if (s.parsed === null || s.form !== "A") continue;
      if (s.group_name) {
        if (!groupedRawByName[s.group_name]) groupedRawByName[s.group_name] = [];
        groupedRawByName[s.group_name].push({ parsed: s.parsed, lineIdx: s.lineIdx });
      } else {
        parsedSteps.push(s.parsed);
      }
    }
  }

  // Per-group contiguity check: step_number inside a group must be 1-based
  // contiguous. Branching inside a stepper group is explicitly not supported
  // in v1 (schema.stepper_group.branches[] is a forward-compat placeholder).
  for (const [groupName, items] of Object.entries(groupedRawByName)) {
    if (items.length < 2) {
      failures.push({
        id: "F-FLOW-STEPPER-GROUP-EMPTY",
        severity: "error",
        detail: {
          name: groupName,
          count: items.length,
          reason: "`Stepper group` blocks must contain at least 2 Step lines",
        },
      });
    }
    items.forEach((it, idx) => {
      const expected = idx + 1;
      if (it.parsed.step_number !== expected) {
        failures.push({
          id: "F-FLOW-STEP-GAP",
          severity: "error",
          detail: {
            group: groupName,
            observed: items.map((x) => x.parsed.step_number),
            expected_prefix: items.map((_, i) => i + 1),
            reason:
              "Step numbers inside a Stepper group must be 1-based contiguous",
          },
        });
      }
      if (it.parsed.branch) {
        failures.push({
          id: "F-FLOW-STEPPER-GROUP-EMPTY",
          severity: "error",
          detail: {
            group: groupName,
            step_number: it.parsed.step_number,
            branch: it.parsed.branch,
            reason:
              "Stepper groups do not support branching in v1 (step " +
              it.parsed.step_number +
              it.parsed.branch +
              ")",
          },
        });
      }
    });
  }

  // Mode-vs-declaration consistency:
  //   - mode=routes forbids `Stepper group` blocks (user asked for route-per-step).
  //   - mode=hybrid requires at least one `Stepper group` block.
  //   - mode=stepper is allowed with OR without explicit groups; when no groups
  //     are declared, Phase 2a synthesises one group containing all top-level
  //     steps (this keeps the simple "all-stepper" prompt short).
  const declaredGroupCount = Object.keys(groupedRawByName).length;
  if (mode === "routes" && declaredGroupCount > 0) {
    failures.push({
      id: "F-FLOW-MODE-UNKNOWN",
      severity: "error",
      detail: {
        reason:
          "`mode: routes` forbids `Stepper group` blocks — use `mode: hybrid` to mix both, or `mode: stepper`/omit for all-stepper.",
      },
    });
  }
  if (mode === "hybrid" && declaredGroupCount === 0) {
    failures.push({
      id: "F-FLOW-MODE-UNKNOWN",
      severity: "error",
      detail: {
        reason:
          "`mode: hybrid` requires at least one `Stepper group \"<name>\" at <route>:` block in the prompt.",
      },
    });
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

  // Resolve stepper-group steps. Each group's steps carry explicit titles,
  // optional/validate flags, and group-scoped routes (all steps in a group
  // share the group's `route`).
  const resolved_stepper_groups = [];
  for (const { name, route: groupRoute, startLineIdx } of stepperGroupsDecl) {
    const items = groupedRawByName[name] || [];
    if (items.length === 0) continue;
    const steps = [];
    for (let i = 0; i < items.length; i++) {
      const p = items[i].parsed;
      const nodeIdMatch = FIGMA_NODE_ID_RE.exec(p.figma_url);
      const node_id = nodeIdMatch
        ? decodeURIComponent(nodeIdMatch[1]).replace(/-/g, ":")
        : null;
      if (!node_id) {
        failures.push({
          id: "F-FLOW-FILE-URL",
          severity: "error",
          detail: {
            step_number: p.step_number,
            url: p.figma_url,
            group: name,
          },
        });
      }
      const fileKeyMatch = FIGMA_FILE_KEY_RE.exec(p.figma_url);
      steps.push({
        order: i + 1,
        step_number: p.step_number,
        figma_url: p.figma_url,
        node_id,
        file_key: fileKeyMatch ? fileKeyMatch[1] : null,
        title: p.title || null,
        optional: p.optional === true,
        validate: p.validate || "none",
        state_writes:
          p.state_writes && p.state_writes.length > 0 ? p.state_writes : null,
      });
    }
    resolved_stepper_groups.push({
      name: toPascalCase(name),
      raw_name: name,
      route: groupRoute,
      header_line: startLineIdx + 1,
      validation_enabled: steps.some((s) => s.validate === "form"),
      steps,
    });
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
  for (const g of resolved_stepper_groups) {
    for (const s of g.steps) {
      if (s.file_key && !fileKeys.includes(s.file_key)) fileKeys.push(s.file_key);
    }
  }
  const cross_file = fileKeys.length > 1;

  return {
    ok: !hasError,
    failures,
    base_route,
    flow_name,
    auto_discovered,
    mode,
    mode_source,
    cross_file,
    file_keys: fileKeys,
    steps: resolvedSteps,
    stepper_groups: resolved_stepper_groups,
  };
}

function toPascalCase(raw) {
  if (!raw) return "Stepper";
  return (
    String(raw)
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("") || "Stepper"
  );
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
  const empty = {
    error: null,
    route: null,
    state_writes: null,
    mobile_url: null,
    title: null,
    optional: false,
    validate: null,
  };
  if (!trailing) return empty;

  let route = null;
  let stateRaw = null;
  let mobile_url = null;
  let title = null;
  let optional = false;
  let validate = null;
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

  const titleMatch = TITLE_DIRECTIVE_RE.exec(remainder);
  if (titleMatch) {
    title = titleMatch[1] || titleMatch[2] || titleMatch[3] || null;
    remainder = remainder.replace(titleMatch[0], "").trim();
  }

  const optionalMatch = OPTIONAL_DIRECTIVE_RE.exec(remainder);
  if (optionalMatch) {
    optional = optionalMatch[1].toLowerCase() === "true";
    remainder = remainder.replace(optionalMatch[0], "").trim();
  }

  const validateMatch = VALIDATE_DIRECTIVE_RE.exec(remainder);
  if (validateMatch) {
    validate = validateMatch[1].toLowerCase();
    remainder = remainder.replace(validateMatch[0], "").trim();
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
      title,
      optional,
      validate,
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
        mobile_url,
        title,
        optional,
        validate,
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
        mobile_url,
        title,
        optional,
        validate,
      };
    }
    state_writes = parsed;
  }

  return {
    error: null,
    route,
    state_writes,
    mobile_url,
    title,
    optional,
    validate,
  };
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
