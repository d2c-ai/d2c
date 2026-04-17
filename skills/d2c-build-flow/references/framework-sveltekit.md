# framework-sveltekit — SvelteKit patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "svelte"` and `meta_framework = "sveltekit"`. It defines exactly how the flow IR maps to SvelteKit's filesystem router, nested layouts, store-based state, and nav smoke test.

Targets **Svelte 5 + SvelteKit 2** idioms (runes: `$state`, `$derived`; `{@render children()}` for slots). Never emit Svelte 4 patterns (`export let`, `$:` reactive, `<slot />`, `on:click`) — those are anti-patterns here; the project's `d2c-build` counterpart enforces the same rule.

Keep this file parallel to `framework-react-next.md`. When a new section lands there, mirror it here.

---

## When this branch fires

- `design-tokens.json.framework === "svelte"` and `meta_framework === "sveltekit"`.
- Assumes SvelteKit 2 + Svelte 5. Svelte 4 projects are not supported by d2c-build-flow v1.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
src/
  routes/
    onboarding/
      +layout.svelte                # shared shell (if layouts[] non-empty)
      step-1/
        +page.svelte
      step-2/
        +page.svelte
      step-3/
        +page.svelte
  lib/
    stores/
      onboarding.ts                 # Svelte store (if shared_state[] non-empty)
    components/
      onboarding/
        SharedShell.svelte          # reused or generated
```

When pages use explicit routes outside the `flow_name` tree (e.g. `/signup`, `/signup/verify`), files go under those exact paths (`src/routes/signup/+page.svelte`, `src/routes/signup/verify/+page.svelte`, etc.). `+layout.svelte` is emitted at the longest common route prefix.

---

## Shared layout (`+layout.svelte`)

Emit when `flow-graph.layouts[]` is non-empty. SvelteKit nests layouts automatically — anything under `src/routes/onboarding/` inherits `src/routes/onboarding/+layout.svelte`.

```svelte
<!-- src/routes/onboarding/+layout.svelte -->
<script lang="ts">
  import SharedShell from "$lib/components/onboarding/SharedShell.svelte";
  let { children } = $props();
</script>

<SharedShell>
  {@render children()}
</SharedShell>
```

Rules:
- Use `$props()` + `{@render children()}` (Svelte 5). Never emit `<slot />` or `export let` — those are Svelte 4.
- `SharedShell` is the component identified by `layouts[].figma_node_id` via existing component-match scoring, or a newly generated component written to `src/lib/components/<flow_name>/SharedShell.svelte` when no reusable match exists.

---

## Shared state provider (`src/lib/stores/<flow_name>.ts`)

SvelteKit idiom: a typed `writable` store exported from `$lib/stores`. Emit one module per `shared_state[]` entry. The template branches on `persistence`.

### persistence = "memory" — in-memory writable store

```ts
// src/lib/stores/onboarding.ts
import { writable } from "svelte/store";

export interface OnboardingData {
  // Generated from pages[].state_writes when present. Fallback: opaque record.
  email?: string;
  age?: number;
  newsletter?: boolean;
}

function createOnboardingStore() {
  const { subscribe, set, update } = writable<OnboardingData>({});
  return {
    subscribe,
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      update((prev) => ({ ...prev, [key]: value }));
    },
    reset() {
      set({});
    },
  };
}

export const onboarding = createOnboardingStore();
```

### persistence = "session" — sessionStorage-backed store

```ts
// src/lib/stores/onboarding.ts
import { writable } from "svelte/store";
import { browser } from "$app/environment";

const STORAGE_KEY = "OnboardingContext:v1";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

function readInitial(): OnboardingData {
  if (!browser) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OnboardingData) : {};
  } catch {
    return {};
  }
}

function createOnboardingStore() {
  const { subscribe, set, update } = writable<OnboardingData>(readInitial());

  if (browser) {
    subscribe((value) => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Ignore quota or serialisation errors — state still lives in memory.
      }
    });
  }

  return {
    subscribe,
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      update((prev) => ({ ...prev, [key]: value }));
    },
    reset() {
      set({});
      if (browser) sessionStorage.removeItem(STORAGE_KEY);
    },
  };
}

export const onboarding = createOnboardingStore();
```

Rules:
- Key naming: `<FlowName>Context:v1`. Bump the version suffix if the typed shape changes.
- Gate every `sessionStorage` access on `browser` (from `$app/environment`) — SvelteKit SSR runs the module on the server, where `sessionStorage` is undefined.
- Per-key typed `setField` signature so a typo at a caller becomes a compile error.

### persistence = "local" — localStorage with opt-in TTL

Mirrors the session variant but uses `localStorage` and wraps writes in a TTL envelope when `shared_state[i].ttl_seconds` is set. A read after expiry returns an empty object and deletes the stored entry.

```ts
// src/lib/stores/onboarding.ts
import { writable } from "svelte/store";
import { browser } from "$app/environment";

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

function readInitial(): OnboardingData {
  if (!browser) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const envelope = JSON.parse(raw) as StoredEnvelope;
    if (envelope.expires_at !== null && Date.now() > envelope.expires_at) {
      localStorage.removeItem(STORAGE_KEY);
      return {};
    }
    return envelope.data ?? {};
  } catch {
    return {};
  }
}

function createOnboardingStore() {
  const { subscribe, set, update } = writable<OnboardingData>(readInitial());

  if (browser) {
    subscribe((value) => {
      try {
        const envelope: StoredEnvelope = {
          data: value,
          expires_at:
            TTL_SECONDS === null ? null : Date.now() + TTL_SECONDS * 1000,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      } catch {
        // Ignore quota or serialisation errors — state still lives in memory.
      }
    });
  }

  return {
    subscribe,
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      update((prev) => ({ ...prev, [key]: value }));
    },
    reset() {
      set({});
      if (browser) localStorage.removeItem(STORAGE_KEY);
    },
  };
}

export const onboarding = createOnboardingStore();
```

Rules specific to `"local"`:
- Always emit the `{ data, expires_at }` envelope — even when TTL is null — so adding a TTL in a later build doesn't invalidate the existing key.
- TTL is sliding (refreshed on every write). Use a first-write timestamp in the envelope if you need a hard cap.
- Reset explicitly when the flow completes so a new run doesn't rehydrate into a stale step.

---

## Page files (`src/routes/<route>/+page.svelte`)

```svelte
<!-- src/routes/onboarding/step-1/+page.svelte -->
<script lang="ts">
  import { goto } from "$app/navigation";
  // ... existing imports for the page's components/tokens

  function goNext() {
    goto("/onboarding/step-2");
  }
</script>

<section>
  <!-- rendered body from component-match + layout IR -->
  <Button onclick={goNext}>Next</Button>
</section>
```

Rules:
- Use `goto(...)` from `$app/navigation` for programmatic navigation. For plain links, use `<a href="/path">` — SvelteKit intercepts clicks on internal links and does client-side routing automatically.
- Svelte 5 event syntax is `onclick`, not `on:click`. The `on:` colon form is Svelte 4 and MUST NOT appear in generated code.
- When `link_target.trigger === "onSubmit"`, wrap in `<form onsubmit={goNext}>` and call `preventDefault()` manually if needed; alternatively use SvelteKit's progressive-enhancement form handling when the project already uses it.
- **No invented Next buttons.** If no component carries `link_target`, emit a TODO comment and leave the design untouched.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Playwright runs identically against SvelteKit projects. Use the same template as the Next.js variant.

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
- The `playwright.flow.config.ts` template's `webServer.command` defaults to `npm run dev`. SvelteKit projects use Vite's `vite dev` under `npm run dev`, so the default works.
- Click-level test selectors match DOM: `page.getByRole("button", { name: /next|continue|proceed/i }).click()`.

---

## Placement decisions

- **Layout:** SvelteKit uses folder-local `+layout.svelte`. The layout lives at the longest common route prefix of the pages it serves.
- **State:** `src/lib/stores/<flow_name>.ts`. The `$lib` alias is baked into SvelteKit — never use relative imports across the lib boundary.
- **Shared components:** `src/lib/components/<flow_name>/`. Reused components keep their existing paths from `design-tokens.components[]`.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

When a page's `page_type === "overlay"`, emit a `.svelte` overlay component under `src/lib/components/<flow_name>/overlays/<Name>.svelte` and mount it inside the `overlay_parent` page. Open state is reflected in the URL as `?<overlay_query_param>=<slug>` so browser back/forward and deep-links work:

```svelte
<!-- src/lib/components/onboarding/overlays/ConfirmOverlay.svelte -->
<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";

  const OVERLAY_PARAM = "overlay";
  const OVERLAY_SLUG = "confirm";

  const isOpen = $derived($page.url.searchParams.get(OVERLAY_PARAM) === OVERLAY_SLUG);

  function close() {
    const url = new URL($page.url);
    url.searchParams.delete(OVERLAY_PARAM);
    goto(url.pathname + (url.search || ""), { replaceState: true });
  }
</script>

{#if isOpen}
  <div role="dialog" aria-modal="true" onclick={close}>
    <div onclick={(e) => e.stopPropagation()}>
      <!-- overlay body -->
      <button onclick={close}>Close</button>
    </div>
  </div>
{/if}
```

Open-overlay / close-overlay edges append or remove the query param via `goto(..., { replaceState: true })`. Overlays are never routable — do not emit a `+page.svelte` for an overlay node.

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `flow-graph.edges[]` contains `is_loop: true` edges (re-entry cycles like "Did you mean…?" → back to step 2), the nav smoke test must cap visits per route so the assertion terminates. Use a `Map<string, number>` counter and assert `count <= MAX_VISITS_PER_ROUTE` inside the URL-level loop.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

For a branch page (out-degree > 1 in `flow-graph.edges[]`), emit one handler per outgoing edge — each wired to the Figma component named in `edges[i].source_component_node_id`.

```svelte
<!-- src/routes/onboarding/step-2/+page.svelte -->
<script lang="ts">
  import { goto } from "$app/navigation";
  function goPathA() { goto("/onboarding/step-3a"); }
  function goPathB() { goto("/onboarding/step-3b"); }
</script>

<section>
  <Button onclick={goPathA}>Path A</Button>
  <Button onclick={goPathB}>Path B</Button>
</section>
```

Rules:
- One `goto(...)` per outgoing edge. Plain `<a href="…">` works for declarative branches and lets SvelteKit intercept the click itself.
- Svelte 5 event syntax `onclick` (not `on:click`).
- Every branch MUST resolve to a distinct Figma component (non-null `source_component_node_id`). Validator rejects the graph otherwise.
- Navigation smoke test emits **one click-level assertion per outgoing edge**.
