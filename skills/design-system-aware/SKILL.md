---
name: design-system-aware
description: "Enforces design tokens, component reuse, SOLID/DRY principles, and preferred library conventions when editing frontend code. Activates on component file edits when .claude/design-tokens/design-tokens.json exists."
allowed-tools: Read
---

# Design System Aware Code Generation

**Trigger condition:** This skill activates when ANY component file inside `src/` or `app/` is being created or modified, AND `.claude/design-tokens/design-tokens.json` exists.

Component file extensions by framework (read `framework` from `design-tokens.json`):
- **react** / **solid**: `.tsx`, `.jsx`
- **vue**: `.vue`
- **svelte**: `.svelte`
- **angular**: `.component.ts`
- **astro**: `.astro`
- If `framework` field is missing, default to `.tsx`/`.jsx` (React).

When writing or editing frontend code in this project, follow these rules:

## Before Writing Code

1. Check if `.claude/design-tokens/design-tokens.json` exists.
2. If it exists, read it and use it as the source of truth for all design decisions.
3. Check the `components` section before creating any new component — reuse what exists.

## Project Conventions (Highest Priority)

If `design-tokens.json` contains a `conventions` section, these conventions override the framework reference file's generic patterns for **all stylistic decisions**. Only enforce conventions where `confidence` > 0.6 (or `override` is `true`) and `value` is not `"mixed"`.

- **Component declaration** (`conventions.component_declaration`): Use arrow functions or function declarations as specified.
- **Export style** (`conventions.export_style`): Use default or named exports as specified.
- **Type definitions** (`conventions.type_definition`): Use `interface` or `type` as specified.
- **Type location** (`conventions.type_location`): Keep types in the component file (`colocated`) or in a separate `types.ts` (`separate_file`).
- **File naming** (`conventions.file_naming`): Name new files in PascalCase, kebab-case, or camelCase as specified.
- **Import ordering** (`conventions.import_ordering`): Order import groups per the detected pattern array.
- **CSS utility pattern** (`conventions.css_utility_pattern`): Wrap Tailwind classes with the project's utility function (e.g., `cn()` from `@/lib/utils`). Use the `wrapper_import` path for the import.
- **Barrel exports** (`conventions.barrel_exports`): If `"yes"`, update `index.ts` barrel files when adding new components.
- **Props pattern** (`conventions.props_pattern`): Destructure props in the function signature or use a props object as specified.

If the `conventions` section does not exist, follow framework reference file defaults.

## Token Usage

- All colors, spacing, font sizes, shadows, and border radii must come from `.claude/design-tokens/design-tokens.json`.
- Never hardcode design values. No raw hex colors, no magic number padding or margins.
- Use the project's styling approach as specified in `styling_approach`.

## Preferred Library Conventions

- If `preferred_libraries` exists in `design-tokens.json`, always use the `selected` library for each capability category.
- **Data fetching**: use whatever is at `preferred_libraries.data_fetching.selected`. Use the correct import/API pattern for the project's framework. Common patterns: React Query = `useQuery`/`useMutation`, SWR = `useSWR`/`useSWRMutation`, axios = `axios.get()`/`axios.post()`, Nuxt = `useFetch`/`useAsyncData`, Solid = `createResource`, Angular = `inject(HttpClient)`. Never use an alternative library that is installed but not selected.
- **Dates**: use whatever is at `preferred_libraries.dates.selected`. Never mix date libraries (e.g., don't use `moment` if `date-fns` is selected).
- **Forms, validation, icons, animation, charts, etc.**: same rule — always use the `selected` library for each category. Use the framework-correct variant (e.g., `lucide-react` for React, `lucide-vue-next` for Vue, `lucide-svelte` for Svelte).
- Follow the project's error handling and loading state patterns as documented in the `api` section.
- Place API-related code in the same directory structure the project already uses.
- Use the framework's class attribute name: `className` for React/Solid (JSX), `class` for Vue/Svelte/Angular/Astro/Qwik.

## Component Reusability

- If a UI pattern appears 2+ times, extract it into a reusable component. A pattern is "repeated" if 2+ elements share the same HTML structure (same nesting, same tag types) AND the same visual styling (same colors, spacing, border treatment). Different text content does not make a pattern different.
- New components must be props-driven. No hardcoded content inside components.
- Compose complex UI from small pieces: a `PageHeader` uses `Heading` + `Breadcrumbs` + `ActionBar`.
- **Sub-component extraction rule:** Extract sub-components into separate files if they exceed 15 lines. Sub-components of 15 lines or fewer may stay in the parent file.

## SOLID

- **Single Responsibility**: One component, one job.
- **Open/Closed**: Extend via props and composition, not source modification.
- **Liskov Substitution**: Specialized component variants are drop-in replacements for the base component.
- **Interface Segregation**: Don't bloat props. Split if needed.
- **Dependency Inversion**: Depend on props and hooks, not concrete implementations.

## DRY

- Shared logic → custom hooks (React/Solid), composables (Vue), stores/functions (Svelte), services (Angular).
- Shared layout → layout components.
- Shared styles → design tokens.
- No copy-paste between components.