/**
 * Runs that did not apply: refusals (nothing changed), failures part-way,
 * agent errors, runs that ended or timed out, and a launch that failed.
 */

import { toolTitle } from "./blocks.js";
import {
  clip,
  context,
  fields,
  header,
  mrkdwn,
  pre,
  quote,
  rich,
  txt,
} from "./kit.js";
import type { AgentReply } from "./reply.js";
import { startButton } from "./requests.js";
import type { ResultContext } from "./results.js";
import { escapeMrkdwn, type Block } from "./slack.js";
import type { Step } from "./structured.js";

interface Suggestion {
  text: string;
  request?: string;
  label?: string;
}

const LIST: Suggestion = {
  text: "see what's in flight.",
  request: "list",
  label: "List what's in flight",
};

const SUGGESTIONS: Record<string, Suggestion> = {
  P7: {
    text:
      "downmerge main into develop, merge that pull request, then ask for " +
      "the release candidate again.",
    request: "downmerge main to develop",
    label: "Downmerge main to develop",
  },
  P1: LIST,
  P2: LIST,
  P6: LIST,
  P16: LIST,
  S2: LIST,
  S3: LIST,
  S5: LIST,
  S9: LIST,
  S10: LIST,
  S12: LIST,
  S13: LIST,
  P4: { text: "promote or retire that release candidate first." },
  P8: { text: "nothing to do: it is already merged." },
  P11: {
    text: "cut a new release candidate.",
    request: "create an RC",
    label: "Create an RC",
  },
};

/** The tool stopped before changing anything. */
export function renderRefused(
  reply: Extract<AgentReply, { kind: "refused" }>,
  ctx: ResultContext
): Block[] {
  const s = reply.code ? SUGGESTIONS[reply.code] : undefined;
  const next = mrkdwn("Nothing was changed." + (s ? ` *Next:* ${s.text}` : ""));
  return [
    header(`🛑 ${toolTitle(reply.tool)}: refused`),
    rich([quote([txt(clip(reply.text || "The tool refused.", 2900))])]),
    s?.request && s.label
      ? { ...next, accessory: startButton(s.label, s.request) }
      : next,
    plainFooter(ctx),
  ];
}

/** The footer without an approval part, for messages that need none. */
export const plainFooter = (ctx: ResultContext): Block =>
  context(
    [
      `Requested by <@${ctx.requester}>` +
        (ctx.approver ? ` · approved by <@${ctx.approver}>` : "") +
        ` · <${ctx.agentLink}|agent>`,
    ],
    "footer"
  );

export type Stage = "plan" | "apply";

const stageField = (stage: Stage, ctx: ResultContext): string =>
  `*Stage*\n${
    stage === "plan"
      ? "Planning"
      : `Applying${ctx.approver ? ` (approved by <@${ctx.approver}>)` : ""}`
  }`;

/** The apply started and then failed: say what ran before it stopped. */
export function renderFailed(
  reply: Extract<AgentReply, { kind: "failed" }>,
  stage: Stage,
  ctx: ResultContext
): Block[] {
  const done = reply.steps.filter((s: Step) => s.status === "completed");
  return [
    header(`❌ ${toolTitle(reply.tool)}: failed part-way`),
    fields([
      stageField(stage, ctx),
      "*Changed on origin*\nPossibly: it stopped after it started",
      ...(done.length > 0
        ? [
            `*Done before it failed*\n${escapeMrkdwn(
              done
                .slice(0, 8)
                .map((s) => s.name)
                .join("; ")
            )}`,
          ]
        : []),
    ]),
    rich([pre(clip(reply.text || "The tool failed.", 2900))]),
    context([
      `➡️ Open the <${ctx.agentLink}|agent> to see how far it got, or ` +
        "`@release-manager list`. A new request plans from origin as it " +
        "is now.",
    ]),
    plainFooter(ctx),
  ];
}

/** The agent itself reported an error, or its reply could not be read. */
export function renderAgentError(
  text: string,
  stage: Stage,
  ctx: ResultContext
): Block[] {
  const unreadable = text.startsWith("The agent's reply could not be read");
  return [
    header(
      unreadable
        ? "❌ The agent's reply could not be read"
        : stage === "plan"
          ? "❌ Could not plan the request"
          : "❌ Could not apply the plan"
    ),
    fields([
      stageField(stage, ctx),
      `*Changed on origin*\n${
        stage === "plan"
          ? "Probably nothing: check `@release-manager list` if this was " +
            "a create or increment RC"
          : "Unknown: check the agent"
      }`,
    ]),
    rich([pre(clip(text || "No details.", 2900))]),
    plainFooter(ctx),
  ];
}

/** The run ended without a reply: ERROR, CANCELLED, EXPIRED, or timeout. */
export function renderRunEnded(
  status: string | "timeout",
  stage: Stage,
  ctx: ResultContext,
  minutes: number
): Block[] {
  const timeout = status === "timeout";
  return [
    header(
      timeout
        ? `⌛ The agent did not finish within ${minutes} minutes`
        : `❌ The agent run ended with ${status}`
    ),
    fields([
      stageField(stage, ctx),
      `*Changed on origin*\n${
        stage === "apply"
          ? "Unknown: it may have partly applied"
          : "Probably nothing: check `@release-manager list` if this was " +
            "a create or increment RC"
      }`,
    ]),
    context([
      timeout
        ? "It may still be running and may yet push. Watch the " +
          `<${ctx.agentLink}|agent>; do not approve again until it finishes.`
        : `Open the <${ctx.agentLink}|agent> to see how far it got, or ` +
          "`@release-manager list`. A new request plans from origin as it " +
          "is now.",
    ]),
    plainFooter(ctx),
  ];
}

/** Launching the agent failed: nothing ran. */
export function renderLaunchError(message: string): Block[] {
  return [
    mrkdwn(
      "❌ *Could not start the agent.* Nothing ran, so nothing was changed. " +
        "Try the request again."
    ),
    rich([pre(clip(message, 2900))]),
  ];
}
