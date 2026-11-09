import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commandAfterSeparator,
  parseRepository,
} from "../lib/commands/with-github-auth.js";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "release-management"
);

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const FAKE_GITHUB = `
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const method = init.method ?? "GET";
  if (method === "GET" && path === "/repos/owner/repo/installation") {
    return json(200, { id: 77 });
  }
  if (method === "POST" && path === "/app/installations/77/access_tokens") {
    return json(201, {
      token: "ghs_cli_installation",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "write" },
    });
  }
  if (method === "GET" && path === "/app") {
    return json(200, { id: 5, slug: "release-bot" });
  }
  if (method === "GET" && path === "/users/release-bot%5Bbot%5D") {
    return json(200, { id: 4242 });
  }
  return json(404, { message: "Not Found" });
};
`;

const CHILD = `
const { writeFileSync } = require("node:fs");
const picked = {};
for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_VALUE_1",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
]) picked[name] = process.env[name];
writeFileSync(
  process.env.CHILD_OUT,
  JSON.stringify({
    env: picked,
    argv: [...process.execArgv, ...process.argv],
    cwd: process.cwd(),
  })
);
console.log("child ran");
process.exit(Number(process.argv[1] ?? 0));
`;

let scratch;
let out;
let baseEnv;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "with-github-auth-")));
  out = join(scratch, "child.json");
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const git = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  symlinkSync(git, join(bin, "git"));
  writeFileSync(join(scratch, "fake-github.mjs"), FAKE_GITHUB);
  baseEnv = { PATH: bin, HOME: scratch, CHILD_OUT: out };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = (args, { env = {}, cwd = scratch, preload = false } = {}) =>
  spawnSync(
    process.execPath,
    [
      ...(preload ? ["--import", join(scratch, "fake-github.mjs")] : []),
      CLI,
      "with-github-auth",
      ...args,
    ],
    { env: { ...baseEnv, ...env }, cwd, encoding: "utf8" }
  );

const child = (code = 0) => ["--", process.execPath, "-e", CHILD, String(code)];

const childSaw = () => JSON.parse(readFileSync(out, "utf8"));

const noTokenIn = (result, token) => {
  const seen = childSaw();
  assert.ok(!result.stdout.includes(token), "stdout contains the token");
  assert.ok(!result.stderr.includes(token), "stderr contains the token");
  assert.ok(!seen.argv.join(" ").includes(token), "argv contains the token");
};

test("with a token, the command gets it for gh and git and keeps the caller's cwd", () => {
  const result = run(child(), { env: { GITHUB_TOKEN: "personal-token" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "child ran\n");
  const seen = childSaw();
  assert.equal(seen.env.GH_TOKEN, "personal-token");
  assert.equal(seen.env.GITHUB_TOKEN, "personal-token");
  assert.equal(seen.env.GIT_CONFIG_COUNT, "4");
  assert.equal(
    Buffer.from(
      seen.env.GIT_CONFIG_VALUE_1.split("AUTHORIZATION: basic ")[1],
      "base64"
    ).toString(),
    "x-access-token:personal-token"
  );
  assert.equal(seen.env.GIT_AUTHOR_NAME, undefined);
  assert.equal(seen.cwd, scratch);
  noTokenIn(result, "personal-token");
});

test("with an app, the command runs as the bot with a token for origin's repository", () => {
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:owner/repo.git"],
    { cwd: repo }
  );

  const result = run(child(), {
    cwd: repo,
    preload: true,
    env: {
      GH_TOKEN: "personal-token",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: PEM,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const seen = childSaw();
  assert.equal(seen.env.GH_TOKEN, "ghs_cli_installation");
  assert.equal(seen.env.GITHUB_TOKEN, "ghs_cli_installation");
  assert.equal(seen.env.GIT_AUTHOR_NAME, "release-bot[bot]");
  assert.equal(
    seen.env.GIT_COMMITTER_EMAIL,
    "4242+release-bot[bot]@users.noreply.github.com"
  );
  assert.equal(seen.env.GITHUB_APP_ID, undefined);
  assert.equal(seen.env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(seen.cwd, repo);
  noTokenIn(result, "ghs_cli_installation");
  assert.ok(!result.stderr.includes(PEM.split("\n")[1]), "stderr contains the key");
});

test("the command's exit code is passed through, and a signal becomes 128 + its number", () => {
  const env = { GH_TOKEN: "personal-token" };
  assert.equal(run(child(7), { env }).status, 7);

  const killed = run(
    ["--", process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
    { env }
  );
  assert.equal(killed.status, 143);

  const missing = run(["--", join(scratch, "no-such-command")], { env });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /^Error: Could not run '.*no-such-command': /);
});

test("a missing command is a usage error and runs nothing", () => {
  for (const args of [[], ["--"], ["--repo", "owner/repo", "--"]]) {
    const result = run(args, { env: { GH_TOKEN: "personal-token" } });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^Error: with-github-auth needs the command to run after --/
    );
  }
  const unseparated = run([process.execPath, "-e", CHILD], {
    env: { GH_TOKEN: "personal-token" },
  });
  assert.equal(unseparated.status, 1);
  assert.ok(!existsSync(out), "the command ran");
});

test("an unresolvable credential fails before the command runs", () => {
  const none = run(child());
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^Error: No GitHub token available\./);

  const halfApp = run(child(), {
    env: { GH_TOKEN: "personal-token", GITHUB_APP_PRIVATE_KEY: PEM },
  });
  assert.equal(halfApp.status, 2);
  assert.match(halfApp.stderr, /but GITHUB_APP_ID is not/);
  assert.ok(!halfApp.stderr.includes(PEM.split("\n")[1]), "stderr contains the key");

  const badRepo = run(["--repo", "not-a-repo", ...child()], {
    env: { GH_TOKEN: "personal-token" },
  });
  assert.equal(badRepo.status, 1);
  assert.match(badRepo.stderr, /--repo must be owner\/name/);

  assert.ok(!existsSync(out), "the command ran");
});

test("the command is everything after the first -- that follows the subcommand", () => {
  assert.deepEqual(
    commandAfterSeparator([
      "node",
      "cli",
      "--quiet",
      "with-github-auth",
      "--repo",
      "o/r",
      "--",
      "gh",
      "pr",
      "list",
      "--repo",
      "x/y",
      "--",
      "z",
    ]),
    ["gh", "pr", "list", "--repo", "x/y", "--", "z"]
  );
  assert.deepEqual(parseRepository("octo-org/octo-repo"), {
    owner: "octo-org",
    repo: "octo-repo",
  });
  assert.throws(() => parseRepository("octo-org/octo/repo"), /owner\/name/);
});
