import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js");
const cleanup = [];

after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const healthCheck = async (env, args = {}) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stderr: "ignore",
    })
  );
  try {
    const result = await client.callTool({ name: "health_check", arguments: args });
    return JSON.parse(result.content.map((c) => c.text).join("\n"));
  } finally {
    await client.close();
  }
};

test("health_check names the token source without showing the token", async () => {
  const status = await healthCheck({ GH_TOKEN: "personal-token-value" });

  assert.equal(status.status, "healthy");
  assert.deepEqual(status.auth, { source: "GH_TOKEN" });
  assert.ok(!JSON.stringify(status).includes("personal-token-value"));
});

test("health_check reports a GitHub App it cannot use, without the key", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mcp-health-"));
  cleanup.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const status = await healthCheck(
    { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: privateKey, GH_TOKEN: "unused" },
    { workingDirectory: repo }
  );

  assert.equal(status.status, "healthy");
  assert.equal(status.auth.source, "app");
  assert.match(status.auth.error, /origin/);
  assert.ok(!JSON.stringify(status).includes(privateKey.split("\n")[1]));
});
