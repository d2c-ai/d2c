# Solid.js / SolidStart Code Generation Rules

Loaded when: `package.json` contains `solid-js` or `solid-start`.
These rules are ADDITIVE to the universal rules in SKILL.md.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the canonical component template and patterns in this file for stylistic decisions (declaration style, export style, type definitions, file naming, import ordering, props pattern). This file remains authoritative for framework-specific syntax requirements (createSignal, createResource, `className`, no props destructuring at call site).

## 1. KEY REMINDERS

- NEVER destructure props -- it breaks reactivity. Always use `props.title`, not `{ title }`.
- Signals are called as functions: `count()` not `count`.
- Use `class` not `className`. Use `onInput` not `onChange` for live text input.
- Use `<For>`/`<Show>` components, NEVER `.map()` or ternaries in JSX (they don't preserve DOM nodes).
- NEVER use `createEffect` + setter to derive state -- use `createMemo` instead.
- Use `splitProps` for safe prop forwarding, `mergeProps` for reactive defaults.

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

| Concept       | Solid.js Syntax                                                |
|---------------|----------------------------------------------------------------|
| Split props   | `const [local, rest] = splitProps(props, ["class", "onClick"])` -- safe prop forwarding |
| Merge props   | `const merged = mergeProps({ size: "md" }, props)` -- reactive default values |
| Refs          | `let ref!: HTMLDivElement;` then `ref={ref}`                   |

Critical differences from React: signals called as functions (`count()`), `class` not `className`, `onInput` not `onChange`, `<For>`/`<Show>` not `.map()`/ternaries.

---

## 3. FILE STRUCTURE CONVENTIONS

| Type                | Path                                      |
|---------------------|-------------------------------------------|
| Page (SolidStart)   | `src/routes/index.tsx`, `src/routes/about.tsx` |
| Nested route        | `src/routes/dashboard/settings.tsx`       |
| Dynamic route       | `src/routes/users/[id].tsx`               |
| Layout              | `src/routes/(layout).tsx`                 |
| Reusable component  | `src/components/ComponentName.tsx`         |
| Lib / utils         | `src/lib/` or `src/utils/`               |
| API route           | `src/routes/api/endpoint.ts`             |

---

## 4. DATA FETCHING PATTERNS

| Context                | Pattern                                                     |
|------------------------|-------------------------------------------------------------|
| Client resource        | `const [data] = createResource(fetcher)`                    |
| SolidStart server data | `const getItems = query(async () => { "use server"; return db.items() }, "items")` |
| Consume async          | `const data = createAsync(() => getItems())` from `@solidjs/router` |
| TanStack Query         | `createQuery(() => ({ queryKey, queryFn }))`                |

Default: `createResource` for client-only. SolidStart: `query` + `createAsync`. NEVER use deprecated `createServerData$` or `cache`.

---

## 5. CLIENT / SERVER BOUNDARIES

SolidStart is server-rendered by default. Key rules:
- Use `"use server"` to mark functions that must only run on the server
- There is NO `"use client"` directive — components render on both sides by default
- Server-only code: `"use server"` at top of function or file
- Actions: `const myAction = action(async (formData) => { "use server"; ... })` — for form mutations
- Isomorphic by default — code runs on server first, then hydrates on client

---

## 6. STYLING SYNTAX

| Method         | Syntax                                                     |
|----------------|-------------------------------------------------------------|
| Tailwind       | `class="flex items-center gap-2 text-sm"`                   |
| Conditional    | `classList={{ active: isActive(), disabled: isDisabled() }}` |

Always use `class`, NEVER `className`. Use `classList` for conditional classes. CSS property names in `style` use kebab-case strings as keys.

---

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

| Category           | Solid Libraries                                               |
|--------------------|---------------------------------------------------------------|
| data_fetching      | `@tanstack/solid-query`, `createResource` (built-in)          |
| forms              | `@modular-forms/solid`, `@felte/solid`                        |
| icons              | `solid-icons`, `lucide-solid`                                 |
| component_library  | `@kobalte/core`, `@ark-ui/solid`, `corvu`                     |
| animation          | `solid-transition-group`, `motion`, `gsap`                    |
| state              | `createSignal` / `createStore` (built-in)                     |
| router             | `@solidjs/router` (built-in with SolidStart)                  |
| tables             | `@tanstack/solid-table`                                       |
| meta               | `@solidjs/meta`                                               |

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.
