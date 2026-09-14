/**
 * Unit tests for the mutation seam.
 *
 * The seam decides whether a tool call can write a file, and everything sentinel
 * promises hangs off that answer: the pre-state capture, the verification, the
 * rollback, the evidence ledger. The cases below are the ones that used to be
 * wrong — a foreign editor writing a file that nobody snapshotted — plus the
 * ones that must stay free: a read tool must not arm a capture.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_HINT_PATHS,
  MAX_LEARNED_TOOLS,
  classifyMutation,
  contentField,
  isLearnedMutationTool,
  learnMutationTool,
  namedPaths,
} from "../src/clients/mutation.ts";

describe("mutation: the host's own tools keep their old answer", () => {
  test("edit and write are edits and writes, whatever the path key", () => {
    assert.deepEqual(classifyMutation("edit", { path: "a.ts" }), {
      kind: "edit",
      paths: ["a.ts"],
      evidence: "name:edit",
    });
    assert.deepEqual(classifyMutation("write", { filePath: "src/b.ts" }), {
      kind: "write",
      paths: ["src/b.ts"],
      evidence: "name:write",
    });
    assert.deepEqual(classifyMutation("write", { file: "c.ts" }), {
      kind: "write",
      paths: ["c.ts"],
      evidence: "name:write",
    });
  });

  test("a mutation with no path is still a mutation", () => {
    const hint = classifyMutation("write", {});
    assert.equal(hint?.kind, "write");
    assert.deepEqual(hint?.paths, []);
  });
});

describe("mutation: foreign edit tools are recognized by name", () => {
  for (const name of ["replace", "insert", "multi_edit", "apply_patch", "edit_file", "undo_last_change"]) {
    test(`${name} is an edit`, () => {
      const hint = classifyMutation(name, { path: "src/a.ts", oldText: "a", newText: "b" });
      assert.equal(hint?.kind, "edit");
      assert.deepEqual(hint?.paths, ["src/a.ts"]);
      assert.equal(hint?.evidence, `name:${name}`);
    });
  }

  test("a foreign writer is a write, and create is not in the table", () => {
    assert.equal(classifyMutation("create_file", { path: "a.ts" })?.kind, "write");
    // `create` means a non-file resource often enough that guessing is worse
    // than watching it.
    assert.equal(classifyMutation("create", { path: "a.ts" })?.kind, "unknown");
  });
});

describe("mutation: shape tier", () => {
  test("path plus content is a mutation", () => {
    const hint = classifyMutation("frobnicate", { path: "src/a.ts", newText: "hello" });
    assert.equal(hint?.kind, "edit");
    assert.equal(hint?.evidence, "shape:newText");
  });

  test("path alone is not a mutation, but is worth watching", () => {
    const hint = classifyMutation("frobnicate", { path: "src/a.ts" });
    assert.equal(hint?.kind, "unknown");
    assert.deepEqual(hint?.paths, ["src/a.ts"]);
  });

  test("read-shaped tools are not watched at all", () => {
    for (const name of ["read_file", "search_files", "list_dir", "grep_search", "lens_diagnostics", "web_search", "sentinel_status"]) {
      assert.equal(classifyMutation(name, { path: "src/a.ts" }), null, name);
    }
  });

  test("a call that names nothing is not watched", () => {
    assert.equal(classifyMutation("frobnicate", {}), null);
    assert.equal(classifyMutation("frobnicate", { limit: 5 }), null);
  });

  test("shell tools belong to the shell guard", () => {
    assert.equal(classifyMutation("bash", { command: "rm -rf src" }), null);
    assert.equal(classifyMutation("powershell", { command: "Remove-Item src" }), null);
  });

  test("garbage input cannot be mistaken for a path", () => {
    assert.equal(classifyMutation("frobnicate", { path: "" }), null);
    assert.equal(classifyMutation("frobnicate", { path: 42 }), null);
    assert.equal(classifyMutation("frobnicate", { path: "https://example.com/a.ts" }), null);
    assert.equal(classifyMutation("frobnicate", null), null);
    assert.equal(classifyMutation("", { path: "a.ts" }), null);
  });
});

describe("mutation: learned tools", () => {
  test("a learned name is an edit even with no content field", () => {
    const hint = classifyMutation("frobnicate", { path: "a.ts" }, ["frobnicate"]);
    assert.equal(hint?.kind, "edit");
    assert.equal(hint?.evidence, "learned:frobnicate");
  });

  test("learning beats a read-shaped name", () => {
    // Contrived, but the rule is deliberate: what a tool did outranks what it
    // is called.
    const hint = classifyMutation("read_and_fix", { path: "a.ts" }, ["read_and_fix"]);
    assert.equal(hint?.kind, "edit");
  });

  test("learning is idempotent and capped", () => {
    assert.deepEqual(learnMutationTool([], "frobnicate"), ["frobnicate"]);
    assert.deepEqual(learnMutationTool(["frobnicate"], "frobnicate"), ["frobnicate"]);
    assert.equal(isLearnedMutationTool(["frobnicate"], "frobnicate"), true);
    assert.equal(isLearnedMutationTool(["frobnicate"], "other"), false);

    let learned: string[] = [];
    for (let i = 0; i < MAX_LEARNED_TOOLS + 5; i++) learned = learnMutationTool(learned, `tool_${i}`);
    assert.equal(learned.length, MAX_LEARNED_TOOLS);
    // Newest kept, oldest dropped.
    assert.equal(learned[learned.length - 1], `tool_${MAX_LEARNED_TOOLS + 4}`);
    assert.equal(isLearnedMutationTool(learned, "tool_0"), false);
  });
});

describe("mutation: path extraction", () => {
  test("both the single and the plural keys are read", () => {
    assert.deepEqual(namedPaths({ path: "a.ts", filePath: "b.ts" }), ["a.ts", "b.ts"]);
    assert.deepEqual(namedPaths({ files: ["a.ts", "b.ts"] }), ["a.ts", "b.ts"]);
    assert.deepEqual(namedPaths({ paths: ["a.ts"], path: "a.ts" }), ["a.ts"]);
  });

  test("extraction is bounded", () => {
    const many = Array.from({ length: MAX_HINT_PATHS + 10 }, (_, i) => `f${i}.ts`);
    assert.equal(namedPaths({ files: many }).length, MAX_HINT_PATHS);
  });

  test("empty-valued content keys do not count as content", () => {
    assert.equal(contentField({ newText: "" }), undefined);
    assert.equal(contentField({ edits: [] }), undefined);
    assert.equal(contentField({ newText: "x" }), "newText");
    assert.equal(contentField({ patch: "@@ -1 +1 @@" }), "patch");
  });
});
