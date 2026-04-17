---
name: d2c-build-flow
description: "Build a connected multi-page Figma flow (onboarding, checkout, KYC, etc.) into production-ready frontend code: per-page components, a shared layout, routing, optional shared state, and a navigation smoke test. Takes a natural-language prompt listing ordered steps (each step = one Figma frame URL, optional per-step route). Use when implementing flows that span 2+ screens, when the user mentions 'flow', 'multi-page', 'onboarding', 'checkout', or lists steps."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__figma
---

# Figma to Design — Build Flow

You are a flow-aware code generator. You take a natural-language prompt listing ordered Figma frames and produce a connected, production-ready flow: per-page components, a shared layout shell, routes wired up, optional shared state, and a navigation smoke test. You reuse the existing `/d2c-build` machinery for per-page IR + codegen + pixel-diff and add only a thin flow layer on top.

This skill ships a **parallel** pipeline to `/d2c-build`. It does not replace it. When the user hands you a single Figma URL, redirect them to `/d2c-build`.

---

<!-- NON-NEGOTIABLES:BEGIN -->
## Non-negotiables

These rules hold across every phase of this skill. No exceptions.

1. **Design tokens MUST be loaded before any decision.** Read `.claude/d2c/design-tokens.json`. If it is missing, unreadable, or has `d2c_schema_version < 1`, STOP AND ASK the user to run `/d2c-init` (or `/d2c-init --force` if outdated).
2. **NEVER use a library outside `preferred_libraries.<category>.selected`.** The user explicitly chose which library to use for each capability. NEVER substitute an installed-but-not-selected library. If the design requires a capability not covered by `preferred_libraries`, STOP AND ASK.
3. **NEVER hardcode color, spacing, typography, shadow, or radius values.** Every visual value MUST reference a design token from `design-tokens.json`. No raw hex, no magic numbers, no exceptions.
4. **MUST reuse existing components when an existing component can serve the need.** Check the `components` array in `design-tokens.json` before creating anything new. If an existing component can do the job, MUST use it.
5. **MUST follow project conventions when `confidence > 0.6` and `value ≠ "mixed"`.** Project conventions (declaration style, export style, type definitions, import ordering, file naming, CSS wrapper, barrel exports, props pattern) override framework defaults.
6. **NEVER re-decide a locked component or token.** Read `decisions.lock.json` from the IR run directory at the start of every phase after Phase 2. Only nodes with `status: "failed"` may have their component choice or token mapping changed. If a locked decision must change, STOP AND ASK.

**When any rule is ambiguous, STOP AND ASK — do not guess.**
<!-- NON-NEGOTIABLES:END -->

## Flow-specific rules (in addition to the Non-negotiables)

7. **The parsed step list is authoritative.** The user's prompt (step numbers, URLs, per-step routes) wins over any Figma prototype metadata. Prototype edges only feed shell detection and the `F-FLOW-PROTOTYPE-CONTRADICTS-ORDER` warning.
8. **Flow IR freezes in Phase 2a; page IR freezes per page in Phase 2.** Neither may re-decide the other without user input. Phase 3 reads both IRs as frozen; if a fix would require changing the flow graph, STOP AND ASK.
9. **Never auto-generate Next buttons that weren't drawn in Figma.** If no interactive component in a page carries a `link_target`, emit a TODO comment and flag the edge as `inferred: true` in the report. Do not invent chrome to make the pixel-diff or the nav test "pass."
10. **The report must echo the parsed step list.** Users verify intent by diffing "what I wrote" against "what you understood."
11. **One argument controls flow shape: `mode:`.** It has four values — `auto` (default), `routes`, `stepper`, `hybrid`. When the user omits `mode:`, Phase 2a auto-detects from Figma via `detect-mode.js` and logs the chosen mode + per-signal reasons. Explicit `mode:` always wins. Auto-detection confidence below 0.55 aborts Phase 2a with a structured error listing signal scores — never silently picks a wrong shape.

---

## Arguments

Parse `$ARGUMENTS` for optional flags (in addition to the flow prompt):

- **`--threshold <number>`** (default: **95**) — per-page pixel-diff threshold; forwarded to each page's `/d2c-build` Phase 4. Clamped to `[50, 100]`.
- **`--max-rounds <number>`** (default: **4**) — per-page max auto-fix rounds; forwarded to each page's Phase 4. Clamped to `[1, 10]`.
- **`--yes`** — skip the Phase 1 confirm-or-edit gate; proceed immediately once parsing succeeds. Use for scripted/CI runs.

Unknown flags are ignored with a one-line warning.

---

## Pre-flight Check

Before anything else:
1. Confirm `.claude/d2c/design-tokens.json` exists. If not, trigger **F-FLOW-TOKENS-MISSING**.
2. Read the prompt (`$ARGUMENTS` after the slash command plus any message body the user provided).
3. Do NOT start any phase until the prompt has been parsed (Phase 1).

---

## Phase 1 — Prompt Parsing

Goal: turn the user's natural-language prompt into a deterministic, validated list of steps with resolved routes.

### Tooling

Use the parser at `skills/d2c-build-flow/scripts/parse-flow-prompt.js`. Invoke it from Bash:

```bash
node skills/d2c-build-flow/scripts/parse-flow-prompt.js <prompt-file>
```

Or call the exported `parseFlowPrompt(text)` function directly from another Node script. The parser is pure and deterministic; it does not touch Figma, the filesystem, or the network.

### Invocation grammar

The parser recognises two canonical forms. **Both are legal; teach users Form A in examples unless they need to route outside a common parent.**

**Form A — base route, derived per-step routes**
```
/d2c-build-flow
In these following pages we need to build the following flow, this is the route /onboarding
These are the steps:
Step 1: <figma-frame-url>
Step 2: <figma-frame-url>
Step 3: <figma-frame-url>
```
Every step without an explicit `route:` is resolved to `<base_route>/step-<N>` (e.g. `/onboarding/step-1`).

**Form B — explicit per-step routes**
```
/d2c-build-flow
In these following pages we need to build the following flow.
These are the steps:
Step 1: <figma-frame-url>  route: /signup
Step 2: <figma-frame-url>  route: /signup/verify
Step 3: <figma-frame-url>  route: /signup/complete
```

Mixed form (base route plus some explicit per-step routes) is legal. Explicit routes that leave the `base_route` subtree trigger **F-FLOW-ROUTE-ESCAPES-BASE** as a warning.

**Form C — auto-discover from an entry frame**
```
/d2c-build-flow
Build the onboarding flow, this is the route /onboarding
Step: <figma-frame-url>
```

Exactly one `Step:` line (no number). The parser returns `auto_discovered: true` and a single-entry `steps[]`. Phase 2a then BFS-walks Figma's prototype connections starting at `entry_node_id` to enumerate the rest of the flow; each discovered edge lands in `flow-graph.edges[]` with `inferred: false` and a real `source_component_node_id`. Routes are derived as `<base_route>/step-<N>` in BFS order; if no `base_route` is given, the model asks for one before freezing the graph.

Mixing Form C with Form A/B (or listing multiple `Step:` lines) → **F-FLOW-PARSE-AMBIGUOUS**.

**Mode directive (any form) — `mode: auto | routes | stepper | hybrid`**

Declare the flow shape in the preamble (typically trailing the route line):
```
this is the route /onboarding, mode: stepper
```
Values:
- `auto` (default when omitted) — Phase 2a runs `detect-mode.js` against the Figma frames to pick `routes` / `stepper` / `hybrid`.
- `routes` — every step is its own URL (today's behaviour). Forbids `Stepper group` blocks.
- `stepper` — all steps share one URL and swap in place. If no `Stepper group` blocks are present, Phase 2a wraps the entire `steps[]` into a single implicit group named after the flow.
- `hybrid` — one or more explicit `Stepper group` blocks mixed with bare `Step:` lines. Requires at least one block.

Unknown values → **F-FLOW-MODE-UNKNOWN** with the allowed set shown.

**Stepper group blocks (mode: stepper or hybrid)**
```
Stepper group "intake" at /signup:
  Step 1: <figma-frame-url>  title: "Name"
  Step 2: <figma-frame-url>  title: "Email"  validate: form
```
- Header: `Stepper group "<name>" at <route>:` — quoted name (single or double), followed by the single route the group is mounted at.
- Steps under the header are group-internal: their `step_number` must be 1-based contiguous within the group and their URLs are rendered as swappable bodies sharing the group's route.
- Per-step directives legal in groups: `title:` (stepper label), `optional: true|false` (Skip button), `validate: none|form` (Next gate), `state:` (shared form fields).
- Groups are closed when a line de-indents to ≤ header indent or a new group starts. Empty groups (<2 steps) → **F-FLOW-STEPPER-GROUP-EMPTY**.
- Two groups with the same name → **F-FLOW-STEPPER-GROUP-DUP**.

A full hybrid prompt:
```
/d2c-build-flow
Build the signup, this is the route /signup, mode: hybrid
Stepper group "intake" at /signup:
  Step 1: <url>  title: "Name"
  Step 2: <url>  title: "Email"
Step 1: <url>  route: /signup/verify
Step 2: <url>  route: /signup/welcome
```

### Grammar rules (also documented in `references/failure-modes.md`)

- **Preamble**: any free text before the first candidate step line. Capture `base_route` as the first match of `/\broute\s+(\/\S+)/i` in the preamble; strip trailing punctuation.
- **Step candidate**: any line matching `^\s*Step\s+\d+\b.*$` (case-insensitive).
- **Strict step grammar**: `^\s*Step\s+(\d+)\s*[:\-]\s*(\S+)(?:\s+route:\s*(\/\S+))?\s*$` — URL must be one whitespace-free token.
- **Minimum**: 2 step lines. Fewer → **F-FLOW-TOO-FEW-STEPS**.
- **Step numbers**: contiguous `[1, 2, …, N]`. Gaps or duplicates → **F-FLOW-STEP-GAP**.
- **URL validation**: must contain `?node-id=` or `&node-id=`. Bare file URLs → **F-FLOW-FILE-URL** (offer a frame pick-list via `get_metadata`).
- **Cross-file flows (B-FLOW-CROSS-FILE).** Steps may come from different Figma files; the parser extracts the file key from each URL (`/design/<key>/…` or `/file/<key>/…`) and sets `cross_file: true` when more than one unique key appears. Phase 2a MUST fetch metadata per unique `file_key` and the Phase 6 report MUST echo the full dependency list so the user knows which files gate the flow.
- **Route resolution**: explicit per-step `route:` wins; else `<base_route>/step-<N>`; else **F-FLOW-NO-ROUTE** (ask for a base route once and apply to all unrouted steps).
- **Optional `state:` directive** (per step, after URL and optional `route:`, order-independent): `state: <name>:<type>[, <name>:<type> …]`. Declares which fields this page writes into shared state. Types MUST be `string | number | boolean` — anything else fires **F-FLOW-STATE-TYPE-UNSUPPORTED**. Example: `Step 1: <url>  state: email:string, age:number`.
- **Optional `mobile:` directive** (per step, B-FLOW-MOBILE-VARIANT): `mobile: <figma-frame-url>` pairs a mobile viewport with the desktop frame. Phase 4 verifies both viewports; Phase 3 emits responsive CSS (tokens-aware) rather than two components. The mobile URL must also carry a `node-id` — bare file URLs fire **F-FLOW-FILE-URL**. Example: `Step 1: <desktop-url>  mobile: <mobile-url>`.
- Anything else → **F-FLOW-PARSE-AMBIGUOUS** with the failing line quoted and a canonical example in the prompt.

### Output of Phase 1

```
{
  ok,
  failures[],
  base_route,
  flow_name,
  auto_discovered,
  mode: "auto" | "routes" | "stepper" | "hybrid",
  mode_source: "explicit" | "default",
  steps: [{ step_number, figma_url, node_id, route, route_source }],
  stepper_groups: [{ name, raw_name, route, header_line, validation_enabled, steps: [...] }]
}
```

`auto_discovered === true` signals Phase 2a to run Figma-prototype BFS instead of trusting the user's step list for page enumeration. In Form A/B the flag is `false` and the flow is exactly as the user listed.

`mode` carries the user's declared flow shape; when `"auto"`, Phase 2a calls `detect-mode.js` to resolve it to one of the three terminal values before writing `flow-graph.json`. `stepper_groups[]` holds any explicit `Stepper group` blocks; additional groups may be synthesised in Phase 2a (either by wrapping all steps when `mode: stepper` is declared with no blocks, or by `detect-mode.js` partitioning in `mode: auto`).

`node_id` is extracted from the URL's `node-id` query parameter and normalised to colon form (e.g. `1-2` → `1:2`) to match Figma's MCP node id format.

### Batched error reporting

When multiple Phase-1 failures fire together (common when a user mistypes), present them in a single grouped STOP AND ASK message per the meta-rule in `failure-modes.md`. Do not iterate one by one.

When `F-FLOW-FILE-URL` fires (step URL missing `?node-id=`), follow the **Runtime procedure** in `failure-modes.md`: call `mcp__figma__get_metadata` on the file and feed the response through `skills/d2c-build-flow/scripts/format-frame-picker.js` to render the numbered pick-list. The helper's deterministic output is what the user sees — do not hand-format frame names.

### Pass criteria

Phase 1 passes when `ok === true` (only `warning`-severity failures allowed). Warnings are surfaced to the user but do not block.

### Confirm-or-edit gate

Before entering Phase 2a, echo the parsed step list and wait for confirmation. This catches grammar misunderstandings before any Figma fetch runs.

Format:

```
Parsed steps:
  Step 1 → /onboarding/step-1 → https://www.figma.com/design/abc/Flow?node-id=1-2
  Step 2 → /onboarding/step-2 → https://www.figma.com/design/abc/Flow?node-id=3-4
  Step 3 → /onboarding/step-3 → https://www.figma.com/design/abc/Flow?node-id=5-6

Proceed? [y = proceed / e = edit prompt / n = abort]
```

Rules:
- Skip this gate when `--yes` is present in `$ARGUMENTS`.
- `y` → continue to Phase 2a.
- `e` → wait for an updated prompt, re-run Phase 1 from the top.
- `n` → stop the flow with "aborted at confirm gate" and exit cleanly.
- Any other input → re-show the prompt unchanged.

---

## Phase 2a — Flow Planning

Goal: produce a validated, frozen `flow-graph.json` from the parsed step list plus Figma metadata.

### Run directory

Create `.claude/d2c/runs/<YYYY-MM-DDTHHMMSS>/flow/` containing `flow-graph.json`. Individual per-page runs land at `.claude/d2c/runs/<ts>/pages/<node_id>/` (Phase 2 per page).

### Steps

1. **Inherit** `framework`, `meta_framework`, `conventions`, `components`, `preferred_libraries`, `api` from `design-tokens.json`. Phase 2a builds the flow graph for any framework — it is codegen (Phase 3) that branches. Supported framework/meta_framework pairs for Phase 3: `react`+`next` (App Router), `react`+`next` with Pages Router, `vue`+`nuxt`, `svelte`+`sveltekit`, `angular`+`angular`, `solid`+`solidstart`, `astro`+`astro`. Other pairs still produce a valid `flow-graph.json` during Phase 2a but abort at Phase 3 preconditions with a clear message.

2. **Enumerate pages.** Two modes, picked by `auto_discovered`:

   **Mode 1 — declared steps (`auto_discovered === false`, Form A/B):** iterate the user's `steps[]` in order. For each step, call Figma MCP (in parallel when possible):
   - `get_design_context(nodeId)` → metadata + screenshot.
   - Capture the frame `title` for the report and for future IR layers.
   - Inspect prototype interactions for overlay / conditional actions:
     - Overlay triggers → add to `not_supported_detected[]` with `kind: "overlay"` and fire **F-FLOW-OVERLAY-AS-PAGE**.
     - Conditional actions → `kind: "conditional"`, fire **F-FLOW-CONDITIONAL**.

   **Mode 2 — auto-discover (`auto_discovered === true`, Form C):** the parser handed us a single entry frame. BFS the prototype graph starting at `entry_node_id` to enumerate every downstream page:
   - Call `get_design_context(entry_node_id)` first; read `prototype.connections[]` (the outgoing prototype edges). If empty → fire **F-FLOW-DISCOVERY-EMPTY**.
   - Enqueue each connection's destination node id; repeat `get_design_context` per visited frame (parallelise where the MCP allows). De-duplicate on `node_id`.
   - If a connection closes a cycle (revisits a frame already visited on the current branch) → fire **F-FLOW-DISCOVERY-CYCLE** (inform), record the back-edge in `not_supported_detected[]` with `kind: "loop"`, and skip that edge.
   - After BFS terminates, check whether the file's prototype metadata lists additional entry frames reachable only from elsewhere. When multiple disconnected subtrees exist → fire **F-FLOW-DISCOVERY-DISCONNECTED** (stop-and-ask).
   - Assign `pages[]` in BFS order (entry first). Assign routes:
     - If `base_route` is set → `route = <base_route>/step-<N>` where N is the 1-based BFS index.
     - If `base_route` is null → STOP AND ASK the user for one before continuing (reuse the F-FLOW-NO-ROUTE wording).
   - Emit edges from the BFS tree: each non-back-edge becomes one `edges[]` entry with `inferred: false`, `source_component_node_id` set to the prototype connection's source component node id, and `trigger` derived from the connection (`ON_CLICK` → `"onClick"`, etc.).
   - Same overlay / conditional checks apply per visited frame.

3. **Shell detection.** Compare top-level children across every page's design context. Use the same component-match scoring pass that Phase 2 uses for candidate identification. A shared shell is identified when ≥ 75% of pages contain the same top-level component instance. Otherwise fire **F-FLOW-SHELL-DIVERGENT** (inform; fall back to no layouts).
   - When identified, add a single `layouts[]` entry with PascalCase `name` (derived from the shared component's Figma name, e.g. `OnboardingShell`), `figma_node_id` pointing at the shared component, and `applies_to` listing every page that contains it.
   - The detection itself is implemented by `skills/d2c-build-flow/scripts/detect-shared-shell.js` — call its exported `detectSharedShell({ pages, threshold })` after collecting `top_level_children` per page. `layouts: []` + `divergent: true` is the signal to fire `F-FLOW-SHELL-DIVERGENT`.
   - **Stepper-indicator sub-detection.** `detectSharedShell` also scans each top-level child's `descendants[]` for a repeated component instance whose `variant` (or `properties.step`/`index`/`current`) differs per page in an ordered way. When found, the layout entry gets a `stepper_indicator` object capturing `component_id`, `node_ids_per_page`, `variants_per_page`, and `ordered`. This feeds mode detection and stepper codegen.

3a. **Mode resolution.** When Phase 1 returned `mode !== "auto"`, carry the declared value through to `flow-graph.mode` and set `mode_source = "explicit"`. When `mode === "auto"`, call `skills/d2c-build-flow/scripts/detect-mode.js` with:
   - `pages[]` — each entry carries `node_id`, `figma_url`, `frame_size` from `get_design_context`, optional `differential_region` (derived by subtracting the shared-shell bbox from the frame bbox and reporting the leftover area ratio + bbox), and `prototype_edges[]` from the prototype metadata.
   - `shell_result` — the `detectSharedShell` output with `threshold: 0.9` (stepper coverage bar is stricter than the default).
   - `explicit_groups` — any `Stepper group` blocks already parsed.

   The detector returns `detected_mode` (`routes` | `stepper` | `hybrid`), `mode_confidence` in `[0, 1]`, `mode_detection_reasons[]` (per-signal breakdown), a `partition` of pages into stepper/routes runs, and `aborted: true` when confidence is below 0.55. Handling per band:
   - **`band: "silent"` (≥0.80):** write the result into the IR, log a single-line notice, proceed.
   - **`band: "advisory"` (0.55–0.80):** write the result, print a prominent warning with the signal breakdown, proceed.
   - **`band: "abort"` (<0.55):** fire **F-FLOW-MODE-UNDECIDABLE** and STOP AND ASK the user to pass `mode:` explicitly. Include the returned reasons verbatim.

   When `mode` resolves to `stepper` with no explicit `Stepper group` blocks, synthesise a single implicit group named after the flow (PascalCase of `flow_name`) containing all top-level steps. When `mode` is `hybrid`, keep explicit groups as-is; when the detector returns additional stepper runs beyond what the user declared, merge them into `stepper_groups[]` with `detected_mode_run: true` for observability.

   Finally, for every stepper group (explicit or detected), insert a single virtual `pages[]` entry with `page_type: "stepper_group"`, `node_id: "stepper:<hash>"`, `route` equal to the group's route, `stepper_group_ref` equal to the group's name, and drop the group-internal steps from `pages[]` — those steps live only in `stepper_groups[*].steps[]`.

4. **Edges.** Behaviour depends on `auto_discovered`, branch suffixes, and stepper groups:
   - **Linear declared steps (`auto_discovered === false`, no branches, no stepper groups):** emit one linear edge per consecutive pair of pages:
     - `from_node_id = pages[i].node_id`, `to_node_id = pages[i+1].node_id`.
     - `trigger = "onClick"`, `source_component_node_id = null`, `inferred = true`, `condition = null`.
     - v1 does not populate `source_component_node_id` in this mode — identifying the Next button is deferred to the per-page Phase 2 (where it lands on `component-match.link_target` instead).
   - **Stepper-group internal edges (mode: stepper or hybrid):** do NOT add entries to `flow-graph.edges[]`. Inside a stepper group the "next step" action is represented at the page level via `stepper_groups[i].steps[]` order, and at the button level via `link_target.edge_kind = "step_delta"` written by `pick-link-target.js` during Phase 2b. The stepper-group virtual page may still have outgoing edges into the next top-level page (route-mode exit), and those ARE recorded in `edges[]` as normal.
   - **Branching declared steps (at least one `Step Na:` / `Step Nb:` in the prompt, B-FLOW-MULTI-BRANCH):** for each pair of consecutive unique step numbers, emit the edge(s) into the next group's pages:
     - A group of size 1 → one edge to the next group's only page (linear).
     - A group of size 2+ → N edges, one per sibling, all `from_node_id` sharing the previous page's `node_id`.
     - For every outgoing branch, identify the Figma component that triggers it (typically the button whose prototype connection targets the branch's entry frame). Populate `source_component_node_id` with its node id and set `inferred = false`. If any branch can't be wired to an identifiable component → fire **F-FLOW-BRANCH-UNWIRED**. The validator refuses to freeze a branching graph with null `source_component_node_id` on any outgoing edge.
     - After a branch group, subsequent linear steps re-merge — emit one edge from each branch's last page to the merge target.
   - **Mode 2 (auto-discover):** edges are emitted directly from the Figma prototype connections visited during BFS. Every edge MUST have `inferred = false` and a non-null `source_component_node_id`; the validator enforces this invariant whenever `auto_discovered === true`. Trigger is taken from the prototype connection type. Prototype-discovered branching is fully supported here — a page with multiple outgoing prototype connections becomes a multi-branch page automatically.

5. **Shared state.**
   - **From `state:` directives:** when any parsed step carried a `state:` directive, carry the field list onto that page as `pages[].state_writes`. Then auto-create a single `shared_state[]` entry named `<flow_name>Data` (camelCase, e.g. `onboardingData`) whose `pages[]` is the set of nodes that appear as writers or readers and whose `persistence` defaults to `"memory"` (user can request `"session"` or `"local"` during the confirm-or-edit gate). The field types feed the generated TypeScript interface.
   - **Persistence override.** When the user asks for `"local"` persistence, accept an optional `ttl_seconds` (positive integer). Write both into `shared_state[i]`. When the user asks for `"local"` without a TTL, set `ttl_seconds: null` — the provider keeps the data until `reset()` is called.
   - **No `state:` directives, no user ask:** leave `shared_state: []`. The skill does not auto-infer from Figma in v1.
   - **User asked for shared state** (e.g. "this flow carries user data across steps") **but no form elements exist** across pages → fire **F-FLOW-MISSING-STATE**.

6. **Prototype vs declared order.** If prototype metadata exists and implies an order that differs from the declared steps, fire **F-FLOW-PROTOTYPE-CONTRADICTS-ORDER** (inform only; user's list wins).

7. **Emit + validate.** Write `flow-graph.json` and run:
   ```bash
   node skills/d2c-build-flow/scripts/validate-flow-graph.js <run-dir>/flow/flow-graph.json
   ```
   On any validation error, regenerate and retry up to 2 times (`P2-SCHEMA-ERR`-style auto-recover). After 2 failures, escalate to **FX-UNKNOWN-FAILURE**.

8. **Write `flow-manifest.json`.** Alongside `flow-graph.json`, emit a manifest bookkeeping file so tokens changing between Phase 2a and Phase 3 becomes a detectable failure. Schema at `skills/d2c-build-flow/schemas/flow-manifest.schema.json`. Required fields:
   - `schema_version: 1`
   - `flow_prompt_hash` — SHA-256 hex of the raw flow prompt text
   - `design_tokens_hash` — SHA-256 hex of the tokens file(s); same hashing rule as `run-manifest.tokens_file_hash` (see `skills/d2c-build/scripts/validate-ir.js::computeTokensHash`)
   - `started_at` — ISO 8601 timestamp with timezone
   - `framework`, `meta_framework` — inherited from design-tokens.json

9. **Freeze.** After successful validation, treat `flow-graph.json` as immutable for all subsequent phases. Any need to change it during Phase 3+ requires STOP AND ASK per flow-rule #8.

---

## Phase 2 — Per-page IR (delegated)

For each page in `flow-graph.pages[]` (in order):

1. Set the run directory to `.claude/d2c/runs/<ts>/pages/<node_id>/`.
2. Run the existing `/d2c-build` Phase 2 emit + validate process. Inputs: the page's `figma_url`, the project's design tokens, the framework reference file.
3. **Link-target enrichment.** After `component-match.json` is emitted, run `skills/d2c-build-flow/scripts/pick-link-target.js` (or call the exported `pickLinkTarget(...)`). The script accepts two target shapes — pass exactly one:
   - `toNodeId` — the next page's node id (route navigation).
   - `stepDelta` — a signed integer, typically `+1` (Next) or `-1` (Back), for stepper-internal advancement. Back targeting uses a different text regex (`/back|previous|prev|return/i`) so a stepper with both buttons visible wires each correctly.

   The heuristic otherwise matches today's: highest-ranked node whose `figma_name` matches the forward text set (or the back set for `-1`), with a primary-button fallback.

   Populate `component-match.nodes[<id>].link_target` from the returned descriptor:
   - Always: `page_node_id = <this page's node_id>`, `trigger` = `"onClick"` or `"onSubmit"` (form regions).
   - `edge_kind: "route"` + `to_node_id` when the returned descriptor is a route edge.
   - `edge_kind: "step_delta"` + `step_delta` (signed int) when the returned descriptor is a stepper-internal edge. No `to_node_id` is written for step-delta edges — Phase 3 reads the step order from `stepper_groups[*].steps[]`.

   For stepper-group virtual pages, Phase 2b runs `pick-link-target` **per step frame** (each step's own `component-match.json`), once with `stepDelta: +1` and once with `stepDelta: -1`, so every step carries its own Next/Back wiring.

   For route-edge enrichment, update `flow-graph.edges[i].source_component_node_id` to the chosen component's node id and set `inferred = false`. *This is the one sanctioned mutation of `flow-graph.json` after Phase 2a — it only fills in previously-null fields and never changes page order, routes, or layouts. Validator allows the write; flow-rule #8 still forbids re-ordering or route changes.*
4. If no wireable component is identified, leave `component-match.link_target` absent on every node (the edge stays `inferred: true`).

Skip page-level Phase 2 for any page whose `not_supported_detected[]` entry the user asked to `skip` during Phase 2a.

---

## Phase 3 — Code Generation

### Preconditions

- **Framework/meta_framework pair must be supported.** Pick the reference file by branch table — first matching row wins:

  | Framework | Meta framework | Extra condition | Reference |
  |---|---|---|---|
  | `react` | `next` | top-level `pages/` directory exists or `conventions.router === "pages"` | `references/framework-react-next-pages.md` |
  | `react` | `next` | otherwise (App Router) | `references/framework-react-next.md` |
  | `vue` | `nuxt` | — | `references/framework-vue-nuxt.md` |
  | `svelte` | `sveltekit` | — | `references/framework-sveltekit.md` |
  | `angular` | `angular` | — | `references/framework-angular.md` |
  | `solid` | `solidstart` | — | `references/framework-solidstart.md` |
  | `astro` | `astro` | — | `references/framework-astro.md` |
  | anything else | — | — | **abort** with: "Unsupported framework pair `<framework>`/`<meta_framework>`. Supported: react+next (app/pages), vue+nuxt, svelte+sveltekit, angular, solid+solidstart, astro. Run `/d2c-init --force` to re-detect." |

- `flow-graph.json` validated and frozen.
- Every page has passed per-page Phase 2.
- **Manifest check.** Re-validate `flow-manifest.json` against the current tokens file:
  ```bash
  node skills/d2c-build-flow/scripts/validate-flow-graph.js <run-dir>/flow/flow-graph.json \
    --verify-manifest <run-dir>/flow/flow-manifest.json \
    --tokens .claude/d2c/design-tokens.json
  ```
  A `design_tokens_hash` mismatch means tokens changed between Phase 2a and Phase 3 — STOP AND ASK the user whether to re-run Phase 2a or abort.

### Order of emission

1. **Shared layout files** (when `layouts[]` non-empty) — see `references/framework-react-next.md` §"Shared layout".
2. **Shared state provider** (when `shared_state[]` non-empty) — see §"Shared state provider". The provider template branches on `shared_state[i].persistence`: `"memory"` emits an in-memory React state module; `"session"` emits the sessionStorage-backed, SSR-safe variant; `"local"` emits the localStorage-backed variant with an opt-in TTL envelope read from `shared_state[i].ttl_seconds`.
3. **Per-page files** — delegate to `/d2c-build` Phase 3 per page, with three flow-specific additions:
   - If the page's `component-match.json` contains a node with `link_target`, wire the handler (see §"Page files"). For `link_target.edge_kind === "step_delta"`, wire to the stepper provider's `next()`/`back()` instead of `router.push` (see §"Stepper groups" in `framework-react-next.md`).
   - If the page is inside a layout, place it at `app/<route>/page.tsx` relative to the layout directory and do NOT re-emit the shell — Next's App Router composes automatically.
   - If the page is `page_type: "stepper_group"`, do NOT delegate to `/d2c-build` per-page codegen. Instead emit the stepper per §"Stepper groups (single-route multi-step)" in `framework-react-next.md`: one `app/<group_route>/page.tsx`, per-step files under `_steps/`, and a provider under `_state/`. Each step's IR comes from its own `/d2c-build` Phase 2 run (keyed by the step's `node_id`), but the output shape is a step component, not a route page.

### Rules carried over from `/d2c-build`

All six non-negotiables apply per page exactly as in `/d2c-build`. Reuse, tokens, conventions, library selection, locked-decision respect — unchanged.

### Flow-specific rules

- **No invented chrome.** If a page has no button wireable to the outgoing edge, DO NOT inject one. Emit a TODO comment and keep pixel fidelity.
- **Placement.** Layout + `_state/` + `_components/` all live at the longest common route prefix of the pages they serve. When pages don't share a common prefix, fall back to per-page layouts and no shared state.
- **Conventions precedence.** If the project's `conventions` say `declare` via `function` but the layout template in the framework reference uses `default export function`, prefer the project convention (it's more strict).

---

## Phase 4 — Per-page Visual Verification

For each page, run the existing `/d2c-build` Phase 4 loop unchanged: Playwright screenshot → `pixeldiff.js` → auto-fix up to `max-rounds` times → pass at `threshold`%.

- Per-page score, per-page pass/fail, per-page auto-fix rounds.
- One page's regression does not reset another page's state.
- All Phase 4 failure modes from `skills/d2c-build/references/failure-modes.md` apply verbatim.

---

## Phase 4b — Flow Navigation Smoke Test

Goal: prove that routes resolve, pages mount without errors, and wired navigation actually navigates.

### Emission

Write `flow-navigation.spec.ts` per the selected framework reference's §"Navigation smoke test" (the branch table in Phase 3 Preconditions determines which file: `framework-react-next.md`, `framework-react-next-pages.md`, `framework-vue-nuxt.md`, `framework-sveltekit.md`, `framework-angular.md`, `framework-solidstart.md`, or `framework-astro.md`). Emission rules:
- Always emit a URL-level `test` that iterates every route, calls `page.goto`, asserts `body` visible and no `pageerror` events.
- Iterate `flow-graph.edges[]`: for each edge where `source_component_node_id` is non-null, emit one click-level assertion inside the second `test`. Branching pages produce multiple click assertions — one per outgoing edge — which is how the nav test proves each branch resolves.
- Location: `app/<flow_name>/flow-navigation.spec.ts` by default (App Router); `tests/flow/<flow_name>-navigation.spec.ts` if a top-level `tests/` directory is already used in the repo. Other frameworks follow the location rules in their respective reference file.

### Execution

If the project does not already have a Playwright config, emit one at the repo root from the template at `skills/d2c-build-flow/references/playwright.flow.config.ts.template`. It includes a `webServer` block that starts `npm run dev` and waits for `http://localhost:3000`, so the spec can run without a dev server pre-started.

Run the spec with:

```bash
npx playwright test -c playwright.flow.config.ts
```

If a Playwright config already exists in the project, fall back to:

```bash
npx playwright test <path-to-spec>
```

### Outcome handling

- **Pass:** log it in the report.
- **Fail (with autofix, B-FLOW-NAV-AUTOFIX):** when click-level assertions fail, run the autofix planner:
  ```bash
  node skills/d2c-build-flow/scripts/nav-autofix-plan.js \
    <run-dir>/flow/flow-graph.json <run-dir>/flow/nav-failures.json \
    --max-rounds 2
  ```
  The planner returns one of:
  - `action: "relax-link-target"` — re-run `pick-link-target.js` with a relaxed regex, update `edges[i].source_component_node_id`, re-run the test.
  - `action: "wire-next-best"` — take the second-ranked primary-button candidate from the page's `component-match.json`, rewire, re-run.
  - `action: "escalate"` — budget exhausted or URL-level failure; emit **F-FLOW-NAV-ASSERT-FAIL** (inform tier).
  Each round is one retry. Default `--max-rounds 2`; override per-invocation with `--nav-max-rounds`.
- **Fail (autofix exhausted):** fire **F-FLOW-NAV-ASSERT-FAIL** (inform tier). Report which edges failed and whether each failure was URL-level or click-level, plus the planner diagnosis for each.

---

## Phase 5 — Per-page Audit

For each page, run the existing `/d2c-build` Phase 5 audit unchanged (hardcoded values, library violations, IR unauthorised imports, convention conflicts).

Aggregate violations across pages for the final report.

---

## Phase 6 — Finalize

The flow-level report section is required. It sits at the top of the build summary, above the per-page details.

### Required report sections

1. **Parsed step list echo.** A numbered list: `Step N → <route> → <figma_url>`. This is how the user verifies intent.
2. **Flow diagram (B-FLOW-REPORT-DIAGRAM).** Emit a Mermaid `flowchart LR` block rendered by `skills/d2c-build-flow/scripts/render-flow-diagram.js <run-dir>/flow/flow-graph.json`. Solid arrows = wired edges, dashed arrows = inferred, labels annotate `loop`, `if <condition>`, etc. Fall back to `--format ascii` when the report consumer can't render Mermaid.
3. **Flow-graph diff (B-FLOW-REPORT-DIFF).** If `<run-dir>/flow/flow-graph.json` has a predecessor (a previous run-dir under `.claude/d2c/runs/`), render the diff with `skills/d2c-build-flow/scripts/diff-flow-graph.js <previous>/flow/flow-graph.json <run-dir>/flow/flow-graph.json`. Show `no changes` when nothing differs.
4. **Cross-file dependencies (B-FLOW-CROSS-FILE).** When `flow-graph.cross_file === true`, list every unique `file_key` from `flow-graph.file_keys[]` with the pages it gates.
5. **Page scores table.** Columns: `Step`, `Route`, `Pixel-diff %`, `Rounds used`, `Pass/Fail`. Add a `Mobile %` column when any page declares `mobile_variant` (B-FLOW-MOBILE-VARIANT).
6. **Reuse metric.** `X / Y components reused across ≥2 pages (Z%)`. Computed by `skills/d2c-build-flow/scripts/flow-reuse-metric.js <run-dir>` — reads every per-page `component-match.json` and tallies distinct source paths. Stdout format: `reused: <N>`, `total: <M>`, `percent: <P>`.
7. **Navigation test result.** `PASS` / `FAIL: <edges>` / `N/A (not executed)`. Plus counts of wired vs inferred edges, plus each autofix-round diagnosis from `nav-autofix-plan.js` when the autofix loop ran.
8. **Not-supported detections.** Every entry in `flow-graph.not_supported_detected[]` with its `kind`, `node_id`, and `reason`.
9. **Warnings.** Any `warning`-severity failure from Phase 1 (e.g. `F-FLOW-ROUTE-ESCAPES-BASE`) and any Phase 2a informs (`F-FLOW-SHELL-DIVERGENT`, `F-FLOW-PROTOTYPE-CONTRADICTS-ORDER`, `F-FLOW-DISCOVERY-CYCLE`).

### Update `design-tokens.json.components[]`

Add any newly generated shared layout components to `components[]` so that subsequent `/d2c-build` and `/d2c-build-flow` runs can reuse them.

---

## Canonical examples

**Example 1 — onboarding (Form A)**

```
/d2c-build-flow
In these following pages we need to build the following flow, this is the route /onboarding
These are the steps:
Step 1: https://www.figma.com/design/abc/Onboarding?node-id=1-2
Step 2: https://www.figma.com/design/abc/Onboarding?node-id=3-4
Step 3: https://www.figma.com/design/abc/Onboarding?node-id=5-6
```

Expected: `/onboarding/step-1..3`, one `OnboardingShell` layout if detected, no shared state unless asked for, URL-level nav test passes.

**Example 2 — signup (Form B)**

```
/d2c-build-flow
In these following pages we need to build the following flow.
These are the steps:
Step 1: https://www.figma.com/design/xyz/Signup?node-id=10-1  route: /signup
Step 2: https://www.figma.com/design/xyz/Signup?node-id=10-2  route: /signup/verify
Step 3: https://www.figma.com/design/xyz/Signup?node-id=10-3  route: /signup/complete
```

Expected: pages at `/signup`, `/signup/verify`, `/signup/complete`; no base route; `flow_name` prompts the user once (or is auto-derived from the longest common route prefix `/signup`).

**Example 3 — onboarding stepper (mode: stepper)**

```
/d2c-build-flow
Build the onboarding, this is the route /onboarding, mode: stepper
Step 1: https://www.figma.com/design/abc/Onboarding?node-id=1-2  title: "Email"
Step 2: https://www.figma.com/design/abc/Onboarding?node-id=3-4  title: "Verify"  validate: form
Step 3: https://www.figma.com/design/abc/Onboarding?node-id=5-6  title: "Profile"
```

Expected: a single virtual page at `/onboarding`, a stepper group containing the three steps, one `OnboardingShell` layout if detected, `_steps/StepEmail.tsx` + `StepVerify.tsx` + `StepProfile.tsx`, `_state/OnboardingContext.tsx` with `currentStep`, URL never changes when clicking Next, browser-back undoes a step.

**Example 4 — signup hybrid (stepper + standalone routes)**

```
/d2c-build-flow
Build the signup, this is the route /signup, mode: hybrid
Stepper group "intake" at /signup:
  Step 1: https://www.figma.com/design/abc/Signup?node-id=10-1  title: "Name"
  Step 2: https://www.figma.com/design/abc/Signup?node-id=10-2  title: "Email"
Step 1: https://www.figma.com/design/abc/Signup?node-id=20-1  route: /signup/verify
Step 2: https://www.figma.com/design/abc/Signup?node-id=30-1  route: /signup/welcome
```

Expected: stepper mounted at `/signup` (2 steps, swap in place), then standalone routes `/signup/verify` and `/signup/welcome`; the final step's Next navigates out of the stepper via a route edge; stepper context unmounts on exit.

**Example 5 — auto-detected mode (no `mode:` directive)**

```
/d2c-build-flow
Build the onboarding, this is the route /onboarding
Step 1: https://www.figma.com/design/abc/Onboarding?node-id=1-2
Step 2: https://www.figma.com/design/abc/Onboarding?node-id=3-4
Step 3: https://www.figma.com/design/abc/Onboarding?node-id=5-6
```

Expected: Phase 1 sets `mode: "auto"`, `mode_source: "default"`. Phase 2a runs `detect-mode.js`; when the three frames share the same size, a ≥90% shell, and an ordered stepper indicator, it resolves to `mode: "stepper"` with `mode_confidence ≥ 0.80` (silent band). When the frames are mixed-size or share no shell, it resolves to `mode: "routes"`. Either way, the IR records `mode_source: "auto-detected"` and `mode_detection_reasons[]` so the Phase 6 report shows exactly why the shape was picked.

---

## Failure modes index

See `references/failure-modes.md` for the full list. Quick reference:

| Phase | Failure id | Tier |
|------|------------|------|
| 1 | F-FLOW-PARSE-AMBIGUOUS | stop-and-ask |
| 1 | F-FLOW-STEP-GAP | stop-and-ask |
| 1 | F-FLOW-FILE-URL | stop-and-ask |
| 1 | F-FLOW-NO-ROUTE | stop-and-ask |
| 1 | F-FLOW-ROUTE-ESCAPES-BASE | inform |
| 1 | F-FLOW-TOO-FEW-STEPS | stop-and-ask |
| 1 | F-FLOW-TOKENS-MISSING | fatal |
| 1 | F-FLOW-MODE-UNKNOWN | stop-and-ask |
| 1 | F-FLOW-STEPPER-GROUP-EMPTY | stop-and-ask |
| 1 | F-FLOW-STEPPER-GROUP-DUP | stop-and-ask |
| 2a | F-FLOW-MODE-UNDECIDABLE | stop-and-ask |
| 2a | F-FLOW-OVERLAY-AS-PAGE | inform |
| 2a | F-FLOW-CONDITIONAL | inform |
| 2a | F-FLOW-MISSING-STATE | stop-and-ask |
| 2a | F-FLOW-SHELL-DIVERGENT | inform |
| 2a | F-FLOW-PROTOTYPE-CONTRADICTS-ORDER | inform |
| 4b | F-FLOW-NAV-ASSERT-FAIL | inform |
| any | FX-UNKNOWN-FAILURE | stop-and-ask |
