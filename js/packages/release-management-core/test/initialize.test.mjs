// Node built-in test runner. Run from the package root with:
//   node --test test/initialize.test.mjs
//
// initialize_versioner used to write VERSION before checking the version, so a
// malformed one left an untracked VERSION behind and every rerun was refused with
// "file already exists". Everything that can refuse is now checked first, and a
// failure after writing removes what it created.
//
// Real repositories, the real versioner.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeVersioner } from "../lib/initialize.js";

let repo;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const untouched = () => ({
  head: git("rev-parse", "HEAD"),
  status: git("status", "--porcelain"),
  tags: git("tag", "--list"),
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "initialize-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("a malformed version is refused before anything is written", async () => {
  const before = untouched();

  await assert.rejects(initializeVersioner(repo, "1.0"), {
    message: /Invalid version format: 1\.0\. Expected format: X\.Y\.Z or X\.Y\.Z-RC\.N\. Nothing was written\./,
  });

  assert.ok(!existsSync(join(repo, "VERSION")));
  assert.deepEqual(untouched(), before);

  const created = await initializeVersioner(repo, "1.0.0");
  assert.equal(created.version, "1.0.0");
});

test("an existing tag is refused before anything is written", async () => {
  git("tag", "0.1.0-RC.0");
  const before = untouched();

  await assert.rejects(initializeVersioner(repo), {
    message: /Tag '0\.1\.0-RC\.0' already exists\. Nothing was written\./,
  });

  assert.ok(!existsSync(join(repo, "VERSION")));
  assert.deepEqual(untouched(), before);
});

test("a failure after writing removes what was created", async () => {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho no commits today >&2\nexit 1\n", { mode: 0o755 });
  const before = untouched();

  await assert.rejects(initializeVersioner(repo, "1.0.0"), {
    message: /Everything it created was removed, so it can be run again\./,
  });

  assert.ok(!existsSync(join(repo, "VERSION")));
  assert.deepEqual(untouched(), before);

  rmSync(hook);
  await initializeVersioner(repo, "1.0.0");
  assert.equal(readFileSync(join(repo, "VERSION"), "utf8").split("\n")[0], "1.0.0");
  assert.equal(git("log", "-1", "--format=%s"), "To version 1.0.0");
});

test("each call acts on its own repository", async () => {
  const other = mkdtempSync(join(tmpdir(), "initialize-other-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Initial"], { cwd: other });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: other });
    execFileSync("git", ["config", "user.name", "T"], { cwd: other });

    await initializeVersioner(repo, "1.0.0");
    await initializeVersioner(other, "2.0.0");

    assert.equal(readFileSync(join(repo, "VERSION"), "utf8").split("\n")[0], "1.0.0");
    assert.equal(readFileSync(join(other, "VERSION"), "utf8").split("\n")[0], "2.0.0");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
