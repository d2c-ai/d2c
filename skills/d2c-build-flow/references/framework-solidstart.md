# framework-solidstart — SolidStart patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "solid"` and `meta_framework = "solidstart"`. It defines how the flow IR maps to SolidStart's file-based routing, nested layouts, signal/store-based state, and nav smoke test.

Targets **SolidStart 1.x + Solid 1.8+** idioms: `createSignal`/`createStore`, the `Router`/`Route` config from `@solidjs/router`, and `<A>` / `useNavigate` for navigation.

Keep this file parallel to `framework-react-next.md`. When a section lands there, mirror it here.

---

## When this branch fires

- `design-tokens.json.framework === "solid"` and `meta_framework === "solidstart"`.
- Assumes SolidStart 1.x with the `@solidjs/router` package. Bare Solid projects (no SolidStart) still work but must wire their own router — Phase 3 assumes SolidStart conventions.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
src/
  routes/
    onboarding.tsx                    # layout (if layouts[] non-empty)
    onboarding/
      step-1.tsx
      step-2.tsx
      step-3.tsx
  lib/
    state/
      onboarding.ts                   # signal-based state store (if shared_state[] non-empty)
    components/
      onboarding/
        SharedShell.tsx               # reused or generated
```

SolidStart nests layouts automatically when the route folder (`src/routes/onboarding/`) has a sibling file of the same name (`src/routes/onboarding.tsx`). Pages inside the folder render as children of the layout.

---

## Shared layout (`src/routes/<flow_name>.tsx`)

```tsx
import type { RouteSectionProps } from "@solidjs/router";
import { SharedShell } from "~/lib/components/onboarding/SharedShell";

export default function OnboardingLayout(props: RouteSectionProps) {
  return <SharedShell>{props.children}</SharedShell>;
}
```

Rules:
- Layouts are default-exported route components whose `props.children` is the nested route output.
- `SharedShell` is the component identified via component-match scoring, or a newly generated component under `src/lib/components/<flow_name>/SharedShell.tsx` when no reusable match exists.

---

## Shared state provider (`src/lib/state/<flow_name>.ts`)

SolidStart idiom: a reactive store created at module scope. Emit one module per `shared_state[]` entry. The template branches on `persistence`.

### persistence = "memory" — createStore at module scope

```ts
import { createStore } from "solid-js/store";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

const [state, setState] = createStore<OnboardingData>({});

export function useOnboarding() {
  return {
    data: state,
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      setState(key, value as any);
    },
    reset() {
      setState({} as OnboardingData);
    },
  };
}
```

### persistence = "session" — sessionStorage, SSR-safe

```ts
import { createStore } from "solid-js/store";
import { isServer } from "solid-js/web";
import { createEffect } from "solid-js";

const STORAGE_KEY = "OnboardingContext:v1";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

function readInitial(): OnboardingData {
  if (isServer) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OnboardingData) : {};
  } catch {
    return {};
  }
}

const [state, setState] = createStore<OnboardingData>(readInitial());

if (!isServer) {
  createEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota errors — state still lives in memory.
    }
  });
}

export function useOnboarding() {
  return {
    data: state,
    setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
      setState(key, value as any);
    },
    reset() {
      setState({} as OnboardingData);
      if (!isServer) sessionStorage.removeItem(STORAGE_KEY);
    },
  };
}
```

### persistence = "local" — localStorage with opt-in TTL

Same pattern as `session` but read/write `localStorage` and wrap each write in a `{ data, expires_at }` envelope when `ttl_seconds` is set. Reads after expiry return `{}` and drop the entry.

Rules:
- Gate every storage access with `isServer` from `solid-js/web` — SolidStart SSR runs modules on the server during build + request.
- Keep the store at module scope so every page imports the same instance. Creating the store inside `useOnboarding()` would give every caller its own state.
- Key naming: `<FlowName>Context:v1`.

---

## Page files (`src/routes/<flow_name>/step-N.tsx`)

```tsx
import { useNavigate } from "@solidjs/router";
import { useOnboarding } from "~/lib/state/onboarding";

export default function OnboardingStep1() {
  const navigate = useNavigate();
  const { setField } = useOnboarding();

  function goNext() {
    navigate("/onboarding/step-2");
  }

  return (
    <section>
      {/* rendered body from component-match + layout IR */}
      <button type="button" onClick={goNext}>Next</button>
    </section>
  );
}
```

Rules:
- `useNavigate()` from `@solidjs/router` for imperative navigation. Prefer the `<A href="...">` component for static links — it prefetches and intercepts clicks.
- Solid event syntax is `onClick` (camelCase, like React). Do NOT emit `on:click` (Svelte-style) or `(click)` (Angular).
- **No invented Next buttons.** Emit a `{/* TODO(d2c-flow): wire a Next button for edge <from> → <to> */}` comment when `link_target` is absent.
- When `link_target.trigger === "onSubmit"`, wrap in `<form onSubmit={(e) => { e.preventDefault(); goNext(); }}>`.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Playwright drives the browser, not Solid. Same template as the React reference.

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
- SolidStart's dev command is `npm run dev` (Vinxi under the hood), matching the default `playwright.flow.config.ts.template`.

---

## Placement decisions

- **Layout:** `src/routes/<flow_name>.tsx` sibling to `src/routes/<flow_name>/`. The filename-plus-folder pairing is what triggers SolidStart's nested-layout detection.
- **State:** `src/lib/state/<flow_name>.ts`. Module-scoped store, singleton per server/client boundary.
- **Shared components:** `src/lib/components/<flow_name>/` for flow-specific shared components. Reused components keep their existing paths.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

```tsx
import { useNavigate } from "@solidjs/router";

export default function OnboardingStep2() {
  const navigate = useNavigate();
  return (
    <section>
      <button type="button" onClick={() => navigate("/onboarding/step-3a")}>Path A</button>
      <button type="button" onClick={() => navigate("/onboarding/step-3b")}>Path B</button>
    </section>
  );
}
```

Rules:
- One `navigate(...)` per outgoing edge. Every branch MUST resolve to a distinct Figma component (non-null `source_component_node_id`).
- Nav smoke test emits one click-level assertion per outgoing edge.

---

## Conditional navigation (B-FLOW-CONDITIONAL-NAV)

```tsx
function goNext() {
  if (data.plan === "pro") {
    navigate("/onboarding/step-3-pro");
    return;
  }
  navigate("/onboarding/step-3-free");
}
```

The condition is evaluated inline against the imported state — same shape as the React reference.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

Overlay pages render as child components inside the `overlay_parent` page. Use `useSearchParams` from `@solidjs/router` to reflect open state in the URL:

```tsx
import { useSearchParams } from "@solidjs/router";

export function ConfirmOverlay() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isOpen = () => searchParams.overlay === "confirm";

  function close() {
    setSearchParams({ overlay: undefined }, { replace: true });
  }

  return (
    <>
      {isOpen() && (
        <div role="dialog" aria-modal="true" onClick={close}>
          <div onClick={(e) => e.stopPropagation()}>
            {/* overlay body */}
            <button type="button" onClick={close}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
```

Open-overlay edges call `setSearchParams({ overlay: "confirm" }, { replace: true })`. Overlays are never routable — do not create a `step-N/overlay.tsx` file.

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `edges[].is_loop === true`, the Playwright nav test caps visits per route using a `Map<string, number>` counter — identical pattern to the React reference.

---

## Mobile variants (B-FLOW-MOBILE-VARIANT)

One component tree, token-driven media queries in the page's CSS module (or inline `<style>` tag when the project uses scoped styles). Prefer token breakpoints from `design-tokens.json.breakpoints` over hardcoded pixel values.
