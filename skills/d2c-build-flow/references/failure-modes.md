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
| F-FLOW-INTAKE-METADATA-FAILED | 1.5 | stop-and-ask | `mcp__Figma__get_metadata` failed for one or more steps during complexity classification |
| F-FLOW-MOBILE-FRAME-MISSING | 1.5 | stop-and-ask | A mobile URL supplied in §1.5b Q7 returned 404 from `get_metadata` |
| F-FLOW-MOBILE-COUNT-MISMATCH | 1.5 | stop-and-ask | Number of pasted mobile URLs (excluding `skip` lines) doesn't match declared step count |
| F-FLOW-MOBILE-DOUBLE-SOURCE | 2a | stop-and-ask | Same step has both a Phase 1 inline `mobile:` URL and a Phase 1.5 bulk URL |
| F-FLOW-LOCK-MISSING | 2a / 3 / 4 / 5 | auto-recover | `flow-decisions-lock.json` missing or its `flow_graph_hash` doesn't match the current `flow-graph.json` |
| F-FLOW-LOCK-CONFLICT | 3 / 4 / 5 | stop-and-ask | A `status: "locked"` decision in `flow-decisions-lock.json` doesn't match the current `flow-graph.json` value |
| F-FLOW-WALKER-NEXT-NOT-FOUND | 4a | stop-and-ask | Flow-walker can't find the Next button at step N |
| F-FLOW-WALKER-VALIDATION-BLOCKED | 4a | stop-and-ask | Auto-fixture filled all fields but Next stayed disabled on a `validate: form` step |
| F-FLOW-WALKER-STEP-TIMEOUT | 4a | retry-then-escalate | Step N didn't render within 5s after click |
| F-FLOW-WALKER-FIGMA-EXPORT-MISSING | 4a | stop-and-ask | Figma export for step N's loaded frame unreachable via MCP |
| F-FLOW-WALKER-REGRESSION | 4a | auto-recover | Auto-fix dropped pixel-diff score >1pp; revert + try alternate fix once |
| F-FLOW-WALKER-PLATEAU | 4a | conditional | Auto-fix improvement <1pp; inform if score ≥80%, stop-and-ask if <80% |
| F-FLOW-WALKER-OSCILLATION | 4a | stop-and-ask | Last 3 auto-fix scores within 2pp range — loop won't converge |
| F-FLOW-WALKER-SHARED-BLAST | 4a | stop-and-ask | Auto-fix would edit shared orchestrator/state context affecting other passing steps |
| F-FLOW-WALKER-CHECKPOINT-STALE | 4a | auto-recover | `walker-checkpoint.json` references a flow-graph hash that no longer matches |
| F-FLOW-WALKER-DEPS-MISSING | 4a | auto-recover | `pixelmatch`, `pngjs`, or `@playwright/test` not reachable when walker tries to start |
| F-FLOW-WALKER-AUTH-DETECTED-NO-CREDS | 4a | stop-and-ask | Auth detected + flow has API calls + no `D2C_TEST_USER`/`D2C_TEST_PASSWORD` in `.env.local` |
| F-FLOW-WALKER-AUTH-BYPASS-INSTRUCTIONS | 4a | inform | Auth detected + UI-only flow — emitted snippet for the user to add gated routes to public list |
| F-FLOW-WALKER-AUTH-LOGIN-FAILED | 4a | stop-and-ask | Walker tried to log in via the configured credentials but the login flow did not produce a session |
| F-FLOW-NAV-AUTOFIX-EXHAUSTED | 4b | inform | Nav-test autofix hit `--nav-max-rounds` without a passing diff |
| F-FLOW-HONOR-COMPONENT-UNAUTHORIZED | 5 | stop-and-ask | Flow-emitted file imports a PascalCase component that isn't in `flow-graph.layouts[]`, `design-tokens.components[]`, or `app/<route>/steps/` |
| F-FLOW-HONOR-TOKEN-UNAUTHORIZED | 5 | stop-and-ask | Flow-emitted file uses a hardcoded value matching a token in `design-tokens.json` instead of the semantic class |
| F-FLOW-HONOR-PROP-CONTRACT | 5 | stop-and-ask | Orchestrator or state context violates the step prop contract (`framework-react-next.md` §"Step component prop contract") |
| F-FLOW-HONOR-EDGE-MISSING | 5 | inform | Nav-smoke spec doesn't assert a route from `flow-graph.edges[]` |
| F-FLOW-HONOR-WALKER-COVERAGE | 5 | inform | Flow-walker spec doesn't cover a host (page or stepper-step loaded slot) at every required viewport |
| F-FLOW-SHARED-COMPONENT-MUTATION | 3 / 4a / 5b | stop-and-ask | Codegen or auto-fix tried to write to a `design-tokens.components[]` entry whose `import_count ≥ --shared-component-threshold` (flow-rule #12) |
| F-FLOW-WRAPPER-PROP-SOUP | 3 / 5b | stop-and-ask | A shared component's prop signature would gain a step-scoped prop (`isStep2`, `checkoutVariant`, …) — flow-rule #13 requires a wrapper instead |
| F-FLOW-BLAST-RADIUS-REGRESSION | 4a | stop-and-ask | Auto-fix for the current host dropped a previously passing host below `--threshold`; flow-rule #14 halts the oscillation |
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
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
- **Related rule:** Grammar section of SKILL.md

**Runtime procedure** (MUST follow — `B-FLOW-INTAKE-FRAME-PICKER`):

1. Parse the Figma file key from the offending step URL (the path segment after `/design/` or `/file/`).
2. Call `mcp__figma__get_metadata` with that file key to retrieve the top-level frame list.
3. Render the response as a numbered pick-list per SKILL.md §"When `F-FLOW-FILE-URL` fires" (Phase 1):
   - Top-level FRAME nodes only.
   - When the file has no top-level FRAMEs, escalate to `FX-UNKNOWN-FAILURE` with "Figma file `<url>` has no top-level frames"; do NOT present an empty pick-list.
4. Accept user input:
   - `^\d+$` that indexes into the printed pick-list → rebuild the step line as `Step <N>: <fileUrl>?node-id=<chosen-node-id>` and re-run Phase 1 from the top (parser). `node-id` values must be in colon form (`1:234`).
   - `abort` → stop the flow cleanly.
   - Any other input → re-show the prompt unchanged (do NOT improvise).

**User prompt template:**
> "Step {N} points to a Figma file URL, not a specific frame:
> {url}
>
> Frames in this file:
> 1. {frame_name_1} — node {node_id_1}
> 2. {frame_name_2} — node {node_id_2}
> …
>
> Which frame is step {N}? (number, or `abort`)"

**Context to show:** The Figma file URL the user provided and the `get_metadata` frame list (top-level frames only, `type === "FRAME"`). Nested children and non-FRAME entries (`SECTION`, `GROUP`, `COMPONENT`, etc.) MUST be filtered out — they're not valid frame URLs.

---

### F-FLOW-NO-ROUTE — Step has no route and no base route in preamble

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** At least one step has neither an explicit `route: /path` suffix nor a derivable route from a `route /base` token in the preamble.
- **Action:** Halt. Ask the user for a base route once; apply it to every unrouted step as `<base>/step-<N>`.
- **Max retries:** N/A
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
- **Related rule:** Grammar section of SKILL.md

**User prompt:**
> "I only parsed {count} step line(s). A flow needs at least 2 steps. Please repaste the prompt with all steps, or run `/d2c-build` for a single page."

---

### F-FLOW-STATE-TYPE-UNSUPPORTED — `state:` directive uses an unsupported field type

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step line's `state:` directive declares a field whose type is not one of `string | number | boolean`. v1 typed state is primitives-only; complex shapes (Date, arrays, nested objects) need manual typing after codegen.
- **Action:** Halt. Echo the offending field(s). Offer: (1) repaste with a supported primitive, (2) drop the field from the directive and write the typed shape by hand post-build, (3) abort.
- **Max retries:** N/A
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #7 (parsed step list authoritative)

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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #7 (parsed step list authoritative)

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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #8 (Flow IR freezes in Phase 2a)

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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #8 (Flow IR freezes in Phase 2a)

**Log line:**
> "No consistent shell detected across {N} pages (variance {pct}%). Falling back to per-page layouts."

---

### F-FLOW-DISCOVERY-EMPTY — Entry frame has no outgoing prototype connections (auto-discover mode)

- **Phase:** 2a
- **Tier:** stop-and-ask
- **Trigger:** `auto_discovered === true` (Form C: `Step: <entry-url>`) but the entry frame's `prototype.connections[]` is empty — nothing to BFS into.
- **Action:** Halt. Ask the user whether the entry frame is correct, whether they meant the explicit Form A (`Step 1:` … `Step N:`), or abort.
- **Max retries:** N/A
- **Lock impact:** none
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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #11 (mode argument controls flow shape)

**User prompt:**
> "The Figma file has {count} disconnected flow subtrees starting from different entry frames:
> 1. `{subtree_1_entry_name}` ({subtree_1_size} frames)
> 2. `{subtree_2_entry_name}` ({subtree_2_size} frames)
> …
>
> Which one should I build? (number, or `abort`)"

> Anti-rationalization: Do NOT silently pick the largest subtree — multiple disconnected entry frames means the user has multiple flows in the same file; the user picks which one to build.

---

### F-FLOW-DISCOVERY-CYCLE — Prototype graph contains a cycle; back-edge cut

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** `auto_discovered === true` and the prototype BFS revisits a frame already on the current branch (e.g. "Did you mean…?" loop back to step 2). v1 linearises the flow by cutting the back-edge.
- **Action:** Log a warning, record the cut edge in `not_supported_detected[]` with `kind: "loop"`, continue. The user sees this as a one-line inform in the final report.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Linear-only invariant until B-FLOW-LOOP-SUPPORT ships

**Log line:**
> "Prototype graph contains a cycle from node `{from}` back to node `{to}`. The back-edge was not emitted; re-entry loops are not supported in v1 (recorded in `not_supported_detected[]`)."

> Anti-rationalization: Do NOT silently break the cycle by picking the longer path — record the back-edge as `not_supported` and inform; cycles are user-design decisions, not auto-recoverable.

---

### F-FLOW-PROTOTYPE-CONTRADICTS-ORDER — Figma prototype edges disagree with declared step order

- **Phase:** 2a
- **Tier:** inform
- **Trigger:** Figma prototype metadata exists and declares edges that conflict with the user's declared step order (e.g. prototype says step 3 → step 1 but prompt order is 1, 2, 3).
- **Action:** Log a warning. User's list wins. Continue automatically.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Flow-specific rule #7 (parsed step list authoritative)

**Log line:**
> "Figma prototype order differs from declared step order ({figma_order} vs {declared_order}). Using declared order."

---

### F-FLOW-LOCK-MISSING — flow-decisions-lock.json missing or stale

- **Phase:** 2a (write), 3 / 4 / 5 (read)
- **Tier:** auto-recover
- **Trigger:** `<run-dir>/flow/flow-decisions-lock.json` does not exist when a downstream phase tries to read it, OR its `flow_graph_hash` field doesn't match the SHA-256 of the current `flow-graph.json` content. The latter happens when the lock was emitted from a different graph (e.g. the user re-ran Phase 2a and the rerun produced a slightly different IR).
- **Action:** Re-emit the lock by running `node skills/d2c-build-flow/scripts/write-flow-lock.js <run-dir>/flow/flow-graph.json --out <run-dir>/flow/flow-decisions-lock.json`. The writer is deterministic — same flow-graph + same `--locked-at` produces a byte-identical lock. After regeneration, retry the original phase. No prompt to the user; this is a recoverable bookkeeping miss.
- **Max retries:** 1 (one regenerate; if the second read still fails, escalate as **PX-RETRY-EXHAUSTION**)
- **Lock impact:** N/A — this failure regenerates the lock from scratch.
- **Related rule:** Non-negotiable #3 (Lock honored).

**Log line:**
> "flow-decisions-lock.json missing or stale (hash drift). Regenerating from current flow-graph.json."

---

### F-FLOW-LOCK-CONFLICT — Locked decision differs from current flow-graph

- **Phase:** 3 / 4 / 5
- **Tier:** stop-and-ask
- **Trigger:** A `status: "locked"` entry in `flow-decisions-lock.json` does not match the current `flow-graph.json` value. Triggered when something downstream of Phase 2a tries to mutate a locked decision — e.g. Phase 3 codegen wants to switch `project_conventions.error_boundary_kind` from `next-file-convention` to `react-error-boundary` because the user's project mid-flow installed `react-error-boundary`. Detected by `validate-flow-graph.js --verify-lock`.
- **Action:** Halt. Surface every conflicting decision (the validator emits one `error: flow-decisions-lock — F-FLOW-LOCK-CONFLICT — <path> — locked=<value> current=<value>` line per mismatch). Ask the user to either (a) accept the lock and revert the IR, (b) accept the new IR and mark the locked entry `failed` (which permits re-decision and writes a new lock entry with `failed_by` set to the calling phase), or (c) abort.
- **Max retries:** 0
- **Lock impact:** Choice (b) marks the conflicting entry as `failed` with `failure_reason` describing the conflict and `failed_by` set to `phase3_codegen` / `phase4_walker` / `phase4b_navsmoke` / `phase5_audit` / `user_override` per the calling phase. Re-locking on the new value happens at the next successful Phase 2a re-emit.
- **Related rule:** Non-negotiable #3 (Lock honored).

**User prompt:**
> "Detected a flow-decisions-lock conflict. The following decision(s) differ from the lock:
> - {path}: locked={locked_value}, current={current_value}
>
> Options:
> (a) Revert the IR to match the lock (preserves the original Phase 2a plan).
> (b) Accept the new IR and mark these entries `failed` so they can be re-decided. The lock will be re-emitted on the next Phase 2a freeze.
> (c) Abort — review the divergence manually before continuing."

> Anti-rationalization: Do NOT silently update the lock to match the current IR. The lock exists so retries converge; bypassing it defeats the discipline mechanism. The user gets to decide which side wins.

---

## Phase 4a — Flow-Walker Pixel-Diff

### F-FLOW-WALKER-NEXT-NOT-FOUND — Walker can't find Next button at step N

- **Phase:** 4a
- **Tier:** stop-and-ask
- **Trigger:** The flow-walker spec called `await page.getByRole("button", { name: /next|continue|submit|finish|done|confirm/i }).click()` at stepper step N, but no matching button was found in the rendered DOM.
- **Action:** Halt. Show the first 200 lines of the rendered HTML at the time of failure and ask the user to either (a) fix the orchestrator's footer Next button text to match the regex, (b) confirm the step's design has a Next button with different text and supply the regex extension, or (c) abort and re-check the orchestrator emission.
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** SKILL.md §"Phase 4a.3 Stepper navigation"

**User prompt:**
> "Flow-walker couldn't find a Next button at <Group> step <N>. The rendered DOM had <list-of-buttons>. Options: (a) update the orchestrator footer to use 'Next' / 'Continue' / 'Submit' text, (b) the step uses non-standard text — paste the button label, (c) abort."

---

### F-FLOW-WALKER-VALIDATION-BLOCKED — Auto-fixture exhausted but Next stays disabled

- **Phase:** 4a
- **Tier:** stop-and-ask
- **Trigger:** A `validate: form` step received auto-fixture data for every wired field but the Next button remained `disabled` (or fired no `onClick` event when clicked). Likely a regex / business-rule constraint the auto-fixture didn't satisfy (e.g. password complexity, age >= 18, regex-narrow phone format).
- **Action:** Halt. Surface the field values used and the field metadata (regex, min/max, required attributes) and ask the user to supply real fixture values for this step. Persist the user's values to `<run-dir>/flow/walker-fixtures.json` (schema at `skills/d2c-build-flow/schemas/walker-fixtures.schema.json`) per the read-merge-write protocol in SKILL.md §4a.2: read the file (or treat as `{schema_version: 1, fixtures: {}}` if missing), insert `fixtures[<group_node_id>__step_<N>][<field-name>] = { value: "<user-value>", supplied_by: "user", supplied_at: "<ISO 8601>", field_type: "string|number|boolean" }`, write atomically (`>tmp; mv tmp final`). The user-wins rule in SKILL.md §4a.2 guarantees that subsequent auto-fixture writes can never silently overwrite this entry — so the next walker run reads the persisted value BEFORE generating an auto-fixture, and this STOP-AND-ASK fires at most once per (step, field) tuple per project lifetime.
- **Max retries:** 0 (one prompt; the persistence layer guarantees no repeat)
- **Lock impact:** none
- **Related rule:** SKILL.md §"Phase 4a.2 Auto-fixture for `validate: form` steps". Anti-rationalization: Do NOT reason that "a longer auto-fixture string would probably pass" — the validation pattern is the user's contract; they supply the values.

**User prompt:**
> "Auto-fixture for <Group> step <N> filled <fields-with-values> but Next stayed disabled. Likely the form has stricter validation than the auto-fixture covers. Please supply valid values (each will be saved to <run-dir>/flow/walker-fixtures.json so reruns won't re-prompt):
> - <field-name> (current auto value: <value>): "
> Press Enter after each field. Empty input keeps the auto value (and the auto value gets persisted as `supplied_by: \"auto-fixture\"` so the merge helper still records the attempt)."

**Fixture format (excerpt — see `walker-fixtures.schema.json` for the canonical contract):**
```json
{
  "schema_version": 1,
  "fixtures": {
    "stepper:abc__step_1": {
      "email":    { "value": "real-user@example.com", "supplied_by": "user", "supplied_at": "2026-04-19T12:00:00Z", "field_type": "string" },
      "password": { "value": "Real$Password123",      "supplied_by": "user", "supplied_at": "2026-04-19T12:00:00Z", "field_type": "string" }
    }
  }
}
```

---

### F-FLOW-WALKER-STEP-TIMEOUT — Step N didn't render within 5s after Next click

- **Phase:** 4a
- **Tier:** retry-then-escalate
- **Trigger:** The walker clicked Next and waited up to 5s for the `data-stepper-step` attribute to advance (or the body to settle), but neither happened. Likely a runtime error in the step component or the provider, OR the step is genuinely slow to mount (heavy initial query).
- **Action:** Retry once with a 10s timeout. If the second attempt also times out, escalate: dump the rendered HTML and console errors at timeout, fire **F-FLOW-WALKER-STEP-TIMEOUT** as a failed pixel-diff round, and let the auto-fix loop attempt to repair the step.
- **Max retries:** 1 (10s on retry, then escalate)
- **Lock impact:** none
- **Related rule:** SKILL.md §"Phase 4a.3 Stepper navigation"

**Log line (first timeout):**
> "Step <N> didn't render within 5s after Next click — retrying with 10s timeout."

**Log line (second timeout):**
> "Step <N> didn't render within 10s. Console errors: <errors>. Treating as a failed pixel-diff round; auto-fix will retry the step's body."

---

### F-FLOW-WALKER-FIGMA-EXPORT-MISSING — Figma export unreachable via MCP

- **Phase:** 4a
- **Tier:** stop-and-ask
- **Trigger:** `mcp__Figma__get_screenshot(node_id, viewport)` returned 404 / unreachable / empty for one or more hosts during the walker's pixel-diff pass.
- **Action:** Halt. Surface the failing host's `(node_id, figma_url)` and ask the user to either (a) verify the frame still exists in Figma (it may have been renamed or deleted), (b) supply a different Figma URL, or (c) skip pixel-diff for this host (the walker will still navigate it for nav-smoke purposes but emit `{slot: "loaded", status: "skipped", reason: "figma_export_missing"}` in audit.json).
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** SKILL.md §"Phase 4a.4 Pixel-diff per screenshot"

**User prompt:**
> "Figma export for <route> (node <node_id>) is unreachable via MCP. Options: (a) re-check the Figma frame exists, (b) supply a new URL for this host, (c) skip pixel-diff for this host."

---

### F-FLOW-WALKER-REGRESSION — Auto-fix dropped pixel-diff score

- **Phase:** 4a
- **Tier:** auto-recover
- **Trigger:** After applying an auto-fix in round N, the new pixel-diff score is more than `REGRESSION_DELTA` (1.0pp) below the round N-1 score. Detected per the in-line rule in SKILL.md §4a.5 step 3. Mirrors `d2c-build/SKILL.md` §Phase 4.4b.
- **Action:** Revert all files edited in round N from the snapshot at `<run-dir>/flow/walker-snapshots/<host_node_id>/round-<N>/` (reverse `cp` per SKILL.md §4a.5 step 4). Then dispatch `/d2c-build` ONE more time with a different fix strategy — pass the previous failed strategy in `fix_target.previous_failed_strategies[]` so the AI doesn't repeat itself. If the alternate fix ALSO regresses, escalate to STOP AND ASK with the round history.
- **Max retries:** 1 (one alternate fix attempt; if it also regresses, escalate)
- **Lock impact:** none (the lock isn't touched; we're rolling back code, not IR)
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file). Anti-rationalization: Do NOT silently accept the lower score because "it's only 2pp" — regressions compound across rounds, and the snapshot mechanism exists precisely so we don't compound.

**Log line (first regression — auto-recover):**
> "Round {N} regressed score from {prev}% to {current}% (Δ {delta}pp). Reverted edits and trying alternate fix strategy."

**User prompt (second regression — escalate):**
> "Auto-fix regressed twice on host {node_id} ({route}, viewport={viewport}):
>   Round {N-1}: {score_n_minus_1}% → Round {N}: {score_n}% (reverted).
>   Round {N+1}: alternate fix → {score_n_plus_1}% (also regressed).
> Options:
> (a) Accept the original score ({original_score}%) and move on.
> (b) Show me the diff regions and let me fix this manually.
> (c) Re-run Phase 2 for this host (re-decide its IR — this requires marking the host's lock entries as `failed`)."

---

### F-FLOW-WALKER-PLATEAU — Auto-fix improvement < 1pp

- **Phase:** 4a
- **Tier:** conditional (inform if score ≥ 80%, stop-and-ask if score < 80%)
- **Trigger:** After round N, the new score improved by less than `PLATEAU_DELTA` (1.0pp) over round N-1. Detected per the in-line rule in SKILL.md §4a.5 step 3. The conditional tier mirrors d2c-build's P4-PLATEAU — at high scores (≥80%) the remaining diff is usually renderer artefacts (anti-aliasing, sub-pixel positioning) and not worth more rounds; at low scores it usually means the auto-fix strategy is wrong and the user should weigh in.
- **Action:** Two branches keyed on the current score. **At score ≥80%** (inform tier): STOP autofixing this (host, viewport); record `{ status: "plateau", final_score: <score>, plateau_reason: "improvement_below_threshold" }` in `audit.json` and push an `audit.json.warnings[]` entry with kind `walker_plateau` so the Phase 6 report surfaces it. **At score <80%** (stop-and-ask tier): Halt; show the score progression and ask the user whether to (a) accept the current score and stop, (b) try a different fix strategy (re-prompt with hints), or (c) re-run Phase 2 for this host.
- **Max retries:** 0 in either branch
- **Lock impact:** none for the ≥80% branch; choice (c) in the <80% branch marks the host's lock entries as `failed` so Phase 2 can re-decide.
- **Related rule:** Non-negotiable #6 (NEVER re-decide a locked component or token). Anti-rationalization: Do NOT add "one more round" hoping it'll improve. The plateau IS the convergence signal; ignoring it means oscillation in 1-2 more rounds.

**Log line (≥80%):**
> "Round {N} plateau on host {node_id} ({route}, viewport={viewport}): {prev}% → {current}% (Δ {delta}pp). Score above 80% — accepting and recording warning."

**User prompt (<80%):**
> "Auto-fix plateaued on host {node_id} ({route}, viewport={viewport}) at {current}% (improvement {delta}pp over previous round). Score is below 80% so this likely needs more than spacing/colour tweaks. Options:
> (a) Accept {current}% and continue (records a warning in audit.json).
> (b) Show me the diff regions; I'll provide a fix hint and you re-run.
> (c) Re-run Phase 2 for this host (re-decide its IR — locks the affected entries as `failed`)."

---

### F-FLOW-WALKER-OSCILLATION — Last 3 scores within 2pp

- **Phase:** 4a
- **Tier:** stop-and-ask
- **Trigger:** The last `OSCILLATION_WINDOW` (3) auto-fix scores fall within `OSCILLATION_DELTA` (2.0pp) of each other. Detected per the in-line rule in SKILL.md §4a.5 step 3. The auto-fix loop is bouncing between candidate fixes — each round picks a different region to nudge but the overall score doesn't move. Mirrors d2c-build's plateau-with-oscillation case.
- **Action:** Halt. Show the 3-round score history and the diff regions for each round. Ask the user whether to (a) accept the current score and stop, (b) provide a fix hint (will be passed to `/d2c-build` in the next dispatch), or (c) re-run Phase 2 for this host.
- **Max retries:** 0
- **Lock impact:** Choice (c) marks the host's lock entries as `failed`.
- **Related rule:** Anti-rationalization: Do NOT keep retrying hoping a different round picks a better region. The oscillation IS the signal that the strategy space is exhausted.

**User prompt:**
> "Auto-fix is oscillating on host {node_id} ({route}, viewport={viewport}). Last 3 scores: {s1}% → {s2}% → {s3}% (range {range}pp ≤ 2pp). The loop is bouncing between candidate fixes without converging. Options:
> (a) Accept {s3}% and continue.
> (b) Tell me what to focus on (which region in the design isn't matching), and I'll re-run with that hint.
> (c) Re-run Phase 2 for this host."

---

### F-FLOW-WALKER-SHARED-BLAST — Auto-fix would edit shared orchestrator/state-context

- **Phase:** 4a
- **Tier:** stop-and-ask
- **Trigger:** Before applying an auto-fix in round N, the file scope includes `<group_route>/page.tsx` (orchestrator) or `<group_route>/state/<Group>Context.tsx` (state context). Both files are shared across every step in the group, so a fix that improves one step's diff might regress others. Mirrors d2c-build's P4-SHARED-BLAST-RADIUS.
- **Action:** Halt. List which other steps depend on the file the AI wants to edit, and which of those steps already passed pixel-diff. Ask the user whether to (a) proceed with the edit (acknowledging the blast radius), (b) confine the fix to step-body files only (which won't ripple), or (c) abort and let the user fix manually.
- **Max retries:** 0
- **Lock impact:** none directly; choice (a) may indirectly cause F-FLOW-WALKER-REGRESSION on other steps in the next round.
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file). Anti-rationalization: Do NOT proceed silently because "the orchestrator is the obvious place to fix the layout". The orchestrator owns wiring; if a step's body doesn't match its frame, the body file is the right edit target.

**User prompt:**
> "Auto-fix wants to edit a shared file: {file}. This file is used by {N} steps in the group: [{list}]. Of those, {M} already passed pixel-diff at ≥{threshold}% — editing this file may regress them.
> Options:
> (a) Proceed with the edit (I'll re-run the walker for ALL N steps to catch any regression).
> (b) Confine the fix to the failing step's body file only (recommended — safer blast radius).
> (c) Abort; I'll fix the shared file manually."

---

### F-FLOW-WALKER-CHECKPOINT-STALE — Walker checkpoint references a stale flow-graph

- **Phase:** 4a (entry / resume check)
- **Tier:** auto-recover
- **Trigger:** `walker-checkpoint.json` exists at `<run-dir>/flow/walker-checkpoint.json`, but its `flow_graph_hash` field doesn't match the SHA-256 of the current `flow-graph.json` content (compare via `shasum -a 256`). Detected by the `STATE=stale` path in SKILL.md §4a.0c. Triggered when the user re-ran Phase 2a between sessions and the rerun produced a different IR — OR when the checkpoint file is corrupted/unparseable.
- **Action:** `rm <run-dir>/flow/walker-checkpoint.json` and proceed as if no checkpoint existed (start the walker fresh from host index 0). Log a one-line warning so the user knows the previous walker progress was discarded; do not prompt — this is a recoverable bookkeeping miss, not a divergence the user needs to weigh in on.
- **Max retries:** N/A (delete + start fresh always succeeds)
- **Lock impact:** none (this failure is about checkpoint freshness, not lock-decision drift; `flow-decisions-lock.json` has its own F-FLOW-LOCK-MISSING for an analogous case).
- **Related rule:** Non-negotiable #1 (Single source of truth — `flow-graph.json` is authoritative; the checkpoint follows it, not the other way around).

**Log line:**
> "Discarding stale walker-checkpoint.json (flow_graph_hash mismatch: checkpoint {old_hash}, current {new_hash}). Starting walker fresh."

---

### F-FLOW-WALKER-DEPS-MISSING — Walker dependencies not reachable

- **Phase:** 4a (Phase 4a.0 pre-flight)
- **Tier:** auto-recover
- **Trigger:** One or more of the three Phase 4a.0a `node -e "require('...')"` checks (pixelmatch, pngjs, @playwright/test) exited non-zero. Mirrors d2c-build's P4-PIXELDIFF-DEPS but bundles all three deps in one check so Phase 4a.0 makes a single decision instead of three sequential ones.
- **Action:** Run the install pass from SKILL.md §4a.0a once: `npm install -g pixelmatch pngjs && npm install -D @playwright/test`. Re-run all three checks; if anything is still missing, escalate to **PX-RETRY-EXHAUSTION** with the install error in the prompt.
- **Max retries:** 1 (one install attempt, then escalate)
- **Lock impact:** none
- **Related rule:** Non-negotiable #1 (Design tokens MUST be loaded — by extension, every tool the walker needs MUST be reachable before Phase 4a starts).

**Log line:**
> "Walker preflight failed: missing [{deps}]. Running `npm install -g pixelmatch pngjs && npm install -D @playwright/test`. Re-checking…"

---

### F-FLOW-WALKER-AUTH-DETECTED-NO-CREDS — Auth present but no test credentials

- **Phase:** 4a (Phase 4a.0 auth pre-flight)
- **Tier:** stop-and-ask
- **Trigger:** Phase 4a.0b auth detection (SKILL.md) found a system AND at least one flow route is gated AND the flow has `flow_intake.has_api_calls === "yes"` (so a public-route bypass would mask real auth-gated API behaviour) AND `process.env.D2C_TEST_USER` / `process.env.D2C_TEST_PASSWORD` are unset (the walker reads them from `.env.local` at runtime).
- **Action:** Halt. Show the detected auth system, the gated routes from `flow-graph.pages[].route ∩ protected_routes`, and ask the user to add credentials to `.env.local`. Show the exact two lines the user needs to paste. After the user confirms the env vars are set, re-run the walker.
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** Non-negotiable #1 (Design tokens MUST be loaded — by extension, every credential the walker needs MUST be reachable before Phase 4a runs).

**User prompt:**
> "Detected `{system}` auth in this project. The following flow routes are protected and need a logged-in session for the walker to pixel-diff:
> - {route_1}
> - {route_2}
> ...
>
> Because the flow declared API calls (Phase 1.5 Q6 = yes), the walker needs a real authenticated session — a public-route bypass would skip the API integration. Please add test credentials to `.env.local`:
> ```
> D2C_TEST_USER=<your test user email>
> D2C_TEST_PASSWORD=<your test user password>
> ```
> The walker will read both env vars and use them in a `loginBefore()` Playwright fixture. `.env.local` is gitignored by Next.js convention so credentials don't ship.
>
> Press Enter once `.env.local` is updated, or type `abort` to stop."

> Anti-rationalization: Do NOT skip the auth-gated pages because they're "harder to test." Gated pages are usually the most important pages in the flow (dashboards, account settings) — bypassing them silently means the walker reports a green pixel-diff on pages it never actually rendered. Halt until creds exist.

---

### F-FLOW-WALKER-AUTH-BYPASS-INSTRUCTIONS — Auth present, UI-only flow — emit bypass snippet

- **Phase:** 4a (Phase 4a.0 auth pre-flight)
- **Tier:** inform
- **Trigger:** Phase 4a.0b auth detection (SKILL.md) found a system AND at least one flow route is gated AND the flow has `flow_intake.has_api_calls === "no"` (UI-only — no real API integration to exercise). Adding gated routes to a public-routes bypass is safe because there's no auth-protected business logic to skip.
- **Action:** Generate `<run-dir>/flow/walker-auth-bypass.md` containing a per-system snippet the user pastes into their auth config (next-auth → `auth.config.ts` `pages.signIn` / `callbacks.authorized`; clerk → `middleware.ts` `publicRoutes: [...]`; supabase → middleware skip-list; bare middleware → matcher exclusion). Log an inform-level notice with the file path. Pause the walker once for the user to confirm they've applied the snippet (no STOP-AND-ASK prompt — just a `Press Enter to continue` blocker).
- **Max retries:** N/A (the snippet emit is one-shot; the walker waits for user confirmation).
- **Lock impact:** none
- **Related rule:** Non-negotiable #1.

**Log line:**
> "Auth detected (`{system}`) but flow is UI-only — wrote bypass snippet to `<run-dir>/flow/walker-auth-bypass.md`. Apply the snippet, then press Enter to continue. The bypass is meant to be temporary; revert it before shipping."

> Anti-rationalization: Do NOT auto-edit the user's `auth.config.ts` / `middleware.ts`. Those files are security boundaries. The user gets to decide when and how to apply the bypass.

---

### F-FLOW-WALKER-AUTH-LOGIN-FAILED — Walker login attempt did not produce a session

- **Phase:** 4a (during walker run, in the `loginBefore()` fixture)
- **Tier:** stop-and-ask
- **Trigger:** The walker's `loginBefore()` Playwright fixture submitted the login form with `D2C_TEST_USER` / `D2C_TEST_PASSWORD` but did not see one of: a redirect away from the login URL, a `data-authenticated` attribute on `<body>`, or a session cookie matching the detected system's cookie name (`next-auth.session-token` for next-auth, `__session` for Clerk, `sb-access-token` for Supabase). Likely causes: wrong creds, MFA blocking the login, or a custom login form selector the walker didn't match.
- **Action:** Halt. Surface the rendered HTML at the moment of failure (last 500 chars), the URL the walker was on, and the error message Playwright reported. Ask the user to either (a) update `.env.local` with corrected credentials, (b) supply a custom selector for the login form (will be persisted in `<run-dir>/flow/walker-auth-config.json`), or (c) abort.
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** Non-negotiable #1.

**User prompt:**
> "Walker login attempt failed for `{user}` against `{login_url}`:
>   {error_message}
>
> Last URL: {final_url}
> Rendered (truncated): {html_snippet}
>
> Options:
> (a) The credentials are wrong — update `D2C_TEST_USER` / `D2C_TEST_PASSWORD` in `.env.local`, then press Enter.
> (b) The login form uses non-standard selectors — paste the email field selector, password selector, and submit selector. They'll be saved to `<run-dir>/flow/walker-auth-config.json` so reruns won't re-prompt.
> (c) Abort the walker — I'll fix the login flow manually."

> Anti-rationalization: Do NOT proceed with the walker assuming "the screenshots will be good enough" — every gated host will silently render a login redirect, the pixel-diff will fail across the board, and the user wastes a full walker run debugging visual regressions that are actually auth failures.

---

## Phase 4b — Navigation Smoke Test

### F-FLOW-NAV-ASSERT-FAIL — Navigation smoke test failed post-gen

- **Phase:** 4b
- **Tier:** inform
- **Trigger:** The generated `flow-navigation.spec.ts` Playwright test fails on one or more edges — either the URL-level `page.goto` check or the click-level assertion for wired edges.
- **Action:** Report which edges failed and whether each failure was URL-level or click-level. No auto-fix in v1.
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** Flow-specific rule #9 (no invented chrome)

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
- **Lock impact:** none
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
- **Lock impact:** none
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
- **Lock impact:** none
- **Related rule:** Flow-specific rule #7 (parsed step list authoritative)

**Log line:**
> "Flow spans {N} Figma files: {file_keys}. Ensure every file is reachable from the current MCP session — missing access on any one file will abort Phase 2a."

---

### F-FLOW-MOBILE-URL — `mobile:` URL missing `node-id` or unreachable

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** A step line's `mobile:` directive points at a URL without a `node-id` query parameter, or the referenced frame can't be resolved during Phase 2a.
- **Action:** Halt. Offer the same frame pick-list flow as `F-FLOW-FILE-URL`, scoped to the mobile URL's file.
- **Max retries:** N/A
- **Lock impact:** none
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
- **Trigger:** The Phase 4b autofix loop (SKILL.md §Phase 4b "Outcome handling") exhausted every priority strategy (`relax-link-target`, `wire-next-best`, `force-click`, `wait-for-state`) and the nav test still fails.
- **Action:** Report the full planner trail (per-round action + candidate + outcome). Do NOT silently retry — the next rerun starts from round 0.
- **Max retries:** 0 after exhaustion; caller may re-invoke with a higher `--nav-max-rounds`.
- **Lock impact:** none
- **Related rule:** B-FLOW-NAV-AUTOFIX caps

**Log line:**
> "Nav-test autofix exhausted {rounds}/{max_rounds} rounds on edge `{from}` → `{to}` (click-level). Planner actions tried: {trail}. Fix manually or re-run with --nav-max-rounds {max_rounds+2}."

---

## Phase 5 — Bucket F Honor Checks (flow-emitted files)

These five entries cover violations surfaced by SKILL.md §5b's Bucket F-Flow enforcement — the per-bucket honor checks that run in Phase 5 against files the flow emits directly (orchestrator `page.tsx`, state context, shared layout, navigation smoke spec, flow-walker spec). The per-step body files emitted by `/d2c-build` dispatches get their own Bucket F coverage from `/d2c-build` Phase 5; this phase covers the orchestration-layer files that `/d2c-build` never sees.

### F-FLOW-HONOR-COMPONENT-UNAUTHORIZED — Flow-emitted file imports an unknown component

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** SKILL.md §5b's F1-Flow check found one or more violations. The orchestrator (or another flow-emitted file) imports a PascalCase component whose resolved path is not in `flow-graph.layouts[].component_id` (shared shell), `design-tokens.components[]` (project component reuse), or `app/<route>/steps/Step<N>.tsx` (delegated step body).
- **Action:** Halt. List every unauthorized import with file:line and the resolved path. Ask the user to either (a) replace the rogue import with an authorized one (existing layout, existing component, or a new step), (b) add the component to `design-tokens.components[]` if it's a real new piece of project UI, or (c) abort and let the user re-check the flow's layout decisions.
- **Max retries:** 0
- **Lock impact:** none (Bucket F doesn't touch the lock; it just reports that codegen drifted from the IR's authorized-component set).
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file).

**User prompt:**
> "Bucket F-Flow flagged {N} unauthorized component import(s) in flow-emitted files:
> - {file}:{line} — import `{source}` (resolved: {path}) is not in flow-graph.layouts[], design-tokens.components[], or app/<route>/steps/.
>
> Options:
> (a) Replace with an authorized component (which one?).
> (b) Add `{component_name}` to design-tokens.components[] if it's a real new project component.
> (c) Abort — the orchestrator may be importing the wrong shell or stale step paths."

> Anti-rationalization: Do NOT silently rewrite the import to point at a similarly-named authorized component. The mismatch is a signal that codegen and IR diverged; the user gets to decide which side is correct.

---

### F-FLOW-HONOR-TOKEN-UNAUTHORIZED — Hardcoded value matches a token

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** SKILL.md §5b's F2-Flow check found one or more violations. A flow-emitted file uses a hardcoded value (e.g. `bg-[#3366ff]`) that matches a token already in `design-tokens.json` (e.g. `colors.primary === "#3366ff"`).
- **Action:** Halt. List every hardcoded value with file:line and the matching token path. Ask the user to either (a) replace each hardcoded value with the semantic class (e.g. `bg-primary`), or (b) confirm the deviation is intentional (rare; usually only for SVG library boundaries — see `framework-react.md` §"Library boundary values").
- **Max retries:** 0
- **Lock impact:** none.
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file).

**User prompt:**
> "Bucket F-Flow flagged {N} hardcoded value(s) in flow-emitted files that match existing tokens:
> - {file}:{line} — `{value}` matches token `{path}`.
>
> Options:
> (a) Replace with the semantic class.
> (b) Mark this site as an intentional library boundary (will exempt with a `// Token: {path}` comment).
> (c) Abort."

---

### F-FLOW-HONOR-PROP-CONTRACT — Orchestrator or state context violates the step prop contract

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** SKILL.md §5b's F3-Flow check found one or more violations. The orchestrator is missing a step import, the step JSX is missing `onNext` / `onBack` props, the orchestrator never wires `onValidityChange` for a `validation_enabled` group, or the state context is missing one of `next` / `back` / `goTo` / `data` / `setField` / `markStepValid`. Contract is documented at `framework-react-next.md` §"Step component prop contract".
- **Action:** Halt. List every contract violation with the file path and the missing piece. Ask the user to either (a) regenerate the orchestrator and state context (the framework reference template is the source of truth), or (b) explicitly waive the contract for a specific step (rare; usually only for steps that have no Next button by design — see **P3-STEPPER-NEXT-MISSING** option (b)).
- **Max retries:** 0
- **Lock impact:** none.
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file).

**User prompt:**
> "Bucket F-Flow flagged {N} step prop contract violation(s):
> - {file} — {description}
>
> Options:
> (a) Regenerate the orchestrator + state context from the framework reference template.
> (b) Confirm this is an intentional waiver for a specific step (which step? why?).
> (c) Abort."

---

### F-FLOW-HONOR-EDGE-MISSING — Nav-smoke spec doesn't assert an edge

- **Phase:** 5
- **Tier:** inform
- **Trigger:** SKILL.md §5b's F4-Flow check found one or more violations. The navigation smoke spec doesn't include an assertion for a route from `flow-graph.edges[]`. The walker (Phase 4a) covers visual fidelity; the nav-smoke spec covers route resolution and edge wiring — a missing edge means a navigation regression could ship undetected.
- **Action:** Log a warning per missing edge. Add a TODO to the spec at the appropriate location (the `tests/flow/<flow_name>-navigation.spec.ts` body, after the existing assertions). Continue. The user sees the warning in the Phase 6 report.
- **Max retries:** N/A (auto-add TODO is silent; the warning is informational).
- **Lock impact:** none.
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file).

**Log line:**
> "Nav-smoke spec missing assertion for edge {from}→{to} ({route}). Added TODO at line {line}; review before shipping."

---

### F-FLOW-HONOR-WALKER-COVERAGE — Walker spec doesn't cover a host

- **Phase:** 5
- **Tier:** inform
- **Trigger:** SKILL.md §5b's F5-Flow check found one or more violations. The flow-walker spec doesn't include a screenshot+diff for a host (page or stepper-step loaded slot) at every required viewport (desktop + mobile when `mobile_variant` is set).
- **Action:** Log a warning per missing host. Add a TODO at the appropriate location in the walker spec (`<run-dir>/flow/flow-walker.spec.ts`). Continue. The user sees the warning in the Phase 6 report.
- **Max retries:** N/A.
- **Lock impact:** none.
- **Related rule:** Non-negotiable #4 (Bucket F enforced on every emitted file).

**Log line:**
> "Walker spec missing coverage for host {node_id} ({route}, viewport={viewport}). Added TODO; the walker will not pixel-diff this host until you add the test() block."

---

## Component mutation boundary (flow-rules 12 + 13 + 14)

### F-FLOW-SHARED-COMPONENT-MUTATION — Attempt to edit a shared component

- **Phase:** 3 (codegen) / 4a (auto-fix) / 5b (F1-Flow audit)
- **Tier:** stop-and-ask
- **Trigger:** A planned `Write` or `Edit` targets a file whose `path` matches a `design-tokens.components[]` entry with `import_count ≥ --shared-component-threshold` (default `2`). The three entry points: (1) Phase 3 §"Component mutation boundary" Step 1 classifies the target as immutable; (2) Phase 4a.5 fix dispatch's `fix_target.file_path` resolves to an immutable component; (3) Phase 5b F1-Flow audit finds a diff that mutated an immutable component between IR and emitted code.
- **Action:** Halt **before** writing. Show the component's path, its `import_count`, and the current threshold. Offer composition (the default recommendation), a threshold raise (only if every consumer is part of this flow), or abort. Do NOT silently proceed — the mutation is denied even if the user types "yes" without picking one of the options below.
- **Max retries:** 0 (every re-attempt at the same path re-fires this failure; the user must pick one of the options).
- **Lock impact:** none directly. Option (b) writes a new wrapper file (not a locked decision); option (c) may update `--shared-component-threshold` for the remainder of the run, which is NOT persisted in `flow-decisions-lock.json` — it's a per-invocation override.
- **Related rule:** Flow-rule #12 (Shared components are immutable). Anti-rationalization: a pixel-diff pressure in Phase 4a is NOT license to edit `Button.tsx` — the pressure is exactly when this rule earns its keep.

**User prompt:**
> "I was about to edit **{target_path}** to satisfy **{host_route}**, but this component has `import_count: {N}` in design-tokens.json — that's above the shared-component threshold ({threshold}), so editing it would ripple into {N} other consumers across the codebase.
>
> Flow-rule #12: shared components are immutable. Options:
>   (a) **Wrap** (recommended) — I'll create `app/{route}/_components/{Host}{Original}.tsx` that imports {Original} and applies the visual delta as a local wrapper. The original stays untouched.
>   (b) **Show consumers** — let me list the {N} files that import {Original} so you can decide whether a codebase-wide change is appropriate.
>   (c) **Raise threshold** — re-run with `--shared-component-threshold {N+1}` (only sane when every consumer is part of THIS flow).
>   (d) **Abort** — stop the flow; I'll redesign the shared component manually outside /d2c-build-flow."

**Context to show:** The target path, its `import_count`, the current threshold, the list of consumers (the file paths that import the component — resolve via a grep on the component's default export name), and the emitted Figma frame URL that motivated the edit.

---

### F-FLOW-WRAPPER-PROP-SOUP — Step-scoped prop added to a shared component

- **Phase:** 3 (codegen) / 5b (F1-Flow audit)
- **Tier:** stop-and-ask
- **Trigger:** A planned or emitted wrapper file adds a prop name to its imported original's call site that doesn't exist in the original's current prop signature. Detected via (1) Phase 3 AST scan of the wrapper's `<Original …>` JSX vs. the original's prop interface, or (2) Phase 5b F1-Flow running the same scan on every committed wrapper. Also fires when the proposed edit is a direct mutation to the shared component's prop interface itself (typing `interface ButtonProps { isCheckout?: boolean; }` into `Button.tsx`).
- **Action:** Halt. Name the offending prop(s). Suggest the two canonical alternatives: render the variation in the wrapper's own JSX, or apply the variation via a wrapping `<div>` + design-token style. Refuse to apply the prop-soup fix even under `--yes`.
- **Max retries:** 0
- **Lock impact:** none
- **Related rule:** Flow-rule #13 (Composition over modification). Anti-rationalization: a one-line `variant="checkout"` prop feels harmless, but it converts a single-purpose shared component into a conditionally-rendered branch factory — the exact drift rule #13 exists to prevent.

**User prompt:**
> "I was about to add prop **{prop_name}** to **{original_name}** at **{wrapper_path}** to wire the {host_route} variant. But {original_name} is a shared component (rule #12), so its prop surface is frozen and this addition would be prop soup (rule #13).
>
> Options:
>   (a) **Render it in the wrapper** — I'll lift the {prop_name}-triggered UI into {wrapper_path}'s own JSX tree instead of forwarding it into {original_name}. {original_name} stays single-purpose.
>   (b) **Style-only variation** — if the delta is purely visual (padding/border/color), I'll emit `<div style={{…}}>{original}</div>` using design-tokens values and drop the prop entirely.
>   (c) **Legitimize the prop** — the variation is truly general-purpose, not step-scoped. Abort the flow run, add the prop to {original_name} yourself (with tests), update design-tokens.components[], then re-run.
>   (d) **Abort** — stop the flow."

**Context to show:** The wrapper path, the offending prop name, the original's current prop interface (as a code block), and the planned JSX usage that introduced the prop.

---

### F-FLOW-BLAST-RADIUS-REGRESSION — Fixing current host regressed an earlier passing host

- **Phase:** 4a (auto-fix loop, inside §4a.5 step 5a reverification pass)
- **Tier:** stop-and-ask
- **Trigger:** Inside §4a.5 step 5a's reverification pass, one or more dependents (hosts that already passed pixel-diff in this walker run) dropped below `--threshold` after the current host's fix dispatch edited a shared file. See the `blast-regression` row in §4a.5 step 5a's outcome table.
- **Action:** Revert the current round from the round-N snapshot (§4a.5 step 1). Mark the current host's auto-fix budget exhausted for this Phase 4a pass (no more rounds even if the user picks "accept" below). Halt and ask the user to arbitrate — the system is not allowed to keep iterating between the two hosts, that's an oscillation trap the rule exists to prevent.
- **Max retries:** 0 (by construction — the whole point is to stop after one round of break-and-fix).
- **Lock impact:** none directly. Option (a) records the regression in `audit.json.warnings[]` (kind = `blast_radius_accepted`); option (c) persists no state since the walker ends.
- **Related rule:** Flow-rule #14 (Blast-radius reverification). Anti-rationalization: the natural instinct is "let me try one more round, maybe it'll converge" — that's precisely the oscillation this failure halts.

**User prompt:**
> "Auto-fix for **{current_host.route}** edited **{files}** and re-diffing earlier passing hosts now shows:
>
>   {dependent_1.route}  old={d1.old}% → new={d1.new}% ({below_or_above threshold})
>   {dependent_2.route}  old={d2.old}% → new={d2.new}% ({below_or_above threshold})
>
> Current host score: {prev_score}% → {score}%.
>
> Fixing **{current_host.route}** is now breaking **{regressed_dependents}**. I will NOT keep iterating between these — that's an oscillation trap.
>
> Options:
>   (a) **Accept** — keep the edit, leave {regressed_dependents} below threshold, record `blast_radius_accepted` in audit.json. The walker continues to the next host.
>   (b) **Revert** — roll this round back, leave {current_host.route} at {prev_score}%. The walker continues to the next host.
>   (c) **Abort** — stop the walker; fix the shared file manually before re-running (recommended when two designs genuinely disagree on the shared component's shape)."

**Context to show:** Every `dependent.host_key` with old score / new score / pass-fail against threshold; the list of files the fix edited; the current host's score trajectory; and the files' identities so the user knows which shared file is in contention.

---

## Catch-all

### FX-UNKNOWN-FAILURE — Unrecognized failure (catch-all)

- **Phase:** any
- **Tier:** stop-and-ask
- **Trigger:** A failure condition outside any of the above.
- **Action:** Halt. Present the raw error and ask the user how to proceed. Do NOT invent an ad-hoc recovery.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Anti-rationalization meta-rule

**User prompt:**
> "I hit an unexpected failure in phase {N}: `{error_summary}`. I don't have a named recovery for this. Options:
> 1. Show the full diagnostic and let me decide
> 2. Skip this phase (if skippable) and continue
> 3. Abort the flow build"
