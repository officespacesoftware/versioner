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
  // release → develop takes the conflicting path.
  git("checkout", "-q", "-b", "develop");
  commit("VERSION", version("4.124.0-RC.9"), "To version 4.124.0-RC.9");

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

const buildEveryPlan = async (agent) => [
  await agent.planCreateReleaseCandidate("minor"),
  await agent.planCreateHotfix(),
  await agent.planDownmergeMainToDevelop(),
  await agent.planDownmergeReleaseToDevelop(),
  await agent.planDownmergeReleaseToMain(),
  await agent.planDownmergeHotfixToDevelop(),
  await agent.planDownmergeHotfixToMain(),
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

  assert.equal(rc.resultingVersion, "4.125.0-RC.0");
  assert.match(
    rc.warnings.join("\n"),
    /Branch release\/4\.125\.0 already exists/
  );

  assert.equal(hotfix.resultingVersion, "4.124.1-RC.0");
  assert.match(
    hotfix.warnings.join("\n"),
    /Branch hotfix\/4\.124\.1 already exists/
  );

  assert.equal(mainToDevelop.targetBranch, "develop");
  assert.match(
    mainToDevelop.mutations[0].summary,
    new RegExp(`merging main at ${git("rev-parse", "origin/main").slice(0, 11)}`)
  );

  // release/4.125.0 and develop both rewrote VERSION, so merge-tree reports it.
  assert.match(
    releaseToDevelop.warnings.join("\n"),
    /conflicts in 1 file\(s\): VERSION/
  );
  assert.ok(
    releaseToDevelop.mutations.some((m) => m.kind === "branch"),
    "a conflicting release → develop plans a merge branch"
  );

  assert.equal(releaseToMain.targetBranch, "main");

  assert.equal(hotfixToDevelop.targetBranch, "develop");
  assert.deepEqual(
    hotfixToDevelop.mutations.map((m) => m.kind),
    ["branch", "commit", "push", "pull-request"]
  );

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
    first.map((p) => p.digest),
    second.map((p) => p.digest)
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
