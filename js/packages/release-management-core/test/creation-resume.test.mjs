// Node built-in test runner. Run from the package root with:
//   node --test test/creation-resume.test.mjs
//
// create_release_candidate and create_hotfix push before they open their pull
// request. A pull-request failure used to fail the action after the branch and tag
// were already on origin: the pipeline trigger never ran, and a rerun was refused
// because the branch existed. The failure is now reported, the trigger still runs,
// and rerunning resumes from the push when origin holds the branch at exactly the
// planned version.
//
// Driven against a real repository with a real bare origin. GitHub and the
// versioner are stubbed; the versioner stub writes VERSION, commits and tags as the
// real one does.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;
let scratch;
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

function fakeVersioner() {
  const read = () => git("show", "HEAD:VERSION").split("\n")[0].trim();
  const cut = (bump) => async () => {
    const [major, minor, patch] = read().split(".").map(Number);
    const next = `${bump(major, minor, patch)}-RC.0`;
    commit("VERSION", version(next), `To version ${next}`);
    git("tag", next, "-a", "-m", `Release version ${next}`);
    return parseVersion(next);
  };
  return {
    getCurrentVersion: async () => parseVersion(read()),
    createReleaseCandidate: cut((M, m) => `${M}.${m + 1}.0`),
    createPatchReleaseCandidate: cut((M, m, p) => `${M}.${m}.${p + 1}`),
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
}

/** `failBases` lists the bases GitHub refuses a pull request into. */
function makeAgent({ failBases = [], open = {} } = {}) {
  const gfm = new GitFlowManager(repo);
  calls = { created: [], lookups: 0 };
  gfm.findOpenPullRequest = async (head, base) => open[base] ?? null;
  gfm.findOpenPullRequestsFrom = async () => {
    calls.lookups += 1;
    return [];
  };
  gfm.createPullRequest = async (head, base, title, body, draft) => {
    if (failBases.includes(base)) {
      throw new Error("Failed to create pull request: GitHub is down");
    }
    calls.created.push({ head, base, title, draft: draft === true });
    return { url: `https://example.invalid/pr/${base}`, action: "created" };
  };
  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = fakeVersioner();
  return agent;
}

const remoteTags = () =>
  execFileSync("git", ["ls-remote", "--tags", origin], { encoding: "utf8" });
const remoteHeads = () =>
  execFileSync("git", ["ls-remote", "--heads", origin], { encoding: "utf8" });

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "resume-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  scratch = mkdtempSync(join(tmpdir(), "resume-scratch-"));
  process.env.PIPELINE_MARKER = join(scratch, "started");

  repo = mkdtempSync(join(tmpdir(), "resume-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", origin);

  commit("VERSION", version("1.3.0"), "To version 1.3.0");
  commit(
    ".release-management.json",
    JSON.stringify({ pipeline: { trigger: 'touch "$PIPELINE_MARKER"' } }),
    "Configure the pipeline trigger"
  );
  git("checkout", "-q", "-b", "develop");
  git("push", "-q", "origin", "main", "develop");
});

afterEach(() => {
  delete process.env.PIPELINE_MARKER;
  for (const dir of [repo, origin, scratch]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a pull request failure after the push is reported, and the pipeline still starts", async () => {
  const agent = makeAgent({ failBases: ["develop"] });
  await agent.planCreateReleaseCandidate("minor");

  const result = await agent.executeRCWorkflow("minor", repo, false);

  assert.equal(result.targetVersion.version, "1.4.0-RC.0");
  assert.match(result.pullRequestError, /GitHub is down/);
  assert.equal(result.pullRequestUrl, undefined);
  assert.equal(result.stepProgress.find((s) => s.step === 6).status, "completed");
  assert.equal(result.pipelineTrigger?.status, "started");
  assert.ok(existsSync(process.env.PIPELINE_MARKER));
});

test("rerunning after that failure resumes from the push", async () => {
  await makeAgent({ failBases: ["develop"] }).executeRCWorkflow("minor", repo, false);
  const pushedHead = git("rev-parse", "origin/release/1.4.0");

  const agent = makeAgent();
  const plan = await agent.planCreateReleaseCandidate("minor");

  assert.equal(plan.resultingVersion, "1.4.0-RC.0");
  assert.deepEqual(
    plan.mutations.map((m) => `${m.kind}: ${m.summary}`),
    ["pull-request: open release/1.4.0 → develop"]
  );
  assert.match(
    plan.notices.join("\n"),
    new RegExp(
      `release/1\\.4\\.0 is already on origin at 1\\.4\\.0-RC\\.0 \\(${pushedHead.slice(0, 11)}\\)`
    )
  );

  const result = await agent.executeRCWorkflow("minor", repo, false);

  assert.equal(result.resumed, true);
  assert.equal(result.targetVersion.version, "1.4.0-RC.0");
  assert.equal(result.pullRequestUrl, "https://example.invalid/pr/develop");
  assert.deepEqual(calls.created.map((c) => c.title), ["RC 1.4.0-RC.0 to develop"]);
  // Nothing new on origin: the same branch head, one RC tag.
  assert.equal(git("rev-parse", "origin/release/1.4.0"), pushedHead);
  assert.doesNotMatch(remoteTags(), /1\.4\.0-RC\.1/);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "release/1.4.0");
});

test("a resume pushes the tag when the earlier run stopped before it", async () => {
  await makeAgent({ failBases: ["develop"] }).executeRCWorkflow("minor", repo, false);
  git("push", "-q", "origin", ":refs/tags/1.4.0-RC.0");
  const bump = git("rev-parse", "origin/release/1.4.0");

  const agent = makeAgent();
  const plan = await agent.planCreateReleaseCandidate("minor");
  assert.deepEqual(
    plan.mutations.map((m) => `${m.kind}: ${m.summary}`),
    [
      `tag: annotated tag 1.4.0-RC.0 on ${bump.slice(0, 11)}`,
      "push: tag 1.4.0-RC.0 to origin",
      "pull-request: open release/1.4.0 → develop",
    ]
  );

  await agent.executeRCWorkflow("minor", repo, false);

  assert.match(remoteTags(), /refs\/tags\/1\.4\.0-RC\.0\^\{\}/);
  assert.equal(git("rev-parse", "1.4.0-RC.0^{commit}"), bump);
});

test("a branch on origin at another version is still refused", async () => {
  await makeAgent({ failBases: ["develop"] }).executeRCWorkflow("minor", repo, false);
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0");
  git("checkout", "-q", "develop");

  await assert.rejects(makeAgent().planCreateReleaseCandidate("minor"), {
    name: "BranchSelectionError",
    message: /release\/1\.4\.0 already exists on origin at 1\.4\.0-RC\.1/,
  });
});

test("a hotfix whose pull request into main failed still opens its draft and resumes", async () => {
  const first = await makeAgent({ failBases: ["main"] }).executeHotfixWorkflow(
    repo,
    false
  );
  assert.match(first.pullRequestError, /GitHub is down/);
  assert.deepEqual(calls.created.map((c) => `${c.base} ${c.draft}`), ["develop true"]);
  assert.ok(remoteHeads().includes("refs/heads/hotfix/1.3.1"));

  const agent = makeAgent({
    open: { develop: { number: 5, url: "u", title: "t", body: "" } },
  });
  const plan = await agent.planCreateHotfix();
  assert.deepEqual(
    plan.mutations.map((m) => `${m.kind}: ${m.summary}`),
    [
      "pull-request: open hotfix/1.3.1 → main",
      "pull-request: update PR #5 (hotfix/1.3.1 → develop)",
    ]
  );

  const result = await agent.executeHotfixWorkflow(repo, false);
  assert.equal(result.resumed, true);
  assert.equal(result.pullRequestUrl, "https://example.invalid/pr/main");
});
