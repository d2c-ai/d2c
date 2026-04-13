# d2c-build Failure Modes

This file is the single source of truth for every failure mode across all phases of `/d2c-build`. When a failure occurs, the model reads the matching entry and follows the User prompt template exactly — no improvisation.

---

## Meta-Rules

### Anti-Rationalization

If you are writing a justification for why a constraint does not apply to this specific case, you are rationalizing. Follow the constraint or STOP AND ASK. The failure modes below exist precisely because past runs invented plausible-sounding reasons to skip rules. Every entry here is a named trap — recognizing it is the defense.

### NEVER Invent a Fallback

If a failure occurs that does not match any entry in this file, trigger **PX-UNKNOWN-FAILURE** (the catch-all at the bottom). NEVER invent an ad-hoc recovery strategy. Ad-hoc recoveries are the #1 source of silent regressions.

### Universal Retry Escalation

Any auto-recover failure that recurs **more than its `max_retries`** with the same error (same failure ID + same node ID) MUST escalate to stop-and-ask. The counter resets when the error changes (different failure ID or different node ID). Escalation prompt:

> "I have attempted to auto-recover from `{failure_id}` {count} times for node `{node_id}` and keep hitting the same error: `{error_summary}`. This needs your input. Options: (1) re-run `/d2c-build` from scratch, (2) run `/d2c-init --force` to refresh tokens and components, (3) skip this node and continue. Which?"

### Batching

When multiple failures fire in the same phase, present them in a single STOP AND ASK message grouped by failure ID. Do NOT issue separate sequential prompts for each failure — that causes prompt fatigue. Format:

> "Phase {N} encountered {count} issues:"
> - `{failure_id}`: {summary} — {options}
> - `{failure_id}`: {summary} — {options}
> "How would you like to proceed?"

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
| P1-TOKENS-MISSING | 1 | fatal | design-tokens.json missing or invalid |
| P1-FIGMA-UNREACHABLE | 1 | stop-and-ask | Figma MCP unreachable after retry |
| P1-LIBRARY-GAP | 1 | stop-and-ask | Design needs capability not in preferred_libraries |
| P2-SCHEMA-ERR | 2 | auto-recover | IR artifact schema validation error |
| P2-UNKNOWN-TOKEN | 2 | stop-and-ask | Token reference not in design-tokens.json |
| P2-DANGLING-REF | 2 | auto-recover | Layout references node not in component-match |
| P2-INVALID-CHOSEN | 2 | auto-recover | Chosen component not in its own candidates list |
| P2-AMBIGUOUS-CHOSEN | 2 | stop-and-ask | Chosen is null — model could not decide |
| P2-DEFERRED | 2 | stop-and-ask | Layout region uses unsupported layout mode |
| P2-HASH-MISMATCH | 2 | auto-recover | Token file changed after IR was emitted |
| P2-EMPTY-TOKEN-CATEGORY | 2 | stop-and-ask | Core token category (colors/spacing/typography) is empty |
| P2-SOURCE-MISSING | 2 | stop-and-ask | Chosen component source file not on disk |
| P2-MULTI-SUBTREE | 2 | stop-and-ask | Figma frame contains multiple unrelated subtrees |
| P2-NO-MATCH | 2 | stop-and-ask | No component match above score threshold |
| P2-TOKEN-CONFLICT-AUTO | 2 | inform | Token conflict with clear winner by usage |
| P2-TOKEN-CONFLICT-ASK | 2 | stop-and-ask | Ambiguous token conflict |
| P3-IR-DEVIATION | 3 | stop-and-ask | Model about to deviate from frozen IR |
| P3-COMPONENT-GONE | 3 | stop-and-ask | Component source file deleted since Phase 2 |
| P3-PROP-MISMATCH | 3 | stop-and-ask | Chosen component lacks required prop |
| P3-FRAMEWORK-REF-MISSING | 3 | inform | Framework reference file not found |
| P3-FILE-PLACEMENT | 3 | stop-and-ask | No standard component directory exists |
| P4-DEV-SERVER | 4 | stop-and-ask | Dev server not running or unreachable |
| P4-PLAYWRIGHT-CRASH | 4 | auto-recover | Playwright error (non-connection) |
| P4-PIXELDIFF-MISSING | 4 | inform | pixeldiff.js not found |
| P4-PIXELDIFF-DEPS | 4 | auto-recover | pixelmatch or pngjs not installed |
| P4-FIGMA-SCREENSHOT-UNSAVEABLE | 4 | inform | Figma screenshot cannot be saved to disk for pixeldiff |
| P4-PLATEAU | 4 | conditional | Score plateau (< 1pp improvement) |
| P4-IR-LOCK-CONFLICT | 4 | stop-and-ask | Fix requires changing a locked IR decision |
| P4-FILE-OUT-OF-SCOPE | 4 | stop-and-ask | Fix requires editing an out-of-scope file |
| P4-REGRESSION | 4 | auto-recover | Score regression after applying fixes |
| P4-SHARED-BLAST-RADIUS | 4 | stop-and-ask | Shared component edit affects passing regions |
| P4-MAX-ROUNDS | 4 | inform | Maximum verification rounds reached |
| P4-SCREENSHOT-MISMATCH | 4 | stop-and-ask | Screenshot aspect ratio difference > 1.5x |
| P5-HARDCODED-MATCH | 5 | stop-and-ask | Hardcoded value with exact token match |
| P5-HARDCODED-NOVEL | 5 | stop-and-ask | Hardcoded value with no matching token |
| P5-LIBRARY-VIOLATION | 5 | stop-and-ask | Import of non-selected library |
| P5-IR-UNAUTHORIZED-COMPONENT | 5 | stop-and-ask | Component import not in IR |
| P5-IR-UNAUTHORIZED-TOKEN | 5 | stop-and-ask | Design value not in token-map |
| P5-AUDIT-REGRESSION | 5 | stop-and-ask | Previously fixed violation reappeared |
| P5-CONVENTION-CONFLICT | 5 | stop-and-ask | Two conventions with confidence > 0.6 contradict |
| P6-TOKENS-WRITE-CONFLICT | 6 | inform | design-tokens.json modified during build |
| PX-RETRY-EXHAUSTION | X | stop-and-ask | Auto-recover failure exceeded max_retries |
| PX-CASCADE | X | stop-and-ask | Phase 4 below threshold + Phase 5 preamble violations |
| PX-UNKNOWN-FAILURE | X | stop-and-ask | Unrecognized failure (catch-all) |

---

## Phase 1 — Input Gathering

### P1-TOKENS-MISSING — design-tokens.json missing or invalid

- **Phase:** 1
- **Tier:** fatal
- **Trigger:** `.claude/d2c/design-tokens.json` does not exist, is unreadable, or has `d2c_schema_version < 1`.
- **Action:** Abort the build immediately. Do not proceed to Phase 2.
- **Max retries:** 0 (fatal — no retry)
- **Lock impact:** none
- **Related rule:** Non-negotiable 1

**User prompt:**
> "Cannot start the build — `.claude/d2c/design-tokens.json` is {missing | unreadable | outdated (schema version {version})}. Run `/d2c-init` to set up your project's design tokens, then re-run `/d2c-build`."

---

### P1-FIGMA-UNREACHABLE — Figma MCP unreachable after retry

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** Figma MCP returns an error or empty response on two consecutive attempts.
- **Action:** Halt. Present diagnostic information and ask user to resolve.
- **Max retries:** 1 (one retry before escalating)
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "Figma MCP couldn't fetch the design after two attempts. Error: `{error_message}`. Please check: (1) the URL is a valid Figma Dev Mode link, (2) Figma MCP is connected and authenticated, (3) you have access to this file. Once resolved, press Enter to retry."

---

### P1-LIBRARY-GAP — Design needs capability not in preferred_libraries

- **Phase:** 1
- **Tier:** stop-and-ask
- **Trigger:** During intake or IR planning, the design requires a capability (e.g., date picker, carousel, charts) that has no entry in `preferred_libraries` or where `selected` is empty.
- **Action:** Halt. Present the missing capability and suggest 2-3 library options from `library-categories.md`.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 2

**User prompt:**
> "The design requires `{capability}` (e.g., {example_element}), but no library is selected for this in your `preferred_libraries`. Here are common options for `{capability}`:
> 1. `{library_1}` — {one-line description}
> 2. `{library_2}` — {one-line description}
> 3. `{library_3}` — {one-line description}
> 4. None — I'll build it from scratch
>
> Which would you like to use?"

**Context to show:** The Figma element that triggered the gap, the `preferred_libraries` category name, installed packages from `package.json` that might already cover this.

---

## Phase 2 — IR Validation

### P2-SCHEMA-ERR — IR artifact schema validation error

- **Phase:** 2
- **Tier:** auto-recover
- **Trigger:** `validate-ir.js` reports a schema error (missing required field, wrong type, pattern mismatch). Error line matches: `"required field"`, `"expected ... got"`, `"pattern"`, `"unexpected field"`.
- **Action:** Regenerate the failing IR artifact from scratch. Re-run `validate-ir.js`.
- **Max retries:** 2
- **Lock impact:** none (lock not yet written)
- **Related rule:** none

**Log line:**
> "IR schema error in `{artifact_file}`: `{error_line}`. Regenerating."

---

### P2-UNKNOWN-TOKEN — Token reference not in design-tokens.json

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `validate-ir.js` reports an unknown token reference in `token-map.json` or `layout.json`. Error line matches: `"unknown token reference"`. The validator may include a "did you mean?" suggestion.
- **Action:** Halt. Surface the invalid reference, the validator's suggestion (if any), and ask the user.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 1

**User prompt:**
> "I mapped a design value to a token that isn't in `design-tokens.json`: `{error_line}`.{did_you_mean_hint}
>
> Options:
> 1. Add the missing token via `/d2c-init --force` (rescans your codebase)
> 2. Let me remap to an existing token — I'll pick the closest match and show you
>
> Which do you prefer?"

**Context to show:** The invalid token path, the node/property it was assigned to, the `did you mean` suggestion from validate-ir.js (if present).

---

### P2-DANGLING-REF — Layout references node not in component-match

- **Phase:** 2
- **Tier:** auto-recover
- **Trigger:** `validate-ir.js` reports a layout child node ID not present in `component-match.json`. Error line matches: `"not present in component-match"`.
- **Action:** Regenerate both `layout.json` and `component-match.json` to ensure consistency. Re-run `validate-ir.js`.
- **Max retries:** 2
- **Lock impact:** none (lock not yet written)
- **Related rule:** none

**Log line:**
> "Layout cross-reference error: node `{node_id}` in `layout.json` not found in `component-match.json`. Regenerating IR."

---

### P2-INVALID-CHOSEN — Chosen component not in its own candidates list

- **Phase:** 2
- **Tier:** auto-recover
- **Trigger:** `validate-ir.js` reports a `chosen` value that does not appear in the node's `candidates[]` array. Error line matches: `"not in candidates"`.
- **Action:** Regenerate `component-match.json`. Re-run `validate-ir.js`.
- **Max retries:** 2
- **Lock impact:** none (lock not yet written)
- **Related rule:** none

**Log line:**
> "Invalid component choice for node `{node_id}`: chose `{chosen}` which is not in candidates. Regenerating."

---

### P2-AMBIGUOUS-CHOSEN — Chosen is null, model could not decide

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `validate-ir.js` reports `chosen: null` for a node (the model set chosen to null to signal ambiguity). Error line matches: `"chosen is null"`.
- **Action:** Halt. Present the candidates with their reasoning and ask the user to pick.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 4

**User prompt:**
> "I couldn't decide between component candidates for Figma node `{node_id}` (`{figma_name}`). Here are the options:
> {for each candidate:}
> {index}. **{componentId}** (`{source}`) — {reasoning}
> {end}
> {candidates_count + 1}. Create a **new component** for this
>
> Which one should I use?"

**Context to show:** The Figma node name, the candidates array with reasoning for each.

---

### P2-DEFERRED — Layout region uses unsupported layout mode

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `validate-ir.js` reports non-empty `deferred[]` in `layout.json` (grid, absolute positioning, or nesting too deep for v1 IR). Error line matches: `"deferred"`.
- **Action:** Halt. Show the deferred regions and their reasons.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** none

**User prompt:**
> "One or more layout regions aren't supported by the v1 layout IR:
> {for each deferred region:}
> - `{region_id}`: {reason} (e.g., CSS Grid, absolute positioning, deeply nested)
> {end}
>
> Options:
> 1. **Skip** these regions — I'll generate the rest and leave placeholders
> 2. **Convert** them to flexbox in Figma and re-run `/d2c-build`
>
> Which do you prefer?"

---

### P2-HASH-MISMATCH — Token file changed after IR was emitted

- **Phase:** 2
- **Tier:** auto-recover
- **Trigger:** `validate-ir.js` reports that `run-manifest.json.tokens_file_hash` does not match the current SHA-256 of `design-tokens.json`. Error line matches: `"tokens_file_hash"` + `"mismatch"`.
- **Action:** Regenerate all IR artifacts against the updated tokens file. Re-run `validate-ir.js`.
- **Max retries:** 1
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 1

**Log line:**
> "`design-tokens.json` changed after the IR was emitted (hash mismatch). Regenerating IR against the current tokens file."

---

### P2-EMPTY-TOKEN-CATEGORY — Core token category is empty

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `validate-ir.js` reports that a core token category (`colors`, `spacing`, or `typography`) has zero entries. Error line matches: `"STOP AND ASK: token category"` + `"is empty"`.
- **Action:** Halt. An empty core category means `d2c-init` did not extract tokens for it. Without tokens, the model will be forced to invent workarounds (e.g., using border-radius tokens as spacing gaps, hardcoding hex values). These workarounds produce semantically incorrect code.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 3

**User prompt:**
> "Token category `{category}` is empty in `design-tokens.json`. Without {category} tokens, I cannot map Figma {category} values to your design system — I would have to hardcode them or misuse tokens from other categories.
>
> Options:
> 1. **Run `/d2c-init --force`** to re-scan and populate {category} tokens, then re-run `/d2c-build`
> 2. **Add tokens manually** — I'll list the {category} values from the Figma design so you can add them to `design-tokens.json`
> 3. **Continue without {category} tokens** — I'll use Tailwind defaults (spacing) or hardcode values (colors/typography) and flag them in the audit
>
> Which?"

**Anti-rationalization trap:** Do NOT reason that "Tailwind defaults are fine" or "the project doesn't use custom spacing." The purpose of tokens is to give the build a contract to validate against. Without tokens, validation is impossible and hardcoded values will silently drift from the design system.

---

### P2-SOURCE-MISSING — Chosen component source file not on disk

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `validate-ir.js` reports that a chosen component's `source` path does not exist on disk. Error line matches: `"does not exist on disk"`.
- **Action:** Halt. The component index in `design-tokens.json` is stale.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 4

**User prompt:**
> "The component I chose (`{componentId}`) points at a file that doesn't exist on disk: `{source_path}`. The component index may be stale.
>
> Options:
> 1. Run `/d2c-init` to refresh the component index, then re-run `/d2c-build`
> 2. Pick a different candidate from the list: {other_candidates}
> 3. Create a new component instead
>
> Which?"

---

### P2-MULTI-SUBTREE — Figma frame contains multiple unrelated subtrees

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** During IR emission (before `validate-ir.js`), the Figma frame has 3+ direct children with no shared visual patterns (different background colors, different layout directions, different content types with no visual grouping).
- **Action:** Halt. Ask which subtree(s) to build.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** none

**User prompt:**
> "This Figma frame appears to contain {count} unrelated sections:
> {for each subtree:}
> {index}. **{subtree_name}** — {brief_description} ({child_count} layers)
> {end}
>
> Options:
> 1. Build **all** as a single page/view
> 2. Build only section **{number}** — specify which
> 3. Build each as a **separate component** (multiple `/d2c-build` runs)
>
> Which?"

**Context to show:** Names and brief visual descriptions of each subtree, layer counts.

---

### P2-NO-MATCH — No component match above score threshold

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** The highest-scoring component candidate for a node scores below 50/100 on the composite scoring rubric (props match 0–50 + usage frequency 0–25 + semantic alignment 0–25). Does NOT apply to candidates with `user_confirmed: true`.
- **Action:** Halt. The node needs a new component. Set `chosen: "__NEW__"` in `component-match.json`.
- **Max retries:** N/A
- **Lock impact:** none (lock not yet written)
- **Related rule:** Non-negotiable 4

**User prompt:**
> "No existing component is a good match for Figma node `{node_id}` (`{figma_name}`). The best candidate was `{top_candidate}` with a score of {top_score}/100 (below the 50-point threshold):
> - Props match: {props_score}/50
> - Usage frequency: {usage_score}/25
> - Semantic alignment: {alignment_score}/25
>
> I need to create a new component. What should I name it? (e.g., `{suggested_name}`)
>
> Options:
> 1. Create new component with a name you provide
> 2. Use `{top_candidate}` anyway (I'll mark it as user-confirmed)
> 3. Skip this node for now"

---

### P2-TOKEN-CONFLICT-AUTO — Token conflict with clear winner by usage

- **Phase:** 2
- **Tier:** inform
- **Trigger:** `token-conflicts.json` exists and contains a resolved conflict (status `auto-resolved` or `user-resolved`) whose value matches multiple tokens being mapped for a Figma node.
- **Action:** Use the `canonical` token path from the conflict entry. Log an informational note. Build continues.
- **Max retries:** N/A
- **Lock impact:** canonical choice is recorded in the token-map and carried into decisions.lock.json
- **Related rule:** Non-negotiable 3
- **Source:** Item #6 (Token Conflict Detection) — `.claude/d2c/token-conflicts.json`

**Log line:**
> "Token conflict resolved: used canonical `{canonical}` over `{duplicates}` for value `{resolved_value}` (resolved by {chosen_by})."

---

### P2-TOKEN-CONFLICT-ASK — Ambiguous token conflict

- **Phase:** 2
- **Tier:** stop-and-ask
- **Trigger:** `token-conflicts.json` exists and contains one or more entries with `status: "unresolved"`. Checked in the Phase 2.3 preamble before emitting `token-map.json`.
- **Action:** Halt. Present ALL unresolved conflicts with usage counts. Wait for user to resolve each one. Update `token-conflicts.json` with user choices before proceeding.
- **Max retries:** N/A
- **Lock impact:** user choices flow into token-map.json and then into decisions.lock.json
- **Related rule:** Non-negotiable 3
- **Source:** Item #6 (Token Conflict Detection) — `.claude/d2c/token-conflicts.json`

**User prompt:**
> "Unresolved token conflicts from `/d2c-init` must be resolved before token mapping:
>
> {for each unresolved conflict:}
> {index}. **{category}** value `{resolved_value}` is shared by:
> {for each token, sorted by usage count desc:}
>    - `{dotted_path}` ({usage_count} references in source files)
> {end}
>    Recommendation: {highest-usage name if ratio >= 2x | "needs your input (usage too close)"}
> {end}
>
> Which token should be canonical for each group? Options:
> 1. Accept all recommendations (where available)
> 2. Choose differently for specific groups
> 3. Run `/d2c-init` to re-detect and resolve there"

---

## Phase 3 — Code Generation

### P3-IR-DEVIATION — Model about to deviate from frozen IR

- **Phase:** 3
- **Tier:** stop-and-ask
- **Trigger:** During code generation, the model identifies that the chosen component, token reference, or layout direction from the frozen IR is a poor fit and is about to use a different value.
- **Action:** Halt immediately. Present the IR value vs. the proposed alternative. NEVER silently substitute.
- **Max retries:** N/A
- **Lock impact:** unlock-node (if user approves the deviation)
- **Related rule:** Non-negotiable 6

**User prompt:**
> "I'm about to deviate from the frozen IR for node `{node_id}` (`{figma_name}`):
> - **IR says:** {ir_field} = `{ir_value}`
> - **I want to use:** `{proposed_value}`
> - **Reason:** {reason_for_deviation}
>
> Options:
> 1. **Approve** the change (I'll unlock this node in `decisions.lock.json` and update the IR)
> 2. **Keep the IR** value and proceed (I'll make the original choice work)
> 3. **Re-run Phase 2** to regenerate the IR with fresh analysis
>
> Which?"

**Context to show:** The node name, the IR field being changed (component, token, or layout), the current and proposed values, and the reason the model thinks the IR choice is wrong.

---

### P3-COMPONENT-GONE — Component source file deleted since Phase 2

- **Phase:** 3
- **Tier:** stop-and-ask
- **Trigger:** Before generating code for a node, the model verifies the chosen component's source file exists on disk. The file is gone (deleted, moved, or renamed between Phase 2 and Phase 3).
- **Action:** Halt. The component index is stale for this entry.
- **Max retries:** N/A
- **Lock impact:** unlock-node (if user picks a different candidate)
- **Related rule:** Non-negotiable 4

**User prompt:**
> "The component `{componentId}` (source: `{source_path}`) no longer exists on disk. It may have been deleted or moved since Phase 2 ran.
>
> Options:
> 1. Run `/d2c-init` to refresh the component index, then re-run `/d2c-build`
> 2. Pick a different candidate: {other_candidates_from_ir}
> 3. Create a new component instead
>
> Which?"

---

### P3-PROP-MISMATCH — Chosen component lacks required prop

- **Phase:** 3
- **Tier:** stop-and-ask
- **Trigger:** During code generation, the model discovers that the chosen component's actual prop interface (read from the source file) doesn't support a prop needed to render the Figma design (e.g., the design has a subtitle but the Card component only has `title` and `body` props).
- **Action:** Halt. Show the gap between design needs and component props.
- **Max retries:** N/A
- **Lock impact:** unlock-node (if user picks different candidate or creates wrapper)
- **Related rule:** Non-negotiable 4

**User prompt:**
> "The chosen component `{componentId}` doesn't have a prop for `{missing_prop_description}` needed by the Figma design.
> - **Component props:** {existing_props_list}
> - **Design needs:** {design_requirement}
>
> Options:
> 1. **Create a wrapper** component that extends `{componentId}` with the missing prop
> 2. **Pick a different component** from the IR candidates: {other_candidates}
> 3. **Skip** this element — don't render the `{missing_prop_description}` part
> 4. **Unlock and re-decide** — I'll re-analyze this node in Phase 2
>
> Which?"

---

### P3-FRAMEWORK-REF-MISSING — Framework reference file not found

- **Phase:** 3
- **Tier:** inform
- **Trigger:** The framework reference file (`references/framework-{framework}.md`) cannot be found at any of the standard locations.
- **Action:** Continue with framework-agnostic defaults. Log warning.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "Warning: Framework reference file for `{framework}` not found. Using framework-agnostic defaults. Generated code may need manual adjustment for framework-specific patterns (reactivity, template syntax, lifecycle hooks)."

---

### P3-FILE-PLACEMENT — No standard component directory exists

- **Phase:** 3
- **Tier:** stop-and-ask
- **Trigger:** The model needs to create a new component file but none of the standard directories exist (`src/components/`, `components/`, `app/components/`, `src/lib/components/`).
- **Action:** Halt. Ask the user where to put new component files.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "I need to create a new component file but couldn't find a standard component directory. Where should I put new components? Please provide a directory path (e.g., `src/components/`)."

---

## Phase 4 — Visual Verification

### P4-DEV-SERVER — Dev server not running or unreachable

- **Phase:** 4
- **Tier:** stop-and-ask
- **Trigger:** Playwright cannot reach the dev server URL (connection refused, timeout, or non-200 response).
- **Action:** Halt. Ask the user to start their dev server.
- **Max retries:** 1 (one automatic retry after user confirms)
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "I can't reach the dev server to take a screenshot for visual verification. Please start your dev server and provide the local URL (e.g., `http://localhost:3000`). Press Enter when ready."

---

### P4-PLAYWRIGHT-CRASH — Playwright error (non-connection)

- **Phase:** 4
- **Tier:** auto-recover
- **Trigger:** Playwright throws a non-connection error (timeout, crash, rendering error).
- **Action:** Retry with increased timeout (2x default). If retry fails, escalate.
- **Max retries:** 1
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "Playwright error: `{error_message}`. Retrying with increased timeout."

**Escalation prompt (after max_retries):**
> "Playwright keeps failing: `{error_message}`. Options: (1) skip visual verification and proceed to Phase 5, (2) provide a manual screenshot for comparison, (3) abort the build. Which?"

---

### P4-PIXELDIFF-MISSING — pixeldiff.js not found

- **Phase:** 4
- **Tier:** inform
- **Trigger:** `pixeldiff.js` cannot be found at any of the 6 standard locations.
- **Action:** Fall back to visual-only comparison (no numeric score). Log warning.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "Warning: `pixeldiff.js` not found. Falling back to visual-only comparison without pixel-diff scoring. Run `/d2c-init` to install dependencies."

---

### P4-PIXELDIFF-DEPS — pixelmatch or pngjs not installed

- **Phase:** 4
- **Tier:** auto-recover
- **Trigger:** `pixeldiff.js` exits with an error indicating `pixelmatch` or `pngjs` cannot be found.
- **Action:** Attempt to install the missing dependency. Retry pixeldiff.
- **Max retries:** 2 (try global install, then project-local install)
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "pixeldiff dependency missing: `{dependency}`. Installing and retrying."

---

### P4-FIGMA-SCREENSHOT-UNSAVEABLE — Figma screenshot cannot be saved to disk

- **Phase:** 4
- **Tier:** inform
- **Trigger:** All methods for saving the Figma screenshot to disk have failed (download URL, base64 decode, save_to_disk parameter, Playwright Figma capture). The pixeldiff script requires both screenshots as PNG files on disk.
- **Action:** Fall back to visual-only comparison (no pixeldiff numeric score). Log warning. **CRITICAL: The verification loop MUST still complete all `MAX_ROUNDS` rounds using visual-only comparison.** Do NOT skip rounds or exit early because pixeldiff is unavailable. Visual-only comparison is less precise but still catches layout, color, and spacing issues.
- **Max retries:** N/A (all fallback methods already attempted per Step A.1)
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "Warning: Figma screenshot could not be saved to disk after trying all methods (download URL, base64, save_to_disk, Playwright). Falling back to visual-only comparison. Pixel-diff scoring will be unavailable — all {MAX_ROUNDS} rounds will use visual judgment only. Consider using a Figma personal access token with the REST API for future builds."

**Anti-rationalization trap:** Do NOT use this as an excuse to run only 1 round. The visual comparison catches different issues than pixeldiff — layout misalignment, wrong colors, missing components. Each round gives the model a chance to fix issues and re-verify. All rounds are valuable even without a numeric score.

---

### P4-PLATEAU — Score plateau

- **Phase:** 4
- **Tier:** conditional (inform if score >= 80%, stop-and-ask if score < 80%)
- **Trigger:** Pixel-diff score improved by less than 1 percentage point from the previous round.
- **Action:** If score >= 80%, inform and proceed to Phase 5 (renderer artifacts). If score < 80%, halt and STOP AND ASK (real layout/styling issues likely).
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**User prompt:**

*When score >= 80% (inform tier):*
> "Score plateaued at {score}% (improved <1% from {previous_score}%). Remaining differences are likely cross-renderer artifacts (anti-aliasing, font rendering, sub-pixel positioning). Proceeding to Phase 5."

*When score < 80% (stop-and-ask tier):*
> "Score plateaued at {score}% (improved <1% from {previous_score}%). At this level, remaining differences are likely real layout or styling issues, not just renderer artifacts.
>
> Options:
> 1. **Continue fixing** — I'll attempt more targeted fixes (may need to change IR decisions)
> 2. **Re-run from Phase 2** — fresh IR analysis may find better component/token choices
> 3. **Accept** the current state and proceed to Phase 5
>
> Which?"

---

### P4-IR-LOCK-CONFLICT — Fix requires changing a locked IR decision

- **Phase:** 4
- **Tier:** stop-and-ask
- **Trigger:** During fix application, the model determines that a visual issue can only be fixed by changing a component choice, token reference, or layout direction that is locked in `decisions.lock.json`.
- **Action:** Halt. Ask the user to unlock the specific node.
- **Max retries:** N/A
- **Lock impact:** unlock-node (if approved — sets `status: "failed"`, adds `failure_reason`, `failed_at`, `failed_by: "phase4_pixeldiff"`)
- **Related rule:** Non-negotiable 6

**User prompt:**
> "Node `{node_id}` (`{figma_name}`, component: `{componentId}`) needs a different {component | token | layout direction} to fix the visual issue, but this decision is locked.
>
> Options:
> 1. **Unlock** this node — I'll set it to `failed`, regenerate its IR, and continue
> 2. **Keep locked** — accept this visual difference
>
> Which?"

---

### P4-FILE-OUT-OF-SCOPE — Fix requires editing an out-of-scope file

- **Phase:** 4
- **Tier:** stop-and-ask
- **Trigger:** During fix application, the model determines that a visual issue can only be fixed by editing a file that is NOT in the current round's file scope (from Step 4.3c). The file's corresponding region has no red pixels in the diff image, meaning it is currently passing.
- **Action:** Halt. Editing an out-of-scope file risks regressing a passing region.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Step 4.3c file scope determination

**User prompt:**
> "The fix for `{issue_description}` requires editing `{file}`, but this file's region (`{region_label}`) has no red pixels in the current diff — it's currently passing.
>
> Editing it risks regressing a passing area. Options:
> 1. **Allow this edit** — expand the file scope to include `{file}` for this round
> 2. **Skip this fix** — move to the next issue in the fix list
> 3. **Try a different fix strategy** — find an alternative that stays within the current scope
>
> Which?"

---

### P4-REGRESSION — Score regression after applying fixes

- **Phase:** 4
- **Tier:** auto-recover (revert from snapshot, then stop-and-ask if recovery fails)
- **Trigger:** After applying fixes and re-scoring, the pixel-diff score dropped by more than 1 percentage point compared to the previous round's score: `current_score < previous_score - 1.0`.
- **Action:** Auto-revert all files edited in the regressing round from the snapshot at `$D2C_TMP/snapshots/round-N/`. Try one alternate fix strategy. If the alternate strategy also regresses, STOP AND ASK.
- **Max retries:** 1 (one revert + one alternate attempt before escalation)
- **Lock impact:** none
- **Related rule:** Non-negotiable 6 (retry must fix, not redesign)

**Auto-recover log:**
> "Regression detected: score dropped from {prev_score}% to {current_score}% after round {round} fixes. Reverted to round {round-1} state. Trying a different fix strategy."

**User prompt (after failed recovery):**
> "Score regressed from `{prev_score}%` to `{current_score}%` after fixes in round {round}. Reverted to round {round-1} state (`{prev_score}%`).
>
> The attempted fixes caused more visual damage than they repaired. Options:
> 1. **Try a different fix approach** — I'll attempt a fundamentally different strategy
> 2. **Accept current score** — proceed to Phase 5 with `{prev_score}%` match
> 3. **Re-run from Phase 2** — regenerate IR with fresh component/token decisions
>
> Which?"

---

### P4-SHARED-BLAST-RADIUS — Shared component edit affects passing regions

- **Phase:** 4
- **Tier:** stop-and-ask
- **Trigger:** The model is about to edit a component file that is `chosen` by multiple nodes in `component-match.json`, and at least one of those other nodes' regions had minimal red pixels in the previous round's diff (i.e., was previously passing).
- **Action:** Halt. The edit could silently regress passing regions. Ask the user to choose between proceeding, skipping, or creating a scoped variant.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Step 4.3c shared component blast radius check

**User prompt:**
> "Editing `{file}` (`{component_name}`) to fix the `{failing_region}` would also affect these currently-passing regions: {passing_regions_list}.
>
> This component is used by {node_count} nodes. Changing it risks regressing the passing areas. Options:
> 1. **Proceed** — accept the risk of regression in `{passing_regions}`
> 2. **Skip this fix** — leave the failing region as-is and move to the next issue
> 3. **Create a scoped variant** — make a copy of `{component_name}` for use only in `{failing_region}`, leaving the original untouched
>
> Which?"

---

### P4-MAX-ROUNDS — Maximum verification rounds reached

- **Phase:** 4
- **Tier:** inform
- **Trigger:** Round counter reaches `MAX_ROUNDS` (default 4) regardless of current score.
- **Action:** Stop the verification loop. Report remaining issues and proceed to Phase 5.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**Log line:**
> "Reached maximum verification rounds ({max_rounds}). Current score: {score}%. Remaining issues: {issue_list}. Proceeding to Phase 5."

---

### P4-SCREENSHOT-MISMATCH — Screenshot aspect ratio difference > 1.5x

- **Phase:** 4
- **Tier:** stop-and-ask
- **Trigger:** After capturing both Figma and Playwright screenshots, the aspect ratio difference exceeds 1.5x on either axis: `max(w1,w2) / min(w1,w2) > 1.5` OR `max(h1,h2) / min(h1,h2) > 1.5`.
- **Action:** Halt. The screenshots are incomparable — pixel-diff would be meaningless.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "The Figma screenshot ({figma_w}x{figma_h}) and Playwright screenshot ({playwright_w}x{playwright_h}) have very different dimensions (aspect ratio difference > 1.5x). Pixel-diff comparison would be unreliable.
>
> Options:
> 1. **Adjust viewport** — I'll resize Playwright to match Figma's width ({figma_w}px) and retake
> 2. **Continue with crop** — compare the overlapping area only (less accurate)
> 3. **Skip pixel-diff** — proceed to Phase 5 without a numeric score
>
> Which?"

---

## Phase 5 — Code Quality Audit

### P5-HARDCODED-MATCH — Hardcoded value with exact token match

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Audit bucket A finds a hardcoded design value (color, spacing, typography, shadow, radius) that exactly matches an existing token in `design-tokens.json`.
- **Action:** Halt. These are accidental inline values — offer auto-replacement.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 3

**User prompt:**
> "Found {count} hardcoded values that exactly match existing tokens. These look like accidental inline values. Apply the token replacement? [y/N/list-per-file]"

**Context to show:** For each violation: file path, line number, the hardcoded value, and the matching token name.

---

### P5-HARDCODED-NOVEL — Hardcoded value with no matching token

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Audit bucket A finds a hardcoded design value with no existing token match in `design-tokens.json`.
- **Action:** Halt. Present the values and options.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 3

**User prompt:**
> "Found {count} hardcoded values with no matching token:
> {for each violation:}
> - `{file}:{line}` — `{value}`
> {end}
>
> Options:
> 1. **Add** these as new tokens to `design-tokens.json`
> 2. **Replace** with the closest existing token (I'll show each mapping for your approval)
> 3. **Leave** as-is
>
> Which?"

---

### P5-LIBRARY-VIOLATION — Import of non-selected library

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Audit bucket C finds an import of a library that is installed but not selected in `preferred_libraries.<category>.selected`.
- **Action:** Halt. Present the violations.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 2

**User prompt:**
> "Found {count} imports of non-selected libraries:
> {for each violation:}
> - `{file}:{line}` — `import ... from '{library}'` (category: `{category}`, selected: `{selected_library}`)
> {end}
>
> These violate Non-negotiable rule 2 (preferred_libraries selection). Options:
> 1. **Rewrite** to use the selected library (`{selected_library}`)
> 2. **Update** `preferred_libraries` to add `{library}` as selected
> 3. **Leave** as-is
>
> Which?"

---

### P5-IR-UNAUTHORIZED-COMPONENT — Component import not in IR

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Audit bucket F1 finds a component import in generated code that was NOT in `component-match.json.chosen` for any node.
- **Action:** Halt. Phase 3 ignored the frozen IR — this is a build integrity failure.
- **Max retries:** N/A
- **Lock impact:** none (IR is already frozen)
- **Related rule:** Non-negotiable 6

**User prompt:**
> "Phase 3 imported a component that was NOT in `component-match.json.chosen`:
> {for each violation:}
> - `{file}:{line}` — `import {component} from '{path}'`
> {end}
>
> The IR was frozen at Phase 2 — this indicates codegen ignored the plan. Options:
> 1. **Regenerate** the IR and re-run `/d2c-build`
> 2. **Update** `component-match.json` manually to add this component, re-run validate-ir, then re-run `/d2c-build`
>
> Which?"

---

### P5-IR-UNAUTHORIZED-TOKEN — Design value not in token-map

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Audit bucket F2 finds a design value in generated code that is not mapped in `token-map.json` for the corresponding node.
- **Action:** Halt. Phase 3 used a token not planned in the IR.
- **Max retries:** N/A
- **Lock impact:** none (IR is already frozen)
- **Related rule:** Non-negotiable 6

**User prompt:**
> "Phase 3 used a design value not in `token-map.json`:
> {for each violation:}
> - `{file}:{line}` — `{value}` (expected token from token-map: `{expected_token}`)
> {end}
>
> Options:
> 1. **Regenerate** the IR and re-run `/d2c-build`
> 2. **Add** the missing token entry manually, re-run validate-ir, then re-run `/d2c-build`
>
> Which?"

---

### P5-AUDIT-REGRESSION — Previously fixed violation reappeared

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** On a resumed build (from checkpoint), a violation that was fixed in a prior Phase 5 run has reappeared — typically because a Phase 4 retry overwrote the fix.
- **Action:** Halt. The retry loop undid a previous fix.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "A previously fixed audit violation has reappeared in `{file}:{line}`:
> - **Violation:** {violation_description}
> - **Previously fixed in:** round {round_number}
> - **Likely cause:** Phase 4 retry overwrote the fix
>
> Options:
> 1. **Re-apply** the fix
> 2. **Investigate** — show me the diff between the fixed and current version
>
> Which?"

---

### P5-CONVENTION-CONFLICT — Two conventions with confidence > 0.6 contradict

- **Phase:** 5
- **Tier:** stop-and-ask
- **Trigger:** Two convention rules from `design-tokens.json.conventions` both have `confidence > 0.6` and `value != "mixed"` but produce contradictory guidance for the same code construct.
- **Action:** Halt. Ask which convention takes priority.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 5

**User prompt:**
> "Two project conventions contradict each other for this code:
> - `{convention_a}`: `{value_a}` (confidence: {confidence_a})
> - `{convention_b}`: `{value_b}` (confidence: {confidence_b})
>
> Which takes priority for this case?"

---

## Phase 6 — Finalize

### P6-TOKENS-WRITE-CONFLICT — design-tokens.json modified during build

- **Phase:** 6
- **Tier:** inform
- **Trigger:** Before auto-updating `design-tokens.json` with new components/hooks (Phase 6 step 3), the file's current SHA-256 hash does not match `run-manifest.json.tokens_file_hash`.
- **Action:** Skip the auto-update. Report what would have been added so the user can apply manually.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** Non-negotiable 1

**Log line:**
> "Warning: `design-tokens.json` was modified during this build (hash mismatch). Skipping auto-update to avoid overwriting your changes. The following would have been added:
> {list of new components/hooks}"

---

## Cross-Phase

### PX-RETRY-EXHAUSTION — Auto-recover failure exceeded max_retries

- **Phase:** any
- **Tier:** stop-and-ask
- **Trigger:** Any auto-recover failure has been retried `max_retries` times with the same error (same failure ID + same node ID). Counter resets when the error changes.
- **Action:** Halt. The auto-recovery strategy isn't working.
- **Max retries:** N/A (this IS the escalation)
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "I've attempted to auto-recover from `{failure_id}` {count} times for {context} and keep hitting the same error: `{error_summary}`.
>
> Options:
> 1. Re-run `/d2c-build` from scratch
> 2. Run `/d2c-init --force` to refresh tokens and components, then re-run
> 3. Skip this {node | artifact | step} and continue
>
> Which?"

---

### PX-CASCADE — Phase 4 below threshold + Phase 5 preamble violations

- **Phase:** between 5 and 6
- **Tier:** stop-and-ask
- **Trigger:** Phase 4 exited with a final score below `THRESHOLD` (default 95%) AND Phase 5 found one or more preamble violations (bucket A exact-match, bucket C, or bucket F).
- **Action:** Halt. This combination suggests the IR made marginal choices that cascaded into both visual and code quality issues.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** none

**User prompt:**
> "The build has both visual accuracy issues (Phase 4: {score}%, below {threshold}% target) and code quality violations (Phase 5: {violation_count} preamble issues). This combination suggests the IR planning phase made marginal choices that cascaded.
>
> Options:
> 1. **Re-run from Phase 2** — fresh IR analysis with the same Figma input (recommended)
> 2. **Accept** the current output with known issues
> 3. **Re-run with `/d2c-init --force`** first to refresh tokens and components
>
> Which?"

---

### PX-UNKNOWN-FAILURE — Unrecognized failure (catch-all)

- **Phase:** any
- **Tier:** stop-and-ask
- **Trigger:** A failure occurs that does not match any entry in this file. This is the catch-all safety net — it exists to enforce the "NEVER invent a fallback" meta-rule.
- **Action:** Halt. Report the raw error. Do NOT improvise a recovery.
- **Max retries:** N/A
- **Lock impact:** none
- **Related rule:** all (this is the anti-rationalization backstop)

**User prompt:**
> "I encountered an error that doesn't match any known failure mode:
> - **Phase:** {phase}
> - **Error:** `{raw_error_message}`
> - **Context:** {what_the_model_was_doing}
>
> I don't have a pre-defined recovery for this. Options:
> 1. Tell me what to do
> 2. Re-run `/d2c-build` from scratch
> 3. Abort
>
> Which?"

**Note:** If this failure mode fires frequently for the same error pattern, a new entry should be added to this file to handle it explicitly.
