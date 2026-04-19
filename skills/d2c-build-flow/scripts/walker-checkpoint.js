#!/usr/bin/env node

/**
 * walker-checkpoint.js — Read / write / validate the walker checkpoint
 * artifact at <run-dir>/flow/walker-checkpoint.json. Mirrors d2c-build's
 * .d2c-build-checkpoint.json discipline: atomic write (tmp + rename),
 * hash-anchored to flow-graph.json, schema-validated on read, stale-on-mismatch
 * detection so a Phase 2a re-run between sessions invalidates the checkpoint
 * cleanly instead of resuming with a divergent IR.
 *
 * Usage:
 *   node walker-checkpoint.js write  <run-dir> <checkpoint-json-or-stdin>
 *   node walker-checkpoint.js read   <run-dir>
 *   node walker-checkpoint.js status <run-dir> [--graph-hash <expected-hash>]
 *   node walker-checkpoint.js delete <run-dir>
 *
 * 'status' is the resume-decision helper. It returns one of:
 *   - "missing"   — no checkpoint at all; start fresh
 *   - "ready"     — checkpoint present, hash matches; resume
 *   - "stale"     — checkpoint present, hash differs; F-FLOW-WALKER-CHECKPOINT-STALE
 *
 * Exit codes:
 *   0 — ok / status returned
 *   1 — schema or IO error
 *   2 — CLI misuse
 *
 * Library exports for the walker spec generator and the test suite.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "schemas",
  "walker-checkpoint.schema.json"
);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const SCHEMA_VERSION = 1;

// Reuse the validate-flow-graph inline schema validator so the checkpoint
// gets the same structural checks as the IR.
const { validateSchema } = require(path.join(__dirname, "validate-flow-graph.js"));

function checkpointPath(runDir) {
  return path.join(runDir, "flow", "walker-checkpoint.json");
}

function flowGraphPath(runDir) {
  return path.join(runDir, "flow", "flow-graph.json");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(targetPath, content) {
  ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function computeFlowGraphHash(runDir) {
  const fp = flowGraphPath(runDir);
  if (!fs.existsSync(fp)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function readCheckpoint(runDir) {
  const cp = checkpointPath(runDir);
  if (!fs.existsSync(cp)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cp, "utf8"));
  } catch (e) {
    throw new Error(`walker-checkpoint — could not parse ${cp}: ${e.message}`);
  }
  const errors = validateSchema(SCHEMA, parsed, "", SCHEMA);
  if (errors.length > 0) {
    throw new Error(
      `walker-checkpoint — schema invalid:\n  - ${errors.join("\n  - ")}`
    );
  }
  return parsed;
}

function writeCheckpoint(runDir, checkpoint) {
  const errors = validateSchema(SCHEMA, checkpoint, "", SCHEMA);
  if (errors.length > 0) {
    throw new Error(
      `walker-checkpoint — refusing to write invalid checkpoint:\n  - ${errors.join("\n  - ")}`
    );
  }
  atomicWrite(checkpointPath(runDir), JSON.stringify(checkpoint, null, 2));
  return checkpointPath(runDir);
}

function deleteCheckpoint(runDir) {
  const cp = checkpointPath(runDir);
  if (fs.existsSync(cp)) fs.unlinkSync(cp);
}

/**
 * status() returns the resume-decision verb without throwing on stale.
 * The caller (Phase 4a entry point in SKILL.md) uses this to decide
 * whether to prompt the user to resume.
 */
function status(runDir, expectedHash) {
  const cp = checkpointPath(runDir);
  if (!fs.existsSync(cp)) return { state: "missing" };
  let checkpoint;
  try {
    checkpoint = readCheckpoint(runDir);
  } catch (e) {
    // Schema-invalid checkpoint = stale; safer to start fresh than crash mid-resume.
    return { state: "stale", reason: e.message };
  }
  const currentHash = expectedHash ?? computeFlowGraphHash(runDir);
  if (!currentHash) {
    return {
      state: "stale",
      reason: "current flow-graph.json missing — cannot validate checkpoint hash",
    };
  }
  if (currentHash !== checkpoint.flow_graph_hash) {
    return {
      state: "stale",
      reason: `flow_graph_hash mismatch (checkpoint ${checkpoint.flow_graph_hash.slice(0, 12)}…, current ${currentHash.slice(0, 12)}…)`,
      checkpoint,
    };
  }
  return { state: "ready", checkpoint };
}

/**
 * Build a fresh checkpoint at the start of Phase 4a. Caller fills in
 * current_host_index/viewport/round as it iterates.
 */
function buildCheckpoint(runDir, { startedAt = new Date().toISOString() } = {}) {
  const flowGraphHash = computeFlowGraphHash(runDir);
  if (!flowGraphHash) {
    throw new Error(
      `walker-checkpoint — no flow-graph.json at ${flowGraphPath(runDir)}`
    );
  }
  return {
    schema_version: SCHEMA_VERSION,
    started_at: startedAt,
    flow_graph_hash: flowGraphHash,
    current_host_index: 0,
    current_viewport: "desktop",
    current_round: 1,
    rounds_completed: [],
    files_touched: [],
    snapshot_dirs_by_host: {},
  };
}

/**
 * Append a completed-host entry to rounds_completed[] and persist. The
 * walker calls this after each host/viewport finishes (pass / plateau /
 * regression / max-rounds / skipped).
 */
function recordCompletion(checkpoint, entry) {
  const required = ["host_node_id", "viewport", "rounds", "final_score", "status"];
  for (const k of required) {
    if (!(k in entry)) throw new Error(`recordCompletion — missing field "${k}"`);
  }
  checkpoint.rounds_completed.push(entry);
  return checkpoint;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { verb: argv[0], runDir: argv[1], opts: {} };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--graph-hash") out.opts.graphHash = argv[++i];
    else if (argv[i] === "--in") out.opts.inPath = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const { verb, runDir, opts } = parseArgs(argv);
  if (!verb || !runDir) {
    console.error(
      "usage: walker-checkpoint.js (write [--in <json-file>] | read | status [--graph-hash <hex>] | delete) <run-dir>"
    );
    return 2;
  }

  try {
    if (verb === "status") {
      const s = status(runDir, opts.graphHash);
      console.log(`state: ${s.state}`);
      if (s.reason) console.log(`reason: ${s.reason}`);
      if (s.checkpoint) {
        console.log(`current_host_index: ${s.checkpoint.current_host_index}`);
        console.log(`current_round: ${s.checkpoint.current_round}`);
        console.log(`rounds_completed: ${s.checkpoint.rounds_completed.length}`);
      }
      return 0;
    }
    if (verb === "read") {
      const cp = readCheckpoint(runDir);
      if (cp === null) {
        console.error("error: no walker-checkpoint.json found");
        return 1;
      }
      console.log(JSON.stringify(cp, null, 2));
      return 0;
    }
    if (verb === "write") {
      let raw;
      if (opts.inPath) {
        raw = fs.readFileSync(opts.inPath, "utf8");
      } else {
        raw = fs.readFileSync(0, "utf8"); // stdin
      }
      const cp = JSON.parse(raw);
      const written = writeCheckpoint(runDir, cp);
      console.log(written);
      return 0;
    }
    if (verb === "delete") {
      deleteCheckpoint(runDir);
      console.log("deleted");
      return 0;
    }
    console.error(`unknown verb "${verb}"`);
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
  readCheckpoint,
  writeCheckpoint,
  deleteCheckpoint,
  status,
  buildCheckpoint,
  recordCompletion,
  computeFlowGraphHash,
  checkpointPath,
  SCHEMA_VERSION,
};
