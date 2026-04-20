#!/usr/bin/env node

/**
 * phase4-login.js — One-shot login helper for d2c-build Phase 4. Uses the
 * Playwright Node API (not the CLI — `npx playwright screenshot` doesn't
 * accept storage state) to log in once and write a `storageState` JSON to
 * disk. Subsequent screenshots load that state via `screenshot-with-auth.js`
 * so the rendered page is the authenticated host, not the login redirect.
 *
 * Mirrors the discipline of d2c-build-flow Phase 4a.0b's `loginBefore()`
 * fixture — same auth systems, same env-var contract (D2C_TEST_USER /
 * D2C_TEST_PASSWORD), same selectors. The fixture in the flow uses
 * @playwright/test; this script uses `playwright` (the npm package). Both
 * end up at the same place: a browser context with a valid session.
 *
 * Usage:
 *   node phase4-login.js \
 *     --base-url <http://localhost:3000> \
 *     --login-url </sign-in> \
 *     --system <next-auth|clerk|supabase|middleware> \
 *     --out <path/to/auth-state.json> \
 *     [--email-selector <css>] [--password-selector <css>] [--submit-selector <css>] \
 *     [--timeout 8000]
 *
 * Reads `D2C_TEST_USER` and `D2C_TEST_PASSWORD` from process.env (which the
 * caller is expected to source from `.env.local`).
 *
 * Exit codes:
 *   0 — login succeeded; storageState written to --out
 *   1 — login failed (env missing OR submit didn't produce a session)
 *   2 — CLI misuse (or `playwright` not installed)
 *
 * Stdout (machine-readable, one key per line):
 *   phase4-login: ok | fail
 *   system: <system>
 *   login_url: <url>
 *   final_url: <url>            # where we ended up after submit
 *   session_detected: cookie | redirect | none
 *   wrote: <out path>           # only when ok
 *   error: <description>        # only when fail
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const COOKIE_NAME_BY_SYSTEM = {
  "next-auth": "next-auth.session-token",
  clerk: "__session",
  supabase: "sb-access-token",
  middleware: null,
};

const DEFAULT_SELECTORS = {
  email: "input[type='email'], input[name='email'], input[id='email']",
  password:
    "input[type='password'], input[name='password'], input[id='password']",
  submit:
    "button[type='submit'], button:has-text('Sign in'), button:has-text('Log in')",
};

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

function parseArgs(argv) {
  const out = {
    baseUrl: null,
    loginUrl: null,
    system: null,
    out: null,
    emailSel: DEFAULT_SELECTORS.email,
    passwordSel: DEFAULT_SELECTORS.password,
    submitSel: DEFAULT_SELECTORS.submit,
    timeout: 8000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--login-url") out.loginUrl = argv[++i];
    else if (a === "--system") out.system = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--email-selector") out.emailSel = argv[++i];
    else if (a === "--password-selector") out.passwordSel = argv[++i];
    else if (a === "--submit-selector") out.submitSel = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else return null;
  }
  if (!out.baseUrl || !out.loginUrl || !out.system || !out.out) return null;
  if (!(out.system in COOKIE_NAME_BY_SYSTEM)) return null;
  return out;
}

async function login(opts) {
  const { chromium } = requireGlobal("playwright");
  const user = process.env.D2C_TEST_USER;
  const password = process.env.D2C_TEST_PASSWORD;
  if (!user || !password) {
    return {
      ok: false,
      error: "D2C_TEST_USER / D2C_TEST_PASSWORD not set in process.env",
    };
  }
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const fullLoginUrl = new URL(opts.loginUrl, opts.baseUrl).toString();
  let finalUrl = fullLoginUrl;
  let sessionDetected = "none";
  try {
    await page.goto(fullLoginUrl, { timeout: opts.timeout });
    await page.locator(opts.emailSel).first().fill(user);
    await page.locator(opts.passwordSel).first().fill(password);
    await page.locator(opts.submitSel).first().click();

    // Two acceptance signals: redirect away from login URL OR session cookie present.
    const cookieName = COOKIE_NAME_BY_SYSTEM[opts.system];
    const redirectPromise = page
      .waitForURL((u) => !u.pathname.startsWith(opts.loginUrl), {
        timeout: opts.timeout,
      })
      .then(() => "redirect")
      .catch(() => null);
    const cookiePromise = cookieName
      ? new Promise(async (resolve) => {
          const start = Date.now();
          while (Date.now() - start < opts.timeout) {
            const cookies = await context.cookies();
            if (cookies.some((c) => c.name === cookieName)) return resolve("cookie");
            await new Promise((r) => setTimeout(r, 200));
          }
          resolve(null);
        })
      : Promise.resolve(null);
    sessionDetected = (await Promise.race([redirectPromise, cookiePromise])) || "none";
    finalUrl = page.url();

    if (sessionDetected === "none") {
      const html = (await page.content()).slice(0, 500);
      return {
        ok: false,
        finalUrl,
        sessionDetected,
        error: `no session detected after submit (no redirect, no ${cookieName ?? "session"} cookie). Last HTML: ${html.replace(/\n/g, " ")}`,
      };
    }

    const state = await context.storageState();
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    const tmp = `${opts.out}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, opts.out);
    return { ok: true, finalUrl, sessionDetected };
  } finally {
    await browser.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts) {
    console.error(
      "usage: phase4-login.js --base-url <url> --login-url <path> --system <next-auth|clerk|supabase|middleware> --out <path> [selectors...] [--timeout <ms>]"
    );
    return 2;
  }
  let result;
  try {
    result = await login(opts);
  } catch (e) {
    console.log("phase4-login: fail");
    console.log(`system: ${opts.system}`);
    console.log(`login_url: ${opts.loginUrl}`);
    console.log(`error: ${e.message.split("\n")[0]}`);
    return 1;
  }
  console.log(`phase4-login: ${result.ok ? "ok" : "fail"}`);
  console.log(`system: ${opts.system}`);
  console.log(`login_url: ${opts.loginUrl}`);
  if (result.finalUrl) console.log(`final_url: ${result.finalUrl}`);
  console.log(`session_detected: ${result.sessionDetected ?? "none"}`);
  if (result.ok) {
    console.log(`wrote: ${path.resolve(opts.out)}`);
    return 0;
  }
  console.log(`error: ${result.error}`);
  return 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  login,
  parseArgs,
  COOKIE_NAME_BY_SYSTEM,
  DEFAULT_SELECTORS,
};
