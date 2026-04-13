# Vue 3 / Nuxt 3 Code Generation Rules

Loaded when: `package.json` contains `vue` or `nuxt`.
These rules are ADDITIVE to the universal rules in SKILL.md.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the patterns in this file for stylistic decisions (export style, file naming, import ordering, barrel exports). This file remains authoritative for framework-specific syntax requirements (`<script setup>`, Composition API, `<template>`, `class` attribute, Vue directives).

## 0. NON-NEGOTIABLES

These Vue 3 / Nuxt 3 rules hold for every generated file. No exceptions.

- **MUST use `<script setup lang="ts">` + Composition API.** NEVER emit Options API for new code. NEVER mix `<script setup>` and plain `<script>` in the same SFC.
- **NEVER use `.value` inside `<template>`.** Vue automatically unwraps refs in templates. Writing `{{ count.value }}` instead of `{{ count }}` is a bug.
- **MUST use `class`, NEVER `className`.** Vue uses the native HTML `class` attribute.
- **MUST use `defineModel()` for v-model bindings in Vue 3.4+.** NEVER hand-roll the prop + emit pair when `defineModel()` is available.
- **NEVER use React hooks (`useEffect`, `useState`).** Vue has no `useEffect`. Use `watch`, `watchEffect`, `ref`, `reactive`, or `onMounted`.

---

## 1. KEY REMINDERS

- Always use `<script setup lang="ts">` with Composition API. Never use Options API for new code.
- Use `class` (never `className`). Use `defineModel()` for v-model instead of manual prop+emit.
- Never use `useEffect` -- Vue has no `useEffect`. Use `watch`, `watchEffect`, or `onMounted`.

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

- Reactive props destructure (3.5+): `const { title, disabled = false } = defineProps<Props>()` -- reactivity preserved automatically, no `toRefs` needed
- defineModel (3.4+): `const modelValue = defineModel<string>()` -- two-way binding macro, replaces manual prop + emit pattern for v-model
- useTemplateRef (3.5+): `const el = useTemplateRef<HTMLInputElement>('input')` -- preferred over `ref()` for DOM refs
- Typed emits: `defineEmits<{ select: [item: string] }>()`

## 3. FILE STRUCTURE CONVENTIONS

Nuxt 3 (auto-imports enabled):
- Nuxt 4 moves app code into `app/` directory (e.g., `app/pages/`, `app/components/`). Check for `app/` before generating paths.
- If project has `app/` directory with pages/components inside, use `app/` prefix for all paths below.
- Pages: `pages/index.vue`, `pages/dashboard.vue`, `pages/users/[id].vue`
- Components: `components/` (auto-imported), `components/ui/` for primitives
- Composables: `composables/` (auto-imported, prefix files with `use`)
- Server API: `server/api/users.get.ts`, `server/api/users.post.ts`
- Layouts: `layouts/default.vue`
- Middleware: `middleware/auth.ts`
- Plugins: `plugins/`
- Public assets: `public/`

Standalone Vue 3 (Vite):
- Pages/views: `src/views/` or `src/pages/`
- Components: `src/components/`, `src/components/ui/`
- Composables: `src/composables/`
- Router: `src/router/index.ts`
- Store: `src/stores/`

## 4. DATA FETCHING PATTERNS

| Context                | Pattern                                                     |
|------------------------|-------------------------------------------------------------|
| Nuxt simple            | `const { data, pending, error } = useFetch('/api/users')`  |
| Nuxt complex           | `const { data } = useAsyncData('users', () => $fetch('/api/users', { query: { page } }))` |
| Nuxt server route      | `server/api/users.get.ts` exports `defineEventHandler()`   |
| Vue Query              | `const { data } = useQuery({ queryKey: ['users'], queryFn })` |
| No library fallback    | `onMounted(async () => { data.value = await fetch(...) })`  |

- Nuxt 4+: `useFetch` / `useAsyncData` return `shallowRef` data by default. Add `deep: true` for deep reactivity.
- `getCachedData` option on `useAsyncData` controls SPA-navigation caching.

## 5. CLIENT / SERVER BOUNDARIES

- No `"use client"` or `"use server"` directives. Never add them.
- Vue/Nuxt components hydrate automatically after SSR.
- Client-only rendering: `<ClientOnly><MyWidget /></ClientOnly>`
- Server-only components: name file `MyComponent.server.vue` (Nuxt 3)
- Server-only logic: place in `server/` directory (Nuxt)
- Environment check: `import.meta.client` / `import.meta.server` (Nuxt 3)
- Never use `process.client` / `process.server` — these are deprecated. Always use `import.meta.client` / `import.meta.server`.
- Vapor Mode (experimental): do NOT enable unless explicitly requested — it changes the rendering pipeline and is not yet stable.

## 6. STYLING SYNTAX

| Method          | Syntax                                                       |
|-----------------|--------------------------------------------------------------|
| Tailwind        | `class="flex gap-4"`                                         |
| Dynamic classes | `:class="{ 'bg-blue-500': isActive, 'opacity-50': disabled }"` |
| Array syntax    | `:class="['base', condition ? 'extra' : '']"`                |
| Scoped styles   | `<style scoped>` (preferred)                                 |
| CSS Modules     | `<style module>` with `:class="$style.name"`                 |

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

- state_management: `pinia` (recommended), `vuex` (legacy only)
- data_fetching: `@tanstack/vue-query`, `ofetch`, `axios`
- forms: `vee-validate`, `formkit`, `@tanstack/vue-form`
- icons: `lucide-vue-next`, `@iconify/vue`, `unplugin-icons`
- animation: `@vueuse/motion`, `gsap`, `<Transition>` (built-in)
- component_library: `shadcn-vue`, `reka-ui (formerly radix-vue)`, `@nuxt/ui`, `vuetify`, `primevue`, `naive-ui`, `element-plus`, `quasar`
- composables: `@vueuse/core` (essential utility composables)
- tables: `@tanstack/vue-table`, `ag-grid-vue3`
- charts: `vue-chartjs`, `vue-echarts`
- toast: `vue-sonner`, `vue-toastification`
- dnd: `vuedraggable`, `@vueuse/integrations` (useSortable)

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.

---

## Library Boundary Values (SVG Chart Libraries)

Some libraries accept color/style values as string props, not CSS classes or variables. SVG-based chart libraries (vue-chartjs, @nivo/core, d3) require hex/rgb strings because the SVG renderer does not resolve CSS custom properties at the attribute level.

**Pattern: Resolve CSS variables at runtime with `computed` + `onMounted`.**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'

function resolveTokenColor(tokenVar: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(tokenVar)
    .trim() || '#000000'
}

const chartColors = ref({ primary: '#000000' })
onMounted(() => {
  chartColors.value = {
    primary: resolveTokenColor('--colors-primary'),
  }
})
</script>
```

**When runtime resolution is not feasible**, hardcoding is acceptable but MUST include a comment linking the value to its token:

```vue
<!-- Token: colors.primary (#2563EB) — hardcoded for SVG chart compatibility -->
<Bar :fill="'#2563EB'" />
```

These values are **exempt from the Phase 5 hardcoded-values audit** (bucket A) because the library API requires them.
