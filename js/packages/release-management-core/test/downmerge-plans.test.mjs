// Node built-in test runner. Run from the package root with:
//   node --test test/downmerge-plans.test.mjs
//
// A downmerge creates no version commit, so its plan carries no version
// transition; what it must carry is which branch head is being merged into
// which, and — for release → develop, whose outcome forks on the merge result —
// only the path that would actually be taken.
//
// GitFlowManager is faked wholesale — ReleaseAgent already takes it by constructor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReleaseAgent } from "../lib/release-agent.js";

const WD = "/tmp/downmerge-plans-test";
const HEADS = {
  main: "0c9d8e7f6a50000000000000000000000000000b",
  develop: "f5e771b41ba0000000000000000000000000000a",
  "release/4.125.0": "a1b2c3d4e5f0000000000000000000000000000c",
  "hotfix/4.124.1": "9876543210a0000000000000000000000000000d",
};

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

function makeAgent(overrides = {}) {
  const fakeGfm = {
    getBranchHead: async (branch) => HEADS[branch],
    // Mirrors GitFlowManager.resolveDownmergeBranch: the exact version, or the
    // newest branch of that type.
    resolveDownmergeBranch: async (type, version) => {
      const branches = Object.keys(HEADS)
        .filter((n) => n.startsWith(`${type}/`))
        .map(branchInfo);
      if (version) {
        const match = branches.find((b) => b.version.full === version);
        if (!match) {
          const label = type === "release" ? "Release" : "Hotfix";
          throw new Error(`${label} branch for version ${version} not found`);
        }
        return { branch: match, cleanName: match.name };
      }
      const latest = branches.at(-1);
      if (!latest) throw new Error(`No ${type} branches found`);
      return { branch: latest, cleanName: latest.name };
    },
    describeMainDownmerge: async () => ({
      title: "Release 4.124.0 to develop",
      version: "4.124.0",
    }),
    previewMergeConflicts: async () => ({
      hasConflicts: false,
      conflictedFiles: [],
    }),
    checkIsAncestor: async () => false,
    findOpenPullRequest: async () => null,
    ...overrides,
  };

  return new ReleaseAgent(fakeGfm, WD);
}

const summaries = (plan) => plan.mutations.map((m) => `${m.kind}: ${m.summary}`);
const conflicting = (...files) => ({
  previewMergeConflicts: async () => ({
    hasConflicts: true,
    conflictedFiles: files,
  }),
});

test("main into develop goes through a timestamped merge branch", async () => {
  const plan = await makeAgent().planDownmergeMainToDevelop();

  assert.equal(plan.action, "downmerge_main_to_develop");
  assert.equal(plan.targetBranch, "develop");
  assert.equal(plan.targetBranchHead, HEADS.develop);
  assert.equal(plan.currentVersion, undefined);
  assert.equal(plan.resultingVersion, undefined);
  assert.deepEqual(summaries(plan), [
    "branch: main-into-develop-<unix-timestamp> off develop, merging main at 0c9d8e7f6a5",
    'commit: merge commit "Downmerge main into develop" on main-into-develop-<unix-timestamp>',
    "push: main-into-develop-<unix-timestamp> to origin",
    "pull-request: open main-into-develop-<unix-timestamp> → develop",
  ]);
  assert.equal(
    plan.mutations.at(-1).detail.title,
    "Release 4.124.0 to develop"
  );
});

test("release into main goes through a merge branch, never head=release/*", async () => {
  const plan = await makeAgent().planDownmergeReleaseToMain();

  assert.equal(plan.targetBranch, "main");
  assert.deepEqual(summaries(plan), [
    "branch: release-4.125.0-into-main-<unix-timestamp> off main, merging release/4.125.0 at a1b2c3d4e5f",
    'commit: merge commit "Merge release/4.125.0 into main" on release-4.125.0-into-main-<unix-timestamp>',
    "push: release-4.125.0-into-main-<unix-timestamp> to origin",
    "pull-request: open release-4.125.0-into-main-<unix-timestamp> → main",
  ]);
});

test("a merge-branch downmerge warns that a conflict creates nothing at all", async () => {
  const plan = await makeAgent(
    conflicting("VERSION", "src/app.ts")
  ).planDownmergeReleaseToMain();

  assert.match(plan.warnings[0], /conflicts in 2 file\(s\): VERSION, src\/app\.ts/);
  assert.match(plan.warnings[0], /creates nothing/);
});

test("a source already merged into the base is a warning", async () => {
  const plan = await makeAgent({
    checkIsAncestor: async () => true,
  }).planDownmergeMainToDevelop();

  assert.match(plan.warnings[0], /main is already merged into develop/);
});

test("a clean release into develop is a single direct pull request", async () => {
  const plan = await makeAgent().planDownmergeReleaseToDevelop();

  assert.deepEqual(summaries(plan), [
    "pull-request: open release/4.125.0 at a1b2c3d4e5f → develop",
  ]);
  assert.equal(
    plan.mutations[0].detail.title,
    "Release 4.125.0 to develop"
  );
  assert.deepEqual(plan.warnings, []);
});

test("a conflicting release into develop plans the merge branch and the build trigger", async () => {
  const plan = await makeAgent(
    conflicting("VERSION")
  ).planDownmergeReleaseToDevelop();

  assert.deepEqual(summaries(plan), [
    "branch: release-4.125.0-into-develop-<unix-timestamp> off develop, merging release/4.125.0 at a1b2c3d4e5f",
    'commit: merge commit "Merge release/4.125.0 into develop (conflicts unresolved — needs manual resolution)" on release-4.125.0-into-develop-<unix-timestamp>',
    "push: release-4.125.0-into-develop-<unix-timestamp> to origin",
    "pull-request: open draft release-4.125.0-into-develop-<unix-timestamp> → develop",
    "pull-request: open release/4.125.0 → develop as a transient build trigger, then close it",
  ]);
  assert.equal(plan.mutations[1].detail.files, "VERSION");
  assert.match(plan.warnings[0], /committed with their markers intact/);
});

test("an open pull request on the release branch drops the build trigger", async () => {
  // Opening one would rewrite that PR's title and body through the 422 fallback
  // and then close it.
  const plan = await makeAgent({
    ...conflicting("VERSION"),
    findOpenPullRequest: async () => ({
      number: 77,
      url: "u",
      title: "t",
      body: "",
    }),
  }).planDownmergeReleaseToDevelop();

  assert.ok(
    !summaries(plan).some((s) => s.includes("build trigger")),
    "the build-trigger pull request must not be planned"
  );
  assert.match(plan.warnings.at(-1), /#77 is already open/);
  assert.match(plan.warnings.at(-1), /CI is not re-triggered/);
});

test("a clean release into develop reports an open pull request as an update", async () => {
  const plan = await makeAgent({
    findOpenPullRequest: async () => ({
      number: 12,
      url: "u",
      title: "t",
      body: "",
    }),
  }).planDownmergeReleaseToDevelop();

  assert.deepEqual(summaries(plan), [
    "pull-request: update PR #12 (release/4.125.0 at a1b2c3d4e5f → develop)",
  ]);
});

test("hotfix into main is a pull request and nothing else", async () => {
  const plan = await makeAgent().planDownmergeHotfixToMain();

  assert.equal(plan.targetBranch, "main");
  assert.deepEqual(summaries(plan), [
    "pull-request: open hotfix/4.124.1 at 9876543210a → main",
  ]);
  assert.equal(plan.mutations[0].detail.title, "Release 4.124.1 to main");
});

test("a conflicting hotfix still opens its pull request", async () => {
  // This one is production-critical and GitHub reports the conflict on the PR,
  // so a conflict is information rather than a blocker.
  const plan = await makeAgent(
    conflicting("VERSION")
  ).planDownmergeHotfixToMain();

  assert.deepEqual(summaries(plan), [
    "pull-request: open hotfix/4.124.1 at 9876543210a → main",
  ]);
  assert.match(plan.warnings[0], /The pull request still opens/);
});

test("a moved source branch invalidates the digest even though the base has not moved", async () => {
  const before = await makeAgent().planDownmergeReleaseToMain();
  const after = await makeAgent({
    getBranchHead: async (branch) =>
      branch === "release/4.125.0"
        ? "1111111111100000000000000000000000000000"
        : HEADS[branch],
  }).planDownmergeReleaseToMain();

  assert.equal(before.targetBranchHead, after.targetBranchHead);
  assert.notEqual(before.digest, after.digest);
});

test("an unknown version is refused rather than falling back to the newest branch", async () => {
  await assert.rejects(
    () => makeAgent().planDownmergeReleaseToMain("9.9.9"),
    /Release branch for version 9\.9\.9 not found/
  );
  await assert.rejects(
    () => makeAgent().planDownmergeHotfixToMain("9.9.9"),
    /Hotfix branch for version 9\.9\.9 not found/
  );
});
