// Node built-in test runner. Run from the package root with:
//   node --test test/render.test.mjs
//
// Every message rendered from real structured output (test/fixtures), held
// to Slack's limits and to the committed mockups in test/fixtures/mockups.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { collapse, renderPlaceholder } from "../lib/blocks.js";
import { planBody, planTier, renderStructuredPlan } from "../lib/plan.js";
import { isStartable } from "../lib/requests.js";
import { planConfirm, reviewView } from "../lib/review.js";
import { renderApplied } from "../lib/results.js";
import {
  fixtures,
  messages,
  planBlocks,
  REPO,
  replyFor,
  signed,
} from "./mockup-messages.mjs";

const all = messages();
const text = (value) => JSON.stringify(value);

/** Slack's documented limits for each part of a message or modal. */
function checkLimits(name, message) {
  const blocks = message.view ? message.view.blocks : message.blocks;
  const fail = (what) => assert.fail(`${name}: ${what}`);
  if (blocks.length > (message.view ? 100 : 50))
    fail(`${blocks.length} blocks`);
  if (message.view) {
    if (message.view.title.text.length > 24) fail("modal title");
    if (message.view.private_metadata.length > 3000) fail("metadata");
  }
  const ids = blocks.map((b) => b.block_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) fail(`duplicate block_id ${ids}`);
  for (const block of blocks) {
    if (block.block_id && block.block_id.length > 255) fail("block_id");
    if (block.type === "header" && block.text.text.length > 150) fail("header");
    if (block.text?.text?.length > 3000) fail("section text");
    if (block.fields) {
      if (block.fields.length > 10) fail("fields");
      for (const f of block.fields) if (f.text.length > 2000) fail("field");
    }
    if (block.type === "context" && block.elements.length > 10) fail("context");
    if (block.type === "actions" && block.elements.length > 25) fail("actions");
    if (block.type === "rich_text") {
      const chars = text(block).match(/"text":"((?:[^"\\]|\\.)*)"/g) ?? [];
      const size = chars.join("").length;
      if (size > 4000) fail(`rich_text of ${size} characters`);
    }
    for (const e of [
      ...(block.type === "actions" ? block.elements : []),
      ...(block.accessory ? [block.accessory] : []),
    ]) {
      if (e.text.text.length > 75) fail(`button text ${e.text.text}`);
      if ((e.value ?? "").length > 2000) fail("button value");
      if (e.url && !e.url.startsWith("https://")) fail(`url ${e.url}`);
      if (e.confirm) {
        if (e.confirm.title.text.length > 100) fail("confirm title");
        if (e.confirm.text.text.length > 300) fail("confirm text");
      }
    }
  }
}

test("every message stays within Slack's limits", () => {
  for (const [name, message] of Object.entries(all)) {
    checkLimits(name, message);
  }
});

test("the committed mockups match what the code renders", () => {
  for (const [name, message] of Object.entries(all)) {
    const file = new URL(`./fixtures/mockups/${name}.json`, import.meta.url);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(
      saved,
      JSON.parse(text(message.view ?? { blocks: message.blocks })),
      `${name}: run npm run mockups -- --write`
    );
  }
});

test("every start button carries a request in the grammar", () => {
  for (const [name, message] of Object.entries(all)) {
    for (const block of message.blocks ?? message.view.blocks) {
      for (const e of [...(block.elements ?? []), block.accessory]) {
        if (e?.action_id === "start_request") {
          assert.ok(isStartable(JSON.parse(e.value).q), `${name}: ${e.value}`);
        }
      }
    }
  }
});

test("every link button is a link.* action, so it skips the approver check", () => {
  for (const [name, message] of Object.entries(all)) {
    for (const block of message.blocks ?? message.view.blocks) {
      for (const e of [...(block.elements ?? []), block.accessory]) {
        if (e?.url) assert.match(e.action_id, /^link\./, name);
      }
    }
  }
});

const tier = (name) => planTier(replyFor(fixtures[name]).plan);

test("a plan with no warning and no deletion is safe; any of either is risky", () => {
  assert.equal(tier("plan-hotfix"), "safe");
  assert.equal(tier("plan-create-rc"), "safe");
  assert.equal(tier("plan-release"), "safe");
  assert.equal(tier("plan-create-rc-warnings"), "risky");
  assert.equal(tier("plan-increment-warnings"), "risky");
  assert.equal(tier("plan-release-warnings"), "risky");
  assert.equal(tier("plan-revert"), "risky", "it deletes a tag");
  assert.equal(tier("plan-abandon"), "risky");
});

test("a promote of code no candidate contained is risky, and says so", () => {
  const output = structuredClone(fixtures["plan-release"]);
  output.plan.review.sinceVersion.count = 3;
  output.plan.review.sinceVersion.filesChanged = 2;
  const plan = replyFor(output).plan;

  assert.equal(planTier(plan), "risky");
  const blocks = renderStructuredPlan(plan, ctx, awaiting("risky"));
  assert.match(text(blocks), /3 commits that no release candidate contained/);
  assert.match(text(blocks), /⚠️ 3 commits/);
});

test("commits since the candidate that change no file leave a promote safe", () => {
  const output = structuredClone(fixtures["plan-release"]);
  output.plan.review.sinceVersion.count = 2;
  output.plan.review.sinceVersion.filesChanged = 0;
  const plan = replyFor(output).plan;

  assert.equal(planTier(plan), "safe");
  const blocks = renderStructuredPlan(plan, ctx, awaiting("safe"));
  assert.match(text(blocks), /✅ 2 commits · 0 files/);
  assert.match(text(blocks), /no file differs/);
  assert.doesNotMatch(text(blocks), /no release candidate contained/);
});

test("a promote whose untested commits are unknown is risky, and says so", () => {
  const output = structuredClone(fixtures["plan-release"]);
  delete output.plan.review.sinceVersion;
  const plan = replyFor(output).plan;

  assert.equal(planTier(plan), "risky");
  const blocks = renderStructuredPlan(plan, ctx, awaiting("risky"));
  assert.match(text(blocks), /does not say which commits/);

  output.plan.review.sinceVersion = { count: "none" };
  assert.equal(planTier(replyFor(output).plan), "risky");
});

const ctx = {
  tool: "release_version",
  digest: "abc123",
  requester: "U0REQ",
  agentLink: "https://cursor.com/agents/bc-1",
  repoUrl: REPO,
};
const awaiting = (t) => ({ kind: "awaiting", buttonValue: "{}", tier: t });

const actionsOf = (blocks) =>
  blocks.find((b) => b.block_id === "state").elements.map((e) => e.action_id);

test("a safe plan has Approve with a one-sentence confirm, View details and Cancel", () => {
  const blocks = all["plan-hotfix-safe"].blocks;

  assert.deepEqual(actionsOf(blocks), ["approve", "details", "cancel"]);
  const confirm = blocks.find((b) => b.block_id === "state").elements[0]
    .confirm;
  assert.equal(confirm.title.text, "Create hotfix 1.3.1-RC.0?");
  assert.match(confirm.text.text, /opens a PR into main \(production\)/);
  assert.equal(confirm.confirm.text, "Create hotfix");
  assert.equal(confirm.style, "danger", "it touches main");
  assert.equal(confirm.text.text.split(". ").length, 1);
});

test("a confirm that touches only develop is not red", () => {
  const confirm = planConfirm(replyFor(fixtures["plan-create-rc"]).plan);
  assert.equal(confirm.danger, false);
  assert.match(confirm.text, /^Creates release\/1\.4\.0 off develop/);
});

test("a risky plan has only Review & approve and Cancel; red when it deletes", () => {
  assert.deepEqual(actionsOf(all["plan-promote-risky"].blocks), [
    "review",
    "cancel",
  ]);
  const revert = all["plan-revert"].blocks.find((b) => b.block_id === "state");
  assert.equal(revert.elements[0].style, "danger");
  const promote = all["plan-promote-risky"].blocks.find(
    (b) => b.block_id === "state"
  );
  assert.equal(promote.elements[0].style, "primary");
});

test("warnings sit directly above the buttons", () => {
  const blocks = all["plan-increment-risky"].blocks;
  const state = blocks.findIndex((b) => b.block_id === "state");
  assert.match(text(blocks[state - 1]), /did not finish within 1s/);
  assert.match(text(blocks.slice(0, state)), /2 warnings to decide on/);
});

test("deletes come first, and what cannot be undone is bold", () => {
  const changes = all["plan-revert-final"].blocks.find(
    (b) => b.block_id === "changes"
  );
  const order = text(changes).match(/Deletes|Creates|Updates and closes/g);
  assert.deepEqual(order, ["Deletes", "Creates", "Updates and closes"]);
  for (const name of ["plan-revert-final", "plan-abandon"]) {
    const group = all[name].blocks.find((b) => b.block_id === "changes")
      .elements[0];
    assert.equal(group.elements[0].type, "text", `${name}: no icon`);
  }
  assert.match(
    text(changes),
    /"text":"\. Cannot be undone: release notes are destroyed[^"]*","style":\{"bold":true\}/
  );
  assert.match(text(changes), /A build or deploy it already triggered/);
});

test("the notes that are folded into a change line are not repeated", () => {
  const blocks = all["plan-promote-risky"].blocks;
  assert.doesNotMatch(text(blocks), /is already open for/);
  assert.match(
    text(blocks),
    /"url":"https:\/\/github\.com\/[^"]*\/pull\/67","text":"PR #67"/
  );
  assert.doesNotMatch(text(all["plan-revert"].blocks), /ℹ️ Deleting a tag/);
});

test("a branch deletion shows its recovery command", () => {
  assert.match(
    text(all["plan-abandon"].blocks),
    /"Recovery: "\},\{"type":"text","text":"git branch release\/1\.5\.0 [0-9a-f]+/
  );
});

test("the message shows five commits and links the rest; the modal fifty", () => {
  const message = all["plan-promote-risky"].blocks;
  const commits = message.filter((b) => /^commits-/.test(b.block_id ?? ""));
  assert.equal(commits.length, 1);
  assert.equal(text(commits).match(/"url":"[^"]*\/commit\//g).length, 5);
  assert.match(text(commits), /…and 38 more/);
  assert.match(text(commits), /All 43 on GitHub/);

  const modal = all["modal-review-promote"].view.blocks;
  const all43 = modal.filter((b) => /^commits-/.test(b.block_id ?? ""));
  assert.equal(text(all43).match(/"url":"[^"]*\/commit\//g).length, 43);
});

test("a failed check's output: its tail in the message, all of it in the modal", () => {
  const message = text(all["plan-promote-risky"].blocks);
  assert.match(message, /last 8 of 9 lines/);
  assert.doesNotMatch(message, /Name: rack/);
  assert.match(message, /Full output in Review & approve/);
  assert.match(text(all["modal-review-promote"].view), /Name: rack/);
});

test("a huge plan still fits: 30 warnings, long output, 400 commits", () => {
  const output = structuredClone(fixtures["plan-release-warnings"]);
  const plan = output.plan;
  plan.warnings = Array.from({ length: 30 }, (_, i) => ({
    text: `Warning ${i} `.padEnd(2500, "x"),
  }));
  plan.checkOutput = [
    {
      name: "bundle-audit",
      output: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"),
    },
  ];
  plan.review.ships.count = 400;
  const parsed = replyFor(signed(output)).plan;

  const blocks = renderStructuredPlan(parsed, ctx, awaiting("risky"));
  checkLimits("huge message", { blocks });
  assert.match(text(blocks), /30 warnings to decide on/);
  assert.match(text(blocks), /Warning 29/, "no warning is dropped");

  const view = reviewView(
    { plan: parsed },
    { metadata: "{}", mode: "review", canApprove: true, ctx }
  );
  checkLimits("huge modal", { view });
  assert.match(text(view), /line 4999/, "the modal keeps the output's tail");
});

test("an applied plan keeps the full plan; cancelled and superseded collapse", () => {
  assert.ok(all["state-applied"].blocks.length > 5);
  assert.match(text(all["state-applied"].blocks), /Branch: /);
  for (const name of ["state-cancelled", "state-superseded"]) {
    const blocks = all[name].blocks;
    assert.equal(blocks.length, 3, name);
    assert.match(blocks[0].text.text, /^📋 ~Promote 1\.0\.0-RC\.0 → 1\.0\.0~$/);
    assert.equal(blocks[2].block_id, "footer");
  }
});

test("the outcome-unknown state never says the plan was not applied", () => {
  const state = all["state-outcome-unknown"].blocks.find(
    (b) => b.block_id === "state"
  );
  assert.match(text(state), /Outcome unknown/);
  assert.doesNotMatch(text(state), /Not applied|nothing was changed/);
});

test("collapse keeps a legacy plan's last context as its footer", () => {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "📋 Promote 1.0.0" } },
    { type: "context", block_id: "state", elements: [] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Digest x" }] },
  ];
  const out = collapse(blocks, { kind: "cancelled", by: "U1" });
  assert.equal(out.length, 3);
  assert.match(text(out[2]), /Digest x/);
});

test("result cards name what was made, linked, with the right footer", () => {
  const rc = text(all["result-create-rc"].blocks);
  assert.match(rc, /✅ Created release candidate 1\.4\.0-RC\.0/);
  assert.match(rc, /releases\/tag\/1\.4\.0-RC\.0\|1\.4\.0-RC\.0/);
  assert.match(rc, /no approval needed \(no warnings\)/);

  const promote = text(all["result-promote"].blocks);
  assert.match(promote, /\(Latest\)/);
  assert.match(promote, /approved by <@U0APR>/);
  assert.match(promote, /"action_id":"link\.release"/);

  assert.match(
    text(all["result-abandon"].blocks),
    /~release\/1\.5\.0~ deleted/
  );
  assert.match(
    text(all["result-downmerge"].blocks),
    /no approval needed \(the PR is the review\)/
  );
});

test("a failed pipeline comes first, under a warning header", () => {
  const blocks = all["result-increment-no-build"].blocks;
  assert.match(blocks[0].text.text, /^⚠️ Incremented .*: no build started$/);
  assert.match(
    blocks[1].text.text,
    /No build is running for `release\/1\.4\.0`/
  );
  assert.equal(
    blocks.find((b) => b.type === "actions").elements[0].action_id,
    "link.checks"
  );
});

test("problems after the push are listed with what each needs", () => {
  const blocks = all["result-promote-problems"].blocks;
  assert.match(blocks[0].text.text, /2 steps need a hand/);
  assert.match(text(blocks[1]), /Pull request not opened or updated/);
});

test("a conflict the agent resolved shows each file and its pull request", () => {
  for (const name of [
    "result-downmerge-resolved",
    "result-increment-resolved",
  ]) {
    const t = text(all[name].blocks);
    assert.match(t, /resolved\./, name);
    assert.match(t, /pull\/74\/files/, name);
    assert.match(t, /resolved by the agent \(the PR is the review\)/, name);
  }
  assert.match(
    text(all["result-increment-resolved"].blocks),
    /Incremented 1\.4\.0-RC\.1 → 1\.4\.0-RC\.2/
  );
});

test("an increment whose conflict was not resolved says a downmerge is needed", () => {
  const reply = replyFor(fixtures["applied-increment-handoff"]);
  assert.equal(reply.resolution, undefined);

  const blocks = renderApplied(reply, {
    requester: "U1",
    agentLink: "x",
    repoUrl: REPO,
  });

  assert.match(
    blocks[0].text.text,
    /develop conflict needs a manual downmerge/
  );
  assert.match(text(blocks), /1\.4\.0-RC\.2 is pushed and tagged/);
  assert.match(text(blocks), /Cut release-1\.4\.0-into-develop/);
});

test("Decision needed has no Approve, and option 1 plans a patch RC", () => {
  const blocks = all["handoff-decision-needed"].blocks;
  assert.match(
    blocks[0].text.text,
    /🛑 Decision needed: release\/1\.0\.0 → main/
  );
  assert.doesNotMatch(text(blocks), /"action_id":"(approve|review)"/);
  const option = blocks.find((b) => b.accessory);
  assert.equal(JSON.parse(option.accessory.value).q, "create an RC patch");
  assert.ok(option.accessory.confirm, "a patch RC can apply without approval");
});

test("Manual downmerge needed lists the files and numbered steps", () => {
  const t = text(all["handoff-manual-downmerge"].blocks);
  assert.match(t, /"style":"ordered"/);
  assert.match(t, /keep develop's/);
});

test("a known refusal offers its next step", () => {
  const blocks = all["refused-create-rc"].blocks;
  assert.match(blocks[0].text.text, /🛑 Create release candidate: refused/);
  assert.match(text(blocks[1]), /rich_text_quote/);
  assert.equal(
    JSON.parse(blocks[2].accessory.value).q,
    "downmerge main to develop"
  );
});

test("the in-flight list has one row per unmerged branch, merged in one line", () => {
  const blocks = all.list.blocks;
  assert.match(blocks[0].text.text, /In flight: 2 branches/);
  const rows = blocks.filter((b) => /^row:/.test(b.block_id ?? ""));
  assert.deepEqual(
    rows.map((r) => r.block_id),
    ["row:release/1.5.0", "row:hotfix/1.4.1"]
  );
  assert.match(text(blocks), /Merged into main: 3/);
  assert.match(text(all["list-empty"].blocks), /Create an RC \(minor\)/);
});

test("help explains approval; not understood quotes the request literally", () => {
  assert.match(text(all.help.blocks), /How approval works/);
  assert.match(text(all.help.blocks), /`?promote release\/1\.5\.0/);
  assert.match(
    text(all["not-understood"].blocks),
    /"text":"ship it pls","style":\{"italic":true\}/
  );
  assert.doesNotMatch(text(all.help.blocks), /"type":"table"/);
});

test("the placeholder keeps _ and * in the request literal", () => {
  const blocks = renderPlaceholder({ request: "a_b *c*", requester: "U1" });
  assert.match(text(blocks), /"text":"a_b \*c\*","style":\{"italic":true\}/);
  assert.match(text(blocks), /starting the agent/);
});

test("a replacement plan says which plan it replaces", () => {
  const blocks = planBlocks("stale-increment", "4f0b2d");
  assert.equal(blocks[1].block_id, "replaces");
  assert.match(blocks[1].elements[0].text, /Replaces plan `4f0b2d`/);
});

test("the full plan names mutation details in words, not field names", () => {
  const plan = replyFor(fixtures["plan-release"]).plan;

  const body = text(planBody(plan, ctx, true));

  assert.match(body, /Points at: release\//);
  assert.match(body, /Tag message: Release version/);
  assert.doesNotMatch(body, /targetCommitish/);
});
