// Node built-in test runner. Run from the package root with:
//   node --test test/plan-is-read-only.test.mjs
//
// Integration test against a real throwaway repository with a real origin. A plan
// is only useful if it is trustworthy, and it is only trustworthy if building one
// cannot move HEAD, switch branches, or touch the working tree. Every builder is
// run against real git and the repository is compared byte for byte afterwards.
//
// findOpenPullRequest is the one call that reaches GitHub rather than git, so it
// is the one thing stubbed out.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent, BranchSelectionError } from "../lib/release-agent.js";
import { ManualDownmergeRequired } from "../lib/manual-downmerge.js";

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

before(() => {
  origin = mkdtempSync(join(tmpdir(), "plan-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "plan-read-only-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("4.124.0"), "To version 4.124.0");

  // develop and release/4.125.0 both rewrite VERSION off the same base, so
  // release → develop conflicts and hands off rather than planning. develop holds a final version,
  // which is what lets a new release candidate be cut from it.
  git("checkout", "-q", "-b", "develop");
  commit("VERSION", version("4.124.1"), "To version 4.124.1");

  git("checkout", "-q", "-b", "release/4.125.0", "main");
  commit("VERSION", version("4.125.0-RC.1"), "To version 4.125.0-RC.1");

  git("checkout", "-q", "-b", "hotfix/4.124.1", "main");
  commit("hotfix.txt", "a fix\n", "the fix");
  commit("VERSION", version("4.124.1-RC.0"), "To version 4.124.1-RC.0");

  // main moves last, so it is nobody's ancestor and main → develop is a real merge.
  git("checkout", "-q", "main");
  commit("notes.txt", "shipped\n", "production note");

  git("push", "-q", "origin", "main", "develop", "release/4.125.0", "hotfix/4.124.1");
  git("checkout", "-q", "develop");
});

after(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Everything a plan must leave exactly as it found it. */
const snapshot = () => ({
  head: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  status: git("status", "--porcelain"),
  refs: git("show-ref"),
  index: git("write-tree"),
});

function makeAgent() {
  const gfm = new GitFlowManager(repo);
  // The only GitHub call a plan makes; everything else is git.
  gfm.findOpenPullRequest = async () => null;
  return new ReleaseAgent(gfm, repo);
}

// A conflicting downmerge throws its handoff instead of returning a plan. The
// handoff is built by the same preview, so it is held to the same guarantee.
const planOrHandoff = (building) =>
  building.catch((error) => {
    if (error instanceof ManualDownmergeRequired) return error.handoff;
    throw error;
  });

// A plan that could only fail is refused instead. The refusal comes from the same
// read-only inspection, so it too must leave the repository untouched.
const planOrRefusal = (building) =>
  building.catch((error) => {
    if (error instanceof BranchSelectionError) return { refused: error.message };
    throw error;
  });

const buildEveryPlan = async (agent) => [
  await planOrRefusal(agent.planCreateReleaseCandidate("minor")),
  await planOrRefusal(agent.planCreateHotfix()),
  await agent.planDownmergeMainToDevelop(),
  await planOrHandoff(agent.planDownmergeReleaseToDevelop()),
  await agent.planDownmergeReleaseToMain(),
  await planOrHandoff(agent.planDownmergeHotfixToDevelop()),
  await agent.planDownmergeHotfixToMain(),
  // Reverting is the one plan whose apply deletes refs, so its read-only
  // guarantee is the one most worth pinning. Named explicitly because revert
  // refuses to auto-select a branch.
  await agent.planRevertVersion("4.125.0"),
];

test("building every plan leaves the repository untouched", async () => {
  const before = snapshot();

  await buildEveryPlan(makeAgent());

  assert.deepEqual(snapshot(), before);
});

test("every plan is built from the real repository, not from defaults", async () => {
  const [
    rc,
    hotfix,
    mainToDevelop,
    releaseToDevelop,
    releaseToMain,
    hotfixToDevelop,
    hotfixToMain,
  ] = await buildEveryPlan(makeAgent());

  // main holds content develop does not, and release/4.125.0 already exists.
  assert.match(rc.refused, /synchronization check/);
  assert.match(hotfix.refused, /Branch hotfix\/4\.124\.1 already exists/);

  assert.equal(mainToDevelop.targetBranch, "develop");
  assert.match(
    mainToDevelop.mutations[0].summary,
    new RegExp(`merging main at ${git("rev-parse", "origin/main").slice(0, 11)}`)
  );

  // release/4.125.0 and develop both rewrote VERSION, so merge-tree reports it.
  assert.deepEqual(releaseToDevelop.conflictedFiles, ["VERSION"]);
  assert.equal(releaseToDevelop.sourceBranch, "release/4.125.0");

  assert.equal(releaseToMain.targetBranch, "main");

  // The hotfix and develop are on different version lines, so VERSION conflicts.
  assert.deepEqual(hotfixToDevelop.conflictedFiles, ["VERSION"]);
  assert.equal(hotfixToDevelop.resolutionBase, "develop");

  assert.equal(hotfixToMain.targetBranch, "main");
  assert.deepEqual(
    hotfixToMain.mutations.map((m) => m.kind),
    ["pull-request"]
  );
});

test("the same repository state produces the same digests", async () => {
  const first = await buildEveryPlan(makeAgent());
  const second = await buildEveryPlan(makeAgent());

  assert.deepEqual(
    first.map((p) => p.digest ?? p),
    second.map((p) => p.digest ?? p)
  );
});

test("a commit on the source branch invalidates the downmerge digest", async () => {
  const before = await makeAgent().planDownmergeHotfixToMain();

  git("checkout", "-q", "hotfix/4.124.1");
  commit("hotfix.txt", "a better fix\n", "revise the fix");
  git("push", "-q", "origin", "hotfix/4.124.1");
  git("checkout", "-q", "develop");

  const after = await makeAgent().planDownmergeHotfixToMain();

  assert.notEqual(before.digest, after.digest);
});
