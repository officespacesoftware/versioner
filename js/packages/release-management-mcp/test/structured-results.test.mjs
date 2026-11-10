import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  GitFlowManager,
  ReleaseAgent,
  describeManualDownmerge,
} from "@officespacesoftware/release-management-core";
import {
  OUTPUT_SCHEMAS,
  createdOutput,
  downmergeOutput,
  incrementOutput,
  releaseOutput,
  revertOutput,
  structuredHandoff,
  structuredPlan,
} from "../lib/structured.js";

const GITHUB_URL = "https://github.com/acme/widgets.git";
const REPO_URL = "https://github.com/acme/widgets";
const validator = new AjvJsonSchemaValidator();

let repo;
let origin;
let github;

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (file, contents, message) => {
  writeFileSync(join(repo, file), contents);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

const bump = (v) => {
  const sha = commit("VERSION", `${v}\nabc1234def56\n`, `To version ${v}`);
  git("tag", v, "-a", "-m", `Release version ${v}`);
  return sha;
};

const assertValid = (tool, output) => {
  const result = validator.getValidator(OUTPUT_SCHEMAS[tool])(output);
  assert.ok(result.valid, result.errorMessage);
  return output;
};

const prUrl = (number) => `${REPO_URL}/pull/${number}`;

const makeAgent = async ({ open = [] } = {}) => {
  github = { open: [...open], created: [], closed: [], releases: [] };
  const gfm = new GitFlowManager(repo);
  gfm.findOpenPullRequest = async (head, base) => {
    const pr = github.open.find((p) => p.head === head && p.base === base);
    return pr ? { number: pr.number, url: prUrl(pr.number), title: "t", body: "" } : null;
  };
  gfm.findOpenPullRequestsFrom = async (head) =>
    github.open.filter((p) => p.head === head).map((p) => ({ number: p.number }));
  gfm.findOpenPullRequestsInto = async () => [];
  gfm.createPullRequest = async (head, base, title, body, draft = false) => {
    github.created.push({ head, base, title, draft });
    const existing = github.open.find((p) => p.head === head && p.base === base);
    if (existing) {
      return { url: prUrl(existing.number), action: "updated" };
    }
    const number = 100 + github.created.length;
    github.open.push({ number, head, base });
    return { url: prUrl(number), action: "created" };
  };
  gfm.closePullRequest = async (number) => {
    github.closed.push(number);
  };
  gfm.createGitHubRelease = async (version) => {
    github.releases.push(version);
    return { url: `${REPO_URL}/releases/tag/${version}` };
  };
  gfm.getGitHubRelease = async () => null;
  const agent = new ReleaseAgent(gfm, repo);
  await agent.initialize();
  return agent;
};

const apply = { dryRun: false };

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "mcp-results-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  repo = mkdtempSync(join(tmpdir(), "mcp-results-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", GITHUB_URL);
  git("config", `url.${origin}.insteadOf`, GITHUB_URL);
  bump("1.3.0");
  commit("deps.lock", "a\n", "Lock dependencies");
  git("checkout", "-q", "-b", "develop");
  commit("feature.txt", "f\n", "Add a feature");
  git("push", "-q", "origin", "main", "develop", "1.3.0");
});

afterEach(() => {
  for (const dir of [repo, origin]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a create_release_candidate plan and its result", async () => {
  const agent = await makeAgent();
  const plan = await agent.planCreateReleaseCandidate("minor");

  const planned = assertValid("create_release_candidate", {
    kind: "plan",
    tool: "create_release_candidate",
    plan: structuredPlan(plan),
  });
  assert.equal(planned.plan.digest, plan.digest);
  assert.deepEqual(
    planned.plan.mutations.map((m) => `${m.operation}:${m.kind}`),
    [
      "create:branch",
      "create:commit",
      "create:tag",
      "create:push",
      "create:pull-request",
    ]
  );
  assert.equal(planned.plan.review.ships.count, 1);
  assert.equal(planned.plan.review.ships.commits[0].subject, "Add a feature");
  assert.deepEqual(planned.plan.checks, []);

  const result = await agent.executeRCWorkflow("minor", repo, false);
  const output = assertValid(
    "create_release_candidate",
    createdOutput({
      tool: "create_release_candidate",
      result,
      plan,
      ...apply,
      steps: agent.getWorkflowSteps(),
    })
  );

  assert.deepEqual(
    { ...output.result, steps: undefined, nextSteps: undefined },
    {
      dryRun: false,
      branch: { name: "release/1.4.0", change: "created", base: "develop" },
      from: "1.3.0",
      to: "1.4.0-RC.0",
      resumed: false,
      tag: { name: "1.4.0-RC.0", change: "created" },
      pullRequests: [
        {
          number: 101,
          url: prUrl(101),
          head: "release/1.4.0",
          base: "develop",
          title: "RC 1.4.0-RC.0 to develop",
          change: "opened",
        },
      ],
      warnings: [],
      notices: [],
      problems: [],
      steps: undefined,
      nextSteps: undefined,
    }
  );
  assert.ok(output.result.steps.every((s) => s.status === "completed"));
  assert.equal(output.result.nextSteps[0], `Review the pull request: ${prUrl(101)}`);
});

test("a create_hotfix result shows both pull requests, the develop one a draft", async () => {
  const agent = await makeAgent();
  const plan = await agent.planCreateHotfix();
  assertValid("create_hotfix", {
    kind: "plan",
    tool: "create_hotfix",
    plan: structuredPlan(plan),
  });
  assert.deepEqual(structuredPlan(plan).notices.map((n) => n.code), ["N2"]);

  const result = await agent.executeHotfixWorkflow(repo, false);
  const output = assertValid(
    "create_hotfix",
    createdOutput({
      tool: "create_hotfix",
      result,
      plan,
      ...apply,
      steps: agent.getWorkflowSteps(),
    })
  );

  assert.deepEqual(output.result.pullRequests, [
    {
      number: 101,
      url: prUrl(101),
      head: "hotfix/1.3.1",
      base: "main",
      title: "RC 1.3.1-RC.0 to main",
      change: "opened",
    },
    {
      number: 102,
      url: prUrl(102),
      head: "hotfix/1.3.1",
      base: "develop",
      title: "Hotfix 1.3.1 to develop",
      change: "opened",
      draft: true,
    },
  ]);
  assert.equal(output.result.branch.base, "main");
  assert.equal(output.result.nextSteps.length, 6);
});

test("an increment that conflicts with develop returns its handoff and pipeline", async () => {
  git("checkout", "-q", "main");
  commit(
    ".release-management.json",
    JSON.stringify({ pipeline: { trigger: "echo pipeline queued" } }),
    "Configure the pipeline trigger"
  );
  git("checkout", "-q", "develop");
  git("merge", "-q", "--no-edit", "main");
  git("push", "-q", "origin", "main", "develop");
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.1");
  commit("deps.lock", "c\n", "Upgrade a dependency on the release");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");
  git("checkout", "-q", "develop");
  commit("deps.lock", "b\n", "Upgrade a dependency on develop");
  git("push", "-q", "origin", "develop");

  const agent = await makeAgent();
  const plan = await agent.planIncrementRC("1.4.0");
  const planned = assertValid("increment_release_candidate", {
    kind: "plan",
    tool: "increment_release_candidate",
    plan: structuredPlan(plan),
  });
  assert.equal(planned.plan.mergePreview.code, "N8");
  assert.equal(planned.plan.pipelineTrigger.code, "T1");
  assert.equal(planned.plan.review.ships.count, 1);

  const result = await agent.executeIncrementRCWorkflow(repo, "1.4.0", false);
  const output = assertValid(
    "increment_release_candidate",
    incrementOutput({ result, plan, ...apply, steps: agent.getWorkflowSteps() })
  );

  assert.equal(output.result.to, "1.4.0-RC.2");
  assert.deepEqual(output.result.tag, { name: "1.4.0-RC.2", change: "created" });
  assert.deepEqual(output.result.pullRequests, []);
  assert.equal(output.result.pipeline.status, "started");
  assert.equal(output.result.pipeline.code, "T2");
  assert.equal(output.result.pipeline.output, "pipeline queued");
  const handoff = output.result.manualDownmerge;
  assert.equal(handoff.code, "H1");
  assert.deepEqual(handoff.increment, { version: "1.4.0-RC.2" });
  assert.deepEqual(handoff.conflictedFiles, ["deps.lock"]);
  assert.match(output.result.nextSteps[0], /manual downmerge of release\/1\.4\.0 into develop/);
});

test("a release_version result carries the release and both pull requests", async () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.1");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1");

  const agent = await makeAgent({
    open: [{ number: 41, head: "release/1.4.0", base: "develop" }],
  });
  const plan = await agent.planReleaseVersion("1.4.0");
  const planned = assertValid("release_version", {
    kind: "plan",
    tool: "release_version",
    plan: structuredPlan(plan),
  });
  assert.equal(planned.plan.review.sinceVersion.count, 0);
  assert.equal(planned.plan.review.ships.base, "main");
  const developPr = planned.plan.mutations.find(
    (m) => m.kind === "pull-request" && m.ref.base === "develop"
  );
  assert.equal(developPr.operation, "update");
  assert.equal(developPr.ref.number, 41);

  const result = await agent.executeReleaseWorkflow(repo, "1.4.0", false);
  const output = assertValid(
    "release_version",
    releaseOutput({ result, plan, ...apply, steps: agent.getWorkflowSteps() })
  );

  assert.deepEqual(output.result.githubRelease, {
    tag: "1.4.0",
    change: "created",
    url: `${REPO_URL}/releases/tag/1.4.0`,
  });
  assert.deepEqual(
    output.result.pullRequests.map(({ number, base, change, title }) => ({
      number,
      base,
      change,
      title,
    })),
    [
      { number: 101, base: "main", change: "opened", title: "Release 1.4.0 to main" },
      { number: 41, base: "develop", change: "updated", title: "Release 1.4.0 to develop" },
    ]
  );
  assert.equal(output.result.from, "1.4.0-RC.1");
  assert.equal(output.result.to, "1.4.0");
});

test("a revert_version result shows the deleted tag and the updated pull request", async () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.1");
  bump("1.4.0-RC.2");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.1", "1.4.0-RC.2");

  const agent = await makeAgent({
    open: [{ number: 41, head: "release/1.4.0", base: "develop" }],
  });
  const plan = await agent.planRevertVersion("1.4.0");
  const planned = assertValid("revert_version", {
    kind: "plan",
    tool: "revert_version",
    plan: structuredPlan(plan),
  });
  assert.equal(planned.plan.shape, "revert");
  assert.deepEqual(planned.plan.review.reverts.files, ["VERSION"]);

  const result = await agent.executeRevertVersionWorkflow(repo, "1.4.0", false);
  const output = assertValid(
    "revert_version",
    revertOutput({ result, plan, ...apply, steps: agent.getWorkflowSteps() })
  );

  assert.equal(output.result.shape, "revert");
  assert.deepEqual(output.result.tag, {
    name: "1.4.0-RC.2",
    change: "deleted",
    deletedLocally: true,
    deletedOnOrigin: true,
  });
  assert.deepEqual(output.result.pullRequests, [
    {
      number: 41,
      url: prUrl(41),
      head: "release/1.4.0",
      base: "develop",
      title: "RC 1.4.0-RC.1 to develop",
      change: "updated",
    },
  ]);
  assert.deepEqual(output.result.branch, { name: "release/1.4.0", change: "updated" });
});

test("an abandon result shows the deleted branch and the closed pull request", async () => {
  git("checkout", "-q", "-b", "release/1.4.0", "develop");
  bump("1.4.0-RC.0");
  git("push", "-q", "origin", "release/1.4.0", "1.4.0-RC.0");
  git("checkout", "-q", "develop");

  const agent = await makeAgent({
    open: [{ number: 52, head: "release/1.4.0", base: "develop" }],
  });
  const plan = await agent.planRevertVersion("1.4.0");
  assert.deepEqual(
    structuredPlan(plan).warnings.map((w) => w.code),
    ["W13"]
  );

  const result = await agent.executeRevertVersionWorkflow(repo, "1.4.0", false);
  const output = assertValid(
    "revert_version",
    revertOutput({ result, plan, ...apply, steps: agent.getWorkflowSteps() })
  );

  assert.equal(output.result.shape, "abandon");
  assert.equal(output.result.to, undefined);
  assert.deepEqual(output.result.branch, { name: "release/1.4.0", change: "deleted" });
  assert.deepEqual(output.result.pullRequests.map((p) => [p.number, p.change]), [
    [52, "closed"],
  ]);
  assert.deepEqual(github.closed, [52]);
});

test("a downmerge result names its merge branch and what it superseded", () => {
  const route = { source: "hotfix", target: "develop" };
  const output = assertValid(
    "downmerge",
    downmergeOutput({
      route,
      result: {
        kind: "merge-branch",
        pullRequestUrl: prUrl(104),
        mergeBranchName: "hotfix-1.3.1-into-develop-1762351700",
        superseded: {
          head: "hotfix/1.3.1",
          base: "develop",
          number: 91,
          url: prUrl(91),
        },
      },
      warnings: [],
      notices: [],
      plan: {
        action: "downmerge hotfix → develop",
        targetBranch: "develop",
        targetBranchHead: "f5e771b41ba0000000000000000000000000000a",
        mutations: [
          {
            kind: "pull-request",
            summary: "open hotfix-1.3.1-into-develop-<unix-timestamp> → develop",
            ref: {
              head: "hotfix-1.3.1-into-develop-<unix-timestamp>",
              base: "develop",
              title: "Hotfix 1.3.1 to develop",
            },
          },
        ],
        warnings: [],
        notices: [],
        digest: "abcdef",
      },
    })
  );

  assert.deepEqual(output.result.route, route);
  assert.equal(output.result.mergeBranch, "hotfix-1.3.1-into-develop-1762351700");
  assert.deepEqual(output.result.pullRequests, [
    {
      number: 104,
      url: prUrl(104),
      head: "hotfix-1.3.1-into-develop-1762351700",
      base: "develop",
      title: "Hotfix 1.3.1 to develop",
      change: "opened",
    },
    {
      number: 91,
      url: prUrl(91),
      head: "hotfix/1.3.1",
      base: "develop",
      change: "superseded",
    },
  ]);
  assert.deepEqual(output.result.nextSteps, [
    "Review the pull request and CI checks, or close it to reject the downmerge",
    "Merge once green",
  ]);
});

test("a downmerge's notes carry their codes, and a close it could not make is a problem", () => {
  const route = { source: "release", target: "main" };
  const output = assertValid(
    "downmerge",
    downmergeOutput({
      route,
      result: {
        kind: "merge-branch",
        pullRequestUrl: prUrl(110),
        mergeBranchName: "release-1.4.0-into-main-1762351600",
        superseded: { head: "release/1.4.0", base: "main", error: "403" },
      },
      warnings: [],
      notices: [
        "PR #7 is already open for release/1.4.0 → main; it will be updated, not created.",
      ],
      plan: {
        action: "downmerge release → main",
        targetBranch: "main",
        targetBranchHead: "0c9d8e7f6a50000000000000000000000000000b",
        mutations: [],
        warnings: [],
        notices: [],
        digest: "abcdef",
      },
    })
  );

  assert.deepEqual(output.result.notices.map((n) => n.code), ["N1"]);
  assert.deepEqual(output.result.problems, [{ code: "R9", text: "403" }]);
  assert.equal(output.result.pullRequests.length, 1);
});

test("both handoffs validate as downmerge output", () => {
  for (const route of [
    { source: "release", target: "develop" },
    { source: "release", target: "main" },
  ]) {
    const handoff = structuredHandoff(
      describeManualDownmerge({
        route,
        sourceBranch: "release/1.4.0",
        version: "1.4.0",
        conflictedFiles: ["deps.lock"],
        pullRequestTitle: `Release 1.4.0 to ${route.target}`,
      })
    );
    assertValid("downmerge", { kind: "handoff", tool: "downmerge", handoff });
  }
});

test("refusals, failures and stale plans validate for every planning tool", async () => {
  const agent = await makeAgent();
  const plan = structuredPlan(await agent.planCreateReleaseCandidate("minor"));
  for (const tool of [
    "create_release_candidate",
    "create_hotfix",
    "increment_release_candidate",
    "release_version",
    "revert_version",
  ]) {
    assertValid(tool, { kind: "refused", tool, code: "P2", text: "Tag x already exists" });
    assertValid(tool, {
      kind: "failed",
      tool,
      code: "A18",
      text: "Failed to push",
      steps: [{ step: 1, name: "Select", status: "completed" }],
    });
    assertValid(tool, {
      kind: "stale",
      tool,
      code: "D1",
      text: "The repository changed since this plan was created.",
      provided: "000000",
      plan,
    });
  }
  const invalid = validator.getValidator(OUTPUT_SCHEMAS.create_hotfix)({
    kind: "plan",
    tool: "create_hotfix",
    plan: { ...plan, mutations: [{ kind: "tag", operation: "rename", summary: "x" }] },
  });
  assert.equal(invalid.valid, false);
});
