# Design Tokens JSON Schema Reference

This file is loaded by d2c-init Step 6 when generating design-tokens.json.

## Schema

```json
{
  "d2c_schema_version": 1,
  "split_files": false,
  "framework": "<react | vue | svelte | angular | solid | astro>",
  "meta_framework": "<next | nuxt | sveltekit | angular | solidstart | astro | react | vue | svelte | solid>",
  "component_file_extension": "<.tsx | .vue | .svelte | .component.ts | .astro>",
  "island_frameworks": ["<optional array of island framework names, e.g. react, vue, svelte>"],
  "styling_approach": "<tailwind | css-modules | css-in-js | vanilla-css | mixed>",
  "styling_config_path": "<path to tailwind config, theme file, or primary CSS file>",
  "colors": { },
  "spacing": { },
  "typography": { },
  "breakpoints": { },
  "shadows": { },
  "borders": { },
  "components": [
    {
      "name": "ComponentName",
      "path": "src/components/ui/ComponentName.tsx",
      "description": "What it does in plain English",
      "props": ["variant", "size", "children"],
      "import_count": 8
    }
  ],
  "hooks": [
    {
      "name": "useHookName",
      "path": "src/hooks/useHookName.ts",
      "description": "What it does"
    }
  ],
  "preferred_libraries": {
    "<category_name>": {
      "selected": "<package name the user chose>",
      "installed": ["<all installed packages in this category>"],
      "file_count": { "<package>": "<number of files using it>" }
    }
  },
  "api": {
    "config_path": "<path to API config/setup file, e.g., lib/api.ts>",
    "query_client_path": "<path to QueryClient setup if using React Query/SWR>",
    "base_url_env": "<environment variable name for API base URL, e.g., NEXT_PUBLIC_API_URL>",
    "response_envelope": "<exact key names if consistent across 3+ responses, e.g., { data, error, meta } | none-detected>",
    "auth_pattern": "<axios-interceptor | fetch-wrapper | next-auth-session | auth-header-manual | none-detected>",
    "error_handling": "<toast | error-boundary | inline-message | console-only | mixed | none-detected>",
    "loading_pattern": "<react-query-isLoading | swr-isLoading | suspense | useState-loading | skeleton-component | mixed | none-detected>"
  },
  "conventions": {
    "component_declaration": {
      "value": "<arrow_function | function_declaration | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "export_style": {
      "value": "<default_export | named_export | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "type_definition": {
      "value": "<interface | type_alias | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "type_location": {
      "value": "<colocated | separate_file | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "file_naming": {
      "value": "<PascalCase | kebab-case | camelCase | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "import_ordering": {
      "value": ["framework", "external", "internal", "relative", "type", "style"],
      "confidence": 0.0,
      "override": false
    },
    "css_utility_pattern": {
      "value": "<raw_classes | cn | clsx | cva | twMerge | cx | mixed>",
      "wrapper_import": "<e.g., @/lib/utils | clsx | class-variance-authority>",
      "confidence": 0.0,
      "override": false
    },
    "barrel_exports": {
      "value": "<yes | no | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "test_location": {
      "value": "<colocated | separate | none_detected | mixed>",
      "confidence": 0.0,
      "override": false
    },
    "props_pattern": {
      "value": "<destructured | props_object | mixed>",
      "confidence": 0.0,
      "override": false
    }
  },
  "figma_variables": {
    "imported_from": "<path to Figma variables file or Figma file key>",
    "mismatches": [
      {
        "name": "<variable name>",
        "figma_value": "<value in Figma>",
        "code_value": "<value in code>",
        "status": "<matched | mismatched | missing_in_code | missing_in_figma>"
      }
    ]
  }
}
```

## `preferred_libraries` rules

- Include ALL categories where at least 1 library was detected.
- For categories with only 1 library, `selected` and `installed` will both contain just that one library.
- For categories where the user chose, `selected` is the user's choice, `installed` lists everything found.
- The build skill reads `preferred_libraries.<category>.selected` to decide which library to use.
- The old `api.client` field is removed -- the data fetching library is now at `preferred_libraries.data_fetching.selected`.

## Example

```json
"preferred_libraries": {
  "data_fetching": {
    "selected": "@tanstack/react-query",
    "installed": ["@tanstack/react-query", "swr", "fetch (built-in)"],
    "file_count": { "@tanstack/react-query": 8, "swr": 5, "fetch (built-in)": 12 }
  },
  "dates": {
    "selected": "date-fns",
    "installed": ["date-fns", "moment"],
    "file_count": { "date-fns": 14, "moment": 6 }
  },
  "icons": {
    "selected": "lucide-react",
    "installed": ["lucide-react"],
    "file_count": { "lucide-react": 22 }
  },
  "realtime": {
    "selected": "ably",
    "installed": ["ably"],
    "file_count": { "ably": 3 }
  },
  "forms": {
    "selected": "react-hook-form",
    "installed": ["react-hook-form"],
    "file_count": { "react-hook-form": 9 }
  }
}
```

If no libraries are detected in any category (e.g., a brand new project with no dependencies), omit the `preferred_libraries` section entirely.

The `api` section is now only for API-specific configuration (base URL, auth, error handling, loading patterns). It is only included if a `data_fetching` library exists in `preferred_libraries`. Omit it entirely for projects with no data fetching.

## `conventions` rules

Project conventions capture how the team writes code — stylistic choices that are independent of framework requirements.

- Only conventions with `confidence` > 0.6 are enforced during code generation. Conventions with `value` = `"mixed"` are informational only — the build skill may use either pattern.
- `override: true` means the user manually set the value during init. Overridden conventions are always enforced regardless of confidence.
- **Framework applicability:** Not all conventions apply to all frameworks. Omit inapplicable conventions:
  - `component_declaration` and `props_pattern`: only for `react` and `solid` (Vue/Svelte/Angular/Astro have framework-dictated patterns)
  - `type_definition` and `type_location`: only for TypeScript projects (`.tsx`, `.ts`, `.component.ts`)
  - `css_utility_pattern`: only when `styling_approach` includes `tailwind`
- **Priority chain:** conventions > design-tokens.json values > framework reference file defaults. The build skill and design-system-aware skill read `conventions.<key>.value` to determine which pattern to follow. If the `conventions` section does not exist (e.g., older init version), fall back to framework reference file patterns.
- The `import_ordering` value is an array of group names in the expected order. Common groups: `"framework"` (react, next, vue, svelte, etc.), `"external"` (third-party packages), `"internal"` (aliased paths like `@/`), `"relative"` (./), `"type"` (type-only imports), `"style"` (CSS/SCSS imports).
- The `css_utility_pattern.wrapper_import` field records the import path for the wrapper function (e.g., `"@/lib/utils"` for a `cn()` helper). The build skill uses this to add the correct import when generating Tailwind classes.

## `d2c_schema_version` rules

- `d2c_schema_version` is always the FIRST field in the JSON file. It is a positive integer.
- The current version is **1**.
- **`split_files`** (boolean, optional): Set to `true` when design-tokens.json exceeds 400 lines / ~20K tokens and split files have been generated. When `true`, consuming skills (d2c-build, d2c-audit) load per-phase split files (`tokens-core.json`, `tokens-colors.json`, `tokens-components.json`, `tokens-conventions.json`) instead of parsing sections from the monolithic file. Default: absent (treated as `false`).
- When to increment: bump the version when a breaking change is made to the schema structure (e.g., renaming a required field, removing a field, changing a field's type, or adding a new required field). Adding new optional fields does NOT require a version bump.
- The build and audit skills check this version before reading the file. If the version is older than the current expected version, they warn the user: "design-tokens.json uses schema version X but the current version is Y. Run `/d2c-init --force` to regenerate."
- If the `d2c_schema_version` field is missing entirely (file generated by an older version of init), treat it as version 0 and show the warning.
