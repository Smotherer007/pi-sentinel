/**
 * RunInputs — the files a verification verdict is bound to.
 *
 * A run's verdict is only true of the tree it read. When the run is slow
 * (`npm test` takes ten seconds here) and the tree moves while it runs, the
 * verdict describes a state that no longer exists. Acting on that is the
 * documented failure of a repair loop: the agent gets a failure for code it has
 * already fixed, spends one of its bounded attempts on it, and — because the
 * failure names a file in a shape that no longer matches — learns nothing from
 * it.
 *
 * Sentinel already guarded against this, but the guard bound the wrong set. It
 * hashed `focusPaths`: the files *this turn* touched. A whole-project step has
 * inputs far beyond that. `npm test` reads every test and every module, so an
 * edit to a file that an earlier turn changed — or to a file no turn touched —
 * invalidates the run while the hash stays identical. The guard then reported
 * the stale failure as current and spent an attempt on it.
 *
 * So the binding is the run's *input set*, not its change set:
 *
 *   1. the focus paths (what the turn changed),
 *   2. every project file the check can read, taken from the `include`/`exclude`
 *      patterns that already decide whether a file is worth verifying, and
 *   3. the manifests a check's meaning depends on (`package.json`, lockfiles,
 *      `tsconfig.json`, the sentinel config), whether or not they match
 *      `include`.
 *
 * The comparison is deliberately one-sided: a verdict whose inputs moved is
 * discarded, never a verdict whose inputs stayed. Discarding is the safe
 * direction — it costs a later re-run — while keeping a stale red costs a
 * repair attempt and the agent's trust in the signal.
 *
 * Cheap by construction: content hashes of source-sized files, a size-and-mtime
 * identity for anything oversized, and a hard cap on how many files are bound.
 * When the cap bites, `truncated` says so rather than pretending the binding is
 * complete.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isExcluded, matchesGlob } from "../config.ts";
import { hashFile } from "./snapshot.ts";

/** Most files bound to one verdict. Past this the binding says it is partial. */
export const RUN_INPUT_FILE_CAP = 4000;

/** Above this, a file is bound by size and mtime instead of by content. */
export const RUN_INPUT_MAX_BYTES = 1024 * 1024;

/** Bound even when they do not match `include`: they decide what a check means. */
export const MANIFEST_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
];

/**
 * What is bound when the project configures no `include` patterns.
 *
 * Deliberately not "every file". A check that writes inside the project — a log,
 * a coverage file, a marker — would then invalidate its own verdict on every
 * run, because its own output is one of its inputs. That is self-defeating: the
 * freshness rule would discard exactly the runs that did happen to write
 * something.
 *
 * Source and configuration files are what a verdict is about. Sentinel cannot
 * know which of them a given project's checks read, so this is the honest
 * superset of the usual answer and nothing more.
 */
export const DEFAULT_INPUT_PATTERNS: readonly string[] = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.mts",
  "**/*.cts",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.py",
  "**/*.pyi",
  "**/*.rb",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.kt",
  "**/*.kts",
  "**/*.cs",
  "**/*.c",
  "**/*.cc",
  "**/*.cpp",
  "**/*.h",
  "**/*.hpp",
  "**/*.swift",
  "**/*.php",
  "**/*.sh",
  "**/*.bash",
  "**/*.zsh",
  "**/*.sql",
  "**/*.vue",
  "**/*.svelte",
  "**/*.json",
  "**/*.toml",
  "**/*.yaml",
  "**/*.yml",
  "**/*.ini",
  "**/*.cfg",
  "**/*.gradle",
  "**/*.csproj",
  "**/Makefile",
  "**/Dockerfile",
  "**/go.mod",
  "**/Cargo.toml",
  "**/pyproject.toml",
  "**/requirements.txt",
];

/** Directories never walked: they are large, and never a project's own code. */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** The `include`/`exclude` patterns, as the config carries them. */
export interface InputPatterns {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** A run's bound inputs: what it read, as of when it started. */
export interface RunInputs {
  /** Absolute paths the verdict is bound to, sorted for a stable report. */
  readonly scope: readonly string[];
  /** Content identity per path — see {@link identityOf}. */
  readonly hashes: ReadonlyMap<string, string>;
  /** True when the file cap was hit, so the binding is knowingly partial. */
  readonly truncated: boolean;
}

/**
 * Identity of one file.
 *
 * Content for anything source-sized; size and mtime for the rare file above the
 * cap, because hashing a 500 MB artefact to notice it changed is worse than
 * noticing it a little later. A file that cannot be read is "missing" rather
 * than an error: a verdict is not invalidated by a file it never had.
 */
export function identityOf(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return "not-a-file";
    if (stat.size > RUN_INPUT_MAX_BYTES) return `size:${stat.size}:mtime:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
  return hashFile(absPath) ?? "missing";
}

/** Would this project file be verified, and therefore is it an input? */
function isInputFile(rel: string, includes: readonly string[], patterns: InputPatterns): boolean {
  if (patterns.exclude.some((pattern) => matchesGlob(pattern, rel))) return false;
  return includes.some((pattern) => matchesGlob(pattern, rel));
}

/**
 * Walk the project and return every file a check could read.
 *
 * Returns relative paths, sorted, plus whether the cap cut the walk short.
 */
export function projectFiles(
  cwd: string,
  patterns: InputPatterns,
  cap: number = RUN_INPUT_FILE_CAP,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  // No `include` means "verify everything not excluded" for *gating*, but binding
  // every file would let a check invalidate itself with its own output. Bind the
  // usual source set instead.
  const includes = patterns.include.length > 0 ? patterns.include : DEFAULT_INPUT_PATTERNS;

  const walk = (dir: string, relDir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(name)) continue;
        // A directory whose contents cannot match anything is not walked: this
        // is what keeps `include: ["src/**"]` from visiting the whole tree.
        if (!couldMatchAny(rel, includes)) continue;
        walk(path.join(dir, name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isInputFile(rel, includes, patterns)) continue;
      files.push(rel);
      if (files.length >= cap) {
        truncated = true;
        return;
      }
    }
  };

  walk(cwd, "");

  for (const manifest of MANIFEST_FILES) {
    if (files.includes(manifest)) continue;
    if (fs.existsSync(path.join(cwd, manifest))) files.push(manifest);
  }

  files.sort();
  return { files, truncated };
}

/**
 * True when a path could still match one of the patterns once more segments are
 * appended. Used only to prune directories, so an uncertain answer means "walk":
 * a pattern that can match anywhere is never pruned, and neither is one whose
 * first literal segment covers this directory.
 */
function couldMatchAny(relDir: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const prefix = `${relDir}/`;
  for (const pattern of patterns) {
    // `**/…`, `*.ts`: they can match below any directory.
    if (pattern.startsWith("*")) return true;
    const literal = pattern.split("*")[0];
    if (literal.startsWith(prefix)) return true;
    if (prefix.startsWith(literal)) return true;
  }
  return false;
}

/** Bind a run's inputs: focus paths, project files, manifests. */
export function fingerprintInputs(
  cwd: string,
  focusPaths: readonly string[],
  patterns: InputPatterns,
  cap: number = RUN_INPUT_FILE_CAP,
): RunInputs {
  const { files, truncated } = projectFiles(cwd, patterns, cap);
  const scope = new Set<string>();

  for (const rel of files) scope.add(path.resolve(cwd, rel));
  // The turn's own files always count, even when no pattern matches them: they
  // are what the verdict is about.
  for (const p of focusPaths) scope.add(path.resolve(cwd, p));

  const ordered = [...scope].sort();
  const hashes = new Map<string, string>();
  for (const abs of ordered) hashes.set(abs, identityOf(abs));

  return { scope: ordered, hashes, truncated };
}

/**
 * Which bound inputs moved since the run started.
 *
 * Reports the union of changed, added and removed paths, because a run that
 * never saw a file created while it ran is describing an older tree just as
 * much as one whose file was edited.
 */
export function movedInputs(inputs: RunInputs, cwd: string, patterns: InputPatterns): string[] {
  const { files } = projectFiles(cwd, patterns);
  const known = new Set(inputs.scope);
  const moved: string[] = [];

  for (const abs of inputs.scope) {
    if (identityOf(abs) !== inputs.hashes.get(abs)) moved.push(abs);
  }
  for (const rel of files) {
    const abs = path.resolve(cwd, rel);
    if (!known.has(abs)) moved.push(abs);
  }

  return moved;
}

/** A short, bounded rendering of moved inputs for a notice. */
export function describeMoved(moved: readonly string[], cwd: string, limit = 3): string {
  const names = moved.slice(0, limit).map((p) => path.relative(cwd, p) || p);
  const rest = moved.length - names.length;
  return rest > 0 ? `${names.join(", ")} (+${rest} more)` : names.join(", ");
}
