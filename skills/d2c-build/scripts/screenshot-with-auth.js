#!/usr/bin/env node

/**
 * screenshot-with-auth.js — Drop-in replacement for `npx playwright screenshot`
 * that loads a Playwright `storageState` JSON before navigating, so the
 * captured screenshot is the authenticated host (not the login redirect).
 *
 * Used by d2c-build Phase 4.1 when an `auth-state.json` exists at
 * `$D2C_TMP/auth-state.json` (produced by `phase4-login.js`). When no
 * auth state is needed, Phase 4.1 keeps using the existing `npx playwright
 * screenshot` CLI — this helper is opt-in via the `--auth-state` flag.
 *
 * Usage:
 *   node screenshot-with-auth.js \
 *     --url <full URL> \
 *     --output <path/to/file.png> \
 *     --viewport 1280x800 \
 *     [--auth-state <path/to/auth-state.json>] \
 *     [--timeout 10000] \
 *     [--full-page]
 *
 * Mirrors the CLI surface of `npx playwright screenshot` so the rest of
 * Phase 4.1 doesn't have to branch on syntax — only on which executable
 * to invoke.
 *
 * Exit codes:
 *   0 — screenshot written
 *   1 — Playwright error (page didn't load, selector timeout, etc.)
 *   2 — CLI misuse (or `playwright` not installed)
 *
 * Stdout (machine-readable, one key per line):
 *   screenshot-with-auth: ok | fail
 *   url: <url>
 *   viewport: <WxH>
 *   auth_loaded: yes | no
 *   wrote: <abs path>          # only when ok
 *   error: <description>       # only when fail
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function requireGlobal(name) {
  try {
    return require(name);
  } catch {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      return require(path.join(globalRoot, name));
    } catch (e) {
      const err = new Error(
        `Cannot find ${name} (tried local + global). Run /d2c-init or npm install -g playwright.`
      );
      err.cause = e;
      throw err;
    }
  }
}

function parseViewport(s) {
  const m = /^(\d+)\s*[xX,]\s*(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function parseArgs(argv) {
  const out = {
    url: null,
    output: null,
    viewport: { width: 1280, height: 800 },
    authState: null,
    timeout: 10000,
    fullPage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--output") out.output = argv[++i];
    else if (a === "--viewport") {
      const v = parseViewport(argv[++i]);
      if (!v) return null;
      out.viewport = v;
    } else if (a === "--auth-state") out.authState = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--full-page") out.fullPage = true;
    else return null;
  }
  if (!out.url || !out.output) return null;
  return out;
}

async function shoot(opts) {
  const { chromium } = requireGlobal("playwright");
  const contextOpts = { viewport: opts.viewport };
  let authLoaded = false;
  if (opts.authState) {
    if (!fs.existsSync(opts.authState)) {
      throw new Error(`auth-state file not found: ${opts.authState}`);
    }
    contextOpts.storageState = opts.authState;
    authLoaded = true;
  }
  const browser = await chromium.launch();
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  try {
    await page.goto(opts.url, { timeout: opts.timeout, waitUntil: "load" });
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    await page.screenshot({
      path: opts.output,
      fullPage: opts.fullPage,
      timeout: opts.timeout,
    });
    return { ok: true, authLoaded, wrote: path.resolve(opts.output) };
  } finally {
    await browser.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts) {
    console.error(
      "usage: screenshot-with-auth.js --url <url> --output <path> [--viewport WxH] [--auth-state <path>] [--timeout ms] [--full-page]"
    );
    return 2;
  }
  let result;
  try {
    result = await shoot(opts);
  } catch (e) {
    console.log("screenshot-with-auth: fail");
    console.log(`url: ${opts.url}`);
    console.log(`viewport: ${opts.viewport.width}x${opts.viewport.height}`);
    console.log(`auth_loaded: ${opts.authState ? "yes" : "no"}`);
    console.log(`error: ${e.message.split("\n")[0]}`);
    return 1;
  }
  console.log("screenshot-with-auth: ok");
  console.log(`url: ${opts.url}`);
  console.log(`viewport: ${opts.viewport.width}x${opts.viewport.height}`);
  console.log(`auth_loaded: ${result.authLoaded ? "yes" : "no"}`);
  console.log(`wrote: ${result.wrote}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  shoot,
  parseArgs,
  parseViewport,
};
