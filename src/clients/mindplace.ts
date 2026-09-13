/**
 * MindplaceClient — impact analysis from the code knowledge graph.
 *
 * pi-sentinel is the write phase; pi-mindplace is the read phase (see the
 * "Synergy" section of the README). Sentinel knows *what* just changed and
 * whether it still compiles; mindplace knows *what depends on it*. Combining
 * the two turns raw compiler noise into an actionable repair target.
 *
 * This adapter is deliberately decoupled: it reads `graph-out/graph.json`
 * directly instead of importing pi-mindplace. That keeps sentinel free of a
 * tree-sitter dependency, of the graph's version churn, and of hard failure
 * when the graph extension is not installed at all.
 *
 * Deliberately silent degradation: no graph, malformed graph or a stale graph
 * all yield empty results, and every caller keeps working exactly as before.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { GraphImpact, GraphStatus } from "../types.ts";

export const GRAPH_DIR = "graph-out";
export const GRAPH_FILE = "graph.json";

/** Upper bound on dependents returned per file (keeps feedback terse). */
export const MAX_DEPENDENTS = 8;

/** Upper bound on symbol names shown per file. */
export const MAX_SYMBOLS = 6;

/** How many source files to stat when judging graph staleness. */
const MAX_STALENESS_CHECKS = 400;

interface RawNode {
  id: string;
  label: string;
  type: string;
  sourceFile: string;
  centrality?: number;
}

interface RawEdge {
  source: string;
  target: string;
  relation?: string;
}

interface RawGraph {
  nodes?: RawNode[];
  edges?: RawEdge[];
}

interface GraphIndex {
  mtimeMs: number;
  nodeCount: number;
  edgeCount: number;
  /** Relative file path → symbols defined in it. */
  byFile: Map<string, RawNode[]>;
  /** Relative file path → related file path → weight. */
  related: Map<string, Map<string, number>>;
  /** Relative file paths known to the graph. */
  files: Set<string>;
}

const cache = new Map<string, GraphIndex>();

export function graphPath(cwd: string): string {
  return path.join(cwd, GRAPH_DIR, GRAPH_FILE);
}

/** Normalise a graph path (always POSIX-relative) for lookups. */
function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Turn an absolute path into the graph's relative form. */
export function toGraphPath(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  if (rel && !rel.startsWith("..")) return normalise(rel);
  return normalise(absPath);
}

function buildIndex(raw: RawGraph, mtimeMs: number): GraphIndex {
  const byFile = new Map<string, RawNode[]>();
  const related = new Map<string, Map<string, number>>();
  const byId = new Map<string, RawNode>();

  for (const node of raw.nodes ?? []) {
    if (!node?.id || !node.sourceFile) continue;
    byId.set(node.id, node);
    const file = normalise(node.sourceFile);
    const list = byFile.get(file);
    if (list) list.push(node);
    else byFile.set(file, [node]);
  }

  const bump = (from: string, to: string, weight: number) => {
    let targets = related.get(from);
    if (!targets) {
      targets = new Map();
      related.set(from, targets);
    }
    targets.set(to, (targets.get(to) ?? 0) + weight);
  };

  for (const edge of raw.edges ?? []) {
    const source = byId.get(edge?.source);
    const target = byId.get(edge?.target);
    if (!source || !target) continue;
    const from = normalise(source.sourceFile);
    const to = normalise(target.sourceFile);
    if (from === to) continue;
    // Outgoing ("imports") is the stronger signal for blast radius, but the
    // mindplace adjacency is symmetric, so incoming links still count.
    bump(from, to, edge.relation === "imports" ? 2 : 1);
    bump(to, from, 1);
  }

  return {
    mtimeMs,
    nodeCount: byId.size,
    edgeCount: (raw.edges ?? []).length,
    byFile,
    related,
    files: new Set(byFile.keys()),
  };
}

/** Load and index the graph, cached by graph.json mtime. Null when absent. */
export function loadIndex(cwd: string): GraphIndex | null {
  const gp = graphPath(cwd);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(gp).mtimeMs;
  } catch {
    return null;
  }

  const cached = cache.get(cwd);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  try {
    const raw = JSON.parse(fs.readFileSync(gp, "utf-8")) as RawGraph;
    const index = buildIndex(raw, mtimeMs);
    cache.set(cwd, index);
    return index;
  } catch {
    return null;
  }
}

/** True when a usable graph exists for this project. */
export function hasGraph(cwd: string): boolean {
  return loadIndex(cwd) !== null;
}

/** Graph size and freshness, for `sentinel_status`. */
export function graphStatus(cwd: string): GraphStatus {
  const index = loadIndex(cwd);
  if (!index) return { present: false, stale: false, nodeCount: 0, edgeCount: 0 };

  let stale = false;
  let checked = 0;
  for (const file of index.files) {
    if (checked >= MAX_STALENESS_CHECKS) break;
    checked += 1;
    try {
      if (fs.statSync(path.join(cwd, file)).mtimeMs > index.mtimeMs) {
        stale = true;
        break;
      }
    } catch {
      // A file the graph mentions but that no longer exists means the graph has
      // a stale *node*, not stale *content* — mindplace itself would not rebuild
      // for that either, so reporting "stale" here would be a false alarm that
      // never clears during a refactor.
      continue;
    }
  }

  return {
    present: true,
    stale,
    nodeCount: index.nodeCount,
    edgeCount: index.edgeCount,
    builtAt: new Date(index.mtimeMs).toISOString(),
  };
}

/**
 * Impact of one file: symbols it defines plus the files related to it.
 * Returns null when there is no graph or the file is unknown to it.
 */
export function impactOf(cwd: string, absPath: string): GraphImpact | null {
  const index = loadIndex(cwd);
  if (!index) return null;

  const rel = toGraphPath(cwd, absPath);
  const nodes = index.byFile.get(rel);
  const related = index.related.get(rel);
  if (!nodes && !related) return null;

  const symbols = [...(nodes ?? [])]
    // File nodes carry the file name, which would only repeat the label.
    .filter((n) => n.type !== "file")
    .sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))
    .map((n) => n.label)
    .filter((label, i, all) => label && all.indexOf(label) === i)
    .slice(0, MAX_SYMBOLS);

  const dependents = [...(related ?? new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
    .slice(0, MAX_DEPENDENTS);

  return { file: rel, dependents, symbols };
}

/**
 * Impact for several files, de-duplicated and capped.
 * The mutated files themselves are never listed as their own dependents.
 */
export function impactOfAll(cwd: string, absPaths: string[], limit = 6): GraphImpact[] {
  const index = loadIndex(cwd);
  if (!index) return [];

  const self = new Set(absPaths.map((p) => toGraphPath(cwd, p)));
  const out: GraphImpact[] = [];
  for (const p of absPaths) {
    const impact = impactOf(cwd, p);
    if (!impact) continue;
    const dependents = impact.dependents.filter((d) => !self.has(d));
    if (dependents.length === 0 && impact.symbols.length === 0) continue;
    out.push({ ...impact, dependents });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Expand a set of mutated files with their graph dependents, so diagnostics
 * in affected files are promoted by the pruner instead of being buried
 * under unrelated output.
 */
export function expandWithDependents(cwd: string, absPaths: string[], limit = 10): string[] {
  const index = loadIndex(cwd);
  if (!index) return absPaths;

  const seen = new Set(absPaths);
  for (const p of absPaths) {
    const impact = impactOf(cwd, p);
    if (!impact) continue;
    for (const dep of impact.dependents) {
      if (seen.size >= absPaths.length + limit) return [...seen];
      seen.add(path.resolve(cwd, dep));
    }
  }
  return [...seen];
}

/**
 * A short human label for a set of changed files, using symbol names from the
 * graph — e.g. "parseConfig, deepMerge (src/config.ts)". Used by the
 * checkpoint store so `/sentinel rewind` reads like a changelog.
 */
export function describeChange(cwd: string, absPaths: string[]): string {
  if (absPaths.length === 0) return "no files";

  const index = loadIndex(cwd);
  const first = absPaths[0];
  const rel = toGraphPath(cwd, first);

  if (index) {
    const symbols = impactOf(cwd, first)?.symbols ?? [];
    if (symbols.length > 0) {
      const head = symbols.slice(0, 3).join(", ");
      const more = absPaths.length > 1 ? ` +${absPaths.length - 1} file(s)` : "";
      return `${head} (${rel})${more}`;
    }
  }

  if (absPaths.length === 1) return rel;
  return `${rel} +${absPaths.length - 1} more`;
}

/** @internal Drop the memoised graph — for testing only. */
export function _clearCache(): void {
  cache.clear();
}
