/**
 * Repository identity: running below the repository root is normal, and every
 * git-derived path has to survive it.
 *
 * `git status --porcelain` prints paths relative to the repository *root*,
 * never to the current directory. Resolving them against the cwd produced
 * paths that do not exist as soon as the agent ran in a subdirectory — and
 * those phantom paths then reached the verification focus, the state hash and
 * the change policy.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { GitClient, repoRoot, _clearRepoRootCache } from "../src/clients/git-client.ts";
import { changedPaths, outOfBandChanges, captureBaseline } from "../src/clients/workspace.ts";

let repo: string;
let sub: string;

beforeEach(() => {
  _clearRepoRootCache();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-root-"));
  sub = path.join(repo, "packages", "app");
  fs.mkdirSync(sub, { recursive: true });
  execSync("git init -q", { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
});

afterEach(() => {
  _clearRepoRootCache();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("repoRoot", () => {
  test("resolves the root from a subdirectory", () => {
    assert.equal(repoRoot(sub), repo);
  });

  test("keeps the caller's own path prefix instead of git's canonical one", () => {
    // On macOS the temp dir is a symlink, so `--show-toplevel` answers with a
    // different (real) prefix. Returning that would make every derived path
    // disagree with the absolute paths the mutation hooks captured.
    assert.equal(repoRoot(repo), path.resolve(repo));
  });

  test("returns null outside a repository", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-plain-"));
    try {
      assert.equal(repoRoot(plain), null);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a directory that becomes a repository is not remembered as 'no repo'", () => {
    const later = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-later-"));
    try {
      assert.equal(repoRoot(later), null);
      execSync("git init -q", { cwd: later });
      assert.equal(repoRoot(later), path.resolve(later));
    } finally {
      fs.rmSync(later, { recursive: true, force: true });
    }
  });
});

describe("GitClient in a subdirectory", () => {
  test("recognises the repository", () => {
    assert.equal(GitClient.isGitRepo(sub), true);
  });

  test("reports branch and head", () => {
    const meta = GitClient.gitMeta(sub);
    assert.ok(meta, "metadata is available below the root");
    assert.ok(meta.head.length > 0);
  });
});

describe("changedPaths from a subdirectory", () => {
  test("yields paths that actually exist", () => {
    fs.writeFileSync(path.join(sub, "generated.ts"), "export const g = 1;\n");

    const fromRoot = changedPaths(repo).map((c) => c.path);
    const fromSub = changedPaths(sub).map((c) => c.path);

    assert.deepEqual(fromSub, fromRoot, "the cwd must not change the answer");
    for (const file of fromSub) {
      assert.equal(fs.existsSync(file), true, `${file} must be a real path`);
    }
  });
});

describe("turn baseline", () => {
  test("work already in flight is not reported as a turn change", () => {
    fs.writeFileSync(path.join(repo, "wip.ts"), "export const wip = 1;\n");
    const baseline = captureBaseline(repo);

    assert.deepEqual(outOfBandChanges(repo, [], () => false, baseline), []);
  });

  test("a change made after the baseline is reported", () => {
    fs.writeFileSync(path.join(repo, "wip.ts"), "export const wip = 1;\n");
    const baseline = captureBaseline(repo);

    fs.writeFileSync(path.join(repo, "wip.ts"), "export const wip = 2;\n");
    const changes = outOfBandChanges(repo, [], () => false, baseline);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, path.join(repo, "wip.ts"));
  });

  test("a file that becomes dirty after the baseline is reported", () => {
    const baseline = captureBaseline(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

    const changes = outOfBandChanges(repo, [], () => false, baseline);
    assert.deepEqual(
      changes.map((c) => c.path),
      [path.join(repo, "README.md")],
    );
  });

  test("without a baseline every dirty path is still reported", () => {
    fs.writeFileSync(path.join(repo, "wip.ts"), "export const wip = 1;\n");
    assert.equal(outOfBandChanges(repo, []).length, 1);
  });
});
