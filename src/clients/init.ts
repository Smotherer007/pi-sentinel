/**
 * ProjectInit — what sentinel would check *here*, and the config that says so.
 *
 * Sentinel ships with defaults that only make sense for one kind of project:
 * `npx tsc --noEmit`, `npx eslint --quiet`, `npm test`. A plain Node 26 project
 * has no tsconfig and no test script; a Python service has neither; a repo with
 * no tests has no test runner at all. Running on those defaults is not a
 * neutral choice — it is a guess, and the guess shows up as a step that cannot
 * run, every turn, in every project that is not the one the defaults were
 * written for.
 *
 * So the config stops being optional. `/sentinel init` writes one, derived from
 * what is actually in the project, and the doctor says when a project is running
 * on the guesses instead. Two rules keep that honest:
 *
 *   1. **Only propose what exists.** A script that is in `package.json`, a tool
 *      that resolves on `PATH`, a runner this project actually depends on. A
 *      proposal that cannot run is worse than no proposal: it teaches the reader
 *      to ignore the check.
 *   2. **Never write silently.** The file is created by an explicit command, it
 *      comments every line it chose, and it is never overwritten. Nothing here
 *      changes what sentinel *does* until the developer has seen it.
 *
 * Pure where it counts: `proposeConfig` and `renderConfig` take facts and return
 * values, so the interesting half is testable without a project on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What the project looks like, as far as a config proposal cares. */
export interface ProjectProfile {
  readonly cwd: string;
  /** Script names that exist in `package.json`, if there is one. */
  readonly scripts: readonly string[];
  /** Tools this project depends on or has installed locally. */
  readonly tools: {
    readonly typescript: boolean;
    readonly eslint: boolean;
    readonly biome: boolean;
    readonly prettier: boolean;
    readonly vitest: boolean;
    readonly jest: boolean;
    readonly mocha: boolean;
    readonly ruff: boolean;
    readonly pytest: boolean;
    readonly mypy: boolean;
  };
  /** Marker files found at the project root or one level down. */
  readonly markers: {
    readonly tsconfig: boolean;
    readonly packageJson: boolean;
    readonly pyproject: boolean;
    readonly requirements: boolean;
    readonly goMod: boolean;
    readonly cargo: boolean;
    readonly gemfile: boolean;
    readonly pom: boolean;
  };
  /** Programs reachable through `PATH`. */
  readonly onPath: { readonly [program: string]: boolean };
}

/** One step the proposal would write, with the reason it was chosen. */
export interface ProposedStep {
  readonly name: string;
  readonly cmd: string;
  readonly timeoutMs: number;
  readonly files?: readonly string[];
  readonly warnOnly?: boolean;
  /** Slow suites opt out of the reuse cache; a stale pass proves less than it claims. */
  readonly cacheable?: boolean;
  /** Rendered as a comment above the step, so the reader can judge it. */
  readonly why: string;
}

/** What `/sentinel init` would put in a config file. */
export interface ConfigProposal {
  readonly onFileMutation: readonly ProposedStep[];
  readonly onTurnEnd: readonly ProposedStep[];
  readonly include: readonly string[];
  /** Things the proposal could *not* decide, said out loud in the file. */
  readonly notes: readonly string[];
}

/** The files a config is looked for in, in load order. */
export const CONFIG_FILES: readonly string[] = ["sentinel.config.ts", "sentinel.config.js"];

/** Is this project already configured (locally)? */
export function hasProjectConfig(cwd: string): boolean {
  return CONFIG_FILES.some((file) => fs.existsSync(path.join(cwd, file)));
}

/** Is there a global default config? */
export function hasGlobalConfig(home: string): boolean {
  return fs.existsSync(path.join(home, ".sentinel.config.ts"));
}

/**
 * Is this program resolvable through `PATH`?
 *
 * Exported because the doctor asks the same question about configured steps and
 * the two answers must not drift.
 */
export function onPath(program: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, program + ext))) return true;
      } catch {
        /* an unreadable PATH entry proves nothing about the next one */
      }
    }
  }
  return false;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function existsAny(cwd: string, names: readonly string[]): boolean {
  return names.some((name) => fs.existsSync(path.join(cwd, name)));
}

/**
 * Read the project, without guessing beyond what is on disk.
 *
 * A package manager is only inferred from a lockfile or the `packageManager`
 * field — never from "there is a package.json, so it is npm", because the
 * command that gets proposed depends on it.
 */
export function detectProject(cwd: string): ProjectProfile {
  const pkg = readJson(path.join(cwd, "package.json"));
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null
    ? Object.keys(pkg.scripts as Record<string, unknown>)
    : [];

  const deps: Record<string, unknown> = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
  };
  const hasDep = (...names: string[]): boolean => names.some((name) => name in deps);
  const localBin = (...names: string[]): boolean =>
    names.some((name) => fs.existsSync(path.join(cwd, "node_modules", ".bin", name)));

  // Python tooling is declared in pyproject/requirements, or installed.
  let pyText = "";
  for (const file of ["pyproject.toml", "requirements.txt", "requirements-dev.txt"]) {
    try {
      pyText += fs.readFileSync(path.join(cwd, file), "utf-8").toLowerCase();
    } catch {
      /* absent is fine */
    }
  }
  const declaresPy = (...names: string[]): boolean => names.some((name) => pyText.includes(name));

  return {
    cwd,
    scripts,
    tools: {
      typescript: hasDep("typescript") || localBin("tsc"),
      eslint: hasDep("eslint") || localBin("eslint"),
      biome: hasDep("@biomejs/biome") || localBin("biome"),
      prettier: hasDep("prettier") || localBin("prettier"),
      vitest: hasDep("vitest") || localBin("vitest"),
      jest: hasDep("jest") || localBin("jest"),
      mocha: hasDep("mocha") || localBin("mocha"),
      ruff: declaresPy("ruff") || onPath("ruff"),
      pytest: declaresPy("pytest") || onPath("pytest"),
      mypy: declaresPy("mypy") || onPath("mypy"),
    },
    markers: {
      tsconfig: existsAny(cwd, ["tsconfig.json", "tsconfig.build.json"]),
      packageJson: fs.existsSync(path.join(cwd, "package.json")),
      pyproject: fs.existsSync(path.join(cwd, "pyproject.toml")),
      requirements: existsAny(cwd, ["requirements.txt", "requirements-dev.txt"]),
      goMod: fs.existsSync(path.join(cwd, "go.mod")),
      cargo: fs.existsSync(path.join(cwd, "Cargo.toml")),
      gemfile: fs.existsSync(path.join(cwd, "Gemfile")),
      pom: fs.existsSync(path.join(cwd, "pom.xml")),
    },
    onPath: {
      python: onPath("python3") || onPath("python"),
      go: onPath("go"),
      cargo: onPath("cargo"),
      tsc: onPath("tsc"),
    },
  };
}

/** Build the config a project would want, from what it actually has. */
export function proposeConfig(profile: ProjectProfile): ConfigProposal {
  const mutation: ProposedStep[] = [];
  const turnEnd: ProposedStep[] = [];
  const notes: string[] = [];
  const { scripts, tools, markers } = profile;

  // ── TypeScript / JavaScript ────────────────────────────────────────────
  if (scripts.includes("typecheck")) {
    mutation.push({
      name: "type-check",
      cmd: "npm run typecheck",
      timeoutMs: 60_000,
      files: ["**/*.ts", "**/*.tsx"],
      why: "package.json defines a `typecheck` script",
    });
  } else if (markers.tsconfig && tools.typescript) {
    mutation.push({
      name: "type-check",
      cmd: "npx --no-install tsc --noEmit",
      timeoutMs: 60_000,
      files: ["**/*.ts", "**/*.tsx"],
      why: "tsconfig.json and a local typescript install",
    });
  } else if (markers.tsconfig && !tools.typescript) {
    notes.push(
      "tsconfig.json exists but typescript is not installed here — add `npm i -D typescript` and then enable a type-check step",
    );
  }

  if (scripts.includes("lint")) {
    mutation.push({
      name: "lint",
      cmd: "npm run lint",
      timeoutMs: 30_000,
      warnOnly: true,
      why: "package.json defines a `lint` script",
    });
  } else if (tools.biome) {
    mutation.push({
      name: "lint",
      cmd: "npx --no-install biome check",
      timeoutMs: 30_000,
      warnOnly: true,
      why: "@biomejs/biome is installed",
    });
  } else if (tools.eslint) {
    mutation.push({
      name: "lint",
      cmd: "npx --no-install eslint --quiet",
      timeoutMs: 30_000,
      warnOnly: true,
      why: "eslint is installed (warning-only: lint must not block a turn)",
    });
  }

  if (scripts.includes("test")) {
    turnEnd.push({
      name: "unit-tests",
      cmd: "npm test",
      timeoutMs: 120_000,
      cacheable: false,
      why: "package.json defines a `test` script",
    });
  } else if (tools.vitest) {
    turnEnd.push({
      name: "unit-tests",
      cmd: "npx --no-install vitest run",
      timeoutMs: 120_000,
      why: "vitest is installed but no `test` script exists",
    });
  } else if (tools.jest) {
    turnEnd.push({
      name: "unit-tests",
      cmd: "npx --no-install jest --ci",
      timeoutMs: 120_000,
      why: "jest is installed but no `test` script exists",
    });
  }

  // ── Python ─────────────────────────────────────────────────────────────
  if (markers.pyproject || markers.requirements) {
    if (tools.pytest) {
      turnEnd.push({
        name: "unit-tests",
        cmd: "python3 -m pytest -q",
        timeoutMs: 120_000,
        files: ["**/*.py"],
        why: "pytest is declared or installed",
      });
    }
    if (tools.ruff) {
      mutation.push({
        name: "lint",
        cmd: "ruff check .",
        timeoutMs: 30_000,
        files: ["**/*.py"],
        warnOnly: true,
        why: "ruff is declared or installed",
      });
    }
    if (tools.mypy) {
      mutation.push({
        name: "type-check",
        cmd: "mypy .",
        timeoutMs: 60_000,
        files: ["**/*.py"],
        why: "mypy is declared or installed",
      });
    }
  }

  // ── Go / Rust: one toolchain command each, nothing to infer ────────────
  if (markers.goMod && profile.onPath.go) {
    mutation.push({ name: "build", cmd: "go build ./...", timeoutMs: 60_000, files: ["**/*.go"], why: "go.mod and a go toolchain" });
    turnEnd.push({ name: "unit-tests", cmd: "go test ./...", timeoutMs: 120_000, files: ["**/*.go"], why: "go.mod and a go toolchain" });
  }
  if (markers.cargo && profile.onPath.cargo) {
    mutation.push({ name: "build", cmd: "cargo check", timeoutMs: 120_000, files: ["**/*.rs"], why: "Cargo.toml and a cargo toolchain" });
    turnEnd.push({ name: "unit-tests", cmd: "cargo test", timeoutMs: 180_000, files: ["**/*.rs"], why: "Cargo.toml and a cargo toolchain" });
  }

  if (mutation.length === 0 && turnEnd.length === 0) {
    notes.push(
      "no check could be detected in this project — add the commands you actually run to the pipelines above; empty pipelines verify nothing",
    );
  }

  // Include patterns follow the languages that were detected, so unrelated
  // files never trigger a check that cannot judge them.
  const include: string[] = [];
  const jsOrTs = markers.packageJson || markers.tsconfig;
  if (jsOrTs) include.push("**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx");
  if (markers.pyproject || markers.requirements) include.push("**/*.py");
  if (markers.goMod) include.push("**/*.go");
  if (markers.cargo) include.push("**/*.rs");

  return { onFileMutation: mutation, onTurnEnd: turnEnd, include, notes };
}

/** Render the proposal as the source of `sentinel.config.ts`. */
export function renderConfig(
  proposal: ConfigProposal,
  profile: ProjectProfile,
  /**
   * The module the generated file imports `defineConfig` from.
   *
   * `"@patimweb/pi-sentinel"` for a user project; tests point it at the local
   * source so the emitted file can actually be imported and checked, because a
   * config that does not parse is worse than no config at all.
   */
  importFrom = "@patimweb/pi-sentinel",
): string {
  const steps = (list: readonly ProposedStep[], indent: string): string[] =>
    list.map((step) => {
      const fields = [
        `name: ${JSON.stringify(step.name)}`,
        `cmd: ${JSON.stringify(step.cmd)}`,
        `timeoutMs: ${step.timeoutMs}`,
        step.files ? `files: ${JSON.stringify(step.files)}` : null,
        step.warnOnly ? `warnOnly: true` : null,
        step.cacheable === false ? `cacheable: false` : null,
      ].filter((field): field is string => field !== null);
      return [`${indent}// ${step.why}`, `${indent}{ ${fields.join(", ")} },`].join("\n");
    });

  /** `[]` on one line when there is nothing, so an empty pipeline is obvious. */
  const block = (list: readonly ProposedStep[], indent: string): string[] =>
    list.length === 0 ? [`${indent}[]`] : steps(list, indent);

  const detection = [
    profile.markers.packageJson ? "package.json" : null,
    profile.markers.tsconfig ? "tsconfig.json" : null,
    profile.markers.pyproject ? "pyproject.toml" : null,
    profile.markers.requirements ? "requirements.txt" : null,
    profile.markers.goMod ? "go.mod" : null,
    profile.markers.cargo ? "Cargo.toml" : null,
  ].filter((name): name is string => name !== null);

  const lines: string[] = [
    "// sentinel.config.ts — created by `/sentinel init`.",
    "//",
    "// Everything in here was derived from this project, and every step carries the",
    "// reason it was chosen. It is a starting point, not a verdict: change the",
    "// commands, the timeouts and the includes to match how you actually work, then",
    "// commit the file so the next person inherits the decision.",
    "//",
    `// Detected: ${detection.length > 0 ? detection.join(", ") : "no project markers"}.`,
    "//",
    "// Nothing is verified until a step can actually run, and a step that cannot run",
    "// is reported as an environment problem — never as a failure of your code.",
    "",
    'import { defineConfig } from "' + importFrom + '";',
    "",
    "export default defineConfig({",
    "  // Fast checks, run after every edit/write.",
    "  pipelines: {",
    "    onFileMutation: [",
    ...block(proposal.onFileMutation, "      "),
    "    ],",
    "    // Slow checks, run once per turn (in the background by default).",
    "    onTurnEnd: [",
    ...block(proposal.onTurnEnd, "      "),
    "    ],",
    "  },",
  ];

  if (proposal.include.length > 0) {
    lines.push(
      "",
      "  // Files the checks can judge. Everything else is ignored, so the pipelines",
      "  // above are never pointed at files they cannot read.",
      `  include: [${proposal.include.map((pattern) => JSON.stringify(pattern)).join(", ")}],`,
    );
  }

  for (const note of proposal.notes) {
    lines.push("", `  // TODO: ${note}`);
  }

  lines.push("});", "");
  return lines.join("\n");
}

/**
 * Write the config, refusing to clobber one that exists.
 *
 * `/sentinel init` is a deliberate act by a person; overwriting the file they
 * have been editing would be the opposite of that, so an existing config is
 * reported rather than replaced.
 */
export function writeConfig(
  cwd: string,
  text: string,
): { written: boolean; path: string; reason?: string } {
  const target = path.join(cwd, CONFIG_FILES[0]);
  const existing = CONFIG_FILES.find((file) => fs.existsSync(path.join(cwd, file)));
  if (existing) {
    return {
      written: false,
      path: path.join(cwd, existing),
      reason: `${existing} already exists — edit it instead (sentinel never overwrites a config)`,
    };
  }
  try {
    fs.writeFileSync(target, text, { encoding: "utf-8", mode: 0o644 });
    return { written: true, path: target };
  } catch (err) {
    return { written: false, path: target, reason: (err as Error).message };
  }
}
