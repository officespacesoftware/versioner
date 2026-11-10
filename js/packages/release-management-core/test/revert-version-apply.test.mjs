// Node built-in test runner. Run from the package root with:
//   node --test test/revert-version-apply.test.mjs
//
// The first test of an apply path above the primitive layer. Every other workflow
// is covered only by its plan builder, which is tolerable when the worst case is a
// commit nobody wanted. A revert deletes tags and can delete a branch on origin, so
// "the plan looked right" is not enough — this drives executeRevertVersionWorkflow
// against a real repository with a real bare origin and inspects what survives.
//
// GitHub is the one thing stubbed: findOpenPullRequest, closePullRequest,
// createPullRequest and the release calls are the only non-git operations involved.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitFlowManager } from "../lib/git-flow.js";
import { ReleaseAgent } from "../lib/release-agent.js";

let repo;
let origin;
let calls;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const gitQuiet = (...args) => {
  try {
    return git(...args);
  } catch {
    return "";
  }
};

function commit(file, contents, message) {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const version = (v) => `${v}\nabc1234def56\n`;

/** Tag exactly as the versioner does: annotated, named for the bare version. */
function tagVersion(v) {
  git("tag", v, "-a", "-m", `Release version ${v}`);
}

function makeAgent(overrides = {}) {
  const gfm = new GitFlowManager(repo);
  calls = { closed: [], created: [], deletedReleases: [] };

  gfm.findOpenPullRequest = async () => null;
  gfm.closePullRequest = async (number, opts) => {
    calls.closed.push({ number, comment: opts?.comment ?? "" });
  };
  gfm.createPullRequest = async (head, base, title, body) => {
    calls.created.push({ head, base, title, body });
    return { url: "https://example.invalid/pr/1", action: "updated" };
  };
  gfm.getGitHubRelease = async () => null;
  gfm.deleteGitHubRelease = async (id) => {
    calls.deletedReleases.push(id);
  };
  Object.assign(gfm, overrides);

  return { gfm, agent: new ReleaseAgent(gfm, repo) };
}

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "revert-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  repo = mkdtempSync(join(tmpdir(), "revert-apply-"));
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

const remoteTags = () =>
  execFileSync("git", ["ls-remote", "--tags", origin], { encoding: "utf8" });

const remoteHeads = () =>
  execFileSync("git", ["ls-remote", "--heads", origin], { encoding: "utf8" });

test("reverting an RC rewinds VERSION and removes the tag everywhere", async () => {
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.shape, "revert");
  assert.equal(result.revertedVersion, "1.4.0-RC.2");
  assert.equal(result.resultingVersion, "1.4.0-RC.1");

  // VERSION is back, by a revert commit rather than a rewind.
  assert.equal(git("show", "HEAD:VERSION").split("\n")[0], "1.4.0-RC.1");
  assert.match(git("log", "-1", "--pretty=format:%s"), /^Revert "To version 1\.4\.0-RC\.2"$/);
  assert.equal(git("rev-list", "--count", "release/1.4.0"), "4");

  // The tag is gone on both sides; the older one is untouched.
  assert.equal(gitQuiet("tag", "-l", "1.4.0-RC.2"), "");
  assert.equal(gitQuiet("tag", "-l", "1.4.0-RC.1"), "1.4.0-RC.1");
  assert.ok(!remoteTags().includes("refs/tags/1.4.0-RC.2"));
  assert.ok(remoteTags().includes("refs/tags/1.4.0-RC.1"));

  // The revert reached origin, and the branch still exists.
  assert.ok(remoteHeads().includes("refs/heads/release/1.4.0"));
  assert.equal(
    git("rev-parse", "HEAD"),
    git("rev-parse", "refs/remotes/origin/release/1.4.0")
  );
  assert.equal(git("status", "--porcelain"), "");
});

test("reverting a final version deletes its GitHub release", async () => {
  releaseBranchAtRC2();
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version("1.4.0"), "To version 1.4.0");
  tagVersion("1.4.0");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0");

  const { agent } = makeAgent({
    getGitHubRelease: async () => ({
      id: 4242,
      url: "https://example.invalid/releases/1.4.0",
      name: "Release 1.4.0",
    }),
  });

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.resultingVersion, "1.4.0-RC.2");
  assert.deepEqual(calls.deletedReleases, [4242]);
  assert.equal(result.releaseDeletedUrl, "https://example.invalid/releases/1.4.0");
  assert.ok(!remoteTags().includes("refs/tags/1.4.0\n"));
});

test("a final whose RC was merged into develop rewinds to that RC", async () => {
  releaseBranchAtRC0();
  git("checkout", "-q", "develop");
  git("merge", "-q", "--no-ff", "-m", "Merge release/1.5.0", "release/1.5.0");
  git("push", "-q", "origin", "develop");
  git("checkout", "-q", "release/1.5.0");
  commit("VERSION", version("1.5.0"), "To version 1.5.0");
  tagVersion("1.5.0");
  git("push", "-q", "origin", "release/1.5.0", "1.5.0");
  const { agent } = makeAgent();

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.shape, "revert");
  assert.equal(result.resultingVersion, "1.5.0-RC.0");
  assert.ok(remoteHeads().includes("refs/heads/release/1.5.0"));
  assert.ok(remoteTags().includes("refs/tags/1.5.0-RC.0"));
  assert.equal(git("show", "HEAD:VERSION").split("\n")[0], "1.5.0-RC.0");
});

test("abandoning an RC.0 deletes the branch on origin and locally", async () => {
  releaseBranchAtRC0();
  const { agent } = makeAgent({
    findOpenPullRequest: async () => ({
      number: 77,
      url: "https://example.invalid/pr/77",
      title: "RC 1.5.0-RC.0 to develop",
      body: "",
    }),
  });

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.shape, "abandon");
  assert.equal(result.branchDeleted, true);

  assert.ok(!remoteHeads().includes("refs/heads/release/1.5.0"));
  assert.equal(gitQuiet("rev-parse", "--verify", "-q", "release/1.5.0"), "");
  assert.ok(!remoteTags().includes("refs/tags/1.5.0-RC.0"));
  assert.equal(gitQuiet("tag", "-l", "1.5.0-RC.0"), "");

  // We are left somewhere sensible rather than on a deleted branch.
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "develop");

  // The PR was closed with an explanation naming the recovery path.
  assert.equal(calls.closed.length, 1);
  assert.equal(calls.closed[0].number, 77);
  assert.match(calls.closed[0].comment, /abandoned rather than rewound/);
  assert.match(calls.closed[0].comment, /git branch release\/1\.5\.0/);
});

test("a failing pull request step does not undo the revert", async () => {
  releaseBranchAtRC2();
  const { agent } = makeAgent({
    findOpenPullRequest: async () => ({
      number: 9,
      url: "u",
      title: "t",
      body: "",
    }),
    createPullRequest: async () => {
      throw new Error("GitHub is down");
    },
  });

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.match(result.pullRequestError, /GitHub is down/);
  // The git side still happened and was pushed.
  assert.equal(git("show", "HEAD:VERSION").split("\n")[0], "1.4.0-RC.1");
  assert.ok(!remoteTags().includes("refs/tags/1.4.0-RC.2"));
});

test("a dry run inspects and refuses to touch anything", async () => {
  releaseBranchAtRC2();
  const { agent } = makeAgent();

  const before = {
    head: git("rev-parse", "HEAD"),
    refs: git("show-ref"),
    status: git("status", "--porcelain"),
    remoteTags: remoteTags(),
  };

  await agent.executeRevertVersionWorkflow(repo, undefined, true);

  assert.equal(git("rev-parse", "HEAD"), before.head);
  assert.equal(git("show-ref"), before.refs);
  assert.equal(git("status", "--porcelain"), before.status);
  assert.equal(remoteTags(), before.remoteTags);
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.deletedReleases.length, 0);
});

test("a tag that only exists locally is still cleaned up", async () => {
  releaseBranchAtRC2();
  // Drop the tag from origin, leaving the local one behind — the state a failed
  // push leaves, and the state a previous hand-rolled revert leaves.
  execFileSync("git", ["push", "-q", origin, ":refs/tags/1.4.0-RC.2"], {
    cwd: repo,
  });

  const { agent } = makeAgent();
  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.tagDeletedLocally, true);
  assert.equal(result.tagDeletedRemotely, false);
  assert.equal(gitQuiet("tag", "-l", "1.4.0-RC.2"), "");
});

test("a version set by something other than a bump commit is refused untouched", async () => {
  releaseBranchAtRC2();
  // A readable version, but set by a commit that is not a version bump — so there
  // is no bump commit to revert and guessing at an earlier one would be a mutation
  // on an unverified target.
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version("1.4.0-RC.9"), "Hand-edit VERSION");
  git("push", "-q", "origin", "release/1.4.0");

  const { agent } = makeAgent();
  const before = { head: git("rev-parse", "HEAD"), refs: git("show-ref") };

  await assert.rejects(
    () => agent.executeRevertVersionWorkflow(repo, undefined, false),
    /Hand-edit VERSION/
  );

  assert.equal(git("rev-parse", "HEAD"), before.head);
  assert.equal(git("show-ref"), before.refs);
  assert.equal(git("status", "--porcelain"), "");
  assert.ok(existsSync(join(repo, "VERSION")));
  assert.ok(remoteTags().includes("refs/tags/1.4.0-RC.2"));
});

/**
 * Make origin reject deletions of refs matching `pattern`, as a protected branch,
 * a tag protection rule or a pre-receive hook would.
 */
function rejectDeletesOf(pattern) {
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "while read old new ref; do",
      `  case "$ref" in ${pattern})`,
      '    if [ "$new" = "0000000000000000000000000000000000000000" ]; then',
      '      echo "deleting $ref is not allowed" >&2; exit 1',
      "    fi;;",
      "  esac",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
}

test("an abandon whose tag deletion origin rejects fails and changes nothing else", async () => {
  releaseBranchAtRC0();
  rejectDeletesOf("refs/tags/*");
  const { agent } = makeAgent({
    findOpenPullRequest: async () => ({ number: 77, url: "u", title: "t", body: "" }),
  });

  await assert.rejects(
    () => agent.executeRevertVersionWorkflow(repo, undefined, false),
    (error) => {
      assert.match(error.message, /Origin refused to delete tag 1\.5\.0-RC\.0/);
      assert.match(error.message, /git push origin :refs\/tags\/1\.5\.0-RC\.0/);
      return true;
    }
  );

  assert.ok(remoteTags().includes("refs/tags/1.5.0-RC.0"));
  assert.ok(remoteHeads().includes("refs/heads/release/1.5.0"));
  assert.equal(calls.closed.length, 0);
});

test("an abandon whose branch deletion origin rejects does not report the branch deleted", async () => {
  releaseBranchAtRC0();
  rejectDeletesOf("refs/heads/*");
  const { agent } = makeAgent();

  await assert.rejects(
    () => agent.executeRevertVersionWorkflow(repo, undefined, false),
    (error) => {
      assert.match(error.message, /Origin refused to delete release\/1\.5\.0/);
      assert.match(error.message, /git push origin --delete release\/1\.5\.0/);
      return true;
    }
  );

  assert.ok(remoteHeads().includes("refs/heads/release/1.5.0"));
  assert.ok(!remoteTags().includes("refs/tags/1.5.0-RC.0"));
  // The local copy is kept while origin still has the branch.
  assert.notEqual(gitQuiet("rev-parse", "--verify", "-q", "release/1.5.0"), "");
});

test("a revert whose tag deletion origin rejects fails before pushing", async () => {
  releaseBranchAtRC2();
  rejectDeletesOf("refs/tags/*");
  const pushed = git("rev-parse", "origin/release/1.4.0");
  const { agent } = makeAgent();

  await assert.rejects(
    () => agent.executeRevertVersionWorkflow(repo, undefined, false),
    /Origin refused to delete tag 1\.4\.0-RC\.2/
  );

  assert.ok(remoteTags().includes("refs/tags/1.4.0-RC.2"));
  assert.equal(
    execFileSync("git", ["rev-parse", "release/1.4.0"], { cwd: origin, encoding: "utf8" }).trim(),
    pushed
  );
});

/** release/1.4.0 promoted from RC.2 to 1.4.0, pushed with its tag. */
function promotedRelease() {
  releaseBranchAtRC2();
  git("checkout", "-q", "release/1.4.0");
  commit("VERSION", version("1.4.0"), "To version 1.4.0");
  tagVersion("1.4.0");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0");
}

const openPr = (number, title) => ({
  number,
  url: `https://example.invalid/pr/${number}`,
  title,
  body: "",
});

test("reverting a promoted release undoes the promotion's pull requests", async () => {
  promotedRelease();
  const { agent } = makeAgent({
    findOpenPullRequest: async (head, base) =>
      base === "develop"
        ? openPr(70, "Release 1.4.0 to develop")
        : openPr(71, "Release 1.4.0 to main"),
  });

  const plan = await agent.planRevertVersion();
  assert.ok(
    plan.mutations.some(
      (m) =>
        m.operation === "close" &&
        m.summary ===
          "close PR #71 (release/1.4.0 → main), opened by the promotion being reverted"
    ),
    plan.mutations.map((m) => m.summary).join("\n")
  );

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  // The develop PR goes back to the candidate's title...
  assert.deepEqual(
    calls.created.map((c) => `${c.base}: ${c.title}`),
    ["develop: RC 1.4.0-RC.2 to develop"]
  );
  // ...and the promotion's PR into main is closed, saying why.
  assert.equal(calls.closed.length, 1);
  assert.equal(calls.closed[0].number, 71);
  assert.match(calls.closed[0].comment, /1\.4\.0 was reverted/);
  assert.equal(result.promotionPullRequestUrl, "https://example.invalid/pr/71");
});

test("a failure closing the promotion's pull request is reported, not thrown", async () => {
  promotedRelease();
  const { agent } = makeAgent({
    findOpenPullRequest: async (head, base) =>
      base === "main" ? openPr(71, "Release 1.4.0 to main") : null,
    closePullRequest: async () => {
      throw new Error("GitHub is down");
    },
  });

  const result = await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(result.resultingVersion, "1.4.0-RC.2");
  assert.match(result.promotionPullRequestError, /GitHub is down/);
});

test("reverting a hotfix final keeps the production warning on its main PR", async () => {
  git("checkout", "-q", "-b", "hotfix/1.3.1", "main");
  commit("VERSION", version("1.3.1-RC.0"), "To version 1.3.1-RC.0");
  tagVersion("1.3.1-RC.0");
  commit("VERSION", version("1.3.1"), "To version 1.3.1");
  tagVersion("1.3.1");
  git("push", "-q", "origin", "hotfix/1.3.1", "1.3.1-RC.0", "1.3.1");

  const { agent } = makeAgent({
    findOpenPullRequest: async (head, base) =>
      base === "main" ? openPr(42, "Release 1.3.1 to main") : null,
  });

  await agent.executeRevertVersionWorkflow(repo, undefined, false);

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].title, "RC 1.3.1-RC.0 to main");
  assert.match(
    calls.created[0].body,
    /This PR must be merged \*\*after\*\* the hotfix has been deployed to production\./
  );
  // A hotfix's PR into main is its own; it is retitled, not closed.
  assert.equal(calls.closed.length, 0);
});
