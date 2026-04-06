---
name: d2c-audit
description: "Audit codebase for design token drift, unused tokens, component reuse violations, library pattern violations, and accessibility issues. Use when checking code quality, running design system audits, or finding hardcoded values."
allowed-tools: Read, Bash, Glob, Grep
---

# Design Token Drift Audit

You are auditing this project's codebase to find violations of the design system. Your job is to detect hardcoded values that should use design tokens, find unused tokens, and report components that bypass the design system.

---

## Arguments

Parse `$ARGUMENTS` for optional flags:

- **Directory path** — If a path is provided (e.g., `/d2c-audit src/components/`), scope all audits to files within that directory only. If no path is provided, audit the entire `src/` and `app/` directories as usual.
- **`--fix`** — After reporting, auto-fix hardcoded values that have an exact token match (labeled `definite` in Audit 1). Only fixes exact matches — `undocumented` values are reported but not touched. Show a summary of fixes applied after the report. When combined with `--dry-run`, shows a preview of proposed fixes instead of applying them (see below).
- **`--dry-run`** — Run the full audit and generate the report, but do NOT apply any changes. Behavior depends on whether `--fix` is also provided:
  - **`--dry-run` alone** (without `--fix`): Runs the audit as read-only and generates the report. This is the same as the default behavior but makes the read-only intent explicit.
  - **`--dry-run` with `--fix`**: Runs the full audit, identifies all fixable issues, but instead of auto-fixing, presents each proposed fix as a diff-style preview:
    ```
    --- src/components/Header.tsx (current)
    +++ src/components/Header.tsx (proposed)
    @@ line 42 @@
    - color: #3B82F6
    + color: theme.colors.primary
    ```
    After showing all proposed fixes, ask the user how to proceed:
    - **"Apply all"** — Apply every proposed fix.
    - **"Review individually"** — Step through each fix one by one. For each, the user can approve or skip.
    - **"Skip all"** — Discard all proposed fixes and end the audit.
    Group fixes by file for easier review. Show the total count: "Found X fixable issues across Y files."

---

## Pre-flight Check

1. Check that `.claude/design-tokens/design-tokens.json` exists. If it doesn't, tell the user to run `/d2c-init` first and stop.
2. **Schema version check:** Read the `d2c_schema_version` field. If it is missing or less than 1 (the current version), warn the user: "design-tokens.json uses schema version {version or 'none'} but the current version is 1. Run `/d2c-init --force` to regenerate." Allow the user to continue or abort.
3. Read `.claude/design-tokens/design-tokens.json` fully into context.

**Split file support:** After reading `design-tokens.json`, check the `split_files` field. If `true`, load only the split files relevant to each audit instead of keeping the full file in context:

| Audit | Split files needed |
|-------|-------------------|
| Audit 1 (Hardcoded Values) | `tokens-colors.json` (colors, shadows, borders for comparison) |
| Audit 2 (Unused Tokens) | `tokens-colors.json` + `tokens-core.json` (all token definitions) |
| Audit 3 (Component Reuse) | `tokens-components.json` (component list for reuse check) |
| Audit 4 (Library Violations) | `tokens-conventions.json` (preferred_libraries for compliance) |
| Audit 5 (Accessibility) | No token files needed (pure HTML/ARIA checks) |

Load each split file only when starting its corresponding audit. If a split file is missing, fall back to the monolithic `design-tokens.json`.

---

## Audit 1: Hardcoded Values That Should Be Tokens

Scan all component and source files for hardcoded values that exist in the design tokens or should be using them. Read the `framework` field from `design-tokens.json` to determine which file extensions to scan:

- **react / solid / qwik**: `.tsx`, `.jsx`, `.ts`, `.js`
- **vue**: `.vue` files (scan both `<template>` and `<style>` blocks), `.ts`, `.js`
- **svelte**: `.svelte` files (scan both markup and `<style>` blocks), `.ts`, `.js`
- **angular**: `.component.ts`, `.component.html`, `.ts`, `.js`
- **astro**: `.astro` files (scan both template and `<style>` blocks), `.ts`, `.js`

Also scan style files: `.css`, `.scss`, `.module.css`, `.module.scss`.

### Colors
- Search for raw hex colors (`#[0-9a-fA-F]{3,8}`), `rgb(`, `rgba(`, `hsl(`, `hsla(` in component files and style files.
- Exclude: SVG files, image assets, config files (`tailwind.config.*`, `postcss.config.*`), `node_modules`, `.next`, test files.
- **Color comparison rule (exact match only):** Convert all found colors to lowercase 6-digit hex before comparison. Convert `rgb()` and `hsl()` values to hex. A match is exact hex equality only — no fuzzy matching, no "near-equivalent" matching.
- For each hardcoded color found, check if it exactly matches any value in `design-tokens.json` → `colors`. If yes, label it `definite` — this value should use the token.
- Also flag colors that do NOT exactly match any token value — label these `undocumented`.

### Spacing
- Search for hardcoded pixel values in padding, margin, gap, width, height properties: `padding: 16px`, `margin: 24px`, `gap: 8px`, `p-[16px]`, `m-[24px]`, etc.
- In Tailwind projects, look for arbitrary value brackets: `p-[...]`, `m-[...]`, `gap-[...]`, `w-[...]`, `h-[...]` with pixel values that match the spacing scale.
- Flag values that match the spacing scale but use raw numbers instead of tokens.

### Typography
- Search for hardcoded font sizes: `font-size: 14px`, `text-[14px]`, etc.
- Search for hardcoded font weights: `font-weight: 600`, `font-[600]`, etc.
- Search for hardcoded line heights in style declarations.
- Flag values that match the typography scale but use raw numbers instead of tokens.

### Shadows & Borders
- Search for hardcoded `box-shadow` values and `border-radius` values.
- Flag values that match tokens but are hardcoded.

---

## Audit 2: Unused Tokens

Check each token defined in `design-tokens.json` to see if it's actually used in the codebase.

**Search patterns by styling approach (deterministic):**

- **For Tailwind projects — color tokens:** Search for each color token name prefixed with `bg-`, `text-`, `border-`, `ring-`, `fill-`, `stroke-`, `decoration-`, `accent-`, `outline-`, `shadow-`. A color token is "used" if ANY of these prefixed forms appear in source files.
- **For Tailwind projects — spacing tokens:** Search for each spacing token name prefixed with `p-`, `px-`, `py-`, `pt-`, `pr-`, `pb-`, `pl-`, `m-`, `mx-`, `my-`, `mt-`, `mr-`, `mb-`, `ml-`, `gap-`, `gap-x-`, `gap-y-`, `w-`, `h-`, `space-x-`, `space-y-`, `inset-`, `top-`, `right-`, `bottom-`, `left-`. A spacing token is "used" if ANY of these prefixed forms appear.
- **For Tailwind projects — typography tokens:** Search for font family with `font-`, font size with `text-`, font weight with `font-`, line height with `leading-`.
- **For Tailwind projects — shadow tokens:** Search with `shadow-` prefix.
- **For Tailwind projects — border tokens:** Search with `rounded-` and `border-` prefixes.
- **For CSS variable projects:** Search for `var(--token-name)` usage. Exact string match.
- **For CSS-in-JS projects:** Search for `theme.colors.tokenName`, `theme.spacing.tokenName`, etc. Exact property path match.

Report tokens that exist in the token file but have zero references in the codebase. Label each as:
- `unused` — zero matches found across all search patterns
- `build-only` — if the token appears only in files under `.next/`, `dist/`, or `build/` (false positive — note this)

---

## Audit 3: Component Reuse Violations

Check if page-level files use raw HTML elements instead of existing reusable components.

**Detection method (deterministic):**

Determine page-level file locations based on framework:
- **react / next**: `app/` and `src/pages/` (`.tsx`/`.jsx` files)
- **vue / nuxt**: `pages/` (`.vue` files — search in `<template>` blocks)
- **svelte / sveltekit**: `src/routes/` (`+page.svelte` files — search in markup section)
- **angular**: `src/app/*/` (`.component.html` files or inline templates in `.component.ts`)
- **astro**: `src/pages/` (`.astro` files — search in template section)
- **solid**: `src/routes/` (`.tsx` files)

1. Search for raw HTML elements (`<button`, `<input`, `<select`, `<textarea`, `<dialog`, `<table`) in the framework's page-level files (NOT files inside component directories).
2. For each raw HTML element found, check if a corresponding component exists in the `components` array of `design-tokens.json`. Match by element type to component name:
   - `<button` → any component with `button` (case-insensitive) in its name
   - `<input` → any component with `input` or `textfield` in its name
   - `<select` → any component with `select` or `dropdown` in its name
   - `<textarea` → any component with `textarea` in its name
   - `<dialog` → any component with `dialog` or `modal` in its name
   - `<table` → any component with `table` in its name
3. If a raw element is found AND a matching component exists, flag it as a violation.
4. Do NOT flag raw elements in component files themselves (they are the implementation).

---

## Audit 4: Preferred Library Violations (if applicable)

If `preferred_libraries` exists in `design-tokens.json`:

**4a: Data fetching violations.**
If `preferred_libraries.data_fetching` exists, check that components use the `selected` data fetching library, not alternatives:
- If selected is `@tanstack/react-query` but a component uses raw `fetch` or `useEffect` + `useState` for data fetching, flag it.
- If selected is `@tanstack/react-query` but a component imports `swr`, flag it.
- If selected is `axios` but a component uses raw `fetch`, flag it.
- Check for missing error handling on API calls (no `onError`, no `.catch()`, no error state).
- Check for missing loading states on API calls.

**4b: Other library category violations.**
For each category in `preferred_libraries` where `installed` has more than 1 entry, check that source files use the `selected` library and not a non-selected alternative:
- If `dates.selected` is `date-fns` but a file imports `moment`, flag it.
- If `forms.selected` is `react-hook-form` but a file imports `formik`, flag it.
- Apply the same check for all categories with competing libraries.

**Detection method:** For each non-selected library in a category, grep for its import statement (`import ... from '<package>'` or `require('<package>')`). Any match in source files (excluding `node_modules`, config files, and lock files) is a violation.

---

## Audit 5: Accessibility Violations

Scan component and page files for common accessibility issues using deterministic pattern matching.

**5a: Images without alt text.**
Search for `<img` tags without an `alt` attribute. Every `<img` must have `alt` (either descriptive text or `alt=""` for decorative).

**5b: Buttons and links without accessible labels.**
Search for `<button` and `<a` tags that have no text content between opening and closing tags AND no `aria-label` attribute. Icon-only buttons must have `aria-label`.

**5c: Heading hierarchy violations.**
For each component/page file, scan for heading tags (`h1` through `h6`). Flag files where heading levels skip (e.g., `h1` followed by `h3` with no `h2`).

**5d: Click handlers on non-interactive elements.**
Search for `onClick` (React/Solid), `@click` (Vue), `onclick` (Svelte), `(click)` (Angular) on `<div`, `<span`, or `<p` elements that do NOT have `role="button"` or `tabIndex`.

**5e: Form inputs without labels.**
Search for `<input`, `<select`, `<textarea` that are not preceded by a `<label` tag and do not have `aria-label` or `aria-labelledby` attributes.

---

## Report Format

Present the audit results as a structured report:

```
## Design Token Drift Audit Report

### Hardcoded Values Found
| File | Line | Value | Should Be | Token Name |
|------|------|-------|-----------|------------|
| src/components/Header.tsx | 42 | #3B82F6 | Token | primary |
| src/app/dashboard/page.tsx | 87 | padding: 24px | Token | spacing-6 |

**Total: X hardcoded values across Y files**

### Unused Tokens
| Token | Category | Defined Value |
|-------|----------|---------------|
| warning | colors | #F59E0B |

**Total: X unused tokens**

### Component Reuse Violations
| File | Line | Issue | Suggested Component |
|------|------|-------|-------------------|
| src/app/settings/page.tsx | 23 | Inline button styling | Use Button component |

**Total: X potential violations**

### Preferred Library Violations (if applicable)
| File | Line | Issue | Category | Selected | Used Instead |
|------|------|-------|----------|----------|-------------|
| src/app/users/page.tsx | 15 | Uses raw fetch | data_fetching | @tanstack/react-query | fetch |
| src/utils/format.ts | 8 | Imports moment | dates | date-fns | moment |

**Total: X library violations**

### Accessibility Violations
| File | Line | Issue | WCAG Criterion |
|------|------|-------|---------------|
| src/components/Icon.tsx | 12 | img without alt | 1.1.1 Non-text Content |
| src/app/dashboard/page.tsx | 45 | div with onClick, no role="button" | 4.1.2 Name, Role, Value |

**Total: X accessibility violations**

### Summary
- Hardcoded values: X (Y are direct token matches, Z are new/undocumented)
- Unused tokens: X
- Component reuse violations: X
- Preferred library violations: X
- Accessibility violations: X
- **Design system adherence score: X/100**
```

**Scoring — percentage-based per category, then weighted average.**

For each category, calculate a per-category score:

1. **Hardcoded values (base weight: 30%)**: Count all scannable values in source files (colors, spacing, typography, shadows, borders). Score = `((total_values - violations) / total_values) * 100`. If total_values is 0, score is **N/A** (category excluded from weighted average).
2. **Unused tokens (base weight: 10%)**: Score = `((total_tokens - unused_tokens) / total_tokens) * 100`. If total_tokens is 0, score is **N/A** (category excluded from weighted average).
3. **Component reuse (base weight: 20%)**: Count raw HTML elements in page-level files that have a corresponding component. Score = `((total_matchable_elements - violations) / total_matchable_elements) * 100`. If total_matchable_elements is 0, score is **N/A** (category excluded from weighted average).
4. **Preferred libraries (base weight: 15%)**: Count all imports in scanned files that belong to a category with a selected library. Score = `((total_categorized_imports - violations) / total_categorized_imports) * 100`. If total_categorized_imports is 0 or no preferred_libraries exist, score is **N/A** (category excluded from weighted average).
5. **Accessibility (base weight: 25%)**: Count all auditable elements (images, buttons, links, headings, click-handler divs, form inputs). Score = `((total_elements - violations) / total_elements) * 100`. If total_elements is 0, score is **N/A** (category excluded from weighted average).

**N/A handling and weight redistribution:** When one or more categories have a score of N/A, exclude them from the final score calculation and redistribute their weights proportionally across the remaining categories. The redistribution formula is: `effective_weight = base_weight / sum_of_active_base_weights`. For example, if "Unused tokens" (10%) and "Preferred libraries" (15%) are both N/A, the remaining categories have base weights 30% + 20% + 25% = 75%. Their effective weights become: Hardcoded = 30/75 = 40%, Component reuse = 20/75 = 26.7%, Accessibility = 25/75 = 33.3%.

**Final score** = sum of `(category_score * effective_weight)` for all non-N/A categories. If ALL categories are N/A, report: "No auditable elements found — score: N/A."

Display per-category scores in the summary:
```
### Summary
- Hardcoded values: X violations / Y total values — **score: Z/100**
- Unused tokens: X / Y total tokens — **score: N/A** (no tokens defined)
- Component reuse: X violations / Y matchable elements — **score: Z/100**
- Preferred libraries: X violations / Y imports — **score: N/A** (no preferred libraries)
- Accessibility: X violations / Y auditable elements — **score: Z/100**
- **Design system adherence score: X/100** (weighted average of non-N/A categories)
```

---

## Important Rules

- Only scan source files. Skip `node_modules`, `.next`, `dist`, `build`, `coverage`, test files (`*.test.*`, `*.spec.*`, `__tests__/`), and config files (`*.config.*`, `postcss.*`).
- **Flag ALL matches from regex scans.** Label each as either `definite` (the hardcoded value exactly matches a token value) or `undocumented` (the hardcoded value has no matching token). Do not skip any regex match. Do not use subjective confidence — every match is either exact-match or not.
- **File modification rules:** By default, this is a read-only audit — do not modify any files. When `--fix` is provided (without `--dry-run`), auto-fix `definite` matches only. When `--dry-run --fix` is provided, show diff previews and wait for user approval before modifying anything.
- If the project is small (< 10 source files), say so and note that the audit may be less meaningful.
