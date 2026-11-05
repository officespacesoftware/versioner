// Node built-in test runner. Run from the package root with:
//   node --test test/merge-branch.test.mjs
//
// Integration test against a real throwaway repository with a real origin.
// createMergeBranch is the one place all three merge-branch downmerges push
// from, so it is the one place that has to decide there is something worth
// pushing — and to leave nothing behind when there is not.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager, MergeConflictError } from "../lib/git-flow.js";
import { ManualDownmergeRequired } from "../lib/manual-downmerge.js";

let repo;
let origin;
const created = [];

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "merge-branch-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "merge-branch-"));
  created.push(repo, origin);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", "1.0.0\nabc1234\n", "To version 1.0.0");
  git("checkout", "-q", "-b", "develop");
  git("push", "-q", "origin", "main", "develop");
});

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const remoteBranches = () =>
  git("ls-remote", "--heads", "origin")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("refs/heads/")[1]);

test("pushes a merge branch when the merge produces a commit", async () => {
  git("checkout", "-q", "main");
  commit("shipped.txt", "in production\n", "production change");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "develop");

  const gfm = new GitFlowManager(repo);
  const result = await gfm.createMergeBranch({
    baseBranch: "develop",
    sourceBranch: "main",
    branchName: "main-into-develop-1",
  });

  assert.equal(result.branchName, "main-into-develop-1");
  assert.ok(remoteBranches().includes("main-into-develop-1"));
});

test("refuses without pushing when the source is already merged", async () => {
  // main has not moved, so `merge --no-ff` reports "Already up to date" and
  // creates nothing. Pushing that branch would put an empty branch on origin and
  // GitHub would then refuse the pull request for having no commits.
  const gfm = new GitFlowManager(repo);

  await assert.rejects(
    () =>
      gfm.createMergeBranch({
        baseBranch: "develop",
        sourceBranch: "main",
        branchName: "main-into-develop-2",
      }),
    (error) => {
      assert.match(error.message, /already merged into develop/);
      assert.match(error.message, /Nothing was pushed/);
      return true;
    }
  );

  assert.deepEqual(remoteBranches().sort(), ["develop", "main"]);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "develop");
  assert.equal(git("branch", "--list", "main-into-develop-2"), "");
});

test("a conflicting merge leaves neither a local nor a remote branch", async () => {
  git("checkout", "-q", "main");
  commit("VERSION", "1.0.1\nabc1234\n", "To version 1.0.1");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "develop");
  commit("VERSION", "1.1.0-RC.0\nabc1234\n", "To version 1.1.0-RC.0");
  git("push", "-q", "origin", "develop");

  const gfm = new GitFlowManager(repo);

  await assert.rejects(
    () =>
      gfm.createMergeBranch({
        baseBranch: "develop",
        sourceBranch: "main",
        branchName: "main-into-develop-3",
      }),
    (error) => {
      assert.ok(error instanceof MergeConflictError);
      assert.deepEqual(error.conflictedFiles, ["VERSION"]);
      return true;
    }
  );

  assert.ok(!remoteBranches().includes("main-into-develop-3"));
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "develop");
  assert.equal(git("branch", "--list", "main-into-develop-3"), "");
  assert.equal(git("status", "--porcelain"), "");
});

test("a conflicting downmerge hands off and pushes nothing", async () => {
  git("checkout", "-q", "main");
  commit("VERSION", "1.0.1\nabc1234\n", "To version 1.0.1");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "develop");
  commit("VERSION", "1.1.0-RC.0\nabc1234\n", "To version 1.1.0-RC.0");
  git("push", "-q", "origin", "develop");

  const gfm = new GitFlowManager(repo);

  await assert.rejects(
    () => gfm.downmerge({ source: "main", target: "develop" }),
    (error) => {
      assert.ok(error instanceof ManualDownmergeRequired);
      assert.deepEqual(error.handoff.conflictedFiles, ["VERSION"]);
      assert.equal(error.handoff.resolutionBase, "develop");
      assert.equal(error.handoff.pullRequestTitle, "Release 1.0.1 to develop");
      return true;
    }
  );

  assert.deepEqual(remoteBranches().sort(), ["develop", "main"]);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "develop");
  assert.equal(git("status", "--porcelain"), "");
});

test("main into develop reports its merge branch, like the other merge-branch routes", async () => {
  git("checkout", "-q", "main");
  commit("shipped.txt", "in production\n", "production change");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "develop");

  const gfm = new GitFlowManager(repo);
  gfm.createPullRequest = async () => ({
    url: "https://example.invalid/pr/1",
    action: "created",
  });

  const result = await gfm.downmerge({ source: "main", target: "develop" });

  assert.equal(result.kind, "merge-branch");
  assert.match(result.mergeBranchName, /^main-into-develop-\d+$/);
  assert.equal(result.pullRequestUrl, "https://example.invalid/pr/1");
  assert.ok(remoteBranches().includes(result.mergeBranchName));
});

/** A release branch with a fix, promoted, for release → main. */
function promotedRelease() {
  git("checkout", "-q", "-b", "release/1.1.0", "develop");
  commit("fix.txt", "a fix\n", "the fix");
  commit("VERSION", "1.1.0\nabc1234\n", "To version 1.1.0");
  git("push", "-q", "origin", "release/1.1.0");
  git("checkout", "-q", "develop");
}

function stubGitHub(gfm, { closeFails = false } = {}) {
  const calls = { closed: [] };
  gfm.createPullRequest = async () => ({
    url: "https://example.invalid/pr/merge",
    action: "created",
  });
  gfm.findOpenPullRequest = async (head, base) =>
    head === "release/1.1.0" && base === "main"
      ? { number: 88, url: "https://example.invalid/pr/88", title: "t", body: "" }
      : null;
  gfm.closePullRequest = async (number, opts) => {
    if (closeFails) throw new Error("GitHub is down");
    calls.closed.push({ number, comment: opts.comment });
  };
  return calls;
}

test("release into main closes the promotion's release → main pull request", async () => {
  promotedRelease();
  const gfm = new GitFlowManager(repo);
  const calls = stubGitHub(gfm);

  const result = await gfm.downmerge({ source: "release", target: "main" });

  assert.deepEqual(result.superseded, {
    head: "release/1.1.0",
    base: "main",
    number: 88,
    url: "https://example.invalid/pr/88",
  });
  assert.equal(calls.closed.length, 1);
  assert.match(
    calls.closed[0].comment,
    /^Superseded by https:\/\/example\.invalid\/pr\/merge\./
  );
});

test("a failure closing the superseded pull request is reported, not thrown", async () => {
  promotedRelease();
  const gfm = new GitFlowManager(repo);
  stubGitHub(gfm, { closeFails: true });

  const result = await gfm.downmerge({ source: "release", target: "main" });

  assert.equal(result.kind, "merge-branch");
  assert.equal(result.superseded.number, 88);
  assert.match(result.superseded.error, /GitHub is down/);
});
