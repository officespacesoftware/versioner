// Node built-in test runner. Run from the package root with:
//   node --test test/blocks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parsePlanText, renderPlan, withState } from "../lib/blocks.js";
import { parseAgentReply } from "../lib/reply.js";
import { reviewView } from "../lib/review.js";

// A real release_version plan, as a cloud agent returned it.
const promotePlan = readFileSync(
  new URL("./promote-plan.txt", import.meta.url),
  "utf8"
);

const context = {
  tool: "release_version",
  digest: "3d5f681aac7f",
  requester: "U123",
  agentLink: "https://cursor.com/agents/bc-1",
};

const textOf = (blocks) => JSON.stringify(blocks);

test("the plan text splits into its header and sections", () => {
  const plan = parsePlanText(promotePlan);

  assert.equal(plan.action, "release_version");
  assert.equal(plan.branch, "release/1.0.0 (at 46ab842a667)");
  assert.equal(plan.version, "1.0.0-RC.0 → 1.0.0");
  assert.deepEqual(
    plan.sections.map((s) => s.title),
    ["Would create", "Warnings", "Notes", "Output of simulated-audit"]
  );
  assert.equal(plan.sections[1].lines.length, 1);
  assert.match(plan.sections[3].lines.join("\n"), /Vulnerabilities found!/);
});

test("nothing after the confirmation line is shown", () => {
  const plan = parsePlanText(promotePlan);

  assert.doesNotMatch(textOf(plan), /confirm/);
});

test("a plan from text renders bold warnings and notes, reviewed in a modal", () => {
  const blocks = renderPlan(promotePlan, context, {
    kind: "awaiting",
    buttonValue: '{"a":"bc-1"}',
    tier: "risky",
  });

  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "📋 Promote 1.0.0-RC.0 → 1.0.0");
  const warnings = blocks.find((b) => b.text?.text?.startsWith("⚠️"));
  assert.match(warnings.text.text, /• \*Pre-version check "simulated-audit" failed/);
  assert.match(textOf(blocks), /ℹ️ PR #67 is already open/);

  const actions = blocks.find((b) => b.type === "actions");
  const [review, cancel] = actions.elements;
  assert.equal(review.action_id, "review");
  assert.equal(review.style, "primary");
  assert.equal(review.value, '{"a":"bc-1"}');
  assert.equal(cancel.action_id, "cancel");
  assert.ok(!actions.elements.some((e) => e.action_id === "approve"));
});

test("each change is its own line, with its details and linked pull requests", () => {
  const blocks = renderPlan(
    promotePlan,
    { ...context, repoUrl: "https://github.com/o/r" },
    { kind: "awaiting", buttonValue: "{}", tier: "risky" }
  );

  const changes = blocks.find((b) => b.text?.text?.startsWith("*Would create*"));
  const lines = changes.text.text.split("\n").slice(1);
  assert.equal(lines.length, 6);
  assert.equal(
    lines[0],
    '📝 *Commit* "To version 1.0.0" on release/1.0.0 · _files: VERSION_'
  );
  assert.match(lines[3], /^🔀 \*Pull request\* update <https:\/\/github\.com\/o\/r\/pull\/67\|PR #67>/);
  assert.match(textOf(blocks), /ℹ️ <https:\/\/github\.com\/o\/r\/pull\/67\|PR #67> is already open/);
});

test("a URL in a detail is an explicit link, so the closing italics stay out of it", () => {
  const plan = promotePlan.replace(
    /^(\s*GitHub release: .*)$/m,
    "$1\n      url: https://github.com/o/r/releases/tag/1.0.0"
  );

  const blocks = renderPlan(
    plan,
    { ...context, repoUrl: "https://github.com/o/r" },
    { kind: "awaiting", buttonValue: "{}", tier: "risky" }
  );

  assert.match(
    textOf(blocks),
    /_url: <https:\/\/github\.com\/o\/r\/releases\/tag\/1\.0\.0>_/
  );
});

test("check output comes last, after the notes", () => {
  const blocks = renderPlan(promotePlan, context, { kind: "awaiting", buttonValue: "{}", tier: "risky" });

  const notes = blocks.findIndex((b) => b.type === "context" && /ℹ️/.test(textOf(b)));
  const output = blocks.findIndex((b) => b.text?.text?.startsWith("*Output of"));
  assert.ok(notes !== -1 && output > notes);
  assert.equal(blocks[output + 1].type, "divider");
});

test("every section stays under Slack's 3000-character limit", () => {
  const long = promotePlan.replace(
    "Vulnerabilities found!",
    Array.from({ length: 400 }, (_, i) => `line ${i} of a long audit`).join("\n  ")
  );

  const blocks = renderPlan(long, context, { kind: "awaiting", buttonValue: "{}", tier: "risky" });

  for (const block of blocks) {
    if (block.text?.text) {
      assert.ok(block.text.text.length <= 3000, block.text.text.slice(0, 80));
    }
  }
});

test("a new state replaces only the approval row", () => {
  const blocks = renderPlan(promotePlan, context, {
    kind: "awaiting",
    buttonValue: "{}",
    tier: "risky",
  });

  const applying = withState(blocks, { kind: "applying", approver: "U9" });

  assert.equal(applying.length, blocks.length);
  assert.ok(!applying.some((b) => b.type === "actions"));
  assert.match(textOf(applying), /\*Applying\* · approved by <@U9>/);
  assert.deepEqual(applying[0], blocks[0]);
});

test("plan text is escaped so it cannot inject Slack mentions or links", () => {
  const sneaky = promotePlan.replace(
    "PR #67 is already open",
    "<!channel> <https://evil.example|click>"
  );

  const blocks = renderPlan(sneaky, context, { kind: "awaiting", buttonValue: "{}", tier: "risky" });

  assert.doesNotMatch(textOf(blocks), /<!channel>/);
  assert.match(textOf(blocks), /&lt;!channel&gt;/);
});

test("the agent's reply is read even inside a code fence", () => {
  const reply = parseAgentReply(
    '```json\n{"kind":"plan","tool":"release_version","version":"1.0.0",' +
      '"digest":"abc123","planText":"Action:  release_version"}\n```'
  );

  assert.equal(reply.kind, "plan");
  assert.equal(reply.digest, "abc123");
});

test("an unreadable reply becomes an error that shows it", () => {
  const reply = parseAgentReply("I could not finish.");

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /I could not finish\./);
});

test("a plan reply without a digest is not offered for approval", () => {
  const reply = parseAgentReply('{"kind":"plan","tool":"x","planText":"y"}');

  assert.equal(reply.kind, "error");
});

const risky = { kind: "awaiting", buttonValue: "{}", tier: "risky" };

test("a URL outside the repository in a detail is not made a link", () => {
  const plan = promotePlan.replace(
    /^(\s*GitHub release: .*)$/m,
    "$1\n      url: https://evil.example/o/r/releases"
  );

  const blocks = renderPlan(
    plan,
    { ...context, repoUrl: "https://github.com/o/r" },
    risky
  );

  assert.doesNotMatch(textOf(blocks), /<https:\/\/evil/);
  assert.match(textOf(blocks), /_url: https:\/\/evil\.example\/o\/r\/releases_/);
});

test("a plan from text fits Slack's 50 blocks and keeps its buttons", () => {
  const sections = Array.from(
    { length: 60 },
    (_, i) => `Section ${i}:\n  line ${i}`
  ).join("\n");
  const plan = `Action:  release_version\nBranch:  release/1.0.0\n\n${sections}`;

  const blocks = renderPlan(plan, context, risky);

  assert.equal(blocks.length, 50);
  assert.equal(blocks.at(-2).block_id, "state");
  assert.equal(blocks.at(-1).block_id, "footer");
});

test("a code section in a plan from text is escaped", () => {
  const plan = promotePlan.replace(
    "Vulnerabilities found!",
    "<!channel> <https://evil.example|click>"
  );

  const blocks = renderPlan(plan, context, risky);
  const output = blocks.find((b) => b.text?.text?.startsWith("*Output of"));

  assert.doesNotMatch(output.text.text, /<!channel>|<https/);
  assert.match(output.text.text, /&lt;!channel&gt;/);
});

test("a plan from text says it is unverified, in the message and the modal", () => {
  const message = renderPlan(promotePlan, context, risky);
  const modal = reviewView(
    { planText: promotePlan },
    { metadata: "{}", mode: "review", canApprove: true, ctx: context }
  );

  assert.match(textOf(message), /\*Unverified\*/);
  assert.match(textOf(modal), /\*Unverified\*/);
});
