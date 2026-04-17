# framework-react-next-pages — Next.js Pages Router patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "react"` and `meta_framework = "next"` **and** the repo uses the legacy Pages Router (a top-level `pages/` directory or an explicit `conventions.router === "pages"` hint in `design-tokens.json`).

The App Router variant lives in `framework-react-next.md`. Keep these two files parallel — if a section grows here, mirror it there.

---

## When this branch fires

Phase 3 selects this reference when **all** of the following are true:

- `design-tokens.json.framework === "react"` and `meta_framework === "next"`.
- The project has a top-level `pages/` directory **or** `conventions.router` equals `"pages"`.

If a project has both `app/` and `pages/`, prefer App Router (pick `framework-react-next.md`). Document the choice in the Phase 6 report.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
pages/
  _app.tsx                          # wraps layout via getLayout (only if no existing _app.tsx)
  onboarding/
    step-1.tsx
    step-2.tsx
    step-3.tsx
components/
  onboarding/
    OnboardingLayout.tsx            # shared shell (if layouts[] non-empty)
    _state/
      OnboardingContext.tsx         # provider + typed hook (if shared_state[] non-empty)
```

When pages use explicit routes outside the `flow_name` tree (e.g. `/signup`, `/signup/verify`), files go under those exact paths (`pages/signup/index.tsx`, `pages/signup/verify.tsx`, etc.). The layout + state module live in `components/<flow_name>/` regardless — Pages Router has no folder-scoped layout.

---

## Shared layout (`OnboardingLayout.tsx` + `getLayout`)

Pages Router has no `layout.tsx` convention. Use the per-page `getLayout` pattern so the layout survives page transitions (keeping state in the tree).

```tsx
// components/onboarding/OnboardingLayout.tsx
import type { ReactNode } from "react";
import { OnboardingProvider } from "./_state/OnboardingContext";
import { SharedShell } from "./SharedShell";

type Props = { children: ReactNode };

export function OnboardingLayout({ children }: Props) {
  return (
    <OnboardingProvider>
      <SharedShell>{children}</SharedShell>
    </OnboardingProvider>
  );
}

export function withOnboardingLayout(page: ReactNode) {
  return <OnboardingLayout>{page}</OnboardingLayout>;
}
```

Each onboarding page assigns `getLayout`:

```tsx
// pages/onboarding/step-1.tsx
import { withOnboardingLayout } from "@/components/onboarding/OnboardingLayout";

OnboardingStep1.getLayout = withOnboardingLayout;
```

`_app.tsx` dispatches:

```tsx
// pages/_app.tsx
import type { AppProps } from "next/app";
import type { NextPage } from "next";
import type { ReactElement, ReactNode } from "react";

type NextPageWithLayout = NextPage & {
  getLayout?: (page: ReactElement) => ReactNode;
};

export default function App({ Component, pageProps }: AppProps & { Component: NextPageWithLayout }) {
  const getLayout = Component.getLayout ?? ((page) => page);
  return getLayout(<Component {...pageProps} />);
}
```

Rules:
- Only emit `pages/_app.tsx` if none exists. If one exists, merge the `getLayout` dispatch into it — never overwrite a user's `_app.tsx`.
- `SharedShell` is the component identified by `layouts[].figma_node_id`, reused from `design-tokens.components[]` when possible.

---

## Shared state provider (`_state/<FlowName>Context.tsx`)

Identical to the App Router variant — see `framework-react-next.md` §"Shared state provider" for both the in-memory and sessionStorage templates, including the typed-interface variant when `pages[].state_writes` are populated. The file simply lives under `components/<flow_name>/_state/` instead of `app/<flow_name>/_state/`, and the provider wraps the page via the `getLayout` helper above.

`"use client"` is not required in Pages Router — every rendered page is a client component by default.

---

## Page files (`pages/<flow_name>/step-N.tsx`)

```tsx
import { useRouter } from "next/router";
// ... existing imports for the page's components/tokens
import { withOnboardingLayout } from "@/components/onboarding/OnboardingLayout";

export default function OnboardingStep1() {
  const router = useRouter();
  return (
    <section>
      {/* ... rendered body from component-match + layout IR ... */}
      <Button onClick={() => router.push("/onboarding/step-2")}>Next</Button>
    </section>
  );
}

OnboardingStep1.getLayout = withOnboardingLayout;
```

Rules:
- `useRouter` comes from `next/router`, NOT `next/navigation` (that's App Router only). Do not mix the two.
- `router.push(<target-route>)` is the canonical navigation call; `router.replace()` when you don't want a history entry.
- Same link-wiring rules as App Router: read `link_target` from the page's `component-match.json`; emit a TODO comment for inferred-only edges; never invent a Next button.
- When `link_target.trigger === "onSubmit"`, wrap the button in a `<form onSubmit={…}>` and call `router.push` from the submit handler.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

The Playwright test is identical to App Router — the test hits routes, not implementation details. Location: `tests/flow/<flow_name>-navigation.spec.ts` when a `tests/` directory exists, else `pages/<flow_name>/flow-navigation.spec.ts` (co-located).

See `framework-react-next.md` §"Navigation smoke test" for the template. The `playwright.flow.config.ts` with its `webServer: { command: "npm run dev" }` block works identically — Pages Router also responds to `next dev`.

---

## Placement decisions

- **Layout location:** `components/<flow_name>/OnboardingLayout.tsx`. There is no folder-scoped layout in Pages Router, so the layout lives outside `pages/` alongside other shared components.
- **State provider:** `components/<flow_name>/_state/OnboardingContext.tsx`. Leading underscore is a directory hint, not a routing rule (Pages Router doesn't have `_`-prefixed segments the way App Router does — it's for human organisation here).
- **Shared components:** `components/<flow_name>/` for flow-specific shared components; reused components keep their existing paths from `design-tokens.components[]`.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

Identical pattern to the App Router variant — see `framework-react-next.md` §"Overlays" for the component shape, URL-param contract, and open/close edge wiring. Two Pages Router differences:
- Reach `useRouter` from `next/router`; use `router.query` + `router.replace({ pathname, query })` instead of the App Router's `useSearchParams`/`usePathname` pair.
- Place overlay components under `components/<flow_name>/overlays/<Name>.tsx` (Pages Router has no folder-scoped `_overlays/` convention — keep them alongside the shared layout and state provider).

```tsx
import { useRouter } from "next/router";

export function ConfirmOverlay() {
  const router = useRouter();
  const OVERLAY_PARAM = "overlay";
  const OVERLAY_SLUG = "confirm";
  const isOpen = router.query[OVERLAY_PARAM] === OVERLAY_SLUG;
  if (!isOpen) return null;
  function close() {
    const { [OVERLAY_PARAM]: _drop, ...rest } = router.query;
    router.replace({ pathname: router.pathname, query: rest });
  }
  return (
    <div role="dialog" aria-modal="true" onClick={close}>
      <div onClick={(e) => e.stopPropagation()}>{/* overlay body */}</div>
    </div>
  );
}
```

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `edges[].is_loop === true`, the Playwright nav test caps visits per route using a `Map<string, number>` counter — same pattern as the App Router variant. The validator accepts cycles as legal topology.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

Identical model to App Router: one `router.push` handler per outgoing edge, wired to the Figma component named in `edges[i].source_component_node_id`. The only difference is the import path — Pages Router uses `next/router`:

```tsx
import { useRouter } from "next/router";

export default function OnboardingStep2() {
  const router = useRouter();
  return (
    <section>
      <Button onClick={() => router.push("/onboarding/step-3a")}>Path A</Button>
      <Button onClick={() => router.push("/onboarding/step-3b")}>Path B</Button>
    </section>
  );
}
```

Rules and navigation-smoke-test expectations match the App Router variant — see `framework-react-next.md` §"Multi-branch navigation" for the full contract.
