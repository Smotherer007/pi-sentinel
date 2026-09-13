import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  impactOf,
  impactOfAll,
  expandWithDependents,
  describeChange,
  graphStatus,
  hasGraph,
  _clearCache,
} from "../src/clients/mindplace.ts";

let dir: string;

/** A minimal but realistic mindplace graph: two files, one cross-file call. */
const GRAPH = {
  nodes: [
    { id: "src_a_file", label: "a.ts", type: "file", sourceFile: "src/a.ts" },
    {
      id: "src_a_parse",
      label: "parseA",
      type: "function",
      sourceFile: "src/a.ts",
      centrality: 0.5,
    },
    {
      id: "src_a_deep",
      label: "deepMerge",
      type: "function",
      sourceFile: "src/a.ts",
      centrality: 0.2,
    },
    { id: "src_b_file", label: "b.ts", type: "file", sourceFile: "src/b.ts" },
    {
      id: "src_b_use",
      label: "useA",
      type: "function",
      sourceFile: "src/b.ts",
      centrality: 0.1,
    },
  ],
  edges: [{ source: "src_b_use", target: "src_a_parse", relation: "calls" }],
};

function writeGraph(data: unknown = GRAPH): void {
  fs.mkdirSync(path.join(dir, "graph-out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "graph-out", "graph.json"), JSON.stringify(data), "utf-8");
  _clearCache();
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mindplace-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dir, "graph-out"), { recursive: true, force: true });
  _clearCache();
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("graph availability", () => {
  test("degrades silently when no graph exists", () => {
    assert.equal(hasGraph(dir), false);
    assert.equal(impactOf(dir, path.join(dir, "src/a.ts")), null);
    assert.deepEqual(impactOfAll(dir, [path.join(dir, "src/a.ts")]), []);
    assert.equal(graphStatus(dir).present, false);
  });

  test("degrades silently on a malformed graph", () => {
    fs.mkdirSync(path.join(dir, "graph-out"), { recursive: true });
    fs.writeFileSync(path.join(dir, "graph-out", "graph.json"), "{not json", "utf-8");
    _clearCache();
    assert.equal(hasGraph(dir), false);
  });

  test("reports size and freshness once a graph exists", () => {
    writeGraph();
    // The graph references real files: a missing one counts as stale.
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "export const b = 1;\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, "src", "a.ts"), past, past);
    fs.utimesSync(path.join(dir, "src", "b.ts"), past, past);

    const status = graphStatus(dir);
    assert.equal(status.present, true);
    assert.equal(status.nodeCount, 5);
    assert.equal(status.edgeCount, 1);
    assert.equal(status.stale, false);
  });

  test("a deleted file alone is not treated as a stale graph", () => {
    writeGraph();
    // mindplace would not rebuild for this either, so sentinel must not claim
    // the graph is out of date — otherwise the warning never clears.
    fs.rmSync(path.join(dir, "src"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    assert.equal(graphStatus(dir).stale, false);
  });

  test("flags a stale graph when sources are newer than the graph", () => {
    writeGraph();
    const sourceFile = path.join(dir, "src", "a.ts");
    fs.writeFileSync(sourceFile, "export const a = 1;\n");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sourceFile, future, future);
    assert.equal(graphStatus(dir).stale, true);
  });
});

describe("impactOf", () => {
  test("returns the symbols a file defines, most central first", () => {
    writeGraph();
    const impact = impactOf(dir, path.join(dir, "src/a.ts"));
    assert.ok(impact);
    assert.equal(impact.file, "src/a.ts");
    assert.deepEqual(impact.symbols.slice(0, 2), ["parseA", "deepMerge"]);
  });

  test("names the files that depend on it", () => {
    writeGraph();
    const impact = impactOf(dir, path.join(dir, "src/a.ts"));
    assert.deepEqual(impact?.dependents, ["src/b.ts"]);
  });

  test("returns null for a file the graph does not know", () => {
    writeGraph();
    assert.equal(impactOf(dir, path.join(dir, "src/unknown.ts")), null);
  });

  test("never lists a file as its own dependent", () => {
    writeGraph();
    const impacts = impactOfAll(dir, [path.join(dir, "src/a.ts"), path.join(dir, "src/b.ts")]);
    for (const impact of impacts) {
      assert.equal(impact.dependents.includes(impact.file), false);
    }
  });
});

describe("expandWithDependents", () => {
  test("adds dependents to the verification focus", () => {
    writeGraph();
    const focus = expandWithDependents(dir, [path.join(dir, "src/a.ts")], 10);
    assert.deepEqual(focus, [path.join(dir, "src/a.ts"), path.join(dir, "src", "b.ts")]);
  });

  test("returns the input untouched without a graph", () => {
    const input = [path.join(dir, "src/a.ts")];
    assert.deepEqual(expandWithDependents(dir, input, 10), input);
  });

  test("respects the expansion limit", () => {
    writeGraph();
    const focus = expandWithDependents(dir, [path.join(dir, "src/a.ts")], 0);
    assert.equal(focus.length, 1);
  });
});

describe("describeChange", () => {
  test("uses symbol names for a changelog-style label", () => {
    writeGraph();
    const label = describeChange(dir, [path.join(dir, "src/a.ts")]);
    assert.equal(label, "parseA, deepMerge (src/a.ts)");
  });

  test("falls back to the path when the file is unknown to the graph", () => {
    writeGraph();
    const label = describeChange(dir, [path.join(dir, "src/unknown.ts")]);
    assert.equal(label, "src/unknown.ts");
  });

  test("summarises multiple files", () => {
    writeGraph();
    const label = describeChange(dir, [
      path.join(dir, "src/a.ts"),
      path.join(dir, "src/b.ts"),
    ]);
    assert.ok(label.includes("+1 file(s)"), `unexpected label: ${label}`);
  });

  test("handles an empty change set", () => {
    writeGraph();
    assert.equal(describeChange(dir, []), "no files");
  });
});
