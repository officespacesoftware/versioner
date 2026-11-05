// Node built-in test runner. Run from the package root with:
//   node --test test/working-directory.test.mjs
//
// The server is one long-lived process serving many calls, each naming its own
// workingDirectory. Anything it caches across calls must not bind a later call to
// an earlier call's repository: initialize_versioner used to keep the versioner
// from its first call, so initializing a second repository wrote VERSION in the
// first one.
//
// Drives the built server over stdio, as an MCP client does.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js");

let client;
const repos = [];

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "mcp-wd-"));
  repos.push(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
  return repo;
}

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return result.content.map((c) => c.text).join("\n");
};

before(async () => {
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [server], stderr: "ignore" })
  );
});

after(async () => {
  await client?.close();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

test("initialize_versioner acts on each call's own workingDirectory", async () => {
  const first = makeRepo();
  const second = makeRepo();

  const one = await call("initialize_versioner", { workingDirectory: first, version: "1.0.0" });
  assert.match(one, /Versioner Initialized Successfully/);
  const two = await call("initialize_versioner", { workingDirectory: second, version: "2.0.0" });
  assert.match(two, /Versioner Initialized Successfully/, two);

  assert.equal(readFileSync(join(first, "VERSION"), "utf8").split("\n")[0], "1.0.0");
  assert.equal(readFileSync(join(second, "VERSION"), "utf8").split("\n")[0], "2.0.0");
});

test("a malformed version writes nothing, so a corrected rerun succeeds", async () => {
  const repo = makeRepo();

  const bad = await call("initialize_versioner", { workingDirectory: repo, version: "1.0" });
  assert.match(bad, /Invalid version format: 1\.0/);
  assert.ok(!existsSync(join(repo, "VERSION")));

  const good = await call("initialize_versioner", { workingDirectory: repo, version: "1.0.0" });
  assert.match(good, /Versioner Initialized Successfully/, good);
});
