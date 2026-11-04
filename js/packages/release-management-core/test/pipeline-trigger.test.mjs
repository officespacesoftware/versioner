// Node built-in test runner. Run from the package root with:
//   node --test test/pipeline-trigger.test.mjs
//
// The pipeline trigger runs a real command in a real checkout after a real push, so
// these drive the plans and applies against a real repository with a real bare
// origin. GitHub and the versioner are the things stubbed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderChangePlan } from "../lib/change-plan.js";
import { GitFlowManager } from "../lib/git-flow.js";
import { parsePipelineConfig } from "../lib/pre-version-checks.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;
let scratch;
let marker;
let calls;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const version = (v) => `${v}\nabc1234def56\n`;

function tagVersion(v) {
  git("tag", v, "-a", "-m", `Release version ${v}`);
}

const remoteTags = () =>
  execFileSync("git", ["ls-remote", "--tags", origin], { encoding: "utf8" });

const remoteHeads = () =>
  execFileSync("git", ["ls-remote", "--heads", origin], { encoding: "utf8" });

/** Records what the trigger saw, in a file outside the repository. */
const RECORDING_TRIGGER =
  'printf "%s\\n" "$RELEASE_BRANCH" "$RELEASE_VERSION" "$RELEASE_ACTION" ' +
  '"$(git rev-parse HEAD)" "$(pwd -P)" > "$PIPELINE_MARKER"; ' +
  'echo "pipeline queued"';

const recorded = () => {
  const [branch, ver, action, head, dir] = readFileSync(marker, "utf8")
    .trim()
    .split("\n");
  return { branch, version: ver, action, head, dir };
};

/** Commit `.release-management.json` holding `pipeline` to develop and main. */
function configurePipeline(pipeline) {
  git("checkout", "-q", "develop");
  commit(
    ".release-management.json",
    JSON.stringify({ pipeline }, null, 2),
    "Configure the pipeline trigger"
  );
  git("checkout", "-q", "main");
  git("merge", "-q", "--ff-only", "develop");
  git("push", "-q", "origin", "main", "develop");
}

/** A release branch carrying two release candidates, pushed with both tags. */
function releaseBranchAtRC2() {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  tagVersion("1.4.0-RC.1");
  commit("VERSION", version("1.4.0-RC.2"), "To version 1.4.0-RC.2");
  tagVersion("1.4.0-RC.2");
  git("push", "-q", "origin", "release/1.4.0");
  git("push", "-q", "origin", "1.4.0-RC.1", "1.4.0-RC.2");
}

/** A release branch holding only its RC.0, pushed with its tag. */
function releaseBranchAtRC0() {
  git("checkout", "-q", "-b", "release/1.5.0", "develop");
  commit("VERSION", version("1.5.0-RC.0"), "To version 1.5.0-RC.0");
  tagVersion("1.5.0-RC.0");
  git("push", "-q", "origin", "release/1.5.0");
  git("push", "-q", "origin", "1.5.0-RC.0");
}

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
  return {
    getCurrentVersion: async () => parseVersion(read()),
    releaseVersion: async () => {
      const promoted = read().split("-RC.")[0];
      commit("VERSION", version(promoted), `To version ${promoted}`);
      tagVersion(promoted);
      return parseVersion(promoted);
    },
    isVersionerAvailable: () => true,
    disconnect: async () => {},
  };
}

/**
 * `openFrom` is what GitHub reports as open with the branch as head, after the
 * action's own pull-request steps.
 */
function makeAgent({ openFrom = [], ...overrides } = {}) {
  const gfm = new GitFlowManager(repo);
  calls = { created: [], lookups: [], createdAtLookup: [] };

  gfm.findOpenPullRequest = async () => null;
  gfm.findOpenPullRequestsFrom = async (branch) => {
    calls.lookups.push(branch);
    calls.createdAtLookup.push(calls.created.length);
    return openFrom;
  };
  gfm.createPullRequest = async (head, base, title, body) => {
    calls.created.push({ head, base, title, body });
    return { url: `https://example.invalid/pr/${base}`, action: "created" };
  };
  gfm.createGitHubRelease = async () => ({
    url: "https://example.invalid/release/1",
  });
  gfm.getGitHubRelease = async () => null;
  gfm.deleteGitHubRelease = async () => {};
  Object.assign(gfm, overrides);

  const agent = new ReleaseAgent(gfm, repo);
  agent.versionerAdapter = fakeVersioner();
  return { gfm, agent };
}

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "pipeline-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  scratch = mkdtempSync(join(tmpdir(), "pipeline-scratch-"));
  marker = join(scratch, "trigger-ran");
  process.env.PIPELINE_MARKER = marker;

  repo = mkdtempSync(join(tmpdir(), "pipeline-repo-"));
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
  delete process.env.PIPELINE_MARKER;
  for (const dir of [repo, origin, scratch]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a revert on a branch with no open PR starts the pipeline", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.deepEqual(result.pipelineTrigger, {
    status: "started",
    message:
      "Started the pipeline for release/1.4.0: it has no open pull request.",
    output: "pipeline queued",
  });
  const seen = recorded();
  assert.equal(seen.branch, "release/1.4.0");
  assert.equal(seen.version, "1.4.0-RC.1");
  assert.equal(seen.action, "revert_version");
  // It ran in a checkout of the pushed revert commit, not in the repository.
  assert.equal(seen.head, git("rev-parse", "refs/remotes/origin/release/1.4.0"));
  assert.notEqual(seen.dir, execFileSync("pwd", ["-P"], { cwd: repo, encoding: "utf8" }).trim());
  assert.equal(git("worktree", "list").split("\n").length, 1);
  assert.deepEqual(calls.lookups, ["release/1.4.0"]);
});

test("a branch with an open PR, to any base, is left to that PR's build", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  releaseBranchAtRC2();
  const { agent } = makeAgent({
    openFrom: [{ number: 81, url: "https://example.invalid/pr/81", base: "main" }],
  });

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.deepEqual(result.pipelineTrigger, {
    status: "skipped",
    message:
      "Did not start the pipeline for release/1.4.0: PR #81 is open, so its " +
      "own build runs on the push.",
  });
  assert.equal(existsSync(marker), false);
});

test("promoting runs the trigger after its pull-request steps", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  commit("VERSION", version("1.4.0-RC.1"), "To version 1.4.0-RC.1");
  tagVersion("1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
  // Both pull-request steps run, yet GitHub reports none open: as when they fail.
  const { agent } = makeAgent();

  const result = await agent.executeReleaseWorkflow(repo, undefined, false);

  assert.equal(result.pipelineTrigger.status, "started");
  assert.deepEqual(calls.createdAtLookup, [2]);
  const seen = recorded();
  assert.equal(seen.version, "1.4.0");
  assert.equal(seen.action, "release_version");
  assert.equal(seen.head, git("rev-parse", "refs/remotes/origin/release/1.4.0"));
});

test("a failing trigger is a warning; the revert stays applied", async () => {
  configurePipeline({ trigger: "echo 'circleci said 401'; exit 4" });
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.deepEqual(result.pipelineTrigger, {
    status: "failed",
    message:
      "The pipeline trigger for release/1.4.0 failed (exit 4), and " +
      "release/1.4.0 has no open pull request. Start the build for " +
      "release/1.4.0 by hand.",
    output: "circleci said 401",
  });
  assert.ok(!remoteTags().includes("refs/tags/1.4.0-RC.2"));
  assert.equal(git("show", "origin/release/1.4.0:VERSION").split("\n")[0], "1.4.0-RC.1");
});

test("a trigger that runs too long is reported as unfinished", async () => {
  configurePipeline({ trigger: "sleep 5", timeoutSeconds: 1 });
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.pipelineTrigger.status, "failed");
  assert.match(
    result.pipelineTrigger.message,
    /did not finish within 1s\. Check whether a build started/
  );
});

test("an invalid pipeline section is a warning, not a silent skip", async () => {
  configurePipeline({ trigger: "" });
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const plan = await agent.planRevertVersion();
  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /\.release-management\.json on release\/1\.4\.0 at \w+ is not valid/);
  assert.match(plan.warnings[0], /pipeline\.trigger must be a non-empty string/);
  assert.equal(result.pipelineTrigger.status, "failed");
  assert.match(result.pipelineTrigger.message, /is not valid .*Start the build for release\/1\.4\.0 by hand/);
  assert.ok(remoteHeads().includes("refs/heads/release/1.4.0"));
});

test("a repository without a pipeline section runs nothing and asks GitHub nothing", async () => {
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const plan = await agent.planRevertVersion();
  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(plan.pipelineTrigger, undefined);
  assert.equal(result.pipelineTrigger, undefined);
  assert.deepEqual(calls.lookups, []);
});

test("abandoning a branch never triggers its pipeline", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  releaseBranchAtRC0();
  const { agent } = makeAgent();

  const plan = await agent.planRevertVersion();
  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.shape, "abandon");
  assert.equal(plan.pipelineTrigger, undefined);
  assert.equal(result.pipelineTrigger, undefined);
  assert.deepEqual(calls.lookups, []);
  assert.equal(existsSync(marker), false);
});

test("a revert plan says the pipeline would start, outside the digest", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  releaseBranchAtRC2();

  const without = await makeAgent().agent.planRevertVersion();
  const withOtherPr = await makeAgent({
    openFrom: [{ number: 81, url: "u", base: "main" }],
  }).agent.planRevertVersion();

  assert.equal(
    without.pipelineTrigger,
    "Would start the pipeline for release/1.4.0: it has no open pull request. " +
      "Checked again after the push."
  );
  assert.match(renderChangePlan(without), /\nPipeline:\n  - Would start the pipeline/);
  assert.equal(withOtherPr.pipelineTrigger, undefined);
  // A pull request opening elsewhere does not make the plan stale; the apply
  // checks again after the push.
  assert.equal(without.digest, withOtherPr.digest);
});

test("a revert plan that updates the branch's PR predicts no trigger", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER });
  releaseBranchAtRC2();
  const { agent } = makeAgent({
    findOpenPullRequest: async () => ({
      number: 70,
      url: "https://example.invalid/pr/70",
      title: "RC 1.4.0-RC.2 to develop",
      body: "",
    }),
  });

  const plan = await agent.planRevertVersion();

  assert.equal(plan.pipelineTrigger, undefined);
  assert.deepEqual(calls.lookups, []);
});

test("plans for actions that open a PR predict no trigger but check its config", async () => {
  configurePipeline({ trigger: RECORDING_TRIGGER, timeoutSeconds: -1 });
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const increment = await agent.planIncrementRC("1.4.0");
  const create = await agent.planCreateReleaseCandidate("major");

  assert.equal(increment.pipelineTrigger, undefined);
  assert.equal(create.pipelineTrigger, undefined);
  assert.match(increment.warnings.at(-1), /pipeline\.timeoutSeconds must be a positive number/);
  assert.match(create.warnings.at(-1), /on develop at \w+ is not valid/);
  assert.match(create.warnings.at(-1), /If release\/2\.0\.0 has no open pull request/);
  assert.deepEqual(calls.lookups, []);
});

test("the parser defaults the timeout and ignores a file without the section", () => {
  assert.deepEqual(
    parsePipelineConfig(JSON.stringify({ pipeline: { trigger: "ci/start" } })),
    { trigger: "ci/start", timeoutSeconds: 120 }
  );
  assert.equal(parsePipelineConfig(JSON.stringify({ checks: [] })), null);
  assert.throws(
    () => parsePipelineConfig(JSON.stringify({ pipeline: "ci/start" })),
    /"pipeline" must be an object/
  );
});
