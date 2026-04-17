# framework-react-next — Next.js App Router patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "react"` and `meta_framework = "next"` and the repo uses the App Router. It defines exactly how the flow IR maps to Next.js App Router file layout, navigation, shared layout, shared state, and nav smoke test.

Keep this file parallel to `framework-react-next-pages.md`, `framework-vue-nuxt.md`, and `framework-sveltekit.md`. When a new section lands here, mirror it to the other three.

---

## When this branch fires

- `design-tokens.json.framework === "react"` and `meta_framework === "next"`.
- The project uses the App Router (a top-level `app/` directory exists **and** no `conventions.router === "pages"` override is set).
- The legacy Pages Router variant lives in `framework-react-next-pages.md` — Phase 3's branch table selects that file when a top-level `pages/` directory is detected.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
app/
  onboarding/
    layout.tsx                       # shared shell (if layouts[] non-empty)
    _state/
      OnboardingContext.tsx          # provider + typed hook (if shared_state[] non-empty)
    step-1/
      page.tsx                       # generated from pages[0]
    step-2/
      page.tsx
    step-3/
      page.tsx
```

When pages use explicit routes outside the `flow_name` tree (e.g. `/signup`, `/signup/verify`), files go under those exact paths (`app/signup/page.tsx`, `app/signup/verify/page.tsx`, etc.). `layout.tsx` and `_state/` are emitted at the longest common route prefix.

---

## Shared layout (`layout.tsx`)

Emit when `flow-graph.layouts[]` is non-empty. One layout file per `layouts[]` entry, nested to the correct route prefix.

```tsx
import type { ReactNode } from "react";
import { OnboardingProvider } from "./_state/OnboardingContext";
// + imports for the shared shell component reused from design-tokens.components[]
// or generated as a new component inside _components/

type Props = {
  children: ReactNode;
};

export default function OnboardingLayout({ children }: Props) {
  return (
    <OnboardingProvider>
      <SharedShell>{children}</SharedShell>
    </OnboardingProvider>
  );
}
```

Rules:
- Only wrap in the provider when `shared_state[]` is non-empty.
- `SharedShell` is the component identified by `layouts[].figma_node_id` via existing component-match scoring, or a newly generated component written to `app/<flow_name>/_components/SharedShell.tsx` when no reusable match exists.
- The layout file respects the project's `conventions` (declaration style, export style, import ordering) the same way `/d2c-build` does.

---

## Shared state provider (`_state/<FlowName>Context.tsx`)

Emit when `flow-graph.shared_state[]` is non-empty. One module per state slice. The template branches on `shared_state[i].persistence`.

### persistence = "memory" — in-memory only

```tsx
"use client";

import { createContext, useContext, useState, useMemo } from "react";
import type { ReactNode } from "react";

type OnboardingData = {
  // See B-FLOW-STATE-TYPED-FIELDS: when the parser captures `state:` directives
  // per step, this type is generated from the merged field dictionary. Otherwise
  // fall back to an opaque record.
  [key: string]: unknown;
};

type OnboardingContextValue = {
  data: OnboardingData;
  setField: (key: string, value: unknown) => void;
  reset: () => void;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<OnboardingData>({});
  const value = useMemo<OnboardingContextValue>(
    () => ({
      data,
      setField: (key, val) => setData((prev) => ({ ...prev, [key]: val })),
      reset: () => setData({}),
    }),
    [data]
  );
  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  }
  return ctx;
}
```

### persistence = "session" — sessionStorage, SSR-safe

```tsx
"use client";

import { createContext, useContext, useState, useMemo, useEffect } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "OnboardingContext:v1";

type OnboardingData = {
  [key: string]: unknown;
};

type OnboardingContextValue = {
  data: OnboardingData;
  setField: (key: string, value: unknown) => void;
  reset: () => void;
  isHydrated: boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function readInitial(): OnboardingData {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OnboardingData) : {};
  } catch {
    return {};
  }
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  // Start empty on every SSR render to keep server/client markup identical.
  const [data, setData] = useState<OnboardingData>({});
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setData(readInitial());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated || typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore quota or serialisation errors — state still lives in memory.
    }
  }, [data, isHydrated]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      data,
      setField: (key, val) => setData((prev) => ({ ...prev, [key]: val })),
      reset: () => {
        setData({});
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(STORAGE_KEY);
        }
      },
      isHydrated,
    }),
    [data, isHydrated]
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  }
  return ctx;
}
```

Rules:
- Always mark `"use client"` — state lives in the browser.
- The storage key is `<FlowName>Context:v1`. Bump the version suffix whenever the typed shape changes so stale entries don't poison a new build.
- Never read `window.sessionStorage` during render; SSR renders fail. Read inside `useEffect` only, and gate with `typeof window !== "undefined"`.
- Export both the provider and the hook; the page files import the hook.

### persistence = "local" — localStorage with opt-in TTL

Mirrors the session variant but persists across tabs/reloads until either `reset()` is called or the optional `shared_state[i].ttl_seconds` window elapses. When a TTL is set, every write is timestamped inside an envelope `{ data, expires_at }` so a stale entry is silently discarded on mount.

```tsx
"use client";

import { createContext, useContext, useState, useMemo, useEffect } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "OnboardingContext:v1";
const TTL_SECONDS: number | null = null; // generated from shared_state[i].ttl_seconds; null = never expire

type OnboardingData = {
  [key: string]: unknown;
};

type StoredEnvelope = {
  data: OnboardingData;
  expires_at: number | null;
};

type OnboardingContextValue = {
  data: OnboardingData;
  setField: (key: string, value: unknown) => void;
  reset: () => void;
  isHydrated: boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function readInitial(): OnboardingData {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const envelope = JSON.parse(raw) as StoredEnvelope;
    if (envelope.expires_at !== null && Date.now() > envelope.expires_at) {
      window.localStorage.removeItem(STORAGE_KEY);
      return {};
    }
    return envelope.data ?? {};
  } catch {
    return {};
  }
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<OnboardingData>({});
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setData(readInitial());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated || typeof window === "undefined") return;
    try {
      const envelope: StoredEnvelope = {
        data,
        expires_at:
          TTL_SECONDS === null ? null : Date.now() + TTL_SECONDS * 1000,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Ignore quota or serialisation errors — state still lives in memory.
    }
  }, [data, isHydrated]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      data,
      setField: (key, val) => setData((prev) => ({ ...prev, [key]: val })),
      reset: () => {
        setData({});
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      },
      isHydrated,
    }),
    [data, isHydrated]
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboarding must be used inside <OnboardingProvider>");
  }
  return ctx;
}
```

Rules specific to `"local"`:
- Always wrap stored data in `{ data, expires_at }` so the TTL decision is local to the read path — even when `ttl_seconds` is null, keep the envelope shape stable so future builds can add a TTL without invalidating the storage key.
- TTL is refreshed on every write (sliding expiration). If you need a hard ceiling ("expires N seconds after first write"), capture the first-write timestamp in the envelope instead.
- Users typically use `"local"` for resumable onboarding/KYC flows; reset explicitly when the flow completes so a fresh run doesn't rehydrate into a stale step.

### Typed state interface — when `state:` directives are declared

When any `pages[].state_writes` is populated (from the Phase 1 `state:` directive), replace the opaque `Record<string, unknown>` shape above with a concrete interface derived from the union of all writer fields, and emit a per-key typed `setField` signature instead of the untyped one:

```tsx
// Generated from pages[].state_writes:
//   page 1: state: email:string
//   page 2: state: age:number, newsletter:boolean
type OnboardingData = {
  email?: string;
  age?: number;
  newsletter?: boolean;
};

type OnboardingContextValue = {
  data: OnboardingData;
  setField: <K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) => void;
  reset: () => void;
};
```

Rules:
- Every field is optional (`?:`) — a page reading another page's key before the writer runs will get `undefined`, not a type error.
- Field types come from the parsed `type` in `state_writes[]`. Merge across all pages (same key written with the same type on multiple pages is fine; a type collision aborts Phase 2a with `F-FLOW-STATE-TYPE-UNSUPPORTED`).
- The per-key setter signature means a downstream page that writes `setField("email", 42)` becomes a compile error — the typed shape is the contract.
- When no `state_writes` exist but `shared_state[]` was requested by other means (e.g. explicit user ask), fall back to the `Record<string, unknown>` shape above.

---

## Page files (`<route>/page.tsx`)

Each page is emitted by the existing `/d2c-build` Phase 3 codegen, exactly as it would be for a single-page build, with one flow-specific addition: **link wiring**.

For every interactive node in `component-match.json` that carries a non-null `link_target.page_node_id`, codegen wires the handler:

```tsx
"use client";

import { useRouter } from "next/navigation";
// ... existing imports for the page's components/tokens

export default function OnboardingStep1() {
  const router = useRouter();
  return (
    <section>
      {/* ... rendered body from component-match + layout IR ... */}
      <Button onClick={() => router.push("/onboarding/step-2")}>Next</Button>
    </section>
  );
}
```

Rules:
- When `link_target.trigger === "onClick"`, attach to the component's `onClick` prop.
- When `link_target.trigger === "onSubmit"`, the button must live inside a `<form onSubmit={...}>`; codegen wraps in a form if one doesn't already exist.
- When a page has shared state, the handler reads/writes `useOnboarding()` before navigation if the button is inside a form region detected in Phase 2a.
- **No auto-generated Next buttons.** If no component has a `link_target` and the edge is `inferred: true`, emit a `// TODO(d2c-flow): wire a Next button for edge <from> → <to>` comment at the end of the return block and leave the design untouched.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Emit alongside the flow, e.g. `app/onboarding/flow-navigation.spec.ts` (or `tests/flow/onboarding-navigation.spec.ts` if the project uses a tests directory — fall back to the former when no test directory convention is detected).

```ts
import { test, expect, type Page } from "@playwright/test";

const ROUTES = [
  "/onboarding/step-1",
  "/onboarding/step-2",
  "/onboarding/step-3",
];

test("onboarding flow: every route resolves and renders", async ({ page }) => {
  for (const route of ROUTES) {
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    expect(errors, `console errors on ${route}`).toEqual([]);
  }
});

// Click-level assertions only for wired edges. Inferred edges are skipped here
// — the URL-level test above still runs for them.
test("onboarding flow: wired Next buttons navigate correctly", async ({ page }) => {
  // generated per wired edge:
  // await page.goto("/onboarding/step-1");
  // await page.getByRole("button", { name: /next|continue|proceed/i }).click();
  // await expect(page).toHaveURL("/onboarding/step-2");
});
```

Rules:
- Always emit the URL-level loop over every page route.
- **Iterate `flow-graph.edges[]`** to generate click-level blocks. For each edge where `source_component_node_id` is non-null (a wired Next button, or a wired branch), emit one click-level assertion inside the second test. Branch pages (out-degree > 1) naturally produce multiple assertions — one per outgoing edge — which is how the nav test proves each branch navigates correctly.
- When every edge is inferred and unwired, still emit the second `test` with a comment explaining why it's empty. Do not mark it `.skip` — the first test alone is the primary regression signal.
- If the project has no existing Playwright config at the repo root (no `playwright.config.ts` / `.js` / `.mjs`), also emit `playwright.flow.config.ts` at the repo root from the template at `skills/d2c-build-flow/references/playwright.flow.config.ts.template`. The template includes a `webServer` block so `npx playwright test -c playwright.flow.config.ts` starts `npm run dev` automatically. If an existing Playwright config is detected, do NOT overwrite it — fall back to `npx playwright test <spec-path>` and document the dev-server requirement in the report.

---

## Placement decisions

- **Layout prefix:** longest common prefix of all page routes. For `[/a, /a/b, /a/c]` the layout lives at `app/a/layout.tsx`. For `[/x, /y]` no shared layout is emitted (there is no meaningful prefix).
- **State provider:** placed inside the layout directory as `_state/`. The leading underscore tells Next this is not a routable segment.
- **Shared components:** placed inside `_components/` sibling to `_state/` when newly generated. Reused components keep their existing paths from `design-tokens.components[]`.

---

## Mobile variants (B-FLOW-MOBILE-VARIANT)

When a page carries `mobile_variant` in `flow-graph.json`, Phase 4 verifies both viewports and Phase 3 emits **one** responsive component instead of two separate components. The mobile frame provides layout/spacing guidance — never its own JSX tree.

### Codegen contract

1. The component tree stays single-source. Mobile-only differences (stacked vs. side-by-side, hidden CTA, resized hero) MUST be expressed with design-token-aware media queries or utility classes, not by branching on `useMediaQuery` or duplicating `<section>`s.
2. Default to the project's `preferred_libraries.styling.selected` breakpoints. If the project uses Tailwind, prefer `sm:` / `md:` utility classes from `design-tokens.json.breakpoints`. If CSS Modules, emit `@media (max-width: var(--bp-md))` blocks. Never hardcode pixel breakpoints.
3. The component's JSX mirrors the **desktop** frame's component-match IR. Mobile-only placement tweaks become className variants or inline style map entries keyed off the breakpoint token.
4. Responsive variants for reused design-system components (Button, Input, Card) are left to the design system — do NOT shim per-page media queries on top of a DS component.

### Verification contract (Phase 4)

Phase 4 runs pixel-diff **twice** per page:
- Desktop viewport (matches the Figma frame export).
- Mobile viewport at a width derived from the mobile Figma frame's `absoluteBoundingBox` (rounded to the nearest 8px).

Both must pass the per-page threshold. A desktop-pass / mobile-fail pair stays failed and enters the Phase 4 auto-fix loop.

### Report

Phase 6 per-page table gains an extra column when any page has a `mobile_variant`: `Mobile %` next to `Pixel-diff %`. Desktop-only pages show `—`.

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `flow-graph.edges[]` contains `is_loop: true` edges (re-entry cycles — e.g. a "Did you mean…?" page linking back to step 2), the flow graph validator accepts cycles as legal topology. The generated Playwright nav smoke test must cap visits per route so the test still terminates:

```ts
const MAX_VISITS_PER_ROUTE = 3;
const visits = new Map<string, number>();

async function visitBounded(page: Page, route: string) {
  const count = (visits.get(route) ?? 0) + 1;
  visits.set(route, count);
  expect(count, `revisit count for ${route}`).toBeLessThanOrEqual(MAX_VISITS_PER_ROUTE);
  await page.goto(route);
}
```

Rules:
- One counter per test — do not share counters across tests, state leaks and the assertion becomes nondeterministic.
- Loop edges still contribute click-level assertions; they just assert the revisit URL and bump the counter.
- When codegen builds the page file for a loop edge, the click handler calls `router.push(<target-route>)` the same way a linear edge does — loop semantics live in the test and the user's mental model, not in the component.

---

## Conditional navigation (B-FLOW-CONDITIONAL-NAV)

When an edge carries a non-null `condition`, codegen wraps the navigation in a state check. The condition is evaluated at click time against the shared-state slice — never against props or server data.

Supported shapes (from `flow-graph.edges[].condition`):

| `kind` | Meaning | Generated guard |
|---|---|---|
| `state-equals` | `data[field] === value` | `if (data[field] === <value>)` |
| `state-truthy` | `Boolean(data[field])` | `if (data[field])` |
| `state-falsy`  | `!Boolean(data[field])` | `if (!data[field])` |

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useOnboarding } from "../_state/OnboardingContext";

export default function OnboardingStep2() {
  const router = useRouter();
  const { data } = useOnboarding();

  function goNext() {
    // edges[i].condition = { kind: "state-equals", field: "plan", value: "pro" }
    if (data.plan === "pro") {
      router.push("/onboarding/step-3-pro");
      return;
    }
    // fallback: edges[j].condition = null (always fires)
    router.push("/onboarding/step-3-free");
  }

  return (
    <section>
      <Button onClick={goNext}>Next</Button>
    </section>
  );
}
```

Rules:
- Always read `data` via the typed hook (`useOnboarding` / `useFlow` / …) so the generated TS catches field typos.
- Emit the unconditional fallback LAST so the first matching condition wins. If the author wants a "none-of-the-above" branch, they must declare it explicitly — codegen doesn't invent one.
- When a branch page has conditional + unconditional edges mixed, treat the unconditional edge as the `else` arm; the validator rejects more than one unconditional outgoing edge on a branch page when conditions are present.
- The nav smoke test prepopulates state via `page.evaluate` (setting `sessionStorage`/`localStorage`) before clicking, then asserts the expected URL for each branch.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

When `flow-graph.pages[]` contains a page with `page_type: "overlay"`, the overlay is rendered as a modal inside its `overlay_parent` page rather than at its own route. Open/close state travels in the URL as `?<overlay_query_param>=<overlay-slug>` so deep-linking and the back button work correctly.

### Overlay component (`<parent-route>/_overlays/<OverlayName>.tsx`)

Each overlay is generated as a standalone client component. It reads its own open state from the URL:

```tsx
"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

const OVERLAY_PARAM = "overlay"; // generated from pages[i].overlay_query_param
const OVERLAY_SLUG = "confirm";  // last path segment of the overlay's route

export function ConfirmOverlay() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const isOpen = searchParams.get(OVERLAY_PARAM) === OVERLAY_SLUG;
  if (!isOpen) return null;

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(OVERLAY_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div role="dialog" aria-modal="true" onClick={close}>
      <div onClick={(e) => e.stopPropagation()}>
        {/* rendered body from the overlay's component-match */}
        <button onClick={close}>Close</button>
      </div>
    </div>
  );
}
```

### Parent page — mounting the overlay

The parent page mounts the overlay unconditionally; the overlay decides itself whether to render:

```tsx
import { ConfirmOverlay } from "./_overlays/ConfirmOverlay";

export default function CheckoutStep2() {
  return (
    <section>
      {/* ... rendered body ... */}
      <ConfirmOverlay />
    </section>
  );
}
```

### Open-overlay edge (`edges[i].action === "open-overlay"`)

Each `open-overlay` edge becomes an `onClick` handler on the source component that appends `?overlay=<slug>` to the current URL via `router.push` (or `router.replace` when you want no history entry):

```tsx
function openConfirm() {
  const params = new URLSearchParams(searchParams.toString());
  params.set(OVERLAY_PARAM, OVERLAY_SLUG);
  router.push(`${pathname}?${params.toString()}`);
}
```

### Close-overlay edge (`edges[i].action === "close-overlay"`)

Buttons inside the overlay whose prototype connection has `action = "close-overlay"` call the `close()` helper above. The Playwright nav smoke test asserts the overlay opens (URL gains `?overlay=<slug>`, overlay body visible), then closes (URL no longer has the param, overlay body removed).

Rules:
- Overlays are NEVER routable pages. Do not emit a `page.tsx` for an overlay node — the overlay lives inside its `overlay_parent`.
- The overlay slug is the last path segment of the overlay page's `route` (e.g. a `route` of `/checkout/step-2/confirm` yields slug `confirm`).
- Use `router.replace` on close if you don't want the overlay toggle to pollute the back-button stack.
- When multiple overlays exist on a single parent, each uses the same `overlay_query_param` but a distinct slug; only one can be open at a time.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

When `flow-graph.edges[]` contains multiple outgoing edges from the same `from_node_id` (a branch page like `Step 3a` / `Step 3b`), emit one click handler per outgoing edge. Each handler wires to the Figma component identified in `edges[i].source_component_node_id` and pushes the corresponding `to_node_id` page's route.

```tsx
"use client";

import { useRouter } from "next/navigation";

export default function OnboardingStep2() {
  const router = useRouter();
  return (
    <section>
      {/* … rendered body from component-match + layout IR … */}
      {/* Wired from edges[k] where source_component_node_id points at this button */}
      <Button onClick={() => router.push("/onboarding/step-3a")}>Path A</Button>
      <Button onClick={() => router.push("/onboarding/step-3b")}>Path B</Button>
    </section>
  );
}
```

Rules:
- Iterate `edges[]` filtered by `from_node_id === <this page's node_id>`. Codegen's outgoing-edge loop here replaces the single-target `link_target` handling used in linear flows.
- Every branch MUST resolve to a distinct Figma component — the validator enforces non-null `source_component_node_id` for every outgoing edge of a branch page. If the wiring was manual, the author needs to provide the id before Phase 3.
- Navigation smoke test: emit **one click-level assertion per outgoing edge** (not per page). See §"Navigation smoke test" for the generator shape.

---

## Stepper groups (single-route multi-step)

When `flow-graph.stepper_groups[]` contains one or more entries, each group renders as a **single-route stepper**: one URL, one shared shell (header + progress indicator + footer), and the body swaps in place as the user clicks Next/Back. No route change between steps; history entries per step so browser-back undoes a step.

Fires when `flow-graph.mode === "stepper"` (whole flow is one group) or `"hybrid"` (groups mixed with standalone routes).

### Output shape

For `stepper_groups[0] = { name: "Onboarding", route: "/onboarding", steps: [{ title: "Email" }, { title: "Verify" }, { title: "Profile" }], validation_enabled: false, persistence: "session" }`:

```
app/
  onboarding/
    page.tsx                         # the stepper page — lives at the group's route
    _steps/
      StepEmail.tsx                  # one file per stepper step (named by title)
      StepVerify.tsx
      StepProfile.tsx
    _state/
      OnboardingContext.tsx          # provider owning currentStep + shared form state
    _components/                     # existing — any stepper-specific shared bits
```

For `mode: hybrid` the stepper group coexists with standalone `page.tsx` files under sibling or nested routes (e.g. `app/signup/page.tsx` + `app/signup/verify/page.tsx`).

### State provider

The stepper provider extends the existing shared-state shape with `currentStep` and, when `validation_enabled: true`, per-step validity flags. Persistence mirrors [§Shared state provider](#shared-state-provider-_statesflownamecontexttsx) — emit `useState` when `validation_enabled: false`, `useReducer` when `true`.

```tsx
// app/onboarding/_state/OnboardingContext.tsx
"use client";

import { createContext, useContext, useReducer, useState, useEffect, ReactNode } from "react";

type OnboardingData = {
  email: string;
  name: string;
  // …fields from stepper_groups[0].steps[*].state_writes
};

type OnboardingCtx = {
  data: OnboardingData;
  currentStep: number;
  totalSteps: number;
  setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]): void;
  next(): void;
  back(): void;
  goTo(index: number): void;
  reset(): void;
  stepValidity: boolean[];        // only when validation_enabled
  markStepValid(i: number, valid: boolean): void; // only when validation_enabled
};

const Ctx = createContext<OnboardingCtx | null>(null);

// session-persistence example — same pattern as the non-stepper provider.
const STORAGE_KEY = "d2c.onboarding";
const TOTAL_STEPS = 3;

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<OnboardingData>(() => {
    if (typeof window === "undefined") return { email: "", name: "" };
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { email: "", name: "" };
    } catch {
      return { email: "", name: "" };
    }
  });
  const [currentStep, setCurrentStep] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const raw = window.sessionStorage.getItem(STORAGE_KEY + ":step");
    return raw ? Math.min(parseInt(raw, 10) || 0, TOTAL_STEPS - 1) : 0;
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, [data]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY + ":step", String(currentStep));
    } catch {}
  }, [currentStep]);

  function setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) {
    setData((d) => ({ ...d, [key]: value }));
  }
  function goTo(index: number) {
    const clamped = Math.max(0, Math.min(TOTAL_STEPS - 1, index));
    setCurrentStep(clamped);
    // Browser history entry per step — browser-back undoes a step.
    window.history.pushState({ step: clamped }, "", window.location.pathname);
  }
  function next() { goTo(currentStep + 1); }
  function back() { goTo(currentStep - 1); }
  function reset() { setData({ email: "", name: "" }); setCurrentStep(0); }

  return (
    <Ctx.Provider
      value={{
        data,
        currentStep,
        totalSteps: TOTAL_STEPS,
        setField,
        next,
        back,
        goTo,
        reset,
        stepValidity: [],            // expand when validation_enabled=true
        markStepValid: () => {},
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useOnboarding() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOnboarding must be used inside OnboardingProvider");
  return ctx;
}
```

When `validation_enabled: true`, swap `useState` for a `useReducer` with actions `SET_FIELD`, `SET_VALID`, `NEXT`, `BACK`, `GOTO`, `RESET`. Next() must refuse to advance when `stepValidity[currentStep] !== true`.

### Page file

```tsx
// app/onboarding/page.tsx
"use client";

import { useEffect } from "react";
import { OnboardingProvider, useOnboarding } from "./_state/OnboardingContext";
import StepEmail from "./_steps/StepEmail";
import StepVerify from "./_steps/StepVerify";
import StepProfile from "./_steps/StepProfile";
// Shared shell component — detected via flow-graph.stepper_groups[0].shell_component_node_id
import OnboardingShell from "@/components/OnboardingShell";

const STEP_TITLES = ["Email", "Verify", "Profile"];

function OnboardingStepperBody() {
  const { currentStep, totalSteps, next, back, goTo } = useOnboarding();

  // browser-back: intercept popstate to update step instead of leaving the flow.
  useEffect(() => {
    function onPop(e: PopStateEvent) {
      const step = e.state && typeof e.state.step === "number" ? e.state.step : 0;
      if (step < currentStep) back();
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [currentStep, back]);

  // Focus the first focusable element inside the body region each time the
  // step advances. Screen readers announce the new step.
  useEffect(() => {
    const body = document.querySelector<HTMLElement>("[data-stepper-body]");
    if (!body) return;
    const focusable = body.querySelector<HTMLElement>(
      "input, select, textarea, button, [tabindex]:not([tabindex='-1'])"
    );
    focusable?.focus();
  }, [currentStep]);

  const stepContent = [
    <StepEmail key="email" />,
    <StepVerify key="verify" />,
    <StepProfile key="profile" />,
  ][currentStep];

  return (
    <OnboardingShell
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepTitles={STEP_TITLES}
    >
      <div
        role="region"
        aria-labelledby={`stepper-title-${currentStep}`}
        data-stepper-body
      >
        <h2 id={`stepper-title-${currentStep}`} className="sr-only">
          Step {currentStep + 1} of {totalSteps}: {STEP_TITLES[currentStep]}
        </h2>
        {stepContent}
      </div>

      <div className="stepper-footer">
        <button type="button" onClick={back} disabled={currentStep === 0}>
          Back
        </button>
        <button type="button" onClick={next}>
          {currentStep === totalSteps - 1 ? "Finish" : "Next"}
        </button>
      </div>
    </OnboardingShell>
  );
}

export default function OnboardingPage() {
  return (
    <OnboardingProvider>
      <OnboardingStepperBody />
    </OnboardingProvider>
  );
}
```

Where the shell component `OnboardingShell` reads `flow-graph.stepper_groups[0].stepper_indicator.variants_per_page` so the progress-indicator node renders the correct variant at each step. When no indicator component was detected, the fallback renders a plain `Step N of M` text label that honours `aria-current="step"` on the active item.

### Step components

Each `_steps/Step<Title>.tsx` is its own component. Wire form fields to `useOnboarding().setField(key, value)` and, when the step has `validate: form`, call `markStepValid(currentStep, <boolean>)` on every field change.

```tsx
// app/onboarding/_steps/StepEmail.tsx
"use client";

import { useOnboarding } from "../_state/OnboardingContext";

export default function StepEmail() {
  const { data, setField } = useOnboarding();
  return (
    <form>
      <label>
        Email
        <input
          type="email"
          value={data.email}
          onChange={(e) => setField("email", e.target.value)}
        />
      </label>
    </form>
  );
}
```

### Next/Back wiring via `pick-link-target.js`

For each step, Phase 2b calls `pick-link-target` with `stepDelta: +1` (Next button) and `stepDelta: -1` (Back button). The returned `edge_kind === "step_delta"` tells codegen to wire the button's `onClick` to `next()` / `back()` from the provider — not to `router.push`.

Edge-kind dispatch in codegen is a one-liner per button:

```tsx
if (link_target.edge_kind === "step_delta") {
  // stepper-internal edge
  return <Button onClick={link_target.step_delta > 0 ? next : back}>{label}</Button>;
}
// route edge — leaves the stepper
return <Button onClick={() => router.push(link_target.route)}>{label}</Button>;
```

### Accessibility contract (non-optional)

Every stepper output MUST:
1. Set `aria-current="step"` on the active indicator element inside the shell.
2. Wrap the swappable body in `role="region"` with `aria-labelledby` pointing at a per-step heading that includes the step index and total.
3. Move focus to the first focusable element inside the body on each step change.
4. Provide a visible "Step N of M" label (text, not colour-only).

The codegen template above satisfies 1–4 by default. Skips are still legal — `optional: true` steps render a Skip button that calls `next()` without running validation.

### Verification (Phase 4 and 4b)

- **Phase 4 pixel diff**: drive the stepper via Playwright with a single `page.goto("/onboarding")`, then `click('button:has-text("Next")')` between screenshots. Screenshot only the `[data-stepper-body]` region; mask the shared shell bbox in both the Figma export and the rendered screenshot (`mask_regions[]` in flow-graph). Compare each step's body to the corresponding `stepper_groups[0].steps[i]` Figma frame.
- **Phase 4b smoke test**: replace the route loop with a stepper driver. Example:

```ts
test("onboarding stepper advances through all steps", async ({ page }) => {
  await page.goto("/onboarding");
  for (let i = 0; i < 3; i++) {
    await expect(page.getByText(`Step ${i + 1} of 3`)).toBeVisible();
    if (i < 2) await page.getByRole("button", { name: /next/i }).click();
  }
  // final step's Next navigates to the post-flow route (or reloads to step 0)
});
```

For `mode: hybrid`, emit one stepper-style block per group and one route-style block per standalone page, joined in the same spec file.

### Shared-shell interaction

When `stepper_groups[i].shell_component_node_id` resolves to a design-system component present in `design-tokens.components[]`, reuse it via import. When not, generate a local `_components/OnboardingShell.tsx` from the shell's IR. Either way the shell receives `currentStep`, `totalSteps`, and `stepTitles` props so the progress indicator stays in sync with the provider.

### Non-negotiables

- The stepper page itself MUST NOT call `router.push` for internal step changes. Use the provider's `next()`/`back()` so state and history stay consistent.
- Form data persists across step changes — never unmount the provider between steps; `_steps/Step*.tsx` components unmount/mount, but `page.tsx` stays mounted for the life of the flow.
- `reset()` is called automatically after the final step if the last step's Next button has `link_target.edge_kind === "route"` (exit edge), so revisiting the stepper route starts fresh unless persistence is `local`.
