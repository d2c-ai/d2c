# Svelte 5 / SvelteKit Code Generation Rules

Loaded when: `package.json` contains `svelte` or `@sveltejs/kit`.
These rules are ADDITIVE to the universal rules in SKILL.md.
CRITICAL: Use Svelte 5 runes syntax ONLY. Never emit Svelte 4 patterns.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the patterns in this file for stylistic decisions (export style, file naming, import ordering, barrel exports). This file remains authoritative for framework-specific syntax requirements (Svelte 5 runes, `$props()`, `$state()`, `{#each}`, `class` attribute).

## 0. NON-NEGOTIABLES

These Svelte 5 / SvelteKit rules hold for every generated file. No exceptions.

- **MUST use Svelte 5 runes syntax ONLY.** NEVER emit Svelte 4 patterns (`export let`, `$:`, `on:click`, `<slot>`). If the project is on Svelte 4 or below, STOP AND ASK the user before proceeding — this file assumes Svelte 5.
- **MUST use `$props()` for props, `$state()` for state, `$derived()` for computed, `$effect()` for side-effects only.** NEVER set state inside `$effect` — use `$derived` or `$derived.by` instead.
- **Shared state files MUST use the `.svelte.ts` extension**, not plain `.ts`. Runes do not work outside a Svelte module context without that extension.
- **MUST use `class`, NEVER `className`.** Svelte uses the native HTML `class` attribute.
- **MUST use `{@render children()}` and `{#snippet}` for slots.** NEVER emit `<slot />` — it is Svelte 4 syntax.

---

## 1. KEY REMINDERS

- Use Svelte 5 runes ONLY. NEVER emit Svelte 4 patterns (`export let`, `$:`, `on:click`, `<slot>`).
- Use `$props()` for props, `$state()` for state, `$derived()` for computed, `$effect()` for side-effects only.
- NEVER set state inside `$effect` -- use `$derived` or `$derived.by` instead.
- Shared state files MUST use `.svelte.ts` extension (not plain `.ts`) for runes to work outside components.
- Use `class`, never `className`. Events use `onclick` (NOT `on:click`). Slots use `{#snippet}` + `{@render}` (NOT `<slot>`).

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

| Concept       | Svelte 5 Syntax                                          |
|---------------|----------------------------------------------------------|
| Raw state     | `let data = $state.raw<User[]>([])` -- no deep proxy, reassign-only, use for large API data |
| Computed (fn) | `let sorted = $derived.by(() => { return items.toSorted(cmp) })` -- for multi-statement derivations |
| Snippets      | `{#snippet name(params)}...{/snippet}` + `{@render name(args)}` |
| Shared state  | Reactive class in `.svelte.ts` file: `class State { count = $state(0); doubled = $derived(this.count * 2); }` |

NEVER use: `export let`, `$:`, `on:click`, `<slot>`, `svelte/store` for new code.

---

## 3. FILE STRUCTURE CONVENTIONS

| Type                | Path                                      |
|---------------------|-------------------------------------------|
| Page                | `src/routes/dashboard/+page.svelte`       |
| Layout              | `src/routes/+layout.svelte`               |
| Server load         | `src/routes/dashboard/+page.server.ts`    |
| Universal load      | `src/routes/dashboard/+page.ts`           |
| Reusable component  | `src/lib/components/ComponentName.svelte`  |
| API route           | `src/routes/api/users/+server.ts`         |
| Server hooks        | `src/hooks.server.ts`                     |
| Client hooks        | `src/hooks.client.ts`                     |
| Types               | `src/lib/types/` or co-located            |
| Reactive module    | `src/lib/state/name.svelte.ts` — runes require `.svelte.ts` extension outside components |

Components in `src/lib/` are importable via `$lib/components/...`. Standalone Svelte projects use `src/lib/components/` or `src/components/`.

---

## 4. DATA FETCHING PATTERNS

| Context               | Pattern                                                       |
|-----------------------|---------------------------------------------------------------|
| Server load (primary) | `+page.server.ts`: `export const load = async ({ fetch }) => { ... }` |
| Page receives data    | `let { data } = $props()` in `+page.svelte`                  |
| Client-side query     | `createQuery({ queryKey, queryFn })` via `@tanstack/svelte-query` |
| API route             | `+server.ts` with `export async function GET({ url }) { ... }` |
| Form mutation         | `+page.server.ts` with `export const actions = { default: async ({ request }) => { ... } }` |

Default: use `+page.server.ts` load functions. Never use `onMount` + `fetch` for initial data.

---

## 5. CLIENT / SERVER BOUNDARIES

- No `"use client"` directive. Svelte components run on both server and client by default.
- Server-only code: `+page.server.ts`, `+server.ts`, or any `*.server.ts` file.
- Form actions in `+page.server.ts` provide progressive enhancement (works without JS).
- Environment variables: `$env/static/private` for server secrets, `$env/static/public` for client-safe values.
- Dynamic env: `$env/dynamic/private` and `$env/dynamic/public` when values change at runtime.

---

## 6. STYLING SYNTAX

| Method          | Syntax                                                    |
|-----------------|-----------------------------------------------------------|
| Tailwind        | `class="flex items-center gap-2 text-sm"`                 |
| Class directive | `class:active={isActive}` (toggle shorthand)              |
| Scoped CSS      | `<style>` block (auto-scoped, no keyword needed)          |

---

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

| Category           | Svelte Libraries                                                |
|--------------------|-----------------------------------------------------------------|
| data_fetching      | `@tanstack/svelte-query`, SvelteKit load functions (built-in)   |
| forms              | `superforms`, `felte`, `@tanstack/svelte-form`                  |
| state_management   | `$state` (built-in Svelte 5), `svelte/store` (Svelte 4 compat) |
| icons              | `lucide-svelte`, `@steeze-ui/icons`, `unplugin-icons`           |
| animation          | `svelte/transition` (built-in), `svelte/animate` (built-in), `gsap` |
| component_library  | `shadcn-svelte`, `skeleton`, `bits-ui`, `melt-ui`, `flowbite-svelte` |
| tables             | `@tanstack/svelte-table`, `svelte-headless-table`               |
| charts             | `layerchart`, `pancake`, `chart.js` via `svelte-chartjs`        |
| toast              | `svelte-sonner`, `svelte-french-toast`                          |
| dnd                | `svelte-dnd-action`, `@dnd-kit/svelte`                          |

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.

---

## Library Boundary Values (SVG Chart Libraries)

Some libraries accept color/style values as string props, not CSS classes or variables. SVG-based chart libraries (layercake, d3, pancake) require hex/rgb strings because the SVG renderer does not resolve CSS custom properties at the attribute level.

**Pattern: Resolve CSS variables at runtime with `$state` + `$effect`.**

```svelte
<script>
  let chartColors = $state({ primary: '#000000' })

  function resolveTokenColor(tokenVar) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(tokenVar)
      .trim() || '#000000'
  }

  $effect(() => {
    chartColors = {
      primary: resolveTokenColor('--colors-primary'),
    }
  })
</script>
```

**When runtime resolution is not feasible**, hardcoding is acceptable but MUST include a comment linking the value to its token:

```svelte
<!-- Token: colors.primary (#2563EB) — hardcoded for SVG chart compatibility -->
<rect fill="#2563EB" />
```

These values are **exempt from the Phase 5 hardcoded-values audit** (bucket A) because the library API requires them.
