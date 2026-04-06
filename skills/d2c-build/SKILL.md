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

Store these as `THRESHOLD` and `MAX_ROUNDS` variables for use in Phase 3. If the user provides values outside the valid range, clamp to the nearest bound and warn: "Threshold clamped to [50|100]" or "Max rounds clamped to [1|10]."

---

## Pre-flight Check

Before anything else:
1. Check that `.claude/design-tokens/design-tokens.json` exists. If it doesn't, tell the user to run `/d2c-init` first and stop.
2. **Schema validation:** Validate `.claude/design-tokens/design-tokens.json` against the JSON Schema at `references/design-tokens.schema.json` (relative to this SKILL.md, or search with Glob for `**/design-tokens.schema.json`). If validation fails, warn the user with the specific validation errors and ask: "design-tokens.json has schema errors. Run `/d2c-init --force` to regenerate, or continue anyway?" If the schema file is not found, skip validation silently.
3. **Schema version check:** Read the `d2c_schema_version` field. If it is missing or less than 1 (the current version), warn the user: "design-tokens.json uses schema version {version or 'none'} but the current version is 1. Run `/d2c-init --force` to regenerate." Allow the user to continue or abort.
4. **Load design tokens using the phased loading strategy below.** Do NOT read the entire file into context at once — load only the sections needed for the current phase.

### Token Loading Strategy

To minimize context usage, load only the sections of `design-tokens.json` relevant to each phase:

- **Phase 1 (Gather Inputs):** Load `framework`, `meta_framework`, `component_file_extension`, `styling_approach`, `components` (for reuse suggestions), `preferred_libraries` (for library check), `conventions`.
- **Phase 2 (Generate Code):** Load `colors`, `spacing`, `typography`, `breakpoints`, `shadows`, `borders`, `conventions`, `preferred_libraries`, `api`, `components` (for reuse), `hooks`.
- **Phase 3 (Visual Verification):** No additional token sections needed — only the files list and screenshots are used.
- **Phase 4 (Code Quality Audit):** Load `colors`, `spacing`, `typography`, `shadows`, `borders` (for hardcoded value check), `preferred_libraries`, `conventions`, `components`.
- **Phase 5 (Finalize):** Load `components`, `hooks`, `api` (for updating the file with new entries).

At the start of each phase, read only the listed sections from the file. If a section was already loaded in a previous phase and is still in context, do not re-read it. This approach keeps context lean for large projects where the full file exceeds 8K tokens.

#### Split File Loading (when `split_files: true`)

If the `split_files` field is `true` in `design-tokens.json`, load the focused split files instead of parsing sections from the monolithic file:

- **Phase 1 (Gather Inputs):** Read `tokens-core.json` + `tokens-components.json` + `tokens-conventions.json`
- **Phase 2 (Generate Code):** Read `tokens-colors.json` + `tokens-core.json` + `tokens-conventions.json` + `tokens-components.json`
- **Phase 3 (Visual Verification):** No token files needed.
- **Phase 4 (Code Quality Audit):** Read `tokens-colors.json` + `tokens-conventions.json` + `tokens-components.json`
- **Phase 5 (Finalize):** Read `tokens-components.json` + `tokens-core.json`

Each split file is a standalone JSON object — read it directly with `Read`, no section parsing needed. If a split file is missing, fall back to reading that section from the monolithic `design-tokens.json`.

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
   - Search with Glob for `**/framework-{framework}.md` in the skill install directories
   - If neither resolves, proceed without a reference file (step 4 applies).
3. All code generation in Phase 2 MUST follow both the universal rules in this SKILL.md AND the framework-specific rules in the loaded reference file. The reference file takes precedence for framework-specific syntax (file extensions, class vs className, props syntax, etc.).
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

## Design System Rules — Enforced at All Times

These rules apply to ALL code generated or modified during this build. No exceptions.

- All colors, spacing, font sizes, shadows, and border radii must come from `.claude/design-tokens/design-tokens.json`. Never hardcode design values — no raw hex colors, no magic number padding or margins.
- Use the project's styling approach as specified in `styling_approach`.
- Check the `components` section before creating any new component — reuse what exists.
- **Always use the user's preferred libraries.** Check `preferred_libraries` in `design-tokens.json` for every capability: data fetching, dates, forms, validation, icons, animation, charts, etc. Use the `selected` library for each category. Never use an alternative that is `installed` but not `selected` — the user explicitly chose which to use for new code.
- If a UI pattern appears 2+ times in the design, extract it into a reusable component. A pattern is "repeated" if 2+ elements share the same HTML structure (same nesting, same tag types) AND the same visual styling (same colors, spacing, border treatment). Different text content does not make a pattern different. New components must be props-driven with no hardcoded content.
- **SOLID**: One component = one job. Extend via props, not source modification. Don't bloat props. Depend on props and hooks, not concrete implementations.
- **DRY**: Shared logic → custom hooks. Shared layout → layout components. Shared styles → design tokens. No copy-paste between components.

---

## Phase 1: Gather Inputs

### 1.1 — Get the Figma URL
Ask the user for the Figma Dev Mode URL for the design. This is required.

If the user provided a URL with their initial prompt (e.g., `/d2c:build https://www.figma.com/design/...`), use that — captured in $ARGUMENTS.

### 1.1b — Dry Run Check
If the user includes "dry run" in their prompt or $ARGUMENTS, complete Phases 1 and 2 but do NOT write any files. Instead, present the plan: which files would be created/modified, which existing components would be reused, and the code structure. Ask the user to confirm before proceeding to write files and run the verification loop.

### 1.2 — Standard Intake Questions

#### 1.2a — Complexity Classification

After loading the Figma design context (from step 1.4, or if the Figma URL was provided upfront), classify the component's complexity BEFORE asking intake questions. This determines which questions to skip.

**Classification rules:**

- **Simple** (skip questions 4 and 6): The design is a single UI element — button, badge, icon, avatar, chip, tag, toggle, tooltip, divider, separator, progress bar, skeleton, spinner. **Detection:** the Figma node name or top-level layer name (case-insensitive) contains one of these keywords AND the total layer count in the Figma design context is 20 or fewer.
- **Medium** (skip question 6 only): Cards, inputs, selects, dropdowns, modals, dialogs, alerts, toasts, navigation items, tabs, breadcrumbs, list items. **Detection:** Figma node name matches one of these keywords (case-insensitive) AND total layer count is 50 or fewer.
- **Complex** (ask all 6 questions): Pages, dashboards, forms, tables, layouts, sidebars, or any design with layer count > 50, or any design that does not match Simple or Medium keywords.

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

**If a library is installed → use it.** Never rebuild from scratch what a project dependency already provides. If multiple are installed, ask the user which to prefer (same format as init Step 5e).

**Step 4: If no matching library is installed**, present the user with 2-3 options and a recommendation:

> "The design includes [charts/maps/etc.] but no library is installed for this. Here are the options:
> 1. **[Library A]** — [one-line why]. **(Recommended)**
> 2. **[Library B]** — [one-line why].
> 3. **Build from scratch** — Only if the requirement is simple enough.
>
> Which would you like?"

Always recommend the option that best fits the project's existing stack and complexity. Wait for the user's choice before proceeding. Install the chosen library before generating code. **After the user chooses, update `preferred_libraries` in `.claude/design-tokens/design-tokens.json`** with the new category and selection so future builds don't ask again.

---

## Phase 2: Generate Code

### Code Principles

Follow the Design System Rules defined above (reusability, preferred libraries, SOLID, DRY). Additionally:
- Before creating ANY new component, check `design-tokens.json` → `components`. If an existing component can do the job, USE IT.
- If a pattern appears 2+ times in the design (same HTML structure + same visual styling = repeated pattern; different text content does not make it different), extract it into a new reusable component.
- New components must be props-driven and composable. No hardcoded content — pass it through props.

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
- **Strict one-component-per-file rule**: Each component gets its own file. The only exception is a sub-component that is 15 lines or fewer — it may stay in the parent file. Anything over 15 lines must be extracted to a separate file, imported, and used.
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
   - The root `<html>` element should have a `lang` attribute
   - Every new component must have a JSDoc comment above the function/component declaration: `/** Brief description. @param props.propName - Description */`
5. **Image handling:** If Figma MCP is available, use `get_screenshot` to export individual image/icon nodes from the Figma design and save them to the project's asset directory (e.g., `public/images/`). If export is not possible, use placeholder `src` values with a comment: `{/* Figma asset: [node name] */}`. For icons, prefer the project's icon library from `preferred_libraries.icons`.
6. **Client/server boundary rule:** Follow the framework reference file's client/server boundary rules. Each framework handles this differently. Do NOT apply React's `"use client"` rule to non-React frameworks. **Inline fallback for React/Next.js (if reference file unavailable):** Add `"use client"` ONLY if the component uses: `useState`, `useEffect`, `useReducer`, `useContext`, `useRef` with DOM access, event handlers (`onClick`, `onChange`, `onSubmit`), browser APIs (`window`, `document`, `localStorage`), or third-party client hooks. All other components default to Server Components.
7. Focus on the default/resting visual state. Add subtle transitions on interactive elements by default: `transition-colors duration-150` (or equivalent) on buttons, links, and clickable cards. Add `hover:opacity-80` or a framework-appropriate hover state for buttons. Do NOT implement complex animations, active states, or loading animations unless the user explicitly requests them or the Figma design includes them as separate frames.
8. **Tailwind class selection rule (if Tailwind):** Always use the shortest Tailwind class that achieves the exact value. Prefer scale classes (`p-4`) over arbitrary values (`p-[16px]`). For values not in the Tailwind scale, use arbitrary values. Never use longhand (`px-4 py-4`) when shorthand (`p-4`) achieves the same result. For colors, always use the semantic token class (`bg-primary`) over the raw color class (`bg-blue-500`) if a semantic token exists. **Use the framework's class attribute name** — `className` for React/Solid (JSX), `class` for Vue/Svelte/Angular/Astro/Qwik. Check the framework reference file.

### API Integration Rules

If the user selected "Yes" for API connections in question 6 and `preferred_libraries.data_fetching` exists in `design-tokens.json`, follow these rules:

1. **Use the selected data fetching library.** Check `preferred_libraries.data_fetching.selected` and use that library. The framework reference file specifies the correct API/import pattern for each library in this framework (e.g., `useQuery` for React Query, `useFetch` for Nuxt, `createResource` for Solid, `inject(HttpClient)` for Angular). Never use a different fetching library than what's selected.

2. **Match the project's API file structure.** If the project has API calls in `services/`, `api/`, or `lib/`, put new API calls in the same location following the same naming convention.

3. **Generate typed API functions for each call the user described.**
   - If the user provided a sample response JSON, generate TypeScript interfaces/types from it.
   - If no sample was provided, generate reasonable types based on the design's data needs with `// TODO: Replace with actual API response type` comments.
   - Name the types descriptively (e.g., `UserProfileResponse`, `NotificationItem`, `ActivityFeedEntry`).

4. **Wire up components to API calls.**
   - Components should consume data from the API hooks/functions, not hardcoded values.
   - Use the project's established loading state pattern (from `api.loading_pattern` in tokens).
   - Use the project's established error handling pattern (from `api.error_handling` in tokens).
   - The generated code should work end-to-end — when the user plugs in a real API endpoint, the component renders real data without structural changes.

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
2. **Generate both light and dark token usage.** For Tailwind: use `dark:bg-surface-dark` alongside `bg-surface`. For CSS variables: tokens should already switch via the `[data-theme]` selector.
3. **Do NOT generate a theme toggle unless the user requests one.** Just ensure the component renders correctly in both themes.
4. If no dark mode tokens exist, skip this section entirely.

### Form Validation Rules

If the design includes form fields AND `preferred_libraries.validation` exists in `design-tokens.json`:

1. Generate a validation schema using the selected validation library (e.g., `zod`, `yup`, `valibot`).
2. Wire the schema to the selected form library (e.g., `react-hook-form` with `zodResolver`, `vee-validate` with `zod`).
3. Generate inline error messages below invalid fields using the project's styling conventions.
4. If no validation library is selected, add `required` HTML attributes and basic browser validation only.

---

## Phase 3: Visual Verification Loop

After generating the code, run this loop. **Maximum `MAX_ROUNDS` rounds** (default 4, configurable via `--max-rounds`).

### Context Management

Once code generation (Phase 2) is complete, the framework reference file and intake question answers are no longer needed for verification. Prioritize keeping in context:

1. **The Figma screenshot(s)** — the design truth
2. **The current Playwright screenshot** — what was actually rendered
3. **The diff image** — highlights exactly what differs
4. **The list of files created/modified** — to know what to fix

Design tokens are only needed if applying token-related fixes (e.g., wrong color, spacing). The full design-tokens.json can be re-read on demand rather than kept in context.

### 3.0 — Create Session Directory & Check for Resume

Before the first round, check for a previous interrupted build and create/restore the session directory.

**Step 3.0a — Check for checkpoint.**

Check if `.claude/design-tokens/.d2c-build-checkpoint.json` exists. If it does, read it and check if its `figma_url` matches the current build's Figma URL.

- **If checkpoint exists AND `figma_url` matches:** Ask the user: "A previous build was interrupted at **round {round}** with score **{score}%**. Resume from where it left off, or start fresh?"
  - **Resume:** Load the checkpoint state. Restore `D2C_TMP` to the saved `session_dir` (verify it still exists on disk — if not, fall back to start fresh). Set the current round counter to `checkpoint.round + 1`. Set `THRESHOLD` and `MAX_ROUNDS` from the checkpoint (unless the user overrode them via arguments — user arguments take precedence). Skip directly to Phase 3.1 (take a new screenshot and continue the verification loop).
  - **Start fresh:** Delete the checkpoint file and proceed normally.
- **If checkpoint exists but `figma_url` does NOT match:** Warn the user: "Found a checkpoint for a different Figma URL ({checkpoint.figma_url}). Ignoring it and starting fresh." Delete the stale checkpoint file.
- **If no checkpoint exists:** Proceed normally.

**Step 3.0b — Create session directory** (if not resuming).

```bash
D2C_TMP=$(mktemp -d "${TMPDIR:-/tmp}/d2c-XXXXXX")
```

All screenshots and diff images for this session go into `$D2C_TMP/`. This prevents collisions if multiple builds run concurrently.

**Step 3.0c — Save checkpoint after each round.**

At the END of each verification round (after scoring in 3.2), save checkpoint state to `.claude/design-tokens/.d2c-build-checkpoint.json`:

```json
{
  "figma_url": "<the Figma URL for this build>",
  "timestamp": "<ISO 8601>",
  "round": 2,
  "score": 88.1,
  "files_touched": ["src/components/Header.tsx", "src/app/dashboard/page.tsx"],
  "session_dir": "/tmp/d2c-XXXXXX",
  "threshold": 95,
  "max_rounds": 4
}
```

- `round`: the round number just completed (1-indexed)
- `score`: the pixel-diff match percentage from this round
- `files_touched`: cumulative list of all files created or modified during this build (deduplicated)
- `session_dir`: absolute path to `$D2C_TMP`
- `threshold` and `max_rounds`: the effective values for this build

Write the checkpoint file atomically (write to a temp file, then rename). This ensures a crash mid-write does not corrupt the checkpoint.

### 3.1 — Take a Screenshot
Use the Playwright CLI (globally installed) via Bash to capture screenshots:

```bash
npx playwright screenshot --viewport-size="1280,800" --timeout=10000 <dev-server-url> $D2C_TMP/d2c-screenshot.png
```

1. Run the command with the dev server URL and the primary viewport width.
2. If multiple viewports, run additional commands at each viewport width (e.g., `--viewport-size="768,1024"` for tablet, `--viewport-size="375,812"` for mobile).
3. Read the resulting screenshot file(s) to load them into context for comparison.

If the dev server isn't running or Playwright can't reach the page:
1. Tell the user to start their dev server and provide the local URL.
2. Wait for confirmation, then retry once.

If Figma MCP returns an error or empty response during Phase 1:
1. Retry the Figma MCP call once.
2. If it fails again, tell the user: "Figma MCP couldn't fetch the design. Check that the URL is a valid Figma Dev Mode link and that Figma MCP is connected." Stop.

Do NOT retry any failing tool more than once. If a tool fails twice, report the error and stop rather than burning tokens on repeated failures.

### 3.2 — Compare

**Step A: Objective pixel-diff score.**

Run a pixel-diff comparison between the Figma screenshot and the Playwright screenshot using the pixeldiff script (shipped with this skill at `scripts/pixeldiff.js`, dependencies installed during `/d2c-init`).

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
node skills/d2c-build/scripts/pixeldiff.js $D2C_TMP/figma-screenshot.png $D2C_TMP/d2c-screenshot.png $D2C_TMP/figma-diff.png 0.1
```

If the script is not found at `skills/d2c-build/scripts/pixeldiff.js`, search for it with Glob: `**/pixeldiff.js`.

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

**Note on cross-renderer differences:** Figma's renderer and Chromium produce inherently different anti-aliasing, font rendering, and sub-pixel positioning. A pixel-diff score above 90% is considered good for cross-renderer comparison. The threshold parameter (0.1) already provides tolerance for anti-aliasing. If scores consistently plateau below 95% due to renderer differences (not actual layout/color issues), visual judgment in Step B should confirm correctness and the loop may stop early.

**Step A.4: If the script fails:**
1. If dependencies are missing, try each approach in order (stop at first success):
   a. `npm install -g pixelmatch pngjs`
   b. `npm install --prefix ~/.d2c-deps pixelmatch pngjs` — then retry with `NODE_PATH=~/.d2c-deps/node_modules node <pixeldiff.js path> ...`
2. Retry the script once after installing.
3. If it still fails, warn the user: "Pixel-diff scoring unavailable — falling back to visual-only comparison." Proceed with Step B only.

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

- **If pixel-diff is available:** Use the pixel-diff `matchPercent` as the sole gating score for the decide step (3.3). Visual judgment is used ONLY to identify WHAT is wrong and prioritize fixes — it does NOT affect the score.
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

### 3.3 — Analyze Diff Image and Identify Fixes

**When pixel-diff is available**, read the diff image (`$D2C_TMP/figma-diff.png`) to pinpoint exactly where differences are. The diff image shows red/magenta pixels where the two screenshots differ and transparent/dark pixels where they match.

**Step 3.3a: Read the diff image and map red regions to components.**

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

**Step 3.3b: Create a fix list ordered by red pixel density.**

For each identified issue, estimate how many red pixels it accounts for. Fix the issues with the most red pixels first — this maximizes the score improvement per fix.

Example fix list:
> 1. **Header background** (top 80px) — large red block → background color is `bg-white` but should be `bg-surface` → ~5,000 red pixels
> 2. **Card spacing** (middle section) — red outlines around cards → gap is `gap-4` but should be `gap-6` → ~2,000 red pixels
> 3. **Body text** (scattered red in paragraphs) → font size is `text-sm` but should be `text-base` → ~1,500 red pixels

### 3.4 — Decide and Fix

Use the gating score from Step C (pixel-diff `100 - error%` if available, otherwise visual judgment):

- **Below `THRESHOLD`%** (default 95): Apply the fixes identified in Step 3.3b, starting with the highest red-pixel-density issues. Make targeted edits — do NOT rewrite entire components. After applying fixes, go back to 3.1 to take a new screenshot and re-run pixelmatch. Do not ask the user. Continue this loop automatically until either:
  - The pixel-diff score reaches **`THRESHOLD`% or above**, OR
  - **Round `MAX_ROUNDS`** is reached (default 4), OR
  - **Plateau detected**: the score improved by less than 1 percentage point from the previous round. This indicates remaining differences are cross-renderer artifacts (anti-aliasing, font rendering, sub-pixel positioning) that cannot be fixed by code changes. Report: "Score plateaued at X% (improved <1% from previous round). Remaining differences are likely renderer artifacts." Stop the loop and proceed to Phase 4.

- **`THRESHOLD`% or above** (default 95): Stop. Show the user:
  - The current Playwright screenshot(s)
  - The pixel-diff score (e.g., "Pixel-diff: **96.2% match** (error: 3.8%, 3,891 different pixels)")
  - The diff image path `$D2C_TMP/figma-diff.png`
  - Any remaining visible differences
  - Summary of all fixes applied across rounds

- **Round `MAX_ROUNDS` reached regardless of score** (default 4): Stop. Show the user the current state, pixel-diff score, the diff image, and remaining issues. List the specific red regions that still differ and explain what would need manual adjustment.

### 3.5 — Fix Priority Order

When multiple issues have similar red pixel density, prioritize in this order:
1. Structural/layout issues (wrong grid, missing sections, incorrect ordering) — these cause the most red pixels
2. Color mismatches (wrong backgrounds, text colors) — large solid blocks of red
3. Spacing issues (wrong gaps, padding, margins) — red outlines and strips
4. Typography mismatches (font size, weight, line-height) — scattered red in text
5. Border radius, shadow, and decorative differences — small red areas
6. Fine-grained alignment and sub-pixel polish — minimal red pixels

---

## Phase 4: Code Quality Audit & Auto-Fix

After the visual verification loop ends, run a scoped audit on **only the files created or modified during this build session** (not the entire codebase). This catches code-level issues that visual verification misses.

### 4.1 — Track files touched

Maintain a list of every file you created or modified during this build. This is your audit scope.

### 4.2 — Run these checks on each file in the audit scope:

**A. Hardcoded design values:**
- Search for raw hex colors (`#[0-9a-fA-F]{3,8}`), `rgb(`, `rgba(`, hardcoded pixel values in padding/margin/gap that should use design tokens.
- Convert all found colors to lowercase 6-digit hex. If the value exactly matches a token in `design-tokens.json` → `colors`, replace it with the token reference (Tailwind class, CSS variable, or theme value per the project's styling approach).

**B. Accessibility violations:**
- `<img` without `alt` → add `alt=""` for decorative or `alt="[descriptive text from Figma layer name]"` for informational.
- `<button` or `<a` without text content and no `aria-label` → add `aria-label` derived from the Figma layer name or component purpose.
- `<div` or `<span` with click handlers but no `role="button"` → add `role="button"` and `tabIndex={0}`.
- `<input`/`<select`/`<textarea` without associated `<label>` or `aria-label` → add `aria-label` from the Figma context.
- Heading hierarchy skips → fix by adjusting heading levels.

**C. Preferred library violations:**
- Check imports in the created files. If any import uses a non-selected library (e.g., imports `moment` when `date-fns` is selected, imports raw `fetch` when React Query is selected), replace with the selected library's API.

**D. Missing JSDoc comments:**
- Every new component function/declaration must have a JSDoc comment. If missing, add one using the component's design-tokens.json description or the Figma context.

**E. Convention violations (if `conventions` section exists in design-tokens.json):**
- Check each created file against enforced conventions (confidence > 0.6 or override = true, value ≠ "mixed"):
  - Wrong component declaration style → rewrite to match `conventions.component_declaration.value`
  - Wrong export style → rewrite to match `conventions.export_style.value`
  - Wrong type definition style → rewrite `interface` to `type` or vice versa per `conventions.type_definition.value`
  - Wrong import ordering → reorder import groups to match `conventions.import_ordering.value`
  - Missing CSS utility wrapper → wrap Tailwind class strings with the project's wrapper function per `conventions.css_utility_pattern`
  - Missing barrel export → create/update `index.ts` if `conventions.barrel_exports.value` is `"yes"`

### 4.3 — Auto-fix all found issues

Apply all fixes directly. Do NOT ask the user — these are deterministic corrections that enforce the project's own rules. After fixing, report what was fixed:

> **Code quality audit (X files scanned):**
> - Fixed Y hardcoded values → replaced with design tokens
> - Fixed Z accessibility issues (N missing alt, M missing aria-label, ...)
> - Fixed W library imports → replaced with preferred libraries
> - Added V JSDoc comments
> - Fixed U convention violations (list specifics)

If zero issues were found, report: "Code quality audit: all clean."

---

## Phase 5: Finalize

After the audit:

0. **Delete the checkpoint file.** Remove `.claude/design-tokens/.d2c-build-checkpoint.json` if it exists. The build completed successfully — no resume needed.
1. Ensure all new components are properly exported and TypeScript types are correct.
2. Summarize what was built:
   - Files created or modified (with paths)
   - New reusable components introduced
   - Existing components reused from the project
   - **Score progression across rounds** (e.g., "Round 1: 72.3% → Round 2: 88.1% → Round 3: 95.4%")
   - **Fixes applied per round** (e.g., "Round 1: fixed header bg color, card spacing. Round 2: fixed font sizes, button padding.")
   - Final match score
   - Any remaining known differences from the Figma (with diff image reference)
3. **Auto-update design tokens if needed.** If new reusable components, hooks, or API patterns were created during this build:
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
        "plateau_detected": "<boolean — true if the last 2+ rounds had score changes < 0.5%>"
      }
      ```
   4. Push the new entry onto the array and write the file back.
   5. Do NOT report the metrics to the user unless they ask. This is silent bookkeeping.

   > **Note:** Build metrics are stored locally and never transmitted. They help you track iteration patterns and identify which component types need more rounds.

---

## Critical Reminders

- **Never lose the Figma screenshots from context.** You need them for every comparison round.
- **Always read `.claude/design-tokens/design-tokens.json` before generating code.** Non-negotiable.
- **Reuse over recreate.** Check existing components first. Always.
- **Targeted fixes, not rewrites.** Each iteration changes as little as possible.
- **Match the project's conventions.** Styling approach, file structure, naming patterns — match what's already there.