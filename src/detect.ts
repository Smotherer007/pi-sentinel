/**
 * Detect the checks a project already has.
 *
 * A harness that needs a config file before it does anything is a harness
 * nobody turns on. Sentinel reads the project the way a new team member would
 * — package scripts first, then the toolchain markers — and proposes the
 * commands the project itself uses. Only what is actually present is proposed:
 * a guessed `npm test` in a project without a test script is a red run that
 * says nothing about the code.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Step } from "./types.ts";

export interface DetectedChecks {
  afterEdit: Step[];
  beforeDone: Step[];
  /** Why each command was chosen, for `/sentinel checks`. */
  reasons: string[];
}

const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const JS_FILES = [...TS_FILES, "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function exists(cwd: string, name: string): boolean {
  return fs.existsSync(path.join(cwd, name));
}

function runnerFor(cwd: string): string {
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "yarn.lock")) return "yarn";
  if (exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")) return "bun run";
  return "npm run";
}

function pythonHas(cwd: string, tool: string): boolean {
  for (const file of ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.cfg"]) {
    try {
      if (fs.readFileSync(path.join(cwd, file), "utf-8").toLowerCase().includes(tool)) return true;
    } catch {
      /* absent */
    }
  }
  return false;
}

export function detectChecks(cwd: string): DetectedChecks {
  const afterEdit: Step[] = [];
  const beforeDone: Step[] = [];
  const reasons: string[] = [];

  const pkg = readJson(path.join(cwd, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown>;
    const run = runnerFor(cwd);
    const script = (...names: string[]) => names.find((name) => typeof scripts[name] === "string");

    const typecheck = script("typecheck", "type-check", "check-types", "tsc");
    if (typecheck) {
      const step = { name: "typecheck", cmd: `${run} ${typecheck}`, timeoutMs: 120_000, files: TS_FILES };
      afterEdit.push(step);
      beforeDone.push(step);
      reasons.push(`typecheck: package.json script "${typecheck}"`);
    } else if (exists(cwd, "tsconfig.json") && ("typescript" in deps || exists(cwd, "node_modules/.bin/tsc"))) {
      const step = { name: "typecheck", cmd: "npx --no-install tsc --noEmit", timeoutMs: 120_000, files: TS_FILES };
      afterEdit.push(step);
      beforeDone.push(step);
      reasons.push("typecheck: tsconfig.json + local typescript");
    }

    const lint = script("lint");
    if (lint) {
      beforeDone.push({ name: "lint", cmd: `${run} lint`, timeoutMs: 120_000, files: JS_FILES, warnOnly: true });
      reasons.push('lint: package.json script "lint" (warning only)');
    }

    const test = script("test");
    const placeholder = typeof scripts.test === "string" && /no test specified/.test(scripts.test);
    if (test && !placeholder) {
      beforeDone.push({ name: "test", cmd: run === "npm run" ? "npm test" : `${run} test`, timeoutMs: 300_000 });
      reasons.push('test: package.json script "test"');
    }
  }

  if (exists(cwd, "Cargo.toml")) {
    afterEdit.push({ name: "cargo-check", cmd: "cargo check --quiet", timeoutMs: 180_000, files: ["**/*.rs"] });
    beforeDone.push({ name: "cargo-test", cmd: "cargo test --quiet", timeoutMs: 600_000 });
    reasons.push("rust: Cargo.toml");
  }

  if (exists(cwd, "go.mod")) {
    afterEdit.push({ name: "go-vet", cmd: "go vet ./...", timeoutMs: 120_000, files: ["**/*.go"] });
    beforeDone.push({ name: "go-test", cmd: "go test ./...", timeoutMs: 600_000 });
    reasons.push("go: go.mod");
  }

  if (exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt")) {
    if (pythonHas(cwd, "mypy")) {
      afterEdit.push({ name: "mypy", cmd: "mypy .", timeoutMs: 120_000, files: ["**/*.py"] });
      beforeDone.push({ name: "mypy", cmd: "mypy .", timeoutMs: 120_000, files: ["**/*.py"] });
      reasons.push("python: mypy declared");
    }
    if (pythonHas(cwd, "ruff")) {
      beforeDone.push({ name: "ruff", cmd: "ruff check .", timeoutMs: 60_000, files: ["**/*.py"], warnOnly: true });
      reasons.push("python: ruff declared (warning only)");
    }
    if (pythonHas(cwd, "pytest")) {
      beforeDone.push({ name: "pytest", cmd: "python3 -m pytest -q", timeoutMs: 600_000 });
      reasons.push("python: pytest declared");
    }
  }

  return { afterEdit, beforeDone, reasons };
}
