import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderChangePlan } from "../lib/change-plan.js";
import { GitFlowManager } from "../lib/git-flow.js";
import { renderManualDownmerge } from "../lib/manual-downmerge.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;
let github;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (file, contents, message) => {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const version = (v) => `${v}\nabc1234def56\n`;

const tagVersion = (v) => git("tag", v, "-a", "-m", `Release version ${v}`);

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

const fakeVersioner = () => {
  const read = () => git("show", "HEAD:VERSION").split("\n")[0].trim();
  return {
    getCurrentVersion: async () => parseVersion(read()),
    incrementReleaseCandidate: async () => {
      const [core, rc] = read().split("-RC.");
      const next = `${core}-RC.${Number(rc) + 1}`;
      commit("VERSION", version(next), `To version ${next}`);
      tagVersion(next);
      return parseVersion(next);
    },
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
};

const makeAgent = (open = []) => {
  github = { open: [...open], created: [], lookupsAt: [] };
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async (head, base) => {
    const pr = github.open.find((p) => p.head === head && p.base === base);
    return pr ? { number: pr.number, url: pr.url, title: "t", body: "" } : null;
  };
  gfm.findOpenPullRequestsFrom = async (head) => {
    github.lookupsAt.push(github.created.length);
    return github.open.filter((p) => p.head === head);
  };
  gfm.createPullRequest = async (head, base, title) => {
    github.created.push({ head, base, title });
    const existing = github.open.find((p) => p.head === head && p.base === base);
    if (existing) {
      return { url: existing.url, action: "updated" };
    }
    const number = 100 + github.open.length;
    const url = `https://example.invalid/pr/${number}`;
    github.open.push({ number, url, head, base });
    return { url, action: "created" };
  };
  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = fakeVersioner();
  return agent;
};

const setUp = ({ trigger }) => {
  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  commit("deps.lock", "a\n", "Lock dependencies");
  if (trigger) {
    commit(
      ".release-management.json",
      JSON.stringify({ pipeline: { trigger: "echo pipeline queued" } }),
      "Configure the pipeline trigger"
    );
  }
  git("checkout", "-q", "-b", "develop");
  git("push", "-q", "origin", "main", "develop");
};

const releaseBranch = () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  tagVersion("1.4.0-RC.1");
  commit("deps.lock", "c\n", "Upgrade a dependency on the release");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
};

const hotfixBranch = () => {
  git("checkout", "-q", "-b", "hotfix/1.3.1", "main");
  commit("VERSION", version("1.3.1-RC.0"), "To version 1.3.1-RC.0");
  tagVersion("1.3.1-RC.0");
  commit("deps.lock", "c\n", "Upgrade a dependency on the hotfix");
  git("push", "-q", "origin", "hotfix/1.3.1", "1.3.1-RC.0");
};

const moveBase = (base) => {
  git("checkout", "-q", base);
  commit("deps.lock", "b\n", `Upgrade a dependency on ${base}`);
  git("push", "-q", "origin", base);
};

const openReleasePr = {
  number: 41,
  url: "https://example.invalid/pr/41",
  head: "release/1.4.0",
  base: "develop",
};

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "increment-conflict-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  repo = mkdtempSync(join(tmpdir(), "increment-conflict-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a release that merges cleanly into develop opens its pull request", async () => {
  setUp({ trigger: true });
  releaseBranch();
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.4.0");
  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);

  assert.equal(plan.mergePreview, undefined);
  assert.equal(plan.pipelineTrigger, undefined);
  assert.deepEqual(plan.warnings, []);
  assert.equal(result.manualDownmerge, undefined);
  assert.equal(result.pullRequestAction, "created");
  assert.deepEqual(github.created.map((c) => c.base), ["develop"]);
  assert.equal(result.pipelineTrigger.status, "skipped");
});

test("a conflicting release with no open pull request hands off and starts the pipeline", async () => {
  setUp({ trigger: true });
  releaseBranch();
  const before = await makeAgent().planIncrementRC("1.4.0");
  moveBase("develop");
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.4.0");
  github.lookupsAt = [];
  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);

  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.notices, []);
  assert.equal(
    plan.mergePreview,
    "release/1.4.0 conflicts with develop in 1 file(s): deps.lock. No " +
      "release/1.4.0 → develop pull request is open, so the apply will not " +
      'open the one listed above: it returns a "Manual downmerge needed" ' +
      "handoff to resolve the conflicts on a merge branch instead, and the " +
      "pipeline trigger starts the build. Checked again after the push."
  );
  assert.match(
    plan.pipelineTrigger,
    /^Would start the pipeline for release\/1\.4\.0: it has no open pull request/
  );
  assert.match(renderChangePlan(plan), /\nNotes:\n  - release\/1\.4\.0 conflicts/);
  assert.equal(plan.digest, before.digest);

  assert.deepEqual(github.created, []);
  assert.equal(result.pullRequestUrl, undefined);
  assert.equal(result.pullRequestError, undefined);
  const handoff = result.manualDownmerge;
  assert.deepEqual(handoff.route, { source: "release", target: "develop" });
  assert.equal(handoff.requiresDecision, false);
  assert.equal(handoff.sourceBranch, "release/1.4.0");
  assert.equal(handoff.version, "1.4.0");
  assert.deepEqual(handoff.conflictedFiles, ["deps.lock"]);
  assert.equal(
    handoff.resolutionBranch,
    "release-1.4.0-into-develop-<unix-timestamp>"
  );
  assert.equal(handoff.pullRequestTitle, "Release 1.4.0 to develop");
  assert.deepEqual(handoff.increment, { version: "1.4.0-RC.2" });

  const text = renderManualDownmerge(handoff);
  assert.match(text, /^Manual downmerge needed: release\/1\.4\.0 → develop\n/);
  assert.match(
    text,
    /1\.4\.0-RC\.2 is pushed and tagged, but release\/1\.4\.0 conflicts with develop, so no pull request into develop was opened\. Conflicted files:/
  );
  assert.doesNotMatch(text, /nothing was created/);

  assert.equal(result.pipelineTrigger.status, "started");
  assert.deepEqual(github.lookupsAt, [0]);
  assert.equal(
    git("show", "origin/release/1.4.0:VERSION").split("\n")[0],
    "1.4.0-RC.2"
  );
});

test("a conflicting release with its pull request open updates it and hands off", async () => {
  setUp({ trigger: true });
  releaseBranch();
  moveBase("develop");
  const agent = makeAgent([openReleasePr]);

  const plan = await agent.planIncrementRC("1.4.0");
  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);

  assert.deepEqual(plan.warnings, []);
  assert.match(plan.notices[0], /PR #41 is already open/);
  assert.match(plan.mergePreview, /PR #41 stays open and is updated/);
  assert.equal(plan.pipelineTrigger, undefined);

  assert.equal(result.pullRequestAction, "updated");
  assert.equal(result.pullRequestUrl, openReleasePr.url);
  assert.deepEqual(result.manualDownmerge.increment, {
    version: "1.4.0-RC.2",
    openPullRequest: 41,
  });
  assert.match(
    renderManualDownmerge(result.manualDownmerge),
    /PR #41 \(release\/1\.4\.0 → develop\) stays open, but it cannot merge/
  );
  assert.equal(result.pipelineTrigger.status, "skipped");
  assert.match(result.pipelineTrigger.message, /PR #41 is open/);
});

test("without a pipeline trigger a conflicting release still opens its pull request", async () => {
  setUp({ trigger: false });
  releaseBranch();
  moveBase("develop");
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.4.0");
  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);

  assert.equal(plan.mergePreview, undefined);
  assert.deepEqual(plan.warnings, []);
  assert.equal(result.manualDownmerge, undefined);
  assert.equal(result.pullRequestAction, "created");
  assert.deepEqual(github.created.map((c) => c.base), ["develop"]);
  assert.equal(result.pipelineTrigger, undefined);
});

test("a hotfix whose pull request into main would conflict is a plan warning", async () => {
  setUp({ trigger: true });
  hotfixBranch();
  moveBase("main");
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.3.1");
  const result = await agent.executeIncrementRCWorkflow(repo, "1.3.1", false);

  assert.deepEqual(plan.warnings, [
    "Merging hotfix/1.3.1 into main conflicts in 1 file(s): deps.lock. The " +
      "apply still opens or updates the hotfix/1.3.1 → main pull request, " +
      "which cannot merge until this is resolved. main mirrors production, " +
      "so how to resolve it is a human decision: see docs/manual-downmerge.md.",
  ]);
  assert.equal(plan.mergePreview, undefined);
  assert.equal(result.manualDownmerge, undefined);
  assert.deepEqual(github.created.map((c) => c.base), ["main"]);
  assert.equal(result.pipelineTrigger.status, "skipped");
});

test("a hotfix that merges cleanly into main has no warning", async () => {
  setUp({ trigger: true });
  hotfixBranch();
  const agent = makeAgent();

  const plan = await agent.planIncrementRC("1.3.1");

  assert.deepEqual(plan.warnings, []);
});
