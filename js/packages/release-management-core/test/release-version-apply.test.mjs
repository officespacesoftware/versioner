// Node built-in test runner. Run from the package root with:
//   node --test test/release-version-apply.test.mjs
//
// The promotion apply path, driven against a real repository with a real bare
// origin. It exists for step 10: promoting a release branch has to refresh the
// develop pull request it has been rewriting since the branch was cut, which it
// silently skipped, leaving that PR advertising an RC that no longer existed and a
// "use release_version when ready" next step that had just been carried out.
//
// Stubbed: GitHub (findOpenPullRequest, createPullRequest, createGitHubRelease) and
// the versioner, which owns the VERSION write. The versioner stub does what the real
// one does — write VERSION, commit, annotated tag — so pushes stay real.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;
let calls;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const version = (v) => `${v}\nabc1234def56\n`;

const parseVersion = (v) => {
  const [core, rc] = v.split("-RC.");
  const [major, minor, patch] = core.split(".").map(Number);
  return {
    version: v,
    isReleaseCandidate: rc !== undefined,
    major,
    minor,
    patch,
    rcNumber: rc === undefined ? undefined : Number(rc),
  };
};

/**
 * Stand in for the versioner: strip the RC suffix, commit, tag. Reading VERSION
 * from the worktree keeps it honest about which branch the workflow checked out.
 */
function fakeVersioner() {
  const read = () => git("show", "HEAD:VERSION").split("\n")[0].trim();
  return {
    getCurrentVersion: async () => parseVersion(read()),
    releaseVersion: async () => {
      const promoted = read().split("-RC.")[0];
      commit("VERSION", version(promoted), `To version ${promoted}`);
      git("tag", promoted, "-a", "-m", `Release version ${promoted}`);
      return parseVersion(promoted);
    },
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
}

function makeAgent({ openPrs = {}, ...overrides } = {}) {
  const gfm = new GitFlowManager(repo);
  calls = { created: [], releases: [] };

  gfm.findOpenPullRequest = async (head, base) => openPrs[base] ?? null;
  // Mirrors the real thing: opening succeeds unless GitHub already has one open for
  // this head and base, in which case it reports an update instead.
  gfm.createPullRequest = async (head, base, title, body) => {
    calls.created.push({ head, base, title, body });
    return {
      url: `https://example.invalid/pr/${base}`,
      action: openPrs[base] ? "updated" : "created",
    };
  };
  gfm.createGitHubRelease = async (v, branch) => {
    calls.releases.push({ version: v, branch });
    return { url: "https://example.invalid/release/1" };
  };
  Object.assign(gfm, overrides);

  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = fakeVersioner();
  return { gfm, agent };
}

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "release-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "release-apply-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  git("checkout", "-q", "-b", "develop");
  git("checkout", "-q", "main");
  git("push", "-q", "origin", "main", "develop");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function releaseBranchAtRC1() {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  git("tag", "1.4.0-RC.1", "-a", "-m", "Release version 1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0");
  git("push", "-q", "origin", "1.4.0-RC.1");
}

function hotfixBranchAtRC0() {
  git("checkout", "-q", "-b", "hotfix/1.3.1", "main");
  commit("VERSION", version("1.3.1-RC.0"), "To version 1.3.1-RC.0");
  git("tag", "1.3.1-RC.0", "-a", "-m", "Release version 1.3.1-RC.0");
  git("push", "-q", "origin", "hotfix/1.3.1");
  git("push", "-q", "origin", "1.3.1-RC.0");
}

const prTo = (base) => calls.created.find((c) => c.base === base);

test("promoting refreshes the open develop PR to the final version", async () => {
  releaseBranchAtRC1();
  const { agent } = makeAgent({
    openPrs: {
      develop: {
        number: 70,
        url: "https://example.invalid/pr/70",
        title: "RC 1.4.0-RC.1 to develop",
        body: "",
      },
    },
  });

  const result = await agent.executeReleaseWorkflow(repo, undefined, false);

  assert.equal(result.targetVersion.version, "1.4.0");
  assert.equal(result.ownBasePullRequestUrl, "https://example.invalid/pr/develop");
  assert.equal(result.ownBasePullRequestAction, "updated");
  assert.equal(result.ownBasePullRequestError, undefined);

  // Both PRs written, each with its own wording.
  const develop = prTo("develop");
  assert.equal(develop.title, "Release 1.4.0 to develop");
  assert.match(develop.body, /promoted from a release candidate to `1\.4\.0`/);
  assert.doesNotMatch(develop.body, /RC\.1/);
  assert.doesNotMatch(develop.body, /release_version/);
  assert.equal(prTo("main").title, "Release 1.4.0 to main");

  const step10 = result.stepProgress.find((s) => s.step === 10);
  assert.equal(step10.status, "completed");
});

// The previous RC's develop PR is normally merged by now, so this is the common path:
// the promotion has to open a fresh one rather than leave the release branch to
// diverge until the post-deploy downmerge runs.
test("promoting opens a develop PR when none is waiting", async () => {
  releaseBranchAtRC1();
  const { agent } = makeAgent();

  const result = await agent.executeReleaseWorkflow(repo, undefined, false);

  const develop = prTo("develop");
  assert.equal(develop.title, "Release 1.4.0 to develop");
  assert.equal(result.ownBasePullRequestUrl, "https://example.invalid/pr/develop");
  assert.equal(result.ownBasePullRequestAction, "created");
  assert.equal(
    result.stepProgress.find((s) => s.step === 10).status,
    "completed"
  );
});

test("promoting a hotfix leaves its main PR with the step 7 title", async () => {
  hotfixBranchAtRC0();
  const { agent } = makeAgent({
    openPrs: {
      main: {
        number: 42,
        url: "https://example.invalid/pr/42",
        title: "RC 1.3.1-RC.0 to main",
        body: "",
      },
    },
  });

  const result = await agent.executeReleaseWorkflow(repo, undefined, false);

  // One write, from step 7. Step 10 must not follow it with develop wording.
  assert.equal(calls.created.length, 1);
  assert.equal(prTo("main").title, "Release 1.3.1 to main");

  const step10 = result.stepProgress.find((s) => s.step === 10);
  assert.equal(step10.status, "skipped");
  assert.match(step10.message, /already handled in step 7/);
});

test("a failure refreshing the develop PR is reported, not thrown", async () => {
  releaseBranchAtRC1();
  const { agent, gfm } = makeAgent({
    openPrs: {
      develop: { number: 70, url: "u", title: "t", body: "" },
    },
  });
  const realCreate = gfm.createPullRequest;
  gfm.createPullRequest = async (head, base, title, body) => {
    if (base === "develop") throw new Error("GitHub said no");
    return realCreate(head, base, title, body);
  };

  const result = await agent.executeReleaseWorkflow(repo, undefined, false);

  // The tag and the release happened, so the workflow must not unwind.
  assert.equal(result.targetVersion.version, "1.4.0");
  assert.equal(calls.releases.length, 1);
  assert.match(result.ownBasePullRequestError, /GitHub said no/);
  assert.equal(
    result.stepProgress.find((s) => s.step === 10).status,
    "completed"
  );
});
