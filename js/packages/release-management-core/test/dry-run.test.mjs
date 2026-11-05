// Node built-in test runner. Run from the package root with:
//   node --test test/dry-run.test.mjs
//
// A dry run checks nothing out, so every version it reads has to come from the
// branch it is about, as the plan reads it, and not from whatever happens to be
// checked out. Standing on develop, a dry-run increment of a release branch used
// to fail with "1.3.0 is not a release candidate", and the creation dry runs
// computed their version from the wrong branch.
//
// Driven against a real repository with a real bare origin; GitHub is stubbed and
// must not be called.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const version = (v) => `${v}\nabc1234def56\n`;

function makeAgent() {
  const gfm = new GitFlowManager(repo);
  const refuse = async () => {
    throw new Error("a dry run must not call GitHub");
  };
  gfm.findOpenPullRequest = refuse;
  gfm.findOpenPullRequestsFrom = refuse;
  gfm.createPullRequest = refuse;
  gfm.createGitHubRelease = refuse;
  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = {
    getCurrentVersion: async () => {
      throw new Error("a dry run must not read the working tree's VERSION");
    },
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
  return agent;
}

const snapshot = () => ({
  head: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  refs: git("show-ref"),
  status: git("status", "--porcelain"),
});

const stepMessage = (ctx, n) => ctx.stepProgress.find((s) => s.step === n).message;

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "dry-run-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "dry-run-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  // main is production at 1.2.0; develop has moved on to 1.3.0; a release of
  // 1.4.0 is at RC.1. Each branch holds a different VERSION, so reading the wrong
  // one shows.
  commit("VERSION", version("1.2.0"), "To version 1.2.0");
  git("checkout", "-q", "-b", "develop");
  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  git("checkout", "-q", "-b", "release/1.4.0");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  git("push", "-q", "origin", "main", "develop", "release/1.4.0");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a dry-run increment reads the target branch, not the one checked out", async () => {
  git("checkout", "-q", "develop");
  const before = snapshot();

  const ctx = await makeAgent().executeIncrementRCWorkflow(repo, "1.4.0", true);

  assert.equal(ctx.stepProgress.find((s) => s.step === 4).status, "completed");
  assert.deepEqual(snapshot(), before);
});

test("a dry-run promotion reads the target branch, not the one checked out", async () => {
  git("checkout", "-q", "main");
  const before = snapshot();

  const ctx = await makeAgent().executeReleaseWorkflow(repo, "1.4.0", true);

  assert.match(stepMessage(ctx, 9), /would create GitHub release 1\.4\.0 /);
  assert.equal(ctx.stepProgress.find((s) => s.step === 4).status, "completed");
  assert.deepEqual(snapshot(), before);
});

test("a dry-run release candidate is computed from develop", async () => {
  git("checkout", "-q", "main");
  // release/1.4.0 would block the minor; a major is free.
  const before = snapshot();

  const ctx = await makeAgent().executeRCWorkflow("major", repo, true);

  assert.equal(ctx.currentBranch, "release/2.0.0");
  assert.match(stepMessage(ctx, 4), /2\.0\.0-RC\.0/);
  assert.deepEqual(snapshot(), before);
});

test("a dry-run hotfix is computed from main", async () => {
  git("checkout", "-q", "develop");
  const before = snapshot();

  const ctx = await makeAgent().executeHotfixWorkflow(repo, true);

  assert.equal(ctx.currentBranch, "hotfix/1.2.1");
  assert.match(stepMessage(ctx, 4), /1\.2\.1-RC\.0/);
  assert.deepEqual(snapshot(), before);
});
