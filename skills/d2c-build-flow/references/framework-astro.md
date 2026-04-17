# framework-astro — Astro patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "astro"` and `meta_framework = "astro"`. Astro is primarily a static-first framework; flow semantics land differently than in React/Vue/Solid.

Targets **Astro 4.x** with the View Transitions API enabled. Static Astro pages handle URL-level navigation natively, but shared state + interactive overlays require a client island from one of the supported frameworks (React, Vue, Svelte, Solid). The flow skill emits client islands in whichever framework the project's `preferred_libraries.interactive-islands.selected` names.

Keep this file parallel to `framework-react-next.md`. When a section lands there, mirror it here.

---

## When this branch fires

- `design-tokens.json.framework === "astro"` and `meta_framework === "astro"`.
- Assumes Astro 4.x. View Transitions are preferred for flow navigation UX but not required.

If `preferred_libraries.interactive-islands.selected` is not set but a page has `shared_state[]` writers or branching logic, **STOP AND ASK** which framework to use for interactivity — do not silently pick React.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
src/
  layouts/
    OnboardingLayout.astro            # shared shell (if layouts[] non-empty)
  pages/
    onboarding/
      step-1.astro
      step-2.astro
      step-3.astro
  components/
    onboarding/
      SharedShell.astro               # reused or generated
      StateProvider.tsx               # client island for shared state (framework = preferred_libraries.interactive-islands.selected)
```

Astro uses file-based routing under `src/pages/`. Shared layouts are `.astro` components imported by each page.

---

## Shared layout (`src/layouts/<FlowName>Layout.astro`)

```astro
---
// src/layouts/OnboardingLayout.astro
import { ClientRouter } from "astro:transitions";
import SharedShell from "~/components/onboarding/SharedShell.astro";
---
<html lang="en">
  <head>
    <ClientRouter />
    <slot name="head" />
  </head>
  <body>
    <SharedShell>
      <slot />
    </SharedShell>
  </body>
</html>
```

Each page imports the layout explicitly:

```astro
---
// src/pages/onboarding/step-1.astro
import OnboardingLayout from "~/layouts/OnboardingLayout.astro";
---
<OnboardingLayout>
  <!-- rendered body -->
</OnboardingLayout>
```

Rules:
- `<ClientRouter />` from `astro:transitions` enables View Transitions for all pages rendered inside the layout. Flow navigations feel instant and preserve scroll/state for persistent elements.
- Astro's `<slot />` is the children insertion point. Use named slots only when the design calls for multiple distinct regions (header/footer).

---

## Shared state provider (`src/components/<flow_name>/StateProvider.tsx`)

Astro itself has no reactive state — shared state MUST live inside a client island of a framework the project selected. The island emits a persistence layer (`session` / `local`) that mirrors the React / Vue / Svelte / Solid variants documented in their respective framework-*.md files.

### Wiring the island

Mark the state provider island with `client:load` (it must be active on every route it wraps):

```astro
---
// layouts/OnboardingLayout.astro
import { OnboardingProvider } from "~/components/onboarding/StateProvider";
---
<OnboardingProvider client:load>
  <SharedShell>
    <slot />
  </SharedShell>
</OnboardingProvider>
```

If `shared_state[]` is empty, skip the island entirely — adding one for no reason introduces hydration cost.

When the selected framework is React, generate the island per `framework-react-next.md` §"Shared state provider" but drop the `"use client"` directive (Astro scopes client behaviour via the `client:*` directive on the island import).

---

## Page files (`src/pages/<flow_name>/step-N.astro`)

Static Astro pages link between steps with plain `<a href="…">` — URL-level navigation is handled by the browser. With `<ClientRouter />` enabled, those links become View Transitions automatically.

```astro
---
// src/pages/onboarding/step-1.astro
import OnboardingLayout from "~/layouts/OnboardingLayout.astro";
---
<OnboardingLayout>
  <section>
    <!-- rendered body from component-match + layout IR -->
    <a href="/onboarding/step-2" class="button">Next</a>
  </section>
</OnboardingLayout>
```

Rules:
- Prefer `<a href="…">` for linear flow navigation. The browser handles it; View Transitions make it feel SPA-like.
- Use a client island (React/Vue/Svelte/Solid button component) only when:
  - The nav requires branching on shared state (B-FLOW-CONDITIONAL-NAV), or
  - The nav must also call `setField` before navigating (form submission), or
  - The button is inside an overlay that needs interactivity.
- **No invented Next buttons.** If a component-match node has no `link_target`, emit an HTML comment `<!-- TODO(d2c-flow): wire a Next button for edge <from> → <to> -->` and leave the rendered body untouched.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Playwright works identically. Same URL-iteration template as the React reference.

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
- Astro's default dev command is `npm run dev` (Vite + Astro CLI), matching the default `playwright.flow.config.ts.template`.
- View Transitions may delay assertions by 100–300ms. Prefer `await expect(page.locator(...)).toBeVisible()` over `page.waitForSelector` — Playwright auto-waits and the transition does not block visibility checks.

---

## Placement decisions

- **Layout:** `src/layouts/<FlowName>Layout.astro`. Astro's layouts are plain `.astro` components imported by each page; there is no folder-scoped layout convention.
- **State:** `src/components/<flow_name>/StateProvider.tsx` (or `.vue` / `.svelte` / `.tsx` in the Solid case). Mounted once per route via `client:load` in the layout.
- **Shared components:** `src/components/<flow_name>/` for flow-specific shared components. Reused components keep their existing paths.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

Static branches become N `<a href>` tags in the page. State-dependent branching (B-FLOW-CONDITIONAL-NAV) requires a client island:

```astro
---
// src/pages/onboarding/step-2.astro
import OnboardingLayout from "~/layouts/OnboardingLayout.astro";
---
<OnboardingLayout>
  <section>
    <a href="/onboarding/step-3a" class="button">Path A</a>
    <a href="/onboarding/step-3b" class="button">Path B</a>
  </section>
</OnboardingLayout>
```

Rules:
- Static branches prefer `<a>` tags — better a11y, no hydration cost, View Transitions still fire.
- Dynamic branches (condition reads shared state) fall back to a framework island whose `onClick` / `@click` handler calls the imperative navigation API.

---

## Conditional navigation (B-FLOW-CONDITIONAL-NAV)

Only expressible through a client island. Cannot be done in pure Astro since Astro pages are static at request time. Emit a framework-native button component using the island's framework and wire the condition as in its framework-*.md reference.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

Overlays MUST be client islands (pure Astro has no reactive open/close state). Mount the overlay component in the `overlay_parent` page with `client:load`:

```astro
<OnboardingLayout>
  <section>
    <!-- page body -->
    <ConfirmOverlay client:load />
  </section>
</OnboardingLayout>
```

The overlay component is emitted in the framework selected by `preferred_libraries.interactive-islands.selected`. Open state lives in `URLSearchParams` so View Transitions preserve it correctly across navigations.

---

## Loops (B-FLOW-LOOP-SUPPORT)

`is_loop: true` edges reduce to plain `<a href>` re-links in Astro — the browser handles re-entry, and View Transitions replay cleanly. The nav smoke test still caps visits per route with a `Map<string, number>` counter to guarantee termination.

---

## Mobile variants (B-FLOW-MOBILE-VARIANT)

Astro pages use plain CSS (scoped `<style>` blocks inside the `.astro` component). Emit token-driven `@media` queries against `design-tokens.json.breakpoints` — never duplicate components for mobile/desktop.
