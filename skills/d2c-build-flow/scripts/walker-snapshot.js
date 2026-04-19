#!/usr/bin/env node

/**
 * walker-snapshot.js — Snapshot / revert / plateau / oscillation helpers
 * for the /d2c-build-flow Phase 4a flow-walker auto-fix loop. Mirrors
 * d2c-build/SKILL.md §Phase 4.4a-d (snapshot before edits → revert on
 * regression → plateau detection → oscillation detection) so the walker's
 * convergence guarantees match the build skill's.
 *
 * Library-only by default (no CLI flow uses this directly except via the
 * walker spec). Dual-mode for ease of debugging:
 *
 *   node walker-snapshot.js snapshot <snapshot-dir> <file1> [file2 ...]
 *   node walker-snapshot.js revert   <snapshot-dir> <file1> [file2 ...]
 *
 * Constants match d2c-build's defaults verbatim:
 *   THRESHOLD              = 95   (passing pixel-diff %)
 *   MAX_ROUNDS             = 3    (auto-fix budget per host/viewport)
 *   PLATEAU_DELTA          = 1.0  (improvement <1pp = plateau)
 *   OSCILLATION_WINDOW     = 3    (look back 3 rounds)
 *   OSCILLATION_DELTA      = 2.0  (range within 2pp = oscillating)
 *   REGRESSION_DELTA       = 1.0  (drop >1pp = regression → revert)
 *   PLATEAU_OK_THRESHOLD   = 80   (≥80% plateau = inform; <80% = stop-and-ask)
 *
 * Exits 0 on success, 1 on file errors, 2 on CLI misuse.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const THRESHOLD = 95;
const MAX_ROUNDS = 3;
const PLATEAU_DELTA = 1.0;
const OSCILLATION_WINDOW = 3;
const OSCILLATION_DELTA = 2.0;
const REGRESSION_DELTA = 1.0;
const PLATEAU_OK_THRESHOLD = 80;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicCopy(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`source file not found: ${src}`);
  }
  ensureDir(path.dirname(dest));
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

/**
 * Snapshot every file in `files[]` into `snapshotDir`, preserving the file's
 * absolute path under `snapshotDir/<absolute-path>` so revert can find it
 * deterministically. Atomic per-file copy via tmp-rename.
 *
 * Returns the list of snapshotted paths (one per input file) for the caller
 * to record in round_history[].snapshot_files[].
 */
function snapshot(snapshotDir, files) {
  ensureDir(snapshotDir);
  const written = [];
  for (const filePath of files) {
    const absolute = path.resolve(filePath);
    // strip leading "/" so the path joins cleanly under snapshotDir
    const dest = path.join(snapshotDir, absolute.replace(/^\/+/, ""));
    atomicCopy(absolute, dest);
    written.push(dest);
  }
  return written;
}

/**
 * Revert every file in `files[]` from its snapshot at `snapshotDir`. The
 * snapshotted path is computed the same way as `snapshot()` — by joining
 * the absolute path under `snapshotDir`. A missing snapshot for any file
 * is a hard error (the caller passed wrong files OR the snapshot was
 * cleaned out from under us).
 */
function revert(snapshotDir, files) {
  for (const filePath of files) {
    const absolute = path.resolve(filePath);
    const src = path.join(snapshotDir, absolute.replace(/^\/+/, ""));
    if (!fs.existsSync(src)) {
      throw new Error(
        `snapshot not found at ${src} — cannot revert ${absolute}`
      );
    }
    atomicCopy(src, absolute);
  }
}

/**
 * Did the just-finished round regress? A drop greater than REGRESSION_DELTA
 * (1.0pp by default) triggers a snapshot revert. The delta is positive when
 * the score went down (so callers can compare delta > REGRESSION_DELTA).
 */
function detectRegression(currentScore, prevScore) {
  if (prevScore == null) {
    return { regressing: false, delta: 0 };
  }
  const delta = prevScore - currentScore;
  return { regressing: delta > REGRESSION_DELTA, delta };
}

/**
 * Did the just-finished round plateau? Improvement strictly less than
 * PLATEAU_DELTA (1.0pp). Returns the recommended tier:
 *   - "ok"           → first round, nothing to compare
 *   - "improving"    → improvement ≥ 1pp
 *   - "plateau-ok"   → plateau AND current_score ≥ PLATEAU_OK_THRESHOLD (80%)
 *   - "plateau-stop" → plateau AND current_score < PLATEAU_OK_THRESHOLD
 */
function detectPlateau(currentScore, prevScore) {
  if (prevScore == null) {
    return { plateau: false, tier: "ok", improvement: null };
  }
  const improvement = currentScore - prevScore;
  if (improvement >= PLATEAU_DELTA) {
    return { plateau: false, tier: "improving", improvement };
  }
  return {
    plateau: true,
    tier: currentScore >= PLATEAU_OK_THRESHOLD ? "plateau-ok" : "plateau-stop",
    improvement,
  };
}

/**
 * Are the last OSCILLATION_WINDOW (3) rounds within OSCILLATION_DELTA (2pp)
 * of each other? That signals the auto-fix loop is bouncing between
 * candidate fixes without converging. Need at least WINDOW scores to fire.
 */
function detectOscillation(scoreHistory) {
  if (!Array.isArray(scoreHistory) || scoreHistory.length < OSCILLATION_WINDOW) {
    return { oscillating: false, range: null };
  }
  const window = scoreHistory.slice(-OSCILLATION_WINDOW);
  const max = Math.max(...window);
  const min = Math.min(...window);
  const range = max - min;
  return { oscillating: range <= OSCILLATION_DELTA, range };
}

/**
 * One-shot decision helper. Given the round just finished and the prior
 * score history, return a verb the caller (the walker spec or the AI
 * driving Phase 4a) can act on:
 *
 *   - "pass"       → score >= THRESHOLD; stop autofixing this host
 *   - "regression" → revert + try alternate fix (auto-recover, 1 retry)
 *   - "oscillation" → STOP AND ASK (F-FLOW-WALKER-OSCILLATION)
 *   - "plateau-stop" → STOP AND ASK (F-FLOW-WALKER-PLATEAU, score < 80%)
 *   - "plateau-ok" → INFORM and stop (F-FLOW-WALKER-PLATEAU, score >= 80%)
 *   - "max-rounds" → INFORM and stop (P4-MAX-ROUNDS analog)
 *   - "continue"  → still improving and budget remains
 */
function decideNextAction({
  currentScore,
  prevScore,
  roundIndex,
  scoreHistory,
  threshold = THRESHOLD,
  maxRounds = MAX_ROUNDS,
}) {
  if (currentScore >= threshold) return { action: "pass" };
  const reg = detectRegression(currentScore, prevScore);
  if (reg.regressing) {
    return { action: "regression", delta: reg.delta };
  }
  const osc = detectOscillation(scoreHistory);
  if (osc.oscillating) {
    return { action: "oscillation", range: osc.range };
  }
  const plateau = detectPlateau(currentScore, prevScore);
  if (plateau.plateau) {
    return { action: plateau.tier, improvement: plateau.improvement };
  }
  if (roundIndex >= maxRounds) {
    return { action: "max-rounds" };
  }
  return { action: "continue" };
}

// ---------- CLI ----------

function main(argv = process.argv.slice(2)) {
  const [verb, snapshotDir, ...files] = argv;
  if (!verb || !snapshotDir || files.length === 0) {
    console.error(
      "usage: walker-snapshot.js (snapshot|revert) <snapshot-dir> <file1> [file2 ...]"
    );
    return 2;
  }
  try {
    if (verb === "snapshot") {
      const written = snapshot(snapshotDir, files);
      for (const w of written) console.log(`snapshot: ${w}`);
      return 0;
    }
    if (verb === "revert") {
      revert(snapshotDir, files);
      for (const f of files) console.log(`revert: ${path.resolve(f)}`);
      return 0;
    }
    console.error(`unknown verb "${verb}" — use snapshot or revert`);
    return 2;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  snapshot,
  revert,
  detectRegression,
  detectPlateau,
  detectOscillation,
  decideNextAction,
  THRESHOLD,
  MAX_ROUNDS,
  PLATEAU_DELTA,
  OSCILLATION_WINDOW,
  OSCILLATION_DELTA,
  REGRESSION_DELTA,
  PLATEAU_OK_THRESHOLD,
};
