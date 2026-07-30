// Node built-in test runner. Run from the package root with:
//   node --test test/branch-selection.test.mjs
//
// Covers D1: selectTargetReleaseBranch must resolve versions from each branch's
// VERSION file rather than its name, must prefer the checked-out branch, and must
// refuse to auto-select a different branch when one is checked out.
//
// GitFlowManager is faked wholesale — ReleaseAgent already takes it by constructor.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ReleaseAgent,
  BranchSelectionError,
  predictIncrementedRC,
  predictPromotedVersion,
} from "../lib/release-agent.js";

const WD = "/tmp/branch-selection-test";

/** Build the BranchTypeInfo shape findBranchesOfType returns: version parsed from the NAME. */
function branchInfo(name) {
  const match = name.match(/^(release|hotfix)\/(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`bad test branch name: ${name}`);
  const [, type, major, minor, patch] = match;
  return {
    name,
    type,
    version: {
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
      full: `${major}.${minor}.${patch}`,
    },
    baseBranch: type === "release" ? "develop" : "main",
    targetBranch: type === "release" ? "develop" : "main",
  };
}

/**
 * @param branches map of branch name -> VERSION file contents
 * @param currentBranch what `git status` reports
 */
function makeAgent(branches, currentBranch) {
  const all = Object.keys(branches).map(branchInfo);

  const fakeGfm = {
    getStatus: async () => ({ currentBranch }),
    detectBranchType: (name) => {
      if (/^release\/\d+\.\d+\.\d+$/.test(name)) return "release";
      if (/^hotfix\/\d+\.\d+\.\d+$/.test(name)) return "hotfix";
      return null;
    },
    findBranchesOfType: async (type) => all.filter((b) => b.type === type),
    // Mirrors GitFlowManager.readBranchVersion: first line of VERSION, or null when
    // it is missing or does not look like a version.
    readBranchVersion: async (branch) => {
      const content = branches[branch];
      if (content === undefined) return null;
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      return /^\d+\.\d+\.\d+/.test(firstLine) ? firstLine : null;
    },
  };

  return new ReleaseAgent(fakeGfm, WD);
}

const select = (agent, version) => agent["selectTargetReleaseBranch"](version);

test("prefers the checked-out hotfix over a higher-numbered release branch", async () => {
  // The exact shape of the 2026-07-30 incident: standing on hotfix/0.8.1 while
  // release/0.9.0 exists. Semver alone would pick 0.9.0.
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0-RC.0\nabc1234",
      "hotfix/0.8.1": "0.8.1-RC.0\ndef5678",
    },
    "hotfix/0.8.1"
  );

  const selected = await select(agent);

  assert.equal(selected.name, "hotfix/0.8.1");
  assert.equal(selected.version.full, "0.8.1-RC.0");
});

test("resolves the RC suffix from VERSION, not from the branch name", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.7\nabc1234" },
    "release/1.4.0"
  );

  const selected = await select(agent);

  // parseVersionFromBranch would have yielded a bare "1.4.0" here.
  assert.equal(selected.version.full, "1.4.0-RC.7");
});

test("refuses to auto-select when the checked-out branch is already final", async () => {
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0-RC.0\nabc1234",
      "hotfix/0.8.1": "0.8.1\ndef5678",
    },
    "hotfix/0.8.1"
  );

  await assert.rejects(() => select(agent), (error) => {
    assert.ok(error instanceof BranchSelectionError);
    assert.match(error.message, /not a release candidate/);
    assert.match(error.message, /hotfix\/0\.8\.1/);
    return true;
  });
});

test("refuses when the checked-out branch has no readable VERSION", async () => {
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0-RC.0\nabc1234",
      // hotfix/0.8.1 is listed as a branch but has no VERSION file
    },
    "hotfix/0.8.1"
  );
  // Make the branch discoverable without giving it a VERSION file.
  const orig = agent["gitFlowManager"].findBranchesOfType;
  agent["gitFlowManager"].findBranchesOfType = async (type) =>
    type === "hotfix" ? [branchInfo("hotfix/0.8.1")] : orig(type);

  await assert.rejects(() => select(agent), (error) => {
    assert.ok(error instanceof BranchSelectionError);
    assert.match(error.message, /no readable VERSION file/);
    return true;
  });
});

test("auto-selects the newest RC when not standing on a release/hotfix branch", async () => {
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0-RC.0\nabc1234",
      "hotfix/0.8.1": "0.8.1-RC.0\ndef5678",
    },
    "develop"
  );

  const selected = await select(agent);

  assert.equal(selected.name, "release/0.9.0");
});

test("skips branches whose VERSION is not a release candidate", async () => {
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0\nabc1234",
      "hotfix/0.8.1": "0.8.1-RC.2\ndef5678",
    },
    "develop"
  );

  const selected = await select(agent);

  assert.equal(selected.name, "hotfix/0.8.1");
  assert.equal(selected.version.full, "0.8.1-RC.2");
});

test("an explicit version wins over the checked-out branch", async () => {
  const agent = makeAgent(
    {
      "release/0.9.0": "0.9.0-RC.0\nabc1234",
      "hotfix/0.8.1": "0.8.1-RC.0\ndef5678",
    },
    "hotfix/0.8.1"
  );

  const selected = await select(agent, "0.9.0");

  assert.equal(selected.name, "release/0.9.0");
  assert.equal(selected.version.full, "0.9.0-RC.0");
});

test("rejects an explicit version that matches both a release and a hotfix branch", async () => {
  const agent = makeAgent(
    {
      "release/1.0.0": "1.0.0-RC.0\nabc1234",
      "hotfix/1.0.0": "1.0.0-RC.1\ndef5678",
    },
    "develop"
  );

  await assert.rejects(() => select(agent, "1.0.0"), (error) => {
    assert.ok(error instanceof BranchSelectionError);
    assert.match(error.message, /Ambiguous/);
    return true;
  });
});

test("reports no candidates when nothing is an RC", async () => {
  const agent = makeAgent({ "release/0.9.0": "0.9.0\nabc1234" }, "develop");

  await assert.rejects(() => select(agent), (error) => {
    assert.ok(error instanceof BranchSelectionError);
    assert.match(error.message, /No release candidate branches found/);
    return true;
  });
});

test("predictIncrementedRC bumps the RC number", () => {
  assert.equal(predictIncrementedRC("4.124.1-RC.1"), "4.124.1-RC.2");
  assert.equal(predictIncrementedRC("1.0.0-RC.9"), "1.0.0-RC.10");
  assert.match(predictIncrementedRC("1.0.0"), /not a release candidate/);
});

test("predictPromotedVersion strips the RC suffix", () => {
  assert.equal(predictPromotedVersion("4.124.1-RC.1"), "4.124.1");
  assert.equal(predictPromotedVersion("1.0.0"), "1.0.0");
});
