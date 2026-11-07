import { test } from "node:test";
import assert from "node:assert/strict";

import { describeManualDownmerge } from "@officespacesoftware/release-management-core";
import {
  incrementRCOutputs,
  renderIncrementRC,
} from "../lib/commands/increment-rc.js";

const route = { source: "release", target: "develop" };

const handoff = {
  ...describeManualDownmerge({
    route,
    sourceBranch: "release/1.4.0",
    version: "1.4.0",
    conflictedFiles: ["deps.lock"],
    pullRequestTitle: "Release 1.4.0 to develop",
  }),
  increment: { version: "1.4.0-RC.2" },
};

const base = {
  workingDirectory: "/repo",
  currentBranch: "release/1.4.0",
  branchType: "release",
  branchInfo: { name: "release/1.4.0" },
  dryRun: false,
  stepProgress: [],
  targetVersion: { version: "1.4.0-RC.2" },
};

test("a conflicting increment prints the manual downmerge handoff", () => {
  const text = renderIncrementRC({
    ...base,
    manualDownmerge: handoff,
    pipelineTrigger: {
      status: "started",
      message: "Started the pipeline for release/1.4.0: it has no open pull request.",
    },
  });

  assert.doesNotMatch(text, /Pull Request:/);
  assert.match(text, /\n\nManual downmerge needed: release\/1\.4\.0 → develop\n/);
  assert.match(text, /release-1\.4\.0-into-develop-<unix-timestamp>/);
  assert.match(text, /\n\nPipeline: Started the pipeline for release\/1\.4\.0/);
});

test("the handoff is written to $GITHUB_OUTPUT only when there is one", () => {
  const conflicting = incrementRCOutputs({ ...base, manualDownmerge: handoff });
  assert.match(conflicting.manual_downmerge, /^Manual downmerge needed: release\/1\.4\.0 → develop\n/);
  assert.equal(conflicting.pull_request_url, undefined);

  const clean = incrementRCOutputs({
    ...base,
    pullRequestUrl: "https://example.invalid/pr/1",
    pullRequestAction: "created",
  });
  assert.equal(clean.manual_downmerge, undefined);
  assert.equal(clean.pull_request_action, "created");
});
