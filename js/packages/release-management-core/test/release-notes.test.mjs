// Node built-in test runner. Run from the package root with:
//   node --test test/release-notes.test.mjs
//
// Exercises createGitHubRelease's notes-generation retry/fallback logic by
// pre-seeding the github-client cache with a fake Octokit.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  _setGitHubClientForTesting,
  clearGitHubClientCache,
} from "../lib/github-client.js";
import { GitFlowManager } from "../lib/git-flow.js";

const WD = "/tmp/release-notes-test";

function makeClient(behavior) {
  return {
    owner: "fake-owner",
    repo: "fake-repo",
    rest: {
      repos: {
        generateReleaseNotes: mock.fn(behavior.generateReleaseNotes),
        createRelease: mock.fn(behavior.createRelease),
        updateRelease: mock.fn(
          behavior.updateRelease ?? (async () => ({ data: {} }))
        ),
      },
    },
    graphql: () => {
      throw new Error("graphql not stubbed");
    },
  };
}

function withFastBackoff(fn) {
  // Collapse the retry backoff to ~zero so tests run instantly.
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => orig(cb, 0);
  return Promise.resolve(fn()).finally(() => {
    globalThis.setTimeout = orig;
  });
}

function freshManager(behavior) {
  clearGitHubClientCache();
  const client = makeClient(behavior);
  _setGitHubClientForTesting(WD, client);
  const gfm = new GitFlowManager(WD);
  return { gfm, client };
}

test("returns body on first successful call", async () => {
  const { gfm, client } = freshManager({
    generateReleaseNotes: async () => ({
      data: { body: "## What's Changed\n* Thing" },
    }),
    createRelease: async () => ({
      data: { html_url: "https://example/r/1", id: 1 },
    }),
  });

  const result = await gfm.createGitHubRelease("1.0.0", "release/1.0.0");
  assert.equal(result.url, "https://example/r/1");
  assert.equal(result.notesWarning, undefined);
  assert.equal(client.rest.repos.generateReleaseNotes.mock.callCount(), 1);
  assert.equal(client.rest.repos.createRelease.mock.callCount(), 1);
  assert.equal(client.rest.repos.updateRelease.mock.callCount(), 0);
  const args = client.rest.repos.createRelease.mock.calls[0].arguments[0];
  assert.equal(args.body, "## What's Changed\n* Thing");
});

test("retries on empty body and patches the release once notes appear", async () => {
  let attempt = 0;
  const { gfm, client } = freshManager({
    generateReleaseNotes: async () => {
      attempt += 1;
      if (attempt <= 3) return { data: { body: "" } };
      return { data: { body: "## What's Changed\n* Late!" } };
    },
    createRelease: async () => ({
      data: { html_url: "https://example/r/2", id: 42 },
    }),
  });

  const result = await withFastBackoff(() =>
    gfm.createGitHubRelease("2.0.0", "release/2.0.0")
  );

  assert.equal(result.url, "https://example/r/2");
  assert.equal(result.notesWarning, undefined);
  // 3 empties (pre-create) + 1 success (post-create) = 4 calls.
  assert.equal(client.rest.repos.generateReleaseNotes.mock.callCount(), 4);
  assert.equal(client.rest.repos.createRelease.mock.callCount(), 1);
  assert.equal(client.rest.repos.updateRelease.mock.callCount(), 1);
  const createArgs = client.rest.repos.createRelease.mock.calls[0].arguments[0];
  assert.equal(createArgs.body, "");
  const updateArgs = client.rest.repos.updateRelease.mock.calls[0].arguments[0];
  assert.equal(updateArgs.release_id, 42);
  assert.equal(updateArgs.body, "## What's Changed\n* Late!");
});

test("surfaces a warning when notes generation never succeeds", async () => {
  const { gfm, client } = freshManager({
    generateReleaseNotes: async () => {
      throw new Error("HTTP 502 from GitHub");
    },
    createRelease: async () => ({
      data: { html_url: "https://example/r/3", id: 3 },
    }),
  });

  const result = await withFastBackoff(() =>
    gfm.createGitHubRelease("3.0.0", "release/3.0.0")
  );

  assert.equal(result.url, "https://example/r/3");
  assert.match(
    result.notesWarning ?? "",
    /generateReleaseNotes failed.*HTTP 502/
  );
  // 3 attempts pre-create + 3 attempts post-create = 6 calls.
  assert.equal(client.rest.repos.generateReleaseNotes.mock.callCount(), 6);
  assert.equal(client.rest.repos.createRelease.mock.callCount(), 1);
  assert.equal(client.rest.repos.updateRelease.mock.callCount(), 0);
});

test("throws when createRelease itself fails", async () => {
  const { gfm } = freshManager({
    generateReleaseNotes: async () => ({ data: { body: "## stuff" } }),
    createRelease: async () => {
      throw new Error("validation: tag already exists");
    },
  });

  await assert.rejects(
    () => gfm.createGitHubRelease("4.0.0", "release/4.0.0"),
    /Failed to create GitHub release.*tag already exists/
  );
});
