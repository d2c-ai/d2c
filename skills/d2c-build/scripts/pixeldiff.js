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
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");

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
