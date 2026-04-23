# Fix Priority Order

Ranking rubric consumed by Phase 4.3b (`analyze_diff` sub-step) when the fix list has multiple issues at similar red-pixel density and the model needs a tiebreaker. This is advice, not an action — it never produces a `sub_step_status` entry of its own.

When two candidate fixes are within ~10% red-pixel density of each other, pick the one earlier in this list:

1. **Structural / layout issues** — wrong grid, missing sections, incorrect ordering. Cause the most red pixels; one structural fix usually subsumes several downstream issues.
2. **Color mismatches** — wrong backgrounds, text colors, accent tints. Render as large solid blocks of red in the diff image.
3. **Spacing issues** — wrong gaps, padding, margins. Render as red outlines and strips around elements.
4. **Typography mismatches** — font size, weight, line-height, family. Render as scattered red pixels inside text regions.
5. **Border radius, shadow, and decorative differences** — small red areas at component edges or behind elevation.
6. **Fine-grained alignment and sub-pixel polish** — minimal red pixels; often renderer artifacts rather than real issues (see cross-renderer note in SKILL.md §4.2).

## Why this ordering

Higher items on the list have **larger blast radii on the diff score** and tend to **force lower items into view**. Fixing a misaligned grid (#1) often eliminates spacing diffs (#3) automatically because the spacing was computed relative to a wrong container. Fixing a color token (#2) usually cascades across every element that consumes it, so the score improvement per edit is highest. Fine-grained polish (#6) is last because a 1px alignment win rarely moves the pixel-diff score by more than ~0.3pp and is often indistinguishable from anti-aliasing noise.

## When to ignore this order

- **Token cascade risk.** If #2 (color) points at a shared design token that 10+ other elements consume AND those elements are currently passing, prefer a narrower fix even if it ranks lower — edits with a wide blast radius risk triggering `P4-SHARED-BLAST-RADIUS` or dragging other regions below threshold.
- **Failed node hint.** If `decisions.lock.json` has a node flagged `status: "failed"` with a specific `failure_reason` (e.g. "wrong component chosen"), that hint wins over this order — the IR already diagnosed the real issue.
- **Explicit user guidance.** Any user instruction in the intake answers or follow-up prompt overrides this ordering.
