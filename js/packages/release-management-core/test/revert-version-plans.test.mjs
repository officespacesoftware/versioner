// Node built-in test runner. Run from the package root with:
//   node --test test/revert-version-plans.test.mjs
//
// planRevertVersion takes one of two shapes and refuses in several situations, and
// the difference between them is destructive: one rewinds a branch, the other
// deletes it. These assertions pin which shape is chosen and that every guard
// refuses rather than proceeding.
//
// GitFlowManager is faked wholesale — ReleaseAgent takes it by constructor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReleaseAgent, BranchSelectionError } from "../lib/release-agent.js";

const WD = "/tmp/revert-version-plans-test";
const HEAD = "f5e771b41ba0000000000000000000000000000a";

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
 * @param branch the branch name under test, assumed checked out
 * @param versions map of ref -> VERSION first line; HEAD and `${HEAD}^` are the
 *        two that matter
 */
function makeAgent(branch, versions, overrides = {}) {
  const fakeGfm = {
    getStatus: async () => ({ currentBranch: branch }),
    detectBranchType: (name) =>
      /^(release|hotfix)\//.test(name) ? name.split("/")[0] : null,
    findBranchesOfType: async (type) =>
      [branchInfo(branch)].filter((b) => b.type === type),
    // Selection asks by branch name; the plan then asks by commit. The branch name
    // resolves to whatever HEAD holds, as it would in a real repository.
    readBranchVersion: async (ref) =>
      ref === branch ? versions[HEAD] ?? null : versions[ref] ?? null,
    getBranchHead: async () => HEAD,
    commitSubject: async () => `To version ${versions[HEAD]}`,
    checkIsAncestor: async () => false,
    tagExistsLocally: async () => true,
    tagExistsRemotely: async () => true,
    getGitHubRelease: async () => null,
    commitsNotIn: async () => [],
    findOpenPullRequest: async () => null,
    ...overrides,
  };

  return new ReleaseAgent(fakeGfm, WD);
}

const kinds = (plan) =>
  plan.mutations.map(
    (m) => `${m.operation ?? "create"}:${m.kind}`
  );

test("an RC above zero rewinds to the previous RC and keeps the branch", async () => {
  const agent = makeAgent("release/1.4.0", {
    [HEAD]: "1.4.0-RC.3",
    [`${HEAD}^`]: "1.4.0-RC.2",
  });

  const plan = await agent.planRevertVersion();

  assert.equal(plan.currentVersion, "1.4.0-RC.3");
  assert.equal(plan.resultingVersion, "1.4.0-RC.2");
  assert.deepEqual(kinds(plan), [
    "create:commit",
    "delete:tag",
    "delete:tag",
    "create:push",
  ]);
  assert.ok(!kinds(plan).includes("delete:branch"));
});

test("a final version rewinds to the release candidate it was promoted from", async () => {
  const agent = makeAgent("release/1.4.0", {
    [HEAD]: "1.4.0",
    [`${HEAD}^`]: "1.4.0-RC.7",
  });

  const plan = await agent.planRevertVersion();

  assert.equal(plan.resultingVersion, "1.4.0-RC.7");
  assert.ok(
    plan.warnings.some((w) => /is a FINAL version/.test(w)),
    "reverting a final should be called out"
  );
});

test("a final version's GitHub release is deleted, and the plan says what that costs", async () => {
  const agent = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0", [`${HEAD}^`]: "1.4.0-RC.7" },
    {
      getGitHubRelease: async () => ({
        id: 99,
        url: "https://github.com/o/r/releases/tag/1.4.0",
        name: "Release 1.4.0",
      }),
    }
  );

  const plan = await agent.planRevertVersion();

  const release = plan.mutations.find((m) => m.kind === "github-release");
  assert.equal(release.operation, "delete");
  assert.match(release.detail.effect, /Latest marker moves/);
  assert.match(release.detail.irreversible, /notes are destroyed/);
});

test("an RC.0 with no predecessor abandons the branch instead of rewinding it", async () => {
  const agent = makeAgent("release/1.5.0", {
    [HEAD]: "1.5.0-RC.0",
    [`${HEAD}^`]: null,
  });

  const plan = await agent.planRevertVersion();

  assert.equal(plan.resultingVersion, undefined);
  assert.deepEqual(kinds(plan), [
    "delete:tag",
    "delete:tag",
    "delete:branch",
  ]);
  // No revert commit and no push: there is nothing to rewind to.
  assert.ok(!kinds(plan).some((k) => k.endsWith(":commit")));
  assert.ok(
    plan.warnings.some((w) => /first version on release\/1\.5\.0/.test(w))
  );
});

test("an RC.0 whose parent carries develop's version still abandons", async () => {
  // The realistic shape: a release branch is cut from develop, so the bump's parent
  // is a develop commit that has a perfectly readable VERSION. "Has a predecessor
  // version" is therefore the wrong test for whether the branch can be rewound —
  // reverting here would leave the branch indistinguishable from develop.
  const agent = makeAgent(
    "release/1.5.0",
    { [HEAD]: "1.5.0-RC.0", [`${HEAD}^`]: "1.3.0" },
    {
      checkIsAncestor: async (ancestor, descendant) =>
        ancestor === `${HEAD}^` && descendant === "origin/develop",
    }
  );

  const plan = await agent.planRevertVersion();

  assert.equal(plan.resultingVersion, undefined);
  assert.ok(kinds(plan).includes("delete:branch"));
  assert.ok(!kinds(plan).some((k) => k.endsWith(":commit")));
});

test("abandoning names a recovery command, since deleting a branch is the least reversible step", async () => {
  const agent = makeAgent("release/1.5.0", {
    [HEAD]: "1.5.0-RC.0",
    [`${HEAD}^`]: null,
  });

  const plan = await agent.planRevertVersion();

  const branch = plan.mutations.find((m) => m.kind === "branch");
  assert.match(branch.detail.recovery, /git branch release\/1\.5\.0 f5e771b41ba/);
});

test("abandoning refuses when the branch holds commits that are not in its base", async () => {
  const agent = makeAgent(
    "release/1.5.0",
    { [HEAD]: "1.5.0-RC.0", [`${HEAD}^`]: null },
    {
      commitsNotIn: async () => [
        "abc1234 Fix the thing",
        "def5678 To version 1.5.0-RC.0",
      ],
    }
  );

  await assert.rejects(
    () => agent.planRevertVersion(),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /would destroy work/);
      assert.match(error.message, /Fix the thing/);
      // One of the two commits is the bump itself, which is not work worth saving.
      assert.match(error.message, /holds 1 commit\(s\)/);
      return true;
    }
  );
});

test("a version already in production is refused outright", async () => {
  const agent = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0", [`${HEAD}^`]: "1.4.0-RC.7" },
    { checkIsAncestor: async () => true }
  );

  await assert.rejects(
    () => agent.planRevertVersion(),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /already in main/);
      assert.match(error.message, /superseded/);
      return true;
    }
  );
});

test("a head that is not the version bump is refused rather than guessed at", async () => {
  const agent = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0-RC.3", [`${HEAD}^`]: "1.4.0-RC.2" },
    { commitSubject: async () => "Fix a typo in the changelog" }
  );

  await assert.rejects(
    () => agent.planRevertVersion(),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /Fix a typo in the changelog/);
      assert.match(error.message, /will not\s+guess/);
      return true;
    }
  );
});

test("it refuses to pick a branch when none is checked out", async () => {
  const agent = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0-RC.3", [`${HEAD}^`]: "1.4.0-RC.2" },
    { getStatus: async () => ({ currentBranch: "develop" }) }
  );

  await assert.rejects(
    () => agent.planRevertVersion(),
    (error) => {
      assert.ok(error instanceof BranchSelectionError);
      assert.match(error.message, /will not pick one for you/);
      assert.match(error.message, /deletes tags and can delete a branch/);
      return true;
    }
  );
});

test("an open pull request is updated on a revert and closed on an abandon", async () => {
  const pr = async () => ({ number: 42, url: "u", title: "t", body: "" });

  const reverting = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0-RC.3", [`${HEAD}^`]: "1.4.0-RC.2" },
    { findOpenPullRequest: pr }
  );
  const revertPlan = await reverting.planRevertVersion();
  const updated = revertPlan.mutations.find((m) => m.kind === "pull-request");
  assert.equal(updated.operation, undefined);
  assert.match(updated.summary, /update PR #42 to 1\.4\.0-RC\.2/);

  const abandoning = makeAgent(
    "release/1.5.0",
    { [HEAD]: "1.5.0-RC.0", [`${HEAD}^`]: null },
    { findOpenPullRequest: pr }
  );
  const abandonPlan = await abandoning.planRevertVersion();
  const closed = abandonPlan.mutations.find((m) => m.kind === "pull-request");
  assert.equal(closed.operation, "delete");
  assert.match(closed.summary, /close PR #42, with a comment/);
});

test("a missing tag is reported rather than planned as a deletion", async () => {
  const agent = makeAgent(
    "release/1.4.0",
    { [HEAD]: "1.4.0-RC.3", [`${HEAD}^`]: "1.4.0-RC.2" },
    {
      tagExistsLocally: async () => false,
      tagExistsRemotely: async () => false,
    }
  );

  const plan = await agent.planRevertVersion();

  assert.ok(!kinds(plan).includes("delete:tag"));
  assert.ok(plan.warnings.some((w) => /No tag 1\.4\.0-RC\.3 exists/.test(w)));
});

test("every plan warns that deleting a tag does not undo a deployment", async () => {
  const agent = makeAgent("release/1.4.0", {
    [HEAD]: "1.4.0-RC.3",
    [`${HEAD}^`]: "1.4.0-RC.2",
  });

  const plan = await agent.planRevertVersion();

  assert.ok(
    plan.warnings.some((w) => /does not undo a build or deployment/.test(w))
  );
});
