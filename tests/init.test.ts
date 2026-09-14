/**
 * Unit tests for `/sentinel init`: what it derives, and what it refuses.
 *
 * The point of the feature is that a project's checks should be a *decision*,
 * because the library's defaults describe one kind of project (npm + tsc +
 * eslint) and are simply wrong for the others — a plain Node 26 project with no
 * tsconfig, a Python service, a repo with no test runner. The tests below pin
 * both halves: the proposal only contains commands the project can actually run,
 * and the emitted file is a real config (imported, not just string-matched).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONFIG_FILES,
  detectProject,
  hasProjectConfig,
  proposeConfig,
  renderConfig,
  writeConfig,
} from "../src/clients/init.ts";

let root: string;

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(root, "p-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

const nodeProject = (pkg: Record<string, unknown>, extra: Record<string, string> = {}) =>
  project({ "package.json": JSON.stringify(pkg), ...extra });

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-init-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("init: only what the project actually has", () => {
  test("a plain Node project gets no steps and a note, not guesses", () => {
    // The case that motivated this: no tsconfig, no scripts, no tools. The
    // defaults would ask for `npx tsc --noEmit` and `npm test` and report a
    // failure every turn, for a project that has neither.
    const dir = nodeProject({ name: "node26", type: "module" });
    const proposal = proposeConfig(detectProject(dir));
    assert.deepEqual(proposal.onFileMutation, []);
    assert.deepEqual(proposal.onTurnEnd, []);
    assert.equal(proposal.notes.length, 1);
    assert.match(proposal.notes[0], /no check could be detected/);
  });

  test("declared scripts are used as-is", () => {
    const dir = nodeProject({
      scripts: { test: "node --test", typecheck: "tsc --noEmit", lint: "biome check" },
      devDependencies: { typescript: "^5", "@biomejs/biome": "^2" },
    });
    const proposal = proposeConfig(detectProject(dir));
    assert.deepEqual(
      proposal.onFileMutation.map((step) => step.cmd),
      ["npm run typecheck", "npm run lint"],
    );
    assert.deepEqual(
      proposal.onTurnEnd.map((step) => step.cmd),
      ["npm test"],
    );
    // A lint finding must never block a turn or trigger a rollback.
    assert.equal(proposal.onFileMutation[1].warnOnly, true);
    // The slow suite opts out of the reuse cache, as this repo's own config does.
    assert.equal(proposal.onTurnEnd[0].cacheable, false);
  });

  test("an installed runner is proposed when no script exists", () => {
    const dir = nodeProject({ devDependencies: { vitest: "^3" } });
    const proposal = proposeConfig(detectProject(dir));
    assert.deepEqual(
      proposal.onTurnEnd.map((step) => step.cmd),
      ["npx --no-install vitest run"],
    );
  });

  test("tsconfig without typescript is a note, not a failing step", () => {
    const dir = nodeProject({ name: "x" }, { "tsconfig.json": "{}" });
    const proposal = proposeConfig(detectProject(dir));
    assert.deepEqual(proposal.onFileMutation, []);
    assert.match(proposal.notes.join(" "), /typescript is not installed/);
  });

  test("a Python project is proposed in Python", () => {
    const dir = project({
      "pyproject.toml": '[project]\ndependencies = ["pytest", "ruff"]\n',
    });
    const proposal = proposeConfig(detectProject(dir));
    assert.deepEqual(
      proposal.onTurnEnd.map((step) => step.cmd),
      ["python3 -m pytest -q"],
    );
    assert.deepEqual(
      proposal.onFileMutation.map((step) => step.cmd),
      ["ruff check ."],
    );
    assert.deepEqual(proposal.include, ["**/*.py"]);
  });

  test("include patterns follow the languages found", () => {
    const ts = nodeProject({ name: "x" }, { "tsconfig.json": "{}" });
    assert.deepEqual(proposeConfig(detectProject(ts)).include, [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
    ]);
    const py = project({ "pyproject.toml": "[project]\n" });
    assert.deepEqual(proposeConfig(detectProject(py)).include, ["**/*.py"]);
  });
});

describe("init: the file it writes is a real config", () => {
  test("it parses and loads, with the proposed pipelines", async () => {
    const dir = nodeProject({
      scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5" },
    });
    const profile = detectProject(dir);
    // `importFrom` points at the local source for the test, so the emitted file
    // can be *imported* rather than pattern-matched: a config that does not parse
    // is worse than no config, and only an import proves it does. A user project
    // gets the package specifier, which is asserted separately below.
    const localConfig = new URL("../src/config.ts", import.meta.url).href;
    const text = renderConfig(proposeConfig(profile), profile, localConfig);
    fs.writeFileSync(path.join(dir, "sentinel.config.ts"), text);

    const loaded = await import(pathToFileURL(path.join(dir, "sentinel.config.ts")).href);
    const config = loaded.default;
    assert.equal(config.pipelines.onFileMutation[0].cmd, "npm run typecheck");
    assert.equal(config.pipelines.onTurnEnd[0].cmd, "npm test");
    assert.deepEqual(config.include, ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]);
  });

  test("a user project imports the package, not a local path", () => {
    const dir = nodeProject({ scripts: { test: "node --test" } });
    const profile = detectProject(dir);
    assert.match(renderConfig(proposeConfig(profile), profile), /import \{ defineConfig \} from "@patimweb\/pi-sentinel";/);
  });

  test("it says why every line is there", () => {
    const dir = nodeProject({ scripts: { test: "node --test" } });
    const profile = detectProject(dir);
    const text = renderConfig(proposeConfig(profile), profile);
    assert.match(text, /created by `\/sentinel init`/);
    assert.match(text, /package\.json defines a `test` script/);
    assert.match(text, /Detected: package\.json/);
  });
});

describe("init: never overwrite a decision", () => {
  test("an existing config is reported, not replaced", () => {
    const dir = nodeProject({ name: "x" });
    const target = path.join(dir, CONFIG_FILES[0]);
    fs.writeFileSync(target, "// mine\n");
    assert.equal(hasProjectConfig(dir), true);

    const result = writeConfig(dir, "// generated\n");
    assert.equal(result.written, false);
    assert.match(result.reason ?? "", /already exists/);
    assert.equal(fs.readFileSync(target, "utf-8"), "// mine\n");
  });

  test("a project without one gets it", () => {
    const dir = nodeProject({ name: "x" });
    const result = writeConfig(dir, "// generated\n");
    assert.equal(result.written, true);
    assert.equal(path.basename(result.path), CONFIG_FILES[0]);
    assert.equal(fs.readFileSync(result.path, "utf-8"), "// generated\n");
  });
});
