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
    state/
      OnboardingContext.tsx          # provider + typed hook (if shared_state[] non-empty)
    step-1/
      page.tsx                       # generated from pages[0]
    step-2/
      page.tsx
    step-3/
      page.tsx
```

When pages use explicit routes outside the `flow_name` tree (e.g. `/signup`, `/signup/verify`), files go under those exact paths (`app/signup/page.tsx`, `app/signup/verify/page.tsx`, etc.). `layout.tsx` and `state/` are emitted at the longest common route prefix.

---

## Shared layout (`layout.tsx`)

Emit when `flow-graph.layouts[]` is non-empty. One layout file per `layouts[]` entry, nested to the correct route prefix.

```tsx
import type { ReactNode } from "react";
import { OnboardingProvider } from "./state/OnboardingContext";
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

## Shared state provider (`state/<FlowName>Context.tsx`)

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
- **State provider:** placed inside the layout directory as `state/`. The folder name doesn't need an underscore prefix — it contains no `page.tsx`, so Next won't treat it as a route segment.
- **Shared components:** placed inside `_components/` sibling to `state/` when newly generated. Reused components keep their existing paths from `design-tokens.components[]`.

---

## State variants (loaded / loading / empty / error / initial)

When a page in `flow-graph.json` carries a `state_variants` block, codegen composes per-variant components using **whatever the project already does** — `flow_graph.project_conventions` decides the layout. This section is the authoritative spec for the two paths. If the flow has no `state_variants` (the identity case), skip the entire section.

### Shared rules (both paths)

- Every variant component is a **pure presentational component**. Its JSX and styling come from the Figma frame captured under the slot's `component-match.json`. It does NOT fetch data, track loading state, or compose routing.
- The `loaded` slot is today's primary render — no new component, no rewrite. The identity guarantee (P0.8) says a page with only `loaded` produces byte-identical output to the pre-state-variants pipeline.
- `empty` is **never** wrapped in a boundary. It is a data-driven branch inside the `loaded` component: `if (data.length === 0) return <DashboardEmpty />` at the top of the loaded JSX. The trigger is "data length is zero".
- `initial` is **never** wrapped in a boundary either. It is the pre-fetch / pre-action render — shown before any data request has been initiated or any user input has been given (e.g. a search page before the query is typed, a checkout step before Pay is clicked). Like `empty`, it is a data-driven branch at the top of the loaded JSX, but keyed off an **idle** condition sourced from `project_conventions.data_fetching.kind`:
  - `react-query` → `query.status === 'idle'` (or `fetchStatus === 'idle' && !data` when using `useQuery({ enabled: false })` patterns)
  - `swr` → `!data && !error && !isValidating` with the fetcher gated behind the feature-key (e.g. `useSWR(query ? key : null, fetcher)`)
  - `server-component-fetch` / `custom-hook` / `none` → an internal `hasRequested` boolean default-false, flipped to `true` on the user action that triggers the fetch
  Distinct from `loading` (fetch in flight) and `empty` (fetch completed, zero results). MUST NOT carry `aria-busy` — that attribute belongs to `loading` only. When both `initial` and `empty` are declared, the initial branch runs first (pre-fetch wins over post-fetch-empty).
- Variants live alongside the loaded page — no `states.tsx` bundle, no `<StateSwitch state={...}>`, no `PageState` discriminated union threaded through props.

### Path A — `project_conventions.component_type === "server"` AND `error_boundary.kind === "next-file-convention"`

Use Next.js App Router's built-in `loading.tsx` / `error.tsx` file conventions. The framework wires `<Suspense>` and the error boundary automatically — the flow only emits the files.

File layout per route (e.g. `/dashboard`):

```
app/dashboard/
  page.tsx        ← async Server Component (loaded + inline initial + empty branches)
  loading.tsx     ← Server Component, rendered while page.tsx suspends
  error.tsx       ← Client Component ('use client' required by Next.js)
  _initial.tsx    ← initial branch component (imported by page.tsx when declared)
  _empty.tsx      ← empty branch component (imported by page.tsx when declared)
```

`page.tsx` — loaded + initial + empty (Server Components typically fetch eagerly, so `initial` is rare here; it appears when a page takes `searchParams` that gate the fetch — e.g. `?q=` on a search route):

```tsx
import { getDashboardData } from '@/lib/dashboard';          // or detected data_fetching.example_import
import { DashboardInitial } from './_initial';
import { DashboardEmpty } from './_empty';

export default async function DashboardPage({ searchParams }: { searchParams: { q?: string } }) {
  // initial branch — fetch not yet triggered (no query param). Skip when `searchParams` isn't gating the fetch.
  if (!searchParams.q) return <DashboardInitial />;
  const data = await getDashboardData(searchParams.q);
  if (data.items.length === 0) return <DashboardEmpty />;
  return (
    <main>
      {/* loaded frame JSX from component-match.json */}
    </main>
  );
}
```

- If `state_variants.empty` is absent, drop the zero-length branch and the import entirely.
- If `state_variants.initial` is absent, drop the pre-fetch branch and the import entirely. When `initial` is present but the page is a plain Server Component with no gating prop, convert the page to a Client Component path (Path B) so the idle condition can come from the data-fetching hook.
- `_initial` / `_empty` are sibling files (underscore prefix keeps them off Next's router). Content comes from `variants/initial/component-match.json` and `variants/empty/component-match.json`.

`loading.tsx` — Server Component skeleton:

```tsx
// no 'use client' directive — Server Component renders during Suspense
export default function DashboardLoading() {
  return (
    <div aria-busy="true">
      {/* loading frame JSX from variants/loading/component-match.json */}
    </div>
  );
}
```

`error.tsx` — Client Component:

```tsx
'use client';
// Next.js reads default export; `error` + `reset` props are part of the file convention.
export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" aria-live="assertive">
      {/* error frame JSX from variants/error/component-match.json */}
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

- Prepend `'use client'` even if the project is mostly Server Components. Next.js refuses to treat a non-client `error.tsx` as an error boundary.
- The `error` prop is typed `Error` (or the project's `unknown` convention). The `reset` prop must be wired to a button or link — "Try again" is the default copy unless the Figma frame shows different text.
- When `state_variants.error.stub === true`, emit `ErrorStatePlaceholder` (see §"Error stub" below) as the default export.

### Path B — Client Components OR `error_boundary.kind !== "next-file-convention"`

Use inline composition inside `page.tsx`: `<Suspense>` for loading, the detected error-boundary for error. Fallback components live as sibling files with an `_` prefix.

File layout:

```
app/dashboard/
  page.tsx        ← composes <Suspense> + <ErrorBoundary>
  _loading.tsx    ← loading fallback (Client or Server depending on project convention)
  _empty.tsx      ← empty branch component (imported by whichever component owns the data)
  _error.tsx      ← error fallback
```

`page.tsx` — composition:

```tsx
'use client';                                                 // only if project convention is client
import { Suspense } from 'react';
import { ErrorBoundary } from '<import_path>';                // from project_conventions.error_boundary.import_path
import { DashboardLoaded } from './_loaded';                  // when Client projects split the loaded body out
import { DashboardLoading } from './_loading';
import { DashboardError } from './_error';

export default function DashboardPage() {
  return (
    <ErrorBoundary FallbackComponent={DashboardError}>
      <Suspense fallback={<DashboardLoading />}>
        <DashboardLoaded />
      </Suspense>
    </ErrorBoundary>
  );
}
```

- Import the exact specifier in `project_conventions.error_boundary.import_path`. For `react-error-boundary` that is literally `'react-error-boundary'`. For `custom-class`, use the relative path the detector recorded.
- Path B is required whenever `component_type === "client"` (Next.js client-only pages cannot use the file convention).
- For `data_fetching.kind === "react-query"`, `<Suspense>` fires via `useSuspenseQuery`. For `swr`, use `suspense: true`. For `custom-hook` / `none`, the hook must throw promises / errors on its own (document the expectation but don't synthesise the hook).

### Error stub (`state_variants.error.stub === true`)

When the user declared an error state without supplying a Figma URL, do NOT dispatch `/d2c-build`. Instead emit a placeholder directly from Phase 3:

```tsx
'use client';
import { useEffect } from 'react';

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[d2c] ERROR VARIANT NOT YET DESIGNED — /dashboard — replace with real content before shipping', error);
    }
  }, [error]);
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        border: '2px dashed crimson',
        padding: '1.5rem',
        fontFamily: 'monospace',
        background: 'none',
      }}
    >
      ERROR VARIANT NOT YET DESIGNED — /dashboard — replace with real content before shipping.
      <button onClick={reset} style={{ marginTop: '1rem' }}>Try again</button>
    </div>
  );
}
```

- The dashed border + monospace text + `console.warn` is intentionally obnoxious. The component must remain in the production bundle so reviewers catch it in visual QA — do NOT gate the render on `NODE_ENV`.
- When rendered under Path B, expose the stub as a named export `<PageName>ErrorPlaceholder` and import it into `page.tsx` as the `FallbackComponent`.
- The stub never runs through Phase 4 pixel-diff — the audit surfaces `stub_emitted: true` for the page instead (P1.4).

### Accessibility (P2.1)

State variants ship with live-region semantics so screen readers announce transitions between slots. Apply these rules in Phase 3; the Phase 5 audit rechecks them per variant and escalates to `<run-dir>/flow/audit.json` warnings (see §"Audit surface" in `SKILL.md`).

**Loading variant root:**
- Emit `aria-busy="true"` on the outermost rendered element of `<PageName>Loading` (or `<PageName>Step<N>Loading` in stepper form).
- If the Figma frame's root already has an ARIA role (e.g. from a design-system `Card` reused as the skeleton wrapper), preserve the role and set `aria-busy` alongside it — DO NOT overwrite the role.
- Do NOT add `aria-live` on loading roots — the Suspense fallback announces via the error/status channel already; adding it here produces double-announcement.

**Error variant root:**
- Emit `role="alert"` AND `aria-live="assertive"` on the outermost rendered element of `<PageName>Error`.
- When the Figma frame uses a design-system `Alert` / `Banner` component that already carries `role="alert"`, keep the DS component's role and layer `aria-live="assertive"` only if the DS component doesn't already declare one. Never emit nested `role="alert"` elements (double-wrapping is invalid and silent for most screen readers).
- Wire the "Try again" button (or the Figma frame's equivalent CTA) to the Next.js `reset` prop (Path A) or the ErrorBoundary `resetErrorBoundary` prop (Path B). An error variant with no recovery affordance is an accessibility hole — flag in audit.

**Empty variant root:**
- The component MUST include a semantic heading (`<h1>` or `<h2>`) announcing the zero-data scenario (e.g. "No items yet", "Nothing to show"). This is how screen-reader users discover that the page rendered an empty state rather than failing to load.
- Heading detection (Phase 3 self-check): inspect the `empty` variant's `component-match.json` for a node with `semantic_role: "heading"` or a Figma text style matching `design-tokens.typography` entries tagged `role: "heading"`. If none exists but the Figma frame has a text node sized ≥ the token value for `typography.h2.size`, promote it to an `<h2>`.
- If no heading candidate exists at all (empty frame is imagery only, or text is sub-heading size), emit a **visually hidden** `<h2 className="sr-only">` with copy derived from the variant's `trigger` (e.g. `trigger: "when the user has zero items"` → `<h2 className="sr-only">No items</h2>`), AND stage an audit warning on `flow_graph._pending_audit_warnings[]` for Phase 4 to persist: `{ kind: "a11y_missing_heading", route: "<route>", slot: "empty", node_id: "<empty variant node_id>", recommendation: "Add a visible heading to the empty frame in Figma (at or above typography.h2.size) or hand-edit the generated sr-only copy to match designer-approved text.", details: { reason: "no-heading-in-empty-frame" } }`. See SKILL.md §"Warnings surface (P2.4)" for the canonical shape and how Phase 4 drains the staged list into `audit.json.warnings[]`.

**Initial variant root:**
- MUST NOT emit `aria-busy` — the page is not busy, it is waiting for input or intent. Emitting `aria-busy` on an idle page lies to assistive tech.
- When the frame contains a visible call-to-action (search input, CTA button), preserve the semantic element (`<input>`, `<button>`) from the component-match IR — the initial render is often interactive.
- When the frame is purely informational ("Enter a query to begin"), emit a semantic heading (`<h1>`/`<h2>`) describing the affordance — same heading-detection logic as the empty variant above (promote the largest text node, or emit a visually hidden `<h2 className="sr-only">` derived from the Figma frame title if no text candidate exists).
- No `role="alert"` and no `aria-live` — the initial render is the page's first meaningful paint, not a status announcement.

**Stub variant:** the placeholder already emits `role="alert"` + `aria-live="assertive"` and its own retry button — no additional a11y work. The dashed border + monospace copy makes the stub visually distinct; do NOT suppress those in the name of polish.

**Audit hook:** for every variant file Phase 3 emits, re-scan the generated JSX for the expected attribute. A missing `aria-busy` on loading, missing `role="alert"` on error, or missing heading on empty stages the corresponding warning on `flow_graph._pending_audit_warnings[]` for Phase 4 to persist into `audit.json.warnings[]` (SKILL.md §"Warnings surface (P2.4)"). Do NOT regenerate the file — the audit channel surfaces the gap for human review; mechanical re-emission would churn a DS component whose role is already correct.

### File location summary

| Slot    | Path A (Server + Next file convention)     | Path B (Client or custom boundary)              |
|---------|---------------------------------------------|--------------------------------------------------|
| loaded  | `app/<route>/page.tsx`                     | `app/<route>/_loaded.tsx` (imported by page.tsx) |
| loading | `app/<route>/loading.tsx`                  | `app/<route>/_loading.tsx`                       |
| empty   | `app/<route>/_empty.tsx` (imported by page) | `app/<route>/_empty.tsx` (imported by loaded)   |
| initial | `app/<route>/_initial.tsx` (imported by page) | `app/<route>/_initial.tsx` (imported by loaded) |
| error   | `app/<route>/error.tsx` (`'use client'`)   | `app/<route>/_error.tsx`                        |

### Component naming

Per-variant components are named `<PageName><SlotPascal>`:
- `DashboardPage` (loaded — existing convention)
- `DashboardLoading`
- `DashboardEmpty`
- `DashboardInitial`
- `DashboardError`

For stepper-step variants (P1.1), add the step: `<GroupName>Step<N><SlotPascal>` (e.g. `OnboardingStep2Loading`).

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

### Mobile × state composition (P2.2)

Mobile variants and state variants MUST compose without an N×M explosion of Figma frames. The contract: **one `mobile_variant` per host, reused across every non-stub state slot.**

**Rules:**
1. `mobile_variant` lives on the host (`page` or `stepper_step`), NOT on an individual state slot. The IR never carries `state_variants.loading.mobile_variant` and codegen MUST NOT invent one.
2. Every non-stub state slot inherits the host's `mobile_variant` automatically — the same responsive rules from the `loaded` variant (media queries, utility classes, breakpoint tokens) carry over to `loading` / `empty` / `error` without a separate mobile frame per slot.
3. A slot-specific mobile layout is expressed as a CSS-only adjustment inside the slot's component, keyed off the same breakpoint token. If the loading skeleton needs a different mobile stack than the loaded body, emit a media query in `<PageName>Loading.module.css` (or the Tailwind utility equivalent) — do NOT ask the user for a second mobile Figma frame.
4. Stubs never render mobile-specific styling; the dashed placeholder is fixed-size by design.

**What to do when a slot's Figma frame diverges from loaded at mobile:**
- If the mobile divergence is purely spatial (stacked instead of side-by-side, collapsed action bar, hidden secondary copy), express it in the slot's stylesheet using the same breakpoint tokens the `loaded` variant uses. Copy the media-query structure from `<PageName>.module.css` / the utility string the loaded variant used, and apply it to the slot's root.
- If the mobile divergence is structural (entirely different JSX tree at mobile — e.g. a card grid loading skeleton becomes a single full-width bar on mobile), STOP and stage an audit warning on `flow_graph._pending_audit_warnings[]` for Phase 4 to persist: `{ kind: "missing_mobile_counterpart", route: "<route>", slot: "<slot>", node_id: "<slot variant node_id>", recommendation: "Provide a mobile Figma frame for the <slot> slot or hand-edit the generated responsive styles to match designer intent. Inheriting loaded's mobile structure won't reflect the designed mobile behaviour here.", details: { mobile_strategy: "inherit-from-loaded" } }`. Generate the desktop skeleton and note the divergence — never synthesise a made-up mobile skeleton. See SKILL.md §"Warnings surface (P2.4)" for the canonical shape.

**Verification (Phase 4):**
Phase 4's mobile pixel-diff pass runs once per non-stub variant at the mobile viewport derived from the host's `mobile_variant.absoluteBoundingBox`. The Figma screenshot compared against is the **loaded** frame's mobile export — divergent slots won't match pixel-for-pixel and MUST rely on the tokens-aware CSS adjustments to pass. If the mobile pixel-diff consistently fails on a non-loaded slot, the audit warning from rule 4 is the expected outcome — human review replaces the generated styles with designer-approved mobile copy.

**Identity guarantee:** a host WITHOUT `state_variants` (loaded-only) behaves exactly as today — one desktop + one mobile pixel-diff, no slot iteration. P0.8 identity gate holds.

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
import { useOnboarding } from "../state/OnboardingContext";

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
    steps/
      StepEmail.tsx                  # one file per stepper step (named by title)
      StepVerify.tsx
      StepProfile.tsx
    state/
      OnboardingContext.tsx          # provider owning currentStep + shared form state
    _components/                     # existing — any stepper-specific shared bits
```

For `mode: hybrid` the stepper group coexists with standalone `page.tsx` files under sibling or nested routes (e.g. `app/signup/page.tsx` + `app/signup/verify/page.tsx`).

### State provider

The stepper provider extends the existing shared-state shape with `currentStep` and, when `validation_enabled: true`, per-step validity flags. Persistence mirrors [§Shared state provider](#shared-state-provider-_statesflownamecontexttsx) — emit `useState` when `validation_enabled: false`, `useReducer` when `true`.

```tsx
// app/onboarding/state/OnboardingContext.tsx
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
import { OnboardingProvider, useOnboarding } from "./state/OnboardingContext";
import StepEmail from "./steps/StepEmail";
import StepVerify from "./steps/StepVerify";
import StepProfile from "./steps/StepProfile";
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
        data-stepper-step={currentStep}
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

**Each step body is generated by `/d2c-build` Phase 3, not by this template.** The flow's Phase 3 dispatches `/d2c-build` once per step in stepper-step mode (see `/d2c-build/SKILL.md` §"Stepper step mode") with the structured payload shape documented in `/d2c-build-flow/SKILL.md` §Phase 3 step 3. The result is a presentational component at `app/<group_route>/steps/Step<Title>.tsx` that:

- Has **no** `'use client'` directive of its own (the orchestrator owns it).
- Imports **no** stepper provider hook (`useOnboarding`, etc.) — all wiring flows through props.
- Implements the standard step prop contract `{ onNext, onBack, onValidityChange?, optional?, data?, setField? }`.

This delegation is the source of stepper-step parity with route pages: the same six non-negotiables (reuse, tokens, conventions, library selection, locked decisions, design-tokens drift) that protect every route page now protect every step body.

#### Step component prop contract

```ts
export type Step<Title>Props = {
  onNext: () => void;                                  // wired by orchestrator to provider.next()
  onBack: () => void;                                  // wired to provider.back(); first step renders disabled
  onValidityChange?: (valid: boolean) => void;         // wired to markStepValid(currentStep, valid) when validate: form
  optional?: boolean;                                  // mirrors stepper_groups[].steps[i].optional
  data?: { /* narrowed to step's state_writes */ };    // wired to provider.data
  setField?: <K extends keyof StepData>(key: K, value: StepData[K]) => void;
};

export default function Step<Title>(props: Step<Title>Props) {
  // /d2c-build emits the design's JSX here — Next button onClick={props.onNext},
  // Back button onClick={props.onBack}, form fields wired to props.data + props.setField,
  // validity reported via props.onValidityChange when stepper_step.validation_required.
}
```

#### Orchestrator → step wiring

The orchestrator (`page.tsx`, emitted by this template) owns the provider context and forwards everything as props:

```tsx
// app/onboarding/page.tsx — replaces the flat stepContent array shown above
const stepContent = [
  <StepEmail
    key="email"
    onNext={next}
    onBack={back}
    onValidityChange={(v) => markStepValid(0, v)}
    data={data}
    setField={setField}
  />,
  <StepVerify
    key="verify"
    onNext={next}
    onBack={back}
    onValidityChange={(v) => markStepValid(1, v)}
    data={data}
    setField={setField}
  />,
  <StepProfile
    key="profile"
    onNext={next}
    onBack={back}
    optional={true}
    data={data}
    setField={setField}
  />,
][currentStep];
```

The orchestrator never reads from inside a step body — the prop contract is the only interface. This keeps step bodies decoupled from the specific provider implementation, so a future provider rewrite (e.g. switching from `useState` to `useReducer` to Redux) doesn't ripple into any of the `/d2c-build`-generated step files.

#### Why the prop contract — not the provider hook

Earlier versions of this template had each step body import `useOnboarding()` directly. That coupled `/d2c-build`'s emission to the flow's specific provider name and shape, which prevented the cleanest delegation: `/d2c-build` would have had to know which flow was dispatching it. The prop-based contract removes that coupling — `/d2c-build` emits a generic component shape that the flow's orchestrator decorates. The downside is one extra wiring layer in the orchestrator (the JSX block above), and that's worth it for the parity guarantee.

### Per-step state variants

When `stepper_groups[i].steps[j].state_variants` is present, the step body gets Path-B-style boundary wiring — **never Path A**. Path A (Next.js `loading.tsx` / `error.tsx`) is per-route-segment and cannot target a specific step index inside a single-route stepper; the whole group lives at one URL. Cross-ref Path B details at [§Path B](#path-b--client-components-or-error_boundarykind--next-file-convention).

Ordering rule: declare variants only when the step's non-loaded state is materially different from the loaded body. A step that already handles empty via a zero-length data branch inside `StepEmail.tsx` does not need a separate `_empty.tsx` — keep it as an inline branch (principle 5).

File layout (extending the base stepper layout above):

```
app/onboarding/
  page.tsx
  steps/
    StepEmail.tsx                  # loaded body — unchanged
    StepVerify.tsx
    StepVerifyLoading.tsx          # only when steps[1].state_variants.loading is declared
    StepVerifyError.tsx            # only when steps[1].state_variants.error is declared
    StepVerifyEmpty.tsx            # prefer inline branch inside StepVerify.tsx; emit only
                                   # when the empty frame is materially different
    StepProfile.tsx
```

Naming: `<GroupName>Step<Title><SlotPascal>` where `<Title>` is the step's `title` field (same source that drives `steps/Step<Title>.tsx` today). Examples: `OnboardingStepVerifyLoading`, `OnboardingStepVerifyError`.

Composition inside `page.tsx` — wrap only the step indices that declare variants; leave others unwrapped so identity holds for steps without variants:

```tsx
// app/onboarding/page.tsx — excerpt, replaces the flat `stepContent` array above
import { Suspense } from 'react';
import { ErrorBoundary } from '<import_path>';     // from project_conventions.error_boundary.import_path
import StepEmail from './steps/StepEmail';
import StepVerify from './steps/StepVerify';
import StepVerifyLoading from './steps/StepVerifyLoading';
import StepVerifyError from './steps/StepVerifyError';
import StepProfile from './steps/StepProfile';

// …inside OnboardingStepperBody, replacing the flat array:
const stepContent = [
  <StepEmail key="email" />,
  // step 2 has state_variants — wrap in Path B composition
  <ErrorBoundary key="verify" FallbackComponent={StepVerifyError}>
    <Suspense fallback={<StepVerifyLoading />}>
      <StepVerify />
    </Suspense>
  </ErrorBoundary>,
  <StepProfile key="profile" />,
][currentStep];
```

- Steps without `state_variants` render exactly as today — no `<Suspense>`, no `<ErrorBoundary>`. Loaded-only stepper flows stay byte-identical per the identity guarantee (principle 6).
- The `ErrorBoundary` import specifier comes from `project_conventions.error_boundary.import_path`, same as route-level Path B.
- The shared shell is untouched — only the swappable body wraps. Header/progress/footer keep rendering during the step's loading/error state.
- A step's data-fetching call that can throw (e.g. `useSuspenseQuery`) lives inside `<StepVerify>`; `<Suspense>` catches the throw and renders `<StepVerifyLoading>` until the query resolves.
- When `state_variants.error.stub === true` on a step, emit `<GroupName>Step<Title>ErrorPlaceholder` from the dashed-border template in [§Error stub](#error-stub-state_variantserrorstub--true) and import it as `FallbackComponent` exactly like the non-stub case.

Accessibility during a per-step state transition:
- `StepVerifyLoading` root keeps `aria-busy="true"` (same as route-level loading).
- `StepVerifyError` root keeps `role="alert"` + `aria-live="assertive"`.
- The outer `role="region"` wrapper on `[data-stepper-body]` stays — screen readers still anchor the step heading during a loading/error transition.

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

- **Phase 4a pixel diff**: covered by the unified flow-walker — see §"Flow-walker spec template" below. The walker handles the `page.goto` + click-Next driving and the per-step pixel diff against the Figma export. Per-host screenshot masks the shared shell bbox via `flow-graph.mask_regions[]` so the stepper indicator's variant change between steps doesn't trigger a false diff.
- **Phase 4b smoke test**: nav-smoke remains a separate spec (`flow-navigation.spec.ts`) for route resolution and click-level edge assertions; see §"Navigation smoke test" below. The walker doesn't replace it — the walker checks visual fidelity, the nav-smoke checks navigation correctness.

For `mode: hybrid`, the walker emits one stepper-style block per group and one route-style block per standalone page, joined in the same spec file.

### Flow-walker spec template

Emitted to `<run-dir>/flow/flow-walker.spec.ts` by `/d2c-build-flow` Phase 4a. Drives the entire flow's loaded path in one Playwright run, screenshots every host, and pixel-diffs against the matching Figma export. The template below is parameterised by `flow-graph.json`; the values inside `<…>` are filled in by Phase 4a's emitter.

```ts
import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";

const RUN_DIR = "<run-dir>";                          // e.g. .claude/d2c/runs/2026-04-19T133000
const PIXELDIFF = "skills/d2c-build/scripts/pixeldiff.js";
const THRESHOLD = <threshold>;                        // default 95
const MASK_REGIONS = path.join(RUN_DIR, "flow/mask-regions.json"); // empty-array file when no masks
const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile:  { width: 390,  height: 844 },
};

async function diffAgainstFigma(
  page: Page,
  hostNodeId: string,
  hostFigmaUrl: string,
  viewport: keyof typeof VIEWPORTS,
  label: string
) {
  // Live screenshot of the body region.
  const live = path.join(RUN_DIR, `flow/walker/${hostNodeId}.${viewport}.live.png`);
  const region = await page.locator("[data-flow-ready], main").first();
  await region.screenshot({ path: live });

  // Figma export — fetched via MCP tool by the orchestrator before the test runs;
  // the path is resolved from the run directory's prefetched manifest.
  const figma = path.join(RUN_DIR, `flow/walker/${hostNodeId}.${viewport}.figma.png`);

  // pixeldiff returns "matched in: <ms>" / "different pixels: <count>" / "error: …".
  const out = execSync(
    `node ${PIXELDIFF} --reference ${figma} --candidate ${live} --mask ${MASK_REGIONS} --threshold ${THRESHOLD}`,
    { encoding: "utf8" }
  );
  const score = Number(/score: ([\d.]+)/.exec(out)?.[1] ?? "0");
  expect(score, `${label} (${viewport}): pixel-diff ${score}% < ${THRESHOLD}%`).toBeGreaterThanOrEqual(
    THRESHOLD
  );
}

// One test() per host. Routes-mode hosts visit a URL; stepper-group virtual pages
// drive the click-through inside a single test so the same provider state carries
// across steps.

// --- Routes-mode example ---
<for each pages[i] where page_type === "page":>
test("loaded — <route>", async ({ page }) => {
  for (const viewport of [<viewports>] as const) {
    await page.setViewportSize(VIEWPORTS[viewport]);
    await page.goto("<route>");
    await page.waitForLoadState("domcontentloaded");
    await Promise.race([
      page.waitForSelector("[data-flow-ready]", { timeout: 5000 }),
      page.waitForTimeout(750),
    ]);
    await diffAgainstFigma(page, "<node_id>", "<figma_url>", viewport, "<route>");
  }
});
</for>

// --- Stepper-group example (one test per group, click-through inside) ---
<for each stepper_groups[g]:>
test("loaded — <group_route> (<g.steps.length> steps)", async ({ page }) => {
  for (const viewport of [<viewports>] as const) {
    await page.setViewportSize(VIEWPORTS[viewport]);
    await page.goto("<group_route>");
    await page.waitForLoadState("domcontentloaded");

<for j in 0 .. g.steps.length - 1:>
    // Step <j+1>: <g.steps[j].title>
    await page.waitForSelector(`[data-stepper-step="<j>"]`, { timeout: 5000 });
    await diffAgainstFigma(
      page,
      "<g.steps[j].node_id>",
      "<g.steps[j].figma_url>",
      viewport,
      "<group_route>#step-<j+1>"
    );

  <if j < g.steps.length - 1:>
    <if g.steps[j].validate === "form":>
      // Auto-fixture for validate:form — read persisted values first
      // (user-supplied values from F-FLOW-WALKER-VALIDATION-BLOCKED win),
      // fall back to the auto-fixture rules in SKILL.md §4a.2 otherwise.
      <for each state_writes:>
      // TODO: auto-fixture — replace if a regex/business rule rejects this value
      {
        const stepKey = "<g.group_node_id>__step_<j+1>";
        const fieldName = "<state_writes.name>";
        const persistedJson = execSync(
          `node skills/d2c-build-flow/scripts/walker-fixtures.js get ${RUN_DIR} ${stepKey} ${fieldName}`,
          { encoding: "utf8" }
        ).trim();
        const persisted = persistedJson === "null" ? null : JSON.parse(persistedJson);
        const value = persisted?.value ?? "<auto_value>";
        await page.getByLabel(/<state_writes_label_regex>/i).fill(String(value));
        // Persist auto-fixture writes back so reruns can see what was attempted
        // (user values are protected by the merge helper's user-wins semantics).
        if (!persisted) {
          execSync(
            `node skills/d2c-build-flow/scripts/walker-fixtures.js merge ${RUN_DIR} ${stepKey} ${fieldName} ${JSON.stringify(String(value))} --source auto-fixture --type <state_writes.type>`
          );
        }
      }
      </for>
    </if>
    await page.getByRole("button", { name: /next|continue|submit|finish|done|confirm/i }).click();
  </if>
</for>
  }
});
</for>
```

**Implementation notes for the emitter:**

- `<viewports>` resolves to `["desktop"]` when the host has no `mobile_variant`, else `["desktop", "mobile"]`.
- The Figma exports listed at `<run-dir>/flow/walker/<node_id>.<viewport>.figma.png` are fetched **before** the test runs via `mcp__Figma__get_screenshot` (one fetch per host × viewport), then written to the walker directory. The walker only reads them. This keeps the test deterministic — it doesn't depend on MCP availability at test time.
- The `data-stepper-step="<j>"` attribute is emitted by the orchestrator (see §"Page file" — add it to `<div data-stepper-body data-stepper-step={currentStep}>`). The walker waits for it to advance instead of guessing at a settle delay.
- Step transitions on `validate: form` steps fill fields BEFORE clicking Next so the auto-fixture data flows through the standard validation pipeline. If the auto-fixture is wrong (Next stays disabled after fill), the next click times out and the walker fires **F-FLOW-WALKER-VALIDATION-BLOCKED** — see `failure-modes.md`.
- `optional: true` steps where auto-fixture can't satisfy validation get a Skip click instead: `await page.getByRole("button", { name: /skip/i }).click()`.
- For `mode: hybrid`, route-mode `test()` blocks and stepper-mode `test()` blocks coexist in the same spec file. Order: declared order across `pages[]` and `stepper_groups[]`.

**One-line orchestrator hook to enable the walker** — add `data-stepper-step={currentStep}` to the body region:

```tsx
<div
  role="region"
  aria-labelledby={`stepper-title-${currentStep}`}
  data-stepper-body
  data-stepper-step={currentStep}                    // <-- enables walker step-transition wait
>
```

For non-stepper pages, add `data-flow-ready` to the outermost element after first paint completes (typically a `useEffect(() => { ref.current?.setAttribute("data-flow-ready", ""); }, [])` on the page-level component). When omitted, the walker falls back to a 750ms settle delay.

### Navigation smoke test

(Existing §"Navigation smoke test" wording continues here — the nav-smoke spec is unchanged by the Phase 4a walker. The two specs are complementary: the walker checks visual fidelity per step; the nav-smoke checks that route resolution and edge wiring don't crash.)

### Shared-shell interaction

When `stepper_groups[i].shell_component_node_id` resolves to a design-system component present in `design-tokens.components[]`, reuse it via import. When not, generate a local `_components/OnboardingShell.tsx` from the shell's IR. Either way the shell receives `currentStep`, `totalSteps`, and `stepTitles` props so the progress indicator stays in sync with the provider.

### Non-negotiables

- The stepper page itself MUST NOT call `router.push` for internal step changes. Use the provider's `next()`/`back()` so state and history stay consistent.
- Form data persists across step changes — never unmount the provider between steps; `steps/Step*.tsx` components unmount/mount, but `page.tsx` stays mounted for the life of the flow.
- `reset()` is called automatically after the final step if the last step's Next button has `link_target.edge_kind === "route"` (exit edge), so revisiting the stepper route starts fresh unless persistence is `local`.
