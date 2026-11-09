import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { BranchSelectionError, ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (file, contents, message) => {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const version = (v) => `${v}\nabc1234def56\n`;

const makeAgent = () => {
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async () => null;
  return new ReleaseAgent(gfm, repo);
};

const cutBranch = (branch, from, v) => {
  git("checkout", "-q", "-b", branch, from);
  commit("VERSION", version(v), `To version ${v}`);
  git("push", "-q", "origin", branch);
};

const moveBase = (base, v) => {
  git("checkout", "-q", base);
  commit("VERSION", version(v), `To version ${v}`);
  git("push", "-q", "origin", base);
};

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "stale-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "stale-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  git("checkout", "-q", "-b", "develop");
  git("checkout", "-q", "main");
  git("push", "-q", "origin", "main", "develop");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a release branch behind develop is refused at plan time", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.1");
  moveBase("develop", "1.5.0-RC.0");

  await assert.rejects(makeAgent().planIncrementRC("1.4.0"), {
    name: BranchSelectionError.name,
    message:
      "release/1.4.0 is at 1.4.0-RC.1, behind develop at 1.5.0-RC.0: a newer " +
      "version has already reached develop, so release/1.4.0 is stale and " +
      "increment_release_candidate cannot be planned for it. Promote it with " +
      "release_version or abandon it, or cut a new release candidate with " +
      "create_release_candidate instead.",
  });
});

test("a hotfix branch behind main is refused at plan time", async () => {
  cutBranch("hotfix/1.3.1", "main", "1.3.1-RC.0");
  moveBase("main", "1.4.0");

  await assert.rejects(makeAgent().planIncrementRC("1.3.1"), {
    name: BranchSelectionError.name,
    message:
      "hotfix/1.3.1 is at 1.3.1-RC.0, behind main at 1.4.0: a newer version " +
      "has already reached main, so hotfix/1.3.1 is stale and " +
      "increment_release_candidate cannot be planned for it. Promote it with " +
      "release_version or abandon it, or cut a new hotfix with create_hotfix " +
      "instead.",
  });
});

test("a branch at its base's version is planned", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.0");
  moveBase("develop", "1.4.0");
  cutBranch("hotfix/1.3.1", "main", "1.3.1-RC.2");
  moveBase("main", "1.3.1");

  const release = await makeAgent().planIncrementRC("release/1.4.0");
  const hotfix = await makeAgent().planIncrementRC("hotfix/1.3.1");

  assert.equal(release.resultingVersion, "1.4.0-RC.1");
  assert.equal(hotfix.resultingVersion, "1.3.1-RC.3");
});

test("a branch ahead of its base's version is planned", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.0");
  cutBranch("hotfix/1.3.1", "main", "1.3.1-RC.0");

  const release = await makeAgent().planIncrementRC("release/1.4.0");
  const hotfix = await makeAgent().planIncrementRC("hotfix/1.3.1");

  assert.equal(release.resultingVersion, "1.4.0-RC.1");
  assert.equal(hotfix.resultingVersion, "1.3.1-RC.1");
});

test("the plan compares with origin's base, not the local one", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.0");
  git("checkout", "-q", "develop");
  commit("VERSION", version("1.5.0-RC.0"), "To version 1.5.0-RC.0");

  const plan = await makeAgent().planIncrementRC("1.4.0");

  assert.equal(plan.resultingVersion, "1.4.0-RC.1");
});

test("a base with no readable VERSION is refused at plan time", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.0");
  git("checkout", "-q", "develop");
  git("rm", "-q", "VERSION");
  git("commit", "-q", "-m", "Drop VERSION");
  git("push", "-q", "origin", "develop");

  await assert.rejects(makeAgent().planIncrementRC("1.4.0"), {
    name: BranchSelectionError.name,
    message:
      "Could not compare release/1.4.0 with develop's version (Could not " +
      "read version from develop branch VERSION file), so " +
      "increment_release_candidate cannot be planned. Check that " +
      "origin/develop has a readable VERSION file.",
  });
});

test("the apply still refuses a stale branch without a plan", async () => {
  cutBranch("release/1.4.0", "develop", "1.4.0-RC.1");
  moveBase("develop", "1.5.0-RC.0");

  await assert.rejects(
    makeAgent().executeIncrementRCWorkflow(repo, "1.4.0", true),
    {
      message:
        "release/1.4.0 version 1.4.0-RC.1 is behind develop version " +
        "1.5.0-RC.0. Cannot proceed with increment.",
    }
  );
});
