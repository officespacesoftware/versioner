// Node built-in test runner. Run from the package root with:
//   node --test test/github-token.test.mjs
//
// GH_TOKEN set but empty used to hide GITHUB_TOKEN: `??` only skips undefined, so
// the empty string won and resolution fell through to `gh auth token`. An empty
// variable is now treated as unset.
//
// Assertions compare tokens without printing them.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearGitHubClientCache, createGitHubClient } from "../lib/github-client.js";

let repo;
let home;
const saved = {};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "token-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
    cwd: repo,
  });
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME"]) {
    saved[name] = process.env[name];
  }
  // Only the environment may supply a token here: no gh on PATH (it reads
  // GITHUB_TOKEN itself, which would mask the bug), and no gh hosts file.
  home = mkdtempSync(join(tmpdir(), "token-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(git, join(bin, "git"));
  process.env.PATH = bin;
  process.env.HOME = home;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearGitHubClientCache();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const tokenIs = async (expected) => {
  const client = await createGitHubClient(repo);
  const auth = await client.rest.auth();
  return auth.token === expected;
};

test("an empty GH_TOKEN does not hide GITHUB_TOKEN", async () => {
  process.env.GH_TOKEN = "";
  process.env.GITHUB_TOKEN = "token-from-github-token";

  assert.ok(await tokenIs("token-from-github-token"), "GITHUB_TOKEN was not used");
});

test("a non-empty GH_TOKEN still wins", async () => {
  process.env.GH_TOKEN = "token-from-gh-token";
  process.env.GITHUB_TOKEN = "token-from-github-token";

  assert.ok(await tokenIs("token-from-gh-token"), "GH_TOKEN was not used");
});
