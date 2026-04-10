#!/usr/bin/env node

/**
 * pixeldiff.js — Pixel-diff comparison wrapper for d2c-build
 *
 * Usage: node pixeldiff.js <img1.png> <img2.png> <diff.png> [threshold]
 *
 * Compares two PNG images and outputs a diff image + statistics.
 * Handles dimension mismatches by cropping to the smaller of both images.
 *
 * Requires: npm install -g pixelmatch pngjs
 *
 * Output format (matches what d2c-build SKILL.md expects to parse):
 *   matched in: 15.2ms
 *   different pixels: 143
 *   error: 0.15%
 */

const fs = require("fs");
const { execSync } = require("child_process");

/**
 * Resolve a module, falling back to the global node_modules directory.
 * Node's require() doesn't search global node_modules by default,
 * so when pixeldiff.js runs from ~/.claude/skills/ or ~/.agents/skills/,
 * globally-installed packages won't be found without this.
 */
function requireGlobal(name) {
  try {
    return require(name);
  } catch {
    // Get the global node_modules path and try from there
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    return require(require("path").join(globalRoot, name));
  }
}

const { PNG } = requireGlobal("pngjs");
const pixelmatch = requireGlobal("pixelmatch");

const args = process.argv.slice(2);

if (args.length < 3) {
  console.error(
    "Usage: node pixeldiff.js <image1.png> <image2.png> <diff.png> [threshold]"
  );
  console.error(
    "  threshold: 0-1, smaller = more sensitive (default: 0.1)"
  );
  process.exit(1);
}

const [img1Path, img2Path, diffPath, thresholdStr] = args;
const threshold = parseFloat(thresholdStr || "0.1");

// Validate inputs
if (!fs.existsSync(img1Path)) {
  console.error(`Error: File not found: ${img1Path}`);
  process.exit(1);
}
if (!fs.existsSync(img2Path)) {
  console.error(`Error: File not found: ${img2Path}`);
  process.exit(1);
}

const startTime = performance.now();

// Read both images
const img1 = PNG.sync.read(fs.readFileSync(img1Path));
const img2 = PNG.sync.read(fs.readFileSync(img2Path));

// Handle dimension mismatch by cropping to the smaller dimensions
const width = Math.min(img1.width, img2.width);
const height = Math.min(img1.height, img2.height);

// Warn if dimensions differ significantly (>20%)
const widthDiff = Math.abs(img1.width - img2.width) / Math.max(img1.width, img2.width);
const heightDiff = Math.abs(img1.height - img2.height) / Math.max(img1.height, img2.height);
if (widthDiff > 0.2 || heightDiff > 0.2) {
  console.warn(
    `Warning: significant dimension mismatch — image1: ${img1.width}x${img1.height}, image2: ${img2.width}x${img2.height}. ` +
    `Cropping to ${width}x${height}. ${((1 - (width * height) / (Math.max(img1.width, img2.width) * Math.max(img1.height, img2.height))) * 100).toFixed(1)}% of the larger image is excluded from comparison.`
  );
}

function cropImage(img, w, h) {
  if (img.width === w && img.height === h) {
    return img;
  }
  const cropped = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (img.width * y + x) << 2;
      const dstIdx = (w * y + x) << 2;
      cropped.data[dstIdx] = img.data[srcIdx];
      cropped.data[dstIdx + 1] = img.data[srcIdx + 1];
      cropped.data[dstIdx + 2] = img.data[srcIdx + 2];
      cropped.data[dstIdx + 3] = img.data[srcIdx + 3];
    }
  }
  return cropped;
}

const cropped1 = cropImage(img1, width, height);
const cropped2 = cropImage(img2, width, height);
const diff = new PNG({ width, height });

// Run pixelmatch
const numDiffPixels = pixelmatch(
  cropped1.data,
  cropped2.data,
  diff.data,
  width,
  height,
  { threshold, includeAA: false }
);

// Write diff image
fs.writeFileSync(diffPath, PNG.sync.write(diff));

const elapsed = (performance.now() - startTime).toFixed(1);
const totalPixels = width * height;
const errorPercent = ((numDiffPixels / totalPixels) * 100).toFixed(2);

// Output in the format d2c-build expects
console.log(`matched in: ${elapsed}ms`);
console.log(`different pixels: ${numDiffPixels}`);
console.log(`error: ${errorPercent}%`);

// Also output JSON for programmatic use
if (process.env.JSON_OUTPUT === "1") {
  console.log(
    JSON.stringify({
      matchPercent: (100 - parseFloat(errorPercent)).toFixed(1),
      diffPixels: numDiffPixels,
      totalPixels,
      error: parseFloat(errorPercent),
      width,
      height,
      threshold,
      elapsed: parseFloat(elapsed),
    })
  );
}

// Region output: connected-component analysis on diff pixels
if (process.env.REGIONS_OUTPUT === "1") {
  const MIN_CLUSTER_PIXELS = 100; // Ignore noise clusters smaller than this
  const MERGE_DISTANCE = 10; // Merge clusters within this many pixels of each other

  // Build a boolean grid of "is this pixel different?"
  const isDiff = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // Diff image marks differences with red pixels (R=255, G=0, B=0).
      // Matching pixels are drawn as faded gray (R≈237, G≈237, B≈237).
      // Check R high AND G low to distinguish diff pixels from matching.
      isDiff[y * width + x] = (diff.data[idx] > 200 && diff.data[idx + 1] < 50) ? 1 : 0;
    }
  }

  // Flood-fill connected components (4-connectivity)
  const labels = new Int32Array(width * height).fill(-1);
  const bboxes = []; // { x0, y0, x1, y1, count }
  let nextLabel = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = y * width + x;
      if (!isDiff[pos] || labels[pos] !== -1) continue;

      // BFS flood fill
      const label = nextLabel++;
      const bbox = { x0: x, y0: y, x1: x, y1: y, count: 0 };
      const queue = [pos];
      labels[pos] = label;

      while (queue.length > 0) {
        const cur = queue.pop();
        const cx = cur % width;
        const cy = (cur - cx) / width;

        bbox.x0 = Math.min(bbox.x0, cx);
        bbox.y0 = Math.min(bbox.y0, cy);
        bbox.x1 = Math.max(bbox.x1, cx);
        bbox.y1 = Math.max(bbox.y1, cy);
        bbox.count++;

        // 4-connectivity neighbors
        const neighbors = [
          cy > 0 ? cur - width : -1,
          cy < height - 1 ? cur + width : -1,
          cx > 0 ? cur - 1 : -1,
          cx < width - 1 ? cur + 1 : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && isDiff[n] && labels[n] === -1) {
            labels[n] = label;
            queue.push(n);
          }
        }
      }

      bboxes.push(bbox);
    }
  }

  // Filter out noise clusters
  let regions = bboxes.filter((b) => b.count >= MIN_CLUSTER_PIXELS);

  // Merge clusters within MERGE_DISTANCE of each other
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        if (
          a.x0 - MERGE_DISTANCE <= b.x1 &&
          a.x1 + MERGE_DISTANCE >= b.x0 &&
          a.y0 - MERGE_DISTANCE <= b.y1 &&
          a.y1 + MERGE_DISTANCE >= b.y0
        ) {
          // Merge b into a
          a.x0 = Math.min(a.x0, b.x0);
          a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1);
          a.y1 = Math.max(a.y1, b.y1);
          a.count += b.count;
          regions.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  // Sort by diff pixel count descending (highest impact first)
  regions.sort((a, b) => b.count - a.count);

  const regionOutput = regions.map((r) => ({
    x: r.x0,
    y: r.y0,
    w: r.x1 - r.x0 + 1,
    h: r.y1 - r.y0 + 1,
    diffPixels: r.count,
    errorPercent: parseFloat(((r.count / totalPixels) * 100).toFixed(2)),
  }));

  console.log(JSON.stringify({ regions: regionOutput }));
}
