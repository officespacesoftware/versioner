// Node built-in test runner. Run from the package root with:
//   node --test test/create-hotfix.test.mjs
//
// create-hotfix opens two pull requests. Its text output used to show only the one
// into main, so the draft into develop, and any failure to open it, reached only
// --json callers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderHotfix } from "../lib/commands/create-hotfix.js";

const base = {
  workingDirectory: "/repo",
  currentBranch: "hotfix/1.3.1",
  dryRun: false,
  stepProgress: [],
  targetVersion: { version: "1.3.1-RC.0" },
  pullRequestUrl: "https://example.invalid/pr/1",
  pullRequestAction: "created",
};

test("the draft pull request into develop is shown in text output", () => {
  const text = renderHotfix({
    ...base,
    trackingPullRequestUrl: "https://example.invalid/pr/2",
    trackingPullRequestAction: "created",
  });

  assert.match(text, /Draft PR to develop: https:\/\/example\.invalid\/pr\/2/);
});

test("a failure to open the draft is shown in text output", () => {
  const text = renderHotfix({ ...base, trackingPullRequestError: "GitHub said no" });

  assert.match(text, /Could not open the develop PR: GitHub said no/);
});
