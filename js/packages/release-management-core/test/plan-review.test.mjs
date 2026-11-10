import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REVIEW_COMMIT_LIMIT } from "../lib/change-plan.js";
import { GitFlowManager } from "../lib/git-flow.js";
import { messageCode } from "../lib/message-codes.js";
import { ReleaseAgent } from "../lib/release-agent.js";

const GITHUB_URL = "https://github.com/acme/widgets.git";
const REPO_URL = "https://github.com/acme/widgets";

let repo;
let origin;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (file, contents, message) => {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

const version = (v) => `${v}\nabc1234def56\n`;

const bump = (v) => {
  const sha = commit("VERSION", version(v), `To version ${v}`);
  git("tag", v, "-a", "-m", `Release version ${v}`);
  return sha;
};

const head = (ref) => git("rev-parse", `origin/${ref}`);

const makeAgent = ({ open = [] } = {}) => {
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async (h, base) => {
    const pr = open.find((p) => p.head === h && p.base === base);
    return pr
      ? { number: pr.number, url: `${REPO_URL}/pull/${pr.number}`, title: "t", body: "" }
      : null;
  };
  gfm.findOpenPullRequestsFrom = async (h) =>
    open.filter((p) => p.head === h).map((p) => ({ number: p.number }));
  gfm.findOpenPullRequestsInto = async () => [];
  gfm.getGitHubRelease = async () => null;
  return new ReleaseAgent(gfm, repo);
};

const assertEveryMessageCoded = (plan) => {
  for (const text of [
    ...plan.warnings,
    ...plan.notices,
    ...(plan.mergePreview ? [plan.mergePreview] : []),
    ...(plan.pipelineTrigger ? [plan.pipelineTrigger] : []),
  ]) {
    assert.ok(messageCode(text, plan.action), `no catalog code for: ${text}`);
  }
};

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "plan-review-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  repo = mkdtempSync(join(tmpdir(), "plan-review-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", GITHUB_URL);
  git("config", `url.${origin}.insteadOf`, GITHUB_URL);

  bump("1.3.0");
  git("checkout", "-q", "-b", "develop");
  commit("a.txt", "a\n", "Add a");
  commit("b.txt", "b\n", "Add b");
  commit("c.txt", "c\n", "Add c");
  git("push", "-q", "origin", "main", "develop", "1.3.0");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const releaseBranch = (fixes = 0) => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  const rc1 = bump("1.4.0-RC.1");
  for (let i = 0; i < fixes; i += 1) {
    commit(`fix-${i}.txt`, `${i}\n`, `Fix ${i}`);
  }
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
  return rc1;
};

test("a release candidate plan lists what develop holds that main lacks", async () => {
  const plan = await makeAgent().planCreateReleaseCandidate("minor");
  const { review } = plan;

  assert.equal(plan.digest.length, 6);
  assert.equal(review.repoUrl, REPO_URL);
  assert.deepEqual(review.versionFile, {
    path: "VERSION",
    from: "1.3.0",
    to: "1.4.0-RC.0",
  });
  assert.equal(review.ships.base, "main");
  assert.equal(review.ships.head, "develop");
  assert.equal(review.ships.baseSha, head("main"));
  assert.equal(review.ships.headSha, head("develop"));
  assert.equal(review.ships.count, 3);
  assert.equal(review.ships.filesChanged, 3);
  assert.deepEqual(
    review.ships.commits.map((c) => [c.subject, c.author]),
    [
      ["Add c", "Test"],
      ["Add b", "Test"],
      ["Add a", "Test"],
    ]
  );
  assert.equal(
    review.ships.compareUrl,
    `${REPO_URL}/compare/${head("main")}...${head("develop")}`
  );
  assert.equal(review.sinceVersion, undefined);
  assert.equal(review.reverts, undefined);
  assertEveryMessageCoded(plan);
});

test("the commit list is capped while the count stays exact", async () => {
  for (let i = 0; i < REVIEW_COMMIT_LIMIT + 5; i += 1) {
    commit("many.txt", `${i}\n`, `Change ${i}`);
  }
  git("push", "-q", "origin", "develop");

  const { review } = await makeAgent().planCreateReleaseCandidate("minor");

  assert.equal(review.ships.count, REVIEW_COMMIT_LIMIT + 8);
  assert.equal(review.ships.commits.length, REVIEW_COMMIT_LIMIT);
  assert.equal(review.ships.commits[0].subject, `Change ${REVIEW_COMMIT_LIMIT + 4}`);
  assert.equal(review.ships.filesChanged, 4);
});

test("creation mutations name the objects they create", async () => {
  const plan = await makeAgent().planCreateReleaseCandidate("minor");

  assert.deepEqual(
    plan.mutations.map((m) => [m.kind, m.operation ?? "create", m.ref]),
    [
      ["branch", "create", { name: "release/1.4.0", base: "develop", sha: head("develop") }],
      ["commit", "create", { name: "release/1.4.0" }],
      ["tag", "create", { name: "1.4.0-RC.0" }],
      ["push", "create", { name: "release/1.4.0" }],
      [
        "pull-request",
        "create",
        {
          head: "release/1.4.0",
          base: "develop",
          title: "RC 1.4.0-RC.0 to develop",
        },
      ],
    ]
  );
});

test("a hotfix plan moves no code and opens its develop pull request as a draft", async () => {
  const plan = await makeAgent().planCreateHotfix();

  assert.equal(plan.review.ships, undefined);
  assert.deepEqual(plan.review.versionFile, {
    path: "VERSION",
    from: "1.3.0",
    to: "1.3.1-RC.0",
  });
  const draft = plan.mutations.find(
    (m) => m.kind === "pull-request" && m.ref.base === "develop"
  );
  assert.equal(draft.ref.draft, true);
  assert.deepEqual(
    plan.notices.map((n) => messageCode(n)),
    ["N2"]
  );
});

test("an increment lists the commits since the current candidate's version commit", async () => {
  const rc1 = releaseBranch(2);
  const plan = await makeAgent({
    open: [{ number: 41, head: "release/1.4.0", base: "develop" }],
  }).planIncrementRC("1.4.0");
  const { ships } = plan.review;

  assert.equal(ships.base, "1.4.0-RC.1");
  assert.equal(ships.baseSha, rc1);
  assert.equal(ships.head, "release/1.4.0");
  assert.equal(ships.headSha, head("release/1.4.0"));
  assert.equal(ships.count, 2);
  assert.deepEqual(
    ships.commits.map((c) => c.subject),
    ["Fix 1", "Fix 0"]
  );
  assert.equal(ships.compareUrl, `${REPO_URL}/compare/${rc1}...${ships.headSha}`);

  const pr = plan.mutations.find((m) => m.kind === "pull-request");
  assert.equal(pr.operation, "update");
  assert.deepEqual(pr.ref, {
    number: 41,
    url: `${REPO_URL}/pull/41`,
    head: "release/1.4.0",
    base: "develop",
    title: "RC 1.4.0-RC.2 to develop",
  });
  assert.deepEqual(plan.notices.map((n) => messageCode(n)), ["N1"]);
});

test("a promotion lists what reaches main and what no candidate contained", async () => {
  const rc1 = releaseBranch(1);
  const plan = await makeAgent().planReleaseVersion("1.4.0");
  const { ships, sinceVersion } = plan.review;

  assert.equal(ships.base, "main");
  assert.equal(ships.baseSha, head("main"));
  assert.equal(ships.count, 5);
  assert.equal(sinceVersion.base, "1.4.0-RC.1");
  assert.equal(sinceVersion.baseSha, rc1);
  assert.equal(sinceVersion.count, 1);
  assert.deepEqual(sinceVersion.commits.map((c) => c.subject), ["Fix 0"]);
  assert.deepEqual(
    plan.mutations
      .filter((m) => m.kind === "github-release" || m.kind === "tag")
      .map((m) => m.ref),
    [{ name: "1.4.0" }, { name: "1.4.0" }]
  );
});

test("a revert names the commit it undoes", async () => {
  releaseBranch();
  const rc2 = bump("1.4.0-RC.2");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.2");

  const plan = await makeAgent({
    open: [{ number: 41, head: "release/1.4.0", base: "develop" }],
  }).planRevertVersion("1.4.0");

  assert.equal(plan.shape, "revert");
  assert.deepEqual(plan.review.reverts, {
    sha: rc2,
    subject: "To version 1.4.0-RC.2",
    files: ["VERSION"],
    url: `${REPO_URL}/commit/${rc2}`,
  });
  assert.deepEqual(plan.review.versionFile, {
    path: "VERSION",
    from: "1.4.0-RC.2",
    to: "1.4.0-RC.1",
  });
  assert.deepEqual(
    plan.mutations.map((m) => `${m.operation ?? "create"}:${m.kind}`),
    [
      "create:commit",
      "delete:tag",
      "delete:tag",
      "create:push",
      "update:pull-request",
    ]
  );
  assert.deepEqual(plan.notices.map((n) => messageCode(n)), ["N4"]);
});

test("an abandon lists the branch's commits and closes its pull request", async () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  const rc0 = bump("1.4.0-RC.0");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.0");

  const plan = await makeAgent({
    open: [{ number: 52, head: "release/1.4.0", base: "develop" }],
  }).planRevertVersion("1.4.0");

  assert.equal(plan.shape, "abandon");
  assert.equal(plan.review.ships.base, "develop");
  assert.equal(plan.review.ships.count, 1);
  assert.equal(plan.review.ships.commits[0].sha, rc0);
  const close = plan.mutations.find((m) => m.kind === "pull-request");
  assert.equal(close.operation, "close");
  assert.equal(close.ref.number, 52);
  const branch = plan.mutations.find((m) => m.kind === "branch");
  assert.deepEqual(branch.ref, { name: "release/1.4.0", sha: rc0 });
  assert.deepEqual(plan.warnings.map((w) => messageCode(w, plan.action)), ["W13"]);
});

test("every check that ran is reported, with output only for a failure", async () => {
  git("checkout", "-q", "develop");
  commit(
    ".release-management.json",
    JSON.stringify({
      checks: [
        { name: "passes", run: "echo fine", on: ["create_release_candidate"] },
        { name: "fails", run: "echo broken; exit 3", on: ["create_release_candidate"] },
      ],
    }),
    "Configure checks"
  );
  git("push", "-q", "origin", "develop");

  const plan = await makeAgent().planCreateReleaseCandidate("minor");

  assert.deepEqual(
    plan.checks.map(({ name, status, exitCode, ref, sha, output }) => ({
      name,
      status,
      exitCode,
      ref,
      sha,
      output,
    })),
    [
      { name: "passes", status: "passed", exitCode: 0, ref: "develop", sha: head("develop"), output: undefined },
      { name: "fails", status: "failed", exitCode: 3, ref: "develop", sha: head("develop"), output: "broken" },
    ]
  );
  assert.ok(plan.checks.every((c) => typeof c.seconds === "number"));
  assert.deepEqual(plan.warnings.map((w) => messageCode(w)), ["W8"]);
});

test("an origin that is not on GitHub gets counts without links", async () => {
  git("remote", "set-url", "origin", origin);

  const { review } = await makeAgent().planCreateReleaseCandidate("minor");

  assert.equal(review.repoUrl, undefined);
  assert.equal(review.ships.compareUrl, undefined);
  assert.equal(review.ships.count, 3);
});

test("the review is not part of the digest", async () => {
  const agent = makeAgent();
  const before = await agent.planCreateReleaseCandidate("minor");
  git("remote", "set-url", "origin", origin);
  const after = await agent.planCreateReleaseCandidate("minor");

  assert.notDeepEqual(before.review, after.review);
  assert.equal(before.digest, after.digest);
});
