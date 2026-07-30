// Node built-in test runner. Run from the package root with:
//   node --test test/git-flow-helpers.test.mjs
//
// Covers the pure helpers extracted while fixing D7/D8: the production-merge
// warning that every → production PR must carry, and the network-command
// classifier that decides which git timeout applies.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  productionMergeWarning,
  isNetworkGitCommand,
} from "../lib/git-flow.js";

test("productionMergeWarning renders a GitHub alert naming the change kind", () => {
  const warning = productionMergeWarning("hotfix");

  assert.match(warning, /^> \[!WARNING\]$/m);
  assert.match(warning, /merged \*\*after\*\* the hotfix has been deployed/);
  assert.equal(productionMergeWarning("release").includes("release"), true);
});

test("network git subcommands are classified as network", () => {
  for (const command of [
    "fetch origin",
    "push -u origin hotfix/1.0.1",
    "pull origin develop",
    "ls-remote --heads origin",
    "remote get-url origin",
  ]) {
    assert.equal(isNetworkGitCommand(command), true, command);
  }
});

test("local git subcommands are not classified as network", () => {
  for (const command of [
    "status --porcelain -b",
    "merge --no-ff develop",
    "checkout -b release/1.2.0",
    "rev-parse --short HEAD",
    "tag -d 1.2.0",
    "show HEAD:VERSION",
    "diff --name-only --diff-filter=U",
  ]) {
    assert.equal(isNetworkGitCommand(command), false, command);
  }
});

test("classification keys on the subcommand, not a substring match", () => {
  // "push" appears as an argument, not the subcommand.
  assert.equal(isNetworkGitCommand("log --grep=push"), false);
  // Leading whitespace must not defeat classification.
  assert.equal(isNetworkGitCommand("   fetch origin main"), true);
});
