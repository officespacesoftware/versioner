// Node built-in test runner. Run from the package root with:
//   node --test test/merge-preview.test.mjs
//
// Integration test against real throwaway repositories: previewMergeConflicts must
// detect conflicts, distinguish an unmergeable ref from a clean merge, and leave
// the repository byte-identical.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";

let repo;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "merge-preview-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");

  commit("shared.txt", "line1\nline2\n", "base");
  git("checkout", "-q", "-b", "conflicting");
  commit("shared.txt", "line1\nfrom-branch\n", "branch edit");
  git("checkout", "-q", "-b", "clean-branch", "main");
  commit("separate.txt", "no overlap\n", "unrelated file");
  git("checkout", "-q", "main");
  commit("shared.txt", "line1\nfrom-main\n", "main edit");
});

after(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

/** Snapshot everything a preview must not disturb. */
const snapshot = () => ({
  head: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  status: git("status", "--porcelain"),
  index: git("write-tree"),
});

test("reports conflicted paths for a genuinely conflicting merge", async () => {
  const gfm = new GitFlowManager(repo);

  const result = await gfm.previewMergeConflicts("main", "conflicting");

  assert.equal(result.hasConflicts, true);
  assert.deepEqual(result.conflictedFiles, ["shared.txt"]);
});

test("reports no conflicts for a mergeable branch", async () => {
  const gfm = new GitFlowManager(repo);

  const result = await gfm.previewMergeConflicts("main", "clean-branch");

  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.conflictedFiles, []);
});

test("throws for an unknown ref rather than reporting a clean merge", async () => {
  // git merge-tree exits 1 for both conflicts and errors; only a real conflict
  // writes a tree OID to stdout. Reporting an unknown ref as "no conflicts" would
  // send callers down the clean-merge path against a repository that cannot merge.
  const gfm = new GitFlowManager(repo);

  await assert.rejects(
    () => gfm.previewMergeConflicts("main", "no-such-branch"),
    (error) => {
      assert.match(error.message, /Could not compare/);
      assert.match(error.message, /no-such-branch/);
      return true;
    }
  );
});

test("leaves the repository untouched", async () => {
  const gfm = new GitFlowManager(repo);
  const before = snapshot();

  await gfm.previewMergeConflicts("main", "conflicting");
  await gfm.previewMergeConflicts("main", "clean-branch");
  await gfm.previewMergeConflicts("conflicting", "main");

  assert.deepEqual(snapshot(), before);
});
