/**
 * The pi-mindplace integration: read-only.
 *
 * pi-mindplace owns the code graph — building it, keeping it fresh, and
 * answering structural questions (`mindplace_query`, `mindplace_explain`).
 * Sentinel only reads `graph-out/graph.json` to name the files that depend on
 * what the agent changed, so a failure payload can point at the blast radius
 * and the pruner can rank those diagnostics higher.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { relativeTo } from "./glob.ts";
import type { Dependents } from "./format/feedback.ts";

export const GRAPH_FILE = path.join("graph-out", "graph.json");

interface Graph {
  nodes?: Array<{ id: string; sourceFile?: string }>;
  edges?: Array<{ source: string; target: string }>;
}

interface Index {
  mtimeMs: number;
  /** file → files that reference it */
  dependents: Map<string, Set<string>>;
}

const cache = new Map<string, Index>();

function normalise(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function load(cwd: string): Index | null {
  const file = path.join(cwd, GRAPH_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(cwd);
  if (cached?.mtimeMs === mtimeMs) return cached;
  try {
    const graph = JSON.parse(fs.readFileSync(file, "utf-8")) as Graph;
    const fileOf = new Map<string, string>();
    for (const node of graph.nodes ?? []) {
      if (node?.id && node.sourceFile) fileOf.set(node.id, normalise(node.sourceFile));
    }
    const dependents = new Map<string, Set<string>>();
    for (const edge of graph.edges ?? []) {
      const from = fileOf.get(edge?.source);
      const to = fileOf.get(edge?.target);
      if (!from || !to || from === to) continue;
      let set = dependents.get(to);
      if (!set) dependents.set(to, (set = new Set()));
      set.add(from);
    }
    const index = { mtimeMs, dependents };
    cache.set(cwd, index);
    return index;
  } catch {
    return null;
  }
}

export function hasGraph(cwd: string): boolean {
  return load(cwd) !== null;
}

/** Files that depend on each changed file, excluding the changed files themselves. */
export function dependentsOf(cwd: string, changed: string[], perFile = 6, maxFiles = 5): Dependents[] {
  const index = load(cwd);
  if (!index) return [];
  const self = new Set(changed.map((file) => relativeTo(cwd, file)));
  const out: Dependents[] = [];
  for (const rel of self) {
    const deps = [...(index.dependents.get(rel) ?? [])].filter((d) => !self.has(d)).sort();
    if (deps.length === 0) continue;
    out.push({ file: rel, dependents: deps.slice(0, perFile) });
    if (out.length >= maxFiles) break;
  }
  return out;
}

export function _clearGraphCache(): void {
  cache.clear();
}
