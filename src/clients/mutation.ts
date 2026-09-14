/**
 * MutationSeam — which tool calls write to the working tree.
 *
 * Every sentinel guarantee starts from the same answer: *did this call write a
 * file?* The pre-state snapshot, the repair scope, the rollback, the evidence
 * ledger and the checkpoint all hang off it. That answer used to be a
 * comparison against two string literals — `"edit"` and `"write"`.
 *
 * That is a bet on the host's tool names, and it is the wrong bet. A project
 * that registers `replace`, `insert`, `multi_edit`, `apply_patch` or a hashline
 * editor produces a call that writes a file and gets no pre-state at all: the
 * change is invisible to the snapshot store, so a failed turn can only be
 * repaired by asking the model to undo what it did. Two published extensions
 * reached the same conclusion: pi-lens rebuilt its own mutation seam for it
 * (`mutating-tool.ts`, whose module comment describes this exact failure mode
 * across fifteen call sites) and pi-task-tracker enumerates the same foreign
 * names (`replace`, `insert`, `undo_last_change`) for the same reason.
 *
 * The seam answers in three tiers, cheapest first:
 *
 *   1. **By name.** pi's own `write` and `edit`, plus the names foreign edit
 *      tools are actually published under. Free, and identical to the old
 *      behaviour for the host's tools.
 *   2. **By learned name.** A tool the observation tier has already caught
 *      writing once. Persisted per project, so a later session classifies it
 *      from disk instead of paying for the observation again.
 *   3. **By shape.** An unrecognized tool that names a path *and* carries a
 *      content-shaped field (`content`, `newText`, `patch`, `edits`, …) is a
 *      mutation beyond reasonable doubt. A call that names a path without such
 *      a field is `unknown`: not a mutation, but worth watching — the caller
 *      arms a bounded pre-state capture for it and decides from the result.
 *
 * Pure by construction: no I/O, no clock, no module state. What stays out of
 * here is everything done about the answer — snapshotting, verifying, learning
 * — which is the caller's.
 */

/** How a call was recognized, and therefore how much it is trusted. */
export type MutationKind =
  /** Known to write: the host's tools, or a foreign name in the table. */
  | "write"
  /** Known to edit an existing file (or an equivalent foreign tool). */
  | "edit"
  /** Names a path but nothing else: watch it, do not assume it writes. */
  | "unknown";

/** The seam's answer for one tool call. */
export interface MutationHint {
  readonly kind: MutationKind;
  /** Paths the call names, in the order the input declares them. */
  readonly paths: readonly string[];
  /** Why the call came out this way — carried into notices and status. */
  readonly evidence: string;
}

/** The host's own tools. Behaviour here must not change. */
const HOST_WRITE_TOOLS: readonly string[] = ["write"];
const HOST_EDIT_TOOLS: readonly string[] = ["edit"];

/**
 * Foreign tools that are unambiguously file writers.
 *
 * Only names that mean "write this file" — `create` is deliberately absent,
 * because extensions use it for non-file resources (tasks, entries, agents).
 */
const FOREIGN_WRITE_TOOLS: readonly string[] = ["write_file", "create_file", "new_file"];

/**
 * Foreign tools that are unambiguously file editors. This is the list the two
 * extensions above converged on independently (`replace`/`insert` from
 * pi-hashline-edit-pro, `multi_edit`/`apply_patch` from the Codex-style patch
 * tools, `str_replace*` from the Anthropic-style editors).
 */
const FOREIGN_EDIT_TOOLS: readonly string[] = [
  "edit_file",
  "multi_edit",
  "apply_patch",
  "replace",
  "insert",
  "str_replace",
  "str_replace_editor",
  "undo_last_change",
];

/**
 * Name *words* that mean "read", so the shape tier does not arm an observation
 * for every grep.
 *
 * Matched per token, never as substrings of the whole name: "cat" is a reader,
 * but `truncate`, `duplicate`, `educate` and `frobnicate` are not, and a name
 * fragment heuristic would have armed a capture for all of them. Checked
 * *after* the known and learned names, because what a tool was seen doing
 * outranks what it is called.
 */
const READ_ONLY_WORDS: ReadonlySet<string> = new Set([
  "read",
  "get",
  "list",
  "ls",
  "find",
  "search",
  "grep",
  "glob",
  "cat",
  "head",
  "tail",
  "stat",
  "web",
  "fetch",
  "query",
  "explain",
  "status",
  "show",
  "view",
  "tree",
  "symbol",
  "outline",
  "diff",
  "lens",
  "diagnostic",
  "diagnostics",
  "map",
  "info",
  "doc",
  "docs",
  "schema",
  "inspect",
]);

/** Shell tools belong to the shell guard (`clients/bash-guard.ts`), not here. */
const SHELL_TOOLS: readonly string[] = ["bash", "sh", "shell", "zsh", "powershell", "cmd", "terminal"];

/** Input keys that name one file, in the order the host's tools use them. */
const PATH_KEYS: readonly string[] = [
  "path",
  "filePath",
  "file_path",
  "file",
  "filename",
  "fileName",
  "target",
  "targetFile",
  "target_file",
];

/** Input keys that name several files. */
const PATH_LIST_KEYS: readonly string[] = ["paths", "files", "filePaths", "file_paths"];

/**
 * Input keys whose presence means "this call supplies file content".
 *
 * Deliberately broad: the cost of being wrong is one pre-state capture of one
 * path, and the cost of being narrow is a mutation nobody can undo.
 */
const CONTENT_KEYS: readonly string[] = [
  "content",
  "newContent",
  "new_content",
  "newText",
  "new_text",
  "oldText",
  "old_text",
  "oldString",
  "old_string",
  "newString",
  "new_string",
  "replacement",
  "replace",
  "insert",
  "insertAfter",
  "insert_after",
  "patch",
  "diff",
  "edits",
  "changes",
  "lines",
  "snippet",
  "text",
];

/** Bounded: a tool that names fifty paths is not classified silently. */
export const MAX_HINT_PATHS = 8;

/** Bounded: the learned table is a session-lifetime aid, not a registry. */
export const MAX_LEARNED_TOOLS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plausible path: a string that names one file, not a paragraph or a URL. */
function isPathLike(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (trimmed.includes("\n") || trimmed.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  return true;
}

/** Every path a call names, from both the single and the plural keys. */
export function namedPaths(input: unknown): string[] {
  if (typeof input === "string") return isPathLike(input) ? [input.trim()] : [];
  if (!isRecord(input)) return [];

  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (isPathLike(value)) found.push(value.trim());
  }
  for (const key of PATH_LIST_KEYS) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isPathLike(entry)) found.push(entry.trim());
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of found) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
    if (unique.length >= MAX_HINT_PATHS) break;
  }
  return unique;
}

/** The first content-shaped key the input carries, for the evidence string. */
export function contentField(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of CONTENT_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return key;
  }
  return undefined;
}

function namesOneOf(toolName: string, names: readonly string[]): boolean {
  return names.includes(toolName);
}

/**
 * Split a tool name into lowercase words.
 *
 * `read_file`, `readFile` and `read-file` all have to yield "read", because the
 * population of tool names is open and the separators are not.
 */
export function nameWords(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/**
 * True when the tool name reads as a reader rather than a writer.
 *
 * Deliberately token-based: see {@link READ_ONLY_WORDS}.
 */
function looksReadOnly(toolName: string): boolean {
  return nameWords(toolName).some((word) => READ_ONLY_WORDS.has(word));
}

/** Whether a tool the seam has already caught writing is in the learned set. */
export function isLearnedMutationTool(learned: readonly string[], toolName: string): boolean {
  return learned.includes(toolName);
}

/**
 * Add a tool to the learned set. Newest last, deduplicated, capped: the cap
 * drops the oldest entry, which is the one least likely to be used again in a
 * session that keeps meeting new tools.
 */
export function learnMutationTool(learned: readonly string[], toolName: string): string[] {
  if (toolName.length === 0 || isLearnedMutationTool(learned, toolName)) return [...learned];
  const next = [...learned, toolName];
  return next.length > MAX_LEARNED_TOOLS ? next.slice(next.length - MAX_LEARNED_TOOLS) : next;
}

/**
 * Classify one tool call.
 *
 * `learned` is the persisted set of tools previously observed writing; pass an
 * empty array when there is no state yet. Returns `null` for a call that cannot
 * write and is not worth watching — the common case, and the one that must stay
 * free.
 */
export function classifyMutation(
  toolName: string,
  input: unknown,
  learned: readonly string[] = [],
): MutationHint | null {
  if (toolName.length === 0) return null;
  const lower = toolName.toLowerCase();

  if (namesOneOf(lower, SHELL_TOOLS)) return null;

  if (namesOneOf(toolName, HOST_WRITE_TOOLS) || namesOneOf(lower, FOREIGN_WRITE_TOOLS)) {
    return { kind: "write", paths: namedPaths(input), evidence: `name:${toolName}` };
  }
  if (namesOneOf(toolName, HOST_EDIT_TOOLS) || namesOneOf(lower, FOREIGN_EDIT_TOOLS)) {
    return { kind: "edit", paths: namedPaths(input), evidence: `name:${toolName}` };
  }

  const paths = namedPaths(input);
  if (isLearnedMutationTool(learned, toolName)) {
    return { kind: "edit", paths, evidence: `learned:${toolName}` };
  }

  if (looksReadOnly(toolName)) return null;

  const field = contentField(input);
  if (paths.length > 0 && field !== undefined) {
    return { kind: "edit", paths, evidence: `shape:${field}` };
  }
  if (paths.length > 0) {
    return { kind: "unknown", paths, evidence: `shape:path-only` };
  }
  return null;
}
