// Node built-in test runner. Run from the package root with:
//   node --test test/version-bump-plans.test.mjs
//
// planIncrementRC and planReleaseVersion describe a version bump on an existing
// branch. A release candidate integrates back into its own base, so the pull
// request a plan promises depends on the branch type.
//
// GitFlowManager is faked wholesale — ReleaseAgent already takes it by constructor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReleaseAgent, BranchSelectionError } from "../lib/release-agent.js";

const WD = "/tmp/version-bump-plans-test";

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
 * @param branches map of branch name -> VERSION file contents
 * @param overrides read-only primitives whose defaults a test wants to change
 */
function makeAgent(branches, overrides = {}) {
  const all = Object.keys(branches).map(branchInfo);

  const fakeGfm = {
    getStatus: async () => ({ currentBranch: "develop" }),
    detectBranchType: (name) =>
      /^(release|hotfix)\//.test(name) ? name.split("/")[0] : null,
    findBranchesOfType: async (type) => all.filter((b) => b.type === type),
    readBranchVersion: async (branch) =>
      branches[branch]?.split("\n")[0]?.trim() ?? null,
    getBranchHead: async () => "f5e771b41ba0000000000000000000000000000a",
    tagExistsLocally: async () => false,
    tagExistsRemotely: async () => false,
    findOpenPullRequest: async () => null,
    commitsNotIn: async () => [],
    filesChangedSinceFork: async () => [],
    previewMergeConflicts: async () => ({
      hasConflicts: false,
      conflictedFiles: [],
    }),
    ...overrides,
  };

  return new ReleaseAgent(fakeGfm, WD);
}

const pullRequest = (plan) =>
  plan.mutations.find((m) => m.kind === "pull-request").summary;

test("a release candidate on a release branch integrates into develop", async () => {
  const agent = makeAgent({ "release/1.4.0": "1.4.0-RC.2\nabc1234" });

  const plan = await agent.planIncrementRC("1.4.0");

  assert.equal(plan.currentVersion, "1.4.0-RC.2");
  assert.equal(plan.resultingVersion, "1.4.0-RC.3");
  assert.match(pullRequest(plan), /release\/1\.4\.0 → develop/);
});

test("a release candidate on a hotfix branch integrates into main", async () => {
  const agent = makeAgent({ "hotfix/1.4.1": "1.4.1-RC.0\nabc1234" });

  const plan = await agent.planIncrementRC("1.4.1");

  assert.equal(plan.resultingVersion, "1.4.1-RC.1");
  assert.match(pullRequest(plan), /hotfix\/1\.4\.1 → main/);
});

test("promoting always targets main, whichever branch type holds the candidate", async () => {
  const agent = makeAgent({ "release/1.4.0": "1.4.0-RC.2\nabc1234" });

  const plan = await agent.planReleaseVersion("1.4.0");

  assert.equal(plan.resultingVersion, "1.4.0");
  assert.match(pullRequest(plan), /release\/1\.4\.0 → main/);
  assert.ok(plan.mutations.some((m) => m.kind === "github-release"));
});

test("an open pull request on the branch's own base is reported as an update", async () => {
  const agent = makeAgent(
    { "hotfix/1.4.1": "1.4.1-RC.0\nabc1234" },
    {
      findOpenPullRequest: async (head, base) =>
        base === "main" ? { number: 42, url: "u", title: "t", body: "" } : null,
    }
  );

  const plan = await agent.planIncrementRC("1.4.1");

  assert.match(pullRequest(plan), /update PR #42/);
  assert.ok(plan.warnings.some((w) => /#42 is already open/.test(w)));
});

// Promotion writes two pull requests: the one into main it opens, and the release
// branch's own develop PR, which used to be left advertising the RC it had just
// stopped being. The plan has to name both, or confirming it approves a write the
// operator was never shown.
test("promoting lists the develop PR as a second update when one is open", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.2\nabc1234" },
    {
      findOpenPullRequest: async (head, base) =>
        base === "develop"
          ? { number: 70, url: "u", title: "RC 1.4.0-RC.2 to develop", body: "" }
          : null,
    }
  );

  const plan = await agent.planReleaseVersion("1.4.0");

  const prs = plan.mutations.filter((m) => m.kind === "pull-request");
  assert.equal(prs.length, 2);
  assert.match(prs[0].summary, /open release\/1\.4\.0 → main/);
  assert.match(prs[1].summary, /update PR #70 \(release\/1\.4\.0 → develop\)/);
});

// The develop PR from the previous RC is usually merged, not still waiting, so
// "none open" is the ordinary case and the plan has to say it will open one.
test("promoting plans to open the develop PR when none is open", async () => {
  const agent = makeAgent({ "release/1.4.0": "1.4.0-RC.2\nabc1234" });

  const plan = await agent.planReleaseVersion("1.4.0");

  const prs = plan.mutations.filter((m) => m.kind === "pull-request");
  assert.equal(prs.length, 2);
  assert.match(prs[0].summary, /open release\/1\.4\.0 → main/);
  assert.match(prs[1].summary, /open release\/1\.4\.0 → develop/);
});

// A hotfix integrates into main, so its own base and the promotion target are the
// same PR. Listing it twice would read as two writes to two places.
test("promoting a hotfix lists one PR, its own base being main", async () => {
  const agent = makeAgent(
    { "hotfix/1.4.1": "1.4.1-RC.0\nabc1234" },
    {
      findOpenPullRequest: async () => ({
        number: 42,
        url: "u",
        title: "t",
        body: "",
      }),
    }
  );

  const plan = await agent.planReleaseVersion("1.4.1");

  const prs = plan.mutations.filter((m) => m.kind === "pull-request");
  assert.equal(prs.length, 1);
  assert.match(prs[0].summary, /update PR #42 \(hotfix\/1\.4\.1 → main\)/);
});

// The expensive failure is the quiet one: no conflict, but main keeps its own side of
// files the release branch never touched, so main ends up with changes the shipped
// artifact does not have. A hotfix landing after the branch was cut is the usual cause.
test("promoting warns when main holds commits the release branch does not", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.2\nabc1234" },
    {
      commitsNotIn: async (head, base) =>
        head.includes("main") ? ["deadbee hotfix: suppress a cron"] : [],
      filesChangedSinceFork: async () => ["config/initializers/sidekiq.rb"],
      getBranchHead: async (b) => (b === "main" ? "mainsha000000" : "branchsha0000"),
    }
  );

  const plan = await agent.planReleaseVersion("1.4.0");

  const warning = plan.warnings.find((w) => /holds 1 commit/.test(w));
  assert.ok(warning, `expected a divergence warning, got: ${plan.warnings}`);
  assert.match(warning, /config\/initializers\/sidekiq\.rb/);
  assert.match(warning, /without reporting a conflict/);
  assert.match(warning, /Merge main into release\/1\.4\.0 first/);
});

test("promoting warns when the merge into main would conflict", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.2\nabc1234" },
    {
      previewMergeConflicts: async () => ({
        hasConflicts: true,
        conflictedFiles: ["VERSION"],
      }),
    }
  );

  const plan = await agent.planReleaseVersion("1.4.0");

  const warning = plan.warnings.find((w) => /conflicts in 1 file/.test(w));
  assert.ok(warning, `expected a conflict warning, got: ${plan.warnings}`);
  assert.match(warning, /VERSION/);
  assert.match(warning, /downmerge_release_to_main will refuse/);
});

// A check that silently did not run reads as a clean bill of health.
test("promoting reports a merge check it could not perform", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.2\nabc1234" },
    {
      previewMergeConflicts: async () => {
        throw new Error("unrelated histories");
      },
    }
  );

  const plan = await agent.planReleaseVersion("1.4.0");

  assert.ok(
    plan.warnings.some((w) => /Could not check whether .* merges cleanly/.test(w)),
    `expected a not-checked warning, got: ${plan.warnings}`
  );
});

test("incrementing an RC does not rehearse the merge into main", async () => {
  const agent = makeAgent(
    { "release/1.4.0": "1.4.0-RC.2\nabc1234" },
    {
      previewMergeConflicts: async () => {
        throw new Error("should not be called for an increment");
      },
    }
  );

  const plan = await agent.planIncrementRC("1.4.0");

  assert.equal(plan.warnings.length, 0);
});

test("planning refuses on a branch that is not holding a release candidate", async () => {
  const agent = makeAgent({ "release/1.4.0": "1.4.0\nabc1234" });

  await assert.rejects(
    () => agent.planIncrementRC("1.4.0"),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /not a release candidate/);
      return true;
    }
  );
});
