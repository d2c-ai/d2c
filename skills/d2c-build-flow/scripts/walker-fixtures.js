#!/usr/bin/env node

/**
 * walker-fixtures.js — Read / write / merge walker-fixtures.json. The
 * walker spec reads this file before filling a `validate: form` step's
 * inputs; the user-supplied values from F-FLOW-WALKER-VALIDATION-BLOCKED
 * are persisted here so reruns don't re-prompt.
 *
 * Schema: skills/d2c-build-flow/schemas/walker-fixtures.schema.json
 *
 * CLI:
 *   node walker-fixtures.js read   <run-dir>
 *   node walker-fixtures.js write  <run-dir> [--in <json-file>]
 *   node walker-fixtures.js get    <run-dir> <step-key> <field-name>
 *   node walker-fixtures.js merge  <run-dir> <step-key> <field-name> \
 *       <value> [--source user|auto-fixture] [--type string|number|boolean]
 *
 * Exit codes:
 *   0 — ok
 *   1 — IO / schema error
 *   2 — CLI misuse
 *
 * `merge` is the write path the walker uses on the auto-fixture side and
 * the SKILL prompt uses on the user-supplied side. User-supplied always
 * wins: a `merge --source auto-fixture` call is silently skipped if a
 * `user`-sourced entry already exists for the same (step, field) tuple.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "schemas",
  "walker-fixtures.schema.json"
);
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const SCHEMA_VERSION = 1;

// Reuse the inline schema validator from validate-flow-graph.js so the
// fixture artifact gets the same structural checks as the IR.
const { validateSchema } = require(path.join(__dirname, "validate-flow-graph.js"));

function fixturesPath(runDir) {
  return path.join(runDir, "flow", "walker-fixtures.json");
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

function emptyFixtures() {
  return { schema_version: SCHEMA_VERSION, fixtures: {} };
}

function readFixtures(runDir) {
  const fp = fixturesPath(runDir);
  if (!fs.existsSync(fp)) return emptyFixtures();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    throw new Error(`walker-fixtures — could not parse ${fp}: ${e.message}`);
  }
  const errors = validateSchema(SCHEMA, parsed, "", SCHEMA);
  if (errors.length > 0) {
    throw new Error(
      `walker-fixtures — schema invalid:\n  - ${errors.join("\n  - ")}`
    );
  }
  return parsed;
}

function writeFixtures(runDir, fixtures) {
  const errors = validateSchema(SCHEMA, fixtures, "", SCHEMA);
  if (errors.length > 0) {
    throw new Error(
      `walker-fixtures — refusing to write invalid fixtures:\n  - ${errors.join("\n  - ")}`
    );
  }
  atomicWrite(fixturesPath(runDir), JSON.stringify(fixtures, null, 2));
  return fixturesPath(runDir);
}

/**
 * Look up a single field's fixture value with user-wins semantics. Returns
 * null when the (step, field) tuple has no entry — caller falls back to
 * auto-generating from SKILL.md §4a.2 rules.
 */
function getFixture(runDir, stepKey, fieldName) {
  const fixtures = readFixtures(runDir);
  return fixtures.fixtures[stepKey]?.[fieldName] ?? null;
}

/**
 * Insert or overwrite a fixture value with user-wins semantics:
 *   - existing entry has supplied_by === "user"
 *     AND incoming entry.supplied_by === "auto-fixture"  → keep existing
 *   - otherwise                                          → overwrite
 *
 * Returns { written: bool, entry: <final entry> }.
 */
function mergeFixture(runDir, stepKey, fieldName, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("mergeFixture — entry must be an object");
  }
  const required = ["value", "supplied_by", "supplied_at"];
  for (const k of required) {
    if (!(k in entry)) throw new Error(`mergeFixture — entry missing "${k}"`);
  }
  const fixtures = readFixtures(runDir);
  if (!fixtures.fixtures[stepKey]) fixtures.fixtures[stepKey] = {};

  const existing = fixtures.fixtures[stepKey][fieldName];
  if (
    existing &&
    existing.supplied_by === "user" &&
    entry.supplied_by === "auto-fixture"
  ) {
    return { written: false, entry: existing };
  }

  fixtures.fixtures[stepKey][fieldName] = entry;
  writeFixtures(runDir, fixtures);
  return { written: true, entry };
}

function buildStepKey(groupNodeId, stepIndex) {
  if (typeof groupNodeId !== "string" || !groupNodeId) {
    throw new Error("buildStepKey — groupNodeId must be a non-empty string");
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 1) {
    throw new Error("buildStepKey — stepIndex must be a positive integer");
  }
  return `${groupNodeId}__step_${stepIndex}`;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { verb: argv[0], runDir: argv[1], opts: {}, positional: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--in") out.opts.inPath = argv[++i];
    else if (argv[i] === "--source") out.opts.source = argv[++i];
    else if (argv[i] === "--type") out.opts.type = argv[++i];
    else out.positional.push(argv[i]);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const { verb, runDir, opts, positional } = parseArgs(argv);
  if (!verb || !runDir) {
    console.error(
      "usage: walker-fixtures.js (read | write [--in <json>] | get <step-key> <field> | merge <step-key> <field> <value> [--source user|auto-fixture] [--type string|number|boolean]) <run-dir>"
    );
    return 2;
  }
  try {
    if (verb === "read") {
      const fx = readFixtures(runDir);
      console.log(JSON.stringify(fx, null, 2));
      return 0;
    }
    if (verb === "write") {
      const raw = opts.inPath
        ? fs.readFileSync(opts.inPath, "utf8")
        : fs.readFileSync(0, "utf8");
      writeFixtures(runDir, JSON.parse(raw));
      console.log(fixturesPath(runDir));
      return 0;
    }
    if (verb === "get") {
      const [stepKey, field] = positional;
      if (!stepKey || !field) {
        console.error("get requires <step-key> and <field>");
        return 2;
      }
      const entry = getFixture(runDir, stepKey, field);
      if (entry == null) {
        console.log("null");
        return 0;
      }
      console.log(JSON.stringify(entry, null, 2));
      return 0;
    }
    if (verb === "merge") {
      const [stepKey, field, rawValue] = positional;
      if (!stepKey || !field || rawValue === undefined) {
        console.error("merge requires <step-key> <field> <value>");
        return 2;
      }
      const source = opts.source || "auto-fixture";
      if (source !== "user" && source !== "auto-fixture") {
        console.error(`--source must be 'user' or 'auto-fixture' (got ${source})`);
        return 2;
      }
      const type = opts.type || "string";
      let value = rawValue;
      if (type === "number") value = Number(rawValue);
      else if (type === "boolean") value = rawValue === "true";
      const entry = {
        value,
        supplied_by: source,
        supplied_at: new Date().toISOString(),
        field_type: type,
      };
      const result = mergeFixture(runDir, stepKey, field, entry);
      console.log(JSON.stringify({ written: result.written, entry: result.entry }, null, 2));
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
  readFixtures,
  writeFixtures,
  getFixture,
  mergeFixture,
  buildStepKey,
  fixturesPath,
  emptyFixtures,
  SCHEMA_VERSION,
};
