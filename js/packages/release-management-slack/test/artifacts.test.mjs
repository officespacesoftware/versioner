// Node built-in test runner. Run from the package root with:
//   node --test test/artifacts.test.mjs
//
// The MCP saves each tool call's structuredContent as a Cursor artifact, so
// the app reads the structure from there rather than from the agent's reply,
// which an LLM retypes and can corrupt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickArtifact, structuredOfRun } from "../lib/artifacts.js";
import { CursorClient } from "../lib/cursor.js";
import { parseAgentReply, replyTool, salvageReply } from "../lib/reply.js";
import { fixtures } from "./mockup-messages.mjs";

const corrupted = readFileSync(
  new URL("./promote-reply-corrupted.txt", import.meta.url),
  "utf8"
);
const promote = fixtures["plan-release-promote"];
const DIR = "artifacts/release-management";

const file = (stamp, seq, tool, updatedAt) => ({
  path: `${DIR}/${stamp}-${seq}-${tool}.json`,
  sizeBytes: 100,
  updatedAt,
});

test("the corrupted promote reply does not parse as JSON", () => {
  assert.throws(() => JSON.parse(corrupted));
});

test("its plain fields are salvaged up to where it breaks", () => {
  const fields = salvageReply(corrupted);

  assert.equal(fields.kind, "plan");
  assert.equal(fields.tool, "release_version");
  assert.equal(fields.digest, "001c5e");
  assert.match(fields.planText, /^📋 Plan — nothing has been changed yet\n/);
  assert.equal(fields.text, undefined);
  assert.equal(replyTool(corrupted), "release_version");
});

test("salvage keeps only top-level strings and stops at an open one", () => {
  const fields = salvageReply(
    '{"kind": "plan", "output": {"tool": "nested", "kind": "x"}, ' +
      '"tool": "re\\"lease", "digest": "abc123", "planText": "cut'
  );

  assert.deepEqual(fields, {
    kind: "plan",
    tool: 're"lease',
    digest: "abc123",
  });
});

test("the corrupted reply with the run's artifact is a structured plan", () => {
  const reply = parseAgentReply(corrupted, promote);

  assert.equal(reply.kind, "plan");
  assert.equal(reply.tool, "release_version");
  assert.equal(reply.digest, "001c5e");
  assert.equal(reply.plan.targetBranch, "release/1.1.0");
  assert.equal(
    reply.plan.review.sinceVersion.commits[1].subject,
    "To version 1.1.0-RC.6"
  );
  assert.match(reply.planText, /release\/1\.1\.0 \(at a51ccb61f98\)/);
});

test("the corrupted reply without an artifact falls back to its text", () => {
  const reply = parseAgentReply(corrupted);

  assert.equal(reply.kind, "plan");
  assert.equal(reply.digest, "001c5e");
  assert.equal(reply.plan, undefined);
  assert.match(reply.planText, /Version: 1\.1\.0-RC\.5 → 1\.1\.0/);
});

test("a tampered artifact fails its digest and falls back to the text", () => {
  const tampered = structuredClone(promote);
  tampered.plan.mutations[0].summary = '"To version 9.9.9" on release/1.1.0';

  const reply = parseAgentReply(corrupted, tampered);

  assert.equal(reply.kind, "plan");
  assert.equal(reply.plan, undefined);
  assert.equal(reply.digest, "001c5e");
});

test("a tampered artifact falls back to a valid output in the reply", () => {
  const tampered = structuredClone(promote);
  tampered.plan.resultingVersion = "1.2.0";
  const reply = parseAgentReply(
    JSON.stringify({
      kind: "plan",
      tool: "release_version",
      digest: "001c5e",
      planText: "…",
      output: promote,
    }),
    tampered
  );

  assert.equal(reply.plan.resultingVersion, "1.1.0");
});

test("an artifact of a different digest than the reply's is not used", () => {
  const reply = parseAgentReply(
    JSON.stringify({
      kind: "plan",
      tool: "release_version",
      digest: "9a570f",
      planText: "Action:  release_version",
    }),
    promote
  );

  assert.equal(reply.plan, undefined);
  assert.equal(reply.digest, "9a570f");
});

test("an artifact does not replace a reply of another kind", () => {
  const reply = parseAgentReply(
    JSON.stringify({ kind: "message", text: "Mention me with a branch." }),
    fixtures.versions
  );

  assert.deepEqual(reply, {
    kind: "message",
    text: "Mention me with a branch.",
  });
});

test("an unreadable reply with the run's artifact renders the artifact", () => {
  const reply = parseAgentReply("The tool returned a plan.", promote);

  assert.equal(reply.kind, "plan");
  assert.equal(reply.digest, "001c5e");
  assert.ok(reply.plan);
});

test("an unreadable reply with nothing usable is an error", () => {
  const reply = parseAgentReply('{"output": {"kind": "plan", "pla');

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /could not be read/);
});

const planRun = {
  createdAt: "2026-11-10T05:00:00.000Z",
  updatedAt: "2026-11-10T05:03:00.000Z",
};
const applyRun = {
  createdAt: "2026-11-10T06:00:00.000Z",
  updatedAt: "2026-11-10T06:02:00.000Z",
};
const twoRuns = [
  file("20261110T050130000Z", 1, "list_versions", "2026-11-10T05:01:31Z"),
  file("20261110T050200000Z", 2, "release_version", "2026-11-10T05:02:01Z"),
  file("20261110T060100000Z", 1, "release_version", "2026-11-10T06:01:01Z"),
  file("20261110T060130000Z", 2, "list_versions", "2026-11-10T06:01:31Z"),
  {
    path: "artifacts/screenshot.png",
    sizeBytes: 9,
    updatedAt: "2026-11-10T06:01:59Z",
  },
];

test("the plan run's own file is picked, not the later apply's", () => {
  assert.equal(
    pickArtifact(twoRuns, planRun, "release_version"),
    `${DIR}/20261110T050200000Z-2-release_version.json`
  );
});

test("the apply run picks its own file of the named tool", () => {
  assert.equal(
    pickArtifact(twoRuns, applyRun, "release_version"),
    `${DIR}/20261110T060100000Z-1-release_version.json`
  );
  assert.equal(
    pickArtifact(twoRuns, applyRun, ""),
    `${DIR}/20261110T060130000Z-2-list_versions.json`
  );
});

test("files an earlier run left are taken over by the newest name", () => {
  const resynced = twoRuns.map((a) => ({
    ...a,
    updatedAt: "2026-11-10T06:01:59Z",
  }));

  assert.equal(
    pickArtifact(resynced, applyRun, "release_version"),
    `${DIR}/20261110T060100000Z-1-release_version.json`
  );
});

test("a downmerge reply matches the MCP's downmerge tools", () => {
  const files = [
    file(
      "20261110T060100000Z",
      1,
      "downmerge_release_to_develop",
      "2026-11-10T06:01:01Z"
    ),
    file("20261110T060130000Z", 2, "list_versions", "2026-11-10T06:01:31Z"),
  ];

  assert.equal(pickArtifact(files, applyRun, "downmerge"), files[0].path);
});

test("nothing is picked for a run without a start or new files", () => {
  assert.equal(pickArtifact(twoRuns, {}, "release_version"), undefined);
  assert.equal(
    pickArtifact(
      twoRuns,
      { createdAt: "2026-11-10T07:00:00.000Z" },
      "release_version"
    ),
    undefined
  );
});

const reader = (artifacts, download) => ({
  listArtifacts: async () => artifacts,
  downloadArtifact: download,
});

test("the run's structured output is downloaded and parsed", async () => {
  const asked = [];
  const output = await structuredOfRun(
    reader(twoRuns, async (agentId, path) => {
      asked.push({ agentId, path });
      return JSON.stringify(promote);
    }),
    { agentId: "bc-1", runId: "run-1" },
    planRun,
    "release_version"
  );

  assert.deepEqual(asked, [
    {
      agentId: "bc-1",
      path: `${DIR}/20261110T050200000Z-2-release_version.json`,
    },
  ]);
  assert.deepEqual(output, promote);
});

test("a download error or bad JSON is logged and gives nothing", async () => {
  const logged = [];
  const log = (message, error) => logged.push({ message, error });
  const run = { agentId: "bc-1", runId: "run-1" };

  const failed = await structuredOfRun(
    reader(twoRuns, async () => {
      throw new Error("S3 said no");
    }),
    run,
    planRun,
    "release_version",
    log
  );
  const garbled = await structuredOfRun(
    reader(twoRuns, async () => "{not json"),
    run,
    planRun,
    "release_version",
    log
  );

  assert.equal(failed, undefined);
  assert.equal(garbled, undefined);
  assert.equal(logged.length, 2);
  assert.match(logged[0].error.message, /S3 said no/);
});

function cursorWith(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes[String(url)];
    if (!route) return new Response("{}", { status: 404 });
    return typeof route === "function" ? route() : route;
  };
  return {
    calls,
    client: new CursorClient("key_1", { repos: [] }, fetchFn),
  };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const API = "https://api.cursor.com/v1/agents/bc-1/artifacts";
const PATH = `${DIR}/20261110T050200000Z-2-release_version.json`;
const DOWNLOAD = `${API}/download?${new URLSearchParams({ path: PATH })}`;
const S3 = "https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/a?X-Amz=1";

test("artifacts are listed with the API key", async () => {
  const { client, calls } = cursorWith({
    [API]: json({
      items: [
        { path: PATH, sizeBytes: 7526, updatedAt: "2026-11-10T05:02:01Z" },
        { sizeBytes: 1 },
      ],
    }),
  });

  const items = await client.listArtifacts("bc-1");

  assert.deepEqual(items, [
    { path: PATH, sizeBytes: 7526, updatedAt: "2026-11-10T05:02:01Z" },
  ]);
  assert.match(calls[0].headers.authorization, /^Basic /);
});

test("a download follows the presigned URL without the API key", async () => {
  const { client, calls } = cursorWith({
    [DOWNLOAD]: json({ url: S3, expiresAt: "2026-11-10T05:17:00Z" }),
    [S3]: new Response('{"kind":"plan"}', { status: 200 }),
  });

  const body = await client.downloadArtifact("bc-1", PATH);

  assert.equal(body, '{"kind":"plan"}');
  assert.equal(calls[1].url, S3);
  assert.equal(calls[1].headers.authorization, undefined);
});

test("a presigned URL that is not https is refused", async () => {
  const insecure = "http://cloud-agent-artifacts.s3.amazonaws.com/a";
  const { client, calls } = cursorWith({
    [DOWNLOAD]: json({ url: insecure }),
  });

  await assert.rejects(client.downloadArtifact("bc-1", PATH), /no https URL/);
  await assert.rejects(
    cursorWith({ [DOWNLOAD]: json({}) }).client.downloadArtifact("bc-1", PATH),
    /no https URL/
  );
  assert.equal(calls.length, 1);
});

test("a download over the size cap is refused", async () => {
  const big = "x".repeat(2000);
  const declared = cursorWith({
    [DOWNLOAD]: json({ url: S3 }),
    [S3]: new Response(big, { headers: { "content-length": "2000" } }),
  });
  const streamed = cursorWith({
    [DOWNLOAD]: json({ url: S3 }),
    [S3]: new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(new TextEncoder().encode(big.slice(0, 500)));
          }
          controller.close();
        },
      })
    ),
  });

  await assert.rejects(
    declared.client.downloadArtifact("bc-1", PATH, 1000),
    /over 1000/
  );
  await assert.rejects(
    streamed.client.downloadArtifact("bc-1", PATH, 1000),
    /over 1000/
  );
  assert.equal(
    (await cursorWith({
      [DOWNLOAD]: json({ url: S3 }),
      [S3]: new Response(big),
    }).client.downloadArtifact("bc-1", PATH, 2000)).length,
    2000
  );
});

test("a failed download is an error", async () => {
  const { client } = cursorWith({
    [DOWNLOAD]: json({ url: S3 }),
    [S3]: new Response("AccessDenied", { status: 403 }),
  });

  await assert.rejects(client.downloadArtifact("bc-1", PATH), /\(403\)/);
});
