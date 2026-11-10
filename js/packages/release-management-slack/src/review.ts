/**
 * How a plan is approved: the safe tier's one-sentence confirm, and the
 * review modal that shows the whole plan, whose submit is the only way to
 * approve a risky one.
 */

import { planTextBlocks, type PlanContext } from "./blocks.js";
import {
  context,
  MAX_MODAL_BLOCKS,
  mcode,
  plain,
  plural,
  type Confirm,
} from "./kit.js";
import { LABELS, planBody, structuredTitle } from "./plan.js";
import type { Block } from "./slack.js";
import type { Plan } from "./structured.js";

const VERBS: Record<string, string> = {
  release_version: "Promote",
  create_release_candidate: "Create RC",
  increment_release_candidate: "Increment",
  create_hotfix: "Create hotfix",
  revert_version: "Revert",
};

const joinAnd = (parts: string[]): string =>
  parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** The safe tier's confirm: one sentence of what Approve does. */
export function planConfirm(plan: Plan): Confirm {
  const parts: string[] = [];
  for (const m of plan.mutations) {
    const prod = m.ref.base === "main" ? " (production)" : "";
    switch (m.kind === "pull-request" ? `pr-${m.operation}` : m.kind) {
      case "branch":
        if (m.operation === "create") parts.push(`creates ${m.summary}`);
        break;
      case "push":
        parts.push(`pushes ${m.summary}`);
        break;
      case "github-release":
        if (m.operation === "create") {
          parts.push(
            `creates GitHub release ${m.ref.name ?? ""}, which becomes Latest`
          );
        }
        break;
      case "pr-create":
        parts.push(
          `opens a ${m.ref.draft ? "draft " : ""}PR into ` +
            `${m.ref.base ?? "its base"}${prod}`
        );
        break;
      case "pr-update":
        parts.push(
          `updates PR #${m.ref.number ?? "?"} into ${m.ref.base ?? "its base"}${prod}`
        );
        break;
      case "pr-close":
        parts.push(`closes PR #${m.ref.number ?? "?"}`);
        break;
    }
    if (m.operation === "delete") {
      parts.push(`deletes ${LABELS[m.kind].toLowerCase()} ${m.summary}`);
    }
  }
  const sentence = joinAnd(parts);
  const ships = plan.review.ships;
  const reach =
    plan.action === "release_version" && ships
      ? ` ${plural(ships.count, "commit")} reach main when that PR merges.`
      : "";
  return {
    title: `${structuredTitle(plan)}?`,
    text:
      (sentence
        ? `${sentence[0]?.toUpperCase()}${sentence.slice(1)}.`
        : "Applying changes origin.") + reach,
    confirm: VERBS[plan.action] ?? "Apply",
    danger: plan.mutations.some((m) => m.ref.base === "main"),
  };
}

export const REVIEW_CALLBACK = "review_plan";

export interface ViewOptions {
  metadata: string;
  ctx: PlanContext;
  /** "review" approves on submit; "details" is read-only. */
  mode: "review" | "details";
  canApprove: boolean;
}

const modal = (
  metadata: string,
  blocks: Block[],
  submit?: string
): Record<string, unknown> => ({
  type: "modal",
  callback_id: REVIEW_CALLBACK,
  title: plain("Review plan"),
  close: plain("Back"),
  ...(submit ? { submit: plain(submit) } : {}),
  private_metadata: metadata,
  blocks,
});

export const loadingView = (
  metadata: string,
  digest: string
): Record<string, unknown> =>
  modal(metadata, [context([`⏳ Loading plan ${mcode(digest)}…`])]);

export const messageView = (
  metadata: string,
  text: string
): Record<string, unknown> => modal(metadata, [context([text])]);

/** Drop the least important blocks first: commits, then check output. */
function fitModal(blocks: Block[]): Block[] {
  const out = [...blocks];
  for (const prefix of ["commits-", "output-"]) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out.length <= MAX_MODAL_BLOCKS) break;
      if (String(out[i]?.block_id ?? "").startsWith(prefix)) out.splice(i, 1);
    }
  }
  return out.slice(0, MAX_MODAL_BLOCKS);
}

/**
 * The full plan. In "review" mode for an approver, submitting it approves;
 * otherwise it has no submit button and approval stays on the message.
 */
export function reviewView(
  source: { plan: Plan } | { planText: string },
  opts: ViewOptions
): Record<string, unknown> {
  const body =
    "plan" in source
      ? planBody(source.plan, opts.ctx, true)
      : planTextBlocks(source.planText, opts.ctx);
  const submit = opts.mode === "review" && opts.canApprove;
  const note = submit
    ? "Approving applies this exact plan. If origin moved, nothing is " +
      "applied and a new plan is posted."
    : opts.canApprove
      ? "Approve it from the message."
      : "Only release approvers can approve.";
  return modal(
    opts.metadata,
    fitModal([
      ...body,
      context([`Digest ${mcode(opts.ctx.digest)} · ${note}`]),
    ]),
    submit ? "Approve" : undefined
  );
}
