---
name: d2c-init
description: "Scan your codebase to extract design tokens, detect framework, discover components, and configure preferred libraries. Run once per project before /d2c-build. Use when setting up d2c, initializing design system, or scanning codebase."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__figma
---

# Initialize Design System

You are initializing the design-to-code workflow for this project. Your job is to deeply understand the existing codebase's design patterns and produce a `design-tokens.json` file at `.claude/d2c/design-tokens.json`.

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

> **Note for d2c-init:** This skill creates the infrastructure (design-tokens.json, preferred_libraries, conventions) that the other skills enforce. Rules 1–5 above describe the contract d2c-init writes; d2c-build, d2c-audit, and design-system-aware depend on this file being correct. During initialization, any ambiguity about what to write to the tokens file MUST result in a STOP AND ASK — never guess.

## Arguments

Parse `$ARGUMENTS` for optional flags:

- **Figma URL** — If a Figma URL is provided (e.g., `/d2c-init https://www.figma.com/design/...`), store it for use in Step 5g (Figma Variables import). This avoids requiring the user to provide the URL separately.
- **`--force`** — Skip incremental update detection and force a full scan (Steps 0-8). Useful if the design-tokens.json is out of sync and incremental detection fails.

## Pre-check: Incremental Update

Before scanning, check if `.claude/d2c/design-tokens.json` exists.

- If `--force` was passed in `$ARGUMENTS`: skip incremental detection, create the `.claude/d2c/` directory if needed, and proceed with a full scan (Steps 0-8).
- If it **does not exist**: create the `.claude/d2c/` directory and proceed with a full scan (Steps 0-8).
- If it **does exist**: read it into context. Check the `d2c_schema_version` field — if it is missing or less than 1 (the current version), the model MUST STOP AND ASK the user for confirmation before overwriting, using this prompt: "design-tokens.json uses an older schema version (found: {version or 'none'}). You MUST run `/d2c-init --force` to regenerate with the latest schema before any d2c-build or d2c-audit run. Confirm to proceed, or cancel to leave the file untouched." Only after explicit user confirmation, run a targeted scan:
  1. Check if the styling approach or config file has changed. If yes, re-extract tokens (Step 2) and re-run conflict detection (Step 2b).
  2. Scan only for new, modified, or deleted components and hooks since the file was last generated (compare file paths in the existing JSON against what's on disk).
  3. Check if `package.json` dependencies have changed — compare installed packages against the `preferred_libraries` section. If new libraries were added to an existing category, or a new category now has libraries, re-run Step 5 for those categories only. Ask the user to re-choose if a new competing library was added to a category that previously had only one.
  4. Merge changes into the existing `design-tokens.json` — add new entries, update changed entries, remove entries for deleted files.
  5. If tokens changed (steps 1 or 4 modified token values), re-run Step 2b conflict detection. Preserve existing `user-resolved` entries in `token-conflicts.json` where the tokens and values are still valid.
  6. Skip Steps 7-8's Playwright/pixelmatch install if already installed.
  6. Check if the framework has changed (e.g., project migrated from React to Vue). If `framework` in existing file doesn't match current detection, warn the user: "Framework change detected: {old} → {new}. This will regenerate all framework-specific fields and may update preferred library categories. Proceed?" Wait for confirmation before re-running Step 0.
  7. Check if the `conventions` section exists in the existing `design-tokens.json`. If it does not exist (e.g., file created by an older version of init), run Step 5h to detect conventions. If it does exist, only re-scan conventions if component files have changed (same logic as item 2 — compare file paths on disk against what was previously scanned).

This avoids re-reading the entire codebase when only a few components have changed.

## Step 0: Detect Framework

Scan the project to identify the frontend framework. Check in this order (first match wins):

| Priority | Check | framework | meta_framework |
|----------|-------|-----------|----------------|
| 1 | `nuxt.config.ts` or `nuxt.config.js` exists | `vue` | `nuxt` |
| 2 | `svelte.config.js` exists AND `@sveltejs/kit` in package.json | `svelte` | `sveltekit` |
| 3 | `svelte.config.js` exists without `@sveltejs/kit` | `svelte` | `svelte` |
| 4 | `angular.json` exists | `angular` | `angular` |
| 5 | `astro.config.mjs` or `astro.config.ts` exists | `astro` | `astro` |
| 6 | `@solidjs/start` in package.json dependencies | `solid` | `solidstart` |
| 7 | `solid-js` in package.json without `@solidjs/start` | `solid` | `solid` |
| 8 | `next.config.mjs` or `next.config.js` or `next.config.ts` exists | `react` | `next` |
| 9 | `react` in package.json dependencies | `react` | `react` |
| 10 | None detected | Ask user to specify | — |

**For Astro projects:** Also detect island frameworks by reading `astro.config.mjs`/`astro.config.ts` for integration imports (`@astrojs/react`, `@astrojs/vue`, `@astrojs/svelte`, `@astrojs/solid-js`). Record as `island_frameworks` array.

**Determine component file extension:**
- react, solid: `.tsx`
- vue: `.vue`
- svelte: `.svelte`
- angular: `.component.ts`
- astro: `.astro`

Record `framework`, `meta_framework`, and `component_file_extension` in design-tokens.json (Step 6).

## Step 1: Identify the Styling Approach

Scan the project for how styles are written. Look for:

- `tailwind.config.ts` or `tailwind.config.js` → Tailwind CSS
- `*.module.css` or `*.module.scss` files → CSS/SCSS Modules
- `styled-components`, `@emotion/styled`, or `@emotion/css` in `package.json` → CSS-in-JS
- `.css` files imported directly into components → Vanilla CSS
- A combination of the above

Record the primary styling approach. If mixed: count the number of component files (using the `component_file_extension` detected in Step 0) using each approach. The approach used by >50% of component files is `primary`. Others are `secondary`. If no approach exceeds 50%, record as `mixed` and list all approaches in descending order of file count.

## Step 2: Extract Design Tokens

Based on the styling approach, extract tokens from the appropriate source:

**If Tailwind:** Read `tailwind.config.ts/js` and extract the `theme` / `extend` values — colors, spacing, fontFamily, fontSize, borderRadius, boxShadow, screens (breakpoints).

**If CSS Variables:** Search for `:root` or `[data-theme]` blocks in CSS files. Extract all custom properties.

**If CSS-in-JS / Theme file:** Look for theme objects (commonly in `theme.ts`, `styles/theme.ts`, `lib/theme.ts`, or similar). Extract the token values.

**If Vanilla CSS:** Scan all `.css` files in `src/` and `app/`. A value is a token if it appears in 3+ separate files. Record the exact value and assign a context-aware name using these rules:

- **Colors:** Name by the CSS property context where the value most frequently appears + the nearest named web color. Examples: `bg-slate` (a gray used mostly in `background`), `text-blue` (a blue used mostly in `color`), `border-gray` (used in `border-color`). If the same color is used across multiple property types, use the most frequent context. If two colors would get the same name, append a number: `bg-gray`, `bg-gray-2`.
- **Spacing:** Sort all spacing values numerically and assign t-shirt size names: `spacing-xs`, `spacing-sm`, `spacing-md`, `spacing-lg`, `spacing-xl`, `spacing-2xl`. If more than 6 values, continue with `spacing-3xl`, etc. or use the pixel value for outliers: `spacing-72`.
- **Typography:** Name by inferred purpose from the selectors where the value appears. `font-size-body` (used in `p`, `li`, `span`), `font-size-heading` (used in `h1`-`h6`), `font-size-small` (used in `.caption`, `.helper-text`, or smaller than body). If purpose can't be inferred, use the size scale: `font-size-sm`, `font-size-md`, `font-size-lg`.
- **All auto-generated tokens:** Mark with `"source": "extracted"` in the tokens object so the user knows these names were inferred, not defined by the project.

Sort tokens by frequency descending.

For all approaches, extract:
- **Colors**: primary, secondary, background, surface, text, border, error, success, warning, info — and any other semantic color names used
- **Spacing**: the scale or common spacing values used
- **Typography**: font families, size scale, weight scale, line heights
- **Breakpoints**: responsive breakpoints
- **Shadows**: box-shadow values
- **Borders**: border-radius values, border widths

## Step 2b: Detect Token Conflicts

After extracting tokens (Step 2) and before discovering components (Step 3), run a duplicate-detection pass to identify within-category value collisions — two or more tokens whose resolved value is identical within the same category. This prevents invisible drift where the build silently picks one of several equivalent tokens.

### Detection

Run the conflict detection script:

```
node skills/d2c-init/scripts/detect-conflicts.js .claude/d2c/design-tokens.json
```

If the script is not found at that path, use Glob to locate it (`**/detect-conflicts.js`) and run from wherever it lives.

Parse the stdout for `conflict:` lines. Each line has the format:

```
conflict: <category>:<normalized_value> — <path1>, <path2>, ...
```

If `detect-conflicts: ok` (no conflicts), skip the rest of this step.

### Usage Counting

For each conflict group detected, compute a rough usage count for each token name. The count is a simple grep for the token's leaf name (the last segment of the dotted path, e.g., `primary` from `colors.primary`) across source files with framework-appropriate extensions (`.tsx`, `.vue`, `.svelte`, `.component.ts`, `.astro`, `.ts`, `.jsx`, `.js`, `.css`). Search `src/` and `app/` directories. The count = number of matching lines.

Only compute usage counts for tokens that are IN CONFLICT — not for every token.

### Resolution Rules

For each conflict group, apply these rules in order:

1. **Deprecated-pattern check:** If ANY token name in the group contains a substring matching one of `deprecated`, `old`, `legacy`, `v1`, `v0`, `temp`, `tmp` (case-insensitive), force `status: "unresolved"` regardless of usage counts.

2. **Zero-usage check:** If ALL tokens in the group have 0 usage count, set `status: "unresolved"`.

3. **Usage-ratio check:** Sort tokens by usage count descending. If the highest-usage token has >= 2x the count of the second-highest, set `status: "auto-resolved"`, `canonical` = highest-usage path, `chosen_by: "usage_frequency"`.

4. **Ambiguous (within 2x):** Otherwise, set `status: "unresolved"`, `chosen_by: "pending"`.

### Threshold

The default threshold is **5** unresolved conflicts. If the user passed `--conflict-threshold <N>` in `$ARGUMENTS`, use that value instead.

If the number of unresolved conflicts exceeds the threshold, all unresolved conflicts will be presented to the user in Step 8 for resolution. Auto-resolved conflicts are always fine and do not count toward the threshold.

### Output

Write `.claude/d2c/token-conflicts.json` with the schema defined in `skills/d2c-build/schemas/token-conflicts.schema.json`. Each conflict entry includes:

- `id`: sequential `conflict-001`, `conflict-002`, etc.
- `category`: the token category
- `resolved_value`: the normalized value
- `canonical`: dotted token path of the winner (null if unresolved)
- `duplicates`: array of dotted paths of non-canonical tokens (or all paths if unresolved)
- `chosen_by`: `"usage_frequency"`, `"user_choice"`, or `"pending"`
- `status`: `"auto-resolved"`, `"user-resolved"`, or `"unresolved"`
- `usage_counts`: `{ "path": count }` for all tokens in the group
- `resolution_note`: human-readable explanation

### Incremental Behavior

On incremental d2c-init re-runs (when `token-conflicts.json` already exists):

1. Read the existing conflicts file.
2. After running conflict detection on the fresh tokens, compare against existing entries.
3. **Preserve** `user-resolved` entries where: the canonical token still exists in the fresh tokens, all duplicate tokens still exist, and they all still resolve to the same value.
4. **Remove** entries where any token was deleted or its value changed.
5. **Add** new conflict groups not already tracked.
6. Re-compute `unresolved_count`.

---

## Step 3: Discover Reusable Components

Scan the project for existing UI components. Common locations:
- `src/components/`, `src/components/ui/`, `components/`, `app/components/`
- Any barrel export files (`index.ts`) that re-export components

Also scan framework-specific locations:
- Vue/Nuxt: `components/` (auto-imported by Nuxt)
- Svelte/SvelteKit: `src/lib/components/`
- Angular: `src/app/shared/components/`, `src/app/*/components/`
- Astro: `src/components/`
- Solid: `src/components/`

For each component found, record:
- **name**: The component name
- **path**: File path relative to project root
- **description**: Must follow this exact format: `[Component type] that [primary function]. Supports [key prop categories].` Example: `Button component that triggers actions. Supports variant, size, and loading state.` Do not use free-form descriptions — stick to this template.
- **props**: The props it accepts (read from TypeScript types, PropTypes, or the JSX usage). List all prop names alphabetically.
- **import_count**: The number of files that import this component (the same count used for inclusion criteria below). MUST be an integer ≥ 0. This value is used by `/d2c-build` Phase 2 for component matching scoring.

**Inclusion criteria (deterministic):**
- **Include** any component that is imported by 2+ files (check with grep for import statements referencing the component file).
- **Include** any component that is imported by only 1 file IF it lives in a directory named `ui/`, `shared/`, `common/`, or `primitives/`.
- **Skip** everything else — these are page-specific components.

**Persist the import count:** The grep-based import count computed for the inclusion check above MUST be recorded as `import_count` on each included component entry. Do not discard this number — it feeds the component matching scoring system in `/d2c-build`.

**Props extraction by framework:**
- **React/Solid/Qwik** (`.tsx`/`.jsx`): Read TypeScript interface for props (e.g., `interface Props { ... }` or inline type annotation)
- **Vue** (`.vue`): Read `defineProps<T>()` in `<script setup>` block. Extract property names from the type literal.
- **Svelte** (`.svelte`): Read `let { ... }: Props = $props()` destructuring. Extract the property names.
- **Angular** (`.component.ts`): Read `input()` and `input.required()` calls. Extract property names. Also note `output()` calls.
- **Astro** (`.astro`): Read `Astro.props` type annotation or `interface Props` in frontmatter.

A component is page-specific if it lives inside a route directory (e.g., `app/dashboard/components/`) AND is imported by only 1 file.

## Step 4: Discover Shared Hooks, Composables, and Services

Look for custom hooks relevant to UI development:
- `useMediaQuery`, `useBreakpoint` → responsive behavior
- `useDebounce`, `useThrottle` → input handling
- `useClickOutside` → dropdowns, modals
- `useForm`, `useFormField` → form state
- Any data fetching hooks

**Framework-specific shared logic locations:**
- **React/Solid/Qwik**: Custom hooks (`use*` functions) in `src/hooks/` or `hooks/`
- **Vue/Nuxt**: Composables (`use*` functions) in `composables/` (auto-imported in Nuxt) or `src/composables/`
- **Svelte**: Stores in `src/lib/stores/` or shared functions in `src/lib/`
- **Angular**: Injectable services (`*.service.ts`) in `src/app/core/services/` or `src/app/shared/services/`

Record these in a section named based on framework:
- React/Solid/Qwik: `hooks`
- Vue: `composables`
- Svelte: `stores`
- Angular: `services`

The JSON key in design-tokens.json is always `hooks` for consistency, but the description MUST use the framework's terminology (e.g., "composables" for Vue, "stores" for Svelte, "services" for Angular, "hooks" for React).

Record these in a `hooks` section with name, path, and description.

## Step 5: Detect Libraries and Resolve Competing Choices

This step scans `package.json` to find all installed libraries, groups them by capability category, and asks the user to choose a preferred library when multiple options exist in the same category. This ensures the build skill always uses the right library for new code.

### Step 5a: Scan package.json

Read `package.json` → `dependencies` and `devDependencies`. For every installed package, check if it belongs to a known capability category. A library belongs to a category if its package name matches.

Read the library categories reference file. Try these locations in order (first found wins):
- `references/library-categories.md` (relative to this SKILL.md file)
- Search with Glob for `**/library-categories.md` in `.claude/`, `.agents/`, and the skill install directories

For each installed package, check if it belongs to a known category. Framework-specific categories (prefixed with vue_, svelte_, angular_, solid_) only apply if the detected framework matches.

### Step 5b: Also detect `fetch` usage

`fetch` is not a package — it's a built-in. Scan source files for `fetch(` usage. If found, add `fetch (built-in)` to the `data_fetching` category.

Similarly, scan for:
- `"use server"` → add `next-server-actions (built-in)` to `data_fetching`
- CSS `@import` / `.css` file imports → add `vanilla-css (built-in)` to `css_in_js` if relevant

### Step 5c: Count usage per library

For each detected library, count how many source files (`.ts`, `.tsx`, `.js`, `.jsx`) import or use it. This is used for the recommendation.

### Step 5d: Identify categories with competing libraries

For each category:
- **If 0 libraries detected** → skip the category entirely, do not record it.
- **If exactly 1 library detected** → auto-select it. No question needed. Record it silently.
- **If 2+ libraries detected** → this is a conflict. Ask the user to choose (Step 5e).

### Step 5e: Ask the user to choose preferred libraries

For each category with 2+ libraries, present the options to the user with a recommendation. Ask all conflicting categories in a **single message**.

**Recommendation logic (deterministic):**
1. The library used in the most source files is the default recommendation.
2. Exception: if a library is widely known to be deprecated or unmaintained (e.g., `moment` is deprecated, `react-beautiful-dnd` is unmaintained), recommend the next most-used alternative instead and note the deprecation.

**Format:**

> I found multiple libraries for the same purpose in these categories:
>
> **Data fetching**: `@tanstack/react-query` (8 files), `swr` (5 files), `fetch` (12 files)
> → Recommended: **@tanstack/react-query** (most structured usage, best loading/error state support)
>
> **Dates**: `date-fns` (14 files), `moment` (6 files)
> → Recommended: **date-fns** (moment is deprecated, date-fns is actively maintained)
>
> **Forms**: `react-hook-form` (4 files), `formik` (7 files)
> → Recommended: **formik** (used in more files)
>
> For each category, which library should I use when generating new code?

Wait for the user to respond. If the user says "go with recommendations" or similar, treat those as the user's **selected** options and write them to `preferred_libraries.<category>.selected`. The user's choices are final — once written, NEVER substitute a different library when other skills read this file.

### Step 5f: Detect API-specific configuration

After the user selects a preferred data fetching library, scan for its configuration:

- **API base URL**: look for `axios.create({ baseURL })`, environment variables like `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`, or similar.
- **Query client setup**: if React Query or SWR, look for `QueryClientProvider`, `SWRConfig`, default options.
- **API utility files**: look in `lib/api.ts`, `utils/api.ts`, `services/api.ts`, `api/index.ts`.
- **Auth header injection**: interceptors, middleware, fetch wrappers.

Record API-specific patterns using these exact enum values:
- **`error_handling`** — must be one of: `toast`, `error-boundary`, `inline-message`, `console-only`, `none-detected`. If multiple patterns coexist, use the one that appears in >50% of API call sites. If no pattern exceeds 50%, use `mixed` and note the top two.
- **`loading_pattern`** — must be one of: `react-query-isLoading`, `swr-isLoading`, `suspense`, `useState-loading`, `skeleton-component`, `none-detected`. Same >50% rule applies.
- **`response_envelope`** — search for a consistent wrapper object shape across 3+ API responses. Record the exact key names (e.g., `{ data, error, meta }`). If no consistent shape across 3+ responses, record `none-detected`.
- **Shared types** — check for API response types in `types/`, `interfaces/`, or co-located with API calls. Record the path to the types directory if one exists.

## Step 5g: Import Figma Variables (Optional)

If Figma MCP is available and the user provides a Figma file URL (or one was used in a previous build), attempt to import Figma Variables to enrich the design tokens.

1. Use the Figma MCP `get_variable_defs` tool with the Figma file's node ID and file key to pull the file's variable definitions.
2. Figma Variables typically include:
   - **Color variables**: semantic colors like `primary`, `secondary`, `background`, `text`, organized by collection/mode (e.g., light/dark)
   - **Spacing variables**: spacing scale values
   - **Typography variables**: font sizes, line heights, font weights
   - **Border radius variables**: radius values

3. **Merge strategy — Figma Variables supplement, they do not override. Match by exact key name only:**
   - If a Figma Variable's key name exactly matches a codebase token key name, keep the codebase version as the source of truth. Do NOT match by value similarity or fuzzy name matching — exact key name match only.
   - If a Figma Variable has no codebase equivalent (no exact key name match), add it to the tokens with a `"source": "figma"` annotation.
   - If a Figma Variable and codebase token have the same exact key name but different values, flag the mismatch to the user in the verification step (Step 8).

4. Record any imported Figma Variables in a `figma_variables` section for reference:

```json
"figma_variables": {
  "imported_from": "<figma file URL or key>",
  "mismatches": [
    {
      "name": "primary",
      "figma_value": "#2563EB",
      "code_value": "#3B82F6",
      "status": "flagged"
    }
  ]
}
```

If Figma MCP is not available or no Figma file URL is known, skip this step entirely. Do not ask the user for a Figma URL during init — this is an optional enrichment, not a requirement.

## Step 5h: Detect Project Conventions

Scan existing component files to infer the team's coding conventions. These conventions will take the highest priority during code generation — above framework reference file defaults.

**Which files to scan:** Use files from the directories where components were found in Step 3. Scan up to 20 component files (using `component_file_extension` from Step 0). If fewer than 10 component files exist, scan all of them. Exclude test files, story files, and generated files (`*.test.*`, `*.spec.*`, `*.stories.*`, `*.generated.*`).

For each convention below, count occurrences of each pattern variant. A pattern is the project convention if it appears in **>60% of scanned files**. If no variant exceeds 60%, record as `"mixed"` — no convention will be enforced for that category.

### Convention 1: Component Declaration Style
**Applies to:** `react`, `solid` only. Skip for other frameworks.

Scan for:
- Arrow function: `const [A-Z]\w+ = (` or `const [A-Z]\w+ = React.memo(` → count as `arrow_function`
- Function declaration: `function [A-Z]\w+(` or `export default function [A-Z]` → count as `function_declaration`

Record: `"arrow_function"`, `"function_declaration"`, or `"mixed"`.

### Convention 2: Export Style
**Applies to:** all frameworks.

Scan for:
- `export default` (including `export default function`, `export default class`) → count as `default_export`
- `export const [A-Z]` or `export function [A-Z]` (without `default`) → count as `named_export`

Record: `"default_export"`, `"named_export"`, or `"mixed"`.

### Convention 3: Type Definition Style
**Applies to:** TypeScript projects only (`.tsx`, `.ts` files). Skip for plain JS projects.

Scan for:
- `interface \w+Props` or `interface \w+` in component files → count as `interface`
- `type \w+Props =` or `type \w+ =` in component files → count as `type_alias`

Record: `"interface"`, `"type_alias"`, or `"mixed"`.

### Convention 4: Type Location
**Applies to:** TypeScript projects only.

Check if component directories contain separate type files:
- Separate: `types.ts`, `types/index.ts`, `*.types.ts`, or `*.d.ts` files exist alongside components → count as `separate_file`
- Colocated: type definitions are inside the component file itself → count as `colocated`

Record: `"colocated"`, `"separate_file"`, or `"mixed"`.

### Convention 5: File Naming Convention
**Applies to:** all frameworks.

Look at component file names from Step 3 directories:
- `PascalCase`: file names match `[A-Z][a-z]+([A-Z][a-z]+)*` (e.g., `UserProfile.tsx`)
- `kebab-case`: file names match `[a-z]+(-[a-z]+)+` (e.g., `user-profile.tsx`)
- `camelCase`: file names match `[a-z]+([A-Z][a-z]+)+` (e.g., `userProfile.tsx`)

Record: `"PascalCase"`, `"kebab-case"`, `"camelCase"`, or `"mixed"`.

### Convention 6: Import Ordering
**Applies to:** all frameworks.

Read the import block of 10+ files. Detect consistent grouping by blank lines between import groups. Identify each group:
- `"framework"`: imports from the framework package (`react`, `next`, `vue`, `svelte`, `@angular`, `solid-js`, `astro`)
- `"external"`: imports from `node_modules` packages (no `.` or `@/` prefix in path)
- `"internal"`: imports using aliased paths (`@/`, `~/`, `#/`)
- `"relative"`: imports using `./` or `../`
- `"type"`: type-only imports (`import type`, `import { type }`)
- `"style"`: CSS/SCSS/style imports (`.css`, `.scss`, `.module.css`)

Record: an ordered array of group names reflecting the detected order, or `"mixed"` if no consistent pattern.

### Convention 7: CSS Class Utility Pattern
**Applies to:** only if `styling_approach` includes `tailwind`. Skip otherwise.

Scan for:
- Wrapper imports: `import { cn }`, `import { clsx }`, `import { cva }`, `import { twMerge }`, `import { cx }` — note the function name AND the import path
- Usage: `cn(`, `clsx(`, `cva(`, `twMerge(`, `cx(` in JSX/template class attributes
- Raw classes: Tailwind class strings directly in `className`/`class` without a wrapper

If a wrapper is used in >60% of files, record the wrapper name (e.g., `"cn"`) and set `wrapper_import` to its import path (e.g., `"@/lib/utils"`). If no wrapper dominates, record `"raw_classes"` or `"mixed"`.

### Convention 8: Barrel Exports
**Applies to:** all frameworks.

Count component directories (from Step 3) that contain an `index.ts` or `index.js` re-export file:
- >60% of directories have barrel exports → `"yes"`
- <40% → `"no"`
- Otherwise → `"mixed"`

### Convention 9: Test File Location
**Applies to:** all frameworks.

Check where test files live:
- Colocated: `*.test.*` or `*.spec.*` files in the same directory as the source file → `"colocated"`
- Separate: test files in `__tests__/`, `tests/`, or `test/` directories → `"separate"`
- If no test files exist → `"none_detected"`

Record: `"colocated"`, `"separate"`, `"none_detected"`, or `"mixed"`.

### Convention 10: Props Pattern
**Applies to:** `react`, `solid` only. Skip for other frameworks.

Scan component function signatures:
- Destructured: `({ prop1, prop2 }: \w+Props)` or `({ prop1, prop2 })` → count as `destructured`
- Props object: `(props: \w+Props)` or `(props)` → count as `props_object`

Record: `"destructured"`, `"props_object"`, or `"mixed"`.

### After Detection: User Confirmation

Present the detected conventions to the user in a summary table:

> **Detected project conventions** (scanned X component files):
>
> | Convention | Detected | Confidence |
> |---|---|---|
> | Component declaration | arrow_function | 85% |
> | Export style | named_export | 92% |
> | Type definition | interface | 78% |
> | Type location | colocated | 90% |
> | File naming | PascalCase | 100% |
> | Import ordering | [framework, external, internal, relative, style] | 70% |
> | CSS utility pattern | cn (from @/lib/utils) | 88% |
> | Barrel exports | yes | 65% |
> | Test location | colocated | 75% |
> | Props pattern | destructured | 82% |
>
> Conventions with <60% confidence are marked as "mixed" and won't be enforced.
>
> **Do these look right? You can override any value.**

Wait for the user's response. If they override a value, set `"override": true` for that convention. If they say "looks good" or similar, proceed with the detected values.

## Step 6: Generate design-tokens.json

Read the token schema reference file. Try these locations in order (first found wins):
- `references/token-schema.md` (relative to this SKILL.md file)
- Search with Glob for `**/token-schema.md` in `.claude/`, `.agents/`, and the skill install directories

Write the file to `.claude/d2c/design-tokens.json`. Create the `.claude/d2c/` directory if it does not exist. Follow the schema exactly.

**Schema version:** Always write `"d2c_schema_version": 1` as the FIRST field in the JSON file. This is required for forward compatibility — the build and audit skills check this version before reading.

**Schema validation:** Before writing the file, validate the generated JSON against the JSON Schema. Try these locations in order (first found wins):
- `references/design-tokens.schema.json` (relative to this SKILL.md file)
- Search with Glob for `**/design-tokens.schema.json` in `.claude/`, `.agents/`, and the skill install directories

If validation fails, fix the generated JSON to conform to the schema before writing. If the schema file is not found, proceed without validation but warn: "Schema validation skipped — design-tokens.schema.json not found."

**Structural validation (flat tokens):** After schema validation, verify that all token values under `colors`, `spacing`, `typography`, `breakpoints`, `shadows`, and `borders` are **primitive** (string or number), never nested objects. The `d2c-build` validator (`walkTokens`) walks to leaf values and expects flat paths like `colors.primary` or `spacing.md`. If any token value is an object (e.g., `{ value: "#2563EB", css_var: "--color-primary" }`), flatten it: extract the resolved CSS value and store it directly (e.g., `"primary": "#2563EB"`). Also verify token categorization: spacing values (4px, 0.5rem, 16px) belong under `spacing`, border-radius values (0.375rem, 8px) belong under `borders` — never mix them. Warn the user if any recategorization was needed.

If no libraries are detected in any category, omit the `preferred_libraries` section. If no data fetching library exists, omit the `api` section. Include the `conventions` section from Step 5h — omit conventions that don't apply to the detected framework (see Step 5h for applicability rules).

### Step 6b: Auto-Split for Large Projects

After writing `design-tokens.json` in Step 6, check its size:
1. Count the line count of `.claude/d2c/design-tokens.json`.
2. Estimate tokens as `Math.ceil(character_count / 4)`.

**If the file exceeds 400 lines OR ~20,000 tokens:**

Split the monolithic file into focused files in `.claude/d2c/`:

| Split file | Contents |
|------------|----------|
| `tokens-core.json` | `d2c_schema_version`, `framework`, `meta_framework`, `component_file_extension`, `island_frameworks`, `styling_approach`, `spacing`, `typography`, `breakpoints`, `hooks` |
| `tokens-colors.json` | `colors`, `shadows`, `borders` (all visual tokens) |
| `tokens-components.json` | `components` array |
| `tokens-conventions.json` | `conventions`, `preferred_libraries`, `api`, `figma_variables` |

**Steps:**
1. Read the complete `design-tokens.json`.
2. For each split file, extract the relevant keys and write as a standalone JSON object.
3. Rewrite `design-tokens.json` to contain ONLY `d2c_schema_version`, `split_files: true`, `framework`, and `meta_framework`. Remove all keys that were copied into split files (colors, spacing, typography, breakpoints, shadows, borders, components, conventions, preferred_libraries, api, hooks, figma_variables, etc.). The split files are now the source of truth — the monolithic file becomes a lightweight pointer.
4. Tell the user: `"design-tokens.json is large ({lines} lines, ~{tokens} tokens). Created 4 split files for efficient per-phase loading: tokens-core.json, tokens-colors.json, tokens-components.json, tokens-conventions.json. The main file has been trimmed to avoid duplication."`

**If the file is under 400 lines AND under 20,000 tokens:**
- Do not create split files.
- If `split_files` was previously set to `true` in the file but the file is now small enough, remove the flag and delete any stale split files.

**On incremental updates:** When running an incremental update (pre-check detected existing file), if split files exist, regenerate only the split files whose source sections changed. For example, if only components changed, only rewrite `tokens-components.json`. If `framework` or `meta_framework` changed, also update the trimmed `design-tokens.json` pointer file.

## Step 7: Check Playwright, Pixelmatch, and Pngjs

Ensure Playwright, pixelmatch, and pngjs are installed globally and ready for the visual verification workflow. These are installed **globally** so they work regardless of how d2c was installed (plugin, skills, manual) and across all projects.

**Playwright:**
1. **Check if already available:** Run `npx --no-install playwright --version 2>/dev/null` or check if `playwright` exists in the project's `node_modules/` or `package.json` devDependencies. If available, skip to Chromium check below.
2. If not found, install globally: `npm install -g playwright && npx playwright install chromium`
3. **Chromium check:** Regardless of where Playwright was found, ensure Chromium is installed: run `npx playwright install chromium`.
4. If install fails, warn the user: "Could not install Playwright. Install it manually with `npm install -g playwright && npx playwright install chromium`. Visual verification will be unavailable until then." Do not block — continue with init.

**Pixelmatch and pngjs (for objective visual scoring):**
1. **Check if already available globally:** Run `node -e "require('pixelmatch'); require('pngjs'); console.log('pixeldiff ready')"`. If this succeeds, skip installation.
2. If not found globally, check the project's `node_modules/` — look for `node_modules/pixelmatch` and `node_modules/pngjs`. If both exist, skip.
3. If not found anywhere, install globally: `npm install -g pixelmatch pngjs`
4. **Verify after install:** Run `node -e "require('pixelmatch'); require('pngjs'); console.log('pixeldiff ready')"` to confirm they resolve.
5. If install fails, warn the user: "Could not install pixelmatch/pngjs. Pixel-diff scoring will be unavailable — builds will use visual-only comparison." Do not block.
6. If already installed, skip.

## Step 8: Verify and Confirm

After generating the file:
1. Show the user a summary:
   - Framework detected (e.g., Vue 3 / Nuxt 3)
   - Styling approach detected
   - Number of colors/tokens extracted
   - Components discovered (count and names)
   - Hooks found (count and names)
   - **Preferred libraries** — list each category and the selected library. For categories where the user made a choice, note it. For auto-selected (single library) categories, note they were auto-selected.
   - API configuration detected (if any)
   - Figma variable mismatches (if any)
   - **Token conflicts** — if `token-conflicts.json` exists and has entries, show the conflict summary (see below)
2. Ask if anything looks wrong or missing
3. If they correct something, update the file
4. Confirm initialization is complete and they can now use `/d2c-build`

### Token Conflict Presentation (Step 8)

If `token-conflicts.json` has any entries, present them in the summary as follows:

**Auto-resolved conflicts (FYI):**

For each conflict with `status: "auto-resolved"`, show a single line:
> - `{canonical}` chosen over `{duplicates joined with ", "}` ({usage ratio}x usage ratio)

The user can override any auto-resolution by saying so. If they override, update the entry to `status: "user-resolved"`, `chosen_by: "user_choice"`, and set the new `canonical`.

**Unresolved conflicts (needs input):**

If there are unresolved conflicts, present each one:

> **Token conflicts detected** — {unresolved_count} token groups need your input:
>
> 1. **{category}** value `{resolved_value}` is shared by:
>    - `{dotted_path}` ({usage_count} references)
>    - `{dotted_path}` ({usage_count} references)
>    Recommendation: {highest-usage name if ratio >= 2x | "needs your input (usage too close)"}
>
> For each group, which token should be the canonical name? Options:
> - Accept all recommendations
> - Choose differently for specific groups
> - Skip for now (d2c-build will ask again in Phase 2)

When the user resolves a conflict, update `token-conflicts.json`:
- Set `canonical` to the user's choice
- Move the other paths to `duplicates`
- Set `status: "user-resolved"`, `chosen_by: "user_choice"`
- Re-compute `unresolved_count`

## Important Rules

- Do NOT invent tokens that don't exist in the codebase. Only record what's actually there.
- If the project is new with almost no tokens or components, say so. A sparse file is fine.
- If you find inconsistencies (e.g., 5 different grays with no naming convention), note them but record as-is. Don't "clean up" the design system — that's the user's job.