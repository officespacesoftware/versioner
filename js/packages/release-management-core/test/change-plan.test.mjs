// Node built-in test runner. Run from the package root with:
//   node --test test/change-plan.test.mjs
//
// The digest is the whole safety mechanism: it must change whenever anything
// that affects the outcome changes, and stay stable when nothing does.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildChangePlan,
  assertPlanIsCurrent,
  StalePlanError,
  renderChangePlan,
} from "../lib/change-plan.js";

const base = () => ({
  action: "bump_release_candidate",
  targetBranch: "hotfix/4.124.1",
  targetBranchHead: "f5e771b41ba0000000000000000000000000000a",
  currentVersion: "4.124.1-RC.1",
  resultingVersion: "4.124.1-RC.2",
  mutations: [
    { kind: "commit", summary: 'Commit "To version 4.124.1-RC.2"' },
    { kind: "tag", summary: "Create annotated tag 4.124.1-RC.2" },
    { kind: "push", summary: "Push branch and tag to origin" },
  ],
  warnings: [],
});

test("the same inputs produce the same digest", () => {
  assert.equal(buildChangePlan(base()).digest, buildChangePlan(base()).digest);
});

test("a moved branch HEAD invalidates the digest", () => {
  const before = buildChangePlan(base());
  const after = buildChangePlan({
    ...base(),
    targetBranchHead: "0000000000000000000000000000000000000000",
  });

  assert.notEqual(before.digest, after.digest);
});

test("a different resulting version invalidates the digest", () => {
  const before = buildChangePlan(base());
  const after = buildChangePlan({ ...base(), resultingVersion: "4.124.2" });

  assert.notEqual(before.digest, after.digest);
});

test("a changed mutation set invalidates the digest", () => {
  const before = buildChangePlan(base());
  const withRelease = buildChangePlan({
    ...base(),
    mutations: [
      ...base().mutations,
      { kind: "github-release", summary: "Create release 4.124.1-RC.2" },
    ],
  });

  assert.notEqual(before.digest, withRelease.digest);
});

test("mutation order is significant", () => {
  const forward = buildChangePlan(base());
  const reversed = buildChangePlan({
    ...base(),
    mutations: [...base().mutations].reverse(),
  });

  assert.notEqual(forward.digest, reversed.digest);
});

test("a new warning invalidates the digest", () => {
  // Warnings encode remote facts the branch HEAD does not cover — a tag
  // appearing, or a PR that will now be updated rather than created.
  const before = buildChangePlan(base());
  const after = buildChangePlan({
    ...base(),
    warnings: ["Tag 4.124.1-RC.2 already exists on origin; the push will fail"],
  });

  assert.notEqual(before.digest, after.digest);
});

test("a new notice invalidates the digest", () => {
  const before = buildChangePlan(base());
  const after = buildChangePlan({
    ...base(),
    notices: ["PR #7 is already open for b → main; it will be updated"],
  });

  assert.notEqual(before.digest, after.digest);
});

test("the same text as a notice and as a warning digests differently", () => {
  const text = "PR #7 is already open for b → main; it will be updated";

  assert.notEqual(
    buildChangePlan({ ...base(), notices: [text] }).digest,
    buildChangePlan({ ...base(), warnings: [text] }).digest
  );
});

test("warnings default to an empty array", () => {
  const { warnings } = buildChangePlan({
    action: "a",
    targetBranch: "b",
    targetBranchHead: "c",
    currentVersion: "1.0.0-RC.0",
    resultingVersion: "1.0.0",
    mutations: [],
  });

  assert.deepEqual(warnings, []);
});

test("notices default to an empty array", () => {
  const { notices } = buildChangePlan({
    action: "a",
    targetBranch: "b",
    targetBranchHead: "c",
    mutations: [],
  });

  assert.deepEqual(notices, []);
});

test("assertPlanIsCurrent accepts a matching digest", () => {
  const plan = buildChangePlan(base());

  assert.doesNotThrow(() => assertPlanIsCurrent(plan, plan.digest));
});

test("assertPlanIsCurrent rejects a stale digest and carries the fresh plan", () => {
  const plan = buildChangePlan(base());

  assert.throws(
    () => assertPlanIsCurrent(plan, "deadbeef1234"),
    (error) => {
      assert.ok(error instanceof StalePlanError);
      assert.equal(error.plan.digest, plan.digest);
      assert.equal(error.provided, "deadbeef1234");
      assert.match(error.message, /repository changed/i);
      return true;
    }
  );
});

test("the rendered plan states that nothing changed and how to apply", () => {
  const plan = buildChangePlan(base());
  const text = renderChangePlan(plan);

  assert.match(text, /Nothing has been changed/);
  assert.match(text, new RegExp(plan.digest));
  assert.match(text, /4\.124\.1-RC\.1 → 4\.124\.1-RC\.2/);
  assert.match(text, /Create annotated tag 4\.124\.1-RC\.2/);
});

test("an empty plan says so rather than listing nothing", () => {
  const text = renderChangePlan(
    buildChangePlan({ ...base(), mutations: [] })
  );

  assert.match(text, /Would change nothing/);
});

test("a plan with no version transition renders no version line", () => {
  const { currentVersion, resultingVersion, ...noVersion } = base();
  const plan = buildChangePlan({
    ...noVersion,
    action: "downmerge_release_to_main",
  });

  const text = renderChangePlan(plan);

  assert.doesNotMatch(text, /Version:/);
  assert.match(text, /Branch:\s+hotfix\/4\.124\.1/);
  assert.equal(plan.digest, buildChangePlan({ ...noVersion, action: "downmerge_release_to_main" }).digest);
});

test("dropping the version transition changes the digest", () => {
  // Otherwise a plan that bumps a version and one that does not could share a
  // digest, and either could be confirmed with the other's token.
  const { currentVersion, resultingVersion, ...noVersion } = base();

  assert.notEqual(
    buildChangePlan(base()).digest,
    buildChangePlan(noVersion).digest
  );
});

test("warnings are rendered when present", () => {
  const text = renderChangePlan(
    buildChangePlan({ ...base(), warnings: ["Already merged into main"] })
  );

  assert.match(text, /Warnings:/);
  assert.match(text, /Already merged into main/);
});

test("notices are rendered apart from warnings", () => {
  const text = renderChangePlan(
    buildChangePlan({ ...base(), notices: ["PR #7 will be updated"] })
  );

  assert.match(text, /Notes:\n  - PR #7 will be updated/);
  assert.doesNotMatch(text, /Warnings:/);
});

test("the digest is six lowercase hex characters", () => {
  assert.match(buildChangePlan(base()).digest, /^[0-9a-f]{6}$/);
});

test("a digest typed back with surrounding space or in upper case still matches", () => {
  const plan = buildChangePlan(base());

  assert.doesNotThrow(() =>
    assertPlanIsCurrent(plan, `  ${plan.digest.toUpperCase()}\n`)
  );
  assert.throws(
    () => assertPlanIsCurrent(plan, plan.digest.slice(0, 5)),
    StalePlanError
  );
});

test("updating a pull request digests differently from opening one", () => {
  const pr = (operation) => ({
    ...base(),
    mutations: [
      { kind: "pull-request", operation, summary: "update PR #41 (a → b)" },
    ],
  });

  assert.notEqual(
    buildChangePlan(pr(undefined)).digest,
    buildChangePlan(pr("update")).digest
  );
  assert.notEqual(
    buildChangePlan(pr("close")).digest,
    buildChangePlan(pr("delete")).digest
  );
});

test("refs, checks and the review are left out of the digest", () => {
  const plain = buildChangePlan(base());
  const enriched = buildChangePlan({
    ...base(),
    mutations: base().mutations.map((m) => ({ ...m, ref: { name: "x" } })),
    checks: [
      { name: "c", status: "passed", exitCode: 0, seconds: 1, ref: "r", sha: "s" },
    ],
    review: { repoUrl: "https://github.com/acme/widgets" },
    shape: "revert",
  });

  assert.equal(plain.digest, enriched.digest);
});

test("updates are listed with creations and closures with deletions", () => {
  const text = renderChangePlan(
    buildChangePlan({
      ...base(),
      mutations: [
        { kind: "pull-request", operation: "update", summary: "update PR #41" },
        { kind: "pull-request", operation: "close", summary: "close PR #42" },
      ],
    })
  );

  assert.match(
    text,
    /Would create:\n  Pull request: update PR #41\n\nWould delete:\n  Pull request: close PR #42\n/
  );
});
