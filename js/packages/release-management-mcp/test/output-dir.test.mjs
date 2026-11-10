import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js");
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const withClient = async (env, run) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GH_TOKEN: "output-dir-test-token",
        ...env,
      },
      stderr: "ignore",
    })
  );
  try {
    return await run(async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return {
        text: result.content.map((c) => c.text).join("\n"),
        structured: result.structuredContent,
        isError: result.isError === true,
      };
    });
  } finally {
    await client.close();
  }
};

const NAME = /^\d{8}T\d{9}Z-\d{6}-[a-z_]+\.json$/;

test("writes each call's structuredContent to its own file, in call order", async () => {
  const notARepo = tempDir("mcp-output-not-repo-");
  const out = join(tempDir("mcp-output-"), "nested", "dir");

  const results = await withClient({ RELEASE_MANAGEMENT_OUTPUT_DIR: out }, async (call) => [
    await call("health_check", {}),
    await call("list_versions", { workingDirectory: notARepo }),
    await call("create_release_candidate", {
      workingDirectory: notARepo,
      releaseType: "huge",
    }),
    await call("health_check", {}),
  ]);

  const files = readdirSync(out);
  assert.equal(files.length, 4);
  for (const file of files) assert.match(file, NAME);

  const sorted = [...files].sort();
  assert.deepEqual(
    sorted.map((f) => f.replace(/^.*-\d{6}-/, "")),
    [
      "health_check.json",
      "list_versions.json",
      "create_release_candidate.json",
      "health_check.json",
    ]
  );
  assert.deepEqual(
    sorted.map((f) => f.split("-")[1]),
    ["000001", "000002", "000003", "000004"]
  );

  sorted.forEach((file, i) => {
    const written = JSON.parse(readFileSync(join(out, file), "utf8"));
    assert.deepEqual(written, results[i].structured);
    assert.doesNotMatch(results[i].text, /structured output could not be written/);
  });
  assert.equal(results[1].structured.kind, "refused");
  assert.equal(results[2].isError, true);
  assert.equal(results[2].structured.kind, "refused");
});

test("an unwritable directory still returns the result, with a note", async () => {
  const blocker = join(tempDir("mcp-output-blocked-"), "file");
  writeFileSync(blocker, "not a directory\n");
  const out = join(blocker, "out");

  const result = await withClient(
    { RELEASE_MANAGEMENT_OUTPUT_DIR: out },
    (call) => call("health_check", {})
  );

  assert.equal(result.isError, false);
  assert.equal(result.structured.kind, "health");
  assert.match(
    result.text,
    /The structured output could not be written to RELEASE_MANAGEMENT_OUTPUT_DIR: ENOTDIR/
  );
  assert.ok(!result.text.includes("output-dir-test-token"));
});

test("without the variable, the text has no note", async () => {
  const result = await withClient({}, (call) => call("health_check", {}));

  assert.equal(result.structured.kind, "health");
  assert.doesNotMatch(result.text, /structured output/);
});
