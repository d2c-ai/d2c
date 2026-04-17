# framework-vue-nuxt — Nuxt 3 patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "vue"` and `meta_framework = "nuxt"`. It defines exactly how the flow IR maps to Nuxt's file-based routing, shared layouts, Pinia state, and nav smoke test.

Keep this file parallel to `framework-react-next.md`. When a new section lands there, mirror it here.

---

## When this branch fires

- `design-tokens.json.framework === "vue"` and `meta_framework === "nuxt"`.
- Assumes Nuxt 3 + Vue 3 `<script setup>` idioms. Older Vue/Nuxt 2 projects are not supported by d2c-build-flow v1.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
layouts/
  onboarding.vue                    # shared shell (if layouts[] non-empty)
pages/
  onboarding/
    step-1.vue
    step-2.vue
    step-3.vue
stores/
  onboarding.ts                     # Pinia store (if shared_state[] non-empty)
components/
  onboarding/
    SharedShell.vue                 # reused from design-tokens.components[] when available
```

When pages use explicit routes outside the `flow_name` tree (e.g. `/signup`, `/signup/verify`), files go under those exact paths (`pages/signup/index.vue`, `pages/signup/verify.vue`, etc.). Each page still selects the `onboarding` layout via `definePageMeta`.

---

## Shared layout (`layouts/<flow_name>.vue`)

Emit when `flow-graph.layouts[]` is non-empty.

```vue
<!-- layouts/onboarding.vue -->
<script setup lang="ts">
import SharedShell from "~/components/onboarding/SharedShell.vue";
</script>

<template>
  <SharedShell>
    <slot />
  </SharedShell>
</template>
```

Each page opts in explicitly:

```vue
<!-- pages/onboarding/step-1.vue -->
<script setup lang="ts">
definePageMeta({ layout: "onboarding" });
</script>
```

Rules:
- `SharedShell` is the component identified by `layouts[].figma_node_id` via existing component-match scoring, or a newly generated component written to `components/<flow_name>/SharedShell.vue` when no reusable match exists.
- Follow the project's `conventions` exactly (`<script setup lang="ts">` is the Nuxt 3 default).
- Nuxt layouts are opt-in per page via `definePageMeta({ layout })`, so a page in an unrelated tree (`/settings`) stays unaffected.

---

## Shared state provider (`stores/<flow_name>.ts`)

Pinia is the canonical Nuxt state-management library. Emit one store per `shared_state[]` entry. The template branches on `persistence`.

### persistence = "memory" — in-memory Pinia store

```ts
// stores/onboarding.ts
import { defineStore } from "pinia";

export interface OnboardingData {
  // Generated from pages[].state_writes when present. Fallback: opaque record.
  email?: string;
  age?: number;
  newsletter?: boolean;
}

export const useOnboardingStore = defineStore("onboarding", {
  state: (): OnboardingData => ({}),
  actions: {
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      this[key] = value;
    },
    reset() {
      this.$reset();
    },
  },
});
```

### persistence = "session" — sessionStorage via `pinia-plugin-persistedstate`

Requires `pinia-plugin-persistedstate` to be in `preferred_libraries.state-persistence.selected`. If the project doesn't allow that plugin, fall back to the manual `watch` pattern in the "Manual sessionStorage fallback" block below — never install a library the user didn't select.

```ts
// stores/onboarding.ts
import { defineStore } from "pinia";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

export const useOnboardingStore = defineStore("onboarding", {
  state: (): OnboardingData => ({}),
  actions: {
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      this[key] = value;
    },
    reset() {
      this.$reset();
    },
  },
  persist: {
    storage: typeof window !== "undefined" ? sessionStorage : undefined,
    key: "OnboardingContext:v1",
  },
});
```

### Manual sessionStorage fallback (no plugin)

```ts
// stores/onboarding.ts
import { defineStore } from "pinia";
import { watch } from "vue";

const STORAGE_KEY = "OnboardingContext:v1";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

export const useOnboardingStore = defineStore("onboarding", () => {
  const data = reactive<OnboardingData>({});
  if (import.meta.client) {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(data, JSON.parse(raw));
    watch(data, (next) => sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)), {
      deep: true,
    });
  }
  function setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
    data[key] = value;
  }
  function reset() {
    Object.keys(data).forEach((k) => delete (data as any)[k]);
    if (import.meta.client) sessionStorage.removeItem(STORAGE_KEY);
  }
  return { data, setField, reset };
});
```

Rules:
- Key naming: `<FlowName>Context:v1`. Bump the version suffix if the typed shape changes.
- Read/write `sessionStorage` only on the client (`import.meta.client`) — Nuxt 3 runs `setup` on the server during SSR, where `sessionStorage` is undefined.

### persistence = "local" — localStorage with opt-in TTL

Mirrors the session variant but reads/writes `localStorage` and wraps each write in a TTL envelope when `shared_state[i].ttl_seconds` is set. Reads after expiry reset the store and drop the stored entry.

```ts
// stores/onboarding.ts
import { defineStore } from "pinia";
import { reactive, watch } from "vue";

const STORAGE_KEY = "OnboardingContext:v1";
const TTL_SECONDS: number | null = null; // generated from shared_state[i].ttl_seconds; null = never expire

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

interface StoredEnvelope {
  data: OnboardingData;
  expires_at: number | null;
}

export const useOnboardingStore = defineStore("onboarding", () => {
  const data = reactive<OnboardingData>({});

  if (import.meta.client) {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const envelope = JSON.parse(raw) as StoredEnvelope;
        if (envelope.expires_at !== null && Date.now() > envelope.expires_at) {
          localStorage.removeItem(STORAGE_KEY);
        } else if (envelope.data) {
          Object.assign(data, envelope.data);
        }
      } catch {
        // Corrupt entry — drop it.
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    watch(
      data,
      (next) => {
        const envelope: StoredEnvelope = {
          data: { ...next },
          expires_at:
            TTL_SECONDS === null ? null : Date.now() + TTL_SECONDS * 1000,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      },
      { deep: true }
    );
  }

  function setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
    data[key] = value;
  }
  function reset() {
    Object.keys(data).forEach((k) => delete (data as any)[k]);
    if (import.meta.client) localStorage.removeItem(STORAGE_KEY);
  }
  return { data, setField, reset };
});
```

Rules specific to `"local"`:
- Always emit the `{ data, expires_at }` envelope even when TTL is null — a future build that adds a TTL won't invalidate the storage key.
- TTL is sliding (refreshed on every write). Capture a first-write timestamp inside the envelope if you need a hard cap.
- The `pinia-plugin-persistedstate` variant above doesn't support TTL natively — use this setup-store form when the user requests `ttl_seconds`.

---

## Page files (`pages/<route>/index.vue`)

Each page is emitted by the existing `/d2c-build` Phase 3 codegen, plus the flow-specific link wiring.

```vue
<!-- pages/onboarding/step-1.vue -->
<script setup lang="ts">
definePageMeta({ layout: "onboarding" });

function goNext() {
  navigateTo("/onboarding/step-2");
}
</script>

<template>
  <section>
    <!-- rendered body from component-match + layout IR -->
    <Button @click="goNext">Next</Button>
  </section>
</template>
```

Rules:
- Prefer `<NuxtLink to="…">` for static navigation (better prefetch/accessibility). Use `navigateTo(…)` inside handlers — `router.push` works but `navigateTo` is the Nuxt 3 idiom (SSR-aware, type-safe).
- When `link_target.trigger === "onSubmit"`, wrap in `<form @submit.prevent="goNext">` and call `navigateTo` from the handler after validation.
- **No invented Next buttons.** If no component carries `link_target`, emit a TODO comment and leave the design untouched.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Playwright works identically on Vue/Nuxt projects. Use the same template as the Next.js variant — the test drives the browser, not the framework.

```ts
import { test, expect } from "@playwright/test";

const ROUTES = ["/onboarding/step-1", "/onboarding/step-2", "/onboarding/step-3"];

test("onboarding flow: every route resolves and renders", async ({ page }) => {
  for (const route of ROUTES) {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    expect(errors, `console errors on ${route}`).toEqual([]);
  }
});
```

Rules:
- The `playwright.flow.config.ts` template's `webServer.command` defaults to `npm run dev`. Nuxt projects conventionally run `nuxi dev` under `npm run dev`, so the default works; if the project's script is named differently, override in the config.
- When wiring the click-level test, the Playwright selector is the same (`page.getByRole("button", { name: /next|continue|proceed/i })`) — it matches DOM, not framework.

---

## Placement decisions

- **Layout:** Nuxt 3 layouts live in `layouts/<name>.vue` at the project root. Name is lowercase; pages opt in with `definePageMeta({ layout: "<name>" })`. Shared layouts for the longest common route prefix use the `flow_name` slug.
- **State:** Pinia stores live in `stores/<flow_name>.ts`. Nuxt auto-imports `useOnboardingStore` — do not write explicit `import` statements inside pages unless the project disables auto-imports.
- **Shared components:** `components/<flow_name>/SharedShell.vue` when freshly generated. Nuxt auto-registers every component in `components/` — collision with a file elsewhere in the tree triggers a build warning, so keep the name distinct.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

When a page's `page_type === "overlay"`, emit a standalone component at `components/<flow_name>/overlays/<Name>.vue` and import it inside the `overlay_parent` page. The open state travels in the URL as `?<overlay_query_param>=<slug>`:

```vue
<!-- components/onboarding/overlays/ConfirmOverlay.vue -->
<script setup lang="ts">
const route = useRoute();
const router = useRouter();
const OVERLAY_PARAM = "overlay";
const OVERLAY_SLUG = "confirm";

const isOpen = computed(() => route.query[OVERLAY_PARAM] === OVERLAY_SLUG);

function close() {
  const { [OVERLAY_PARAM]: _drop, ...rest } = route.query;
  router.replace({ path: route.path, query: rest });
}
</script>

<template>
  <div v-if="isOpen" role="dialog" aria-modal="true" @click="close">
    <div @click.stop>
      <!-- overlay body -->
      <button @click="close">Close</button>
    </div>
  </div>
</template>
```

Open-overlay edges navigate via `navigateTo({ path: route.path, query: { ...route.query, overlay: slug } }, { replace: true })`. Overlays are NEVER routable pages — no `pages/.../<name>.vue` for them.

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `edges[].is_loop === true` re-entry cycles exist, the Playwright nav test must cap visits per route with a `Map<string, number>` counter so the cycle terminates. The validator no longer rejects cycles.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

For a branch page (out-degree > 1 in `flow-graph.edges[]`), emit one handler per outgoing edge — each wired to the Figma component named in `edges[i].source_component_node_id`.

```vue
<!-- pages/onboarding/step-2.vue -->
<script setup lang="ts">
definePageMeta({ layout: "onboarding" });

function goPathA() { navigateTo("/onboarding/step-3a"); }
function goPathB() { navigateTo("/onboarding/step-3b"); }
</script>

<template>
  <section>
    <Button @click="goPathA">Path A</Button>
    <Button @click="goPathB">Path B</Button>
  </section>
</template>
```

Rules:
- One `navigateTo(...)` per outgoing edge. Declarative `<NuxtLink to="…">` also works for static branches and gives better accessibility — prefer it when the branch is always-available.
- Every branch MUST resolve to a distinct Figma component (non-null `source_component_node_id`). Validator rejects the graph otherwise.
- Navigation smoke test emits **one click-level assertion per outgoing edge**.
