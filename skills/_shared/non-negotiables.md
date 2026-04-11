# d2c Non-negotiables (canonical source)

This file is the canonical source for the `## Non-negotiables` preamble block that appears at the top of every d2c skill file. If you change any rule here, you MUST update the inline copy in every skill file that contains it. Drift is enforced by `scripts/validate-non-negotiables.js`.

Skill files that embed this block:
- `skills/d2c-init/SKILL.md`
- `skills/d2c-build/SKILL.md`
- `skills/d2c-audit/SKILL.md`
- `skills/d2c-guard/SKILL.md`

The canonical block is everything between the BEGIN and END HTML comment markers below. Each skill file has the same markers surrounding an inline copy of this block. `validate-non-negotiables.js` extracts the content between the markers and asserts byte equality (whitespace-normalized).

<!-- NON-NEGOTIABLES:BEGIN -->
## Non-negotiables

These rules hold across every phase of this skill. No exceptions.

1. **Design tokens MUST be loaded before any decision.** Read `.claude/d2c/design-tokens.json`. If it is missing, unreadable, or has `d2c_schema_version < 1`, STOP AND ASK the user to run `/d2c-init` (or `/d2c-init --force` if outdated).
2. **NEVER use a library outside `preferred_libraries.<category>.selected`.** The user explicitly chose which library to use for each capability. NEVER substitute an installed-but-not-selected library. If the design requires a capability not covered by `preferred_libraries`, STOP AND ASK.
3. **NEVER hardcode color, spacing, typography, shadow, or radius values.** Every visual value MUST reference a design token from `design-tokens.json`. No raw hex, no magic numbers, no exceptions.
4. **MUST reuse existing components when an existing component can serve the need.** Check the `components` array in `design-tokens.json` before creating anything new. If an existing component can do the job, MUST use it.
5. **MUST follow project conventions when `confidence > 0.6` and `value ≠ "mixed"`.** Project conventions (declaration style, export style, type definitions, import ordering, file naming, CSS wrapper, barrel exports, props pattern) override framework defaults.
6. **NEVER re-decide a locked component or token.** Read `decisions.lock.json` from the IR run directory at the start of every phase after Phase 2. Only nodes with `status: "failed"` may have their component choice or token mapping changed. If a locked decision must change, STOP AND ASK.

**When any rule is ambiguous, STOP AND ASK — do not guess.**
<!-- NON-NEGOTIABLES:END -->
