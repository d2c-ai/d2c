# d2c

Claude Code commands that turn Figma designs into production-ready frontend code. Supports **React/Next.js**, **Vue/Nuxt**, **Svelte/SvelteKit**, **Angular**, **Solid.js/SolidStart**, and **Astro**. Scans your codebase for design tokens and API patterns, pulls designs from Figma, generates code matching your project's conventions (including real API integrations), and visually verifies output via Playwright screenshot comparison with objective pixel-diff scoring — iterating until the result matches the design.

---

## Quick Start

```bash
# 1. Install the plugin
claude plugin add d2c

# 2. Initialize in your project (scans codebase, extracts design tokens)
/d2c-init

# 3. Build from a Figma design
/d2c-build https://figma.com/design/your-file/your-page?node-id=1-2
```

See the full [Getting Started guide](docs/getting-started.md) for detailed setup.

---

## How It Works

```
/d2c-init (once per project)
  └─ Claude Code scans codebase → generates .claude/d2c/design-tokens.json
  └─ Discovers existing components, hooks, styling approach
  └─ Detects API call patterns (React Query, SWR, axios, fetch, GraphQL, etc.)
  └─ Imports Figma Variables if Figma MCP is available (flags mismatches)
  └─ Checks for global Playwright installation

/d2c-build (per task)
  └─ User provides Figma URL + prompt
  └─ Shows "Last used" options from previous builds alongside standard choices
  └─ Asks about viewports, components to reuse, and API connections
  └─ Auto-suggests reusable components based on Figma design analysis
  └─ Asks for API response structures (per endpoint) if the design connects to APIs
  └─ Pulls design context + screenshots from Figma MCP
  └─ Generates code using project tokens, styling conventions, existing components
  └─ Generates real typed API calls matching your project's fetching pattern
  └─ Screenshots result via Playwright CLI
  └─ Compares using pixel-diff (objective) + visual judgment (structural)
  └─ Iterates (up to 4 rounds)
       ├─ Below 95% → auto-fixes and re-runs
       └─ 95%+ or round 4 reached → stops, shows results

/d2c-audit (periodic)
  └─ Scans for hardcoded values that should use design tokens
  └─ Finds unused tokens in the design system
  └─ Detects components bypassing the design system
  └─ Checks API calls follow the project's established pattern
  └─ Outputs adherence score and violation report
```

---

## Prerequisites

1. **Claude Code** installed and working
2. **A frontend project** using React/Next.js, Vue/Nuxt, Svelte/SvelteKit, Angular, Solid.js/SolidStart, or Astro
3. **Figma account** with Dev Mode access
4. **Figma MCP** configured in Claude Code
5. **Playwright** installed globally (`npm install -g playwright && npx playwright install chromium`)

---

## Installation

### Option A: Claude Code plugin (recommended)

```
/plugin marketplace add d2c-ai/d2c
/plugin install d2c
```

### Option B: npx skills add

```bash
npx skills add d2c-ai/d2c
```

Works across Claude Code, Cursor, Codex, and other agents that support the [Agent Skills](https://agentskills.io) standard.

### Option C: Manual install

```bash
git clone https://github.com/d2c-ai/d2c.git
cd d2c
./install.sh
```

Restart Claude Code after installing. The commands `/d2c-init` and `/d2c-build` will be available in any project.

### Uninstall

```bash
# If installed via Option C
./uninstall.sh
```

---

## MCP Setup

You need Figma MCP configured. Add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/figma-mcp-server@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-personal-access-token"
      }
    }
  }
}
```

**Figma access token:** Figma → Settings → Account → Personal access tokens → Generate.

---

## Usage

### Step 1: Initialize (once per project)

```
/d2c-init
```

This scans your codebase and generates `.claude/d2c/design-tokens.json` containing your styling approach, colors, spacing, typography, breakpoints, existing components, hooks, and API call patterns.

It also imports Figma Variables if Figma MCP is available, flagging any mismatches between Figma and code tokens.

Re-running init when the token file already exists performs an incremental update — only scanning for changes rather than re-reading everything.

### Step 2: Build from Figma

Make sure your dev server is running (`npm run dev`), then:

```
/d2c-build
```

Claude Code will ask for:
1. The Figma Dev Mode URL
2. What it is (page/section/component), where it lives, functional vs visual-only
3. Viewports and components to reuse (shows "Last used" from previous builds)
4. Whether the design connects to APIs — if yes, how many calls and their response structures

It then auto-suggests reusable components from the Figma analysis, generates code with real typed API calls matching your project's pattern, and runs the visual verification loop with objective pixel-diff scoring.

**Dry run:** Add "dry run" to your prompt to preview the plan without writing files.

### Step 3: Audit (periodic)

```
/d2c-audit
```

Scans for design token drift: hardcoded colors, spacing values that should use tokens, unused tokens, components bypassing the design system, and API calls not following established patterns. Outputs a detailed report with an adherence score.

---

## Example Prompts

### Good Prompts

```
Build the dashboard overview page from this Figma.
It should be the default page at /dashboard.
The data cards at the top should accept props for title, value, and trend.
Reuse the existing Card and Badge components.
```

```
Implement the user settings page.
It goes in app/settings/page.tsx.
The form sections should be separate components under components/settings/.
Use our existing Input and Select components for form fields.
The save button should be disabled until a field changes.
```

```
Build the pricing section from the landing page Figma.
This is a section component, not a full page — it'll be imported into app/page.tsx.
The pricing cards should be a reusable PricingCard component.
The toggle between monthly/annual should update all cards.
```

### Bad Prompts

```
Build this page.
```
*No context about where it lives, what's interactive, or what to reuse.*

```
Make it look exactly like the Figma.
```
*No information about behavior, state, routing, or data flow.*

---

## What It Enforces

### Reusability First
- Check existing components before creating new ones
- Extract repeated patterns into components
- Props-driven, composable components

### SOLID for Frontend
- **S** — Single Responsibility: one component, one job
- **O** — Open/Closed: extendable via props, not source modification
- **I** — Interface Segregation: don't bloat component props
- **D** — Dependency Inversion: depend on props and hooks, not concrete implementations

### DRY for Frontend
- Design tokens for all values — no magic numbers
- Shared logic in custom hooks
- Shared layout in layout components

---

## Troubleshooting

**"Figma MCP not responding"**
- Check your `FIGMA_ACCESS_TOKEN` is valid
- Make sure the Figma file is accessible to your account
- Restart Claude Code after changing `.mcp.json`

**"Playwright screenshot is blank"**
- Is your dev server running?
- Check Playwright is installed globally: `npx playwright --version`

**"design-tokens.json looks wrong"**
- Re-run `/d2c-init` and point out what's missing
- You can manually edit it — it's at `.claude/d2c/design-tokens.json`

**"Generated code doesn't use my existing components"**
- Check the `components` section in `.claude/d2c/design-tokens.json` is complete
- Explicitly name the components you want reused in your prompt

**"Generated API calls use the wrong pattern"**
- Check the `api` section in `.claude/d2c/design-tokens.json`
- Re-run `/d2c-init` if you've changed your data fetching approach

**"Iteration loop isn't converging"**
- Break the page into smaller sections and run `/d2c-build` per section
- Add more context about what matters most in the design

**"Design system rules aren't being enforced during editing"**
- The `design-system-aware` skill activates only when `.claude/d2c/design-tokens.json` exists. Run `/d2c-init` first.
- Check that the skill is installed: look for `design-system-aware/SKILL.md` in your Claude Code commands directory or plugin installation.
- The skill only triggers on component file edits inside `src/` or `app/` directories.

---

## Project Structure

```
d2c/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest
├── skills/
│   ├── d2c-init/SKILL.md             # /d2c-init
│   ├── d2c-build/
│   │   ├── SKILL.md                   # /d2c-build (framework-agnostic orchestrator)
│   │   └── references/                # Framework-specific code gen rules
│   │       ├── framework-react.md     # React / Next.js
│   │       ├── framework-vue.md       # Vue 3 / Nuxt 3
│   │       ├── framework-svelte.md    # Svelte 5 / SvelteKit
│   │       ├── framework-angular.md   # Angular 17+
│   │       ├── framework-solid.md     # Solid.js / SolidStart
│   │       └── framework-astro.md     # Astro
│   ├── d2c-audit/SKILL.md            # /d2c-audit
│   └── design-system-aware/SKILL.md   # Auto-invoked (no slash command)
├── install.sh                         # Install commands globally
├── uninstall.sh                       # Remove commands
└── README.md
```

**`design-system-aware`** is not a slash command. It activates automatically when you create or edit any component file (`.tsx`, `.vue`, `.svelte`, etc.) inside `src/` or `app/`, provided `.claude/d2c/design-tokens.json` exists. It enforces token usage, component reuse, preferred libraries, and SOLID/DRY principles during normal editing — not just during `/d2c-build`.

**In your project (generated by init):**
```
your-project/
├── .claude/
│   └── d2c/
│       ├── design-tokens.json         # Design tokens, components, hooks, API patterns
│       └── intake-history.json        # Previous build intake answers (auto-generated)
└── ...
```

---

## How Skills Resolve Files

Skills reference companion files (framework rules, library categories, token schemas, pixeldiff script) via relative paths like `references/framework-react.md`.

- **Plugin/marketplace install** (`/plugin install d2c` or `npx skills add`): The full directory structure is preserved automatically. Relative paths work out of the box.
- **Manual install** (`./install.sh`): The script copies entire skill directories (including `references/` and `scripts/` subdirectories) to `~/.claude/commands/`. Relative paths resolve from there.
- **Fallback**: If a reference file isn't found at its relative path, skills use a Glob search (`**/filename.md`) as a fallback before giving up.

---

## Limitations

- **Supported frameworks:** React/Next.js, Vue/Nuxt, Svelte/SvelteKit, Angular, Solid.js/SolidStart, Astro.
- **API integration requires user-provided response structures.** The tool generates typed API calls but needs sample response JSON to create accurate types.
- **Does not guarantee pixel-perfection.** 95%+ is the target. Cross-renderer differences (Figma vs Chromium) may limit pixel-diff scores; visual judgment provides the final assessment.
- **Does not create designs.** It implements them.

---

## License

MIT