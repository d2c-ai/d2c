# framework-angular — Angular patterns for d2c-build-flow

This reference is consumed by Phase 3 of `/d2c-build-flow` when the project's `framework = "angular"` and `meta_framework = "angular"`. It defines how the flow IR maps to Angular's router config, standalone components, signal-based state, and nav smoke test.

Targets **Angular 17+** idioms: standalone components, the new `@Component({ standalone: true })` flag, function-style route guards, signals for local state. Never emit `NgModule` scaffolding — it's the legacy path.

Keep this file parallel to `framework-react-next.md`. When a section lands there, mirror it here.

---

## When this branch fires

- `design-tokens.json.framework === "angular"` and `meta_framework === "angular"`.
- Assumes Angular 17+ (standalone components). Older Angular projects (15/16) still work but must opt in to standalone — Phase 3 does not generate `NgModule` files.

---

## File layout

Given `flow-graph.json` with `flow_name = "onboarding"` and a shared layout, Phase 3 emits:

```
src/
  app/
    onboarding/
      onboarding.routes.ts            # child route config
      onboarding-shell.component.ts   # shared shell (if layouts[] non-empty)
      onboarding-state.service.ts     # Injectable state (if shared_state[] non-empty)
      step-1/
        step-1.component.ts
        step-1.component.html
      step-2/
        step-2.component.ts
      step-3/
        step-3.component.ts
    app.routes.ts                     # merges onboarding.routes into the root config
```

When pages use explicit routes outside the `flow_name` tree, they still go under `src/app/<route>/…` and the child route config stays flat — Angular resolves paths relative to the parent route.

---

## Shared layout (`<flow_name>-shell.component.ts`)

Emit when `flow-graph.layouts[]` is non-empty. The shell uses `RouterOutlet` to render children and lives at the parent of the flow's routes.

```ts
import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { SharedShellComponent } from "@/components/shared-shell/shared-shell.component";

@Component({
  selector: "app-onboarding-shell",
  standalone: true,
  imports: [RouterOutlet, SharedShellComponent],
  template: `
    <app-shared-shell>
      <router-outlet />
    </app-shared-shell>
  `,
})
export class OnboardingShellComponent {}
```

Route config ties the shell to the child routes:

```ts
// onboarding.routes.ts
import { Routes } from "@angular/router";
import { OnboardingShellComponent } from "./onboarding-shell.component";

export const ONBOARDING_ROUTES: Routes = [
  {
    path: "onboarding",
    component: OnboardingShellComponent,
    children: [
      { path: "step-1", loadComponent: () => import("./step-1/step-1.component").then((m) => m.Step1Component) },
      { path: "step-2", loadComponent: () => import("./step-2/step-2.component").then((m) => m.Step2Component) },
      { path: "step-3", loadComponent: () => import("./step-3/step-3.component").then((m) => m.Step3Component) },
    ],
  },
];
```

Merge `ONBOARDING_ROUTES` into the root `app.routes.ts` via the spread operator — never overwrite an existing route file.

Rules:
- Use `RouterOutlet` for child rendering. Never emit an `<ng-content>` projection as the primary composition — the shell is a routed layout, not a content wrapper.
- `SharedShellComponent` is identified via component-match scoring; when no reusable match exists, generate it under `src/components/shared-shell/shared-shell.component.ts`.
- Prefer `loadComponent` (lazy) over eager `component:` in the route config. Angular's AOT compiler code-splits per route.

---

## Shared state provider (`<flow_name>-state.service.ts`)

Angular idiom: an `@Injectable({ providedIn: "root" })` service backed by signals. Emit one service per `shared_state[]` entry. The template branches on `persistence`.

### persistence = "memory" — signals in root injector

```ts
import { Injectable, signal } from "@angular/core";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

@Injectable({ providedIn: "root" })
export class OnboardingStateService {
  readonly data = signal<OnboardingData>({});

  setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]): void {
    this.data.update((prev) => ({ ...prev, [key]: value }));
  }

  reset(): void {
    this.data.set({});
  }
}
```

### persistence = "session" — sessionStorage, SSR-safe

```ts
import { Injectable, PLATFORM_ID, inject, signal, effect } from "@angular/core";
import { isPlatformBrowser } from "@angular/common";

const STORAGE_KEY = "OnboardingContext:v1";

export interface OnboardingData {
  email?: string;
  age?: number;
  newsletter?: boolean;
}

@Injectable({ providedIn: "root" })
export class OnboardingStateService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly data = signal<OnboardingData>(this.readInitial());

  constructor() {
    if (!this.isBrowser) return;
    effect(() => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.data()));
      } catch {
        // Ignore quota or serialisation errors — state still lives in memory.
      }
    });
  }

  setField<K extends keyof OnboardingData>(key: K, value: OnboardingData[K]): void {
    this.data.update((prev) => ({ ...prev, [key]: value }));
  }

  reset(): void {
    this.data.set({});
    if (this.isBrowser) sessionStorage.removeItem(STORAGE_KEY);
  }

  private readInitial(): OnboardingData {
    if (!this.isBrowser) return {};
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as OnboardingData) : {};
    } catch {
      return {};
    }
  }
}
```

### persistence = "local" — localStorage with opt-in TTL

Mirrors the session variant but persists across tabs/reloads. When `ttl_seconds` is set, wrap writes in a `{ data, expires_at }` envelope and discard stale entries on read. Same `isPlatformBrowser` guard applies.

Rules:
- Every storage access must be guarded by `isPlatformBrowser(inject(PLATFORM_ID))` — SSR builds (Angular Universal) execute services on the server where `sessionStorage` is undefined.
- Key naming: `<FlowName>Context:v1`. Bump the version suffix when the typed shape changes.
- Per-key typed `setField` so a typo at a caller site becomes a compile error.

---

## Page files (`<flow_name>/step-N/step-N.component.ts`)

```ts
import { Component, inject } from "@angular/core";
import { Router } from "@angular/router";
import { OnboardingStateService } from "../onboarding-state.service";

@Component({
  selector: "app-onboarding-step-1",
  standalone: true,
  template: `
    <section>
      <!-- rendered body from component-match + layout IR -->
      <button type="button" (click)="goNext()">Next</button>
    </section>
  `,
})
export class Step1Component {
  private readonly router = inject(Router);
  private readonly state = inject(OnboardingStateService);

  goNext(): void {
    this.router.navigate(["/onboarding/step-2"]);
  }
}
```

Rules:
- `Router.navigate([...])` is the canonical programmatic navigation call. Prefer the `[routerLink]` directive for static links — better a11y + prefetch.
- `(click)` template syntax; never emit `@HostListener('click')` on the component for nav — it bypasses the template and breaks `routerLink` prefetch.
- **No invented Next buttons.** If `link_target` is absent, emit a `<!-- TODO(d2c-flow): wire a Next button for edge <from> → <to> -->` comment and leave the rendered body untouched.
- When `link_target.trigger === "onSubmit"`, wrap the button in a `<form (ngSubmit)="goNext()">` and call `state.setField(...)` before navigation when the form has shared-state fields.

---

## Navigation smoke test (`flow-navigation.spec.ts`)

Playwright works identically on Angular projects — it drives the browser, not the framework.

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
- `playwright.flow.config.ts` template's `webServer.command` needs to match Angular's dev script. Default is `npm run start` for Angular CLI projects — override the template's `npm run dev` to `npm run start` when emitting for Angular, or update the project's package.json script aliases.

---

## Placement decisions

- **Layout:** `src/app/<flow_name>/<flow_name>-shell.component.ts`. The shell is a routed component, not a global AppShell.
- **State:** `src/app/<flow_name>/<flow_name>-state.service.ts`, registered at root (`providedIn: "root"`). Only use `providedIn: <FlowRoute>` if the state MUST be scoped to the flow; root scope keeps DI simpler.
- **Shared components:** `src/components/<flow_name>/<name>.component.ts` for flow-specific shared components. Reused components keep their existing paths from `design-tokens.components[]`.

---

## Multi-branch navigation (B-FLOW-MULTI-BRANCH)

For a branch page (out-degree > 1 in `flow-graph.edges[]`), emit one method per outgoing edge — each wired to the Figma component identified in `edges[i].source_component_node_id`.

```ts
@Component({
  selector: "app-onboarding-step-2",
  standalone: true,
  template: `
    <section>
      <button type="button" (click)="goPathA()">Path A</button>
      <button type="button" (click)="goPathB()">Path B</button>
    </section>
  `,
})
export class Step2Component {
  private readonly router = inject(Router);
  goPathA() { this.router.navigate(["/onboarding/step-3a"]); }
  goPathB() { this.router.navigate(["/onboarding/step-3b"]); }
}
```

Rules:
- One `Router.navigate` (or `[routerLink]`) per outgoing edge. Every branch MUST resolve to a distinct Figma component (non-null `source_component_node_id`); validator rejects the graph otherwise.
- Nav smoke test emits one click-level assertion per outgoing edge.

---

## Conditional navigation (B-FLOW-CONDITIONAL-NAV)

When an edge carries a non-null `condition`, the branch is evaluated inline against the injected state service. Use `computed()` or a plain getter — never a route guard — since the condition depends on client state set during the flow, not on auth or session metadata.

```ts
goNext(): void {
  if (this.state.data().plan === "pro") {
    this.router.navigate(["/onboarding/step-3-pro"]);
    return;
  }
  this.router.navigate(["/onboarding/step-3-free"]);
}
```

Route guards (`CanActivate`) are for auth / feature-flag gating, not flow branching — don't emit a guard for flow conditions.

---

## Overlays (B-FLOW-OVERLAY-SUPPORT)

Overlay pages render as standalone child components mounted inside the `overlay_parent` via `@if` on a URL-query signal:

```ts
import { Component, inject, computed } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";

@Component({
  selector: "app-confirm-overlay",
  standalone: true,
  template: `
    @if (isOpen()) {
      <div role="dialog" aria-modal="true" (click)="close()">
        <div (click)="$event.stopPropagation()">
          <!-- overlay body -->
          <button type="button" (click)="close()">Close</button>
        </div>
      </div>
    }
  `,
})
export class ConfirmOverlayComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly isOpen = computed(() => this.route.snapshot.queryParamMap.get("overlay") === "confirm");

  close() {
    this.router.navigate([], { queryParams: { overlay: null }, queryParamsHandling: "merge", replaceUrl: true });
  }
}
```

Open-overlay edges navigate with `{ queryParams: { overlay: "confirm" }, queryParamsHandling: "merge" }`. Overlays are never routable — do NOT add them to the route config.

---

## Loops (B-FLOW-LOOP-SUPPORT)

When `edges[].is_loop === true`, the Playwright nav test caps visits per route using a `Map<string, number>` counter — identical pattern to the React reference. The validator accepts cycles as legal topology.

---

## Mobile variants (B-FLOW-MOBILE-VARIANT)

Single component tree with CSS-based responsive design. Prefer `@media` queries against tokens from `design-tokens.json.breakpoints` in the component's SCSS file, never a `BreakpointObserver`-driven re-render.
