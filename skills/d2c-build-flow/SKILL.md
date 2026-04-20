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
11. **One argument controls flow shape: `mode:`.** It has four values — `auto` (default), `routes`, `stepper`, `hybrid`. When the user omits `mode:`, Phase 2a auto-detects from Figma per the 5-signal procedure in §Phase 2a step 3a and logs the chosen mode + per-signal reasons. Explicit `mode:` always wins. Auto-detection confidence below 0.55 aborts Phase 2a with a structured error listing signal scores — never silently picks a wrong shape.

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
- `auto` (default when omitted) — Phase 2a evaluates the 5-signal mode-detection procedure (§Phase 2a step 3a) against the Figma frames to pick `routes` / `stepper` / `hybrid`.
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

`mode` carries the user's declared flow shape; when `"auto"`, Phase 2a's mode-detection procedure (§step 3a) resolves it to one of the three terminal values before writing `flow-graph.json`. `stepper_groups[]` holds any explicit `Stepper group` blocks; additional groups may be synthesised in Phase 2a (either by wrapping all steps when `mode: stepper` is declared with no blocks, or by the partitioning step in `mode: auto`).

`node_id` is extracted from the URL's `node-id` query parameter and normalised to colon form (e.g. `1-2` → `1:2`) to match Figma's MCP node id format.

### Batched error reporting

When multiple Phase-1 failures fire together (common when a user mistypes), present them in a single grouped STOP AND ASK message per the meta-rule in `failure-modes.md`. Do not iterate one by one.

When `F-FLOW-FILE-URL` fires (step URL missing `?node-id=`), follow the **Runtime procedure** in `failure-modes.md`: call `mcp__figma__get_metadata` on the file, then render the response as a numbered pick-list. Use this format:

```
The URL "<failing-url>" is a Figma file URL — I need a frame URL.
Pick a frame from <file-name>:
  1. <Frame Name 1>  (node-id=1-2, 1440×900)
  2. <Frame Name 2>  (node-id=3-4, 390×844)
  ...
Reply with the number, or paste a corrected URL.
```

Show only top-level FRAME nodes. Sort by Figma's `documentationLinks` first (if present), then by document order. Truncate to 50 entries with `... and N more (paste a URL to pick from outside this list)` when the file has more frames.

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

## Phase 1.5 — Flow-level Intake

Goal: ask the standard `/d2c-build` intake questions ONCE upfront and bundle the answers into `flow_intake` so every per-page/per-step `/d2c-build` dispatch can read them. This closes the gap where running `/d2c-build` standalone asks 6 questions but `/d2c-build-flow` silently fell back to the structured-input defaults at `/d2c-build/SKILL.md` §1.0. Also adds a flow-only Q7 that collects all mobile Figma URLs upfront in one pass.

Runs after the Phase 1 confirm-or-edit gate, before Phase 1b. Skipped entirely when `--yes` is present in `$ARGUMENTS` (in which case the standard `/d2c-build` defaults apply per-dispatch and `flow_intake` is omitted from `flow-graph.json`).

### 1.5a — Flow Complexity Classification

For each declared step (every entry in the parsed step list, including stepper-group steps), call `mcp__Figma__get_metadata` to fetch the node tree only — no images, no full design context. Count descendant layers per step using the same rules as standalone `/d2c-build` §1.2a (FRAME, INSTANCE, COMPONENT, COMPONENT_SET, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, GROUP, BOOLEAN_OPERATION, STAR, REGULAR_POLYGON, excluding the root).

Resolve the dominant flow complexity:

- **Simple flow** — every step is Simple-classified (Figma node name matches a Simple keyword AND ≤20 layers). Rare for flows; usually a misuse (a flow of icons or chips). Skip Q4 (viewports) + Q6 (API) + Q7 (mobile).
- **Medium flow** — highest step is Medium (Medium keyword + ≤50 layers) and no step is Complex. AND the flow has fewer than 4 pages AND no `shared_state[]` declaration AND no `validate: form` on any stepper step. Skip Q6 only.
- **Complex flow** — any step is Complex, OR the flow has 4+ pages, OR `shared_state[]` was declared, OR any stepper step carries `validate: form`. Ask all questions.

Surface to the user before asking:

> "Classified as **Complex flow** (5 pages, max 78 layers). Asking all questions including mobile."
>
> or
>
> "Classified as **Medium flow** (2 pages, max 35 layers). Skipping API question — defaulting to no API."

Persist the classification on `flow_intake.complexity` and the list of skipped questions on `flow_intake.skipped_questions[]` so reruns can echo the same rationale.

### 1.5b — Ask Intake Questions

Ask the applicable questions in a single message, applying the skip rules from §1.5a. The questions mirror standalone `/d2c-build` §1.2b with the following flow-level deltas:

1. **What is this?** *(skipped by default for flows — defaults to `page` since every step is route-bound)* — Only ask when the user's prompt explicitly mixes section-level frames into the flow (e.g. a step labelled "the header section of /dashboard"). Default = `page`.
2. **Where should it live?** — **Skip.** Routes are already declared in the prompt and resolved by Phase 2a.
3. **Functional or visual-only?** — Always ask. Drives shared_state inference, form-validation generation in stepper Next handlers, and API plumbing across pages.
4. **Viewports?** *(skipped on Simple flows — defaults to `desktop-only`)* — `desktop-only` or `multiple`. Note: do **NOT** ask the user for per-step Figma URLs here — Q7 below collects them in one pass.
5. **Components to reuse?** — Always ask. Free-text answer; "use what makes sense" is the most common response.
6. **Does this design connect to any APIs?** *(skipped on Simple flows — defaults to `no`)* — Same follow-up structure as standalone `/d2c-build` Q6 (number of calls, then per-call name + sample schema). Stored in `flow_intake.api_calls[]`.
7. **Mobile designs?** *(NEW — skipped on Simple flows)* — "Do you have mobile Figma designs for this flow? (yes / no)". If `yes`: prompt the user to paste one mobile Figma URL **per declared step in order** as a numbered list:
   > "Paste the mobile Figma URL for each step, one per line, in declared order:
   > 1. /onboarding/step-1: <mobile-url>
   > 2. /onboarding/step-2: <mobile-url>
   > 3. /onboarding/step-3: <mobile-url>"
   
   The user may write `skip` on any line — that step ships desktop-only. Validate every supplied URL carries a `?node-id=` segment (else fire **F-FLOW-FILE-URL** with the offending URL quoted). Validate each URL points to a real Figma frame (the same `mcp__Figma__get_metadata` check used on desktop URLs); a 404 fires **F-FLOW-MOBILE-FRAME-MISSING** with the step number quoted.

Wait for answers before proceeding. Do not assume defaults beyond the auto-fills declared by the complexity classifier.

### 1.5c — Bundle Answers into `flow_intake`

Write the gathered answers to `flow_intake` on the in-memory run state, then persist on `flow-graph.json` (Phase 2a). Schema at `skills/d2c-build-flow/schemas/flow-graph.schema.json#/definitions/flow_intake`. Required fields:

- `what`, `mode`, `viewports`, `components_to_reuse`, `has_api_calls`, `mobile`, `complexity`, `skipped_questions`.
- `api_calls[]` only when `has_api_calls === "yes"`.
- `mobile.urls_by_step_index` is a sparse object keyed by 0-based step index across pages[] + stepper_groups[*].steps[*] in declared order. Empty object when `mobile.enabled === false` or every step was `skip`-ed.

### 1.5d — Propagate to Per-Page `/d2c-build` Dispatches

Every Phase 2 (per-page IR + per-variant), Phase 3 (per-step body codegen — see §"Stepper groups" delegation in Phase 3), and Phase 4 (per-variant pixel-diff) dispatch into `/d2c-build` MUST include the `flow_intake` answers in the structured-input payload, replacing the hardcoded defaults at `/d2c-build/SKILL.md` §1.0. Mapping:

| `flow_intake` field | structured-input payload field |
|---|---|
| `what` | `what` |
| `mode` | `mode` |
| `viewports` | `viewports` |
| `components_to_reuse` | `components_to_reuse` |
| `has_api_calls` | `has_api_calls` |
| `api_calls[]` | passed through as a top-level `api_calls` array (parser already accepts it) |

The mobile URLs are NOT propagated as payload fields — instead, Phase 2a attaches `mobile_variant: { figma_url, node_id, file_key }` directly to each matching page / stepper_step IR (the existing `mobile_variant` field). The flow's existing `mobile_variant` codegen path (`framework-react-next.md` §"Mobile variants") then handles dual-viewport pixel-diff and responsive emission without any further payload plumbing.

When `--yes` is present and `flow_intake` is omitted, every dispatch falls back to the existing structured-input defaults — preserving today's silent behaviour for scripted invocations.

### Failure modes

- **F-FLOW-INTAKE-METADATA-FAILED** *(stop-and-ask)* — `mcp__Figma__get_metadata` failed for one or more steps during §1.5a. Show the failing step numbers and ask whether to (a) retry, (b) skip classification and treat the flow as Complex (ask all questions), or (c) abort.
- **F-FLOW-MOBILE-FRAME-MISSING** *(stop-and-ask)* — a mobile URL supplied in §1.5b Q7 returned 404 from `mcp__Figma__get_metadata`. Show the step number and URL; ask the user to re-supply or `skip` that step.
- **F-FLOW-MOBILE-COUNT-MISMATCH** *(stop-and-ask)* — the user pasted a different number of mobile URLs than declared steps (excluding `skip` lines). Show both counts and the parsed list; ask the user to re-supply.

---

## Phase 1b — State variant extraction

Goal: from the raw prompt text, recognise `(figma_url, state_keyword, trigger, step_ref)` quadruples so Phase 2a can attach `state_variants` blocks to the correct pages / stepper steps. This phase is **prose-based, not grammar-based** — the skill does not extend the Phase 1 parser. Instead it instructs the executing model to read the prompt and produce a deterministic extraction table.

When the user's prompt mentions only primary frames (no loading/empty/error language), this phase emits an empty extraction and every page keeps its pre-state-variants shape. **Identity guarantee:** a loaded-only prompt produces a loaded-only IR, byte-identical to the pre-state-variants pipeline.

### Canonical state-keyword vocabulary

Map the user's phrasing to one of five canonical keywords. Matching is case-insensitive, whole-phrase-preferred; fall back to the longest matching substring.

| Canonical | Recognised phrasings |
|---|---|
| `loaded`  | `loaded`, `normal`, `default`, `populated`, `happy path`, `data view`, `primary`, `main` |
| `loading` | `loading`, `skeleton`, `fetching`, `pending`, `placeholder`, `shimmer`, `spinner view` |
| `empty`   | `empty`, `no data`, `zero state`, `null state`, `blank state`, `nothing to show` |
| `error`   | `error`, `failed`, `failure`, `broken`, `crashed`, `fallback`, `something went wrong` |
| `initial` | `initial`, `idle`, `pre-fetch`, `pristine`, `untouched`, `not started`, `before action`, `before search`, `waiting for input` |

A frame mentioned without any state keyword is treated as `loaded` by default — this is the identity case. `loaded` is always inferred when absent, so the user never has to spell it out.

The `initial` slot captures the **pre-fetch / pre-action** render — the moment a user lands on the page before any data request has been initiated or any user input has been given (e.g. a search page before the query is typed, a checkout step before Pay is clicked). It is distinct from `loading` (fetch in flight) and from `empty` (fetch completed, zero results). It is NOT a trigger-carrying state — the "when" is structural, not contextual.

### Extraction algorithm

Apply these rules in order:

1. **Segment the prompt by host.** A "host" is either a route (e.g. `/dashboard`) or a step reference (e.g. `step 2` inside a stepper group). Walk the prompt top-to-bottom; every sentence or list item belongs to the host most recently introduced. The identifying phrase for a host may be `/route`, `"<route>"`, or `step N`.

2. **Within each host segment, collect (state_keyword, figma_url) pairs by proximity.** For each Figma URL in the segment, scan backwards within the same clause for a state keyword. Stop at sentence boundaries. If no keyword is found in the clause, the URL maps to `loaded` by default.

3. **Trigger capture.** For every `loading` and `error` pair, scan the same clause (and the following sentence if needed) for trigger phrasing — "while <doing X>", "on <Y>", "when <Z>", "during <W>", "if <V>". Store the trigger verbatim. If no trigger is found in the local context, mark the trigger as `MISSING` and defer to the clarification phase. The `loaded`, `empty`, and `initial` slots skip trigger capture — their "when" is structural (identity / zero-length data / pre-fetch).

4. **Error stub detection.** An error mention with no Figma URL emits a stub entry: `{ stub: true, trigger: <captured or MISSING> }`. Only the `error` slot may be a stub — `loaded`/`loading`/`empty`/`initial` without a URL are parse failures.

   Recognised phrasings (non-exhaustive; match case-insensitively, treat `—`/`-`/`:` as separators):
   - "error state but no design yet" / "no design for error yet" / "error design TBD"
   - "error: TBD" / "error: placeholder" / "error: WIP"
   - "error state exists (placeholder for now)" / "error state exists — placeholder"
   - "has an error state" / "we also need an error state" — when no URL appears within the same sentence or the immediately following one
   - "error handled separately" / "error lives elsewhere" — when no URL is attached

   Trigger capture still applies to stub entries. The stub MUST carry a trigger describing when the error fires; if no trigger phrasing is in the local context, mark the trigger `MISSING` and ask in the clarification phase (the phrasing "no design yet" does not itself count as a trigger).

   When a stub is emitted, note it in the confirmation table with `stub: true` in the row so the user sees the contract explicitly before Phase 3 emits the dashed placeholder.

5. **Collision rules.** If the same host ends up with two URLs claiming the same state (e.g. two different `loading` URLs for `/dashboard`), abort with a clear message listing both URLs and the host. The extractor MUST NOT silently pick one. If two different hosts share the same URL for the same state, allow it — frames legitimately get reused.

6. **Mode inference.** After all hosts are extracted, infer the flow mode from the extraction shape:
   - Only bare route hosts → `routes`.
   - `step N` references inside a declared stepper group → `stepper`.
   - Both → `hybrid`.
   - A user-declared `mode:` directive from Phase 1 always wins — the inferred mode is only used when the parser left it as `auto`.

7. **Form C rejection.** If Phase 1 returned `auto_discovered === true` and the extraction produced any state_variants, abort with **F-FLOW-VARIANTS-FORMC-UNSUPPORTED** (deferred to P3.1). Do not continue.

### Extraction output

Emit a normalised table the user sees in the confirmation gate (Phase 2a step 2d) and that Phase 2a step 2 uses to populate `state_variants[]`:

```
{host, step_ref?, state, figma_url?, trigger, stub?}
```

- `host` — route string (e.g. `/dashboard`) or `<group-name> step N`.
- `step_ref` — 1-based step index inside the stepper group; null for bare routes.
- `state` — one of `empty | error | initial | loaded | loading`.
- `figma_url` — the supplied URL; absent for error stubs.
- `trigger` — captured trigger text, or the literal string `MISSING` (clarified later). Required for `loading` and `error`; ignored for `loaded`, `empty`, and `initial`.
- `stub` — `true` only on error entries with no URL.

Rows are serialised alphabetically by `state` within each host, for diff stability (`empty`, `error`, `initial`, `loaded`, `loading`).

### Examples the skill must handle

**Mixed routes-mode prompt (all triggers inline):**
```
Build /dashboard — the normal view is https://figma.com/.../a,
loading skeleton is https://figma.com/.../b while fetching the user's data,
error view is https://figma.com/.../c if the fetch returns 5xx.
Also /settings from https://figma.com/.../d.
```
Yields rows for `/dashboard` (`loaded`, `loading`, `error` — all with triggers) and `/settings` (`loaded` only).

**Stepper-mode prompt:**
```
Three-step onboarding at /onboarding.
Step 1: loaded .../a, loading .../b while validating email.
Step 2: loaded .../c, loading .../d on password submit, error .../e on password mismatch.
Step 3: loaded .../f.
```
Yields `step 1` (loaded + loading), `step 2` (loaded + loading + error), `step 3` (loaded only).

**Trigger missing → deferred to clarification:**
```
Loading state for /dashboard is https://figma.com/.../b
```
Yields one row `{host: "/dashboard", state: "loading", figma_url: ".../b", trigger: "MISSING"}`. The clarification phase will ask "When does the loading state show for /dashboard?".

**Error stub declaration:**
```
/dashboard: loaded is https://figma.com/.../a, plus an error state
(no design yet) for when the fetch fails.
```
Yields `/dashboard` `loaded` (with URL) plus `error` as `{stub: true, trigger: "when the fetch fails"}`.

**Initial-state declaration (pre-fetch render):**
```
/search — initial view is https://figma.com/.../a (before the user types),
loaded is https://figma.com/.../b, loading .../c while querying Algolia,
empty .../d when no results.
```
Yields `/search` with four rows in alphabetical order: `empty` (with URL, no trigger), `initial` (with URL, no trigger), `loaded` (with URL, no trigger), `loading` (with URL, trigger `"while querying Algolia"`). The `initial` row never enters trigger clarification.

**Hybrid-mode prompt (standalone route + stepper group, both with full variant coverage):**
```
/dashboard with loaded https://figma.com/.../a,
loading https://figma.com/.../b while fetching dashboard data,
empty https://figma.com/.../c when the user has zero items,
and error https://figma.com/.../d if the fetch returns 5xx.

Plus a multi-step /checkout.
Step 1: loaded https://figma.com/.../e,
loading https://figma.com/.../f while confirming cart totals,
empty https://figma.com/.../g when the cart is empty,
error https://figma.com/.../h on payment provider failure.
Step 2: loaded https://figma.com/.../i.
```
Yields two hosts: `/dashboard` (route, 4 rows — `empty`, `error`, `loaded`, `loading` with triggers where required) and `/checkout` (stepper group, step 1 with 4 rows + step 2 with loaded only). Mode inference reads `step N` + bare route → `hybrid`. Phase 2a step 6a attaches the `/dashboard` block to `pages[dashboard].state_variants` and the `/checkout step 1` block to `stepper_groups[checkout].steps[0].state_variants` — the two hosts never share slots and never cross-contaminate.

### Failure modes

- **F-FLOW-VARIANTS-FORMC-UNSUPPORTED** — state variants declared alongside `Step: <entry-url>` (Form C). MVP scope; deferred to P3.1. STOP AND ASK the user to either (a) drop the state variant language and let the flow ship as loaded-only, or (b) switch to explicit `Step N:` form.
- **F-FLOW-VARIANTS-COLLISION** — two URLs for the same `(host, state)` pair. STOP AND ASK, showing both URLs.
- **F-FLOW-VARIANTS-ORPHAN-URL** — a URL was mentioned with a state keyword but no recognisable host. Likely the prompt lacks a route / step anchor. STOP AND ASK with the failing sentence quoted.
- **F-FLOW-VARIANTS-STUB-NON-ERROR** — the user declared a state without a URL for `loaded`, `loading`, `empty`, or `initial` (only `error` may be a stub). STOP AND ASK.

### Fallback: sibling-name detection

When prompt extraction finds a `loaded` URL for a host but no URL for one or more of `loading` / `empty` / `error` / `initial`, opportunistically scan the primary frame's Figma parent for siblings whose names match the canonical vocabulary (`Dashboard — Loaded` / `Dashboard — Skeleton` / `Dashboard — Empty State` / `Dashboard — Error` / `Dashboard — Idle`). This is a secondary path — it never overrides an explicit URL from the prompt.

**When to fire:**
- Phase 1b extraction produced a `loaded` entry for the host, AND
- One or more of `loading` / `empty` / `error` / `initial` is absent from the host's extracted rows, AND
- The user did NOT pass `mode: no-fallback` (a per-flow opt-out directive).

**How to fire:**
1. Identify the primary frame's `parent_node_id`. This is NOT in the Phase 2a fixture (which carries only `top_level_children`), so a live Figma call is required: `mcp__Figma__get_design_context(parent_node_id)`. The response must carry a `children[]` array where each entry has at minimum `{node_id, name}`.
2. Walk `children[]` and classify each sibling against the canonical state vocabulary below. For each sibling whose name matches a state keyword (case-insensitive, whitespace-and-punctuation-tolerant — so `Home — Empty State`, `home_empty_state`, and `HomeEmptyState` all classify the same way):
   - Pick the **longest** matching keyword phrase when multiple match (so `"empty state"` beats `"empty"`).
   - **Whole-word matches outrank substring matches** (so `"loading"` matches `Home — Loading` but not `Home — Reloading`).
   - Skip siblings whose `file_key` differs from the primary's (cross-file rejection — BFS-over-one-parent always shares the file key, so a mismatch is structural).
   - Build a result map `found[slot] = { node_id, figma_url, file_key }` per matched sibling. When two siblings match the same slot, the LATER one wins and the earlier becomes a `collision` entry — record both for §step 5 below.
   - Build `unmatched_siblings[] = [{node_id, name, candidate_slot?}]` for siblings whose names contained a state-like word but didn't fully match (e.g. `"Skeleton View"` partially matches `loading` keywords; `candidate_slot: "loading"` so the user can confirm).
3. Merge `result.found[slot]` into the host's IR `state_variants[slot]` ONLY for slots that were absent from prompt extraction. Prompt-derived entries always win.
4. Surface `result.unmatched_siblings[]` in the §"Clarification phase" (Phase 2a step 2d): "I also saw these sibling frames but couldn't classify them — tell me which, if any, belong to a state variant: <list>". Collision entries (two siblings matching the same slot) are shown with both URLs so the user picks one.
5. **Stage audit warnings (P2.4).** After the clarification phase resolves, record the leftover ambiguities on `flow_graph._pending_audit_warnings[]` so Phase 4 can persist them into `audit.json.warnings[]` (see §"Warnings surface (P2.4)"):
   - For every entry in `result.unmatched_siblings[]` the user did NOT attach to a slot, push `{ kind: "fallback_unmatched_sibling", route: "<host route>", node_id: "<sibling node_id>", recommendation: "Rename the Figma frame to match a state keyword (e.g. 'Skeleton', 'Empty State', 'Error') or attach it explicitly in the prompt, then re-run /d2c-build-flow.", details: { name: "<sibling name>", candidate_slot: "<detector's best-guess slot, if any>" } }`. Omit `slot` because the siblings were NOT assigned.
   - For every collision entry (a sibling whose detected slot was already filled by another sibling or by prompt extraction), push `{ kind: "fallback_collision", route: "<host route>", slot: "<colliding slot>", node_id: "<losing sibling node_id>", recommendation: "Two frames match the <slot> slot for <route> — disambiguate by renaming one (or removing it from the parent section) before the next run.", details: { name: "<losing sibling name>", other_node_id: "<winning node_id>" } }`.
   These entries drain into `audit.json.warnings[]` during Phase 4's audit-seeding pass (see §"Warnings surface" rule 2). `_pending_audit_warnings` is in-memory only and never serialised into `flow-graph.json`; when Phase 4 is skipped (rare — e.g. `--plan-only`), Phase 4 itself stages the list to the sidecar `<run-dir>/flow/pending-audit-warnings.json` so the next Phase 4 run can drain it.

**What the detector matches** (mirrors Phase 1b vocabulary — `loaded` keywords are NOT matched because the primary is always the loaded frame):
- `loading`: loading, skeleton, fetching, pending, placeholder, shimmer, spinner
- `empty`: empty, no data, zero state, null state, blank state, nothing to show
- `error`: error, failed, failure, broken, crashed, fallback, something went wrong
- `initial`: initial, idle, pre-fetch, pristine, untouched, not started

Whole-word matches outrank substring matches; longest phrase wins when multiple fire. Case-insensitive, whitespace- and punctuation-tolerant (so `Home — Empty State` and `home_empty_state` both classify the same way).

**Cross-file rejection:** siblings whose `file_key` differs from the primary's are dropped silently — BFS-over-one-parent always shares the primary's file key, so a mismatch is a structural error rather than a naming ambiguity.

**Limitations:**
- The detector does NOT guess triggers — every slot it populates still needs a trigger when required (only `loading` and `error`), so §"Clarification phase" still asks "When does `<state>` show for `<host>`?" for every newly-populated `loading` / `error` row. `empty` and `initial` rows are trigger-free and never enter clarification.
- False positives are possible — "PendingTasksCard" would substring-match the `loading` → `pending` keyword, and "InitialPageTitle" could substring-match the `initial` slot. The confirmation gate (Phase 2a step 2d) surfaces every detected entry for explicit approval before dispatch, so false positives are user-visible and correctable, not silent.

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
   - **Procedure:** for each page, list its `top_level_children` from `get_design_context`. Build a per-component-instance frequency map keyed on `componentId` (or `mainComponentId` for instances). The component(s) with frequency ≥ ⌈0.75 × page_count⌉ are shared shells; those below are page-specific. When the highest frequency is below the threshold, set `layouts: []` and `divergent: true` (the signal to fire `F-FLOW-SHELL-DIVERGENT`).
   - **Stepper-indicator sub-detection.** Within the identified shared shell, scan each top-level child's `descendants[]` for a repeated component instance whose `variant` (or `properties.step`/`index`/`current`) differs per page in an ordered way. When found, attach a `stepper_indicator` object to the layout entry capturing `component_id`, `node_ids_per_page`, `variants_per_page`, and `ordered: true|false` (true when the variants form a monotonic sequence like `step=1, step=2, step=3`). This feeds mode detection and stepper codegen.

3a. **Mode resolution.** When Phase 1 returned `mode !== "auto"`, carry the declared value through to `flow-graph.mode` and set `mode_source = "explicit"`. When `mode === "auto"`, run the 5-signal mode-detection procedure below to resolve to one of `routes` / `stepper` / `hybrid`.

   **Inputs you'll need:**
   - `pages[]` — each entry carries `node_id`, `figma_url`, `frame_size` from `get_design_context`, optional `differential_region` (derived by subtracting the shared-shell bbox from the frame bbox and reporting the leftover area ratio + bbox), and `prototype_edges[]` from the prototype metadata.
   - `shell_result` — the §step 3 output, **re-evaluated at the stricter threshold of 0.9** for mode detection (stepper coverage bar is higher than the layout-detection default).
   - `explicit_groups` — any `Stepper group` blocks already parsed.

   **The 5 signals** — score each in [0, 1] independently. The final `mode_confidence` is a weighted sum (weights below); `detected_mode` is the leading classification each signal points at, picked by majority weighted vote.

   | # | Signal | What it measures | Score formula | Stepper-leaning when |
   |---|---|---|---|---|
   | 1 | `frame_size_uniformity` | All step frames have nearly identical width × height | `1 - stddev(sizes) / mean(sizes)` clamped to [0,1] | uniform sizes (>0.95) |
   | 2 | `shared_shell_coverage` | Fraction of pages containing the shell at threshold 0.9 | `pages_with_shell / total_pages` | ≥0.9 |
   | 3 | `stepper_indicator_instance` | Layout has a `stepper_indicator` with `ordered: true` and 1 variant per page | `1.0` if present and ordered, else `0.0` | present + ordered |
   | 4 | `differential_region_geometry` | The leftover (non-shell) area is the same bbox across pages | `iou(bbox_i, bbox_j)` averaged across all pairs | ≥0.85 |
   | 5 | `prototype_semantics` | Prototype connections form a linear chain from one frame to the next, all with the same trigger | `chain_length / (pages-1)` (1.0 when fully chained) | ≥0.9 |

   Weights: signals 2 and 3 weight 0.30 each (shell coverage + stepper indicator are the strongest tells); signals 1, 4, 5 weight 0.13–0.14 each. Sum to `mode_confidence` ∈ [0, 1].

   **Mode pick:**
   - `mode_confidence ≥ 0.55` AND signals 2+3 both lean stepper → `detected_mode = "stepper"`.
   - `mode_confidence ≥ 0.55` AND only some pages lean stepper (partition) → `detected_mode = "hybrid"` with the partitioned runs.
   - `mode_confidence ≥ 0.55` AND no stepper indicators → `detected_mode = "routes"`.
   - `mode_confidence < 0.55` → `aborted = true`. Fire **F-FLOW-MODE-UNDECIDABLE** and STOP AND ASK the user to pass `mode:` explicitly. Include the per-signal scores verbatim.

   Persist on the IR: `mode`, `mode_source: "auto"`, `mode_confidence`, `mode_detection_reasons[]` (one entry per signal: `{signal, score, weight, contributed}`).

   **Bands for handling:**
   - **`band: "silent"` (`mode_confidence ≥ 0.80`):** write the result into the IR, log a single-line notice, proceed.
   - **`band: "advisory"` (`0.55 ≤ mode_confidence < 0.80`):** write the result, print a prominent warning with the signal breakdown, proceed.
   - **`band: "abort"` (`mode_confidence < 0.55`):** as above — fire **F-FLOW-MODE-UNDECIDABLE**.

   When `mode` resolves to `stepper` with no explicit `Stepper group` blocks, synthesise a single implicit group named after the flow (PascalCase of `flow_name`) containing all top-level steps. When `mode` is `hybrid`, keep explicit groups as-is; when the detector returns additional stepper runs beyond what the user declared, merge them into `stepper_groups[]` with `detected_mode_run: true` for observability.

   Finally, for every stepper group (explicit or detected), insert a single virtual `pages[]` entry with `page_type: "stepper_group"`, `node_id: "stepper:<hash>"`, `route` equal to the group's route, `stepper_group_ref` equal to the group's name, and drop the group-internal steps from `pages[]` — those steps live only in `stepper_groups[*].steps[]`.

4. **Edges.** Behaviour depends on `auto_discovered`, branch suffixes, and stepper groups:
   - **Linear declared steps (`auto_discovered === false`, no branches, no stepper groups):** emit one linear edge per consecutive pair of pages:
     - `from_node_id = pages[i].node_id`, `to_node_id = pages[i+1].node_id`.
     - `trigger = "onClick"`, `source_component_node_id = null`, `inferred = true`, `condition = null`.
     - v1 does not populate `source_component_node_id` in this mode — identifying the Next button is deferred to the per-page Phase 2 (where it lands on `component-match.link_target` instead).
   - **Stepper-group internal edges (mode: stepper or hybrid):** do NOT add entries to `flow-graph.edges[]`. Inside a stepper group the "next step" action is represented at the page level via `stepper_groups[i].steps[]` order, and at the button level via `link_target.edge_kind = "step_delta"` set by Phase 2b's link-target prose (§Phase 2b step 3). The stepper-group virtual page may still have outgoing edges into the next top-level page (route-mode exit), and those ARE recorded in `edges[]` as normal.
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

6a. **Attach state variants.** Consume the extraction table from Phase 1b and populate `state_variants` on the corresponding pages / stepper steps. Rules:
   - Pair every extraction row to its host by (route) for routes-mode rows, or by (stepper_groups[].name, step_ref) for stepper/hybrid rows. An unmatched row → fire **F-FLOW-VARIANTS-UNMATCHED-HOST** and STOP AND ASK with the row quoted.
   - For the `loaded` slot: reuse the host's own `node_id` + `figma_url` (do not re-parse — identity with the host is enforced by the validator).
   - For `loading`, `empty`, `error`: parse `file_key`, `node_id` from the supplied URL (same extraction as step 2's URL parsing). Carry `trigger` verbatim.
   - For error stubs: emit `{ stub: true, trigger }` and leave `node_id`/`figma_url` unset (validator enforces the mutex).
   - If a host ends up with only a `loaded` row, **omit the `state_variants` key entirely** from that page/step. This keeps loaded-only flows byte-identical with the pre-state-variants IR (identity gate, P0.8).
   - Serialize each `state_variants` object with keys in alphabetical order (`empty`, `error`, `loaded`, `loading`) — P2.3 hardens this via the validator's normaliser; step 6a relies on the producer emitting them in order in MVP.

6b. **Project convention detection.** When at least one page/step carries a `state_variants` block, scan the project root for the three conventions Phase 3 needs to know about. Skip this step entirely when no host declared `state_variants` — loaded-only flows do not need convention data and the validator forbids the block in that case.

   **`component_type`** — `"server" | "client" | "mixed"`:
   - Count files under `app/**` and `src/app/**` that contain `'use client'` at the top vs files without it.
   - Mostly-server (≥80% no `'use client'`) → `"server"`. Mostly-client (≥80% with `'use client'`) → `"client"`. Otherwise → `"mixed"`.

   **`error_boundary.kind`** — `"next-file-convention" | "react-error-boundary" | "custom-class" | "none"` plus optional `import_path`:
   - Glob for `app/**/error.tsx` or `app/**/error.jsx` (or `src/app/**/error.{tsx,jsx}`). If any exist → `{kind: "next-file-convention", import_path: null}`.
   - Else grep `package.json.dependencies` for `react-error-boundary`. If present → `{kind: "react-error-boundary", import_path: "react-error-boundary"}`.
   - Else grep src files for a class component extending a name like `*ErrorBoundary*`. If present → `{kind: "custom-class", import_path: "<resolved import path>"}`.
   - Else → `{kind: "none", import_path: null}`.

   **`data_fetching.kind`** — `"server-component-fetch" | "react-query" | "swr" | "custom-hook" | "none"` plus optional `example_import`:
   - Grep `package.json.dependencies`: `@tanstack/react-query` → `{kind: "react-query", example_import: "@tanstack/react-query"}`. `swr` → `{kind: "swr", example_import: "swr"}`.
   - Else grep src files for `async function` server components that call `fetch(`. If common (≥3 hits) → `{kind: "server-component-fetch", example_import: null}`.
   - Else grep for repeated `useFetch` / `useApi` / `useGet*` patterns. If found → `{kind: "custom-hook", example_import: "<resolved import>"}`.
   - Else → `{kind: "none", example_import: null}`.

   Write the resolved block verbatim into `flow_graph.project_conventions`.

6c. **Clarification phase.** After extraction + convention detection, resolve the unknowns:
   1. For every extraction row with `trigger === "MISSING"`, ask: *"When does the `<state>` state show for `<host>`? (e.g. during initial data fetch, during form submission, on a specific action, other.)"* — one question per missing trigger, serialised top-to-bottom. Write the user's answer back into the row's `trigger` field.
   2. When `project_conventions.component_type === "mixed"` AND the user prompt did not specify `'use client'` preference, ask: *"The project mixes Server and Client Components. Which should the generated pages be? (a) Server Components (async, data fetched on the server), (b) Client Components ('use client', data fetched in hooks)."* — normalise the answer to `server` or `client` and overwrite `component_type`.
   3. When `project_conventions.error_boundary.kind === "none"` AND at least one page declares a non-stub `error` variant, ask: *"No error boundary was detected in the project. Options: (a) add `react-error-boundary` as a dependency and wire it in, (b) use the Next.js `error.tsx` file convention, (c) skip error-boundary wiring and render the error variant unconditionally at the data branch."* — overwrite `error_boundary` with the user's choice (`react-error-boundary` → install on first generation; `next-file-convention` → rely on file system; `none` → keep but record the user opted out so Phase 3 doesn't add imports).
   4. When `project_conventions.data_fetching.kind === "none"` AND at least one page declares `loading` or `error`, ask: *"No data-fetching library was detected. Options: (a) plain `fetch` inside async Server Components (default for Next.js), (b) `@tanstack/react-query`, (c) `swr`, (d) use a project-specific hook (paste the import)."* — overwrite `data_fetching` with the chosen kind + example_import.
   5. **Confirmation table.** Print the final resolved plan and STOP AND ASK `y = proceed / e = edit prompt / n = abort`. Skip when `--yes` is in `$ARGUMENTS`.

   Format:

   ```
   State variants:
     /dashboard      loaded   https://figma.com/.../a   —
     /dashboard      loading  https://figma.com/.../b   while fetching user dashboard data
     /dashboard      error    https://figma.com/.../c   when the fetch returns 5xx
     /settings       loaded   https://figma.com/.../d   —

   Project conventions (detected):
     component_type: server
     error_boundary: next-file-convention
     data_fetching:  server-component-fetch

   Proceed? [y / e / n]
   ```

   Rules:
   - `y` → continue to step 7.
   - `e` → return control to the user for prompt edits; on resume, re-run Phase 1 + 1b + 2a from the top.
   - `n` → stop cleanly with "aborted at variant-confirm gate".
   - `--yes` short-circuits to `y` but still prints the table for audit.

6d. **Attach mobile variants from Phase 1.5.** When `flow_intake.mobile.enabled === true`, walk the `flow_intake.mobile.urls_by_step_index` map and attach each entry to the matching host's `mobile_variant`:

   - The 0-based step index keys this map. Resolve the index to a host by walking the declared step order: every entry in `pages[]` (filtered to `page_type === "page"`) followed by every step in each `stepper_groups[*].steps[]` in declared order. Index 0 is the first declared step, regardless of whether it's a route page or a stepper step.
   - For each `(index, mobile_url)` pair, parse `node_id` and `file_key` from the URL (same extraction as step 2's URL parsing). Construct `mobile_variant: { figma_url: mobile_url, node_id, file_key }`.
   - Write the block onto the matching host (`pages[i].mobile_variant` for route pages and overlays; `stepper_groups[g].steps[s].mobile_variant` for stepper steps). The schema accepts `mobile_variant` on both shapes.
   - **Skip indices** are absent from the map (the user wrote `skip` on that line in §1.5b Q7). Hosts at those indices ship desktop-only — no `mobile_variant` written.
   - When `flow_intake` is absent (`--yes` was passed) OR `flow_intake.mobile.enabled === false`, this step is a no-op. Pre-existing per-step `mobile:` directives from Phase 1 (the inline opt-in form, see §"Optional `mobile:` directive") still apply — Phase 1.5 only fills in mobile variants the user did NOT supply inline. A collision between a Phase 1 inline `mobile:` URL and a Phase 1.5 URL for the same step fires **F-FLOW-MOBILE-DOUBLE-SOURCE** (stop-and-ask, surface both URLs).

   The downstream `mobile_variant` codegen path (`framework-react-next.md` §"Mobile variants") and Phase 4 dual-viewport pixel-diff are unchanged — they read `mobile_variant` regardless of whether the URL came from a Phase 1 inline directive or Phase 1.5 bulk collection.

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

9. **Freeze + emit `flow-decisions-lock.json`.** After successful validation, treat `flow-graph.json` as immutable for all subsequent phases. Any need to change it during Phase 3+ requires STOP AND ASK per flow-rule #8.

   Immediately after `flow-graph.json` validates, emit a per-decision lock file alongside it so Phase 3 / 4 / 5 retries CANNOT silently re-decide a flow-level choice (mode, shell, project_conventions, stepper_groups, per-page route / layout / mobile_variant, per-edge source_component / trigger / condition). Schema at `skills/d2c-build-flow/schemas/flow-decisions-lock.schema.json`; emitter at `skills/d2c-build-flow/scripts/write-flow-lock.js`. Run:

   ```bash
   node skills/d2c-build-flow/scripts/write-flow-lock.js <run-dir>/flow/flow-graph.json
   ```

   The writer is deterministic (same input + same `--locked-at` produces a byte-identical lock) and uses atomic file ops (write to `<path>.tmp.<pid>.<ts>`, then rename). Default output path is the sibling `<run-dir>/flow/flow-decisions-lock.json`.

   **Lock entry lifecycle** (mirrors `skills/d2c-build/schemas/decisions-lock.schema.json`): every locked decision starts with `status: "locked"`. Phase 3 / 4 / 5 read the lock before any edit; a mismatch between a `status: "locked"` value and the current `flow-graph.json` value fires **F-FLOW-LOCK-CONFLICT** (stop-and-ask). The user can either revert the IR or mark the entry `status: "failed"` (which permits re-decision and records `failed_by: "phase3_codegen" | "phase4_walker" | "phase4b_navsmoke" | "phase5_audit" | "user_override"`). On the next Phase 2a re-emit, failed entries are re-locked with their new value.

   **Verification.** Phase 3 / 4 / 5 verify the lock against the current IR before proceeding:

   ```bash
   node skills/d2c-build-flow/scripts/validate-flow-graph.js <run-dir>/flow/flow-graph.json \
     --verify-lock <run-dir>/flow/flow-decisions-lock.json
   ```

   The validator emits `lock: ok` or `lock: fail` plus one `error: flow-decisions-lock — F-FLOW-LOCK-CONFLICT — <decision_path> — locked=<value> current=<value>` line per mismatch. A missing or stale lock (hash drift) fires **F-FLOW-LOCK-MISSING** (auto-recover; regenerate the lock and retry once).

---

## Phase 2 — Per-page IR (delegated)

For each page in `flow-graph.pages[]` (in order):

1. Set the run directory to `.claude/d2c/runs/<ts>/pages/<node_id>/`.
2. Run the existing `/d2c-build` Phase 2 emit + validate process for the **loaded** frame. Inputs: the page's `figma_url`, the project's design tokens, the framework reference file.

2a. **Per-variant dispatch.** If the page carries a `state_variants` block, iterate the non-`loaded`, non-stub slots in alphabetical order (`empty`, then `error`, then `loading`) and dispatch `/d2c-build` in structured-input mode for each. Stub error entries are handled by Phase 3 codegen directly — do not dispatch for them.

   For each slot:
   - Set the per-variant run directory to `.claude/d2c/runs/<ts>/pages/<node_id>/variants/<slot>/`.
   - Derive the `component_name` as `<PageName><SlotPascal>` (e.g. `DashboardLoading`, `DashboardEmpty`, `DashboardError`).
   - Derive the `output_path` from `project_conventions` (see §Phase 3 §"State variants" in the framework reference — `next-file-convention` Server projects land `loading.tsx` / `error.tsx` at the route segment; Client projects land `_loading.tsx` / `_error.tsx` siblings; empty always lives inline inside the loaded component).
   - Build the structured payload, propagating `flow_intake` answers (Phase 1.5) when present:
     ```json
     {
       "figma_url": "<slot.figma_url>",
       "component_name": "<derived>",
       "output_path": "<derived>",
       "semantic_role": "<slot>",
       "trigger": "<slot.trigger or null for empty>",
       "project_conventions": <flow_graph.project_conventions>,
       "parent_flow_run": "<.claude/d2c/runs/<ts>/flow/>",
       "what":                "<flow_intake.what or 'page'>",
       "mode":                "<flow_intake.mode or 'functional'>",
       "viewports":           "<flow_intake.viewports or 'desktop-only'>",
       "components_to_reuse": "<flow_intake.components_to_reuse or 'use what makes sense'>",
       "has_api_calls":       "<flow_intake.has_api_calls or 'no'>",
       "api_calls":           "<flow_intake.api_calls or omit>"
     }
     ```
     When `flow_intake` is absent (the user passed `--yes`), every right-hand side falls back to the literal default shown — matching the pre-Phase-1.5 behaviour byte-for-byte. When `flow_intake` is present, the answers REPLACE every default; the per-page / per-step dispatch never silently re-invents an answer the user already gave.
   - Validate it: `node skills/d2c-build/scripts/parse-structured-input.js <payload-file>`. Non-zero exit → regenerate from extraction data, retry up to 2 times, then fire **FX-UNKNOWN-FAILURE**.
   - Invoke `/d2c-build` with the validated payload (Phase 1.0 detects the structured input and skips the Q&A gates). The per-variant `component-match.json` lands in the variant's run directory alongside the loaded page's.
   - The loaded variant's `component-match.json` continues to live at `.claude/d2c/runs/<ts>/pages/<node_id>/` — not under `variants/loaded/`. This keeps loaded-only pages' layout unchanged (identity gate, P0.8).

   For stepper groups with per-step `state_variants`, apply the same loop inside each step's Phase 2b pass. The per-step run directory becomes `.claude/d2c/runs/<ts>/pages/<group_node_id>/steps/<step_node_id>/variants/<slot>/`.

3. **Link-target enrichment.** After `component-match.json` is emitted, identify the navigation button on this page using the procedure below — call this `pickLinkTarget(component_match, target)` for short. The `target` is exactly one of:
   - `toNodeId` — the next page's node id (route navigation).
   - `stepDelta` — a signed integer, typically `+1` (Next) or `-1` (Back), for stepper-internal advancement.

   **Heuristic:**
   1. Filter `component_match.nodes` to entries whose `chosen` is non-null AND whose `figma_type` is one of `INSTANCE` / `COMPONENT` / `FRAME` (likely-clickable shapes).
   2. Score each candidate by `figma_name` regex match:
      - For `stepDelta > 0` (forward) OR `toNodeId`: match `/next|continue|submit|finish|done|confirm/i`. Higher score for whole-word match.
      - For `stepDelta < 0` (back): match `/back|previous|prev|return/i`. Higher score for whole-word match.
   3. Tie-break by primary-button heuristic: nodes whose `chosen` matches a component named `Button` / `PrimaryButton` / `CTA` get +1.
   4. Pick the highest-scoring node. If max score is 0, return `null` (no link target — emit a TODO comment per flow-rule #9).

   Populate `component-match.nodes[<chosen-node-id>].link_target` from the returned descriptor:
   - Always: `page_node_id = <this page's node_id>`, `trigger` = `"onClick"` (use `"onSubmit"` only when the chosen node is inside a `FORM` region).
   - `edge_kind: "route"` + `to_node_id` when the call was `pickLinkTarget(cm, {toNodeId})`.
   - `edge_kind: "step_delta"` + `step_delta` (signed int) when the call was `pickLinkTarget(cm, {stepDelta})`. No `to_node_id` is written for step-delta edges — Phase 3 reads the step order from `stepper_groups[*].steps[]`.

   For stepper-group virtual pages, run `pickLinkTarget` **per step frame** (each step's own `component-match.json`), once with `{stepDelta: +1}` and once with `{stepDelta: -1}`, so every step carries its own Next/Back wiring.

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
   - If the page is `page_type: "stepper_group"`, the flow emits exactly two files itself — the orchestrator (`app/<group_route>/page.tsx`) and the state context (`app/<group_route>/state/<Group>Context.tsx`) — and **delegates every step body to `/d2c-build` Phase 3**, one dispatch per step. Per §"Stepper groups (single-route multi-step)" in `framework-react-next.md`, each step body is a presentational component at `app/<group_route>/steps/Step<N>.tsx` produced by `/d2c-build` in `what: "component"` mode. The orchestrator imports each step component and wires the provider's `next()` / `back()` / `validity` to the step's `onNext` / `onBack` / `onValidityChange` props. **Why this delegation matters:** every step body now passes through the same six non-negotiables enforcement that route-mode pages already get from `/d2c-build` Phase 3 (reuse, tokens, conventions, library selection, locked decisions, design-tokens drift) — closing the parity gap with route-mode pages.

     For each step (in `stepper_groups[g].steps[]` order), build the structured payload, propagating `flow_intake` exactly the same way as the per-variant dispatch in §Phase 2 step 2a above:

     ```json
     {
       "figma_url": "<step.figma_url>",
       "component_name": "<Group>Step<N>",
       "output_path": "app/<group_route>/steps/Step<N>.tsx",
       "what": "component",
       "semantic_role": "loaded",
       "trigger": null,
       "project_conventions": <flow_graph.project_conventions>,
       "parent_flow_run": "<.claude/d2c/runs/<ts>/flow/>",
       "mode":                "<flow_intake.mode or 'functional'>",
       "viewports":           "<flow_intake.viewports or 'desktop-only'>",
       "components_to_reuse": "<flow_intake.components_to_reuse or 'use what makes sense'>",
       "has_api_calls":       "<flow_intake.has_api_calls or 'no'>",
       "api_calls":           "<flow_intake.api_calls or omit>"
     }
     ```

     Validate via `parse-structured-input.js` and dispatch as today. The step body is emitted as a pure presentational component — no `'use client'` directive of its own, no router imports, no provider imports. It receives `{ onNext, onBack, onValidityChange?, optional?: boolean }` as props (see `framework-react-next.md` §"Step component prop contract"). The orchestrator owns the provider context and forwards advance/back actions.

     **State variants on stepper steps:** when a step carries `state_variants`, the per-variant dispatch in §Phase 2 step 2a fires per slot at `app/<group_route>/steps/Step<N><Slot>.tsx`. Phase 3 then composes them inside `Step<N>.tsx` per §"Per-step state variants" in `framework-react-next.md`. Path A (Next file convention) does not apply to stepper steps — `loading.tsx` / `error.tsx` are per-route-segment and cannot target a step index inside a single-route stepper. Steps without `state_variants` render unwrapped so the identity guarantee holds for loaded-only steppers.

     **Mobile variants on stepper steps:** when the step's `mobile_variant` is set (Phase 1.5 §1.5b Q7 or a Phase 1 inline `mobile:` directive), the structured payload above adds `viewports: "multiple"` regardless of the flow-level answer, and `/d2c-build`'s Phase 4 dual-viewport pixel-diff fires for the mobile frame as it does for any responsive component. The orchestrator and state context never carry a `mobile_variant` — only step bodies do.

### Rules carried over from `/d2c-build`

All six non-negotiables apply per page exactly as in `/d2c-build`. Reuse, tokens, conventions, library selection, locked-decision respect — unchanged.

### Flow-specific rules

- **No invented chrome.** If a page has no button wireable to the outgoing edge, DO NOT inject one. Emit a TODO comment and keep pixel fidelity.
- **Placement.** Layout + `state/` + `_components/` all live at the longest common route prefix of the pages they serve. When pages don't share a common prefix, fall back to per-page layouts and no shared state.
- **Conventions precedence.** If the project's `conventions` say `declare` via `function` but the layout template in the framework reference uses `default export function`, prefer the project convention (it's more strict).

---

## Phase 4 — Visual Verification

Phase 4 runs in **two passes**: a single Playwright **flow-walker** that pixel-diffs every host's `loaded` slot end-to-end (4a), then per-variant `/d2c-build` Phase 4 dispatches for `loading` / `empty` / `error` / `initial` slots that need their own URL visit (4b). The walker subsumes today's per-host loaded dispatch — instead of N independent `page.goto(URL)` runs, one walker drives the real user path: visit start → screenshot → click Next → screenshot → click Next, etc.

This collapses three problems at once:
1. **Stepper-step pixel-diff parity** — every step's loaded body gets diffed without needing a fragile `click-next` payload field on `/d2c-build`.
2. **Validation forms get exercised** — auto-fixture data fills `validate: form` steps so Next becomes clickable, which is closer to a real user run than mocking validation off.
3. **Inter-step regressions are caught** — a step that renders fine in isolation but breaks the stepper context (e.g. setField clobbering shared state) shows up here, where today's per-host dispatch couldn't see it.

### Flow-level audit file (required)

Before running either pass, create `<run-dir>/flow/audit.json` with `{"pages": [], "warnings": []}`. Both passes append to this file — the walker writes loaded rows directly; per-variant `/d2c-build` dispatches append non-loaded rows via `audit_path` (today's mechanism).

### 4a — Flow-Walker Pixel-Diff (loaded path)

Goal: in one Playwright run, walk the entire flow's loaded path, screenshot each host, pixel-diff against the corresponding Figma export, and auto-fix divergences up to `--max-rounds`.

#### 4a.0a Pre-flight: dependency check

Before generating the walker spec, checking the checkpoint, or running any pixel-diff round, verify the three runtime dependencies the walker uses are reachable. Run these three commands; **any non-zero exit** = the corresponding dep is missing:

```bash
# 1. pixelmatch (consumed by pixeldiff.js)
node -e "try { require('pixelmatch'); } catch { try { require(require('child_process').execSync('npm root -g').toString().trim() + '/pixelmatch'); } catch (e) { process.exit(1); } }"

# 2. pngjs (consumed by pixeldiff.js)
node -e "try { require('pngjs'); } catch { try { require(require('child_process').execSync('npm root -g').toString().trim() + '/pngjs'); } catch (e) { process.exit(1); } }"

# 3. Playwright (the walker spec runs via @playwright/test)
node -e "try { require('@playwright/test'); } catch { process.exit(1); }" || npx --no-install playwright --version >/dev/null 2>&1
```

The two `node -e` checks mirror `pixeldiff.js`'s own resolution order: local first, fall back to global `node_modules`. The third command accepts either a local devDep OR an `npx playwright` reachable on PATH.

On any non-zero exit, fire **F-FLOW-WALKER-DEPS-MISSING** (auto-recover). The recovery is a single install pass:

```bash
# Globals are where /d2c-init puts them
npm install -g pixelmatch pngjs
# Playwright is a project devDep
npm install -D @playwright/test
```

Re-run all three checks. If anything is still missing after the install pass, escalate to **PX-RETRY-EXHAUSTION** with the install error in the user prompt — likely a permissions / registry / network issue the user has to resolve.

Why this is its own pre-flight step instead of failing mid-walker: the walker emits dozens of `test()` blocks and a single missing dep would crash all of them with the same opaque `Cannot find module '...'` error, leaving no clean recovery path. Running the preflight once at the top fails fast and routes through the standard auto-recover protocol.

#### 4a.0b Auth detection + handling

After the dependency check passes, scan the project for an auth system. The walker needs to know whether the routes it's about to screenshot are behind a login wall — if they are, every pixel-diff will silently render the login page instead of the actual host.

**Detection** — run these checks in order; first match wins. Each maps to a `system` value:

1. **`next-auth`** — `package.json` `dependencies["next-auth"]` exists, OR `app/api/auth/[...nextauth]/route.ts` exists, OR `auth.ts` / `auth.config.ts` exists at the project root or under `src/`.
2. **`clerk`** — `package.json` `dependencies["@clerk/nextjs"]` exists, OR `<ClerkProvider>` appears in `app/layout.tsx` (or `src/app/layout.tsx`).
3. **`supabase`** — any `package.json` dependency matches `^@supabase/auth-helpers-`, OR both `@supabase/ssr` AND `@supabase/supabase-js` are present.
4. **`middleware`** — `middleware.ts` (or `src/middleware.ts`, `.js` variants) exists.
5. **`none`** — none of the above. Skip the rest of this section.

Use Bash + Read + Glob to evaluate each rule. Example for the next-auth check:
```bash
[ -f package.json ] && node -e "const p = require('./package.json'); process.exit(p.dependencies?.['next-auth'] ? 0 : 1)" \
  || ls app/api/auth/\[...nextauth\]/route.* 2>/dev/null \
  || ls auth.ts auth.config.ts src/auth.ts src/auth.config.ts 2>/dev/null
```

When precedence resolves to `next-auth` / `clerk` / `supabase`, ALSO check `middleware.ts` for a `matcher` config — its parsed matchers feed `protected_routes` for the gating step below.

**Parsing middleware matchers** — when `middleware.ts` exists, extract its matcher list with a regex (look for `matcher\s*:\s*(\[…\]|['"`].+?['"`])`). Two forms appear in practice:
- Array: `matcher: ['/dashboard/:path*', '/admin/:path*']` — collect each quoted string.
- Single: `matcher: '/dashboard/:path*'` — collect the one string.

**Gating each flow route** — for each `flow-graph.pages[i].route`, compare against the parsed matchers:
- `/dashboard/:path*` covers `/dashboard` and `/dashboard/<anything>` (treat `:path*` as `(/.*)?`).
- `/admin` covers `/admin` exactly (no wildcards).
- Bare regex form `/(?!api|_next).*/` — pass through as a regex.

When `system !== "none"` AND no matcher parsed (e.g. Clerk via `<ClerkProvider>` without a route list), treat **every** flow route as potentially gated — better safe than silently broken.

**Login URL guess** — pick the first existing path:
- `clerk` → `/sign-in` (default).
- `next-auth` → `/api/auth/signin`.
- Others → check `app/login/page.tsx`, `app/sign-in/page.tsx`, `app/auth/login/page.tsx` (and `src/app/...` variants); fall back to `null` if none exist (the user will be asked).

**Default sign-in form selectors** (override per project via `<run-dir>/flow/walker-auth-config.json` if the login form is non-standard):
- email: `input[type='email'], input[name='email'], input[id='email']`
- password: `input[type='password'], input[name='password'], input[id='password']`
- submit: `button[type='submit'], button:has-text('Sign in'), button:has-text('Log in')`

**Decision tree:**

1. **`system === "none"` or `gated_routes === []`** → no-op. Proceed to §4a.0c (checkpoint resume).
2. **Auth detected AND `flow_intake.has_api_calls === "no"`** → emit a public-route bypass snippet for the user to apply manually. Fire **F-FLOW-WALKER-AUTH-BYPASS-INSTRUCTIONS** (inform). The snippet is system-specific:
   - **next-auth:** `auth.config.ts` `callbacks.authorized` exclusion for the gated routes.
   - **clerk:** `middleware.ts` `publicRoutes: [...]` array entries.
   - **supabase / middleware:** `middleware.ts` matcher exclusion.
   
   Write the snippet to `<run-dir>/flow/walker-auth-bypass.md` and pause for user confirmation (`Press Enter once applied`). Do NOT auto-edit the user's auth config — those files are security boundaries.
3. **Auth detected AND `flow_intake.has_api_calls === "yes"`** → require real login. Check for `D2C_TEST_USER` and `D2C_TEST_PASSWORD` in the project's `.env.local`:
   - **Both env vars present** → proceed to walker spec generation; emit a `loginBefore()` Playwright fixture in the spec (template below).
   - **Either env var missing** → fire **F-FLOW-WALKER-AUTH-DETECTED-NO-CREDS** (stop-and-ask). Show the gated routes, ask the user to add the env vars to `.env.local`, then re-run.

**`loginBefore()` Playwright fixture** — emitted into `<run-dir>/flow/flow-walker.spec.ts` when path 3 fires:

```ts
import { test as base } from "@playwright/test";

const LOGIN_URL = "<login_url from detector>";
const SELECTORS = <sign_in_form_selectors from detector or walker-auth-config.json override>;
const COOKIE_NAME_BY_SYSTEM = {
  "next-auth": "next-auth.session-token",
  "clerk": "__session",
  "supabase": "sb-access-token",
  "middleware": null, // unknown — fall back to URL redirect heuristic
};

const test = base.extend<{}>({
  page: async ({ page }, use) => {
    const user = process.env.D2C_TEST_USER;
    const password = process.env.D2C_TEST_PASSWORD;
    if (!user || !password) {
      throw new Error(
        "D2C_TEST_USER / D2C_TEST_PASSWORD missing — F-FLOW-WALKER-AUTH-DETECTED-NO-CREDS"
      );
    }
    await page.goto(LOGIN_URL);
    await page.locator(SELECTORS.email).fill(user);
    await page.locator(SELECTORS.password).fill(password);
    await page.locator(SELECTORS.submit).click();
    // Confirm session — either redirect away from login OR session cookie set.
    const cookieName = COOKIE_NAME_BY_SYSTEM["<system>"];
    const ok = await Promise.race([
      page.waitForURL((u) => !u.pathname.startsWith(LOGIN_URL), { timeout: 5000 }).then(() => true).catch(() => false),
      cookieName
        ? page.context().cookies().then((cs) => cs.some((c) => c.name === cookieName))
        : Promise.resolve(false),
    ]);
    if (!ok) {
      throw new Error("F-FLOW-WALKER-AUTH-LOGIN-FAILED");
    }
    await use(page);
  },
});
```

The fixture wraps every `test()` block — every host the walker pixel-diffs is rendered AFTER the login redirect resolves. If `loginBefore()` throws **F-FLOW-WALKER-AUTH-LOGIN-FAILED**, the walker halts before any pixel-diff runs (no point screenshotting login redirects).

#### 4a.0c Checkpoint resume

Before generating the walker spec or running any pixel-diff round, check whether a previous walker run was interrupted at this run-dir. The checkpoint contract is `<run-dir>/flow/walker-checkpoint.json`; schema at `skills/d2c-build-flow/schemas/walker-checkpoint.schema.json` (still authoritative — read it to know what shape to emit).

**Status check** — read the checkpoint and compare its hash against the current flow-graph:

```bash
CP=<run-dir>/flow/walker-checkpoint.json
GRAPH=<run-dir>/flow/flow-graph.json
if [ ! -f "$CP" ]; then
  STATE=missing
elif ! node -e "JSON.parse(require('fs').readFileSync('$CP','utf8'))" 2>/dev/null; then
  STATE=stale  # corrupted JSON
else
  CP_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CP','utf8')).flow_graph_hash)")
  GRAPH_HASH=$(shasum -a 256 "$GRAPH" | awk '{print $1}')
  if [ "$CP_HASH" = "$GRAPH_HASH" ]; then STATE=ready; else STATE=stale; fi
fi
```

Handle each state:

- **`STATE=missing`** — no checkpoint. Proceed to §4a.1 and start the walker fresh from host index 0.
- **`STATE=ready`** — checkpoint hash matches the current flow-graph. Read it (`Read $CP`) and ask the user:
  > "Previous walker run was interrupted at host {host_node_id} ({route}), viewport {viewport}, round {round}, score {score}%. Resume or start fresh?"
  
  - **Resume:** skip every host already in `checkpoint.rounds_completed[]` and re-run the current round at the recorded `(host_node_id, viewport, round)`. Snapshots from earlier rounds remain intact under `<run-dir>/flow/walker-snapshots/<host_node_id>/round-<N>/` so regression revert still works on the resumed round.
  - **Start fresh:** delete `$CP` AND restore every file in `checkpoint.files_touched[]` from its earliest snapshot (use `cp` from `<run-dir>/flow/walker-snapshots/<host>/round-1/<absolute-path-stem>` back to `<absolute-path>`) before starting Phase 4a from scratch. This ensures "start fresh" doesn't leave half-edited orchestrator/state-context files behind.
- **`STATE=stale`** — checkpoint exists but its `flow_graph_hash` doesn't match (the user re-ran Phase 2a between sessions, OR the file is corrupted). Fire **F-FLOW-WALKER-CHECKPOINT-STALE** (auto-recover) — `rm "$CP"` and start fresh; log the discard so the user knows the previous walker progress was discarded but don't prompt.

**Write protocol** — after every round completes (pass / plateau / regression / max-rounds / skipped), persist the updated checkpoint atomically:

```bash
TMP="${CP}.tmp.$$.${RANDOM}"
echo '<your-updated-checkpoint-json>' > "$TMP"
mv "$TMP" "$CP"
```

Atomic write (tmp + rename) ensures a crash mid-write doesn't corrupt the file. The `current_host_index`, `current_viewport`, `current_round` fields advance with each round; `rounds_completed[]` accumulates per-host results; `files_touched[]` and `snapshot_dirs_by_host` track what's been edited and where the snapshots live. Validate the JSON against the schema before writing — refer to `skills/d2c-build-flow/schemas/walker-checkpoint.schema.json` for the required field set and enums.

When the walker finishes (every host completed, `checkpoint.current_host_index === flow.pages.length + sum(stepper_groups[*].steps.length)`), `rm "$CP"`. The `audit.json` from §4a.6 is the persistent record from then on; the checkpoint was just a resume artifact.

#### 4a.1 Generate the walker spec

Emit `<run-dir>/flow/flow-walker.spec.ts` from the template at `skills/d2c-build-flow/references/framework-react-next.md` §"Flow-walker spec template" (parallel templates exist in the other framework references — pick by the same branch table as Phase 3 §Preconditions). The walker iterates `flow-graph.json` as follows:

- **Routes-mode hosts** (`pages[i].page_type === "page"`): one block per page — `page.goto(<route>)`, wait for `domcontentloaded` AND for any `data-flow-ready` attribute on `<main>` to appear (the walker emits a `data-flow-ready` hook on every generated page so it knows when first paint is complete; absence falls back to a 750ms settle delay), then screenshot.
- **Stepper-group virtual pages** (`pages[i].page_type === "stepper_group"`): one block per group — `page.goto(<group_route>)`, screenshot step 1, then for each subsequent step in `stepper_groups[g].steps[]` order: fill form fields per §4a.2 if `validate: form`, click Next per §4a.3, wait for the step transition, screenshot step N. The shared shell bbox is masked via `flow-graph.mask_regions[]` so the stepper indicator's variant change between steps doesn't trigger a false diff.
- **Mobile pairs**: when the host carries a `mobile_variant`, the same block runs twice — once at the desktop viewport (1280×900) and once at the mobile viewport (390×844, configurable via `--mobile-viewport`). Each viewport pixel-diffs against the matching Figma export.

The walker is generated end-to-end from `flow-graph.json` — no hand-editing. Re-running Phase 4 regenerates it from scratch so a flow-graph change always produces a fresh walker.

#### 4a.2 Auto-fixture for `validate: form` steps

For every stepper step with `validate: form`, the walker fills the form before clicking Next. Fixture values come from the step's IR (`stepper_groups[i].steps[j].state_writes[]` plus per-step form-field metadata from Phase 2):

| Field shape | Auto-fixture value |
|---|---|
| `state_writes.type === "string"` | `"sample-<name>"` (`name` from `state_writes.name`, lowercased, hyphenated) |
| `state_writes.type === "number"` | smallest positive integer satisfying any inferred `min` constraint (default `1`) |
| `state_writes.type === "boolean"` | `true` |
| Field name matches `/email/i` OR `<input type="email">` | `"test@example.com"` |
| Field name matches `/url|website/i` OR `<input type="url">` | `"https://example.com"` |
| Field name matches `/phone|tel/i` OR `<input type="tel">` | `"5551234567"` |
| Field name matches `/zip|postal/i` | `"94103"` |
| Field name matches `/password/i` OR `<input type="password">` | `"Password123!"` |
| Field name matches `/date/i` OR `<input type="date">` | today's date in `YYYY-MM-DD` |

Above each `fill` block, emit `// TODO: auto-fixture — replace if a regex/business rule rejects this value` so the user can correct without grepping.

**Persistence across reruns** — values are read from and written to `<run-dir>/flow/walker-fixtures.json` (schema at `skills/d2c-build-flow/schemas/walker-fixtures.schema.json` — read it for the canonical entry shape: `{ value, supplied_by: "user" | "auto-fixture", supplied_at, field_type }`).

The walker spec follows this read-merge-write protocol per (step, field) tuple:

1. **Read.** `Read <run-dir>/flow/walker-fixtures.json` (or treat as `{schema_version: 1, fixtures: {}}` if missing). Look up `fixtures[<step-key>][<field-name>]`. The step key format is `<group_node_id>__step_<N>` where N is the 1-based step index.
2. **Use existing if present.** Whether `supplied_by` is `"user"` or `"auto-fixture"`, use the recorded `value` — both are committed prior decisions. Skip the auto-generation table.
3. **Generate if absent.** Apply the auto-fixture table above to produce a fresh value, then persist it back.
4. **Atomic write.** Insert the new entry into the in-memory object, validate it against `walker-fixtures.schema.json`, and write atomically:
   ```bash
   TMP="<run-dir>/flow/walker-fixtures.json.tmp.$$.${RANDOM}"
   echo '<updated-fixtures-json>' > "$TMP"
   mv "$TMP" "<run-dir>/flow/walker-fixtures.json"
   ```
5. **User-wins on overwrite.** When updating an entry, if the existing entry has `supplied_by: "user"` AND the incoming entry has `supplied_by: "auto-fixture"`, **keep the existing entry** — never silently downgrade a user-supplied value. User-on-user always rewrites (latest wins). Auto-on-auto always rewrites.

This is what makes the **F-FLOW-WALKER-VALIDATION-BLOCKED** prompt non-repeating across reruns: when the user supplies real values, the SKILL writes them with `supplied_by: "user"`. The next walker run reads them first and uses them without re-prompting. When auto-fixture is exhausted (every wired field has a persisted value, all tried, Next still disabled), fire **F-FLOW-WALKER-VALIDATION-BLOCKED**.

#### 4a.3 Stepper navigation

Click Next via `await page.getByRole("button", { name: /next|continue|submit|finish|done|confirm/i }).click()` — same regex as the Phase 2b link-target heuristic so the walker and the codegen agree on which button is "Next". Wait for transition via either:

- The `data-stepper-step="<index>"` attribute on `[data-stepper-body]` advancing (the orchestrator emits this — see `framework-react-next.md` §"Page file"), OR
- A 750ms settle delay if the attribute is absent (older codegen).

For `optional: true` steps where auto-fixture can't satisfy validation, click `Skip` instead: `await page.getByRole("button", { name: /skip/i }).click()`. The walker chooses Skip only when validation blocks Next AND the step is optional.

#### 4a.4 Pixel-diff per screenshot

Reuse `skills/d2c-build/scripts/pixeldiff.js` directly — same CLI shape as today. For each (host, viewport) tuple:

1. Fetch the Figma export via `mcp__Figma__get_screenshot(node_id, viewport)` — for stepper steps, the `node_id` is `stepper_groups[g].steps[j].node_id`; for routes pages it's `pages[i].node_id`; for mobile pairs the `mobile_variant.node_id`.
2. Run `pixeldiff.js --reference <figma.png> --candidate <playwright.png> --mask <mask_regions.json> --threshold <T>`.
3. Compare to `--threshold` (default 95%, clamped to [50, 100]).

#### 4a.5 Auto-fix loop (snapshot, revert, plateau, oscillation)

When a (host, viewport) tuple fails pixel-diff, dispatch `/d2c-build` in fix mode for ONLY that host's loaded file. The fix dispatch uses the standard structured-input payload (route page) OR the stepper-step payload (with `stepper_step` set, when the host is a stepper step) plus a new `fix_target: { file_path, screenshot_diff_summary }` key that signals "this is a Phase 4 retry — adjust spacing/colour/sizing to align with the Figma export, do NOT change the prop contract or wiring".

After the fix dispatch, **re-run the walker for that host ONLY** (subset replay) — not the entire flow. The subset replay clones the walker spec, comments out every `test()` block except the one for the failing host, and re-runs Playwright. Bound by `--max-rounds` (default 3, same as today).

**Per-round protocol** — port of `d2c-build/SKILL.md` §Phase 4.4a-d, scoped per (host, viewport). Threshold defaults below match d2c-build verbatim:

| constant | value |
|---|---|
| `THRESHOLD` | 95 (passing pixel-diff %) |
| `MAX_ROUNDS` | 3 |
| `PLATEAU_DELTA` | 1.0 (improvement <1pp = plateau) |
| `OSCILLATION_WINDOW` | 3 (look back 3 rounds) |
| `OSCILLATION_DELTA` | 2.0 (last-3 range ≤2pp = oscillating) |
| `REGRESSION_DELTA` | 1.0 (drop >1pp = regression → revert) |
| `PLATEAU_OK_THRESHOLD` | 80 (≥80% plateau = inform; <80% = stop-and-ask) |

1. **Snapshot before edits.** Before each round (round N where N ≥ 2), snapshot every file about to be edited via `cp` into a per-round directory under the run-dir:

   ```bash
   SNAP=<run-dir>/flow/walker-snapshots/<host_node_id>/round-<N>
   mkdir -p "$SNAP"
   for f in <files-to-be-edited>; do
     ABS=$(realpath "$f")
     mkdir -p "$SNAP$(dirname "$ABS")"
     cp "$ABS" "$SNAP$ABS"
   done
   ```

   Round 1 has no snapshot — there is no prior state to revert to.

2. **Run pixel-diff.** Same as §4a.4 — fetch Figma export, run `pixeldiff.js`, get a score.

3. **Decide what to do next.** Compare the new score against the previous round's score and the score history (you maintain this in-memory across rounds). Apply the rules below in order — first match wins:

   | rule | condition | action |
   |---|---|---|
   | `pass` | `score >= THRESHOLD` | stop autofixing this host; record success in `audit.json` |
   | `regression` | `(prev_score - score) > REGRESSION_DELTA` | revert from snapshot, attempt ONE alternate fix. If alternate ALSO regresses, fire **F-FLOW-WALKER-REGRESSION** |
   | `oscillation` | last `OSCILLATION_WINDOW` scores have `max - min <= OSCILLATION_DELTA` | fire **F-FLOW-WALKER-OSCILLATION** — auto-fix is bouncing between candidates and won't converge |
   | `plateau-stop` | `(score - prev_score) < PLATEAU_DELTA` AND `score < PLATEAU_OK_THRESHOLD` | fire **F-FLOW-WALKER-PLATEAU** (stop-and-ask) — the user decides whether to accept the lower score or change strategy |
   | `plateau-ok` | `(score - prev_score) < PLATEAU_DELTA` AND `score >= PLATEAU_OK_THRESHOLD` | fire **F-FLOW-WALKER-PLATEAU** as `inform` — log the plateau but stop autofixing; `audit.json.warnings[]` records it for the Phase 6 report |
   | `max-rounds` | `round_index >= MAX_ROUNDS` and still improving | inform; record in `audit.json` with status `max_rounds_exhausted` |
   | `continue` | otherwise (improving and budget remains) | proceed to round N+1 |

4. **Revert on regression.** When the rule resolves to `regression`, restore every file from the round-N snapshot via reverse `cp`:

   ```bash
   SNAP=<run-dir>/flow/walker-snapshots/<host_node_id>/round-<N>
   for f in <files-to-revert>; do
     ABS=$(realpath "$f")
     cp "$SNAP$ABS" "$ABS"
   done
   ```

   Then dispatch `/d2c-build` ONE more time with a different fix strategy (the previous diff summary in `fix_target.previous_failed_strategies[]` so the AI doesn't repeat itself). If the alternate fix ALSO regresses, **F-FLOW-WALKER-REGRESSION** halts the loop with a STOP-AND-ASK.

5. **Shared-component blast-radius check.** Before applying any fix that would edit `state/<Group>Context.tsx` or the orchestrator (files used by every step), STOP-AND-ASK with **F-FLOW-WALKER-SHARED-BLAST**. Editing those files affects every step, so a fix that improves step 3 might regress steps 1, 2, and 4 — surface the blast radius before the user accepts the change.

6. **Lock check.** Before any fix dispatch, verify the locked decisions still hold:

   ```bash
   node skills/d2c-build-flow/scripts/validate-flow-graph.js <run-dir>/flow/flow-graph.json \
     --verify-lock <run-dir>/flow/flow-decisions-lock.json
   ```

   A locked-value mismatch fires **F-FLOW-LOCK-CONFLICT** — the auto-fix loop is about to drift from the IR. Resolve per the F-FLOW-LOCK-CONFLICT protocol before proceeding (the user either reverts the IR or marks the entry `failed`).

After the budget is exhausted (`action: "max-rounds"`), fire the standard Phase 4 failure (`P4-PIXEL-DIFF-EXHAUSTED`) for that host.

#### 4a.6 Audit.json append (loaded rows)

The walker writes loaded rows directly into `audit.json` — no separate `/d2c-build` dispatch needed. For each host:

```json
{
  "node_id": "<step.node_id or page.node_id>",
  "route": "<route or group_route#step-N>",
  "variants": [
    { "slot": "loaded", "viewport": "desktop", "final_score": 98.5, "rounds": 1, "status": "pass" },
    { "slot": "loaded", "viewport": "mobile",  "final_score": 97.2, "rounds": 0, "status": "pass" }
  ]
}
```

The `viewport` field is new (Phase 1.5 mobile collection): per-variant rows render one entry per viewport when `mobile_variant` is set, else one entry. Loaded-only desktop flows produce `[{slot:"loaded", final_score, rounds, status}]` (no viewport key) for byte-identical compatibility with the pre-Phase-4-walker audit shape — the identity-gate fixtures stay green.

### 4b — Per-variant Pixel-Diff (non-loaded slots)

Unchanged from today's behaviour for `loading` / `empty` / `error` / `initial` slots. For each host that carries a `state_variants` block, iterate slots alphabetically (`empty`, `error`, `loaded`, `loading`) **skipping `loaded` (covered by 4a)** and dispatch `/d2c-build` Phase 4 per non-loaded variant exactly as today:

1. **Seed the page entry** if 4a hasn't already (e.g. a host with state_variants but no participation in the walker — rare, e.g. an overlay page reachable only via a button on another page). Push `{"node_id", "route", "variants": []}` onto `audit.json.pages[]`. 4a's loaded-row append uses upsert semantics keyed on `node_id`, so seeding twice is safe.
2. **Iterate non-loaded slots.** For every non-stub variant:
   - Run `/d2c-build` Phase 4 inside the variant's run directory (`.claude/d2c/runs/<ts>/pages/<node_id>/variants/<slot>/` for pages, `.claude/d2c/runs/<ts>/pages/<group_node_id>/steps/<step_node_id>/variants/<slot>/` for stepper steps).
   - Pass `audit_path: "<absolute-or-project-root-relative path to flow/audit.json>"` in the structured payload so `/d2c-build` Phase 6 appends this variant's result entry.
   - Auto-fix is bounded by the same `--max-rounds` as today.
3. **Stub entries (error only).** Append `{ "slot": "error", "stub_emitted": true }` to the host's `variants[]` directly (no `/d2c-build` dispatch, no screenshot, no pixel-diff). Simultaneously push an `error_stub_emitted` warning: `{ kind: "error_stub_emitted", route, slot: "error", node_id, recommendation: "Replace the dashed-border placeholder at <emitted file path> with a real error design before shipping." }`.
4. **Drain staged warnings (P2.4).** After both passes complete, iterate `flow_graph._pending_audit_warnings[]` (populated by Phase 1b sibling-name detection and Phase 3 codegen hooks) and push each into `audit.json.warnings[]`, de-duplicating by `(kind, route, slot, node_id)` — first entry wins. The in-memory list is dropped from `flow-graph.json` (schema's `additionalProperties: false` would reject it). When `--skip-phase4` is passed, stage the list to `<run-dir>/flow/pending-audit-warnings.json` instead; the next Phase 4 run loads and drains the sidecar before starting.

### Identity guarantee

Loaded-only flows (no `state_variants` on any host, no `mobile_variant` on any host) produce the same `audit.json` as before — one `{slot:"loaded"}` row per page, no `viewport` key. The Phase 6 report collapses single-variant pages back to the pre-change one-row-per-page layout. P0.8 identity gate still holds at the report level; the new flow-walker is invisible on identity-fixture flows because it produces the same row shape today's per-host dispatch did. Loaded-only stepper flows now also get pixel-diff coverage (today's per-host dispatch silently skipped them), so the per-step row count goes from 0 to N — that's a deliberate output change, not an identity violation, and it's the parity move task #6 was scoped to deliver.

### Audit shape (canonical)

```json
{
  "pages": [
    {
      "node_id": "1:2",
      "route": "/dashboard",
      "variants": [
        { "slot": "empty",   "final_score": 99.1, "rounds": 1, "status": "pass" },
        { "slot": "error",   "stub_emitted": true },
        { "slot": "loaded",  "final_score": 98.2, "rounds": 3, "status": "pass" },
        { "slot": "loading", "final_score": 96.5, "rounds": 2, "status": "pass" }
      ]
    }
  ],
  "warnings": [
    {
      "kind": "error_stub_emitted",
      "route": "/dashboard",
      "slot": "error",
      "recommendation": "Replace the dashed-border placeholder at app/dashboard/error.tsx with a real error design before shipping."
    }
  ]
}
```

Slot ordering inside each page's `variants[]` is alphabetical — matches the IR serialisation order and keeps diffs stable across runs.

### Warnings surface (P2.4)

`audit.json.warnings[]` is the single channel that aggregates non-failing signals the user needs to review before shipping. A warning is never a test failure — Phase 4 pixel-diff failures and Phase 4b nav-smoke failures stay in their own channels. Warnings exist so the report can surface soft issues (stubs, fallback ambiguity, mobile drift, a11y gaps) without burying them in per-variant rows.

Canonical fields per entry:

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | yes | Enumerated — see table below. Stable across runs so downstream tooling can filter. |
| `route` | string | yes | The affected route (`"/dashboard"`, `"/checkout#step-2"`, etc.). Use the step-anchored form for stepper-step warnings so one group with mixed warnings is not collapsed. |
| `slot` | `"empty" \| "error" \| "loaded" \| "loading"` | when slot-scoped | Omit for warnings that aren't tied to a specific variant (e.g. a group-level navigation warning). |
| `node_id` | string | when available | The Figma node id of the offending frame. Lets the user jump from the report to the design. Omit when the warning is about something that doesn't map to a single frame (e.g. missing mobile counterpart on a slot that has no mobile frame at all). |
| `recommendation` | string | yes | Human-readable action the user should take. One sentence. Present tense imperative ("Replace …", "Add …", "Disambiguate …"). |
| `details` | object | when the warning kind defines one | Structured extras for specific kinds (see per-kind shapes below). Keep shallow — one level deep. |

Warning kinds (closed set — extend by adding a row here and wiring the producer phase, never by inventing kinds ad hoc):

| `kind` | Producer phase | `slot` required | `details` shape |
|---|---|---|---|
| `error_stub_emitted` | Phase 4 (stub row) | yes (`"error"`) | `{}` |
| `fallback_unmatched_sibling` | Phase 1b §"Fallback: sibling-name detection" | no | `{ name: string, candidate_slot?: "empty"\|"error"\|"loaded"\|"loading" }` |
| `fallback_collision` | Phase 1b §"Fallback: sibling-name detection" | yes | `{ name: string, other_node_id: string }` — `node_id` on the warning points at the losing sibling, `other_node_id` at the winner. |
| `missing_mobile_counterpart` | Phase 3 §"Mobile × state composition" | yes | `{ mobile_strategy: "inherit-from-loaded" }` — matches the audit-hook payload from `framework-react-next.md`. |
| `a11y_missing_heading` | Phase 3 §"Accessibility" (empty variant) | yes (`"empty"`) | `{ reason: "no-heading-in-empty-frame" }` — emitted when the empty variant's Figma frame has no text large enough to serve as a heading and codegen had to insert a `sr-only` fallback. |
| `walker_plateau` | Phase 4a (auto-fix loop) | yes (`"loaded"`) | `{ final_score: number, plateau_reason: "improvement_below_threshold", viewport: "desktop" \| "mobile" }` — emitted when the walker auto-fix plateaued at score ≥80% (inform tier — see F-FLOW-WALKER-PLATEAU). Plateaus below 80% are not warnings, they're STOP-AND-ASK failures and never reach this table. |

Rules:

1. **Phase 4 writes stub warnings.** When the Phase 4 variant loop appends a `{ "slot": "error", "stub_emitted": true }` row to a page's `variants[]`, it also pushes an `error_stub_emitted` warning with the host's route and `node_id`. One page with a stubbed error variant = one audit row + one warning.
2. **Phase 1b writes fallback warnings.** When the fallback sibling-name detector returns `unmatched_siblings[]`, the clarification phase surfaces them to the user — siblings the user declines to attach or that collide with an already-matched slot are recorded as `fallback_unmatched_sibling` / `fallback_collision` warnings before Phase 2a writes the IR. The warnings persist into `audit.json` via the Phase 4 seeding step (Phase 2a carries them forward on `flow_graph._pending_audit_warnings[]`, consumed and cleared by Phase 4's audit-seeding pass).
3. **Phase 3 writes codegen warnings.** When Phase 3 emits the mobile-inherit strategy or a `sr-only` heading fallback, it stages the corresponding warning on `flow_graph._pending_audit_warnings[]`. Phase 4's audit seed consumes the staged list the same way as Phase 1b's entries. Staging (not direct write) keeps Phase 3 independent of whether Phase 4 runs — e.g. `--skip-phase4` preserves the intent to warn and re-emits on the next run.
4. **De-duplication.** Warnings are de-duplicated by `(kind, route, slot, node_id)` at seed time — Phase 2a and Phase 3 may both stage for the same `(route, slot)` independently; only the first wins. Rationale: prevents noise when the same `(route, slot)` triggers both a fallback ambiguity and a mobile-counterpart issue — the user fixes one at a time.
5. **Phase 6 surfaces warnings.** See §Phase 6 step "Warnings table" — warnings render as a separate table below the per-variant summary, grouped by `kind`. Identity-collapse flows (loaded-only everywhere, no warnings) omit the warnings section entirely, preserving the pre-change report shape.
6. **Schema stability.** `warnings` is always present on `audit.json` (empty array on loaded-only flows with no stubs or warnings from Phase 3). Downstream tooling can rely on the field without null checks. New warning kinds require a row in the table above and a producer phase — never add a one-off warning inline without documenting it here.

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
- **Fail (with autofix, B-FLOW-NAV-AUTOFIX):** when click-level assertions fail, run the autofix planner inline. For each failing edge (in `<run-dir>/flow/nav-failures.json`), pick the next strategy from this priority list and re-run the test. Bound by `--nav-max-rounds` (default 2):
  1. **`relax-link-target`** — re-run the Phase 2b `pickLinkTarget` heuristic on the failing page's `component-match.json` with a relaxed regex (drop the whole-word boundary; allow substring matches). If the relaxed pick yields a different `source_component_node_id`, update `flow-graph.edges[i]` accordingly and re-run.
  2. **`wire-next-best`** — take the second-ranked Next-text candidate from the page's `component-match.json` (the runner-up to whatever Phase 2b picked). If it exists, rewire `edges[i].source_component_node_id` and re-run.
  3. **`force-click`** — re-emit the failing click assertion with `force: true` (skips visibility / actionability checks). Use sparingly: a forced click that succeeds usually means the button has a sibling overlay that should be addressed separately.
  4. **`wait-for-state`** — add `await page.waitForLoadState('networkidle')` before the click. Helps when the page is still hydrating when Playwright clicks.
  5. **`escalate`** — budget exhausted or URL-level failure (the `page.goto` itself failed). Emit **F-FLOW-NAV-ASSERT-FAIL** (inform tier).

  Track the strategies tried per edge in an in-memory `autofix_trail[]` so the planner doesn't repeat itself across rounds and the Phase 6 report can show the full sequence.
  Each round is one retry. Default `--max-rounds 2`; override per-invocation with `--nav-max-rounds`.
- **Fail (autofix exhausted):** fire **F-FLOW-NAV-ASSERT-FAIL** (inform tier). Report which edges failed and whether each failure was URL-level or click-level, plus the planner diagnosis for each.

---

## Phase 5 — Per-page Audit + Bucket F-Flow Honor Checks

Phase 5 runs in two passes — `/d2c-build` Phase 5 audit per page (today's behaviour, extended to per-step files for stepper groups) **plus** a new flow-specific Bucket F enforcement pass on files the flow emits directly. The two passes catch different things: per-page audit catches in-component violations (hardcoded values, missing imports, library violations); Bucket F-Flow catches orchestration-layer violations the per-page audit can't see (orchestrator imports a rogue shell, state context is missing `markStepValid`, walker spec doesn't cover step 3, etc.).

### 5a — Per-page audit (delegated to `/d2c-build` Phase 5)

For each page in `flow-graph.pages[]`, run the existing `/d2c-build` Phase 5 audit (hardcoded values, library violations, IR unauthorised imports, convention conflicts):

- **Routes-mode pages and standalone hybrid pages:** audit the single emitted route file (`app/<route>/page.tsx` or framework equivalent) — unchanged from prior behaviour.
- **`page_type: "stepper_group"` virtual pages:** the group emits multiple files (the orchestrator `page.tsx`, the state context under `state/<Group>Context.tsx`, and one step component per declared step under `steps/Step<N>.tsx`). Run `/d2c-build` Phase 5 audit **on each emitted file independently** so the same six non-negotiables apply to every step body, the orchestrator, and the state context. Report rows are grouped under the group's `route` with a sub-row per file (`steps/StepEmail.tsx`, etc.) so the user can pinpoint which step file violated which rule.

Aggregate violations across pages and (for stepper groups) per-file rows for the final report.

### 5b — Bucket F-Flow honor checks (flow-emitted files)

`/d2c-build` per-file audits don't know what the FLOW expected — only what the per-page IR expected. The orchestrator could import a rogue shell that has nothing to do with `flow-graph.layouts[]`, the state context could be missing `markStepValid` even though `validation_enabled === true`, and `/d2c-build`'s Bucket F wouldn't catch it because those files weren't part of any per-page IR. Bucket F-Flow plugs that gap.

Run five inline checks across the flow-emitted files (orchestrator `app/<group_route>/page.tsx`, state context `app/<group_route>/state/<Group>Context.tsx`, shared layout `components/<flow_name>/<Layout>.tsx`, nav-smoke spec `tests/flow/<flow_name>-navigation.spec.ts`, walker spec `<run-dir>/flow/flow-walker.spec.ts`). Categorise each file by filename pattern, then apply the buckets that match.

For every violation, emit a line in the format `violation: F<N>-Flow <file>:<line> — <description>` so the Phase 6 report can grep for them.

**F1-Flow — Component imports.** For every flow-emitted file, scan every `import … from '<source>'` line. Resolve relative imports against the file's directory. The import is **authorized** when it resolves to one of:
- A `component_id` listed in `flow-graph.layouts[]` (shared shell).
- A `source` path listed in `design-tokens.components[]` (project component reuse).
- A path under `app/<route>/steps/Step<N>.tsx` (delegated step body).
- A bare-name match against any layout / component name (e.g. `import OnboardingShell from "./OnboardingShell"` matches the `OnboardingShell` layout).

Skip lowercase imports (hooks, utils, `useEffect`, `clsx`) — only PascalCase basenames are component candidates. Anything PascalCase that doesn't authorise → fire **F-FLOW-HONOR-COMPONENT-UNAUTHORIZED** (stop-and-ask).

**F2-Flow — Token usage.** Scan every Tailwind/inline `bg-[#hex]`, `text-[#hex]`, `border-[#hex]`, `bg-[rgba(...)]`, `p-[Npx]` etc. usage. Build a reverse-lookup map from `design-tokens.json` (`colors.<name>` → hex value). For each hardcoded hex / value, if it matches a token's value, the file should be using the semantic class (`bg-primary`) instead → fire **F-FLOW-HONOR-TOKEN-UNAUTHORIZED** (stop-and-ask). Hardcoded values that DON'T match any token are NOT flagged here (Phase 5a's per-page audit catches those).

**F3-Flow — Orchestrator + state context prop contract.** Only fires for stepper / hybrid groups. For each `stepper_groups[g]`:
- The orchestrator (`app/<g.route>/page.tsx`) MUST import every step from `./steps/Step<N>` (or `./steps/Step<Title>`). Count distinct step imports; if fewer than `g.steps.length`, fire **F-FLOW-HONOR-PROP-CONTRACT**.
- Every `<Step…>` JSX usage in the orchestrator MUST include `onNext={…}` AND `onBack={…}` props. Use a non-greedy match (`/<Step\w+\b[\s\S]*?\/>/g`) that handles arrow functions in props.
- When `g.validation_enabled === true`, the orchestrator MUST also wire `onValidityChange={…}` somewhere.
- The state context (`app/<g.route>/state/<Group>Context.tsx`) MUST mention `next`, `back`, `goTo`, `data`, `setField` — and `markStepValid` when `validation_enabled === true`. Match `\b<name>\s*[(:=]` after stripping JS line/block comments (so a `// TODO: wire markStepValid` comment doesn't satisfy the check).

**F4-Flow — Nav-smoke edge coverage.** For every edge in `flow-graph.edges[]`, the nav-smoke spec MUST contain either (a) the destination route as a quoted literal (matches `page.goto`/`waitForURL`), OR (b) a literal comment `// edge <from>-><to>` or `/* edge <from>-><to> */`. Missing edges → fire **F-FLOW-HONOR-EDGE-MISSING** (inform; auto-add a TODO at an appropriate spec location).

**F5-Flow — Walker host coverage.** Build the canonical host list:
- Every `pages[i]` where `page_type === "page"` → host `(node_id, route)` × viewport (desktop only, OR desktop+mobile when `mobile_variant` is set).
- Every `stepper_groups[g].steps[j]` → host `(node_id, group_route#step-j+1)` × viewport.

For each host × viewport tuple, the walker spec MUST mention the host's `node_id` (as a quoted literal, single OR double quotes) AND the viewport keyword (`desktop` or `mobile`) somewhere. Missing coverage → fire **F-FLOW-HONOR-WALKER-COVERAGE** (inform; auto-add a TODO).

Print results in the format: `validate-honor-flow: ok | fail` (header), then `f<N>-violations: <count>` per bucket, then one `violation: F<N>-Flow <file>:<line> — <description>` line per violation. The Phase 6 report greps for these lines.

**Why two passes instead of one?** Per-page audit and Bucket F-Flow have different blast radii. A per-page audit failure isolates to one file (re-run codegen for that file). A Bucket F-Flow failure usually indicates the orchestration layer drifted from the IR — the fix often involves regenerating the orchestrator + state context together, not patching one file. Keeping them as separate passes keeps the failure-recovery story clean.

---

## Phase 6 — Finalize

The flow-level report section is required. It sits at the top of the build summary, above the per-page details.

### Required report sections

1. **Parsed step list echo.** A numbered list: `Step N → <route> → <figma_url>`. This is how the user verifies intent.
2. **Flow diagram (B-FLOW-REPORT-DIAGRAM).** Emit a Mermaid `flowchart LR` block from `flow-graph.edges[]`. Each page becomes a node `<node_id>[<title>]`; each edge becomes either `A --> B` (wired, `inferred: false`) or `A -.-> B` (inferred, `inferred: true`). For edges with `condition`, label as `A -- "<condition.kind>=<condition.value>" --> B`. Stepper-group virtual pages render as `A[<group_name> stepper]`. Loop edges (cycles in the prototype) render as `A -.-> A` with label `loop`. Wrap the block in a `<details>` summary so the diagram doesn't dominate the report. Fall back to an ASCII tree (`├── <route> → <next-route>`) when the report consumer can't render Mermaid.
3. **Flow-graph diff (B-FLOW-REPORT-DIFF).** If `<run-dir>/flow/flow-graph.json` has a predecessor (a previous run-dir under `.claude/d2c/runs/`), compare the two `flow-graph.json` files key-by-key. Output one line per changed top-level field: `+ <path>: <new>` (added), `- <path>: <old>` (removed), `~ <path>: <old> → <new>` (changed). Compare `pages[]`, `edges[]`, `layouts[]`, `shared_state[]`, `stepper_groups[]`, `mode`, `project_conventions`. Show `no changes` when nothing differs.
4. **Cross-file dependencies (B-FLOW-CROSS-FILE).** When `flow-graph.cross_file === true`, list every unique `file_key` from `flow-graph.file_keys[]` with the pages it gates.
5. **Page scores table.** Columns: `Step`, `Route`, `State variant`, `Pixel-diff %`, `Rounds used`, `Pass/Fail`. Add a `Mobile %` column when any page declares `mobile_variant` (B-FLOW-MOBILE-VARIANT).

   Source: `<run-dir>/flow/audit.json` (Phase 4 writes it). Render rules:
   - One row per `(page, variant)` pair. A page with N non-stub variants renders N rows; the `Step` / `Route` cells are left blank on continuation rows (or rendered once with `rowspan` when the consumer supports it) so the variant list reads as a group under its host.
   - `State variant` column values: `loaded`, `loading`, `empty`, `error`, or `error (stub)` for stub entries.
   - Stub rows render `—` in the `Pixel-diff %` / `Rounds used` / `Pass/Fail` columns (nothing was diffed) and carry the annotation `stub emitted — replace before shipping` in the surrounding prose.
   - **Identity collapse:** a page with only a single `loaded` variant (the whole flow is loaded-only) renders as today — one row per page, no `State variant` column header. Detect this by scanning `audit.json.pages[]` — if every entry's `variants` array has length 1 and slot `"loaded"`, omit the `State variant` column entirely. This preserves the pre-change report shape for the identity-gate fixtures.
6. **Reuse metric.** `X / Y components reused across ≥2 pages (Z%)`. Compute by walking every per-page `component-match.json` under `<run-dir>/pages/<node_id>/`, collecting the `chosen.source` field (or `__NEW__`) per node, then counting distinct source paths that appear in 2+ pages. `Y` = total distinct sources across the flow; `X` = sources used by ≥2 pages; `Z` = `round(X / Y * 100, 1)`. Skip `__NEW__` entries (they're per-page by definition).
7. **Navigation test result.** `PASS` / `FAIL: <edges>` / `N/A (not executed)`. Plus counts of wired vs inferred edges, plus each round's autofix strategy from the in-memory `autofix_trail[]` (Phase 4b) when the autofix loop ran.
8. **Not-supported detections.** Every entry in `flow-graph.not_supported_detected[]` with its `kind`, `node_id`, and `reason`.
9. **Warnings.** Any `warning`-severity failure from Phase 1 (e.g. `F-FLOW-ROUTE-ESCAPES-BASE`) and any Phase 2a informs (`F-FLOW-SHELL-DIVERGENT`, `F-FLOW-PROTOTYPE-CONTRADICTS-ORDER`, `F-FLOW-DISCOVERY-CYCLE`).
10. **State-variant warnings table (P2.4).** Render a separate markdown table when `audit.json.warnings[]` is non-empty. Columns: `Kind`, `Route`, `Slot`, `Node`, `Recommendation`. Render rules:
    - Group rows by `kind` in this order (matches the warning-kinds table in Phase 4): `error_stub_emitted`, `fallback_unmatched_sibling`, `fallback_collision`, `missing_mobile_counterpart`, `a11y_missing_heading`. Unknown kinds sort alphabetically after the known ones — the producer added a row to the table in Phase 4 without updating this ordering, and that's worth surfacing.
    - Within a kind, sort by `route` ascending, then by `slot` alphabetically (`empty`, `error`, `loaded`, `loading`), then by `node_id` ascending. Deterministic so repeated runs on unchanged inputs produce byte-identical reports.
    - `Slot` cell renders `—` when the warning is not slot-scoped; `Node` renders `—` when `node_id` is absent.
    - Append a one-line header above the table: `<N> state-variant warnings — review before shipping.` (singular `warning` when N=1.) When N=0 (common for loaded-only flows and for fully-resolved full-variant flows), omit the entire section — no empty header, no empty table.
    - **Identity preservation:** the section never appears on loaded-only flows because Phase 4 never stages warnings on them (no stubs, no fallback, no mobile-counterpart drift on slots that don't exist). Combined with the identity collapse on the page scores table (rule 5), loaded-only flows produce the pre-change report shape exactly.

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

Expected: a single virtual page at `/onboarding`, a stepper group containing the three steps, one `OnboardingShell` layout if detected, `steps/StepEmail.tsx` + `StepVerify.tsx` + `StepProfile.tsx`, `state/OnboardingContext.tsx` with `currentStep`, URL never changes when clicking Next, browser-back undoes a step.

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
