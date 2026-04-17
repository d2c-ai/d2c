# d2c-build-flow Failure Modes

This file is the single source of truth for every failure mode across all phases of `/d2c-build-flow`. When a failure occurs, the model reads the matching entry and follows the **User prompt** template exactly — no improvisation.

Inherits the meta-rules from `skills/d2c-build/references/failure-modes.md`:

- **Anti-rationalization** — if you are inventing a reason to skip a constraint, STOP AND ASK.
- **Never invent a fallback** — any unrecognized failure routes to `FX-UNKNOWN-FAILURE`.
- **Universal retry escalation** — any auto-recover failure that recurs beyond `max_retries` with the same id + same node id escalates to stop-and-ask.
- **Batching** — multiple failures of the same tier in the same phase are presented in a single grouped prompt, not one-by-one. Required format:

  ```
  Multiple issues with your prompt:

  1. <FAILURE-ID>: <one-line summary>
     <prompt-specific context (failing line, affected step numbers, etc.)>

  2. <FAILURE-ID>: <one-line summary>
     <prompt-specific context>

  Please repaste the prompt with all <N> issues corrected, or type `abort` to cancel.
  ```

  Rules:
  - One numbered block per failure id. Do NOT issue separate STOP-AND-ASK prompts for each.
  - Group by tier: errors come before warnings in the same prompt.
  - The parser already returns every applicable failure in one `failures[]` array — trust that contract. See `tests/integration/failure-batching.test.js` for the lock-in test.
  - If only a single failure fired, use its dedicated prompt template below (no "Multiple issues" header).

---

## Resolution Tiers

| Tier | Behavior | User sees |
|------|----------|-----------|
| **auto-recover** | Model fixes silently, retries. Has `max_retries` before escalation. | Brief log line in build report |
| **inform** | Build continues with a warning. | Yellow warning in build output |
| **stop-and-ask** | Build halts. Model presents prompt template with options, waits. | Full prompt with options |
| **fatal** | Cannot proceed. Build aborts. | Error message with diagnostic |

---

## Quick Reference

| ID | Phase | Tier | Title |
|----|-------|------|-------|
| F-FLOW-PARSE-AMBIGUOUS | 1 | stop-and-ask | Step line did not match the grammar |
| F-FLOW-STEP-GAP | 1 | stop-and-ask | Step numbers are non-contiguous or duplicated |
| F-FLOW-FILE-URL | 1 | stop-and-ask | Step URL is a Figma file URL, not a frame URL |
| F-FLOW-NO-ROUTE | 1 | stop-and-ask | Step has no route and no base route in preamble |
| F-FLOW-ROUTE-ESCAPES-BASE | 1 | inform | Explicit step route is not under base_route |
| F-FLOW-TOO-FEW-STEPS | 1 | stop-and-ask | Fewer than 2 step lines parsed |
| F-FLOW-STATE-TYPE-UNSUPPORTED | 1 | stop-and-ask | `state:` directive uses an unsupported field type |
| F-FLOW-BRANCH-INCOMPLETE | 1 | stop-and-ask | Branch group is missing siblings or has non-contiguous letters |
| F-FLOW-TOKENS-MISSING | 1 | fatal | design-tokens.json missing |
| F-FLOW-OVERLAY-AS-PAGE | 2a | inform | Listed step is an overlay-trigger component |
| F-FLOW-CONDITIONAL | 2a | inform | Listed step contains a conditional prototype action |
| F-FLOW-MISSING-STATE | 2a | stop-and-ask | Shared state declared but no form elements detected |
| F-FLOW-SHELL-DIVERGENT | 2a | inform | Candidate shared layout variance exceeds threshold |
| F-FLOW-PROTOTYPE-CONTRADICTS-ORDER | 2a | inform | Figma prototype edges disagree with declared step order |
| F-FLOW-DISCOVERY-EMPTY | 2a | stop-and-ask | Entry frame has no outgoing prototype connections (auto-discover mode) |
| F-FLOW-DISCOVERY-DISCONNECTED | 2a | stop-and-ask | Prototype graph has multiple disconnected subtrees |
| F-FLOW-DISCOVERY-CYCLE | 2a | inform | Prototype graph contains a cycle; back-edge cut |
| F-FLOW-BRANCH-UNWIRED | 2a | stop-and-ask | Branch page has an outgoing edge that cannot be wired to a Figma component |
| F-FLOW-NAV-ASSERT-FAIL | 4b | inform | Navigation smoke test failed post-gen |
| F-FLOW-OVERLAY-PARENT-MISSING | 2a | stop-and-ask | Overlay page references a parent that isn't a `page_type='page'` |
| F-FLOW-CONDITION-FIELD-UNKNOWN | 2a | stop-and-ask | `edges[].condition.field` doesn't match any declared state writer |
| F-FLOW-CROSS-FILE-DEPENDENCY | 2a | inform | Flow spans multiple Figma files; every file must be fetchable |
| F-FLOW-MOBILE-URL | 1 | stop-and-ask | `mobile:` URL missing `node-id` or unreachable |
| F-FLOW-NAV-AUTOFIX-EXHAUSTED | 4b | inform | Nav-test autofix hit `--nav-max-rounds` without a passing diff |
| FX-UNKNOWN-FAILURE | X | stop-and-ask | Unrecognized failure (catch-all) |

---

## Phase 1 — Prompt Parsing

### F-FLOW-PARSE-AMBIGUOUS — Step line did not match the grammar

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A candidate step line (one that begins with `Step` followed by whitespace) cannot be parsed by the grammar regex:
  `^\s*Step\s+(\d+)\s*[:\-]\s*(<figma-url>)(?:\s+route:\s*(/\S+))?\s*$`
- **Action:** Halt. Quote the failing line verbatim. Show the canonical example. Ask whether to retry with a corrected prompt or abort.
- **Max retries:** N/A
- **Related rule:** Grammar section of SKILL.md

**User prompt:**
> "I couldn't parse this step line:
> ```
> {failing_line}
> ```
> Expected one of:
> ```
> Step 1: https://figma.com/design/abc/file?node-id=1-2
> Step 1: https://figma.com/design/abc/file?node-id=1-2  route: /my-route
> ```
> Please repaste the prompt with the corrected step line, or type `abort` to cancel."

**Context to show:** The exact input line, the step number it tried to parse, and the regex expectations (one URL per step, optional `route: /path` suffix).

---

### F-FLOW-STEP-GAP — Step numbers are non-contiguous or duplicated

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** Parsed step numbers are not `[1, 2, …, N]` contiguous (e.g. `1, 2, 4` or `1, 2, 2, 3`).
- **Action:** Halt. Show the list of step numbers encountered. Offer: (1) auto-renumber preserving the order they appeared, (2) let the user fix and re-invoke, (3) abort.
- **Max retries:** N/A
- **Related rule:** Grammar section of SKILL.md

**User prompt:**
> "Step numbers must be contiguous starting at 1. I parsed: `{observed_numbers}`.
>
> Options:
> 1. Renumber automatically in the order they appeared ({renumbered_preview})
> 2. Fix manually and re-invoke — type `abort` and re-run `/d2c-build-flow`
>
> Which?"

---

### F-FLOW-FILE-URL — Step URL is a Figma file URL, not a frame URL

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step URL does not contain `?node-id=` or `&node-id=`. Figma file URLs point to the whole file rather than a specific frame.
- **Action:** Halt. Call `get_metadata` on the file to list frames, present a numbered pick-list, ask the user which frame this step refers to.
- **Max retries:** N/A
- **Related rule:** Grammar section of SKILL.md

**Runtime procedure** (MUST follow — `B-FLOW-INTAKE-FRAME-PICKER`):

1. Parse the Figma file key from the offending step URL (the path segment after `/design/` or `/file/`).
2. Call `mcp__figma__get_metadata` with that file key to retrieve the top-level frame list.
3. Hand the raw response to `skills/d2c-build-flow/scripts/format-frame-picker.js` (or its exported `formatFramePicker({ frames, stepNumber, fileUrl })`).
   - `kind === "ok"` → print `result.text` verbatim inside the STOP-AND-ASK.
   - `kind === "empty"` → the file has no top-level FRAMEs. Escalate to `FX-UNKNOWN-FAILURE`; do NOT present an empty pick-list.
4. Accept user input:
   - `^\d+$` that indexes into `result.frames[]` → rebuild the step line as `Step <N>: <fileUrl>?node-id=<chosen-node-id>` and re-run Phase 1 from the top (parser). `node-id` values are already in colon form per the helper.
   - `abort` → stop the flow cleanly.
   - Any other input → re-show the prompt unchanged (do NOT improvise).
5. The helper is a pure function — if the user reports a mismatch between the printed list and the Figma UI, diagnose the underlying `get_metadata` response rather than rewriting the prompt by hand.

**User prompt** (rendered by `formatFramePicker` — shown here for reference only):
> "Step {N} points to a Figma file URL, not a specific frame:
> {url}
>
> Frames in this file:
> 1. {frame_name_1} — node {node_id_1}
> 2. {frame_name_2} — node {node_id_2}
> …
>
> Which frame is step {N}? (number, or `abort`)"

**Context to show:** The Figma file URL the user provided and the `get_metadata` frame list (top-level frames only, `type === "FRAME"`). Nested children and non-FRAME entries (`SECTION`, `GROUP`, `COMPONENT`, etc.) are filtered out by the helper.

---

### F-FLOW-NO-ROUTE — Step has no route and no base route in preamble

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** At least one step has neither an explicit `route: /path` suffix nor a derivable route from a `route /base` token in the preamble.
- **Action:** Halt. Ask the user for a base route once; apply it to every unrouted step as `<base>/step-<N>`.
- **Max retries:** N/A
- **Related rule:** Route resolution rules in SKILL.md

**User prompt:**
> "No base route was found in the preamble and {count} step(s) have no explicit `route:`. What base route should I use? (e.g. `/onboarding`, `/signup`)"

---

### F-FLOW-ROUTE-ESCAPES-BASE — Explicit step route is not under base_route

- **Phase:** 1
- **Tier:** inform (confirm to continue)
- **Trigger:** `base_route` was extracted from the preamble and one or more explicit per-step `route:` values do not start with `base_route + "/"`.
- **Action:** Warn once, listing the offending steps, and ask the user to confirm the mismatch is intentional before proceeding.
- **Max retries:** N/A
- **Related rule:** Route resolution rules in SKILL.md

**User prompt:**
> "Base route is `{base_route}` but these steps route outside it:
> - Step {N}: `{route}`
> - Step {M}: `{route}`
>
> Is this intentional? (yes/no — `no` aborts)"

---

### F-FLOW-TOO-FEW-STEPS — Fewer than 2 step lines parsed

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** Fewer than 2 `Step N:` lines matched the grammar.
- **Action:** Halt. Remind the user that a flow needs at least 2 steps.
- **Max retries:** N/A

**User prompt:**
> "I only parsed {count} step line(s). A flow needs at least 2 steps. Please repaste the prompt with all steps, or run `/d2c-build` for a single page."

---

### F-FLOW-STATE-TYPE-UNSUPPORTED — `state:` directive uses an unsupported field type

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step line's `state:` directive declares a field whose type is not one of `string | number | boolean`. v1 typed state is primitives-only; complex shapes (Date, arrays, nested objects) need manual typing after codegen.
- **Action:** Halt. Echo the offending field(s). Offer: (1) repaste with a supported primitive, (2) drop the field from the directive and write the typed shape by hand post-build, (3) abort.
- **Max retries:** N/A
- **Related rule:** Grammar section of SKILL.md (`state:` directive)

**User prompt:**
> "Step {N}'s `state:` directive uses an unsupported type:
> ```
> {offending_fields}
> ```
> Supported types are `string`, `number`, `boolean`. Repaste with a supported type, drop the field (handle the non-primitive shape after codegen), or type `abort`."

---

### F-FLOW-BRANCH-INCOMPLETE — Branch group is missing siblings or has non-contiguous letters

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step line carries a branch suffix (`a`, `b`, …) but the group is ill-formed:
  - a lone `Step 3a:` with no `Step 3b:` sibling, or
  - suffix letters that skip (`a`, `c` instead of `a`, `b`), or
  - a mix of labelled and unlabelled siblings at the same step number.
- **Action:** Halt. Quote the offending step(s) and the observed vs. expected suffix list. Offer: (1) add the missing sibling, (2) drop the `a` suffix to make the step linear, (3) abort.
- **Max retries:** N/A
- **Related rule:** B-FLOW-MULTI-BRANCH grammar (Phase 1 §"Grammar rules")

**User prompt:**
> "Branch group at Step {N} is incomplete:
> - Observed suffixes: `{observed}`
> - Expected contiguous suffixes: `{expected}`
>
> Options:
> 1. Repaste the prompt with the missing sibling(s) added.
> 2. Drop the suffix to make this step linear.
> 3. `abort` to cancel."

---

### F-FLOW-BRANCH-UNWIRED — Branch page has an outgoing edge that cannot be wired to a Figma component

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** A page with out-degree > 1 (i.e. declared as a branch point via `Step Na:` / `Step Nb:`) cannot identify a distinct Figma component for at least one of its outgoing branches. Without a wired component, codegen can't produce separate click handlers for each branch — and the nav smoke test can't assert on each path.
- **Action:** Halt. List the branch page, its outgoing edges, and which one(s) failed to find a candidate component. Ask the user to name the Figma node explicitly or abort.
- **Max retries:** N/A
- **Related rule:** B-FLOW-MULTI-BRANCH validator invariant (non-null `source_component_node_id` on every branch)

**User prompt:**
> "Branch page `{figma_name}` (node `{node_id}`) has {N} outgoing branches, but I couldn't identify the Figma component for: {unwired_branches}. Options:
> 1. Tell me the Figma node id of the button/link that triggers each unwired branch.
> 2. Drop the affected branch from the prompt.
> 3. `abort`."

---

### F-FLOW-TOKENS-MISSING — design-tokens.json missing

- **Phase:** 1
- **Tier:** fatal
- **Trigger:** `.claude/d2c/design-tokens.json` does not exist.
- **Action:** Abort. Tell the user to run `/d2c-init` first.
- **Max retries:** 0
- **Related rule:** Non-negotiable 1

**User prompt:**
> "Cannot start the flow build — `.claude/d2c/design-tokens.json` is missing. Run `/d2c-init` first."

---

## Phase 2a — Flow Planning

### F-FLOW-OVERLAY-AS-PAGE — Listed step is an overlay-trigger component

- **Phase:** 2a
- **Tier:** inform (confirm to continue)
- **Trigger:** A step's Figma node's prototype metadata indicates it is an `OVERLAY` action target, or the frame is wrapped in a `<COMPONENT>` whose primary variant is an overlay.
- **Action:** Warn that overlays-as-pages are not supported in v1. Add to `not_supported_detected[]`. Ask the user whether to (a) skip the step and continue, (b) abort.
- **Max retries:** N/A

**User prompt:**
> "Step {N} (`{figma_name}`) looks like an overlay, not a full page. v1 does not support overlays as pages.
>
> Options:
> 1. Skip this step (flow becomes {N-1} pages)
> 2. Abort and rework the prompt"

---

### F-FLOW-CONDITIONAL — Listed step contains a conditional prototype action

- **Phase:** 2a
- **Tier:** inform (confirm to continue)
- **Trigger:** A step's Figma node has a prototype interaction whose action is conditional (e.g. `CONDITIONAL` navigate based on a variable).
- **Action:** Warn. Add to `not_supported_detected[]`. Confirm continue or abort.
- **Max retries:** N/A

**User prompt:**
> "Step {N} (`{figma_name}`) uses a conditional prototype action. v1 generates linear navigation only. The conditional will be ignored in codegen.
>
> Continue or abort?"

---

### F-FLOW-MISSING-STATE — Shared state declared but no form elements detected

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** The user declared `shared_state` (explicitly via CLI flag or auto-detected) but no form/input nodes were found across pages.
- **Action:** Ask whether to (a) drop the shared state declaration, (b) keep it (the generated provider will be unused until the user writes forms), (c) abort.
- **Max retries:** N/A

**User prompt:**
> "Shared state `{state_name}` was declared, but I didn't find any form or input elements across the pages. Options:
> 1. Drop the shared state declaration
> 2. Keep it — the provider will be generated but unused for now
> 3. Abort"

---

### F-FLOW-SHELL-DIVERGENT — Candidate shared layout variance exceeds threshold

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** Shell detection finds a candidate shared layout but the variance across pages is above the threshold (default: any of header/sidebar/footer differs across more than 25% of pages).
- **Action:** Warn, fall back to per-page layouts (i.e. emit no `layouts[]` entry). Continue automatically.
- **Max retries:** N/A

**Log line:**
> "No consistent shell detected across {N} pages (variance {pct}%). Falling back to per-page layouts."

---

### F-FLOW-DISCOVERY-EMPTY — Entry frame has no outgoing prototype connections (auto-discover mode)

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** `auto_discovered === true` (Form C: `Step: <entry-url>`) but the entry frame's `prototype.connections[]` is empty — nothing to BFS into.
- **Action:** Halt. Ask the user whether the entry frame is correct, whether they meant the explicit Form A (`Step 1:` … `Step N:`), or abort.
- **Max retries:** N/A
- **Related rule:** Form C grammar in SKILL.md

**User prompt:**
> "Entry frame `{figma_name}` (node `{node_id}`) has no outgoing prototype connections, so there's nothing to auto-discover. Options:
> 1. Repaste the prompt with explicit `Step 1:` … `Step N:` lines.
> 2. Repaste with a different entry frame.
> 3. Abort."

---

### F-FLOW-DISCOVERY-DISCONNECTED — Prototype graph has multiple disconnected subtrees

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** `auto_discovered === true` and the BFS from `entry_node_id` reaches a set of frames, but the file's prototype metadata contains additional frames reachable only from a different starting point. The user almost certainly meant one of the subtrees — we can't pick silently.
- **Action:** Halt. Enumerate each subtree by its entry frame name and size. Ask the user to pick 1..N or abort.
- **Max retries:** N/A

**User prompt:**
> "The Figma file has {count} disconnected flow subtrees starting from different entry frames:
> 1. `{subtree_1_entry_name}` ({subtree_1_size} frames)
> 2. `{subtree_2_entry_name}` ({subtree_2_size} frames)
> …
>
> Which one should I build? (number, or `abort`)"

---

### F-FLOW-DISCOVERY-CYCLE — Prototype graph contains a cycle; back-edge cut

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** `auto_discovered === true` and the prototype BFS revisits a frame already on the current branch (e.g. "Did you mean…?" loop back to step 2). v1 linearises the flow by cutting the back-edge.
- **Action:** Log a warning, record the cut edge in `not_supported_detected[]` with `kind: "loop"`, continue. The user sees this as a one-line inform in the final report.
- **Max retries:** N/A
- **Related rule:** Linear-only invariant until B-FLOW-LOOP-SUPPORT ships

**Log line:**
> "Prototype graph contains a cycle from node `{from}` back to node `{to}`. The back-edge was not emitted; re-entry loops are not supported in v1 (recorded in `not_supported_detected[]`)."

---

### F-FLOW-PROTOTYPE-CONTRADICTS-ORDER — Figma prototype edges disagree with declared step order

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** Figma prototype metadata exists and declares edges that conflict with the user's declared step order (e.g. prototype says step 3 → step 1 but prompt order is 1, 2, 3).
- **Action:** Log a warning. User's list wins. Continue automatically.
- **Max retries:** N/A

**Log line:**
> "Figma prototype order differs from declared step order ({figma_order} vs {declared_order}). Using declared order."

---

## Phase 4b — Navigation Smoke Test

### F-FLOW-NAV-ASSERT-FAIL — Navigation smoke test failed post-gen

- **Phase:** 4b
- **Tier:** inform
- **Trigger:** The generated `flow-navigation.spec.ts` Playwright test fails on one or more edges — either the URL-level `page.goto` check or the click-level assertion for wired edges.
- **Action:** Report which edges failed and whether each failure was URL-level or click-level. No auto-fix in v1.
- **Max retries:** 0

**Log line:**
> "Navigation smoke test failed for {count}/{total} edges. Failures:
> - Edge {from} → {to} ({level}): {error}
> - …
> Fix manually and re-run the test."

---

### F-FLOW-OVERLAY-PARENT-MISSING — Overlay page references a parent that isn't a `page_type='page'`

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** A page with `page_type: "overlay"` either has no `overlay_parent` or lists one whose `page_type !== "page"` (nested overlays aren't supported in v1).
- **Action:** Halt. Ask the user to either remap the overlay to a full `page`, or name the correct parent node id.
- **Max retries:** N/A
- **Related rule:** B-FLOW-OVERLAY-SUPPORT invariants in the validator.

**User prompt:**
> "Overlay page `{figma_name}` (node `{node_id}`) needs a valid parent. Current overlay_parent = `{parent}`.
>
> Options:
> 1. Tell me the node id of the parent `page` it opens inside.
> 2. Reclassify this node as a full page (`page_type = 'page'`).
> 3. `abort`."

---

### F-FLOW-CONDITION-FIELD-UNKNOWN — `edges[].condition.field` doesn't match any declared state writer

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** A conditional edge references a shared-state field (`condition.field`) that no page writes via its `state:` directive. Likely a typo.
- **Action:** Halt. List the offending edge(s) and the set of fields that ARE declared. Offer rename / add-writer / drop-condition.
- **Max retries:** N/A
- **Related rule:** B-FLOW-CONDITIONAL-NAV validator invariant.

**User prompt:**
> "Edge `{from}` → `{to}` reads state field `{field}`, but no page declares it.
> Declared fields: `{declared_fields}`.
>
> Options:
> 1. Rename the condition's field to one of the declared names.
> 2. Add a `state: {field}:<type>` directive to the page that sets it.
> 3. Drop the condition (edge becomes unconditional).
> 4. `abort`."

---

### F-FLOW-CROSS-FILE-DEPENDENCY — Flow spans multiple Figma files

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** `flow-graph.cross_file === true` — the parsed steps list URLs from more than one file_key. Phase 2a must call `get_design_context` per file; a broken token on any one file fails the whole build.
- **Action:** Log the dependency list so the user can verify they have access to every file. Continue automatically.
- **Max retries:** N/A

**Log line:**
> "Flow spans {N} Figma files: {file_keys}. Ensure every file is reachable from the current MCP session — missing access on any one file will abort Phase 2a."

---

### F-FLOW-MOBILE-URL — `mobile:` URL missing `node-id` or unreachable

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step line's `mobile:` directive points at a URL without a `node-id` query parameter, or the referenced frame can't be resolved during Phase 2a.
- **Action:** Halt. Offer the same frame pick-list flow as `F-FLOW-FILE-URL`, scoped to the mobile URL's file.
- **Max retries:** N/A
- **Related rule:** B-FLOW-MOBILE-VARIANT grammar.

**User prompt:**
> "Step {N}'s `mobile:` URL is not a frame URL:
> {url}
>
> Mobile URLs must include a `node-id` just like the desktop URL. Repaste with the correct frame URL, drop the `mobile:` directive (builds desktop-only), or `abort`."

---

### F-FLOW-NAV-AUTOFIX-EXHAUSTED — Nav-test autofix hit `--nav-max-rounds` without a passing diff

- **Phase:** 4b
- **Tier:** inform
- **Trigger:** `nav-autofix-plan.js` returned `action: "escalate"` because every candidate has been tried and the nav test still fails.
- **Action:** Report the full planner trail (per-round action + candidate + outcome). Do NOT silently retry — the next rerun starts from round 0.
- **Max retries:** 0 after exhaustion; caller may re-invoke with a higher `--nav-max-rounds`.
- **Related rule:** B-FLOW-NAV-AUTOFIX caps

**Log line:**
> "Nav-test autofix exhausted {rounds}/{max_rounds} rounds on edge `{from}` → `{to}` (click-level). Planner actions tried: {trail}. Fix manually or re-run with --nav-max-rounds {max_rounds+2}."

---

## Catch-all

### FX-UNKNOWN-FAILURE — Unrecognized failure (catch-all)

- **Phase:** any
- **Tier:** stop-and-ask
- **Trigger:** A failure condition outside any of the above.
- **Action:** Halt. Present the raw error and ask the user how to proceed. Do NOT invent an ad-hoc recovery.
- **Max retries:** N/A
- **Related rule:** Anti-rationalization meta-rule

**User prompt:**
> "I hit an unexpected failure in phase {N}: `{error_summary}`. I don't have a named recovery for this. Options:
> 1. Show the full diagnostic and let me decide
> 2. Skip this phase (if skippable) and continue
> 3. Abort the flow build"
