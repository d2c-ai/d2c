# React / Next.js Code Generation Rules

Loaded when: `package.json` contains `react` or `next`.
These rules are ADDITIVE to the universal rules in SKILL.md.

**Precedence:** If `preferred_libraries` in `design-tokens.json` specifies a library not listed in the tables below, that selection takes priority. Use that library's standard API/import pattern. These tables cover common libraries but are not exhaustive. `design-tokens.json` is always authoritative for library selection.

---

**Project conventions override:** If `design-tokens.json` contains a `conventions` section, those conventions take priority over the canonical component template and patterns in this file for stylistic decisions (declaration style, export style, type definitions, file naming, import ordering, props pattern). This file remains authoritative for framework-specific syntax requirements (JSX, hooks, `"use client"`, `className`).

## 1. KEY REMINDERS

- Add `"use client"` ONLY when a component uses hooks, events, or browser APIs. All other components are Server Components by default in App Router.
- React 19+: `useActionState` is from `react` (NOT `react-dom`). `use()` can be conditional. `<form action={serverAction}>` passes async fn directly.
- Always use `className`, never `class`. Always provide `key` on `.map()` elements.

---

## 2. SYNTAX QUICK REFERENCE (framework-specific gotchas and newer APIs only)

| Concept       | React / Next.js Syntax                                  |
|---------------|--------------------------------------------------------|
| Form action   | `<form action={serverAction}>` — pass async fn directly (React 19+) |
| Form state    | `const [state, action, pending] = useActionState(fn, init)` (from `react`, NOT `react-dom`) |
| Form status   | `const { pending } = useFormStatus()` (from `react-dom`, inside `<form>`) |
| Async read    | `const value = use(promise)` or `const ctx = use(MyContext)` (can be conditional, React 19+) |

---

## 3. FILE STRUCTURE CONVENTIONS

| Type                | Path                                      |
|---------------------|-------------------------------------------|
| Page (App Router)   | `app/[route]/page.tsx`                    |
| Page (Pages Router) | `pages/[name].tsx`                        |
| Layout              | `app/layout.tsx`, `app/[route]/layout.tsx`|
| Reusable component  | `src/components/ui/ComponentName.tsx`      |
| Page-specific comp  | `app/[route]/_components/Name.tsx`        |
| Custom hook         | `src/hooks/useHookName.ts`               |
| API route handler   | `app/api/[route]/route.ts`               |
| Service / API lib   | `src/services/` or `src/lib/api/`        |
| Types               | `src/types/` or co-located `types.ts`    |

---

## 4. DATA FETCHING PATTERNS

| Context               | Pattern                                                       |
|-----------------------|---------------------------------------------------------------|
| Server Component      | `async function Page() { const data = await fetch(url); }`   |
| Client + React Query  | `const { data } = useQuery({ queryKey, queryFn })`           |
| Client + SWR          | `const { data } = useSWR(key, fetcher)`                      |
| Server Action         | `"use server"` async function in separate file or inline     |
| Route Handler         | `export async function GET(req: NextRequest) { ... }`        |

**Next.js 15 breaking change:** `params` and `searchParams` in `page.tsx` / `layout.tsx` are now `Promise` objects. Always `await` them:
```tsx
export default async function Page(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
}
```

---

## 5. CLIENT / SERVER BOUNDARIES

Add `"use client"` at the top of a file if and ONLY if it uses any of:
- `useState`, `useEffect`, `useReducer`, `useContext`, `useRef` with DOM access, `useActionState`, `useFormStatus`, `useOptimistic`
- Event handlers (`onClick`, `onChange`, `onSubmit`, etc.)
- Browser APIs (`window`, `document`, `localStorage`, `IntersectionObserver`)
- Third-party hooks that require client context (`useQuery`, `useForm`, `useRouter` from `next/navigation`)

All other components are Server Components by default in App Router. Pages Router does not use this directive.

---

## 6. STYLING SYNTAX

| Method        | Syntax                                                      |
|---------------|-------------------------------------------------------------|
| Tailwind      | `className="flex items-center gap-2 text-sm"`               |
| Tailwind + cn | `className={cn("base-class", isActive && "bg-primary")}`    |
| CSS Modules   | `import s from './Name.module.css'; className={s.wrapper}`   |

---

## 7. FRAMEWORK-SPECIFIC LIBRARY CATEGORIES

| Category           | React Libraries                                                |
|--------------------|---------------------------------------------------------------|
| data_fetching      | `@tanstack/react-query`, `swr`, `axios`                      |
| forms              | `react-hook-form`, `formik`                                   |
| icons              | `lucide-react`, `react-icons`, `@heroicons/react`             |
| animation          | `framer-motion`, `react-spring`                               |
| component_library  | `@radix-ui/themes`, `@shadcn/ui`, `@mui/material`, `@mantine/core`, `@chakra-ui/react` |
| tables             | `@tanstack/react-table`                                       |
| charts             | `recharts`, `@nivo/core`, `victory`                           |
| date_picker        | `react-datepicker`, `react-day-picker`                        |
| toast              | `sonner`, `react-hot-toast`, `react-toastify`                 |
| dnd                | `@dnd-kit/core`, `react-beautiful-dnd`                        |

Rule: check `package.json` before importing. If a library from this table is already installed, use it. Never add a second library for the same category.
