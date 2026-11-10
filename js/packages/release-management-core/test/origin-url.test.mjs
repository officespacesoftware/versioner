// Node built-in test runner. Run from the package root with:
//   node --test test/origin-url.test.mjs
//
// Hosted agents clone with the credential in the remote URL
// (https://user:token@github.com/owner/repo). The origin parser used to reject
// that form and printed the whole URL, credential included, in G8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearGitHubClientCache,
  createGitHubClient,
  parseGitHubRemoteUrl,
  redactRemoteUrl,
} from "../lib/github-client.js";

const SECRET = "not-a-real-credential-0123456789";

test("parses plain, credentialed, ssh and trailing-slash GitHub remotes", () => {
  const expected = { owner: "octo-org", repo: "octo-repo" };
  for (const url of [
    "https://github.com/octo-org/octo-repo",
    "https://github.com/octo-org/octo-repo.git",
    "https://github.com/octo-org/octo-repo/",
    `https://x-access-token:${SECRET}@github.com/octo-org/octo-repo`,
    `https://${SECRET}@github.com/octo-org/octo-repo.git`,
    "git@github.com:octo-org/octo-repo.git",
    "ssh://git@github.com/octo-org/octo-repo.git",
  ]) {
    assert.deepEqual(parseGitHubRemoteUrl(url), expected, redactRemoteUrl(url));
  }
});

test("rejects remotes on other hosts, even with credentials", () => {
  for (const url of [
    "https://gitlab.com/octo-org/octo-repo.git",
    `https://user:${SECRET}@example.com/octo-org/octo-repo.git`,
    "https://github.com.example.com/octo-org/octo-repo",
  ]) {
    assert.equal(parseGitHubRemoteUrl(url), undefined, redactRemoteUrl(url));
  }
});

test("redaction drops only the credential", () => {
  assert.equal(
    redactRemoteUrl(`https://x-access-token:${SECRET}@github.com/o/r.git`),
    "https://github.com/o/r.git"
  );
  assert.equal(
    redactRemoteUrl("git@github.com:o/r.git"),
    "git@github.com:o/r.git"
  );
});

test("G8 never shows the credential from origin", async () => {
  const repo = mkdtempSync(join(tmpdir(), "origin-url-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      `https://user:${SECRET}@example.com/octo-org/octo-repo.git`,
    ]);
    clearGitHubClientCache();
    const env = { ...process.env };
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH"]) {
      delete process.env[name];
    }
    process.env.GH_TOKEN = "placeholder";
    try {
      await assert.rejects(createGitHubClient(repo), (error) => {
        assert.match(error.message, /Could not parse owner\/repo from origin URL/);
        assert.match(error.message, /https:\/\/example\.com\/octo-org\/octo-repo\.git/);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      });
    } finally {
      process.env = env;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
