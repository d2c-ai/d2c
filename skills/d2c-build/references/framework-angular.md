# Angular 17+ Code Generation Rules

Loaded when: `package.json` contains `@angular/core`.
These rules are ADDITIVE to the universal rules in SKILL.md.
CRITICAL: Use Angular 17+ modern syntax ONLY. No NgModules, no decorators for I/O, no structural directives.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the patterns in this file for stylistic decisions (export style, type definitions, file naming, import ordering, barrel exports). This file remains authoritative for framework-specific syntax requirements (`@Component`, signals, dependency injection, Angular template syntax).

## 0. NON-NEGOTIABLES

These Angular 17+ rules hold for every generated file. No exceptions.

- **MUST use standalone components.** NEVER emit `NgModule` for new code. Angular 19+ assumes `standalone: true` by default — NEVER add `standalone: true` explicitly on 19+.
- **MUST use signal-based I/O and state.** Use `input()`, `input.required()`, `output()`, `signal()`, `computed()`, `effect()`. NEVER use `@Input()`/`@Output()` decorators for new components.
- **MUST use `inject()` for dependency injection**, NEVER constructor injection for new services or components.
- **MUST use `@if`/`@for`/`@switch` control flow syntax.** NEVER emit `*ngIf`/`*ngFor`/`*ngSwitch` structural directives — they are obsolete.
- **MUST use `class`, NEVER `className`.** Angular templates use the native HTML `class` attribute.

---

## 1. KEY REMINDERS

- Use Angular 17+ modern syntax ONLY. No NgModules, no `@Input()`/`@Output()` decorators, no `*ngIf`/`*ngFor` structural directives.
- Angular 19+: `standalone: true` is the default. NEVER include it in the decorator.
- Use signal-based inputs (`input()`, `input.required()`), signal state (`signal()`), and `computed()`.
- Use `@if`/`@for`/`@switch` control flow (NOT `*ngIf`/`*ngFor`/`*ngSwitch`).
- v19+: signal writes in `effect()` are allowed by default -- no `allowSignalWrites` needed.
- Use `class`, never `className`.

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

| Concept       | Angular 17+ Syntax                                             |
|---------------|----------------------------------------------------------------|
| LinkedSignal  | `selected = linkedSignal(() => this.items()[0])` -- writable, auto-resets from source |
| Resource      | `data = resource({ request: () => ({ id: this.id() }), loader: ({ request }) => fetch(...) })` |
| RxResource    | `data = rxResource({ request: () => ({ id: this.id() }), loader: ({ request }) => this.http.get<T>(...) })` |
| Control flow  | `@if (cond) { } @else { }`, `@for (item of items(); track item.id) { }`, `@switch` |

---

## 3. FILE STRUCTURE CONVENTIONS

| Type                | Path                                          |
|---------------------|-----------------------------------------------|
| Reusable component  | `src/app/shared/components/card/card.component.ts` |
| Feature component   | `src/app/[feature]/components/name.component.ts`   |
| Global service      | `src/app/core/services/auth.service.ts`            |
| Feature service     | `src/app/[feature]/services/name.service.ts`       |
| Page / Route        | `src/app/[feature]/[feature].component.ts`         |
| Route config        | `src/app/app.routes.ts`                            |
| Guards              | `src/app/core/guards/auth.guard.ts`                |
| Interceptors        | `src/app/core/interceptors/api.interceptor.ts`     |
| Models / Types      | `src/app/shared/models/` or `src/app/[feature]/models/` |
| Layout              | Parent route component with `<router-outlet />`    |

---

## 4. DATA FETCHING PATTERNS

| Context                | Pattern                                                              |
|------------------------|----------------------------------------------------------------------|
| Service + HttpClient   | `http = inject(HttpClient); getData() { return this.http.get<T>(url); }` |
| Component (signal)     | `data = toSignal(this.service.getData(), { initialValue: [] })`      |
| TanStack Query         | `query = injectQuery(() => ({ queryKey: ['k'], queryFn: fetchFn }))` |
| Resource (v19+)        | `data = resource({ request, loader })` or `rxResource({ request, loader })` |

Default: inject services, return `Observable<T>`, convert with `toSignal()`. For signal-native async, MUST use `resource()` or `rxResource()`. NEVER fetch directly in components.

---

## 5. CLIENT / SERVER BOUNDARIES

Angular is client-side by default. All components render on the client.
- Angular SSR (`@angular/ssr`): opt-in server-side rendering with automatic hydration.
- Add `provideClientHydration(withEventReplay())` in `app.config.ts` for SSR hydration (event replay stable in v19; add `withIncrementalHydration()` for deferred block hydration).
- `isPlatformBrowser(inject(PLATFORM_ID))` to guard browser-only code.
- No `"use client"` equivalent exists; everything is client unless SSR is configured.

---

## 6. STYLING SYNTAX

| Method          | Syntax                                                       |
|-----------------|--------------------------------------------------------------|
| Tailwind        | `class="flex items-center gap-2 text-sm"`                    |
| Conditional     | `[class.active]="isActive()"` or `[ngClass]="{'active': isActive()}"` |
| Host element    | `:host { display: block; }` in component styles              |

---

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

| Category           | Angular Libraries                                               |
|--------------------|-----------------------------------------------------------------|
| state_management   | `@ngrx/store`, `@ngrx/signals`, `@ngxs/store`, Angular signals (built-in) |
| data_fetching      | `HttpClient` (built-in), `@tanstack/angular-query-experimental`, `apollo-angular` |
| forms              | `ReactiveFormsModule` (built-in), `FormsModule` (built-in), `ngx-formly` |
| icons              | `@ng-icons/core`, `angular-fontawesome`, `@angular/material` icons |
| animation          | `@angular/animations` (built-in), `gsap`, `motion`             |
| component_library  | `@angular/material`, `primeng`, `ng-zorro-antd`, `taiga-ui`, `spartan-ng` |
| tables             | `@tanstack/angular-table`, `ag-grid-angular`                    |
| charts             | `ngx-charts`, `ng2-charts` (Chart.js wrapper), `ngx-echarts`   |
| toast              | `ngx-toastr`, `@ngneat/hot-toast`                              |
| i18n               | `@ngx-translate/core`, `@angular/localize` (built-in)          |

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.

---

## Library Boundary Values (SVG Chart Libraries)

Some libraries accept color/style values as string props, not CSS classes or variables. SVG-based chart libraries (ngx-charts, d3, @angular/cdk) require hex/rgb strings because the SVG renderer does not resolve CSS custom properties at the attribute level.

**Pattern: Resolve CSS variables at runtime via a service or computed getter.**

```typescript
import { inject, computed, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

function resolveTokenColor(doc: Document, tokenVar: string): string {
  return getComputedStyle(doc.documentElement)
    .getPropertyValue(tokenVar)
    .trim() || '#000000';
}
```

**When runtime resolution is not feasible**, hardcoding is acceptable but MUST include a comment linking the value to its token:

```typescript
// Token: colors.primary (#2563EB) — hardcoded for SVG chart compatibility
[attr.fill]="'#2563EB'"
```

These values are **exempt from the Phase 5 hardcoded-values audit** (bucket A) because the library API requires them.
