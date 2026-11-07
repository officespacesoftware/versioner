import { test } from "node:test";
import assert from "node:assert/strict";

import { describeManualDownmerge } from "@officespacesoftware/release-management-core";
import { renderIncrementResult } from "../lib/render.js";

const route = { source: "release", target: "develop" };

const handoff = (increment) => ({
  ...describeManualDownmerge({
    route,
    sourceBranch: "release/1.4.0",
    version: "1.4.0",
    conflictedFiles: ["deps.lock"],
    pullRequestTitle: "Release 1.4.0 to develop",
  }),
  increment,
});

const render = (result) =>
  renderIncrementResult({
    result: {
      workingDirectory: "/repo",
      currentBranch: "release/1.4.0",
      branchType: "release",
      branchInfo: { name: "release/1.4.0" },
      dryRun: false,
      stepProgress: [],
      targetVersion: { version: "1.4.0-RC.2" },
      ...result,
    },
    workingDirectory: "/repo",
    dryRun: false,
    progressSummary: "✅ Step 7: Create Pull Request",
  });

test("a conflicting increment with no open pull request returns the downmerge handoff", () => {
  const text = render({
    manualDownmerge: handoff({ version: "1.4.0-RC.2" }),
    pipelineTrigger: {
      status: "started",
      message: "Started the pipeline for release/1.4.0: it has no open pull request.",
    },
  });

  assert.match(text, /\n⚠️  Manual downmerge needed: release\/1\.4\.0 → develop\n/);
  assert.match(text, /so no pull request into develop was opened\. Conflicted files:\n  - deps\.lock\n/);
  assert.match(text, /open a pull request into develop titled "Release 1\.4\.0 to develop"/);
  assert.doesNotMatch(text, /🔗/);
  assert.match(text, /🔧 Pipeline: Started the pipeline for release\/1\.4\.0/);
});

test("a conflicting increment with its pull request open shows both", () => {
  const text = render({
    pullRequestUrl: "https://example.invalid/pr/41",
    pullRequestAction: "updated",
    manualDownmerge: handoff({ version: "1.4.0-RC.2", openPullRequest: 41 }),
  });

  assert.match(text, /🔗 Updated PR: https:\/\/example\.invalid\/pr\/41/);
  assert.match(text, /⚠️  Manual downmerge needed: release\/1\.4\.0 → develop/);
  assert.match(text, /PR #41 \(release\/1\.4\.0 → develop\) stays open, but it cannot merge/);
});

test("a clean increment carries no handoff", () => {
  const text = render({
    pullRequestUrl: "https://example.invalid/pr/7",
    pullRequestAction: "created",
  });

  assert.match(text, /🔗 Pull Request: https:\/\/example\.invalid\/pr\/7/);
  assert.doesNotMatch(text, /Manual downmerge needed/);
});
