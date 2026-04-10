# Astro Code Generation Rules

Loaded when: `package.json` contains `astro`.
These rules are ADDITIVE to the universal rules in SKILL.md.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the patterns in this file for stylistic decisions (export style, file naming, import ordering, barrel exports). This file remains authoritative for framework-specific syntax requirements (frontmatter fences, `Astro.props`, `client:*` directives, island architecture).

## 0. NON-NEGOTIABLES

These Astro rules hold for every generated file. No exceptions.

- **MUST keep server-only code in the frontmatter fence, NEVER in client `<script>` tags.** Astro frontmatter runs at build/request time on the server; a `<script>` block runs in the browser. Mixing them leaks secrets and server-only imports.
- **MUST use `client:*` directives deliberately on framework components.** NEVER ship unnecessary JavaScript — MUST choose `client:idle` or `client:visible` over `client:load` unless the component requires immediate hydration on first paint, and NEVER add a `client:*` directive to a component that has no interactivity.
- **MUST use `class`, NEVER `className`, inside `.astro` files.** Island components (React/Vue/Svelte) use their own framework's attribute name.
- **MUST use `astro:assets` (`<Image>`, `<Picture>`) for images in `src/`.** NEVER use raw `<img>` for local images — the Image component optimizes on build. Remote images and images in `public/` remain raw `<img>`.
- **NEVER import a framework component without its integration declared in `astro.config.mjs`.** If a React/Vue/Svelte component is needed but the integration is missing, STOP AND ASK the user to install and configure it.

---

## 1. KEY REMINDERS

- `.astro` files produce ZERO JavaScript by default. All interactivity requires island components with `client:` directives.
- Use `class`, NEVER `className` in `.astro` files. Island components use their own framework's conventions.
- Astro 5+: content collections use `loader: glob(...)` in `content.config.ts`. The old `type: "content"` is legacy. `slug` is replaced by `id`.
- Astro 6: `Astro.glob()` is removed. Use `import.meta.glob()` instead.
- Use `@tailwindcss/vite` in `vite.plugins` for Tailwind v4 (NOT `@astrojs/tailwind`, which is deprecated).
- Use `astro:assets` for images (NOT `@astrojs/image`, which is removed).

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

| Concept         | Astro Syntax                                                  |
|-----------------|---------------------------------------------------------------|
| Dynamic import  | `import.meta.glob("./posts/*.md")` -- NOT `Astro.glob()` (removed in Astro 6) |
| Islands         | `<Component client:load />`, `client:visible`, `client:idle`, `client:only="react"` |
| Server defer    | `server:defer` -- defers server rendering, requires `output: "hybrid"` or `"server"` |
| Render content  | `import { render } from "astro:content"` -- NOT `entry.render()` (Astro 5+) |

---

## 3. FILE STRUCTURE CONVENTIONS

| Type                | Path                                      |
|---------------------|-------------------------------------------|
| Page                | `src/pages/index.astro`, `src/pages/about.astro` |
| Dynamic page        | `src/pages/posts/[slug].astro`            |
| API endpoint        | `src/pages/api/search.ts`                 |
| Layout              | `src/layouts/BaseLayout.astro`            |
| Static component    | `src/components/Header.astro`             |
| Island component    | `src/components/Counter.tsx` (or .vue/.svelte) |
| Content collection  | `src/content/blog/*.md`, `src/content.config.ts` (Astro 5+; was `src/content/config.ts`) |
| Public assets       | `public/`                                 |

---

## 4. DATA FETCHING PATTERNS

| Context                | Pattern                                                     |
|------------------------|-------------------------------------------------------------|
| Build-time fetch       | `const data = await fetch(url)` in frontmatter              |
| Content collection     | `const posts = await getCollection("blog")`                 |
| Dynamic params         | `export async function getStaticPaths() { ... }`            |
| SSR request-time       | `const data = await fetch(url)` (with `output: "server"`)  |
| Island data            | Use island framework's fetching (useQuery, onMount, etc.)   |

---

## 5. CLIENT / SERVER BOUNDARIES

Astro ships ZERO JavaScript by default. Everything is static HTML. Islands opt-in to JS:

| Directive            | When it hydrates                                    |
|----------------------|-----------------------------------------------------|
| `client:load`        | Immediately on page load                            |
| `client:idle`        | When browser becomes idle                           |
| `client:visible`     | When component scrolls into viewport                |
| `client:media="(q)"` | When CSS media query matches                        |
| `client:only="react"`| Client-render only, skip SSR entirely               |
| `server:defer`       | Defers server rendering; fetched after initial page load (requires `output: "hybrid"` or `"server"`) |

Rules:
- Default to `client:load` for above-the-fold interactive components
- Use `client:visible` for below-the-fold interactive components
- Use `client:idle` for non-critical interactive elements
- Use `client:only` when the component cannot run on the server
- If a component needs no interactivity, make it a `.astro` file instead
- Use `server:defer` for personalized/dynamic server content on otherwise static pages. Provide fallback via `<Fragment slot="fallback">Loading...</Fragment>`.

---

## 6. STYLING SYNTAX

| Method         | Syntax                                                     |
|----------------|-------------------------------------------------------------|
| Scoped style   | `<style>` block in `.astro` file (auto-scoped)              |
| Global style   | `<style is:global>` or import CSS in layout                 |
| Tailwind       | `class="flex items-center gap-2 text-sm"`                   |
| class:list     | `class:list={["base", { active: isActive }]}`               |

---

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

| Category           | Astro Libraries / Integrations                                |
|--------------------|---------------------------------------------------------------|
| integrations       | `@astrojs/react`, `@astrojs/vue`, `@astrojs/svelte`, `@astrojs/solid-js` |
| content            | `@astrojs/mdx`, `astro:content` (built-in)                   |
| image              | `astro:assets` (built-in) — `@astrojs/image` is REMOVED |
| sitemap            | `@astrojs/sitemap`                                            |
| tailwind (v4)      | `@tailwindcss/vite` in `vite.plugins` — NOT `@astrojs/tailwind` (deprecated) |
| ssr_adapter        | `@astrojs/node`, `@astrojs/vercel`, `@astrojs/cloudflare`    |
| component_library  | Depends on island framework (see framework-react/vue/svelte/solid) |
| icons              | `astro-icon`, or island framework icon libraries              |

The `island_framework` detected in `design-tokens.json` determines which component libraries apply for interactive islands. Check `astro.config.mjs` for installed integrations before adding new ones.

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.
