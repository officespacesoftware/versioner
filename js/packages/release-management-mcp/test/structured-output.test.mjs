import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js");

let client;
const dirs = [];

const env = () => {
  const vars = { ...process.env, GH_TOKEN: "structured-output-test-token" };
  for (const key of Object.keys(vars)) {
    if (key.startsWith("GITHUB_APP_")) delete vars[key];
  }
  return vars;
};

const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const origin = tempDir("mcp-structured-origin-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repo = tempDir("mcp-structured-repo-");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (file, contents, message) => {
    writeFileSync(join(repo, file), contents);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  const bump = (v) => {
    commit("VERSION", `${v}\nabc1234def56\n`, `To version ${v}`);
    git("tag", v, "-a", "-m", `Release version ${v}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);
  bump("1.3.0");
  commit("app.txt", "base\n", "Add app");
  git("checkout", "-q", "-b", "develop");
  git("push", "-q", "origin", "main", "develop", "1.3.0");
  return { repo, git, commit, bump };
};

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return {
    text: result.content.map((c) => c.text).join("\n"),
    structured: result.structuredContent,
    isError: result.isError === true,
  };
};

before(async () => {
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      stderr: "ignore",
      env: env(),
    })
  );
});

after(async () => {
  await client?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("every tool declares an object output schema", async () => {
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "create_hotfix",
      "create_release_candidate",
      "downmerge",
      "health_check",
      "increment_release_candidate",
      "initialize_versioner",
      "list_versions",
      "release_version",
      "revert_version",
    ]
  );
  for (const tool of tools) {
    assert.equal(tool.outputSchema?.type, "object", tool.name);
    assert.ok(Array.isArray(tool.outputSchema.oneOf), tool.name);
  }
});

test("health_check returns the status it prints", async () => {
  const { text, structured } = await call("health_check", {});

  assert.equal(structured.kind, "health");
  assert.equal(structured.tool, "health_check");
  const printed = JSON.parse(text);
  assert.deepEqual({ ...structured, kind: undefined, tool: undefined }, {
    ...printed,
    kind: undefined,
    tool: undefined,
  });
  assert.equal(structured.auth.source, "GH_TOKEN");
});

test("list_versions returns the rows it prints", async () => {
  const { repo, git, commit, bump } = makeRepo();
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
  git("checkout", "-q", "-b", "hotfix/1.3.1", "main");
  bump("1.3.1");
  git("push", "-q", "origin", "hotfix/1.3.1");
  git("checkout", "-q", "release/1.4.0");
  commit("note.txt", "x\n", "Unpushed note");

  const { text, structured } = await call("list_versions", { workingDirectory: repo });

  assert.equal(structured.kind, "versions");
  assert.equal(structured.currentBranch, "release/1.4.0");
  assert.equal(structured.productionBranch, "main");
  assert.equal(structured.candidates, 1);
  const row = (branch) => {
    const { branch: _b, type: _t, staleLocal: _s, ...rest } = structured.entries.find(
      (e) => e.branch === branch
    );
    return rest;
  };
  assert.deepEqual(row("release/1.4.0"), {
    version: "1.4.0-RC.1",
    kind: "rc",
    current: true,
    tag: "remote",
    mergedIntoProduction: false,
  });
  assert.deepEqual(row("hotfix/1.3.1"), {
    version: "1.3.1",
    kind: "final",
    current: false,
    tag: "local-only",
    mergedIntoProduction: false,
  });
  for (const entry of structured.entries) {
    assert.match(text, new RegExp(`${entry.branch}  ${entry.version.replace(/\./g, "\\.")}`));
  }
});

test("list_versions with no branches returns an empty list", async () => {
  const { repo } = makeRepo();

  const { structured } = await call("list_versions", { workingDirectory: repo });

  assert.deepEqual(structured.entries, []);
  assert.equal(structured.candidates, 0);
});

test("a directory that is not a repository is a refusal with its code", async () => {
  const dir = tempDir("mcp-structured-plain-");

  const { text, structured } = await call("list_versions", { workingDirectory: dir });

  assert.match(text, /❌ List Versions Failed/);
  assert.deepEqual(structured, {
    kind: "refused",
    tool: "list_versions",
    code: "G1",
    text: `Directory '${dir}' is not a Git repository`,
  });
});

test("initialize_versioner returns the version it created, or its refusal", async () => {
  const { repo, git } = makeRepo();
  git("rm", "-q", "VERSION");
  git("commit", "-q", "-m", "Drop VERSION");

  const bad = await call("initialize_versioner", { workingDirectory: repo, version: "1.0" });
  assert.equal(bad.structured.kind, "refused");
  assert.equal(bad.structured.code, "A34");

  const good = await call("initialize_versioner", { workingDirectory: repo, version: "2.0.0" });
  assert.deepEqual(good.structured, {
    kind: "initialized",
    tool: "initialize_versioner",
    workingDirectory: repo,
    version: "2.0.0",
    isReleaseCandidate: false,
  });

  const again = await call("initialize_versioner", { workingDirectory: repo });
  assert.equal(again.structured.code, "A32");
});

test("a plan refusal carries its catalog code", async () => {
  const { repo, git, bump } = makeRepo();
  bump("1.4.0-RC.0");
  git("push", "-q", "origin", "develop");

  const { text, structured } = await call("create_release_candidate", {
    workingDirectory: repo,
  });

  assert.match(text, /💥 Error: develop is at 1\.4\.0-RC\.0, which is still an active release candidate/);
  assert.equal(structured.kind, "refused");
  assert.equal(structured.tool, "create_release_candidate");
  assert.equal(structured.code, "P4");
  assert.match(structured.text, /^develop is at 1\.4\.0-RC\.0/);
});

test("a selection refusal on release_version carries its code", async () => {
  const { repo } = makeRepo();

  const { structured } = await call("release_version", { workingDirectory: repo });

  assert.equal(structured.kind, "refused");
  assert.equal(structured.code, "S5");
});

test("an invalid input is an error result that still says why", async () => {
  const { repo } = makeRepo();

  const result = await call("create_release_candidate", {
    workingDirectory: repo,
    releaseType: "huge",
  });

  assert.equal(result.isError, true);
  assert.equal(result.structured.kind, "refused");
  assert.equal(result.structured.code, "U5");
});

test("a conflicting downmerge into develop is a manual handoff", async () => {
  const { repo, git, commit, bump } = makeRepo();
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.0");
  commit("app.txt", "release\n", "Change app on the release");
  git("push", "-q", "origin", "release/1.4.0");
  git("checkout", "-q", "develop");
  commit("app.txt", "develop\n", "Change app on develop");
  git("push", "-q", "origin", "develop");

  const { text, structured } = await call("downmerge", {
    workingDirectory: repo,
    source: "release",
    target: "develop",
  });

  assert.equal(structured.kind, "handoff");
  const { handoff } = structured;
  assert.equal(handoff.code, "H1");
  assert.equal(text, `⚠️  ${handoff.text}`);
  assert.equal(handoff.source, "release");
  assert.equal(handoff.target, "develop");
  assert.equal(handoff.sourceBranch, "release/1.4.0");
  assert.equal(handoff.version, "1.4.0");
  assert.deepEqual(handoff.conflictedFiles, ["app.txt"]);
  assert.equal(handoff.resolutionBranch, "release-1.4.0-into-develop-<unix-timestamp>");
  assert.equal(handoff.title, "Release 1.4.0 to develop");
  assert.equal(handoff.requiresDecision, false);
  assert.equal(handoff.steps.length, 3);
  assert.deepEqual(handoff.options, []);
});

test("a conflicting downmerge into main is a decision with its options", async () => {
  const { repo, git, commit, bump } = makeRepo();
  git("checkout", "-q", "-b", "hotfix/1.3.1", "main");
  bump("1.3.1-RC.0");
  commit("app.txt", "hotfix\n", "Fix app on the hotfix");
  git("push", "-q", "origin", "hotfix/1.3.1");
  git("checkout", "-q", "main");
  commit("app.txt", "main\n", "Change app on main");
  git("push", "-q", "origin", "main");

  const { structured } = await call("downmerge", {
    workingDirectory: repo,
    source: "hotfix",
    target: "main",
  });

  const { handoff } = structured;
  assert.equal(handoff.code, "H2");
  assert.equal(handoff.requiresDecision, true);
  assert.deepEqual(
    handoff.options.map((o) => [o.label, o.recommended]),
    [
      ["take main's changes into a new candidate", true],
      ["leave them out of hotfix/1.3.1", false],
    ]
  );
  assert.match(handoff.text, /Option 1, take main's changes into a new candidate \(usually right\): Run create_hotfix/);
  assert.match(handoff.text, /Option 2, leave them out of hotfix\/1\.3\.1: cut hotfix-1\.3\.1-into-main-<unix-timestamp> off origin\/main/);
});

test("a downmerge with nothing to merge is a refusal", async () => {
  const { repo, git } = makeRepo();
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  git("push", "-q", "origin", "release/1.4.0");

  const { structured } = await call("downmerge", {
    workingDirectory: repo,
    source: "release",
    target: "develop",
  });

  assert.equal(structured.kind, "refused");
  assert.equal(structured.code, "P8");
});
