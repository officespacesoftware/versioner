// Node built-in test runner. Run from the package root with:
//   node --test test/creation-plans.test.mjs
//
// planCreateReleaseCandidate and planCreateHotfix describe cutting a new branch.
// The version they promise comes from the base branch's VERSION file read at the
// exact commit the plan is anchored to, and every condition that would change the
// outcome — an existing branch, an existing tag, main not merged into develop —
// has to reach the operator as a warning.
//
// GitFlowManager is faked wholesale — ReleaseAgent already takes it by constructor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReleaseAgent, BranchSelectionError } from "../lib/release-agent.js";

const WD = "/tmp/creation-plans-test";
const DEVELOP_HEAD = "f5e771b41ba0000000000000000000000000000a";
const MAIN_HEAD = "0c9d8e7f6a50000000000000000000000000000b";

function branchInfo(name) {
  const [type, version] = name.split("/");
  const [major, minor, patch] = version.split(".").map(Number);
  return {
    name,
    type,
    version: { major, minor, patch, full: version },
    baseBranch: type === "release" ? "develop" : "main",
    targetBranch: type === "release" ? "develop" : "main",
  };
}

/**
 * @param versions map of ref (branch name or sha) -> VERSION first line
 * @param overrides read-only primitives whose defaults a test wants to change
 */
function makeAgent(versions, overrides = {}) {
  const fakeGfm = {
    getBranchHead: async (branch) =>
      branch === "develop" ? DEVELOP_HEAD : MAIN_HEAD,
    readBranchVersion: async (ref) => versions[ref] ?? null,
    findBranchesOfType: async () => [],
    tagExistsLocally: async () => false,
    tagExistsRemotely: async () => false,
    findOpenPullRequest: async () => null,
    // Synchronised: main is already an ancestor of develop.
    checkIsAncestor: async () => true,
    compareBranches: async () => ({
      ahead: 0,
      behind: 0,
      synchronized: true,
      divergent: false,
    }),
    checkContentDiff: async () => false,
    ...overrides,
  };

  return new ReleaseAgent(fakeGfm, WD);
}

const summaries = (plan) => plan.mutations.map((m) => `${m.kind}: ${m.summary}`);

test("a minor release candidate is cut off develop at develop's head", async () => {
  const agent = makeAgent({ [DEVELOP_HEAD]: "4.124.0" });

  const plan = await agent.planCreateReleaseCandidate("minor");

  assert.equal(plan.targetBranch, "develop");
  assert.equal(plan.targetBranchHead, DEVELOP_HEAD);
  assert.equal(plan.currentVersion, "4.124.0");
  assert.equal(plan.resultingVersion, "4.125.0-RC.0");
  assert.deepEqual(summaries(plan), [
    "branch: release/4.125.0 off develop",
    'commit: "To version 4.125.0-RC.0" on release/4.125.0',
    "tag: annotated tag 4.125.0-RC.0",
    "push: release/4.125.0 and tag 4.125.0-RC.0 to origin",
    "pull-request: open release/4.125.0 → develop",
  ]);
  assert.deepEqual(plan.warnings, []);
});

test("major and patch follow the same arithmetic as the workflow", async () => {
  const agent = makeAgent({ [DEVELOP_HEAD]: "4.124.3" });

  assert.equal(
    (await agent.planCreateReleaseCandidate("major")).resultingVersion,
    "5.0.0-RC.0"
  );
  assert.equal(
    (await agent.planCreateReleaseCandidate("patch")).resultingVersion,
    "4.124.4-RC.0"
  );
});

test("planning refuses while the base branch still holds an active candidate", async () => {
  // The versioner refuses to open a candidate while one is active, so a plan that
  // described the transition would promise a change the apply cannot make.
  const agent = makeAgent({ [DEVELOP_HEAD]: "4.124.0-RC.7" });

  await assert.rejects(
    () => agent.planCreateReleaseCandidate("minor"),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /still an active release candidate/);
      assert.match(error.message, /4\.124\.0-RC\.7/);
      return true;
    }
  );

  const hotfixAgent = makeAgent({ [MAIN_HEAD]: "4.124.0-RC.7" });
  await assert.rejects(
    () => hotfixAgent.planCreateHotfix(),
    /still an active release candidate/
  );
});

test("a hotfix is cut off main at the next patch", async () => {
  const agent = makeAgent({ [MAIN_HEAD]: "4.124.0" });

  const plan = await agent.planCreateHotfix();

  assert.equal(plan.targetBranch, "main");
  assert.equal(plan.targetBranchHead, MAIN_HEAD);
  assert.equal(plan.resultingVersion, "4.124.1-RC.0");
  assert.deepEqual(summaries(plan), [
    "branch: hotfix/4.124.1 off main",
    'commit: "To version 4.124.1-RC.0" on hotfix/4.124.1',
    "tag: annotated tag 4.124.1-RC.0",
    "push: hotfix/4.124.1 and tag 4.124.1-RC.0 to origin",
    "pull-request: open hotfix/4.124.1 → main",
    "pull-request: open draft hotfix/4.124.1 → develop",
  ]);
  assert.equal(
    plan.mutations.at(-2).detail.title,
    "RC 4.124.1-RC.0 to main"
  );
  assert.equal(
    plan.mutations.at(-1).detail.title,
    "hotfix 4.124.1 to develop"
  );
  // The draft is unmergeable on arrival and the plan has to say so, or it reads as
  // a second route to production rather than a placeholder.
  assert.match(plan.warnings[0], /opens as a draft holding only a version bump/);
});

test("an open hotfix pull request into main is reconciled, not duplicated", async () => {
  // The same head/base pair increment_release_candidate and release_version use,
  // so a hotfix carries one pull request for its whole life.
  const agent = makeAgent(
    { [MAIN_HEAD]: "4.124.0" },
    {
      findOpenPullRequest: async (head, base) =>
        head === "hotfix/4.124.1" && base === "main"
          ? { number: 31, url: "u", title: "t", body: "" }
          : null,
    }
  );

  const plan = await agent.planCreateHotfix();

  assert.equal(
    plan.mutations.at(-2).summary,
    "update PR #31 (hotfix/4.124.1 → main)"
  );
  assert.match(plan.warnings[0], /#31 is already open/);
});

test("an existing branch of the same name is a warning", async () => {
  const agent = makeAgent(
    { [DEVELOP_HEAD]: "4.124.0" },
    {
      findBranchesOfType: async () => [
        branchInfo("release/4.125.0"),
        branchInfo("release/4.124.0"),
      ],
    }
  );

  const plan = await agent.planCreateReleaseCandidate("minor");

  assert.deepEqual(plan.warnings, [
    "Branch release/4.125.0 already exists; creating it will fail.",
  ]);
});

test("a remote-only branch of the same name is still recognised", async () => {
  const agent = makeAgent(
    { [MAIN_HEAD]: "4.124.0" },
    {
      findBranchesOfType: async () => [
        { ...branchInfo("hotfix/4.124.1"), name: "remotes/origin/hotfix/4.124.1" },
      ],
    }
  );

  const plan = await agent.planCreateHotfix();

  assert.match(plan.warnings[0], /hotfix\/4\.124\.1 already exists/);
});

test("a tag on origin takes precedence over the same tag held only locally", async () => {
  const agent = makeAgent(
    { [DEVELOP_HEAD]: "4.124.0" },
    { tagExistsRemotely: async () => true, tagExistsLocally: async () => true }
  );

  const plan = await agent.planCreateReleaseCandidate("minor");

  assert.deepEqual(plan.warnings, [
    "Tag 4.125.0-RC.0 already exists on origin; pushing it will fail.",
  ]);
});

test("main holding content that develop does not is a warning on the release plan", async () => {
  const agent = makeAgent(
    { [DEVELOP_HEAD]: "4.124.0" },
    {
      checkIsAncestor: async () => false,
      compareBranches: async () => ({
        ahead: 3,
        behind: 0,
        synchronized: false,
        divergent: false,
      }),
      checkContentDiff: async () => true,
    }
  );

  const plan = await agent.planCreateReleaseCandidate("minor");

  assert.match(plan.warnings[0], /3 commit\(s\)/);
  assert.match(plan.warnings[0], /aborts the action/);
});

test("commits on main whose content is already in develop are not a warning", async () => {
  const agent = makeAgent(
    { [DEVELOP_HEAD]: "4.124.0" },
    {
      checkIsAncestor: async () => false,
      compareBranches: async () => ({
        ahead: 2,
        behind: 0,
        synchronized: false,
        divergent: false,
      }),
      checkContentDiff: async () => false,
    }
  );

  assert.deepEqual(
    (await agent.planCreateReleaseCandidate("minor")).warnings,
    []
  );
});

test("the hotfix plan does not consult main/develop synchronization", async () => {
  // A hotfix is cut off main to reach production; whether develop has caught up
  // is irrelevant and must not block it.
  const agent = makeAgent(
    { [MAIN_HEAD]: "4.124.0" },
    {
      checkIsAncestor: async () => {
        throw new Error("synchronization must not be consulted for a hotfix");
      },
    }
  );

  // The throwing stub is what proves the point: reaching it fails the test. The
  // draft placeholder is the only thing a clean hotfix plan warns about.
  const { warnings } = await agent.planCreateHotfix();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /opens as a draft holding only a version bump/);
});

test("planning refuses when the base branch has no readable VERSION", async () => {
  const agent = makeAgent({});

  await assert.rejects(
    () => agent.planCreateHotfix(),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /main has no readable VERSION file/);
      return true;
    }
  );
});

test("planning refuses when the base version is not semantic", async () => {
  const agent = makeAgent({ [DEVELOP_HEAD]: "not-a-version" });

  await assert.rejects(
    () => agent.planCreateReleaseCandidate("minor"),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /not a semantic version/);
      return true;
    }
  );
});
