// Node built-in test runner. Run from the package root with:
//   node --test test/origin-is-truth.test.mjs
//
// Origin is the source of truth and a clone is disposable. A plan reads origin, so
// an apply that builds on whatever the clone happens to hold can do something other
// than what was approved: a version commit that an earlier run made but never
// pushed turned an approved RC.1 → RC.2 into a pushed RC.3, leaving RC.2 untagged
// on origin.
//
// Driven against a real repository with a real bare origin. GitHub and the
// versioner are stubbed; the versioner stub writes VERSION, commits and tags as the
// real one does, so pushes stay real.

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

function tagVersion(v) {
  git("tag", v, "-a", "-m", `Release version ${v}`);
}

const parseVersion = (v) => {
  const [core, rc] = v.split("-RC.");
  const [major, minor, patch] = core.split(".").map(Number);
  return {
    version: v,
    isReleaseCandidate: rc !== undefined,
    major,
    minor,
    patch,
    rcNumber: rc === undefined ? undefined : Number(rc),
  };
};

function fakeVersioner() {
  const read = () => git("show", "HEAD:VERSION").split("\n")[0].trim();
  const bump = (next) => {
    commit("VERSION", version(next), `To version ${next}`);
    tagVersion(next);
    return parseVersion(next);
  };
  return {
    getCurrentVersion: async () => parseVersion(read()),
    incrementReleaseCandidate: async () => {
      const [core, rc] = read().split("-RC.");
      return bump(`${core}-RC.${Number(rc) + 1}`);
    },
    releaseVersion: async () => bump(read().split("-RC.")[0]),
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
}

function makeAgent() {
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async () => null;
  gfm.findOpenPullRequestsFrom = async () => [];
  gfm.createPullRequest = async (head, base) => ({
    url: `https://example.invalid/pr/${base}`,
    action: "created",
  });
  gfm.createGitHubRelease = async () => ({
    url: "https://example.invalid/release/1",
  });
  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = fakeVersioner();
  return agent;
}

const remoteTags = () =>
  execFileSync("git", ["ls-remote", "--tags", origin], { encoding: "utf8" });

const originVersion = (branch) =>
  execFileSync("git", ["show", `${branch}:VERSION`], {
    cwd: origin,
    encoding: "utf8",
  }).split("\n")[0];

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "truth-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "truth-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  git("checkout", "-q", "-b", "develop");
  git("push", "-q", "origin", "main", "develop");

  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  tagVersion("1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** What an earlier run leaves when it commits and tags, then fails to push. */
function unpushedBump(v) {
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version(v), `To version ${v}`);
  tagVersion(v);
  git("checkout", "-q", "develop");
}

test("an unpushed local version commit does not make the apply skip a version", async () => {
  unpushedBump("1.4.0-RC.2");
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.4.0");
  assert.equal(plan.currentVersion, "1.4.0-RC.1");
  assert.equal(plan.resultingVersion, "1.4.0-RC.2");

  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);

  assert.equal(result.targetVersion.version, "1.4.0-RC.2");
  assert.equal(originVersion("release/1.4.0"), "1.4.0-RC.2");
  assert.match(remoteTags(), /refs\/tags\/1\.4\.0-RC\.2\n/);
  assert.doesNotMatch(remoteTags(), /1\.4\.0-RC\.3/);
  assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "origin/release/1.4.0"));
});

test("the plan warns that the unpushed commits will be dropped", async () => {
  unpushedBump("1.4.0-RC.2");
  const sha = git("rev-parse", "--short=11", "release/1.4.0");

  const plan = await makeAgent().planIncrementRC("1.4.0");

  const warning = plan.warnings.find((w) => w.startsWith("Local release/1.4.0"));
  assert.ok(warning, plan.warnings.join("\n"));
  assert.match(warning, /1 commit\(s\) that origin\/release\/1\.4\.0 does not/);
  assert.match(warning, /To version 1\.4\.0-RC\.2/);
  assert.match(warning, new RegExp(`git branch unpushed/release/1\\.4\\.0 ${sha}`));
});

test("a promotion that failed to push is redone from origin", async () => {
  unpushedBump("1.4.0");
  const agent = makeAgent();

  const plan = await agent.planReleaseVersion("1.4.0");
  assert.equal(plan.currentVersion, "1.4.0-RC.1");

  const result = await agent.executeReleaseWorkflow(repo, "1.4.0", false);

  assert.equal(result.targetVersion.version, "1.4.0");
  assert.equal(originVersion("release/1.4.0"), "1.4.0");
  // One promotion commit on top of RC.1, not a second one on the unpushed first.
  assert.equal(
    git("rev-parse", "origin/release/1.4.0^"),
    git("rev-parse", "1.4.0-RC.1^{commit}")
  );
});

test("a local branch behind origin is fast-forwarded without a warning", async () => {
  // Another clone pushed RC.2; this one never pulled.
  const behind = git("rev-parse", "release/1.4.0");
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version("1.4.0-RC.2"), "To version 1.4.0-RC.2");
  tagVersion("1.4.0-RC.2");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.2");
  git("checkout", "-q", "develop");
  git("branch", "-f", "release/1.4.0", behind);

  const agent = makeAgent();
  const plan = await agent.planIncrementRC("1.4.0");
  assert.equal(plan.resultingVersion, "1.4.0-RC.3");
  assert.ok(!plan.warnings.some((w) => w.startsWith("Local ")));

  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);
  assert.equal(result.targetVersion.version, "1.4.0-RC.3");
  assert.equal(originVersion("release/1.4.0"), "1.4.0-RC.3");
});
