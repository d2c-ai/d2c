#!/usr/bin/env node

/**
 * format-frame-picker.js — Render a numbered frame pick-list for the
 * F-FLOW-FILE-URL failure recovery path.
 *
 * Consumed by d2c-build-flow Phase 1 when a step URL lacks `?node-id=` and
 * the model calls `mcp__figma__get_metadata` to fetch the file's top-level
 * frames. This helper formats the raw metadata into the prompt string the
 * user sees inside the STOP-AND-ASK block, so the formatting stays
 * deterministic and unit-testable without a live Figma call.
 *
 * Contract:
 *   - Input accepts the Figma metadata shape with a `document.children[]`
 *     list (as returned by `get_metadata`). Only top-level entries whose
 *     `type === "FRAME"` are rendered. Nested children and non-FRAME types
 *     (SECTION, COMPONENT, COMPONENT_SET, GROUP, OVERLAY, …) are skipped.
 *   - Node ids are emitted in Figma's colon form (`1:2`), hyphen input
 *     (`1-2`) is normalised.
 *   - Empty frame list returns a sentinel `{ kind: "empty", text: "..." }`
 *     so the caller can route to FX-UNKNOWN-FAILURE instead of presenting
 *     an empty pick-list.
 *
 * Usage (programmatic):
 *   const { formatFramePicker } = require('./format-frame-picker');
 *   const result = formatFramePicker({ frames, stepNumber, fileUrl });
 *   if (result.kind === 'ok') process.stdout.write(result.text);
 *
 * Usage (CLI, for ad-hoc inspection):
 *   node format-frame-picker.js <metadata.json> <step-number> <file-url>
 *
 * Exit codes:
 *   0 — ok (either picker rendered or empty sentinel)
 *   2 — CLI misuse
 */

"use strict";

const fs = require("fs");
const path = require("path");

function formatFramePicker({ frames, stepNumber, fileUrl } = {}) {
  if (!Number.isInteger(stepNumber) || stepNumber < 1) {
    throw new TypeError("stepNumber must be a positive integer");
  }
  if (typeof fileUrl !== "string" || fileUrl.length === 0) {
    throw new TypeError("fileUrl must be a non-empty string");
  }

  const topLevelFrames = extractTopLevelFrames(frames);

  if (topLevelFrames.length === 0) {
    return {
      kind: "empty",
      text: `Step ${stepNumber} points to a Figma file URL, but get_metadata returned no top-level FRAME entries for ${fileUrl}.`,
    };
  }

  const lines = [
    `Step ${stepNumber} points to a Figma file URL, not a specific frame:`,
    fileUrl,
    "",
    "Frames in this file:",
  ];
  topLevelFrames.forEach((frame, i) => {
    lines.push(`${i + 1}. ${frame.name} — node ${frame.nodeId}`);
  });
  lines.push("");
  lines.push(`Which frame is step ${stepNumber}? (number, or \`abort\`)`);

  return { kind: "ok", text: lines.join("\n"), frames: topLevelFrames };
}

function extractTopLevelFrames(input) {
  if (!input) return [];

  // Accept either the raw get_metadata response (with a `document.children`)
  // or a pre-extracted array of candidate frames.
  let candidates = [];
  if (Array.isArray(input)) {
    candidates = input;
  } else if (input.document && Array.isArray(input.document.children)) {
    candidates = [];
    for (const child of input.document.children) {
      // Some files wrap top-level frames inside CANVAS / PAGE nodes. Unwrap
      // one level so we reach the actual top-level frames a user would pick.
      if (child && Array.isArray(child.children) && isPageLike(child)) {
        candidates.push(...child.children);
      } else {
        candidates.push(child);
      }
    }
  } else if (Array.isArray(input.children)) {
    candidates = input.children;
  } else if (Array.isArray(input.frames)) {
    candidates = input.frames;
  }

  const frames = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    if (c.type !== "FRAME") continue;
    const id = normalizeNodeId(c.id || c.node_id || c.nodeId);
    const name = typeof c.name === "string" && c.name.length > 0 ? c.name : id;
    if (!id) continue;
    frames.push({ nodeId: id, name });
  }
  return frames;
}

function isPageLike(node) {
  if (!node || typeof node !== "object") return false;
  return node.type === "CANVAS" || node.type === "PAGE" || node.type === "DOCUMENT";
}

function normalizeNodeId(raw) {
  if (typeof raw !== "string") return null;
  const decoded = tryDecode(raw);
  return decoded.replace(/-/g, ":");
}

function tryDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_e) {
    return s;
  }
}

// ---------- CLI ----------

function runCli(argv) {
  if (argv.length !== 3) {
    process.stderr.write(
      "usage: format-frame-picker.js <metadata.json> <step-number> <file-url>\n"
    );
    process.exit(2);
  }
  const [metadataPath, stepArg, fileUrl] = argv;
  const stepNumber = parseInt(stepArg, 10);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) {
    process.stderr.write("step-number must be a positive integer\n");
    process.exit(2);
  }
  const frames = JSON.parse(fs.readFileSync(path.resolve(metadataPath), "utf8"));
  const result = formatFramePicker({ frames, stepNumber, fileUrl });
  process.stdout.write(`format-frame-picker: ${result.kind}\n`);
  process.stdout.write(result.text + "\n");
  process.exit(0);
}

module.exports = { formatFramePicker };

if (require.main === module) {
  runCli(process.argv.slice(2));
}
