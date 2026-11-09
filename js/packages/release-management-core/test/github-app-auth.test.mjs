import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitHubAppAuth,
  TOKEN_REFRESH_MARGIN_MS,
  buildGitCredentialEnv,
  createAppJwt,
  normalizePrivateKey,
  readGitHubAppConfig,
} from "../lib/github-app-auth.js";
import {
  clearGitHubClientCache,
  createGitHubClient,
  describeGitHubAuth,
  githubCommandEnv,
} from "../lib/github-client.js";
import { GitFlowManager } from "../lib/git-flow.js";
import { VersionerAdapter } from "../lib/versioner-adapter.js";

const { privateKey: PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_BODY_LINE = PEM.split("\n")[1];
const ESCAPED_PEM = PEM.trim().replace(/\n/g, "\\n");

const ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GIT_CONFIG_COUNT",
  "PATH",
  "HOME",
  "FAKE_GIT_LOG",
];
const saved = {};
const realFetch = globalThis.fetch;
let scratch;

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  for (const name of ENV_NAMES.slice(0, 6)) delete process.env[name];
  scratch = mkdtempSync(join(tmpdir(), "app-auth-"));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = realFetch;
  clearGitHubClientCache();
  rmSync(scratch, { recursive: true, force: true });
});

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fakeGitHub = ({ now = () => Date.now(), ttlMs = 60 * 60_000, routes = {} } = {}) => {
  const calls = [];
  let minted = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const call = {
      method,
      path,
      authorization: headers.get("authorization"),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const override = routes[`${method} ${path}`];
    if (override) return override(call);
    if (method === "GET" && path === "/repos/owner/repo/installation") {
      return json(200, { id: 77 });
    }
    if (method === "POST" && path === "/app/installations/77/access_tokens") {
      minted += 1;
      return json(201, {
        token: `ghs_installation_${minted}`,
        expires_at: new Date(now() + ttlMs).toISOString(),
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      });
    }
    if (method === "GET" && path === "/app") {
      return json(200, { id: 5, slug: "release-bot" });
    }
    if (method === "GET" && path === "/users/release-bot%5Bbot%5D") {
      return json(200, { id: 4242, login: "release-bot[bot]" });
    }
    return json(200, {});
  };
  return { fetch, calls };
};

const config = () => readGitHubAppConfig({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: PEM });

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("the JWT carries the app ID, is backdated a minute and lives at most nine minutes", () => {
  const nowSeconds = 1_800_000_000;
  const jwt = createAppJwt("12345", config().privateKey, nowSeconds);
  const [header, payload, signature] = jwt.split(".");

  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload);
  assert.equal(claims.iss, 12345);
  assert.equal(claims.iat, nowSeconds - 60);
  assert.ok(claims.exp <= nowSeconds + 9 * 60);
  assert.ok(claims.exp > nowSeconds);
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      PUBLIC_PEM,
      Buffer.from(signature, "base64url")
    ),
    "signature did not verify with the app's public key"
  );
});

test("a client ID is sent as the issuer unchanged", () => {
  const jwt = createAppJwt("Iv23liExample", config().privateKey, 1_800_000_000);
  assert.equal(decode(jwt.split(".")[1]).iss, "Iv23liExample");
});

test("a private key flattened by a secret store is restored", () => {
  const variants = {
    "literal \\n escapes": ESCAPED_PEM,
    "CRLF line endings": PEM.replace(/\n/g, "\r\n"),
    "spaces for newlines": PEM.trim().replace(/\n/g, " "),
    "surrounding quotes": `"${ESCAPED_PEM}"`,
  };
  for (const [name, flattened] of Object.entries(variants)) {
    assert.equal(normalizePrivateKey(flattened), PEM, name);
    assert.ok(
      readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: flattened }),
      name
    );
  }
});

test("app auth is off unless one of its variables is set, and empty counts as unset", () => {
  assert.equal(readGitHubAppConfig({}), undefined);
  assert.equal(
    readGitHubAppConfig({ GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" }),
    undefined
  );
});

test("an incomplete or ambiguous app configuration is refused without echoing the key", () => {
  const cases = [
    [{ GITHUB_APP_ID: "1" }, /GITHUB_APP_ID is set but no private key is/],
    [{ GITHUB_APP_PRIVATE_KEY: PEM }, /GITHUB_APP_ID is not/],
    [
      { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_PRIVATE_KEY_PATH: "/x.pem" },
      /Set only one of them/,
    ],
    [
      {
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETMATERIAL\n-----END RSA PRIVATE KEY-----",
      },
      /GITHUB_APP_PRIVATE_KEY does not hold a valid RSA private key/,
    ],
  ];
  for (const [env, expected] of cases) {
    assert.throws(
      () => readGitHubAppConfig(env),
      (error) =>
        expected.test(error.message) &&
        !error.message.includes(PEM_BODY_LINE) &&
        !error.message.includes("TOPSECRETMATERIAL")
    );
  }
});

test("the key can be read from the file GITHUB_APP_PRIVATE_KEY_PATH names", () => {
  const keyFile = join(scratch, "app.pem");
  writeFileSync(keyFile, PEM);
  assert.ok(readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: keyFile }));
  assert.throws(
    () =>
      readGitHubAppConfig({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY_PATH: join(scratch, "missing.pem"),
      }),
    /Could not read the GitHub App private key file .*ENOENT/
  );
});

test("an installation token is minted once, scoped to the repository, and reused while fresh", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const github = fakeGitHub({ now: () => now });
  const auth = new GitHubAppAuth({
    config: config(),
    owner: "owner",
    repo: "repo",
    fetch: github.fetch,
    now: () => now,
  });

  const [first, concurrent] = await Promise.all([auth.token(), auth.token()]);
  assert.equal(first, "ghs_installation_1");
  assert.equal(concurrent, first);
  assert.deepEqual(
    github.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /repos/owner/repo/installation", "POST /app/installations/77/access_tokens"]
  );
  assert.deepEqual(github.calls[1].body, { repositories: ["repo"] });
  assert.match(github.calls[0].authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  now += 60 * 60_000 - TOKEN_REFRESH_MARGIN_MS - 60_000;
  assert.equal(await auth.token(), "ghs_installation_1");
  assert.equal(github.calls.length, 2);

  now += 2 * 60_000;
  assert.equal(await auth.token(), "ghs_installation_2");
  assert.deepEqual(
    github.calls.slice(2).map((c) => `${c.method} ${c.path}`),
    ["POST /app/installations/77/access_tokens"]
  );
});

test("authentication failures say what is wrong and never contain the JWT, token or key", async () => {
  const cases = [
    {
      route: "GET /repos/owner/repo/installation",
      respond: () => json(404, { message: "Not Found" }),
      expected: /GitHub App 12345 is not installed on owner\/repo \(404\)/,
    },
    {
      route: "GET /repos/owner/repo/installation",
      respond: (call) =>
        json(401, { message: `A JWT could not be decoded: ${call.authorization}` }),
      expected: /rejected the credentials of GitHub App 12345 \(401\)/,
    },
    {
      route: "POST /app/installations/77/access_tokens",
      respond: () =>
        json(403, { message: "Resource not accessible by integration" }, {
          "x-accepted-github-permissions": "contents=write",
        }),
      expected: /refused creating an installation token .*\(403\)\. It needs the permission contents=write/,
    },
  ];

  for (const { route, respond, expected } of cases) {
    const github = fakeGitHub({ routes: { [route]: respond } });
    const auth = new GitHubAppAuth({
      config: config(),
      owner: "owner",
      repo: "repo",
      fetch: github.fetch,
    });
    const error = await auth.token().then(
      () => assert.fail("expected a failure"),
      (e) => e
    );
    assert.match(error.message, expected);
    const jwt = github.calls[0].authorization.replace(/^Bearer /, "");
    assert.ok(!error.message.includes(jwt), "message contains the JWT");
    assert.ok(!error.message.includes(PEM_BODY_LINE), "message contains the key");
    assert.ok(!error.message.includes("ghs_"), "message contains a token");
  }
});

test("the git credential env carries the token as a basic auth header and appends to existing config", () => {
  const env = buildGitCredentialEnv("ghs_secret", { GIT_CONFIG_COUNT: "2" });

  assert.equal(env.GIT_CONFIG_COUNT, "6");
  assert.equal(env.GIT_CONFIG_KEY_2, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_2, "");
  assert.equal(env.GIT_CONFIG_KEY_3, "http.https://github.com/.extraheader");
  const [, scheme, encoded] = env.GIT_CONFIG_VALUE_3.match(/^AUTHORIZATION: (basic) (.+)$/);
  assert.equal(scheme, "basic");
  assert.equal(Buffer.from(encoded, "base64").toString(), "x-access-token:ghs_secret");
  assert.equal(env.GIT_CONFIG_KEY_4, "url.https://github.com/.insteadOf");
  assert.equal(env.GIT_CONFIG_VALUE_4, "git@github.com:");
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
});

const makeRepo = () => {
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
    cwd: repo,
  });
  return repo;
};

const useApp = () => {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = ESCAPED_PEM;
};

test("a GitHub App takes precedence over GH_TOKEN and GITHUB_TOKEN, and every call uses a current token", async () => {
  const repo = makeRepo();
  process.env.GH_TOKEN = "personal-gh-token";
  process.env.GITHUB_TOKEN = "personal-github-token";
  useApp();
  const github = fakeGitHub({ ttlMs: 60_000 });
  globalThis.fetch = github.fetch;

  const client = await createGitHubClient(repo);
  await client.rest.request("GET /repos/{owner}/{repo}", { owner: "owner", repo: "repo" });
  await client.rest.request("GET /repos/{owner}/{repo}", { owner: "owner", repo: "repo" });
  await client.graphql("query { viewer { login } }").catch(() => {});

  const apiCalls = github.calls.filter(
    (c) => c.path === "/repos/owner/repo" || c.path === "/graphql"
  );
  assert.deepEqual(
    apiCalls.map((c) => c.authorization),
    ["token ghs_installation_1", "token ghs_installation_2", "token ghs_installation_3"]
  );
  assert.ok(
    github.calls.every((c) => !String(c.authorization).includes("personal")),
    "a personal token was sent"
  );
});

test("a 403 from the API names the permission the installation lacks", async () => {
  const repo = makeRepo();
  useApp();
  const github = fakeGitHub({
    routes: {
      "GET /repos/owner/repo/pulls": () =>
        json(403, { message: "Resource not accessible by integration" }, {
          "x-accepted-github-permissions": "pull_requests=read",
        }),
    },
  });
  globalThis.fetch = github.fetch;

  const client = await createGitHubClient(repo);
  await assert.rejects(
    client.rest.pulls.list({ owner: "owner", repo: "repo" }),
    (error) =>
      error.status === 403 &&
      /lacks a permission this request needs; GitHub accepts pull_requests=read/.test(
        error.message
      )
  );
});

test("describeGitHubAuth reports the source and the installation's permissions, never a secret", async () => {
  const repo = makeRepo();
  process.env.GH_TOKEN = "personal-gh-token";
  assert.deepEqual(await describeGitHubAuth(repo), { source: "GH_TOKEN" });

  useApp();
  clearGitHubClientCache();
  globalThis.fetch = fakeGitHub().fetch;
  const status = await describeGitHubAuth(repo);
  assert.equal(status.source, "app release-bot");
  assert.equal(status.appId, "12345");
  assert.equal(status.repository, "owner/repo");
  assert.equal(status.installationId, 77);
  assert.deepEqual(status.permissions, {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  });
  assert.ok(!JSON.stringify(status).includes("ghs_"));

  clearGitHubClientCache();
  globalThis.fetch = fakeGitHub({
    routes: { "GET /repos/owner/repo/installation": () => json(404, {}) },
  }).fetch;
  const failed = await describeGitHubAuth(repo);
  assert.equal(failed.source, "app");
  assert.match(failed.error, /not installed on owner\/repo/);
});

const fakeGitOnPath = () => {
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const log = join(scratch, "git.log");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = remote ] && [ "$2" = get-url ]; then echo https://github.com/owner/repo.git; exit 0; fi
{ echo "ARGS $*"; env | grep -E '^GIT_(CONFIG|AUTHOR|COMMITTER)' | sort; echo END; } >> "$FAKE_GIT_LOG"
if [ "$1" = push ]; then
  i=0
  while [ "$i" -lt "\${GIT_CONFIG_COUNT:-0}" ]; do
    eval "echo \\"fatal: header \\$GIT_CONFIG_VALUE_$i\\"" >&2
    i=$((i+1))
  done
  exit 128
fi
exit 0
`
  );
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.FAKE_GIT_LOG = log;
  return () =>
    readFileSync(log, "utf8")
      .split("END\n")
      .filter(Boolean)
      .map((entry) => entry.trim().split("\n"));
};

const header = (lines) => lines.find((line) => line.includes("AUTHORIZATION: basic"));

test("git network commands carry the installation token only when app auth is on", async () => {
  const repo = makeRepo();
  const gitLog = fakeGitOnPath();

  process.env.GH_TOKEN = "personal-gh-token";
  await new GitFlowManager(repo).fetchBranch("develop");
  const [withoutApp] = gitLog();
  assert.equal(withoutApp[0], "ARGS fetch origin develop");
  assert.equal(header(withoutApp), undefined);
  assert.ok(withoutApp.every((line) => !line.startsWith("GIT_AUTHOR")));

  useApp();
  globalThis.fetch = fakeGitHub().fetch;
  const gfm = new GitFlowManager(repo);
  await gfm.fetchBranch("develop");
  await gfm.getCurrentCommit();
  await gfm.createVersionTag("1.0.0", "abc");

  const [, fetched, revParse, tagged] = gitLog();
  const encoded = header(fetched).split("AUTHORIZATION: basic ")[1];
  assert.equal(
    Buffer.from(encoded, "base64").toString(),
    "x-access-token:ghs_installation_1"
  );
  assert.equal(revParse[0], "ARGS rev-parse HEAD");
  assert.equal(header(revParse), undefined);
  assert.match(tagged[0], /^ARGS tag /);
  assert.equal(header(tagged), undefined);
  assert.ok(tagged.includes("GIT_AUTHOR_NAME=release-bot[bot]"));
  assert.ok(tagged.includes("GIT_COMMITTER_NAME=release-bot[bot]"));
  assert.ok(
    tagged.includes("GIT_COMMITTER_EMAIL=4242+release-bot[bot]@users.noreply.github.com")
  );
});

test("a failing git command cannot echo the installation token or its header", async () => {
  const repo = makeRepo();
  fakeGitOnPath();
  useApp();
  globalThis.fetch = fakeGitHub().fetch;

  const encoded = Buffer.from("x-access-token:ghs_installation_1").toString("base64");
  await assert.rejects(new GitFlowManager(repo).pushTag("1.0.0"), (error) => {
    assert.match(error.message, /Git command failed/);
    assert.match(error.message, /\[REDACTED\]/);
    assert.ok(!error.message.includes(encoded), "message contains the header");
    assert.ok(!error.message.includes("ghs_installation_1"), "message contains the token");
    return true;
  });
});

test("versioner commits and tags take the identity the release agent passes, and only while they run", async () => {
  const authorBefore = process.env.GIT_AUTHOR_NAME;
  const committerBefore = process.env.GIT_COMMITTER_EMAIL;
  const repo = join(scratch, "versioned");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Local Person");
  git("config", "user.email", "person@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Initial commit");

  const adapter = new VersionerAdapter();
  await adapter.initialize(undefined, repo, {
    gitEnvironment: async () => ({
      GIT_AUTHOR_NAME: "release-bot[bot]",
      GIT_AUTHOR_EMAIL: "4242+release-bot[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "release-bot[bot]",
      GIT_COMMITTER_EMAIL: "4242+release-bot[bot]@users.noreply.github.com",
    }),
  });
  await adapter.initializeProject("0.1.0-RC.0");
  await adapter.disconnect();

  assert.equal(
    git("log", "-1", "--format=%an <%ae> / %cn <%ce>"),
    "release-bot[bot] <4242+release-bot[bot]@users.noreply.github.com> / " +
      "release-bot[bot] <4242+release-bot[bot]@users.noreply.github.com>"
  );
  assert.equal(
    git("for-each-ref", "--format=%(taggername)", "refs/tags/0.1.0-RC.0"),
    "release-bot[bot]"
  );
  assert.equal(process.env.GIT_AUTHOR_NAME, authorBefore);
  assert.equal(process.env.GIT_COMMITTER_EMAIL, committerBefore);
});

const decodedHeader = (env) => {
  const index = Object.keys(env).find(
    (key) => key.startsWith("GIT_CONFIG_VALUE_") && env[key].startsWith("AUTHORIZATION:")
  );
  const encoded = env[index].split("AUTHORIZATION: basic ")[1];
  return Buffer.from(encoded, "base64").toString();
};

test("with an app, the command env carries a token for the origin's repository and the bot identity, not the key", async () => {
  const repo = makeRepo();
  process.env.GH_TOKEN = "personal-gh-token";
  useApp();
  const github = fakeGitHub();
  globalThis.fetch = github.fetch;

  const env = await githubCommandEnv(repo);

  assert.equal(env.GH_TOKEN, "ghs_installation_1");
  assert.equal(env.GITHUB_TOKEN, "ghs_installation_1");
  assert.equal(decodedHeader(env), "x-access-token:ghs_installation_1");
  assert.equal(env.GIT_CONFIG_COUNT, "4");
  assert.equal(env.GIT_CONFIG_VALUE_2, "git@github.com:");
  assert.equal(env.GIT_CONFIG_VALUE_3, "ssh://git@github.com/");
  assert.equal(env.GIT_AUTHOR_NAME, "release-bot[bot]");
  assert.equal(env.GIT_COMMITTER_NAME, "release-bot[bot]");
  assert.equal(env.GIT_AUTHOR_EMAIL, "4242+release-bot[bot]@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, "4242+release-bot[bot]@users.noreply.github.com");
  for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH"]) {
    assert.equal(env[name], undefined, `${name} reached the command`);
  }
  const minted = github.calls.find((c) => c.method === "POST");
  assert.deepEqual(minted.body, { repositories: ["repo"] });
  assert.equal(process.env.GH_TOKEN, "personal-gh-token");
});

test("with an app, an explicit repository is used instead of origin", async () => {
  useApp();
  const github = fakeGitHub({
    routes: {
      "GET /repos/other/name/installation": () => json(200, { id: 77 }),
    },
  });
  globalThis.fetch = github.fetch;

  const env = await githubCommandEnv(scratch, { owner: "other", repo: "name" });

  assert.equal(env.GH_TOKEN, "ghs_installation_1");
  assert.equal(github.calls[0].path, "/repos/other/name/installation");
  const minted = github.calls.find((c) => c.method === "POST");
  assert.deepEqual(minted.body, { repositories: ["name"] });

  globalThis.fetch = fakeGitHub({
    routes: { "GET /repos/other/gone/installation": () => json(404, {}) },
  }).fetch;
  await assert.rejects(
    githubCommandEnv(scratch, { owner: "other", repo: "gone" }),
    /GitHub App 12345 is not installed on other\/gone \(404\)/
  );
});

test("with a token, the command env carries it for gh and git, with no bot identity", async () => {
  const authorBefore = process.env.GIT_AUTHOR_NAME;
  process.env.GH_TOKEN = "";
  process.env.GITHUB_TOKEN = "personal-github-token";
  process.env.GIT_CONFIG_COUNT = "1";

  const env = await githubCommandEnv(scratch);

  assert.equal(env.GH_TOKEN, "personal-github-token");
  assert.equal(env.GITHUB_TOKEN, "personal-github-token");
  assert.equal(env.GIT_CONFIG_COUNT, "5");
  assert.equal(env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
  assert.equal(decodedHeader(env), "x-access-token:personal-github-token");
  assert.equal(env.GIT_AUTHOR_NAME, authorBefore);
});

test("an unresolvable credential is refused with the tools' messages", async () => {
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  process.env.PATH = bin;
  process.env.HOME = scratch;

  await assert.rejects(githubCommandEnv(scratch), /No GitHub token available\./);

  process.env.GH_TOKEN = "personal-gh-token";
  process.env.GITHUB_APP_ID = "12345";
  await assert.rejects(
    githubCommandEnv(scratch),
    /GITHUB_APP_ID is set but no private key is/
  );
});
