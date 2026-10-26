// Node built-in test runner. Run from the package root with:
//   node --test test/pre-version-checks.test.mjs
//
// Pre-version checks run real commands in a real checkout, so these drive the
// plans against a real repository with a real bare origin. GitHub is the one
// thing stubbed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent } from "../lib/release-agent.js";
import { parsePreVersionConfig } from "../lib/pre-version-checks.js";

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

const config = (checks) => JSON.stringify({ checks }, null, 2);

function makeAgent() {
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async () => null;
  return new ReleaseAgent(gfm, repo);
}

/** A release branch at RC.0 whose tree holds `checks` as its configuration. */
function releaseBranchWithChecks(checks) {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit(".release-management.json", config(checks), "Configure checks");
  commit("VERSION", version("1.4.0-RC.0"), "To version 1.4.0-RC.0");
  git("push", "-q", "origin", "release/1.4.0");
}

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "checks-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "checks-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  git("checkout", "-q", "-b", "develop");
  git("checkout", "-q", "main");
  git("push", "-q", "origin", "main", "develop");
  git("fetch", "-q", "origin");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing check is a warning, with its output after the plan", async () => {
  releaseBranchWithChecks([
    { name: "audit", run: "echo 'crass 1.0.7 is vulnerable'; exit 3" },
  ]);

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Pre-version check "audit" failed on release\/1\.4\.0/);
  assert.match(plan.warnings[0], /exit 3/);
  assert.deepEqual(plan.checkOutput, [
    { name: "audit", output: "crass 1.0.7 is vulnerable" },
  ]);
});

test("output that changes between runs does not change the digest", async () => {
  releaseBranchWithChecks([
    { name: "audit", run: "date +%s%N; echo $RANDOM; exit 1" },
  ]);

  const first = await makeAgent().planIncrementRC("1.4.0");
  const second = await makeAgent().planIncrementRC("1.4.0");

  assert.notEqual(first.checkOutput[0].output, second.checkOutput[0].output);
  assert.equal(first.digest, second.digest);
});

test("a passing check adds nothing to the plan", async () => {
  releaseBranchWithChecks([{ name: "audit", run: "true" }]);

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.checkOutput, []);
});

test("a check runs only for the actions it lists", async () => {
  releaseBranchWithChecks([
    { name: "audit", run: "exit 1", on: ["release_version"] },
  ]);

  const increment = await makeAgent().planIncrementRC("1.4.0");
  const promote = await makeAgent().planReleaseVersion("1.4.0");

  assert.deepEqual(increment.warnings, []);
  assert.ok(promote.warnings.some((w) => /"audit" failed/.test(w)));
});

test("the check runs in a checkout of the commit being versioned", async () => {
  releaseBranchWithChecks([{ name: "marker", run: "test -f marker" }]);
  git("checkout", "-q", "release/1.4.0");
  commit("marker", "only on the release branch\n", "Add marker");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0");
  git("checkout", "-q", "develop");

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.deepEqual(plan.warnings, []);
  // The working directory is left on its own branch, with no checkout behind.
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "develop");
  assert.equal(git("worktree", "list").split("\n").length, 1);
});

test("a check that runs too long is reported as unfinished", async () => {
  releaseBranchWithChecks([
    { name: "slow", run: "sleep 5", timeoutSeconds: 1 },
  ]);

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.match(plan.warnings[0], /"slow" did not finish within 1s/);
});

test("an invalid configuration is a warning, not a silent pass", async () => {
  releaseBranchWithChecks([{ name: "audit" }]);

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.match(plan.warnings[0], /\.release-management\.json .* is not valid/);
  assert.match(plan.warnings[0], /checks\[0\]\.run/);
});

test("a repository without the configuration runs nothing", async () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.0"), "To version 1.4.0-RC.0");
  git("push", "-q", "origin", "release/1.4.0");

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.checkOutput, []);
});

test("creating a release candidate checks develop's head", async () => {
  git("checkout", "-q", "develop");
  commit(
    ".release-management.json",
    config([{ name: "audit", run: "exit 2", on: ["create_release_candidate"] }]),
    "Configure checks"
  );
  git("push", "-q", "origin", "develop");
  git("checkout", "-q", "main");
  git("merge", "-q", "--ff-only", "develop");
  git("push", "-q", "origin", "main");

  const plan = await makeAgent().planCreateReleaseCandidate("minor");

  assert.match(plan.warnings[0], /"audit" failed on develop/);
});

test("the parser defaults a check to every versioning action", () => {
  const [check] = parsePreVersionConfig(
    config([{ name: "audit", run: "bundle exec bundle-audit check" }])
  );

  assert.deepEqual(check.on, [
    "create_release_candidate",
    "increment_release_candidate",
    "release_version",
    "create_hotfix",
  ]);
  assert.equal(check.timeoutSeconds, 300);
});

test("the parser refuses actions it does not know", () => {
  assert.throws(
    () => parsePreVersionConfig(config([{ name: "a", run: "true", on: ["deploy"] }])),
    /checks\[0\]\.on must list actions from/
  );
});
