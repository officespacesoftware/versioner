// Node built-in test runner. Run from the package root with:
//   node --test test/structured.test.mjs
//
// The structured reply passes through an LLM: each part is checked, a bad
// one falls back to the text, and no URL from it reaches Slack unless it
// is built from GITHUB_REPO_URL or already starts with it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStructuredPlan } from "../lib/plan.js";
import { parseAgentReply } from "../lib/reply.js";
import { isStartable, changesOriginAtOnce } from "../lib/requests.js";
import { renderApplied } from "../lib/results.js";
import { branchUrl, compareUrl, pullUrl, safeUrl } from "../lib/links.js";
import { digestOf, readOutput } from "../lib/structured.js";
import { fixtures, REPO, replyFor, signed } from "./mockup-messages.mjs";

const text = (value) => JSON.stringify(value);
const ctx = {
  tool: "release_version",
  digest: "9a570f",
  requester: "U1",
  agentLink: "https://cursor.com/agents/bc-1",
  repoUrl: REPO,
};
const awaiting = { kind: "awaiting", buttonValue: "{}", tier: "risky" };

test("every fixture from the MCP reads as its own kind", () => {
  for (const [name, output] of Object.entries(fixtures)) {
    const read = readOutput(output);
    assert.ok(read, name);
    assert.equal(read.kind, output.kind, name);
  }
});

test("a plan reply with a valid structure renders from it", () => {
  const reply = replyFor(fixtures["plan-release-warnings"]);
  assert.equal(reply.kind, "plan");
  assert.equal(reply.digest, "9a570f");
  assert.equal(reply.plan.mutations.length, 6);
});

test("a plan whose structure is wrong falls back to the plan text", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  output.plan.mutations[0].operation = "rename";

  const reply = parseAgentReply(
    text({
      kind: "plan",
      tool: "release_version",
      digest: "9a570f",
      planText: "Action:  release_version",
      output,
    })
  );

  assert.equal(reply.kind, "plan");
  assert.equal(reply.plan, undefined);
  assert.equal(reply.planText, "Action:  release_version");
});

test("a structure whose digest differs from the reply's is not trusted", () => {
  const reply = parseAgentReply(
    text({
      kind: "plan",
      tool: "release_version",
      digest: "000000",
      planText: "Action:  release_version",
      output: fixtures["plan-release-warnings"],
    })
  );

  assert.equal(reply.plan, undefined);
  assert.equal(reply.digest, "000000");
});

test("a reply with neither a valid structure nor text is unreadable", () => {
  const reply = parseAgentReply(
    text({ kind: "plan", output: { kind: "plan" } })
  );
  assert.equal(reply.kind, "error");
  assert.match(reply.text, /could not be read/);
});

test("a dropped field that is only shown does not discard the plan", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  output.plan.review.ships.commits[0] = { sha: 7 };
  output.plan.checks[0].status = "weird";

  const reply = replyFor(output);

  assert.ok(reply.plan);
  assert.equal(reply.plan.review.ships.commits.length, 42);
  assert.equal(reply.plan.checks.length, 1);
});

test("a missing warning list is not read as no warnings", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  delete output.plan.warnings;

  assert.equal(replyFor(output).plan, undefined);
});

test("URLs in the structure are ignored; links are built from the repo URL", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  const evil = "https://evil.example/x";
  output.plan.mutations[3].ref.url = evil;
  output.plan.review.repoUrl = "https://evil.example";
  output.plan.review.ships.compareUrl = evil;
  const plan = replyFor(output).plan;

  const blocks = renderStructuredPlan(plan, ctx, awaiting);

  assert.doesNotMatch(text(blocks), /evil\.example/);
  assert.match(text(blocks), new RegExp(`${REPO}/pull/67`));
});

test("without GITHUB_REPO_URL nothing is linked", () => {
  const plan = replyFor(fixtures["plan-release-warnings"]).plan;

  const blocks = renderStructuredPlan(
    plan,
    { ...ctx, repoUrl: undefined },
    awaiting
  );

  assert.doesNotMatch(text(blocks), /"url":"|<https:\/\/github/);
  assert.match(text(blocks), /`release\/1\.0\.0`/);
});

test("a name that is not a branch or version is never put in a link", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  output.plan.targetBranch = "release/1.0.0|<!channel>";

  const blocks = renderStructuredPlan(
    replyFor(signed(output)).plan,
    ctx,
    awaiting
  );

  assert.doesNotMatch(text(blocks), /<!channel>/);
  assert.match(text(blocks), /&lt;!channel&gt;/);
});

test("text from the structure cannot inject mentions or links", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  output.plan.notices.push({ text: "<!here> <https://evil.example|click>" });
  output.plan.warnings[0].text = "<!channel> <https://evil.example|click>";

  const blocks = renderStructuredPlan(
    replyFor(signed(output)).plan,
    ctx,
    awaiting
  );
  const mrkdwn = blocks
    .filter((b) => b.type !== "rich_text")
    .map((b) => text(b))
    .join("");

  assert.doesNotMatch(mrkdwn, /<!here>|<!channel>|<https:\/\/evil/);
  const warning = blocks.find((b) => /warning to decide/.test(text(b)));
  assert.match(text(warning), /"type":"text","text":"<!channel>/);
});

test("an applied pull request's URL is used only inside the repository", () => {
  const output = structuredClone(fixtures["applied-downmerge"]);
  delete output.result.pullRequests[0].number;
  output.result.pullRequests[0].url = "https://evil.example/pull/1";
  const card = (o) =>
    text(
      renderApplied(replyFor(o), {
        requester: "U1",
        agentLink: "x",
        repoUrl: REPO,
      })
    );

  assert.doesNotMatch(card(output), /evil\.example/);

  output.result.pullRequests[0].url = `${REPO}/pull/102`;
  assert.match(card(output), /pull\/102\|pull request/);
});

test("the URL checks", () => {
  assert.equal(safeUrl(REPO, `${REPO}/pull/3`), `${REPO}/pull/3`);
  assert.equal(safeUrl(REPO, `${REPO}-evil/pull/3`), undefined);
  assert.equal(safeUrl(REPO, "https://evil.example/"), undefined);
  assert.equal(safeUrl(REPO, `${REPO}/pull/3|x`), undefined);
  assert.equal(safeUrl(REPO, `${REPO}/../x`), undefined);
  assert.equal(safeUrl(undefined, `${REPO}/pull/3`), undefined);
  assert.equal(branchUrl(REPO, "release/1.0.0"), `${REPO}/tree/release/1.0.0`);
  assert.equal(branchUrl(REPO, "release/../x"), undefined);
  assert.equal(branchUrl(REPO, "feature/x"), undefined);
  assert.equal(pullUrl(REPO, 0), undefined);
  assert.equal(pullUrl(REPO, 1.5), undefined);
  assert.equal(compareUrl(REPO, "1.0.0", "x y"), undefined);
});

test("an H1 the agent carried out becomes an applied downmerge", () => {
  const reply = replyFor(fixtures["handoff-develop"], {
    resolution: {
      pullRequest: 74,
      branch: "hotfix-1.4.1-into-develop-1762351700",
      resolvedFiles: [{ path: "VERSION", reason: "kept develop's" }],
    },
  });

  assert.equal(reply.kind, "applied");
  assert.equal(reply.tool, "downmerge");
  assert.equal(reply.resolution.pullRequest, 74);
});

test("a resolution on a branch the handoff did not name is ignored", () => {
  const reply = replyFor(fixtures["handoff-develop"], {
    resolution: { pullRequest: 74, branch: "main", resolvedFiles: [] },
  });

  assert.equal(reply.kind, "handoff");
});

test("H2 always stops, even with a resolution", () => {
  const reply = replyFor(fixtures["handoff-main"], {
    resolution: {
      pullRequest: 74,
      branch: "release-1.0.0-into-main-1762351700",
      resolvedFiles: [],
    },
  });

  assert.equal(reply.kind, "handoff");
  assert.equal(reply.handoff.code, "H2");
});

test("an ambiguity refusal becomes a choice between its branches", () => {
  const reply = replyFor(fixtures["refused-ambiguous"]);

  assert.equal(reply.kind, "choose");
  assert.deepEqual(
    reply.options.map((o) => o.request),
    ["promote release/1.5.0", "promote hotfix/1.5.0"]
  );
});

test("choose options outside the grammar are dropped", () => {
  const reply = parseAgentReply(
    text({
      kind: "choose",
      tool: "release_version",
      options: [
        { branch: "release/1.5.0", request: "promote release/1.5.0" },
        { branch: "hotfix/1.5.0", request: "promote hotfix/1.5.0; rm -rf" },
      ],
    })
  );

  assert.equal(reply.kind, "message");
  assert.match(reply.text, /full branch name/);
});

test("the old text-only contract still reads", () => {
  assert.equal(
    parseAgentReply(text({ kind: "applied", tool: "x", summary: "done" })).kind,
    "applied"
  );
  assert.equal(
    parseAgentReply(text({ kind: "message", text: "hi" })).kind,
    "message"
  );
});

test("the start-request grammar", () => {
  for (const ok of [
    "create an RC",
    "create an RC patch",
    "increment the RC release/1.4.0",
    "promote 1.5.0-RC.1",
    "promote hotfix/1.5.0",
    "hotfix",
    "revert release/1.4.0",
    "downmerge main to develop",
    "downmerge release 1.4.0 to main",
    "list",
    "help",
  ]) {
    assert.ok(isStartable(ok), ok);
  }
  for (const bad of [
    "promote",
    "promote latest",
    "downmerge release to main",
    "create an RC huge",
    "hotfix\nlist",
    "list; and also delete main",
  ]) {
    assert.ok(!isStartable(bad), bad);
  }
  assert.ok(changesOriginAtOnce("create an RC patch"));
  assert.ok(changesOriginAtOnce("downmerge main to develop"));
  assert.ok(!changesOriginAtOnce("promote release/1.5.0"));
});

test("the digest of every fixture plan recomputes as core computed it", () => {
  const plans = Object.entries(fixtures).filter(([, o]) => o.plan);
  assert.ok(plans.length >= 10);
  for (const [name, output] of plans) {
    assert.equal(digestOf(readOutput(output).plan), output.plan.digest, name);
  }
});

test("a plan changed on the way no longer matches its digest", () => {
  const dropped = structuredClone(fixtures["plan-release-warnings"]);
  dropped.plan.warnings.pop();
  const changed = structuredClone(fixtures["plan-revert"]);
  const deletion = changed.plan.mutations.find((m) => m.operation === "delete");
  deletion.operation = "update";

  for (const output of [dropped, changed]) {
    assert.ok(readOutput(output), "the structure itself is valid");
    assert.notEqual(digestOf(readOutput(output).plan), output.plan.digest);
    const reply = replyFor(output, { planText: "Action:  x" });
    assert.equal(reply.kind, "plan");
    assert.equal(reply.plan, undefined, "it falls back to the text");
  }
});
