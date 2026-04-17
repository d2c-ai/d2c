#!/usr/bin/env node

/**
 * validate-flow-graph.js — Validator for the flow-graph IR artifact
 * emitted by d2c-build-flow Phase 2a.
 *
 * Usage:
 *   node validate-flow-graph.js <flow-graph-path>
 *
 * Two-layer validation (mirrors skills/d2c-build/scripts/validate-ir.js):
 *
 *   Layer 1 (structural) — JSON Schema check against
 *     ../schemas/flow-graph.schema.json using a small inlined validator
 *     (no external deps; matches the pixeldiff.js / validate-ir.js pattern).
 *
 *   Layer 2 (semantic) — cross-references within flow-graph.json:
 *     - pages[].step_number is contiguous starting at 1 and equals order
 *     - pages[].node_id values are unique
 *     - entry_node_id equals pages[0].node_id
 *     - edges[] length equals pages.length - 1 and forms a linear chain
 *       where edges[i].from_node_id == pages[i].node_id and
 *             edges[i].to_node_id   == pages[i+1].node_id
 *     - layouts[].applies_to every entry appears in pages[].node_id
 *     - pages[].layout (when non-null) references a layouts[].name
 *     - shared_state[].pages entries appear in pages[].node_id
 *     - not_supported_detected[].node_id references appear in pages[].node_id
 *       (warning only — overlay detections may legitimately reference child
 *       nodes within a page, so this check is lenient and skipped if the id
 *       does not match)
 *
 * Exit codes:
 *   0 — ok
 *   1 — fail
 *   2 — CLI misuse
 *
 * Stdout format (one line per key, machine-readable):
 *
 *   validate-flow-graph: ok | fail
 *   pages: <N>
 *   edges: <N>
 *   layouts: <N>
 *   shared-state: <N>
 *   errors: <N>
 *   error: <path> — <message>
 *   ...
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_PATH = path.join(__dirname, "..", "schemas", "flow-graph.schema.json");
const MANIFEST_SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "schemas",
  "flow-manifest.schema.json"
);

// ---------- Layer 1: inlined minimal JSON Schema validator ----------

function validateSchema(schema, data, fieldPath = "", rootSchema = null) {
  const errors = [];
  const root = rootSchema || schema;

  if (schema.$ref) {
    const refKey = schema.$ref.replace(/^#\/definitions\//, "");
    const resolved = (root.definitions || {})[refKey];
    if (!resolved) {
      errors.push(`${fieldPath || "$"}: unresolved $ref ${schema.$ref}`);
      return errors;
    }
    return validateSchema(resolved, data, fieldPath, root);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = jsonType(data);
    const matchesAny = types.some((t) => matchesType(t, data, actualType));
    if (!matchesAny) {
      errors.push(
        `${fieldPath || "$"}: expected ${types.join(" or ")}, got ${actualType}`
      );
      return errors;
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => deepEqual(v, data))) {
      errors.push(
        `${fieldPath || "$"}: value ${JSON.stringify(data)} not in enum [${schema.enum
          .map((v) => JSON.stringify(v))
          .join(", ")}]`
      );
    }
  }

  if (schema.minimum !== undefined && typeof data === "number" && data < schema.minimum) {
    errors.push(`${fieldPath || "$"}: value ${data} is less than minimum ${schema.minimum}`);
  }

  if (schema.minItems !== undefined && Array.isArray(data) && data.length < schema.minItems) {
    errors.push(`${fieldPath || "$"}: array has ${data.length} items, minimum is ${schema.minItems}`);
  }

  if (schema.minLength !== undefined && typeof data === "string" && data.length < schema.minLength) {
    errors.push(`${fieldPath || "$"}: string length ${data.length} is less than minLength ${schema.minLength}`);
  }

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

function validateSemantic(graph) {
  const errors = [];
  const pages = graph.pages || [];
  const nodeIds = pages.map((p) => p.node_id);
  const nodeIdSet = new Set(nodeIds);

  // step_number + order contiguity and match. Multi-branch flows
  // (B-FLOW-MULTI-BRANCH) allow consecutive pages to share a step_number when
  // each carries a distinct `branch` suffix (`a`, `b`, …); the outer
  // step_number sequence must still be contiguous starting at 1.
  const outerNumbers = [];
  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    if (!prev || prev.step_number !== p.step_number) {
      outerNumbers.push(p.step_number);
    }
    if (p.order !== p.step_number) {
      errors.push(
        `pages[${i}].order — must equal step_number (got order=${p.order}, step_number=${p.step_number})`
      );
    }
  });
  outerNumbers.forEach((n, i) => {
    const expected = i + 1;
    if (n !== expected) {
      errors.push(
        `pages[*].step_number — outer step sequence expected ${expected} at position ${i + 1}, got ${n}`
      );
    }
  });

  // Branch-group consistency: when two or more consecutive pages share a
  // step_number, every member MUST carry a non-null branch letter and the
  // letters MUST form [a, b, …] contiguously.
  for (let i = 0; i < pages.length; ) {
    const step = pages[i].step_number;
    let j = i;
    while (j < pages.length && pages[j].step_number === step) j++;
    const group = pages.slice(i, j);
    if (group.length > 1) {
      const branches = group.map((p) => p.branch ?? null);
      const expected = group.map((_, k) => String.fromCharCode(97 + k));
      const ok = branches.every((b, k) => b === expected[k]);
      if (!ok) {
        errors.push(
          `pages[*].branch — step ${step} has ${group.length} siblings with branches ${JSON.stringify(branches)}; expected ${JSON.stringify(expected)}`
        );
      }
    } else if (group[0].branch !== null && group[0].branch !== undefined) {
      errors.push(
        `pages[${i}].branch — step ${step} has only one page but declares branch "${group[0].branch}"`
      );
    }
    i = j;
  }

  // Unique node_ids
  const seen = new Set();
  pages.forEach((p, i) => {
    if (seen.has(p.node_id)) {
      errors.push(`pages[${i}].node_id — duplicate node_id "${p.node_id}"`);
    }
    seen.add(p.node_id);
  });

  // entry_node_id equals first page
  if (pages.length > 0 && graph.entry_node_id !== pages[0].node_id) {
    errors.push(
      `entry_node_id — expected "${pages[0].node_id}" (pages[0].node_id), got "${graph.entry_node_id}"`
    );
  }

  // Edges: node-id membership + branch wiring. Two modes:
  //   - Linear flow (no page has a branch letter): expect one edge per
  //     consecutive page pair (pages.length - 1) forming a chain. This is the
  //     common case; keep the stricter check so typos surface as clear errors.
  //   - Multi-branch flow (at least one page has a branch letter): drop the
  //     "exactly pages.length - 1 edges in order" rule. Instead enforce:
  //       * Every edge's from/to node_id appears in pages[].node_id.
  //       * Every page is reachable from entry_node_id via a BFS over edges.
  //       * For any page with out-degree > 1, every outgoing edge has a
  //         non-null source_component_node_id — silent branches are not
  //         expressible in generated code.
  const edges = graph.edges || [];
  const isBranching = pages.some((p) => p.branch);
  const hasOverlays = pages.some((p) => (p.page_type ?? "page") === "overlay");
  const hasSteppers = pages.some((p) => (p.page_type ?? "page") === "stepper_group");
  const hasLoops = edges.some((e) => e.is_loop === true);
  const hasConditions = edges.some((e) => e.condition);
  const hasNonNavigateActions = edges.some(
    (e) => e.action && e.action !== "navigate"
  );
  const isNonLinear =
    isBranching ||
    hasOverlays ||
    hasSteppers ||
    hasLoops ||
    hasConditions ||
    hasNonNavigateActions;

  if (!isNonLinear) {
    // Linear-only flows still carry the strict "one edge per consecutive pair
    // in declared order" rule — it's the cheapest way to catch typos.
    const expectedEdgeCount = Math.max(pages.length - 1, 0);
    if (edges.length !== expectedEdgeCount) {
      errors.push(
        `edges — expected ${expectedEdgeCount} edges for ${pages.length} pages, got ${edges.length}`
      );
    }
    edges.forEach((e, i) => {
      const from = pages[i] ? pages[i].node_id : null;
      const to = pages[i + 1] ? pages[i + 1].node_id : null;
      if (from && e.from_node_id !== from) {
        errors.push(
          `edges[${i}].from_node_id — expected "${from}" (pages[${i}].node_id), got "${e.from_node_id}"`
        );
      }
      if (to && e.to_node_id !== to) {
        errors.push(
          `edges[${i}].to_node_id — expected "${to}" (pages[${i + 1}].node_id), got "${e.to_node_id}"`
        );
      }
    });
  }

  // Always validate node-id membership on every edge.
  edges.forEach((e, i) => {
    if (!nodeIdSet.has(e.from_node_id)) {
      errors.push(
        `edges[${i}].from_node_id — "${e.from_node_id}" not present in pages[].node_id`
      );
    }
    if (!nodeIdSet.has(e.to_node_id)) {
      errors.push(
        `edges[${i}].to_node_id — "${e.to_node_id}" not present in pages[].node_id`
      );
    }
  });

  // Branching flows: reachability + out-degree wiring.
  if (isBranching && pages.length > 0 && graph.entry_node_id) {
    const adjacency = new Map();
    edges.forEach((e) => {
      if (!adjacency.has(e.from_node_id)) adjacency.set(e.from_node_id, []);
      adjacency.get(e.from_node_id).push(e);
    });

    // BFS from entry to confirm every page is reachable.
    const visited = new Set();
    const queue = [graph.entry_node_id];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const edge of adjacency.get(cur) || []) {
        if (!visited.has(edge.to_node_id)) queue.push(edge.to_node_id);
      }
    }
    pages.forEach((p, i) => {
      if (!visited.has(p.node_id)) {
        errors.push(
          `pages[${i}].node_id — "${p.node_id}" is not reachable from entry_node_id "${graph.entry_node_id}" via edges[]`
        );
      }
    });

    // Out-degree > 1 → every outgoing edge must be wired to a Figma component.
    for (const [fromId, outgoing] of adjacency.entries()) {
      if (outgoing.length <= 1) continue;
      outgoing.forEach((e) => {
        const edgeIndex = edges.indexOf(e);
        if (
          e.source_component_node_id === null ||
          e.source_component_node_id === undefined
        ) {
          errors.push(
            `edges[${edgeIndex}].source_component_node_id — branch page "${fromId}" has out-degree ${outgoing.length}; every outgoing edge must be wired to an identifiable Figma component`
          );
        }
      });
    }
  }

  // layouts[].applies_to references and pages[].layout back-references
  const layoutNames = new Set();
  (graph.layouts || []).forEach((l, i) => {
    if (layoutNames.has(l.name)) {
      errors.push(`layouts[${i}].name — duplicate layout name "${l.name}"`);
    }
    layoutNames.add(l.name);
    (l.applies_to || []).forEach((nodeId, j) => {
      if (!nodeIdSet.has(nodeId)) {
        errors.push(
          `layouts[${i}].applies_to[${j}] — "${nodeId}" not present in pages[].node_id`
        );
      }
    });
  });
  pages.forEach((p, i) => {
    if (p.layout !== null && p.layout !== undefined && !layoutNames.has(p.layout)) {
      errors.push(
        `pages[${i}].layout — "${p.layout}" not present in layouts[].name`
      );
    }
  });

  // shared_state[].pages references
  (graph.shared_state || []).forEach((s, i) => {
    (s.pages || []).forEach((nodeId, j) => {
      if (!nodeIdSet.has(nodeId)) {
        errors.push(
          `shared_state[${i}].pages[${j}] — "${nodeId}" not present in pages[].node_id`
        );
      }
    });
  });

  // When shared_state is declared and at least one page in the flow has a
  // state_writes directive, every shared_state slice should have at least one
  // writer among its listed pages. Missing writers mean the provider is
  // generated but never filled — callers can still read an empty object, so
  // this stays a warning rather than an error.
  const hasAnyStateWrites = pages.some(
    (p) => Array.isArray(p.state_writes) && p.state_writes.length > 0
  );
  if (hasAnyStateWrites) {
    (graph.shared_state || []).forEach((s, i) => {
      const writers = (s.pages || []).filter((nodeId) => {
        const page = pages.find((p) => p.node_id === nodeId);
        return page && Array.isArray(page.state_writes) && page.state_writes.length > 0;
      });
      if (writers.length === 0) {
        errors.push(
          `shared_state[${i}] — no page among ${JSON.stringify(s.pages)} declares a 'state:' directive; provider will be generated empty`
        );
      }
    });
  }

  // mask_regions[] references must point at real pages.
  (graph.mask_regions || []).forEach((m, i) => {
    if (!nodeIdSet.has(m.page_node_id)) {
      errors.push(
        `mask_regions[${i}].page_node_id — "${m.page_node_id}" not present in pages[].node_id`
      );
    }
  });

  // Overlay invariants (B-FLOW-OVERLAY-SUPPORT):
  //   - page_type='overlay' MUST have an overlay_parent in pages[].node_id
  //   - the overlay's parent MUST be page_type='page' (no overlay-of-overlay)
  //   - page_type='page' MUST NOT carry an overlay_parent
  pages.forEach((p, i) => {
    const kind = p.page_type ?? "page";
    if (kind === "overlay") {
      if (!p.overlay_parent) {
        errors.push(
          `pages[${i}].overlay_parent — overlay pages must reference a parent page via overlay_parent`
        );
      } else if (!nodeIdSet.has(p.overlay_parent)) {
        errors.push(
          `pages[${i}].overlay_parent — "${p.overlay_parent}" not present in pages[].node_id`
        );
      } else {
        const parent = pages.find((q) => q.node_id === p.overlay_parent);
        if (parent && (parent.page_type ?? "page") !== "page") {
          errors.push(
            `pages[${i}].overlay_parent — parent "${p.overlay_parent}" must be page_type='page' (no overlay-of-overlay)`
          );
        }
      }
    } else if (p.overlay_parent) {
      errors.push(
        `pages[${i}].overlay_parent — only page_type='overlay' pages may set overlay_parent (got page_type='${kind}')`
      );
    }
  });

  // Edge action invariants:
  //   - 'open-overlay' edges MUST target a page_type='overlay' page
  //   - 'close-overlay' edges MUST originate from a page_type='overlay' page
  //     (close edge is how the overlay dismisses itself)
  const pagesByNode = new Map(pages.map((p) => [p.node_id, p]));
  edges.forEach((e, i) => {
    const action = e.action ?? "navigate";
    if (action === "open-overlay") {
      const target = pagesByNode.get(e.to_node_id);
      if (target && (target.page_type ?? "page") !== "overlay") {
        errors.push(
          `edges[${i}].action — 'open-overlay' must target a page_type='overlay' page, got "${target.page_type ?? "page"}"`
        );
      }
    } else if (action === "close-overlay") {
      const source = pagesByNode.get(e.from_node_id);
      if (source && (source.page_type ?? "page") !== "overlay") {
        errors.push(
          `edges[${i}].action — 'close-overlay' must originate from a page_type='overlay' page, got "${source.page_type ?? "page"}"`
        );
      }
    }
  });

  // Conditional edges: condition.field MUST match a shared-state key or a
  // state_writes declaration somewhere in the flow — otherwise it's a typo.
  const declaredStateKeys = new Set();
  (graph.shared_state || []).forEach((s) => {
    // Unlisted fields (Record<string, unknown>) are fine; only flag when a
    // typed shape exists via state_writes and the field isn't in it.
  });
  pages.forEach((p) => {
    (p.state_writes || []).forEach((sw) => declaredStateKeys.add(sw.name));
  });
  edges.forEach((e, i) => {
    if (!e.condition) return;
    if (
      declaredStateKeys.size > 0 &&
      !declaredStateKeys.has(e.condition.field)
    ) {
      errors.push(
        `edges[${i}].condition.field — "${e.condition.field}" is not written by any page's state: directive; likely a typo`
      );
    }
    if (e.condition.kind === "state-equals" && e.condition.value === undefined) {
      errors.push(
        `edges[${i}].condition.value — 'state-equals' requires a value`
      );
    }
  });

  // Mode + stepper_groups invariants.
  const mode = graph.mode;
  const stepperGroups = graph.stepper_groups || [];

  // Routes/hybrid flows must have at least 2 pages. This replaces the old
  // pages.minItems=2 schema rule, which had to be relaxed to 1 so pure-stepper
  // flows (a single virtual page_type='stepper_group' entry) can validate.
  if ((mode === "routes" || mode === "hybrid") && pages.length < 2) {
    errors.push(
      `pages — mode '${mode}' requires at least 2 pages (minimum is 2), got ${pages.length}`
    );
  }

  if (mode === "routes" && stepperGroups.length > 0) {
    errors.push(
      `mode — 'routes' forbids stepper_groups[], but found ${stepperGroups.length} group(s)`
    );
  }
  if (mode === "stepper" && stepperGroups.length !== 1) {
    errors.push(
      `mode — 'stepper' requires exactly one stepper_groups[] entry, found ${stepperGroups.length}`
    );
  }
  if (mode === "hybrid" && stepperGroups.length < 1) {
    errors.push(
      `mode — 'hybrid' requires at least one stepper_groups[] entry, found 0`
    );
  }
  if (mode === "hybrid") {
    const standalonePages = pages.filter(
      (p) => (p.page_type ?? "page") === "page"
    );
    if (standalonePages.length < 1) {
      errors.push(
        `mode — 'hybrid' requires at least one page_type='page' alongside stepper groups; found only stepper virtual pages`
      );
    }
  }

  // mode_source + mode_confidence consistency.
  if (graph.mode_source === "auto-detected") {
    if (typeof graph.mode_confidence !== "number") {
      errors.push(
        `mode_confidence — required number when mode_source='auto-detected'`
      );
    } else if (graph.mode_confidence < 0.55) {
      errors.push(
        `mode_confidence — ${graph.mode_confidence} below abort threshold 0.55; detection should have aborted before this IR was written`
      );
    }
  }

  // stepper_groups[] invariants.
  const stepperGroupNames = new Set();
  const stepperGroupNodeIds = new Set();
  const standaloneRoutes = new Set(
    pages
      .filter((p) => (p.page_type ?? "page") === "page" && p.route)
      .map((p) => p.route)
  );
  stepperGroups.forEach((g, i) => {
    if (!g || typeof g !== "object") return;
    if (stepperGroupNames.has(g.name)) {
      errors.push(
        `stepper_groups[${i}].name — duplicate name "${g.name}"`
      );
    }
    stepperGroupNames.add(g.name);

    if (g.group_node_id) {
      if (stepperGroupNodeIds.has(g.group_node_id)) {
        errors.push(
          `stepper_groups[${i}].group_node_id — duplicate id "${g.group_node_id}"`
        );
      }
      stepperGroupNodeIds.add(g.group_node_id);
      if (!nodeIdSet.has(g.group_node_id)) {
        errors.push(
          `stepper_groups[${i}].group_node_id — "${g.group_node_id}" not present in pages[].node_id`
        );
      } else {
        const virtualPage = pages.find((p) => p.node_id === g.group_node_id);
        if (virtualPage && (virtualPage.page_type ?? "page") !== "stepper_group") {
          errors.push(
            `stepper_groups[${i}].group_node_id — page "${g.group_node_id}" must be page_type='stepper_group', got "${virtualPage.page_type ?? "page"}"`
          );
        }
        if (virtualPage && virtualPage.route !== g.route) {
          errors.push(
            `stepper_groups[${i}].route — "${g.route}" must equal pages[].route for the virtual page "${g.group_node_id}" (got "${virtualPage.route}")`
          );
        }
        if (
          virtualPage &&
          virtualPage.stepper_group_ref &&
          virtualPage.stepper_group_ref !== g.name
        ) {
          errors.push(
            `pages[*].stepper_group_ref — virtual page for "${g.group_node_id}" references "${virtualPage.stepper_group_ref}" but stepper_groups[${i}].name is "${g.name}"`
          );
        }
      }
    }

    if (g.route && standaloneRoutes.has(g.route)) {
      errors.push(
        `stepper_groups[${i}].route — "${g.route}" collides with a standalone page route`
      );
    }

    // Steps: contiguous, 1-based, unique node_ids across all groups + pages.
    const steps = Array.isArray(g.steps) ? g.steps : [];
    steps.forEach((s, j) => {
      if (s.order !== j + 1) {
        errors.push(
          `stepper_groups[${i}].steps[${j}].order — expected ${j + 1}, got ${s.order}`
        );
      }
      if (nodeIdSet.has(s.node_id)) {
        errors.push(
          `stepper_groups[${i}].steps[${j}].node_id — "${s.node_id}" collides with pages[].node_id (stepper step frames must be distinct from page node ids)`
        );
      }
      if (s.validate && s.validate !== "none" && s.validate !== "form") {
        errors.push(
          `stepper_groups[${i}].steps[${j}].validate — "${s.validate}" not in [none, form]`
        );
      }
    });

    // Step node_ids unique within the group.
    const seenStepIds = new Set();
    steps.forEach((s, j) => {
      if (seenStepIds.has(s.node_id)) {
        errors.push(
          `stepper_groups[${i}].steps[${j}].node_id — duplicate "${s.node_id}" within the group`
        );
      }
      seenStepIds.add(s.node_id);
    });

    // validation_enabled must reflect actual step validate values.
    const declaredValidation = steps.some(
      (s) => s.validate && s.validate !== "none"
    );
    if (g.validation_enabled !== declaredValidation) {
      errors.push(
        `stepper_groups[${i}].validation_enabled — expected ${declaredValidation} (derived from steps[].validate), got ${g.validation_enabled}`
      );
    }

    // v1: branches[] must be empty, transition must be "none".
    if (Array.isArray(g.branches) && g.branches.length > 0) {
      errors.push(
        `stepper_groups[${i}].branches — v1 does not support branching inside a stepper group (got ${g.branches.length} branch(es))`
      );
    }
    if (g.transition && g.transition !== "none") {
      errors.push(
        `stepper_groups[${i}].transition — v1 only supports 'none' (got "${g.transition}")`
      );
    }
  });

  // Every stepper_group virtual page must back exactly one stepper_groups[] entry.
  pages.forEach((p, i) => {
    if ((p.page_type ?? "page") !== "stepper_group") return;
    if (!p.stepper_group_ref) {
      errors.push(
        `pages[${i}].stepper_group_ref — page_type='stepper_group' requires a stepper_group_ref name`
      );
      return;
    }
    if (!stepperGroupNames.has(p.stepper_group_ref)) {
      errors.push(
        `pages[${i}].stepper_group_ref — "${p.stepper_group_ref}" not present in stepper_groups[].name`
      );
    }
  });

  // Auto-discovered flows (Form C) were built by BFS over Figma prototype
  // edges, so every edge is backed by a real Figma connection. Enforce that:
  //   - inferred === false (we didn't guess step order from a user list)
  //   - source_component_node_id !== null (we know which component triggers it)
  if (graph.auto_discovered === true) {
    edges.forEach((e, i) => {
      if (e.inferred !== false) {
        errors.push(
          `edges[${i}].inferred — auto_discovered flow requires inferred=false (every edge is a wired Figma prototype connection)`
        );
      }
      if (e.source_component_node_id === null || e.source_component_node_id === undefined) {
        errors.push(
          `edges[${i}].source_component_node_id — auto_discovered flow requires a non-null component id (the prototype connection's source)`
        );
      }
    });
  }

  return errors;
}

// ---------- Manifest verification ----------

/**
 * Compute the tokens-file hash per the flow-manifest contract.
 * Matches skills/d2c-build/scripts/validate-ir.js::computeTokensHash:
 *   - split_files=false → SHA-256 of raw design-tokens.json bytes
 *   - split_files=true  → SHA-256 of core|colors|components|conventions
 *                         split files concatenated (raw bytes), fixed order.
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

/**
 * Verify a flow-manifest.json against the current tokens file. Returns an
 * array of error strings; empty array means ok.
 */
function verifyManifest(manifestPath, tokensPath) {
  const errors = [];

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, "utf8"));
  } catch (e) {
    errors.push(`flow-manifest.json:schema — could not read ${MANIFEST_SCHEMA_PATH}: ${e.message}`);
    return errors;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    errors.push(`flow-manifest.json — could not read ${manifestPath}: ${e.message}`);
    return errors;
  }

  const structural = validateSchema(schema, manifest, "", schema);
  if (structural.length > 0) {
    for (const err of structural) errors.push(`flow-manifest.json:${err}`);
    return errors;
  }

  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
  } catch (e) {
    errors.push(`design-tokens.json — could not read ${tokensPath}: ${e.message}`);
    return errors;
  }

  let actualHash;
  try {
    actualHash = computeTokensHash(tokensPath, tokens);
  } catch (e) {
    errors.push(`design-tokens.json:hash — ${e.message}`);
    return errors;
  }

  if (manifest.design_tokens_hash !== actualHash) {
    errors.push(
      `design_tokens_hash changed between Phase 2a and Phase 3 (expected ${actualHash.slice(0, 12)}..., manifest has ${String(manifest.design_tokens_hash).slice(0, 12)}...)`
    );
  }

  return errors;
}

// ---------- CLI ----------

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify-manifest") {
      opts.verifyManifest = argv[++i];
    } else if (a === "--tokens") {
      opts.tokens = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (positional.length !== 1) {
    console.error(
      "usage: validate-flow-graph.js <flow-graph-path> [--verify-manifest <manifest-path> --tokens <tokens-path>]"
    );
    process.exit(2);
  }
  if (
    (opts.verifyManifest && !opts.tokens) ||
    (!opts.verifyManifest && opts.tokens)
  ) {
    console.error("--verify-manifest requires --tokens (and vice versa)");
    process.exit(2);
  }
  const graphPath = positional[0];

  let schema, graph;
  try {
    schema = readJson(SCHEMA_PATH);
  } catch (e) {
    console.log("validate-flow-graph: fail");
    console.log("errors: 1");
    console.log(`error: schema — could not read ${SCHEMA_PATH}: ${e.message}`);
    process.exit(1);
  }

  try {
    graph = readJson(graphPath);
  } catch (e) {
    console.log("validate-flow-graph: fail");
    console.log("errors: 1");
    console.log(`error: flow-graph.json — could not read ${graphPath}: ${e.message}`);
    process.exit(1);
  }

  const structural = validateSchema(schema, graph, "", schema);
  const semantic = structural.length === 0 ? validateSemantic(graph) : [];
  const manifestErrors = opts.verifyManifest
    ? verifyManifest(opts.verifyManifest, opts.tokens)
    : [];
  const allErrors = [...structural, ...semantic, ...manifestErrors];

  const pages = Array.isArray(graph.pages) ? graph.pages.length : 0;
  const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;
  const layouts = Array.isArray(graph.layouts) ? graph.layouts.length : 0;
  const sharedState = Array.isArray(graph.shared_state) ? graph.shared_state.length : 0;

  if (allErrors.length === 0) {
    console.log("validate-flow-graph: ok");
  } else {
    console.log("validate-flow-graph: fail");
  }
  console.log(`pages: ${pages}`);
  console.log(`edges: ${edges}`);
  console.log(`layouts: ${layouts}`);
  console.log(`shared-state: ${sharedState}`);
  if (opts.verifyManifest) {
    console.log(`manifest: ${manifestErrors.length === 0 ? "ok" : "fail"}`);
  }
  console.log(`errors: ${allErrors.length}`);
  for (const err of allErrors) {
    console.log(`error: ${err}`);
  }
  process.exit(allErrors.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  validateSchema,
  validateSemantic,
  verifyManifest,
  computeTokensHash,
};
