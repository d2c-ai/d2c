#!/usr/bin/env node

/**
 * detect-project-conventions.js — Detect the target project's existing
 * conventions around Server/Client Components, error boundaries, and data
 * fetching. Consumed by d2c-build-flow Phase 2a when any page/step carries
 * state_variants — per-variant /d2c-build dispatch and Phase 3 codegen both
 * read this block so the generated code matches the project's idioms rather
 * than imposing a new pattern.
 *
 * The detector never prescribes. It only reports what it sees. When nothing
 * clear is detected, the clarification phase asks the user.
 *
 * Usage:
 *   node detect-project-conventions.js <project-root>
 *
 * Also exports `detectProjectConventions({ projectRoot, fs })` for tests.
 *
 * Output shape (matches flow-graph.schema.json#/definitions/project_conventions):
 *   {
 *     component_type: "server" | "client" | "mixed",
 *     error_boundary: { kind: "...", import_path?: string | null },
 *     data_fetching:  { kind: "...", example_import?: string | null }
 *   }
 *
 * Heuristics:
 *   - component_type: sample all app/**\/page.{tsx,jsx,ts,js} files. Ratio of
 *     files whose first non-comment line is "use client" determines the
 *     label. ≥ 0.8 → client; ≤ 0.2 → server; else mixed. Zero page files
 *     → mixed (clarification phase will ask).
 *   - error_boundary.kind:
 *       next-file-convention — any app/**\/error.{tsx,jsx,ts,js} exists.
 *       react-error-boundary — package.json dep includes the package AND at
 *                              least one source file imports from it.
 *       custom-class         — at least one source file declares a class that
 *                              extends React.Component (or Component) and
 *                              defines componentDidCatch. Lower priority than
 *                              the Next file convention, so projects that use
 *                              both still get classified as next-file.
 *       none                 — neither detected.
 *   - data_fetching.kind:
 *       server-component-fetch — any app/**\/page.{tsx,jsx} is an async
 *                                component whose body calls `await fetch(` or
 *                                `await sql` / `await db.` at top level, with
 *                                no "use client" directive.
 *       react-query            — @tanstack/react-query in deps AND a source
 *                                file imports from it (useQuery/useMutation).
 *       swr                    — swr in deps AND a source file imports from it.
 *       custom-hook            — at least one source file defines or imports
 *                                a hook matching /^use[A-Z]\w*(Data|Query|Fetch|Resource)$/.
 *       none                   — none of the above.
 *
 * Priority order (for error_boundary and data_fetching) is top-to-bottom in
 * the lists above — the first match wins.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Files / directories the detector ignores.
const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".vercel",
  ".cache",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const MAX_FILES = 2000; // cap to keep the detector fast on large monorepos

function isIgnoredDir(name) {
  return IGNORE_DIRS.has(name) || name.startsWith(".");
}

function walkSources(root, out = []) {
  if (out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return out;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (isIgnoredDir(ent.name)) continue;
      walkSources(full, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name);
      if (SOURCE_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

// "use client" must be the first non-comment, non-blank statement.
function hasUseClientDirective(source) {
  if (!source) return false;
  const lines = source.split("\n");
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//")) continue;
    return /^(['"])use client\1\s*;?\s*$/.test(line);
  }
  return false;
}

function detectComponentType(projectRoot) {
  const appDirs = ["app", "src/app"]
    .map((d) => path.join(projectRoot, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch (_) {
        return false;
      }
    });

  const pagePattern = /(^|\/)page\.(tsx|jsx|ts|js)$/;
  const candidates = [];
  for (const dir of appDirs) {
    const files = walkSources(dir, []);
    for (const f of files) {
      if (pagePattern.test(f.replace(projectRoot, ""))) candidates.push(f);
    }
  }

  if (candidates.length === 0) {
    return { component_type: "mixed", _page_files_scanned: 0 };
  }

  let clientCount = 0;
  for (const f of candidates) {
    if (hasUseClientDirective(readFileSafe(f))) clientCount += 1;
  }
  const ratio = clientCount / candidates.length;
  let label;
  if (ratio >= 0.8) label = "client";
  else if (ratio <= 0.2) label = "server";
  else label = "mixed";
  return { component_type: label, _page_files_scanned: candidates.length };
}

function readPackageJson(projectRoot) {
  const p = path.join(projectRoot, "package.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function hasPackage(pkg, name) {
  if (!pkg) return false;
  return Boolean(
    (pkg.dependencies && pkg.dependencies[name]) ||
      (pkg.devDependencies && pkg.devDependencies[name]) ||
      (pkg.peerDependencies && pkg.peerDependencies[name])
  );
}

function findNextErrorFile(projectRoot) {
  const appDirs = ["app", "src/app"]
    .map((d) => path.join(projectRoot, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch (_) {
        return false;
      }
    });
  for (const dir of appDirs) {
    const files = walkSources(dir, []);
    for (const f of files) {
      if (/(^|\/)error\.(tsx|jsx|ts|js)$/.test(f.replace(projectRoot, ""))) {
        return f;
      }
    }
  }
  return null;
}

function findReactErrorBoundaryImport(sourceFiles) {
  const importRe =
    /from\s+['"](react-error-boundary)['"]|require\(\s*['"](react-error-boundary)['"]\s*\)/;
  for (const f of sourceFiles) {
    const src = readFileSafe(f);
    if (!src) continue;
    if (importRe.test(src)) return { file: f, import_path: "react-error-boundary" };
  }
  return null;
}

function findCustomErrorBoundary(sourceFiles) {
  // class Foo extends React.Component / extends Component, with
  // componentDidCatch anywhere in the same file.
  const classRe =
    /class\s+[A-Z]\w*\s+extends\s+(?:React\.)?Component\b[\s\S]{0,600}?componentDidCatch\s*\(/m;
  for (const f of sourceFiles) {
    const src = readFileSafe(f);
    if (!src) continue;
    if (classRe.test(src)) {
      const nameMatch = src.match(/class\s+([A-Z]\w*)\s+extends/);
      const name = nameMatch ? nameMatch[1] : "ErrorBoundary";
      return { file: f, class_name: name };
    }
  }
  return null;
}

function detectErrorBoundary(projectRoot, sourceFiles, pkg) {
  const nextFile = findNextErrorFile(projectRoot);
  if (nextFile) {
    return { kind: "next-file-convention", import_path: null };
  }
  if (hasPackage(pkg, "react-error-boundary")) {
    const hit = findReactErrorBoundaryImport(sourceFiles);
    if (hit) return { kind: "react-error-boundary", import_path: "react-error-boundary" };
  }
  const custom = findCustomErrorBoundary(sourceFiles);
  if (custom) {
    const rel = path
      .relative(projectRoot, custom.file)
      .replace(/\\/g, "/")
      .replace(/\.(tsx|jsx|ts|js|mts|cts)$/, "");
    return { kind: "custom-class", import_path: rel.startsWith(".") ? rel : `./${rel}` };
  }
  return { kind: "none", import_path: null };
}

function findAsyncServerComponentFetch(projectRoot) {
  const appDirs = ["app", "src/app"]
    .map((d) => path.join(projectRoot, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch (_) {
        return false;
      }
    });
  for (const dir of appDirs) {
    const files = walkSources(dir, []);
    for (const f of files) {
      if (!/(^|\/)page\.(tsx|jsx)$/.test(f.replace(projectRoot, ""))) continue;
      const src = readFileSafe(f);
      if (!src) continue;
      if (hasUseClientDirective(src)) continue;
      // Require `export default async function` or `export async function <Component>` or `async function Page(`
      if (!/\bexport\s+default\s+async\s+function\b/.test(src)) continue;
      if (/\bawait\s+(?:fetch\(|sql`|db\.|prisma\.|query\(|get\(|getServerSideProps)/.test(src)) {
        return { file: f };
      }
    }
  }
  return null;
}

function findReactQueryImport(sourceFiles) {
  const re =
    /from\s+['"]@tanstack\/react-query['"]|require\(\s*['"]@tanstack\/react-query['"]\s*\)/;
  for (const f of sourceFiles) {
    const src = readFileSafe(f);
    if (!src) continue;
    const match = src.match(/^[^\n]*@tanstack\/react-query[^\n]*$/m);
    if (match || re.test(src)) {
      // Extract the exact import line for example_import.
      const line = src
        .split("\n")
        .find((l) => l.includes("@tanstack/react-query"));
      return { file: f, example_import: (line || "").trim() };
    }
  }
  return null;
}

function findSwrImport(sourceFiles) {
  const re = /from\s+['"]swr['"]|require\(\s*['"]swr['"]\s*\)/;
  for (const f of sourceFiles) {
    const src = readFileSafe(f);
    if (!src) continue;
    if (!re.test(src)) continue;
    const line = src
      .split("\n")
      .find((l) => /from\s+['"]swr['"]|require\(\s*['"]swr['"]\s*\)/.test(l));
    return { file: f, example_import: (line || "").trim() };
  }
  return null;
}

function findCustomDataHook(sourceFiles) {
  const defRe = /\b(?:function|const)\s+(use[A-Z]\w*(?:Data|Query|Fetch|Resource))\b/;
  const importRe =
    /import\s+\{[^}]*\b(use[A-Z]\w*(?:Data|Query|Fetch|Resource))\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/;
  for (const f of sourceFiles) {
    const src = readFileSafe(f);
    if (!src) continue;
    const defMatch = src.match(defRe);
    if (defMatch) {
      const rel = path
        .relative(process.cwd(), f)
        .replace(/\\/g, "/")
        .replace(/\.(tsx|jsx|ts|js|mts|cts)$/, "");
      return {
        file: f,
        hook_name: defMatch[1],
        example_import: `import { ${defMatch[1]} } from '${rel.startsWith(".") ? rel : `./${rel}`}'`,
      };
    }
    const impMatch = src.match(importRe);
    if (impMatch) {
      return {
        file: f,
        hook_name: impMatch[1],
        example_import: `import { ${impMatch[1]} } from '${impMatch[2]}'`,
      };
    }
  }
  return null;
}

function detectDataFetching(projectRoot, sourceFiles, pkg) {
  // Priority: react-query → swr → server-component-fetch → custom-hook → none.
  if (hasPackage(pkg, "@tanstack/react-query")) {
    const hit = findReactQueryImport(sourceFiles);
    if (hit) {
      return { kind: "react-query", example_import: hit.example_import };
    }
  }
  if (hasPackage(pkg, "swr")) {
    const hit = findSwrImport(sourceFiles);
    if (hit) return { kind: "swr", example_import: hit.example_import };
  }
  const serverHit = findAsyncServerComponentFetch(projectRoot);
  if (serverHit) {
    return { kind: "server-component-fetch", example_import: null };
  }
  const customHit = findCustomDataHook(sourceFiles);
  if (customHit) {
    return { kind: "custom-hook", example_import: customHit.example_import };
  }
  return { kind: "none", example_import: null };
}

function detectProjectConventions({ projectRoot }) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot must be a string path");
  }
  const absRoot = path.resolve(projectRoot);

  const componentTypeResult = detectComponentType(absRoot);
  const pkg = readPackageJson(absRoot);
  const sourceFiles = walkSources(absRoot, []);

  const errorBoundary = detectErrorBoundary(absRoot, sourceFiles, pkg);
  const dataFetching = detectDataFetching(absRoot, sourceFiles, pkg);

  return {
    component_type: componentTypeResult.component_type,
    error_boundary: errorBoundary,
    data_fetching: dataFetching,
  };
}

// ---------- CLI ----------

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error("usage: detect-project-conventions.js <project-root>");
    process.exit(2);
  }
  const projectRoot = argv[0];
  try {
    const result = detectProjectConventions({ projectRoot });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  detectProjectConventions,
  hasUseClientDirective,
  hasPackage,
};
