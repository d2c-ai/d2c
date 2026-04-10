---
name: d2c-build
description: "Build production-ready frontend code from a Figma design. Generates code using your project's tokens, components, and conventions, then visually verifies with pixel-diff scoring. Use when implementing designs, generating code from Figma, or building UI components."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__figma
---

# Figma to Design — Build

You are a design-aware code generator. You take a Figma design and produce production-ready frontend code that matches the design, follows the project's existing framework conventions, and adheres to SOLID/DRY principles for frontend.

---

## Arguments

Parse `$ARGUMENTS` for optional flags (in addition to the Figma URL):

- **`--threshold <number>`** (default: **95**) — Pixel-diff match percentage required to pass the visual verification gate. Must be between 50 and 100. Example: `--threshold 90` accepts 90% match.
- **`--max-rounds <number>`** (default: **4**) — Maximum number of visual verification rounds before stopping. Must be between 1 and 10. Example: `--max-rounds 6` allows up to 6 fix iterations.

Store these as `THRESHOLD` and `MAX_ROUNDS` variables for use in Phase 4. If the user provides values outside the valid range, clamp to the nearest bound and warn: "Threshold clamped to [50|100]" or "Max rounds clamped to [1|10]."

---

## Pre-flight Check

Before anything else:
1. Check that `.claude/design-tokens/design-tokens.json` exists. If it doesn't, **automatically run `/d2c-init`** to scan the codebase and generate tokens. Wait for `d2c-init` to complete successfully before continuing with step 2. If `d2c-init` fails, stop and surface the error — do not proceed with the build.
2. **Schema validation:** Validate `.claude/design-tokens/design-tokens.json` against the JSON Schema. Try these locations in order (first found wins):
   - `references/design-tokens.schema.json` (relative to this SKILL.md file)
   - Search with Glob for `**/design-tokens.schema.json` in `.claude/`, `.agents/`, and the skill install directories

   If validation fails, warn the user with the specific validation errors and ask: "design-tokens.json has schema errors. Run `/d2c-init --force` to regenerate, or continue anyway?" If the schema file is not found, skip validation silently.
3. **Schema version check:** Read the `d2c_schema_version` field. If it is missing or less than 1 (the current version), warn the user: "design-tokens.json uses schema version {version or 'none'} but the current version is 1. Run `/d2c-init --force` to regenerate." Allow the user to continue or abort.
4. **Token structure check (flat tokens):** Spot-check that token values under `colors`, `spacing`, `typography`, `breakpoints`, `shadows`, and `borders` are primitive (string or number). If any value is an object (e.g., `{ value: "#2563EB", css_var: "..." }`), the token file has a nested structure that Phase 2 IR emission cannot handle. Warn: "design-tokens.json has nested token values (expected flat primitives like `\"primary\": \"#2563EB\"`). Run `/d2c-init --force` to regenerate with flat tokens." Allow the user to continue or abort.
5. **Load design tokens using the phased loading strategy below.** Do NOT read the entire file into context at once — load only the sections needed for the current phase.

### Token Loading Strategy

To minimize context usage, load only the sections of `design-tokens.json` relevant to each phase:

- **Phase 1 (Gather Inputs):** Load `framework`, `meta_framework`, `component_file_extension`, `styling_approach`, `components` (for reuse suggestions), `preferred_libraries` (for library check), `conventions`.
- **Phase 2 (Emit and Validate Intermediate Representation):** Load `framework`, `components`, `conventions`, `colors`, `spacing`, `typography`, `shadows`, `borders`, `breakpoints`. Needed to resolve every design value to a token and to enumerate candidate components for each Figma node.
- **Phase 3 (Generate Code):** Load `colors`, `spacing`, `typography`, `breakpoints`, `shadows`, `borders`, `conventions`, `preferred_libraries`, `api`, `components` (for reuse), `hooks`. Also read the three authored IR artifacts (`component-match.json`, `token-map.json`, `layout.json`) from `<ir_run_dir>/` as **frozen inputs** — see the Phase 3 preamble.
- **Phase 4 (Visual Verification):** No additional token sections needed — only the files list and screenshots are used.
- **Phase 5 (Code Quality Audit):** Load `colors`, `spacing`, `typography`, `shadows`, `borders` (for hardcoded value check), `preferred_libraries`, `conventions`, `components`.
- **Phase 6 (Finalize):** Load `components`, `hooks`, `api` (for updating the file with new entries).

At the start of each phase, read only the listed sections from the file. If a section was already loaded in a previous phase and is still in context, do not re-read it. This approach keeps context lean for large projects where the full file exceeds 8K tokens.

#### Split File Loading (when `split_files: true`)

If the `split_files` field is `true` in `design-tokens.json`, load the focused split files instead of parsing sections from the monolithic file:

- **Phase 1 (Gather Inputs):** Read `tokens-core.json` + `tokens-components.json` + `tokens-conventions.json`
- **Phase 2 (Emit and Validate IR):** Read `tokens-core.json` + `tokens-colors.json` + `tokens-components.json` + `tokens-conventions.json` (same set Phase 3 needs, because IR is written against these tokens).
- **Phase 3 (Generate Code):** Read `tokens-colors.json` + `tokens-core.json` + `tokens-conventions.json` + `tokens-components.json`
- **Phase 4 (Visual Verification):** No token files needed.
- **Phase 5 (Code Quality Audit):** Read `tokens-colors.json` + `tokens-conventions.json` + `tokens-components.json`
- **Phase 6 (Finalize):** Read `tokens-components.json` + `tokens-core.json`

Each split file is a standalone JSON object — read it directly with `Read`, no section parsing needed. When `split_files: true`, the split files are the source of truth — the monolithic `design-tokens.json` is a lightweight pointer containing only `d2c_schema_version`, `split_files`, `framework`, and `meta_framework`. If a split file is missing, STOP AND ASK the user to run `/d2c-init --force` to regenerate.

## Step 0b: Token Budget Guard

After the Pre-flight check, estimate the context cost for this build to warn users about large projects that may hit context limits.

**Estimation steps:**
1. Read `.claude/design-tokens/design-tokens.json` and count its lines and character length. Estimate tokens as `Math.ceil(characters / 4)`.
2. Check if `split_files` is `true` in design-tokens.json. If split files exist, the per-phase cost is lower — note this in the estimate.
3. Read the framework reference file (`references/framework-{framework}.md`) and estimate its tokens the same way.
4. Add a fixed estimate of **3,000 tokens** for Figma context overhead (screenshots, design metadata).
5. Sum = design-tokens estimate + framework reference estimate + Figma overhead.

**Thresholds and actions:**

- **design-tokens.json alone exceeds 400 lines or ~20K tokens:**
  - WARN: `"design-tokens.json is large ({lines} lines, ~{tokens} tokens). This will consume significant context per phase."`
  - If `split_files` is `true`: `"Split files detected — only phase-relevant sections will be loaded, reducing per-phase cost."`
  - If `split_files` is `false`: `"Consider running /d2c-init --force to regenerate with split files enabled (auto-splits at 400+ lines)."`

- **Total estimated input exceeds 50K tokens:**
  - STRONG WARNING: `"Estimated context cost is ~{total} tokens. This build may hit context limits on complex designs."`
  - Suggest: `"Consider: (1) splitting the build into smaller components, (2) using --max-rounds 2 to limit iterations, (3) running /d2c-init --force to enable split files."`

- **Total estimated input is under 20K tokens:**
  - Brief one-liner: `"Context budget: ~{total} tokens (comfortable)."`

- **Between 20K and 50K tokens:**
  - Brief one-liner: `"Context budget: ~{total} tokens (moderate — {rounds} rounds should fit)."`
  - Calculate approximate rounds as: `Math.floor((100000 - total) / total)` clamped to MAX_ROUNDS.

Always display the one-line estimate so users know the context cost. Proceed with the build regardless — this is informational, not blocking.

## Step 0: Load Framework Rules

1. Read the `framework` field from `.claude/design-tokens/design-tokens.json`.
2. Read the framework reference file. Try these locations in order (first found wins):
   - `references/framework-{framework}.md` (relative to this SKILL.md file — co-located in the `references/` subdirectory)
   - Search with Glob for `**/framework-{framework}.md` in `.claude/`, `.agents/`, and the skill install directories
   - If neither resolves, proceed without a reference file (step 4 applies).
3. All code generation in Phase 3 MUST follow both the universal rules in this SKILL.md AND the framework-specific rules in the loaded reference file. The reference file takes precedence for framework-specific syntax (file extensions, class vs className, props syntax, etc.).
4. If the reference file does not exist, default to React/Next.js conventions (see inline fallback rules in Generation Rules section) and warn the user: "No framework reference file found for {framework}. Generating with React/Next.js defaults. Run /d2c-init to detect your framework."
5. **Precedence rule for library choices:** `preferred_libraries` in `design-tokens.json` decides WHICH library to use. The framework reference file decides HOW to use that library (import syntax, hook patterns, file conventions). If the selected library is not listed in the reference file's patterns, use the library's standard import/API pattern from its documentation. `design-tokens.json` is always authoritative for library selection.
6. **Load project conventions.** Read the `conventions` section from `design-tokens.json`. For each convention where `confidence` > 0.6 (or `override` is `true`) and `value` is not `"mixed"`, that convention takes **HIGHEST priority** for that code style decision — above the framework reference file. Specifically:
   - `component_declaration` → use arrow functions or function declarations
   - `export_style` → use default or named exports
   - `type_definition` → use `interface` or `type` for props
   - `type_location` → put types in the component file or a separate types file
   - `file_naming` → name new files in PascalCase, kebab-case, or camelCase
   - `import_ordering` → order import groups per the detected pattern
   - `css_utility_pattern` → wrap Tailwind classes with the project's utility function (and use its import path from `wrapper_import`)
   - `barrel_exports` → create/update `index.ts` barrel files for new components
   - `props_pattern` → destructure props in signature or use props object
   - `test_location` → informational only (does not affect code generation, but noted for consistency)
   If the `conventions` section does not exist, fall back to framework reference file patterns for all stylistic choices.

<!-- NON-NEGOTIABLES:BEGIN -->
## Non-negotiables

These rules hold across every phase of this skill. No exceptions.

1. **Design tokens MUST be loaded before any decision.** Read `.claude/design-tokens/design-tokens.json`. If it is missing, unreadable, or has `d2c_schema_version < 1`, STOP AND ASK the user to run `/d2c-init` (or `/d2c-init --force` if outdated).
2. **NEVER use a library outside `preferred_libraries.<category>.selected`.** The user explicitly chose which library to use for each capability. NEVER substitute an installed-but-not-selected library. If the design requires a capability not covered by `preferred_libraries`, STOP AND ASK.
3. **NEVER hardcode color, spacing, typography, shadow, or radius values.** Every visual value MUST reference a design token from `design-tokens.json`. No raw hex, no magic numbers, no exceptions.
4. **MUST reuse existing components when an existing component can serve the need.** Check the `components` array in `design-tokens.json` before creating anything new. If an existing component can do the job, MUST use it.
5. **MUST follow project conventions when `confidence > 0.6` and `value ≠ "mixed"`.** Project conventions (declaration style, export style, type definitions, import ordering, file naming, CSS wrapper, barrel exports, props pattern) override framework defaults.
6. **NEVER re-decide a locked component or token.** Read `decisions.lock.json` from the IR run directory at the start of every phase after Phase 2. Only nodes with `status: "failed"` may have their component choice or token mapping changed. If a locked decision must change, STOP AND ASK.

**When any rule is ambiguous, STOP AND ASK — do not guess.**
<!-- NON-NEGOTIABLES:END -->

## Generation Rules — Enforced at All Times

These rules apply in addition to the non-negotiables above. They govern HOW code is produced once the non-negotiables are satisfied.

- Use the project's styling approach as specified in `styling_approach`.
- If a UI pattern appears 2+ times in the design, extract it into a reusable component. A pattern is "repeated" if 2+ elements share the same HTML structure (same nesting, same tag types) AND the same visual styling (same colors, spacing, border treatment). Different text content does not make a pattern different. New components must be props-driven with no hardcoded content.
- **SOLID**: One component = one job. Extend via props, not source modification. Don't bloat props. Depend on props and hooks, not concrete implementations.
- **DRY**: Shared logic → custom hooks. Shared layout → layout components. Shared styles → design tokens. No copy-paste between components.

---

## Phase 1: Gather Inputs

### 1.1 — Get the Figma URL
Ask the user for the Figma Dev Mode URL for the design. This is required.

If the user provided a URL with their initial prompt (e.g., `/d2c:build https://www.figma.com/design/...`), use that — captured in $ARGUMENTS.

### 1.1b — Dry Run Check
If the user includes "dry run" in their prompt or $ARGUMENTS, complete Phases 1 and 2 but **halt before Phase 3 (Generate Code)**. Phase 2 writes the four IR artifacts to `.claude/design-tokens/runs/<timestamp>/` and runs `validate-ir.js`; the IR **is** the plan. After validate-ir prints `ok`, present the plan to the user: which files would be created/modified, which existing components would be reused, and a pointer to the IR directory so they can inspect the raw JSON before proceeding. Ask the user to confirm before moving to Phase 3 and running the verification loop. (Note: `--dry-run` means "emit and validate IR, halt before codegen" — it does not mean "skip all writes". The IR JSON files are always written so the plan is inspectable.)

### 1.2 — Standard Intake Questions

#### 1.2a — Complexity Classification

After loading the Figma design context (from step 1.4, or if the Figma URL was provided upfront), classify the component's complexity BEFORE asking intake questions. This determines which questions to skip.

**Classification rules:**

- **Simple** (skip questions 4 and 6): The design is a single UI element — button, badge, icon, avatar, chip, tag, toggle, tooltip, divider, separator, progress bar, skeleton, spinner. **Detection:** the Figma node name or top-level layer name (case-insensitive) contains one of these keywords AND the total layer count in the Figma design context is 20 or fewer.
- **Medium** (skip question 6 only): Cards, inputs, selects, dropdowns, modals, dialogs, alerts, toasts, navigation items, tabs, breadcrumbs, list items. **Detection:** Figma node name matches one of these keywords (case-insensitive) AND total layer count is 50 or fewer.
- **Complex** (ask all 6 questions): Pages, dashboards, forms, tables, layouts, sidebars, or any design with layer count > 50, or any design that does not match Simple or Medium keywords.

**How to count layers:** Use `get_metadata` (or the metadata from `get_design_context`) to get the node tree. Count all descendant nodes of type FRAME, INSTANCE, COMPONENT, COMPONENT_SET, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, GROUP, BOOLEAN_OPERATION, STAR, REGULAR_POLYGON. Exclude the root node itself. This count is the "total layer count" for classification.

**Auto-fill defaults for skipped questions:**
- Question 4 (viewports): Default to **"desktop-only"** for simple and medium components.
- Question 6 (API): Default to **"no"** for simple components.

**Tell the user** which questions were skipped and why:
> "Classified as **simple component** (badge, 12 layers). Skipping viewport and API questions -- defaulting to desktop-only, no API."

or:
> "Classified as **medium component** (card, 34 layers). Skipping API question -- defaulting to no API."

If the user disagrees with the classification, they can override by answering the skipped questions. Proceed with their answers.

#### 1.2b — Ask Intake Questions

Ask the applicable questions in a single message. If the user already answered any of these in their prompt or $ARGUMENTS, pre-fill those and only ask the remaining ones.

**Intake history:** Before asking, check if `.claude/design-tokens/intake-history.json` exists. If it does, read it. The file contains a `builds` array (newest first, max 5 entries). First, check if any entry's `figma_url` matches the current Figma URL — if so, use that entry's answers as defaults. If no URL match, use the first (most recent) entry. For each question below, if there is a previous answer on record, show it as a selectable option labeled **"Last used: [previous answer]"** alongside the standard choices. The user must explicitly select it — never auto-apply previous answers. Always also show the standard options so the user can pick something different.

**Questions (ask all that apply based on complexity classification):**

1. **What is this?** — Page, section, or component?
2. **Where should it live?** — File path or general area (e.g., "dashboard route"). If the user gives a general area, expand it to a specific path using the framework's routing convention from the framework reference file.
3. **Functional or visual-only?**
   - **Fully functional**: Real interactivity, state management, working forms, navigation, etc.
   - **Visual only**: Placeholder data, no real logic, just matches the design visually
4. **Viewports?** *(skipped for Simple and Medium — defaults to desktop-only)* — Desktop only, or multiple (desktop/tablet/mobile)? If multiple, share the Figma URL for each.
5. **Components to reuse?** — Name specific existing components, or say "use what makes sense"
6. **Does this design connect to any APIs?** *(skipped for Simple — defaults to no)*
   - **No** — Static content, no API calls needed
   - **Yes** — If yes, ask the follow-up questions:
     - **How many API calls does this page/component need?** (e.g., 1, 2, 3+)
     - **For each API call**, ask the user to provide:
       - A name/description (e.g., "fetch user profile", "get notifications list", "load activity feed")
       - A sample response JSON or endpoint schema (optional but strongly recommended)
     - Present this as a numbered list the user can fill in. Example:
       > "Please describe each API call this design needs:
       > 1. **Call 1**: Name/description + sample response JSON
       > 2. **Call 2**: Name/description + sample response JSON
       > 3. *(add more as needed)*"

Wait for answers before proceeding. Do not assume defaults for any unanswered question (except the auto-filled ones from complexity classification).

**After receiving answers:** Save the answers to `.claude/design-tokens/intake-history.json`. The file contains a `builds` array (max 5 entries, newest first). Prepend the new entry. If an entry with the same `figma_url` already exists, replace it instead of prepending. If the array exceeds 5 entries, drop the oldest. Structure:

```json
{
  "builds": [
    {
      "figma_url": "<the Figma URL for this build>",
      "timestamp": "<ISO 8601>",
      "what": "<page | section | component>",
      "where": "<file path>",
      "mode": "<functional | visual-only>",
      "viewports": "<desktop-only | multiple>",
      "components_to_reuse": "<user's answer>",
      "has_api_calls": "<yes | no>"
    }
  ]
}
```

### 1.4 — Load Design Context
1. **Figma design context** — Use Figma MCP to pull design context and implementation details from the provided URL(s). Get layout, spacing, colors, typography, and component structure.
   - **MCP fallback:** If the Figma Desktop MCP (`mcp__Figma__*`) is unavailable or errors, try the web-based Figma MCP (`mcp__*__get_design_context` with `fileKey` and `nodeId` extracted from the URL). Only escalate to the user (P1-FIGMA-UNREACHABLE) after both Desktop and web MCP providers have been tried and failed.
2. **Figma screenshot(s)** — Use Figma MCP to get a screenshot of each viewport. **CRITICAL: Hold these screenshots in context for the entire session. You need them for every comparison round. Do not discard them.**
3. **Target file context** — If slotting into an existing file, read it first. If it's a new file, read neighboring files to understand patterns (imports, layout conventions, naming).

### 1.4b — Auto-Suggest Reusable Components

After loading the Figma design context, match the design against the `components` section of `design-tokens.json` using **keyword-based matching only** (no visual similarity matching):

1. Scan the Figma design context text for these exact element keywords: `button`, `input`, `select`, `textarea`, `card`, `avatar`, `badge`, `table`, `nav`, `tab`, `modal`, `dialog`, `tooltip`, `popover`, `alert`, `toast`, `sidebar`, `header`, `footer`, `breadcrumb`, `pagination`, `toggle`, `checkbox`, `radio`, `dropdown`, `menu`, `list`, `grid`, `form`, `search`, `icon`.
2. For each keyword found in the Figma context, check if a component with that word (case-insensitive) in its `name` exists in the `components` array of `design-tokens.json`.
3. If a match is found, add it to the suggestions list with source `keyword`.
4. **Layer name matching:** Also scan the Figma design context for layer/node names (e.g., "ProfileCard", "NavBar", "SearchInput"). For each layer name, check if any component in the `components` array has a `name` that is a case-insensitive substring match (e.g., Figma layer "UserAvatar" matches component "Avatar"). Add new matches to the suggestions list with source `layer-name`. Deduplicate with keyword matches by component name.
5. Sort suggestions alphabetically by component name.

**Present suggestions to the user before proceeding:**

> "Based on the Figma design, I recommend reusing these existing components:
> - **Button** (`src/components/ui/Button.tsx`) — matched keyword: `button`
> - **Card** (`src/components/ui/Card.tsx`) �� matched keyword: `card`
> - **Avatar** (`src/components/ui/Avatar.tsx`) — matched layer name: `UserAvatar`
>
> Does this look right? Any additions or changes?"

Wait for confirmation. If the user already specified components in question 5, merge your suggestions with their list (deduplicate by component name) and confirm the combined set.

### 1.5 — Library Check

After loading the Figma design context, identify what the design requires (e.g., charts, maps, date pickers, carousels, rich text editors, drag-and-drop, animations, icons, etc.).

**Step 1: Check installed packages.**
Read `package.json` dependencies and devDependencies. For each capability the design needs, check if a relevant library is already installed.

Examples:
- Charts → `recharts`, `chart.js`, `@nivo/*`, `victory`, `d3`
- Maps → `react-map-gl`, `@react-google-maps/api`, `leaflet`
- Date pickers → `react-datepicker`, `@mui/x-date-pickers`, `react-day-picker`
- Carousels → `swiper`, `embla-carousel-react`, `keen-slider`
- Animations → `framer-motion`, `react-spring`, `@react-spring/web`
- Icons → `lucide-react`, `react-icons`, `@heroicons/react`
- Tables → `@tanstack/react-table`, `ag-grid-react`

**Step 2: Check `preferred_libraries` first.** If the capability category exists in `preferred_libraries`, use the `selected` library. No question needed — the user already chose during init.

**Step 3: If the category does NOT exist in `preferred_libraries`** (the design needs something that was not detected during init), check `package.json` to see if any relevant library is already installed.

**If a library is installed → MUST use it.** NEVER rebuild from scratch what a project dependency already provides. If multiple are installed, STOP AND ASK the user which to prefer (same format as init Step 5e). If a library is installed but NOT listed in `preferred_libraries.<category>.selected`, STOP AND ASK — do NOT substitute it for the selected library.

**Step 4: If no matching library is installed**, present the user with 2-3 options and a recommendation:

> "The design includes [charts/maps/etc.] but no library is installed for this. Here are the options:
> 1. **[Library A]** — [one-line why]. **(Recommended)**
> 2. **[Library B]** — [one-line why].
> 3. **Build from scratch** — Only if the requirement is simple enough.
>
> Which would you like?"

Always recommend the option that best fits the project's existing stack and complexity. Wait for the user's choice before proceeding. Install the chosen library before generating code. **After the user chooses, update `preferred_libraries` in `.claude/design-tokens/design-tokens.json`** with the new category and selection so future builds don't ask again.

---

## Phase 2: Emit and Validate Intermediate Representation

IR is the **plan** for the build. Before any code is written, Phase 2 produces four JSON artifacts in `.claude/design-tokens/runs/<timestamp>/` and runs `scripts/validate-ir.js` to verify them. Code generation in Phase 3 reads the validated IR as a **frozen** input — Non-negotiable rule 6 forbids re-deciding any IR value during codegen or retry.

Three of the four artifacts are **authored** (the model decides their contents). The fourth (`run-manifest.json`) is **mechanical** bookkeeping written by this phase itself.

**Version coupling rule:** All four IR artifacts (`run-manifest.json`, `component-match.json`, `token-map.json`, `layout.json`) MUST share the same `schema_version` value. Set `schema_version` to **1** for all artifacts unless explicitly instructed otherwise. If you use v2 for component-match (scored candidates), you MUST also set v2 for run-manifest, token-map, and layout. The validator rejects any version mismatch across artifacts.

**Phase 2 Quick Reference:**
- **2.0** Create run directory: `.claude/design-tokens/runs/<YYYY-MM-DDTHHMMSS>/`
- **2.1** `run-manifest.json`: compute SHA-256 hash of `design-tokens.json` (or concatenated split files in order: `tokens-core | tokens-colors | tokens-components | tokens-conventions`)
- **2.2** `component-match.json`: score candidates per node, pick highest
- **2.3** `token-map.json`: map Figma properties to `<category>.<name>` token paths (must resolve to leaf values in design-tokens.json)
- **2.4** `layout.json`: root region + 1 level nested, flex-only, deferred must be empty
- **2.5** Run `validate-ir.js` — all artifacts must pass before Phase 3

### 2.0 — Create the run directory

Compute a timestamp in the format `YYYY-MM-DDTHHMMSS` (no colons, filesystem-safe on Windows). Create the directory:

```
.claude/design-tokens/runs/<YYYY-MM-DDTHHMMSS>/
```

Also update `.claude/design-tokens/runs/latest` to point at this new directory. On POSIX, create a symlink; on Windows (or if symlinks fail), write a plain text file containing the run-dir path. Store the full run directory path as `ir_run_dir` for use in step 2f and in the checkpoint file.

### 2.1 — Emit `run-manifest.json` (mechanical)

Compute the SHA-256 hex digest of `.claude/design-tokens/design-tokens.json` (raw file bytes). If `split_files: true`, instead hash the four split files concatenated in the fixed order `tokens-core.json | tokens-colors.json | tokens-components.json | tokens-conventions.json`.

Write `<ir_run_dir>/run-manifest.json`:

```json
{
  "schema_version": 1,
  "figma_url": "<the Figma URL from Phase 1>",
  "started_at": "<ISO 8601 timestamp with timezone, e.g. 2026-04-10T10:00:00-07:00>",
  "framework": "<framework from design-tokens.json>",
  "tokens_file_hash": "<SHA-256 hex>"
}
```

This file anchors the run to a specific tokens version. If the user edits `design-tokens.json` mid-build, the validator catches it via hash mismatch and forces a STOP AND ASK.

### 2.1b — Check for multiple unrelated subtrees

<!-- fm:P2-MULTI-SUBTREE -->

Before emitting IR, analyze the Figma frame's direct children. If the frame has 3+ direct children with no shared visual patterns (different background colors, different layout directions, different content types with no visual grouping), this likely represents multiple unrelated sections. Read the P2-MULTI-SUBTREE entry in `references/failure-modes.md` and follow its prompt template — STOP AND ASK which subtree(s) to build.

### 2.2 — Emit `component-match.json` (authored, scored)

For every Figma node that will render as a component instance, scan `design-tokens.json.components[]` and identify up to 3 candidate components. Score each candidate on three dimensions, pick the highest-scoring one, and write the result.

#### Scoring Rubric (total 0–100)

**Dimension 1 — Props match (0–50 points)**

For each candidate component, count how many of the Figma node's identifiable visual properties map to the component's declared `props[]`.

A **Figma identifiable property** is a distinct visual attribute in the node that a component prop would need to control:
- Text content → maps to `children`, `label`, `title`, `placeholder`, `description`, etc.
- Color/variant indicators → maps to `variant`, `color`, `type`, `intent`, `status`, etc.
- Size indicators → maps to `size`, `width`, `height`, etc.
- Interactive states → maps to `disabled`, `loading`, `active`, `checked`, `open`, etc.
- Children/slots → maps to `children`, `header`, `footer`, `icon`, `prefix`, `suffix`, etc.
- Spacing/padding → maps to `padding`, `gap`, `spacing`, `compact`, etc.
- Icons/images → maps to `icon`, `src`, `avatar`, `image`, etc.

For each component prop, ask: "Does the Figma node contain visual evidence that this prop would be used?" Binary per-prop — yes or no.

Formula: `props_match = floor(matched_props / max(figma_identifiable_properties, 1) * 50)`

The denominator is Figma-side (demand), not component-side. This avoids penalizing components with many props.

**Dimension 2 — Usage frequency (0–25 points)**

Uses the `import_count` field from `design-tokens.json.components[]` (computed during `/d2c-init`).

Relative ranking among candidates for the current node:
- Find `max_count = max(candidate.import_count for all candidates for this node)`
- If `max_count == 0` or all candidates lack `import_count`: all candidates get **13** (neutral — do not let this dimension swing the outcome when there is no data)
- Otherwise: `usage_frequency = floor(candidate.import_count / max_count * 25)`

**Dimension 3 — Semantic alignment (0–25 points)**

How well the component's `name` and `description` match the Figma node's name, type, and surrounding context.

| Score | Band | Criteria |
|---|---|---|
| 18–25 | Strong | Component name is a case-insensitive substring of the Figma node name (e.g., "Button" matches "SubmitButton"), OR the description's primary function directly matches the node's apparent purpose |
| 9–17 | Partial | Component type (from description) matches the node's structural role, but names are not directly related (e.g., "Card" component for a Figma frame named "ProductWrapper") |
| 0–8 | None | No clear relationship between component purpose and node purpose |

**Composite score:** `score = props_match + usage_frequency + alignment`

#### Candidate Selection

1. For each Figma node, evaluate ALL components in `design-tokens.json.components[]` against the rubric.
2. Rank by composite score descending.
3. Emit the **top 3** candidates (or fewer if the registry has fewer components).
4. **Tiebreaker chain** (when composite scores are equal): (a) higher `props_match`, (b) higher `usage_frequency`, (c) alphabetical by `componentId`.

#### Threshold and Chosen

- **MUST pick the highest-scoring candidate** as `chosen`.
- **FAIL IF the top score is below 50** — read `references/failure-modes.md` entry P2-NO-MATCH and follow its user prompt template. Set `chosen: "__NEW__"`.
- **User-confirmed override:** If the user confirmed a component in Phase 1.4b, that component MUST be in candidates with `user_confirmed: true`. It becomes `chosen` regardless of score. The 50-point threshold does NOT apply to user-confirmed choices.
- If the model cannot decide between candidates (genuinely ambiguous), set `chosen: null` — the validator will fail and STOP AND ASK the user.
- **Empty registry:** If `design-tokens.json.components[]` is empty, every node gets `candidates: [], chosen: "__NEW__", chosen_reasoning: "No reusable components in registry."`. Skip the scoring flow.

#### Output Format

```json
{
  "schema_version": 2,
  "nodes": {
    "<figma-node-id>": {
      "figma_name": "<layer name>",
      "figma_type": "<INSTANCE | FRAME | COMPONENT | ...>",
      "candidates": [
        {
          "componentId": "<name>",
          "source": "<file path relative to project root>",
          "reasoning": "<one-line why this is a candidate>",
          "score": 78,
          "score_breakdown": {
            "props_match": 40,
            "usage_frequency": 20,
            "alignment": 18
          }
        },
        {
          "componentId": "<other name>",
          "source": "<file path>",
          "reasoning": "<one-line why>",
          "score": 52,
          "score_breakdown": {
            "props_match": 30,
            "usage_frequency": 10,
            "alignment": 12
          },
          "rejected_because": "<why this was not chosen over the winner>"
        }
      ],
      "chosen": "<componentId of highest-scoring candidate>",
      "chosen_reasoning": "<one-line explanation referencing the score>"
    }
  }
}
```

#### Rules (enforced by the validator)

- `schema_version` MUST be `2`.
- `candidates[]` MUST have 0–3 entries. Empty is valid only when `chosen` is `"__NEW__"`.
- Candidates MUST be sorted by `score` descending.
- Each candidate MUST have `score`, `score_breakdown`, and `reasoning`.
- `score_breakdown.props_match + score_breakdown.usage_frequency + score_breakdown.alignment` MUST equal `score`.
- `score_breakdown` ranges: `props_match` 0–50, `usage_frequency` 0–25, `alignment` 0–25.
- `chosen` MUST be `candidates[0].componentId` (highest score), OR `"__NEW__"`, OR `null` (ambiguous — STOP AND ASK), OR a candidate marked `user_confirmed: true`.
- Non-chosen candidates MUST have `rejected_because` (non-empty string).
- `chosen_reasoning` is mandatory.
- If `chosen` points at a `source` that does not exist on disk AND is not in `design-tokens.json.components[]`, validation fails.

### 2.3 — Emit `token-map.json` (authored)

**Conflict-aware preamble:** Before emitting token-map.json, read `.claude/design-tokens/token-conflicts.json` if it exists. If any conflict entry has `status: "unresolved"`, trigger **P2-TOKEN-CONFLICT-ASK** — STOP AND ASK the user to resolve before proceeding with token mapping. Do not emit token-map.json while unresolved conflicts exist.

For every Figma node with design properties that would normally be translated to CSS values, map each property to a dotted token reference against `design-tokens.json`:

```json
{
  "schema_version": 1,
  "nodes": {
    "<figma-node-id>": {
      "background": "colors.primary",
      "color": "colors.on-primary",
      "padding-x": "spacing.md",
      "gap": "spacing.sm"
    }
  }
}
```

Rules:
- Every value MUST be a lowercase dotted path of the form `<category>.<name>` (or `<category>.<group>.<name>` for nested categories). Categories covered: `colors`, `spacing`, `typography`, `breakpoints`, `shadows`, `borders`.
- Every value MUST resolve to a real entry in `design-tokens.json`. Unknown references fail validation with a "did you mean" suggestion.
- **NEVER** hardcode values with an inline escape hatch — if a Figma value has no matching token, STOP AND ASK (Non-negotiable rule 3).
- **Conflict resolution:** If `token-conflicts.json` exists and a Figma design value matches multiple tokens in the same category (same resolved value), MUST use the `canonical` token path from the resolved conflict entry. Do NOT use any of the `duplicates` paths. If the conflict was `auto-resolved`, log a brief note: "Used canonical `{canonical}` (auto-resolved over `{duplicates}`)". This is an **inform**-tier action (P2-TOKEN-CONFLICT-AUTO) — build continues.

### 2.4 — Emit `layout.json` (authored, shallow)

Capture the root layout region plus one level of nested regions. v1 is **flex-only**. Grid, absolute, and deeper nesting go into `deferred[]` and fail the run so the user is prompted.

```json
{
  "schema_version": 1,
  "root": {
    "nodeId": "<root figma id>",
    "direction": "col",
    "gap": "spacing.lg",
    "align": "start",
    "justify": "start",
    "regions": ["<child region id 1>", "<child region id 2>"]
  },
  "regions": {
    "<child region id 1>": {
      "direction": "row",
      "gap": "spacing.sm",
      "align": "center",
      "justify": "between",
      "children": ["<child node id 1>", "<child node id 2>"]
    }
  },
  "deferred": []
}
```

Rules:
- `direction` MUST be one of `row`, `col`, `wrap`.
- `gap` MUST be a dotted token reference that resolves in `design-tokens.json` (same rules as token-map.json).
- Every `children[]` entry MUST exist as a key in `component-match.json.nodes` (cross-reference check by the validator).
- `deferred[]` MUST be empty for a successful run. Non-empty deferred[] fails the validator — STOP AND ASK the user to either convert the region to flex in Figma or skip it.
- Only one level of nested regions is supported in v1. Anything deeper goes into `deferred[]`.

### 2.5 — Run `validate-ir.js`

Invoke the validator on the run directory. Resolve the script path with the same cascade as `pixeldiff.js`: try `references/scripts/validate-ir.js` relative to this SKILL.md, then `~/.claude/commands/d2c-build/scripts/validate-ir.js`, then `~/.claude/skills/d2c-build/scripts/validate-ir.js`, then `~/.agents/skills/d2c-build/scripts/validate-ir.js`, then Glob `**/validate-ir.js` as a last resort.

```bash
node "$VALIDATE_IR_SCRIPT" ".claude/design-tokens/runs/<timestamp>/"
```

Parse stdout. The first line is `validate-ir: ok | fail | skip`. On `ok`, proceed to step 2f. On `fail`, read the subsequent `error: …` lines and enter the failure handling below.

### 2.6 — Failure handling

<!-- fm:P2-SCHEMA-ERR, P2-UNKNOWN-TOKEN, P2-DANGLING-REF, P2-INVALID-CHOSEN, P2-AMBIGUOUS-CHOSEN, P2-DEFERRED, P2-HASH-MISMATCH, P2-SOURCE-MISSING, PX-UNKNOWN-FAILURE -->

When `validate-ir.js` reports `fail`, read the `error: …` lines and match each against the table below to find the correct failure mode. Then read the matching entry in `references/failure-modes.md` and follow its User prompt template exactly — do NOT improvise a response.

**Error-to-failure-mode matching rules:**

| Error pattern | Failure mode ID |
|---|---|
| `"required field"` / `"expected ... got"` / `"pattern"` / `"unexpected field"` | P2-SCHEMA-ERR |
| `"unknown token reference"` | P2-UNKNOWN-TOKEN |
| `"not present in component-match"` | P2-DANGLING-REF |
| `"not in candidates"` | P2-INVALID-CHOSEN |
| `"chosen is null"` | P2-AMBIGUOUS-CHOSEN |
| `"deferred"` | P2-DEFERRED |
| `"tokens_file_hash"` + `"mismatch"` | P2-HASH-MISMATCH |
| `"does not exist on disk"` | P2-SOURCE-MISSING |
| Any unrecognized error | PX-UNKNOWN-FAILURE |

**Batching:** If multiple errors fire in the same validation run, present them in a single STOP AND ASK message grouped by failure ID (see Meta-Rules in `references/failure-modes.md`). Do NOT issue separate prompts for each error.

In every failure case, NEVER edit the IR files inline to silence the validator. Regenerate them, or STOP AND ASK. (Non-negotiable rule 6.)

### 2.5b — Write `decisions.lock.json`

Immediately after `validate-ir.js` exits 0, freeze all IR decisions into a lock file. This is the enforcement artifact for Non-negotiable rule 6 — every phase after Phase 2 reads it and treats locked entries as immutable.

Write `<ir_run_dir>/decisions.lock.json`:

```json
{
  "schema_version": 1,
  "locked_at": "<ISO 8601 timestamp with timezone>",
  "layout_locked": true,
  "nodes": {
    "<figma-node-id>": {
      "componentId": "<chosen value from component-match.json>",
      "status": "locked",
      "locked_at": "<same ISO 8601 timestamp>"
    }
  }
}
```

**Generation steps:**
1. Read `component-match.json` from `<ir_run_dir>/`.
2. For each node in `component-match.json.nodes`, create a lock entry with `componentId` set to the node's `chosen` value, `status: "locked"`, and `locked_at` set to the current timestamp.
3. Set top-level `schema_version: 1`, `layout_locked: true`, and `locked_at` to the same timestamp.
4. Write the file. This locks all component choices and token mappings. Token-map.json is locked as a whole — no per-property override mechanism in v1.

The lock file uses the `decisions-lock.schema.json` schema. If `validate-ir.js` is re-run after the lock is written (e.g., on resume), it validates the lock against the schema and cross-references every node against `component-match.json`.

**Override mechanism (three tiers):**
- **Per-node unlock:** If Phase 4 or Phase 5 identifies that a locked node needs re-decision, STOP AND ASK the user. If approved, update the lock file: set the node's `status` to `"failed"`, add `failure_reason`, `failed_at`, and `failed_by`. Then regenerate the IR and write a fresh lock.
- **Full fresh build:** User runs `/d2c-build` without `--resume`. New run directory, new IR, new lock.
- **Manual deletion:** User deletes `decisions.lock.json` from the run directory. On next resume, the skill detects the missing lock and re-runs Phase 2 for all nodes.

### 2.7 — Record `ir_run_dir` in the checkpoint

On success, append `ir_run_dir: "<full path to run dir>"` to `.claude/design-tokens/.d2c-build-checkpoint.json` so a later resume can re-read the same IR instead of regenerating it. Proceed to Phase 3.

### 2.8 — Dry-run halt

If the user passed `dry run` in $ARGUMENTS (see Phase 1.1b), halt here after step 2.7. Do not proceed to Phase 3. Print a summary of the IR contents (node count, token-ref count, deferred count) and the path to `.claude/design-tokens/runs/<timestamp>/` so the user can inspect the JSON before deciding to continue.

---

## Phase 3: Generate Code

**Phase 3 preamble — non-negotiable.** Before writing any code, MUST read all three authored IR artifacts from `<ir_run_dir>/` (`component-match.json`, `token-map.json`, `layout.json`) AND the decision lock (`decisions.lock.json`). Treat them as **frozen inputs**. Verify all node entries in `decisions.lock.json` have `status: "locked"`. If any entry has `status: "failed"`, only that node's component choice and token mapping may differ from the original IR — all other nodes remain immutable.

- NEVER re-decide a `chosen` component during codegen. If a component in `component-match.json.chosen` turns out to be a poor fit, STOP AND ASK — do not silently swap it.
- NEVER re-resolve a token reference. Use only the tokens listed in `token-map.json` for each node. If the model realizes a value was mapped incorrectly, STOP AND ASK.
- NEVER change layout direction, gap, or region membership from what `layout.json` specifies.
- FAIL IF the generated code references a component that is not in `component-match.json.chosen` or uses a token that is not in `token-map.json` for that node — the Phase 5 audit will catch this, but the model MUST NOT produce such code in the first place.
- When a situation arises that genuinely requires changing an IR value, STOP AND ASK — do not patch the IR inline.

<!-- fm:P3-IR-DEVIATION, P3-COMPONENT-GONE, P3-PROP-MISMATCH, P3-FILE-PLACEMENT -->

**Pre-generation checks** (before writing any code for a node):
1. **Verify component source exists.** For each node in `component-match.json`, confirm the chosen component's `source` path exists on disk. If missing, follow P3-COMPONENT-GONE in `references/failure-modes.md`.
2. **Verify prop compatibility.** Read the chosen component's actual prop interface from the source file. If the Figma design needs a prop the component doesn't have, follow P3-PROP-MISMATCH.
3. **Verify file placement.** If creating a new component, confirm a standard component directory exists. If none exists, follow P3-FILE-PLACEMENT.

If at any point during codegen you are about to deviate from the frozen IR (different component, different token, different layout direction), follow P3-IR-DEVIATION — STOP AND ASK with the exact prompt template. NEVER silently substitute.

### Code Principles

Follow the Non-negotiables (rules 1–6 at the top of this file) and the Generation Rules section above (styling approach, 2+ pattern extraction, SOLID, DRY). Additionally:
- Before creating ANY new component, MUST check `design-tokens.json` → `components`. If an existing component can do the job, MUST use it (this is Non-negotiable rule 4). If uncertain whether an existing component fits, STOP AND ASK.
- If a pattern appears 2+ times in the design (same HTML structure + same visual styling = repeated pattern; different text content does NOT make it different), MUST extract it into a new reusable component.
- New components MUST be props-driven and composable. NEVER hardcode content — pass it through props.

**Project conventions take highest priority for stylistic choices.** If `conventions` exists in `design-tokens.json`, follow those for: component declaration style, export style, type definitions, type location, file naming, import ordering, CSS utility wrapping, barrel exports, and props pattern. The framework reference file remains authoritative for **framework requirements** — reactivity system, template syntax, directives, lifecycle hooks, `className` vs `class`, `"use client"` rules. The distinction: if it's a stylistic choice where the team could go either way, follow conventions. If it's a framework requirement that can't vary, follow the framework reference.

**Figma Auto Layout Mapping:**
- Figma horizontal Auto Layout → CSS flexbox `flex-row` (or Tailwind `flex flex-row`)
- Figma vertical Auto Layout → CSS flexbox `flex-col` (or Tailwind `flex flex-col`)
- Auto Layout spacing value → CSS `gap` (or Tailwind `gap-X`)
- Auto Layout padding → container padding
- Figma "hug contents" → `width: auto` / `w-auto`
- Figma "fill container" → `width: 100%` / `w-full` or `flex: 1` / `flex-1`
- Figma "fixed" → explicit width/height values

**File Structure:**
- **File placement rules (deterministic):**
  - **New reusable components:** Check the framework reference file for the standard component directory. As a secondary fallback, place the new component in the same directory as the existing component most similar in type (match by keyword overlap between the new component's name and existing component names in `design-tokens.json`). If no similar component exists, use the first directory that exists from: `src/components/ui/`, `src/components/shared/`, `src/components/common/`, `src/components/`, `components/ui/`, `components/`.
  - **Page-specific components:** Place in the route directory's `components/` subfolder. The route directory structure varies by framework — check the framework reference file for the page directory convention.
  - **New hooks/composables/services:** Place in the same directory as existing ones. Check the framework reference file for the standard location (e.g., `src/hooks/` for React, `composables/` for Vue/Nuxt, `src/lib/` for Svelte, `src/app/core/services/` for Angular).
  - **API functions/services:** Place in the same directory as existing API files (from `api.config_path` in tokens). If none exists, check the framework reference file for the default API directory.
- **Strict one-component-per-file rule**: Each component gets its own file. The only exception is a sub-component that is 15 lines or fewer — it is permitted to stay in the parent file. Anything over 15 lines MUST be extracted to a separate file, imported, and used.
- **File naming:** If `conventions.file_naming` is set and not `"mixed"`, name all new files using that pattern (e.g., `PascalCase` → `UserProfile.tsx`, `kebab-case` → `user-profile.tsx`). Otherwise follow the framework reference default.
- **Barrel exports:** If `conventions.barrel_exports.value` is `"yes"`, create or update an `index.ts`/`index.js` file in the component directory to re-export the new component.
- **Type files:** If `conventions.type_location.value` is `"separate_file"`, place TypeScript interfaces/types in a `types.ts` file in the same directory as the component, not inline.
- Export with proper TypeScript types for all props.

### Generation Rules

1. Write code for the primary viewport first (typically desktop).
2. Add responsive behavior for other viewports using the project's breakpoint system from `design-tokens.json`.
3. Use semantic HTML (`nav`, `main`, `section`, `article`, `aside`, `header`, `footer`, `button`) — not div soup.
4. **Accessibility (WCAG 2.2 AA minimum):**
   - All images must have `alt` text (descriptive for informational images, `alt=""` for decorative)
   - All form inputs must have associated `<label>` elements or `aria-label`
   - Heading hierarchy must not skip levels (no h1 then h3)
   - All interactive elements (buttons, links, inputs) must have minimum 24x24px touch target (WCAG 2.5.8)
   - All interactive elements must be keyboard-focusable with visible focus indicators
   - Icon-only buttons must have `aria-label`
   - Color must not be the sole means of conveying information
   - The root `<html>` element MUST have a `lang` attribute
   - Every new component must have a JSDoc comment above the function/component declaration: `/** Brief description. @param props.propName - Description */`
5. **Image handling:** If Figma MCP is available, MUST use `get_screenshot` to export individual image/icon nodes from the Figma design and save them to the project's asset directory (e.g., `public/images/`). If export is not possible, use placeholder `src` values with a comment: `{/* Figma asset: [node name] */}`. For icons, MUST use the project's icon library from `preferred_libraries.icons` (this is Non-negotiable rule 2). NEVER substitute a different icon library.
6. **Client/server boundary rule:** Follow the framework reference file's client/server boundary rules. Each framework handles this differently. Do NOT apply React's `"use client"` rule to non-React frameworks. **Inline fallback for React/Next.js (if reference file unavailable):** Add `"use client"` ONLY if the component uses: `useState`, `useEffect`, `useReducer`, `useContext`, `useRef` with DOM access, event handlers (`onClick`, `onChange`, `onSubmit`), browser APIs (`window`, `document`, `localStorage`), or third-party client hooks. All other components default to Server Components.
7. Focus on the default/resting visual state. Add subtle transitions on interactive elements by default: `transition-colors duration-150` (or equivalent) on buttons, links, and clickable cards. Add `hover:opacity-80` or a framework-appropriate hover state for buttons. Do NOT implement complex animations, active states, or loading animations unless the user explicitly requests them or the Figma design includes them as separate frames.
8. **Tailwind class selection rule (if Tailwind):** MUST use the shortest Tailwind class that achieves the exact value. MUST use scale classes (`p-4`) when the value is in the scale — NEVER substitute arbitrary values (`p-[16px]`) when a scale class exists. Use arbitrary values ONLY when no scale class matches. NEVER use longhand (`px-4 py-4`) when shorthand (`p-4`) achieves the same result. For colors, MUST use the semantic token class (`bg-primary`) over the raw color class (`bg-blue-500`) when a semantic token exists. **Use the framework's class attribute name** — `className` for React/Solid (JSX), `class` for Vue/Svelte/Angular/Astro/Qwik. Check the framework reference file.

### API Integration Rules

If the user selected "Yes" for API connections in question 6 and `preferred_libraries.data_fetching` exists in `design-tokens.json`, follow these rules:

1. **MUST use the selected data fetching library.** Check `preferred_libraries.data_fetching.selected` and MUST use that library. The framework reference file specifies the correct API/import pattern for each library in this framework (e.g., `useQuery` for React Query, `useFetch` for Nuxt, `createResource` for Solid, `inject(HttpClient)` for Angular). NEVER use a different fetching library than what's selected (this is Non-negotiable rule 2).

2. **Match the project's API file structure.** If the project has API calls in `services/`, `api/`, or `lib/`, put new API calls in the same location following the same naming convention.

3. **Generate typed API functions for each call the user described.**
   - If the user provided a sample response JSON, generate TypeScript interfaces/types from it.
   - If no sample was provided, generate reasonable types based on the design's data needs with `// TODO: Replace with actual API response type` comments.
   - Name the types descriptively (e.g., `UserProfileResponse`, `NotificationItem`, `ActivityFeedEntry`).

4. **Wire up components to API calls.**
   - Components MUST consume data from the API hooks/functions. NEVER hardcode values that belong to API data — if the data flow is unclear, STOP AND ASK.
   - MUST use the project's established loading state pattern (from `api.loading_pattern` in tokens).
   - MUST use the project's established error handling pattern (from `api.error_handling` in tokens).
   - The generated code MUST work end-to-end — when the user plugs in a real API endpoint, the component renders real data without structural changes.

5. **For multiple API calls in a single page/component:**
   - Each API call gets its own hook/function.
   - Handle loading and error states independently per call (unless the project uses a coordinated pattern like React Query's `useQueries`).
   - If calls have dependencies (e.g., call 2 needs data from call 1), chain them appropriately using the project's pattern (e.g., `enabled` option in React Query).

6. **Placeholder endpoints.**
   - Use descriptive placeholder URLs: `/api/user/profile`, `/api/notifications`, etc.
   - Add a comment above each endpoint: `// TODO: Replace with actual endpoint`
   - If `base_url_env` exists in the API config, use it: `${process.env.NEXT_PUBLIC_API_URL}/user/profile`

### Dark Mode / Theme Rules

If `design-tokens.json` contains tokens under a `dark` key, `[data-theme="dark"]` block, or the Figma design includes dark mode frames:

1. **Detect the project's theme strategy:** CSS variables with `[data-theme]`, Tailwind `dark:` classes, or a theme context/provider.
2. **Generate both light and dark token usage.** For Tailwind: use `dark:bg-surface-dark` alongside `bg-surface`. For CSS variables: tokens switch automatically via the `[data-theme]` selector, so no per-component dark mode wiring is needed.
3. **Do NOT generate a theme toggle unless the user requests one.** Just ensure the component renders correctly in both themes.
4. If no dark mode tokens exist, skip this section entirely.

### Form Validation Rules

If the design includes form fields AND `preferred_libraries.validation` exists in `design-tokens.json`:

1. Generate a validation schema using the selected validation library (e.g., `zod`, `yup`, `valibot`).
2. Wire the schema to the selected form library (e.g., `react-hook-form` with `zodResolver`, `vee-validate` with `zod`).
3. Generate inline error messages below invalid fields using the project's styling conventions.
4. If no validation library is selected, add `required` HTML attributes and basic browser validation only.

### 3.X — Record Node-File Map

After all code generation is complete, record which files each IR node's code was written to. This mapping is required for file-scoping during the visual verification loop.

For each node in `component-match.json`:
1. Identify every file created or modified for this node (component file, style file, type file, test file, barrel export).
2. Look up the node's position from `layout.json` — use the region's Figma bounding box coordinates.
3. Record the mapping in the checkpoint's `node_file_map`:

```json
{
  "<nodeId>": {
    "files": ["src/components/Header.tsx", "src/components/Header.module.css"],
    "region_label": "<Figma layer name from component-match.json figma_name>",
    "figma_bbox": { "x": 0, "y": 0, "w": 1280, "h": 80 }
  }
}
```

- For inline code written directly into a page file (not a separate component), the "file" entry is the page file itself.
- For nodes that generated multiple files (component + style + types), include ALL files in the `files` array.
- The `figma_bbox` comes from the node's position in `layout.json` — use the region or child entry that contains this nodeId.
- If a node does not appear in `layout.json` (e.g., a utility component), set `figma_bbox` to `null`.

This map MUST be written before the first verification round begins. It is consumed by Step 4.3c for file-scoping.

---

## Phase 4: Visual Verification Loop

After generating the code, run this loop. **Maximum `MAX_ROUNDS` rounds** (default 4, configurable via `--max-rounds`).

### Context Management

Once code generation (Phase 3) is complete, the framework reference file and intake question answers are no longer needed for verification. Prioritize keeping in context:

1. **The Figma screenshot(s)** — the design truth
2. **The current Playwright screenshot** — what was actually rendered
3. **The diff image** — highlights exactly what differs
4. **The list of files created/modified** — to know what to fix

Design tokens are only needed if applying token-related fixes (e.g., wrong color, spacing). The full design-tokens.json can be re-read on demand rather than kept in context.

### 4.0 — Create Session Directory & Check for Resume

Before the first round, check for a previous interrupted build and create/restore the session directory.

**Step 4.0a — Check for checkpoint.**

Check if `.claude/design-tokens/.d2c-build-checkpoint.json` exists. If it does, read it and check if its `figma_url` matches the current build's Figma URL.

- **If checkpoint exists AND `figma_url` matches:** Ask the user: "A previous build was interrupted at **round {round}** with score **{score}%**. Resume from where it left off, or start fresh?"
  - **Resume:** Load the checkpoint state. Restore `D2C_TMP` to the saved `session_dir` (verify it still exists on disk — if not, fall back to start fresh). Set the current round counter to `checkpoint.round + 1`. Set `THRESHOLD` and `MAX_ROUNDS` from the checkpoint (unless the user overrode them via arguments — user arguments take precedence). **Verify `decisions.lock.json` exists in `ir_run_dir`.** If the lock file is missing (user deleted it or file is corrupt), treat as all nodes unlocked — re-run Phase 2 for all nodes and write a fresh lock before continuing. If the lock file exists, read it and proceed. Skip directly to Phase 4.1 (take a new screenshot and continue the verification loop).
  - **Start fresh:** Delete the checkpoint file and proceed normally.
- **If checkpoint exists but `figma_url` does NOT match:** Warn the user: "Found a checkpoint for a different Figma URL ({checkpoint.figma_url}). Ignoring it and starting fresh." Delete the stale checkpoint file.
- **If no checkpoint exists:** Proceed normally.

**Step 4.0b — Create session directory** (if not resuming).

```bash
D2C_TMP=$(mktemp -d "${TMPDIR:-/tmp}/d2c-XXXXXX")
```

All screenshots and diff images for this session go into `$D2C_TMP/`. This prevents collisions if multiple builds run concurrently.

**Step 4.0c — Save checkpoint after each round.**

At the END of each verification round (after scoring in 4.2), save checkpoint state to `.claude/design-tokens/.d2c-build-checkpoint.json`:

```json
{
  "figma_url": "<the Figma URL for this build>",
  "timestamp": "<ISO 8601>",
  "round": 2,
  "score": 88.1,
  "files_touched": ["src/components/Header.tsx", "src/app/dashboard/page.tsx"],
  "session_dir": "/tmp/d2c-XXXXXX",
  "ir_run_dir": ".claude/design-tokens/runs/2026-04-10T100000",
  "threshold": 95,
  "max_rounds": 4,
  "node_file_map": {
    "1:234": {
      "files": ["src/components/Header.tsx", "src/components/Header.module.css"],
      "region_label": "Header",
      "figma_bbox": { "x": 0, "y": 0, "w": 1280, "h": 80 }
    },
    "1:456": {
      "files": ["src/components/CardGrid.tsx"],
      "region_label": "CardGrid",
      "figma_bbox": { "x": 0, "y": 80, "w": 1280, "h": 600 }
    }
  },
  "round_history": [
    {
      "round": 1,
      "score": 72.3,
      "delta": null,
      "files_edited": [],
      "files_in_scope": null,
      "fixes_applied": ["Initial generation"],
      "snapshot_dir": null
    },
    {
      "round": 2,
      "score": 88.1,
      "delta": 15.8,
      "files_edited": ["src/components/Header.tsx"],
      "files_in_scope": ["src/components/Header.tsx", "src/components/Header.module.css"],
      "fixes_applied": ["Fixed header bg color to bg-surface", "Fixed header padding to spacing.lg"],
      "snapshot_dir": "/tmp/d2c-XXXXXX/snapshots/round-2"
    }
  ]
}
```

- `round`: the round number just completed (1-indexed)
- `score`: the pixel-diff match percentage from this round
- `files_touched`: cumulative list of all files created or modified during this build (deduplicated)
- `session_dir`: absolute path to `$D2C_TMP`
- `ir_run_dir`: path to the Phase 2 IR run directory (set in step 2.7). On resume, re-read the IR from this path rather than regenerating it. If `validate-ir.js` no longer exits 0 against the saved `ir_run_dir` (e.g. tokens file has changed), STOP AND ASK the user whether to regenerate IR — NEVER silently regenerate.
- `threshold` and `max_rounds`: the effective values for this build
- `node_file_map`: populated at end of Phase 3 (Step 3.X). Maps each IR nodeId to the files generated for it, a human-readable label, and the Figma bounding box coordinates. Used by Step 4.3c for file-scoping. If absent (legacy checkpoint), all `files_touched` are in scope.
- `round_history`: array of per-round state. Grows with each round. Used for regression detection (score drop > 1pp), oscillation detection (last 3 scores within 2pp range), and the build report. Each entry records the round number, score, delta from previous round, files edited, files that were in scope, human-readable fix descriptions, and snapshot directory (for revert on regression). Round 1's `files_edited` is empty (initial generation), `files_in_scope` is `null` (all files), and `snapshot_dir` is `null` (no pre-edit state to revert to).

Write the checkpoint file atomically (write to a temp file, then rename). This ensures a crash mid-write does not corrupt the checkpoint.

### 4.1 — Take a Screenshot
Use the Playwright CLI (globally installed) via Bash to capture screenshots:

```bash
npx playwright screenshot --viewport-size="1280,800" --timeout=10000 <dev-server-url> $D2C_TMP/d2c-screenshot.png
```

1. Run the command with the dev server URL and the primary viewport width.
2. If multiple viewports, run additional commands at each viewport width (e.g., `--viewport-size="768,1024"` for tablet, `--viewport-size="375,812"` for mobile).
3. Read the resulting screenshot file(s) to load them into context for comparison.

<!-- fm:P4-DEV-SERVER -->

If the dev server isn't running or Playwright can't reach the page, follow P4-DEV-SERVER in `references/failure-modes.md`.

If Figma MCP returns an error or empty response during Phase 1:
1. Retry the Figma MCP call once.
2. If it fails again, follow P1-FIGMA-UNREACHABLE in `references/failure-modes.md`.

Do NOT retry any failing tool more than once. If a tool fails twice, report the error and stop rather than burning tokens on repeated failures.

<!-- fm:P4-SCREENSHOT-MISMATCH -->

**Screenshot dimension check:** After capturing both screenshots, compare their aspect ratios. If `max(w1,w2) / min(w1,w2) > 1.5` OR `max(h1,h2) / min(h1,h2) > 1.5`, the screenshots are incomparable — follow P4-SCREENSHOT-MISMATCH in `references/failure-modes.md`. Do NOT run pixeldiff on incomparable images.

### 4.2 — Compare

**Step A: Objective pixel-diff score.**

Run a pixel-diff comparison between the Figma screenshot and the Playwright screenshot using the pixeldiff script (dependencies installed during `/d2c-init`).

**Locating pixeldiff.js:** The script ships with this skill. Resolve it by checking these locations in order (first match wins):

1. **Relative to this skill file:** `scripts/pixeldiff.js` (works for project-level installs and plugin installs)
2. **Global skills directory:** `~/.claude/skills/d2c-build/scripts/pixeldiff.js`
3. **Agent Skills directory:** `~/.agents/skills/d2c-build/scripts/pixeldiff.js`
4. **Global commands directory:** `~/.claude/commands/d2c-build/scripts/pixeldiff.js`
5. **~/.d2c-deps cache:** `~/.d2c-deps/pixeldiff.js`
6. **Glob fallback:** Search with `**/pixeldiff.js` across `~/.claude/`, `~/.agents/`, and the project root.

Store the resolved path in a variable (e.g., `PIXELDIFF_SCRIPT`) and reuse it for all rounds.

**A.1 — Capture the Figma design screenshot**

Use Figma MCP's `get_screenshot` tool to capture the target node. The screenshot is returned as image data in context.

To save it to disk for pixeldiff comparison:
- If the Figma MCP returns a **download URL**: use `curl -sS -o $D2C_TMP/figma-screenshot.png "<url>"` to download it.
- If the Figma MCP returns **base64-encoded data**: use the Bash tool to decode and write it: `echo "<base64data>" | base64 -d > $D2C_TMP/figma-screenshot.png`
- If the Figma MCP returns the image **inline in context only** (no URL or base64): use the `get_screenshot` tool with the `save_to_disk` option if available, or re-request the screenshot and pipe it to a file.

Verify the file was saved correctly: `file $D2C_TMP/figma-screenshot.png` should report "PNG image data".

The Playwright screenshot is already at `$D2C_TMP/d2c-screenshot.png`.

**Step A.2: Run the pixelmatch CLI.**

```bash
node $PIXELDIFF_SCRIPT $D2C_TMP/figma-screenshot.png $D2C_TMP/d2c-screenshot.png $D2C_TMP/figma-diff.png 0.1
```

`$PIXELDIFF_SCRIPT` is the path resolved in the "Locating pixeldiff.js" step above.

Arguments:
- Image 1: `$D2C_TMP/figma-screenshot.png` (Figma)
- Image 2: `$D2C_TMP/d2c-screenshot.png` (Playwright)
- Diff output: `$D2C_TMP/figma-diff.png` (red pixels = differences)
- Threshold: `0.1` (default sensitivity, range 0-1, lower = more sensitive)

The script handles dimension mismatches automatically by cropping to the smaller of both images.

**Step A.3: Read the CLI output.**

The CLI prints output in this format:
```
matched in: 15.123ms
different pixels: 143
error: 0.15%
```

Parse the output:
- `error` = the percentage of pixels that differ. **The match score is `100 - error`**. So `error: 0.15%` means a **99.85% match**.
- `different pixels` = the absolute count of differing pixels.
- The diff image at `$D2C_TMP/figma-diff.png` shows exactly which pixels differ (red = different). Read this image to show the user where differences are.

**Note on cross-renderer differences:** Figma's renderer and Chromium produce inherently different anti-aliasing, font rendering, and sub-pixel positioning. A pixel-diff score above 90% is considered good for cross-renderer comparison. The threshold parameter (0.1) already provides tolerance for anti-aliasing. If scores consistently plateau below 95% due to renderer differences (not actual layout/color issues), visual judgment in Step B MUST confirm correctness before the loop stops early. NEVER stop the loop on a plateau without a visual pass confirming the remaining red pixels are renderer artifacts and not real layout or color issues.

**Step A.4: If the script fails:**
1. **If pixeldiff.js was not found** at any location: warn the user: "pixeldiff.js not found. Reinstall d2c with `npx skills add d2c-ai/d2c` or `/plugin install d2c`." Fall back to visual-only comparison (Step B only).
2. **If dependencies are missing** (e.g., `Cannot find module 'pixelmatch'` or `Cannot find module 'pngjs'`), MUST attempt each approach in order (stop at first success):
   a. `npm install -g pixelmatch pngjs`
   b. `npm install --prefix ~/.d2c-deps pixelmatch pngjs` — then retry with `NODE_PATH=~/.d2c-deps/node_modules node $PIXELDIFF_SCRIPT ...`
3. Retry the script once after installing.
4. If it still fails, warn the user: "Pixel-diff scoring unavailable — falling back to visual-only comparison." Proceed with Step B only.

**Step B: Visual judgment comparison.**

Also compare the screenshots visually. The pixel-diff score is a baseline, but visual judgment catches structural issues that pixel-diff misses (e.g., correct layout with slightly different fonts still looks right).

Evaluate:

- **Layout**: Overall structure, columns, section ordering, alignment
- **Spacing**: Gaps, padding, margins between elements
- **Typography**: Font sizes, weights, line heights, hierarchy
- **Colors**: Backgrounds, text colors, borders, accents
- **Components**: Correct components used, correct appearance
- **Responsive**: Each viewport matches its respective Figma frame (if applicable)

**Step C: Scoring rules and reporting.**

- **If pixel-diff is available:** Use the pixel-diff `matchPercent` as the sole gating score for the decide step (4.4). Visual judgment is used ONLY to identify WHAT is wrong and prioritize fixes — it does NOT affect the score.
- **If pixel-diff is unavailable** (install failed): Use visual judgment as the gating score. Explicitly warn the user: "Pixel-diff is unavailable — scoring is approximate and based on visual judgment."

**Always display the score to the user after each comparison round:**

> **Round X comparison:**
> - Pixel-diff score: **99.85% match** (error: 0.15%, 143 different pixels)
> - Diff image: `$D2C_TMP/figma-diff.png`
> - Visual issues identified: [list specific issues from Step B]

If pixel-diff is unavailable, show:

> **Round X comparison (visual-only — pixelmatch not available):**
> - Visual score: **~85%** (approximate)
> - Issues identified: [list specific issues]

### 4.3 — Analyze Diff Image and Identify Fixes

**When pixel-diff is available**, read the diff image (`$D2C_TMP/figma-diff.png`) to pinpoint exactly where differences are. The diff image shows red/magenta pixels where the two screenshots differ and transparent/dark pixels where they match.

**Step 4.3a: Read the diff image and map red regions to components.**

1. Read `$D2C_TMP/figma-diff.png` to see which areas of the page have red pixels.
2. Divide the page into logical regions based on the component structure you generated:
   - **Top region** → header/navbar
   - **Upper-middle** → hero section or page title area
   - **Middle** → main content area (cards, forms, tables, etc.)
   - **Lower-middle** → secondary content
   - **Bottom** → footer
   - **Left/Right edges** → sidebars, margins
3. For each region with visible red pixels, identify which specific component/element in your generated code corresponds to that region.
4. Categorize each red region by issue type:
   - **Large red block** (solid rectangle of red) → wrong background color, missing section, or completely wrong layout
   - **Red outline/border around an element** → wrong spacing, padding, margin, or border
   - **Scattered red pixels in text areas** → wrong font size, weight, line-height, or font family
   - **Thin red lines/strips** → off-by-a-few-pixels alignment or spacing
   - **Red in image/icon areas** → missing or wrong-sized image placeholder

**Step 4.3b: Create a fix list ordered by red pixel density.**

For each identified issue, estimate how many red pixels it accounts for. Fix the issues with the most red pixels first — this maximizes the score improvement per fix.

Example fix list:
> 1. **Header background** (top 80px) — large red block → background color is `bg-white` but should be `bg-surface` → ~5,000 red pixels
> 2. **Card spacing** (middle section) — red outlines around cards → gap is `gap-4` but should be `gap-6` → ~2,000 red pixels
> 3. **Body text** (scattered red in paragraphs) → font size is `text-sm` but should be `text-base` → ~1,500 red pixels

**Step 4.3c: Determine file scope for this round.**

<!-- fm:P4-FILE-OUT-OF-SCOPE, P4-SHARED-BLAST-RADIUS -->

Based on the region analysis in Step 4.3a, determine which generated files are in scope for editing this round. File-scoping prevents retries from becoming redesign opportunities — only files responsible for failing regions may be changed.

1. For each red region identified in the diff image, find matching entries in `node_file_map` (from the checkpoint) by comparing the region's visual position to `figma_bbox` coordinates. A region matches a node if its pixel area overlaps with the node's `figma_bbox`.
2. The union of all files from matching entries is the **file scope** for this round.
3. Classify files into two categories:
   - **Component files** (mapped to specific nodes via `node_file_map`): in scope ONLY if their region has red pixels in the diff.
   - **Shared files** (globals.css, layout.tsx, theme.ts, tailwind.config.ts — files not mapped to a single node): always in scope, but edits MUST be targeted to only the specific tokens/values/classes affecting the failing region. NEVER make broad changes to shared files.
4. Log the scope determination to the user:
   > **Round N file scope:** `[Header.tsx, Header.module.css]`
   > **NOT in scope:** `[CardGrid.tsx, Footer.tsx]` (no red pixels in their regions)
5. MUST only edit files in scope. If a fix requires editing an out-of-scope file, follow P4-FILE-OUT-OF-SCOPE in `references/failure-modes.md` — STOP AND ASK before proceeding.
6. If `node_file_map` is not populated (legacy checkpoint or first build without Step 3.X), all `files_touched` are in scope and this step is a no-op.
7. Record `files_in_scope` in the current round's `round_history` entry.

**Shared component blast radius check.** Before editing a component file, check `<ir_run_dir>/component-match.json` for how many nodes chose this component:

1. Count the nodes in `component-match.json` where `chosen` matches the component being edited (by `source` path).
2. If more than one node uses this component, look up ALL those nodes' regions via `node_file_map`.
3. If any of those other regions had minimal red pixels in the diff (i.e., were previously passing), follow P4-SHARED-BLAST-RADIUS in `references/failure-modes.md` — STOP AND ASK before editing.
4. The blast radius check applies even if the file is in scope — being in scope means the file's OWN region is failing, but the edit could still regress OTHER regions that share the component.

### 4.4 — Decide and Fix

<!-- fm:P4-REGRESSION -->

**Step 4.4a — Snapshot before editing.**

Before editing ANY file in this round (round N where N >= 2), create a snapshot so edits can be reverted if they cause a regression:

1. Create directory `$D2C_TMP/snapshots/round-N/`.
2. For each file in the file scope (from Step 4.3c) that you are about to edit, copy it to `$D2C_TMP/snapshots/round-N/`. Preserve the relative path structure (e.g., `$D2C_TMP/snapshots/round-2/src/components/Header.tsx`).
3. Record `snapshot_dir` in the current round's `round_history` entry.

Round 1 has no snapshot (there is no prior state to revert to — the files were just generated in Phase 3).

Use the gating score from Step C (pixel-diff `100 - error%` if available, otherwise visual judgment):

- **Below `THRESHOLD`%** (default 95): Apply the fixes identified in Step 4.3b, starting with the highest red-pixel-density issues. MUST respect the file scope from Step 4.3c — only edit files that are in scope for this round. Make **targeted edits** to code files only — NEVER modify any file under `.claude/design-tokens/runs/<timestamp>/` except `decisions.lock.json` (to mark failed nodes). The IR is frozen for the entire retry loop (Non-negotiable rule 6). If a fix would require changing a component choice, a token reference, or a layout direction recorded in the IR, read `decisions.lock.json` and check the node's status:
  <!-- fm:P4-IR-LOCK-CONFLICT -->
  - If `status: "locked"`: Follow P4-IR-LOCK-CONFLICT in `references/failure-modes.md`. STOP AND ASK the user: "Node {nodeId} ({figma_name}, component: {componentId}) needs a different [component/token]. Unlock this node for re-decision?" If approved, update `decisions.lock.json`: set the node's `status` to `"failed"`, add `failure_reason` (describe what Phase 4 found), `failed_at` (current timestamp), and `failed_by: "phase4_pixeldiff"`. Then regenerate the IR for all nodes and write a fresh lock before continuing the loop.
  - If `status: "failed"`: The node has already been unlocked — proceed with the fix using the updated IR.

  After applying fixes, go back to 4.1 to take a new screenshot and re-run pixelmatch. Do not ask the user otherwise.

  **Step 4.4b — Regression detection (after scoring in Step 4.2 of the next round).**

  After scoring, compare the current round's score to the previous round's score in `round_history`:

  1. If `current_score < previous_score - 1.0` (allowing 1 percentage point noise margin for renderer differences): **regression detected**.
  2. Restore ALL files edited in the regressing round from the snapshot at `$D2C_TMP/snapshots/round-N/`.
  3. Log to the user: "Regression detected: score dropped from {prev}% to {current}%. Reverted round {N} edits."
  4. Follow P4-REGRESSION in `references/failure-modes.md`:
     - **Auto-recover (1 attempt):** Try a DIFFERENT fix strategy for the same issues — avoid repeating the approach that caused the regression. Take a new screenshot and score again.
     - **If the different strategy also regresses:** STOP AND ASK the user: "Score regressed from {prev}% to {current}% after fixes in round {N}. Reverted to round {N-1} state ({prev}%). Options: (1) Try a different fix approach, (2) Accept the current {prev}% score and proceed to Phase 5, (3) Re-run from Phase 2 with fresh IR."

  **Step 4.4c — Oscillation detection.**

  If round >= 3, compute the range (max - min) of the last 3 scores in `round_history`. If the range is 2.0 percentage points or less, scores are oscillating within a narrow band and further iterations are unlikely to converge. Trigger P4-PLATEAU (same handling as existing plateau detection below).

  Continue the loop automatically until either:
  - The pixel-diff score reaches **`THRESHOLD`% or above**, OR
  - **Round `MAX_ROUNDS`** is reached (default 4), OR
  <!-- fm:P4-PLATEAU -->
  - **Plateau detected**: the score improved by less than 1 percentage point from the previous round, OR oscillation is detected (last 3 scores within 2pp range). Follow P4-PLATEAU in `references/failure-modes.md` — this is a **conditional tier** failure:
    - **Score >= 80%:** Inform. Remaining differences are likely cross-renderer artifacts (anti-aliasing, font rendering, sub-pixel positioning). Report: "Score plateaued at X% (improved <1% from previous round). Remaining differences are likely renderer artifacts." Stop the loop and proceed to Phase 5.
    - **Score < 80%:** STOP AND ASK. At this level, remaining differences are likely real layout or styling issues, not renderer artifacts. Present options: continue fixing (may need IR changes), re-run from Phase 2, or accept current state.

  **Step 4.4d — Record round in history.**

  At the end of each round (after scoring, regression checks, and any fix application), append an entry to `round_history` in the checkpoint:
  ```json
  {
    "round": N,
    "score": <current score>,
    "delta": <score - previous score, or null for round 1>,
    "files_edited": ["<list of files modified in this round>"],
    "files_in_scope": ["<list from Step 4.3c, or null if all files>"],
    "fixes_applied": ["<human-readable description of each fix>"],
    "snapshot_dir": "$D2C_TMP/snapshots/round-N"
  }
  ```

- **`THRESHOLD`% or above** (default 95): Stop. Show the user:
  - The current Playwright screenshot(s)
  - The pixel-diff score (e.g., "Pixel-diff: **96.2% match** (error: 3.8%, 3,891 different pixels)")
  - The diff image path `$D2C_TMP/figma-diff.png`
  - Any remaining visible differences
  - Summary of all fixes applied across rounds

<!-- fm:P4-MAX-ROUNDS -->
- **Round `MAX_ROUNDS` reached regardless of score** (default 4): Stop. Show the user the current state, pixel-diff score, the diff image, and remaining issues. List the specific red regions that still differ and explain what would need manual adjustment.

### 4.5 — Fix Priority Order

When multiple issues have similar red pixel density, prioritize in this order:
1. Structural/layout issues (wrong grid, missing sections, incorrect ordering) — these cause the most red pixels
2. Color mismatches (wrong backgrounds, text colors) — large solid blocks of red
3. Spacing issues (wrong gaps, padding, margins) — red outlines and strips
4. Typography mismatches (font size, weight, line-height) — scattered red in text
5. Border radius, shadow, and decorative differences — small red areas
6. Fine-grained alignment and sub-pixel polish — minimal red pixels

---

## Phase 5: Code Quality Audit

After the visual verification loop ends, run a scoped audit on **only the files created or modified during this build session** (not the entire codebase). This catches code-level issues that visual verification misses.

Violations found in Phase 5 are split into two buckets:
- **Preamble violations** (bucket A and bucket C below) — violations of the Non-negotiables at the top of this file. These MUST NOT be auto-fixed silently. STOP AND ASK the user.
- **Non-preamble violations** (buckets B, D, E) — accessibility fixes, missing JSDoc, convention style. Auto-fix silently.

### 5.1 — Track files touched

Maintain a list of every file you created or modified during this build. This is your audit scope.

### 5.2 — Run these checks on each file in the audit scope:

**A. Hardcoded design values (PREAMBLE — Non-negotiable rule 3):**
- Search for raw hex colors (`#[0-9a-fA-F]{3,8}`), `rgb(`, `rgba(`, hardcoded pixel values in padding/margin/gap that MUST use design tokens.
- Convert all found colors to lowercase 6-digit hex.
- For each hardcoded value, classify it:
  - **Exact-match**: the value exactly matches a token in `design-tokens.json` → `colors` or other token scales.
  - **No-match**: the value does not correspond to any token.

**B. Accessibility violations (NON-PREAMBLE):**
- `<img` without `alt` → add `alt=""` for decorative or `alt="[descriptive text from Figma layer name]"` for informational.
- `<button` or `<a` without text content and no `aria-label` → add `aria-label` derived from the Figma layer name or component purpose.
- `<div` or `<span` with click handlers but no `role="button"` → add `role="button"` and `tabIndex={0}`.
- `<input`/`<select`/`<textarea` without associated `<label>` or `aria-label` → add `aria-label` from the Figma context.
- Heading hierarchy skips → fix by adjusting heading levels.

**C. Preferred library violations (PREAMBLE — Non-negotiable rule 2):**
- Check imports in the created files. If any import uses a non-selected library (e.g., imports `moment` when `date-fns` is selected, imports raw `fetch` when React Query is selected), record it as a preamble violation.

**D. Missing JSDoc comments (NON-PREAMBLE):**
- Every new component function/declaration MUST have a JSDoc comment. If missing, add one using the component's design-tokens.json description or the Figma context.

**E. Convention violations (NON-PREAMBLE, if `conventions` section exists in design-tokens.json):**
- Check each created file against enforced conventions (confidence > 0.6 or override = true, value ≠ "mixed"):
  - Wrong component declaration style → rewrite to match `conventions.component_declaration.value`
  - Wrong export style → rewrite to match `conventions.export_style.value`
  - Wrong type definition style → rewrite `interface` to `type` or vice versa per `conventions.type_definition.value`
  - Wrong import ordering → reorder import groups to match `conventions.import_ordering.value`
  - Missing CSS utility wrapper → wrap Tailwind class strings with the project's wrapper function per `conventions.css_utility_pattern`
  - Missing barrel export → create/update `index.ts` if `conventions.barrel_exports.value` is `"yes"`

**F. IR honor check (PREAMBLE — Non-negotiable rule 6):**
- Load `<ir_run_dir>/component-match.json`, `<ir_run_dir>/token-map.json`, and `<ir_run_dir>/decisions.lock.json`. The lock file is the enforcement artifact for IR immutability — when F1 or F2 violations are found for a node with `status: "locked"` in the lock file, the violation is a hard failure indicating the generated code diverged from the frozen plan.
- For every component import in the touched files: it MUST correspond to the `chosen` (by `source` path) of some entry in `component-match.json.nodes`, OR be a new component whose parent node has `chosen: "__NEW__"`. Any import that doesn't match is a preamble violation — record as **F1. Unauthorized component**.
- For every design value used inline in a touched file (color, spacing token, typography class, shadow class, border radius class): it MUST be referenced by at least one `token-map.json.nodes[*]` entry. Any design value not reachable from the token-map is a preamble violation — record as **F2. Unauthorized token use**.
- Do NOT auto-fix either violation. STOP AND ASK in step 5.3b.

### 5.3a — Auto-fix non-preamble violations (buckets B, D, E)

Apply fixes for buckets B, D, and E directly. Do NOT ask the user — these are deterministic corrections that enforce the project's own stylistic rules and accessibility baseline.

### 5.3b — STOP AND ASK on preamble violations (buckets A, C)

<!-- fm:P5-HARDCODED-MATCH, P5-HARDCODED-NOVEL, P5-LIBRARY-VIOLATION, P5-IR-UNAUTHORIZED-COMPONENT, P5-IR-UNAUTHORIZED-TOKEN -->

NEVER silently auto-fix a preamble violation. Preamble violations are structural failures of the build — the generated code violated a non-negotiable rule, and silently rewriting it hides the failure from the user. For exact prompt templates, see the corresponding entries in `references/failure-modes.md`.

For **bucket A (hardcoded design values)**:
- If the violation is **exact-match** (value maps cleanly to an existing token), STOP AND ASK: "Found N hardcoded values that exactly match existing tokens. These look like accidental inline values. Apply the token replacement? [y/N/list-per-file]"
- If the violation is **no-match** (value has no existing token), STOP AND ASK: "Found N hardcoded values with no matching token: [list file:line value]. Options: (1) add these as new tokens to design-tokens.json, (2) replace with the closest existing token, (3) leave as-is. Which?" NEVER guess a "closest" token on the user's behalf.

For **bucket C (preferred library violations)**:
- STOP AND ASK: "Found N imports of non-selected libraries: [list file:line import]. These violate Non-negotiable rule 2 (preferred_libraries selection). Options: (1) rewrite to use the selected library [selected], (2) update preferred_libraries to add this as a selected alternative, (3) leave as-is. Which?" NEVER silently substitute.

For **bucket F (IR honor violations — Non-negotiable rule 6)**:
- **F1. Unauthorized component:** STOP AND ASK: "Phase 3 imported a component that was NOT in `component-match.json.chosen`: [list file:line import]. The IR was frozen at Phase 2 — this indicates codegen ignored the plan. Options: (1) regenerate the IR and re-run `/d2c-build`, (2) update `component-match.json` manually to add this component and re-run validate-ir, then re-run /d2c-build. Which?" NEVER rewrite the import silently.
- **F2. Unauthorized token use:** STOP AND ASK: "Phase 3 used a design value not in `token-map.json`: [list file:line value]. Options: (1) regenerate the IR and re-run `/d2c-build`, (2) add the missing token entry manually and re-run validate-ir, then re-run /d2c-build. Which?" NEVER guess a fix.

Wait for the user's answer before applying any preamble fix. Do NOT loop, do NOT retry — one STOP AND ASK per bucket per Phase 5 run.

### 5.4 — Report

After both 5.3a (auto-fix) and 5.3b (STOP AND ASK) complete, report the full summary:

> **Code quality audit (X files scanned):**
>
> **Non-preamble fixes applied automatically:**
> - Fixed Z accessibility issues (N missing alt, M missing aria-label, ...)
> - Added V JSDoc comments
> - Fixed U convention violations (list specifics)
>
> **Preamble violations (required user decision):**
> - Hardcoded design values: Y found, K resolved by user
> - Preferred library violations: W found, L resolved by user
>
> **Preamble compliance: [PASS | FAIL]** — FAIL if any preamble violation was left unresolved at user's direction.

If zero issues were found in any bucket, report: "Code quality audit: all clean. 0 preamble violations."

### 5.5 — Cascade detection

<!-- fm:PX-CASCADE -->

After Phase 5 completes, check for a cascade failure: if Phase 4 exited with a final score **below** `THRESHOLD` (default 95%) AND Phase 5 found **one or more preamble violations** (bucket A exact-match, bucket C, or bucket F), this combination suggests the IR planning phase made marginal choices that cascaded into both visual and code quality issues.

Follow PX-CASCADE in `references/failure-modes.md` — STOP AND ASK with options: re-run from Phase 2 (recommended), accept current output, or re-run with `/d2c-init --force` first.

---

## Phase 6: Finalize

After the audit:

0. **Delete the checkpoint file.** Remove `.claude/design-tokens/.d2c-build-checkpoint.json` if it exists. The build completed successfully — no resume needed.
1. Ensure all new components are properly exported and TypeScript types are correct.
2. **Display the Build Report.** Output the following 3 tables as the build summary. Use the exact table formats below, filling in actual values from this build.

   **Table 1 — Build Summary**

   ```
   | Field            | Value                              |
   |------------------|------------------------------------|
   | Component        | <component_name from intake>       |
   | Complexity       | <Simple / Medium / Complex>        |
   | Framework        | <framework + meta_framework>       |
   | Final Score      | <final pixel-diff match %>         |
   | Threshold        | <THRESHOLD value>%                 |
   | Rounds Used      | <rounds_completed> / <MAX_ROUNDS> max |
   | Files Created    | <count>                            |
   | Files Modified   | <count>                            |
   | Plateau Detected | <Yes / No>                         |
   ```

   **Table 2 — Round-by-Round Progression**

   One row per verification round. Delta = score difference from the previous round. Round 1 delta is always "—". Scope shows which files were in scope for editing (from Step 4.3c file-scoping). Round 1 scope is "all" (initial generation). Populate from `round_history` in the checkpoint.

   ```
   | Round | Score  | Delta  | Scope                              | Fixes Applied                        |
   |-------|--------|--------|------------------------------------|--------------------------------------|
   | 1     | 72.3%  | —      | all                                | Initial generation                   |
   | 2     | 88.1%  | +15.8% | Header.tsx, Header.module.css      | Fixed header bg color, card spacing  |
   | 3     | 96.2%  | +8.1%  | CardGrid.tsx                       | Fixed font sizes, button padding     |
   ```

   **Table 3 — Build Efficiency**

   Proxy metrics for what the build consumed and produced. Compute each value as follows:
   - **Components Reused** — count of existing components from `design-tokens.json` that were imported/used in the generated code.
   - **Components Created** — count of new component files created during the build.
   - **Design Tokens Used** — count of distinct design token references (colors, spacing, typography, shadows, borders) used in the generated code. Count unique token keys referenced, not total occurrences.
   - **Lines Generated** — total lines of code across all newly created files.
   - **Audit Issues Fixed** — total count of issues fixed in Phase 5 (hardcoded values, a11y, library imports, conventions). 0 if audit was clean.

   ```
   | Metric              | Count |
   |---------------------|-------|
   | Components Reused   | 3     |
   | Components Created  | 1     |
   | Design Tokens Used  | 12    |
   | Lines Generated     | 187   |
   | Audit Issues Fixed  | 4     |
   ```

   **Table 4 — IR Summary**

   Reads from the four artifacts in `<ir_run_dir>/`:
   - **Nodes** — number of entries in `component-match.json.nodes`.
   - **Token refs** — total number of token references in `token-map.json` (sum across all nodes) plus `layout.json` gap references.
   - **Deferred regions** — length of `layout.json.deferred` (should be 0 for a successful build).
   - **Validator status** — the final `validate-ir: <status>` line from Phase 2. Always `ok` if the build reached Phase 6.
   - **Run dir** — path to `<ir_run_dir>`, for inspection.

   ```
   | Field            | Value                                              |
   |------------------|----------------------------------------------------|
   | Nodes            | 17                                                 |
   | Token refs       | 42                                                 |
   | Deferred regions | 0                                                  |
   | Validator status | ok                                                 |
   | Run dir          | .claude/design-tokens/runs/2026-04-10T100000       |
   ```

   **Table 5 — Decision Lock Summary**

   Reads from `<ir_run_dir>/decisions.lock.json`:
   - **Nodes locked** — count of entries with `status: "locked"`.
   - **Nodes failed** — count of entries with `status: "failed"`.
   - **Nodes re-decided** — count of nodes that were failed and then re-locked during this build (had their IR regenerated).
   - **Lock file** — path to `decisions.lock.json`.

   ```
   | Field              | Value                                                        |
   |--------------------|--------------------------------------------------------------|
   | Nodes locked       | 16                                                           |
   | Nodes failed       | 1                                                            |
   | Nodes re-decided   | 1                                                            |
   | Lock file          | .claude/design-tokens/runs/2026-04-10T100000/decisions.lock.json |
   ```

   **After the tables:** List all files created or modified with their full paths. If there are remaining known differences from the Figma design, note them with the diff image reference.
3. **Auto-update design tokens if needed.** If new reusable components, hooks, or API patterns were created during this build:

   <!-- fm:P6-TOKENS-WRITE-CONFLICT -->

   **Pre-write check:** Before modifying `design-tokens.json`, compute its current SHA-256 hash and compare against `run-manifest.json.tokens_file_hash`. If they differ, the file was modified during this build — follow P6-TOKENS-WRITE-CONFLICT in `references/failure-modes.md` (skip auto-update, report what would have been added).

   If hashes match, proceed:
   - Read the current `.claude/design-tokens/design-tokens.json`
   - Add new components to the `components` array (with name, path, description, props)
   - Add new hooks to the `hooks` array (with name, path, description)
   - Update the `api` section if new API patterns were introduced
   - Write the updated file back
   - Tell the user: **"Updated `.claude/design-tokens/design-tokens.json` with X new components / Y new hooks."** List what was added so they can verify.
4. **Append build metrics.** After the build completes, record build statistics to `.claude/design-tokens/build-stats.json` for local tracking.

   **Steps:**
   1. Check if `.claude/design-tokens/build-stats.json` exists. If not, create it with an empty JSON array: `[]`.
   2. If it exists, read it and parse the JSON array.
   3. Construct a new entry object:
      ```json
      {
        "date": "<ISO 8601 timestamp>",
        "framework": "<from design-tokens.json>",
        "meta_framework": "<from design-tokens.json>",
        "figma_url": "<the Figma URL used for this build>",
        "component_name": "<from intake question 1 — what the user said this is>",
        "complexity_tier": "<Simple | Medium | Complex>",
        "rounds_completed": "<number of verification rounds run>",
        "final_score": "<final pixel-diff match percentage, e.g. 96.2>",
        "files_created": "<count of new files created>",
        "files_modified": "<count of existing files modified>",
        "threshold_used": "<the THRESHOLD value used for this build>",
        "max_rounds_used": "<the MAX_ROUNDS value used for this build>",
        "score_progression": ["<array of match % scores from each round, e.g. [72.1, 85.4, 96.2]>"],
        "plateau_detected": "<boolean — true if the last 2+ rounds had score changes < 0.5%>",
        "components_reused": "<count of existing components reused>",
        "components_created": "<count of new component files created>",
        "design_tokens_used": "<count of distinct design token references in generated code>",
        "lines_generated": "<total lines of code across all created files>",
        "audit_issues_fixed": "<count of issues fixed in Phase 5>"
      }
      ```
   4. Push the new entry onto the array and write the file back.
   5. Do NOT report the metrics to the user unless they ask. This is silent bookkeeping.

   > **Note:** Build metrics are stored locally and never transmitted. They help you track iteration patterns and identify which component types need more rounds.

---

## Critical Reminders

- **NEVER discard the Figma screenshots from context.** They are required for every comparison round. If the session is resuming from a checkpoint and the screenshots are not in context, MUST re-fetch them via Figma MCP before continuing the comparison loop.
- **Always read `.claude/design-tokens/design-tokens.json` before generating code.** Non-negotiable.
- **Reuse over recreate.** Check existing components first. Always.
- **Targeted fixes, not rewrites.** Each iteration changes as little as possible.
- **Match the project's conventions.** Styling approach, file structure, naming patterns — match what's already there.