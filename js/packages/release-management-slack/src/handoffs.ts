/**
 * The downmerge handoffs: "Decision needed" into main, which always stops
 * for a person, and "Manual downmerge needed" into develop when the agent
 * did not carry it out.
 */

import {
  clip,
  context,
  divider,
  header,
  list,
  mlink,
  mrkdwn,
  para,
  pre,
  rich,
  txt,
  type Element,
} from "./kit.js";
import type { AgentReply } from "./reply.js";
import { startButton } from "./requests.js";
import type { ResultContext } from "./results.js";
import { escapeMrkdwn, type Block } from "./slack.js";
import type { Handoff } from "./structured.js";

export const MANUAL_DOWNMERGE_URL =
  "https://github.com/officespacesoftware/versioner/blob/master/docs/manual-downmerge.md";

/** The conflicted files and the steps or options of a handoff. */
export function handoffBody(handoff: Handoff): Block[] {
  const files = handoff.conflictedFiles;
  const elements: Element[] = [
    para([
      handoff.code === "H2"
        ? txt("Conflicted files", { bold: true })
        : txt(
            handoff.increment
              ? `${handoff.increment.version} is pushed and tagged, but ` +
                  `${handoff.sourceBranch} conflicts with develop. ` +
                  "Conflicted files:"
              : "The merge conflicts, so nothing was created. Conflicted " +
                  "files:"
          ),
    ]),
    list([
      ...files
        .slice(0, 20)
        .map((f) => [
          txt(f, { code: true }),
          ...(f === "VERSION" && handoff.target === "develop"
            ? [txt(" (expected after every hotfix: keep develop's)")]
            : []),
        ]),
      ...(files.length > 20 ? [[txt(`+${files.length - 20} more`)]] : []),
    ]),
  ];
  if (handoff.code === "H1") {
    elements.push(para([txt("Steps", { bold: true })]));
    elements.push(
      list(
        handoff.steps.map((s) => [txt(s)]),
        "ordered"
      )
    );
    return [rich(elements)];
  }
  const blocks: Block[] = [rich(elements), divider];
  handoff.options.forEach((option, i) => {
    const take = option.recommended && i === 0;
    const request =
      handoff.source === "hotfix" ? "hotfix" : "create an RC patch";
    blocks.push({
      ...mrkdwn(
        `*Option ${i + 1}: ${escapeMrkdwn(option.label)}*` +
          (option.recommended ? " (usually right)" : "") +
          `\n${escapeMrkdwn(option.text)}`
      ),
      ...(take
        ? {
            accessory: startButton(
              handoff.source === "hotfix"
                ? "Plan a new hotfix"
                : "Plan a patch RC",
              request,
              "primary"
            ),
          }
        : {}),
    });
  });
  return blocks;
}

/**
 * A handoff that stops for a person: H2 always, H1 only when the agent did
 * not carry it out.
 */
export function renderHandoff(
  reply: Extract<AgentReply, { kind: "handoff" }>,
  ctx: ResultContext
): Block[] {
  const procedure = mlink(MANUAL_DOWNMERGE_URL, "Manual downmerge procedure");
  const foot = context(
    [
      `${procedure} · requested by <@${ctx.requester}> · ` +
        `<${ctx.agentLink}|agent>`,
    ],
    "footer"
  );
  const h = reply.handoff;
  if (!h) {
    return [
      rich([pre(clip(reply.text || "A downmerge needs a human.", 2900))]),
      foot,
    ];
  }
  if (h.code === "H2") {
    return [
      header(`🛑 Decision needed: ${h.sourceBranch} → main`),
      mrkdwn(
        "The merge conflicts, so *nothing was created*. main mirrors " +
          `production and holds changes ${escapeMrkdwn(h.sourceBranch)} ` +
          "never received. *Do not resolve this or merge main into " +
          `${escapeMrkdwn(h.sourceBranch)}*: that would deploy it without a ` +
          "new release candidate."
      ),
      ...handoffBody(h),
      foot,
    ];
  }
  return [
    header(`🧩 Manual downmerge needed: ${h.sourceBranch} → ${h.target}`),
    ...handoffBody(h),
    foot,
  ];
}
