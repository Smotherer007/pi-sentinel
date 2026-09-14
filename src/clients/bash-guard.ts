/**
 * BashGuard — what a shell command is about to do to the working tree.
 *
 * Sentinel's promise is that the agent's work, and the user's, survives a bad
 * turn. Every mechanism that delivers it — snapshots, checkpoints, the
 * verified-state ledger — is keyed to the `edit` and `write` tools. `bash` goes
 * straight past all of it: an `rm -rf src`, a `git reset --hard`, a `sed -i`
 * across the repo are invisible to the snapshot store, so there is nothing to
 * roll back afterwards. That is the largest remaining hole in the guarantee,
 * and it is the one the user notices.
 *
 * This module answers one question, purely: *what classes of risk does this
 * command carry, and which paths would they affect?* The decision (refuse,
 * protect-then-allow, note) and the I/O (capturing the pre-state) live with the
 * caller, so the interesting half is unit-testable without a shell.
 *
 * ## The boundary, stated plainly
 *
 * This is a guard against the agent's mistakes, not a security boundary. Shell
 * is a programming language: `$(echo cm0K | base64 -d) -rf .` defeats any
 * classifier, and pi's own documentation is explicit that "a partial in-process
 * sandbox would be easy to misunderstand as a security boundary". Sentinel does
 * not contradict that. It catches the destructive command an agent writes when
 * it is confused — which is the overwhelmingly common case — and it says so
 * rather than implying more. Commands that *look* evasive (command substitution
 * feeding an interpreter, `eval`, a decoder piped to a shell) are classified as
 * `untrusted-execution` precisely because their intent cannot be read.
 *
 * Real isolation has to come from the OS: a container, or pi's Gondolin
 * micro-VM extension. This module is what you want *in addition* to that.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What kind of damage a command can do. */
export type BashRiskKind =
  /** Removes files (`rm`, `shred`, `truncate`). */
  | "destructive-delete"
  /** Overwrites in place (`>`, `dd`, `tee`, `sed -i`, `mv` onto a file). */
  | "destructive-overwrite"
  /** Throws away committed or staged work (`git reset --hard`, `git clean`). */
  | "history-rewrite"
  /** Effects that leave the machine and cannot be undone locally. */
  | "irreversible-external"
  /** Network content fed into an interpreter, or otherwise unreadable intent. */
  | "untrusted-execution"
  /** Runs as another user; sentinel's guarantees do not extend there. */
  | "privilege-escalation";

/**
 * How the caller should treat a risk.
 *
 *   - `refuse`:  nothing can make this undoable; the only safe answer is no.
 *   - `protect`: allowed *if* the pre-state can be captured first.
 *   - `note`:    ordinary, but worth telling the human about.
 */
export type BashSeverity = "refuse" | "protect" | "note";

export interface BashRisk {
  kind: BashRiskKind;
  severity: BashSeverity;
  /** The segment that triggered it, for a message the agent can act on. */
  evidence: string;
  /** Literal path arguments the segment named, unresolved. */
  paths: string[];
}

/** One command in a pipeline or list, with the operator that introduced it. */
export interface Segment {
  /** Operator *before* this segment (`""` for the first one). */
  op: "" | "|" | "&&" | "||" | ";" | "&" | "\n";
  /** The raw text of the segment. */
  text: string;
  /** Quote-stripped argv, environment assignments removed. */
  argv: string[];
}

/** Interpreters that turn piped text into executed code. */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish",
  "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "php",
]);

/** Commands that fetch from the network. */
const FETCHERS = new Set(["curl", "wget", "http", "httpie", "fetch"]);

/** Commands whose whole purpose is removal. */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred", "srm"]);

/** `git` subcommands that discard work that is already in the repository. */
const GIT_DISCARD = new Set(["reset", "clean", "checkout", "restore", "stash"]);

/**
 * Split a command line into segments, respecting quotes.
 *
 * Good enough for classification: it does not implement shell grammar, it
 * implements "where does one command end and the next begin" well enough that a
 * pipeline's stages can be looked at individually.
 */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let op: Segment["op"] = "";
  let quote: '"' | "'" | null = null;
  let depth = 0;

  const push = (nextOp: Segment["op"]) => {
    const text = current.trim();
    if (text) segments.push({ op, text, argv: argvOf(text) });
    current = "";
    op = nextOp;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];

    if (quote) {
      current += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    // Keep substitutions intact: their *presence* is the signal, and splitting
    // inside them would invent segments the shell never runs separately.
    if (c === "$" && next === "(") {
      depth += 1;
      current += c;
      continue;
    }
    if (c === "(" && depth > 0) {
      depth += 1;
      current += c;
      continue;
    }
    if (c === ")" && depth > 0) {
      depth -= 1;
      current += c;
      continue;
    }
    if (depth > 0) {
      current += c;
      continue;
    }

    if (c === "&" && next === "&") {
      push("&&");
      i += 1;
      continue;
    }
    if (c === "|" && next === "|") {
      push("||");
      i += 1;
      continue;
    }
    if (c === "|") {
      push("|");
      continue;
    }
    if (c === ";") {
      push(";");
      continue;
    }
    if (c === "&") {
      push("&");
      continue;
    }
    if (c === "\n") {
      push("\n");
      continue;
    }
    current += c;
  }
  push("");

  return segments;
}

/** Quote-aware argv, with leading `FOO=bar` assignments dropped. */
export function argvOf(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += c;
  }
  if (started || current) out.push(current);

  // `NODE_ENV=production npm run build` — the command is `npm`, not the env.
  while (out.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
  return out;
}

/** The arguments of a segment that look like filesystem paths, not flags. */
export function literalPaths(argv: string[]): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  for (const raw of argv.slice(1)) {
    if (raw === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && raw.startsWith("-")) continue;
    if (raw === "") continue;
    // A glob cannot be resolved without running the shell; the caller treats an
    // unresolvable path as "cannot protect", which is the safe reading.
    out.push(raw);
  }
  return out;
}

/** True when any argument is the given short or long flag. */
function hasFlag(argv: string[], ...flags: string[]): boolean {
  return argv.some((arg) => {
    if (flags.includes(arg)) return true;
    // Bundled short flags: `-rf` contains `-r` and `-f`.
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    return flags.some((flag) => flag.length === 2 && flag.startsWith("-") && arg.includes(flag[1]));
  });
}

/** The git subcommand of a segment, skipping global options like `-C dir`. */
function gitSubcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/** Redirection targets in a segment (`>` truncates, `>>` appends). */
export function redirectTargets(text: string): { truncating: string[]; appending: string[] } {
  const truncating: string[] = [];
  const appending: string[] = [];
  // Deliberately simple: `2>&1` and `>&2` are descriptor plumbing, not files.
  // The lookbehind excludes `>` so that `2>>` is read as one append operator
  // rather than a truncation starting at its second character.
  const pattern = /(?<![>&])(>>?)\s*(?!&)([^\s;|&<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = match[2];
    if (target.startsWith("/dev/")) continue;
    if (match[1] === ">>") appending.push(target);
    else truncating.push(target);
  }
  return { truncating, appending };
}

function risk(
  kind: BashRiskKind,
  severity: BashSeverity,
  evidence: string,
  paths: string[] = [],
): BashRisk {
  return { kind, severity, evidence, paths };
}

/**
 * Classify what a command would do. Pure: no filesystem, no shell.
 *
 * Several risks can apply to one command line; the caller decides using the
 * most severe one, and reports all of them so the agent knows why.
 */
export function classifyCommand(command: string): BashRisk[] {
  const risks: BashRisk[] = [];
  const segments = splitSegments(command);

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const argv = segment.argv;
    const head = path.basename(argv[0] ?? "");
    const paths = literalPaths(argv);

    // ── unreadable intent ────────────────────────────────────────────────
    // Not "probably malicious" — *unreadable*. A classifier that cannot see
    // what will run must not pretend it approved it.
    if (/\$\(|`/.test(segment.text) && /curl|wget|base64|eval/.test(segment.text)) {
      risks.push(risk("untrusted-execution", "refuse", segment.text));
    } else if (head === "eval" || (head === "source" && /<\(/.test(segment.text))) {
      risks.push(risk("untrusted-execution", "refuse", segment.text));
    }

    // Network content piped into an interpreter: the canonical injection shape.
    if (segment.op === "|" && INTERPRETERS.has(head)) {
      const previous = segments[i - 1];
      const previousHead = path.basename(previous?.argv[0] ?? "");
      if (FETCHERS.has(previousHead)) {
        risks.push(
          risk("untrusted-execution", "refuse", `${previous.text} | ${segment.text}`),
        );
      }
    }

    if (head === "sudo" || head === "doas" || head === "su") {
      risks.push(risk("privilege-escalation", "refuse", segment.text));
    }

    // ── removal ──────────────────────────────────────────────────────────
    if (REMOVERS.has(head)) {
      risks.push(risk("destructive-delete", "protect", segment.text, paths));
    }

    // ── in-place overwrite ───────────────────────────────────────────────
    if (head === "dd" || head === "truncate") {
      risks.push(risk("destructive-overwrite", "protect", segment.text, paths));
    }
    if (head === "sed" && hasFlag(argv, "-i") ) {
      risks.push(risk("destructive-overwrite", "protect", segment.text, paths));
    }
    if (head === "tee" && !hasFlag(argv, "-a", "--append")) {
      risks.push(risk("destructive-overwrite", "protect", segment.text, paths));
    }
    if ((head === "mv" || head === "cp") && paths.length >= 2) {
      // Only the destination can be clobbered.
      risks.push(risk("destructive-overwrite", "protect", segment.text, paths.slice(-1)));
    }

    const redirects = redirectTargets(segment.text);
    if (redirects.truncating.length > 0) {
      risks.push(
        risk("destructive-overwrite", "protect", segment.text, redirects.truncating),
      );
    }

    // ── git: discarding work, and publishing it ──────────────────────────
    if (head === "git") {
      const sub = gitSubcommand(argv);

      if (sub && GIT_DISCARD.has(sub)) {
        const discards =
          (sub === "reset" && hasFlag(argv, "--hard")) ||
          (sub === "clean" && hasFlag(argv, "-f", "-d", "-x", "--force")) ||
          (sub === "checkout" && (argv.includes("--") || argv.includes("."))) ||
          (sub === "restore" && paths.length > 0) ||
          (sub === "stash" && (argv.includes("drop") || argv.includes("clear")));
        if (discards) {
          risks.push(risk("history-rewrite", "protect", segment.text));
        }
      }

      if (sub === "push") {
        const forced = hasFlag(argv, "--force", "-f") || argv.includes("--force-with-lease");
        risks.push(
          forced
            ? risk("irreversible-external", "refuse", segment.text)
            : // An ordinary push is a normal thing to be asked for. Refusing it
              // by default would make the guard the problem.
              risk("irreversible-external", "note", segment.text),
        );
      }
    }

    // ── publishing and other one-way doors ───────────────────────────────
    const rest = argv.slice(1).join(" ");
    if (["npm", "pnpm", "yarn", "bun"].includes(head) && /^publish\b/.test(rest)) {
      risks.push(risk("irreversible-external", "refuse", segment.text));
    }
    if (head === "gh" && /^(release create|repo delete|pr merge)\b/.test(rest)) {
      risks.push(risk("irreversible-external", "refuse", segment.text));
    }
    if (head === "docker" && /\b(system prune|volume rm)\b/.test(rest)) {
      risks.push(risk("destructive-delete", "note", segment.text));
    }
  }

  return risks;
}

/** The worst severity in a set of risks, or null when there are none. */
export function worstSeverity(risks: BashRisk[]): BashSeverity | null {
  if (risks.some((r) => r.severity === "refuse")) return "refuse";
  if (risks.some((r) => r.severity === "protect")) return "protect";
  if (risks.length > 0) return "note";
  return null;
}

export interface ProtectionPlan {
  /** Existing files whose pre-state can and should be captured. */
  files: string[];
  /** Named paths that could not be resolved (globs, variables, `~`). */
  unresolved: string[];
  /** True when the blast radius exceeded `maxFiles` and is not fully covered. */
  overflowed: boolean;
}

/**
 * Work out exactly which files a destructive command would affect, so their
 * pre-state can be captured before it runs.
 *
 * The scope is deliberately the same one sentinel verifies: a path the config
 * excludes (`node_modules`, `dist`, `.git`) is not sentinel's to protect, so
 * `rm -rf node_modules` costs nothing and is not treated as unprotectable. What
 * sentinel guards, it guards; what it ignores, it ignores — consistently.
 */
export function planProtection(
  cwd: string,
  paths: string[],
  options: {
    maxFiles: number;
    /** Same predicate the mutation hooks use, so the two never disagree. */
    shouldProtect: (absPath: string) => boolean;
  },
): ProtectionPlan {
  const files: string[] = [];
  const unresolved: string[] = [];
  let overflowed = false;

  const visit = (absPath: string): void => {
    if (overflowed) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      // Not there: a command that removes a non-existent path destroys nothing,
      // and one that creates it leaves nothing to restore.
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(absPath);
      } catch {
        unresolved.push(absPath);
        return;
      }
      for (const entry of entries) visit(path.join(absPath, entry));
      return;
    }
    if (!stat.isFile()) return;
    if (!options.shouldProtect(absPath)) return;
    if (files.length >= options.maxFiles) {
      overflowed = true;
      return;
    }
    files.push(absPath);
  };

  for (const raw of paths) {
    // A glob, a variable or a `~` cannot be resolved without a shell. Saying so
    // is the honest answer; guessing would be the dangerous one.
    if (/[*?\[\]{}$~]/.test(raw)) {
      unresolved.push(raw);
      continue;
    }
    visit(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
  }

  return { files: [...new Set(files)], unresolved: [...new Set(unresolved)], overflowed };
}

/** Human-readable label for a risk kind, for the agent-facing message. */
export function riskHeadline(kind: BashRiskKind): string {
  switch (kind) {
    case "destructive-delete":
      return "removes files";
    case "destructive-overwrite":
      return "overwrites files in place";
    case "history-rewrite":
      return "discards work already in the repository";
    case "irreversible-external":
      return "has effects outside this machine";
    case "untrusted-execution":
      return "executes content sentinel cannot read";
    case "privilege-escalation":
      return "runs with elevated privileges";
  }
}
