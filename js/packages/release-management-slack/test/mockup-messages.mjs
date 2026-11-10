// Every message the app posts, rendered from the structured fixtures in
// test/fixtures/structured (real output of versioner PR #23's tools). Used
// by scripts/mockups.mjs and by the tests, which check each one against
// Slack's limits and against the committed test/fixtures/mockups.

import { readFileSync, readdirSync } from "node:fs";

import {
  collapse,
  renderPlaceholder,
  renderPlan,
  withState,
} from "../lib/blocks.js";
import { markStarted, renderChoose, renderVersions } from "../lib/listing.js";
import { planDeletes, planTier, renderStructuredPlan } from "../lib/plan.js";
import { loadingView, planConfirm, reviewView } from "../lib/review.js";
import { parseAgentReply } from "../lib/reply.js";
import { digestOf } from "../lib/structured.js";
import {
  renderAgentError,
  renderFailed,
  renderLaunchError,
  renderRefused,
  renderRunEnded,
} from "../lib/errors.js";
import { renderHandoff } from "../lib/handoffs.js";
import { renderApplied } from "../lib/results.js";

const dir = new URL("./fixtures/structured/", import.meta.url);
export const fixtures = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [
      f.replace(/\.json$/, ""),
      JSON.parse(readFileSync(new URL(f, dir), "utf8")),
    ])
);

export const REPO =
  "https://github.com/officespacesoftware/release-management-test";
export const AGENT = "https://cursor.com/agents/bc-7f3a";
const AT = 1762351500;
const requester = "U0REQ";
const approver = "U0APR";

const promoteText = readFileSync(
  new URL("./promote-plan.txt", import.meta.url),
  "utf8"
);

/** A changed fixture with the digest core would give it. */
export const signed = (output) => {
  output.plan.digest = digestOf(output.plan);
  return output;
};

/** The agent's reply as the contract asks for it, read by the app. */
export const replyFor = (output, extra = {}) =>
  parseAgentReply(
    JSON.stringify({
      kind: output.kind,
      tool: output.tool,
      ...(output.plan ? { digest: output.plan.digest, planText: "…" } : {}),
      output,
      ...extra,
    })
  );

const buttonValue = (reply, tier) =>
  JSON.stringify({
    a: "bc-7f3a",
    u: "run-1",
    d: reply.digest,
    t: reply.tool,
    r: requester,
    q: "promote release/1.0.0",
    k: tier === "safe" ? "s" : "r",
  });

const planCtx = (reply, replaces) => ({
  tool: reply.tool,
  digest: reply.digest,
  requester,
  agentLink: AGENT,
  repoUrl: REPO,
  ...(replaces ? { replaces } : {}),
});

export function planBlocks(name, replaces) {
  const reply = replyFor(fixtures[name]);
  const plan = reply.plan;
  const tier = planTier(plan);
  return renderStructuredPlan(plan, planCtx(reply, replaces), {
    kind: "awaiting",
    buttonValue: buttonValue(reply, tier),
    tier,
    ...(tier === "safe" ? { confirm: planConfirm(plan) } : {}),
    ...(planDeletes(plan) ? { deletes: true } : {}),
  });
}

const result = { requester, agentLink: AGENT, repoUrl: REPO };
const approved = { ...result, approver };

const resolution = (branch, files, extra = {}) => ({
  resolution: {
    pullRequest: 74,
    branch,
    resolvedFiles: files,
    unresolvedFiles: [],
    closedPullRequests: [],
    ...extra,
  },
});

const metadata = JSON.stringify({
  c: "C0RELEASE",
  m: "1762351320.000100",
  t: "1762351300.000100",
  b: {
    a: "bc-7f3a",
    u: "run-1",
    d: "6a6227",
    t: "release_version",
    r: requester,
    q: "promote release/1.0.0",
  },
});

function view(name, mode, canApprove = true) {
  const reply = replyFor(fixtures[name]);
  return reviewView(
    { plan: reply.plan },
    {
      metadata,
      mode,
      canApprove,
      ctx: planCtx(reply),
    }
  );
}

/** name → { blocks } for a message, or { view } for a modal. */
export function messages() {
  const promote = planBlocks("plan-release-warnings");
  const hotfix = planBlocks("plan-hotfix");
  const withFailedPipeline = structuredClone(
    fixtures["applied-increment-handoff"]
  );
  withFailedPipeline.result.manualDownmerge = undefined;
  withFailedPipeline.result.pipeline = {
    status: "failed",
    code: "T8",
    message:
      "The pipeline trigger for release/1.4.0 failed (exit 1), and release/1.4.0 has no open pull request. Start the build for release/1.4.0 by hand.",
    output:
      "curl: (22) The requested URL returned error: 401\nError: CIRCLE_TOKEN rejected",
  };
  const withProblems = structuredClone(fixtures["applied-release"]);
  withProblems.result.problems = [
    {
      code: "R1",
      text: "Failed to create pull request: Validation Failed (422)",
    },
    {
      code: "R4",
      text: "GitHub returned empty release notes — generate them manually from the release page.",
    },
  ];
  const unknown = withState(promote, {
    kind: "unknown",
    reason: "the agent was still running after 15 min and may yet push",
    agentLink: AGENT,
  });
  return {
    placeholder: {
      blocks: renderPlaceholder({
        request: "promote release_1.0.0 *now*",
        requester,
        agentLink: AGENT,
        startedAt: AT,
        minutes: 5,
      }),
    },
    "plan-promote-risky": { blocks: promote },
    "plan-promote-safe": { blocks: planBlocks("plan-release") },
    "plan-create-rc-risky": { blocks: planBlocks("plan-create-rc-warnings") },
    "plan-create-rc-safe": { blocks: planBlocks("plan-create-rc") },
    "plan-increment-risky": { blocks: planBlocks("plan-increment-warnings") },
    "plan-increment-conflict": {
      blocks: planBlocks("plan-increment-conflict"),
    },
    "plan-hotfix-safe": { blocks: hotfix },
    "plan-revert": { blocks: planBlocks("plan-revert") },
    "plan-revert-final": { blocks: planBlocks("plan-revert-final") },
    "plan-abandon": { blocks: planBlocks("plan-abandon") },
    "plan-replaces": { blocks: planBlocks("stale-increment", "4f0b2d") },
    "plan-text-fallback": {
      blocks: renderPlan(
        promoteText,
        planCtx({ tool: "release_version", digest: "3d5f68" }),
        {
          kind: "awaiting",
          buttonValue: "{}",
          tier: "risky",
        }
      ),
    },
    "modal-loading": { view: loadingView(metadata, "6a6227") },
    "modal-review-promote": { view: view("plan-release-warnings", "review") },
    "modal-review-abandon": { view: view("plan-abandon", "review") },
    "modal-details-hotfix": { view: view("plan-hotfix", "details") },
    "modal-review-not-approver": {
      view: view("plan-release-warnings", "review", false),
    },
    "state-applying": {
      blocks: withState(hotfix, {
        kind: "applying",
        approver,
        at: AT,
        agentLink: AGENT,
      }),
    },
    "state-applied": {
      blocks: withState(hotfix, { kind: "applied", approver, at: AT }),
    },
    "state-cancelled": {
      blocks: collapse(promote, { kind: "cancelled", by: approver, at: AT }),
    },
    "state-superseded": {
      blocks: collapse(promote, { kind: "superseded", approver }),
    },
    "state-failed": {
      blocks: withState(promote, {
        kind: "failed",
        title: "Not applied",
        detail: "the tool refused, so nothing was changed · details below",
      }),
    },
    "state-outcome-unknown": { blocks: unknown },
    "result-create-rc": {
      blocks: renderApplied(replyFor(fixtures["applied-create-rc"]), result),
    },
    "result-increment-resolved": {
      blocks: renderApplied(
        replyFor(
          fixtures["applied-increment-handoff"],
          resolution("release-1.4.0-into-develop-1762351700", [
            {
              path: "Gemfile.lock",
              reason:
                "kept develop's rack 3.2.0; the release's 3.1.12 fix is included in it",
            },
          ])
        ),
        result
      ),
    },
    "result-increment-no-build": {
      blocks: renderApplied(replyFor(withFailedPipeline), result),
    },
    "result-promote": {
      blocks: renderApplied(replyFor(fixtures["applied-release"]), approved),
    },
    "result-promote-problems": {
      blocks: renderApplied(replyFor(withProblems), approved),
    },
    "result-hotfix": {
      blocks: renderApplied(replyFor(fixtures["applied-hotfix"]), approved),
    },
    "result-revert": {
      blocks: renderApplied(replyFor(fixtures["applied-revert"]), approved),
    },
    "result-abandon": {
      blocks: renderApplied(replyFor(fixtures["applied-abandon"]), approved),
    },
    "result-downmerge": {
      blocks: renderApplied(replyFor(fixtures["applied-downmerge"]), result),
    },
    "result-downmerge-resolved": {
      blocks: renderApplied(
        replyFor(
          fixtures["handoff-develop"],
          resolution(
            "hotfix-1.4.1-into-develop-1762351700",
            [
              {
                path: "VERSION",
                reason: "kept develop's side (expected after every hotfix)",
              },
              {
                path: "app/models/seat.rb",
                reason:
                  "kept both: the hotfix's nil guard and develop's renamed scope",
              },
            ],
            { closedPullRequests: [71] }
          )
        ),
        result
      ),
    },
    "handoff-decision-needed": {
      blocks: renderHandoff(replyFor(fixtures["handoff-main"]), result),
    },
    "handoff-manual-downmerge": {
      blocks: renderHandoff(replyFor(fixtures["handoff-develop"]), result),
    },
    "refused-create-rc": {
      blocks: renderRefused(replyFor(fixtures["refused-create-rc"]), result),
    },
    "which-branch": {
      blocks: renderChoose(replyFor(fixtures["refused-ambiguous"]), {
        ...result,
        request: "promote 1.5.0",
      }),
    },
    "which-branch-chosen": {
      blocks: markStarted(
        renderChoose(replyFor(fixtures["refused-ambiguous"]), {
          ...result,
          request: "promote 1.5.0",
        }),
        "state",
        approver,
        "promote release/1.5.0"
      ),
    },
    "error-launch": {
      blocks: renderLaunchError(
        "Cursor POST /v1/agents failed (503): upstream unavailable"
      ),
    },
    "error-agent": {
      blocks: renderAgentError(
        "Error: Git command failed: fatal: could not read Username for 'https://github.com'",
        "plan",
        result
      ),
    },
    "error-run-ended": {
      blocks: renderRunEnded("ERROR", "apply", approved, 15),
    },
    "error-timeout": {
      blocks: renderRunEnded("timeout", "apply", approved, 15),
    },
    "error-failed-apply": {
      blocks: renderFailed(
        replyFor(fixtures["failed-release"]),
        "apply",
        approved
      ),
    },
    list: {
      blocks: renderVersions(replyFor(fixtures.versions, { purpose: "list" }), {
        ...result,
        request: "list",
        at: AT,
      }),
    },
    "list-empty": {
      blocks: renderVersions(
        replyFor(fixtures["versions-empty"], { purpose: "list" }),
        { ...result, request: "list", at: AT }
      ),
    },
    "list-row-started": {
      blocks: markStarted(
        renderVersions(replyFor(fixtures.versions, { purpose: "list" }), {
          ...result,
          request: "list",
          at: AT,
        }),
        "row:release/1.5.0",
        approver,
        "promote release/1.5.0"
      ),
    },
    help: {
      blocks: renderVersions(replyFor(fixtures.versions, { purpose: "help" }), {
        ...result,
        request: "help",
        at: AT,
      }),
    },
    "not-understood": {
      blocks: renderVersions(
        replyFor(fixtures.versions, { purpose: "unrecognized" }),
        {
          ...result,
          request: "ship it pls",
          at: AT,
        }
      ),
    },
    "ephemeral-not-approver": {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔒 Only release approvers can approve or cancel this plan: <@U0APR>, <@U0AP2>. Ask one of them in this thread.",
          },
        },
      ],
    },
  };
}

export const builderUrl = (message) =>
  "https://app.slack.com/block-kit-builder/T0CCEAN3A#" +
  encodeURIComponent(
    JSON.stringify(message.view ?? { blocks: message.blocks })
  );
