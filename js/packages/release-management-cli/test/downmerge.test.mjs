// Node built-in test runner. Run from the package root with:
//   node --test test/downmerge.test.mjs
//
// What the downmerge text output says about the pull request it superseded, and
// about one an earlier run already opened.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDownmerge } from "../lib/commands/downmerge.js";

const mergeBranch = {
  kind: "merge-branch",
  pullRequestUrl: "https://example.invalid/pr/9",
  mergeBranchName: "release-1.4.0-into-main-1700000000",
  warnings: [],
  notices: [],
};

test("a superseded pull request is reported closed, or not", () => {
  const closed = renderDownmerge({
    ...mergeBranch,
    superseded: { head: "release/1.4.0", base: "main", number: 7, url: "https://example.invalid/pr/7" },
  });
  assert.match(closed, /Closed PR #7 \(release\/1\.4\.0 → main\) as superseded: https:\/\/example\.invalid\/pr\/7/);

  const failed = renderDownmerge({
    ...mergeBranch,
    superseded: { head: "release/1.4.0", base: "main", number: 7, url: "u", error: "GitHub is down" },
  });
  assert.match(failed, /Could not close the superseded PR #7 \(release\/1\.4\.0 → main\): GitHub is down/);
});

test("a pull request an earlier run opened is not reported as new", () => {
  const text = renderDownmerge({ ...mergeBranch, alreadyOpen: true });
  assert.match(text, /already open from an earlier run; nothing new was created/);
});
