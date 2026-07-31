// Node built-in test runner. Run from the package root with:
//   node --test test/list-versions.test.mjs
//
// listVersions is what a human reads before choosing a branch to act on, and
// findLatestRCBranch resolves versions through the same code, so a wrong answer here
// is not merely cosmetic. Two failure modes are covered, both observed against a
// real repository:
//
//   - a branch that exists only on origin has no local ref, so reading VERSION from
//     the local name fails and the branch silently reports no version at all
//   - a local ref left behind at an old release reports a stale version, which made
//     long-released branches look like available release candidates

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";

let repo;
let origin;
let listing;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const version = (v) => `${v}\nabc1234def56\n`;

const entryFor = (branch) => {
  const entry = listing.entries.find((e) => e.branch === branch);
  assert.ok(entry, `no listing entry for ${branch}`);
  return entry;
};

before(async () => {
  origin = mkdtempSync(join(tmpdir(), "list-versions-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "list-versions-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.0.0"), "To version 1.0.0");

  // Holds a release candidate and is checked out at the end: the ordinary case.
  git("checkout", "-q", "-b", "release/1.2.0");
  commit("VERSION", version("1.2.0-RC.3"), "To version 1.2.0-RC.3");

  // Released, then merged into main. The local ref is rewound to the RC below, so
  // origin and local disagree.
  git("checkout", "-q", "-b", "release/1.1.0", "main");
  commit("VERSION", version("1.1.0-RC.1"), "To version 1.1.0-RC.1");
  const staleLocalHead = git("rev-parse", "HEAD");
  commit("VERSION", version("1.1.0"), "To version 1.1.0");

  // Exists only on origin: pushed, then deleted locally.
  git("checkout", "-q", "-b", "hotfix/1.0.1", "main");
  commit("VERSION", version("1.0.1-RC.0"), "To version 1.0.1-RC.0");

  // A branch with no VERSION file at all — as branches predating the convention
  // are — to prove "unknown" is not reported as "final".
  git("checkout", "-q", "-b", "release/9.9.0", "main");
  git("rm", "-q", "VERSION");
  commit("notes.txt", "no version here\n", "branch without a VERSION");

  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Release 1.1.0 to main", "release/1.1.0");

  git(
    "push",
    "-q",
    "origin",
    "main",
    "release/1.2.0",
    "release/1.1.0",
    "hotfix/1.0.1",
    "release/9.9.0"
  );

  // Now diverge the local refs from what origin holds.
  git("branch", "-q", "-D", "hotfix/1.0.1");
  git("branch", "-q", "-f", "release/1.1.0", staleLocalHead);

  git("checkout", "-q", "release/1.2.0");

  const gfm = new GitFlowManager(repo);
  listing = await gfm.listVersions("main");
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

test("a branch that exists only on origin still reports its version", () => {
  const entry = entryFor("hotfix/1.0.1");
  assert.equal(entry.version, "1.0.1-RC.0");
  assert.equal(entry.kind, "rc");
});

test("a branch with no readable VERSION is unknown, not final", () => {
  const entry = entryFor("release/9.9.0");
  assert.equal(entry.version, null);
  assert.equal(entry.kind, "unknown");
});

test("origin wins over a stale local ref, and the staleness is reported", () => {
  const entry = entryFor("release/1.1.0");
  assert.equal(entry.version, "1.1.0");
  assert.equal(entry.kind, "final");
  assert.equal(entry.staleLocal, true);
});

test("a branch whose local ref agrees with origin is not marked stale", () => {
  const entry = entryFor("release/1.2.0");
  assert.equal(entry.version, "1.2.0-RC.3");
  assert.equal(entry.kind, "rc");
  assert.equal(entry.staleLocal, false);
  assert.equal(entry.isCurrentBranch, true);
});

test("merge status is resolved for a branch with no local ref", () => {
  // hotfix/1.0.1 was never merged; asking git about a nonexistent local ref would
  // error and be swallowed, which looks identical to "not merged".
  assert.equal(entryFor("hotfix/1.0.1").mergedIntoProduction, false);
  assert.equal(entryFor("release/1.1.0").mergedIntoProduction, true);
  assert.equal(entryFor("release/1.2.0").mergedIntoProduction, false);
});

test("only genuine release candidates count as candidates", () => {
  const candidates = listing.entries
    .filter((e) => e.kind === "rc")
    .map((e) => e.branch)
    .sort();
  assert.deepEqual(candidates, ["hotfix/1.0.1", "release/1.2.0"]);
});
