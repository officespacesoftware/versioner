/**
 * The parts every plan message shares: the state row and its transitions,
 * the collapsed record, the placeholder, and the text fallback for a plan
 * whose structured form is missing.
 *
 * The plan text is the one `renderChangePlan` in release-management-core
 * writes, so it is parsed here rather than retyped by the agent: header lines
 * (`Action:`, `Branch:`, `Version:`), then sections that each start with an
 * unindented line ending in a colon.
 */

import {
  actions,
  button,
  clip,
  context,
  divider,
  fit,
  header,
  MAX_TEXT,
  mcode,
  para,
  rich,
  txt,
  when,
  type Confirm,
} from "./kit.js";
import { safeUrl, type Repo } from "./links.js";
import { escapeMrkdwn, type Block } from "./slack.js";

export { parseAgentReply, type AgentReply } from "./reply.js";

export interface PlanSection {
  title: string;
  lines: string[];
}

export interface ParsedPlan {
  action: string | undefined;
  branch: string | undefined;
  version: string | undefined;
  sections: PlanSection[];
}

const HEADER = /^(Action|Branch|Version):\s+(.*)$/;
const SECTION = /^(\S.*):$/;

export function parsePlanText(text: string): ParsedPlan {
  const plan: ParsedPlan = {
    action: undefined,
    branch: undefined,
    version: undefined,
    sections: [],
  };
  let started = false;
  let current: PlanSection | undefined;

  for (const line of text.split("\n")) {
    if (line.startsWith("Nothing has been changed")) {
      break;
    }
    const header = HEADER.exec(line);
    if (header && !current) {
      started = true;
      const [, key, value] = header as unknown as [string, string, string];
      if (key === "Action") plan.action = value;
      if (key === "Branch") plan.branch = value;
      if (key === "Version") plan.version = value;
      continue;
    }
    if (!started || line.trim() === "") {
      continue;
    }
    const section = SECTION.exec(line);
    if (section) {
      current = { title: section[1] as string, lines: [] };
      plan.sections.push(current);
    } else if (/^\S/.test(line)) {
      current = { title: line, lines: [] };
      plan.sections.push(current);
    } else if (current) {
      current.lines.push(line.replace(/^ {2}/, ""));
    }
  }
  return plan;
}

export const TITLES: Record<string, string> = {
  create_release_candidate: "Create release candidate",
  increment_release_candidate: "Increment release candidate",
  release_version: "Promote",
  create_hotfix: "Create hotfix",
  revert_version: "Revert",
  downmerge: "Downmerge",
  list_versions: "List",
};

export const toolTitle = (tool: string): string =>
  TITLES[tool] ?? (tool.replace(/_/g, " ") || "Request");

/** Section text is capped at 3000 characters; leave room for the heading. */
const MAX_CODE = 2700;

const code = (lines: string[]): string => {
  const body = lines.join("\n");
  const clipped =
    body.length > MAX_CODE ? `…${body.slice(body.length - MAX_CODE)}` : body;
  return "```" + escapeMrkdwn(clipped).replace(/```/g, "ˋˋˋ") + "```";
};

const bullet = (line: string): string => line.replace(/^- /, "");

export function planTitle(plan: ParsedPlan, tool: string): string {
  const action = plan.action ?? tool;
  const name = toolTitle(action);
  const title = plan.version ? `${name} ${plan.version}` : name;
  return title.slice(0, 150);
}

export type Tier = "safe" | "risky";

export type PlanState =
  | {
      kind: "awaiting";
      buttonValue: string;
      tier: Tier;
      confirm?: Confirm;
      /** The risky plan deletes something: its button is red. */
      deletes?: boolean;
    }
  | { kind: "applying"; approver: string; at?: number; agentLink?: string }
  | { kind: "applied"; approver: string; at?: number }
  | { kind: "cancelled"; by: string; at?: number }
  | { kind: "failed"; title: string; detail?: string }
  | { kind: "unknown"; reason: string; agentLink: string }
  | { kind: "superseded"; approver?: string };

export interface PlanContext {
  tool: string;
  digest: string;
  requester: string;
  agentLink: string;
  /** `https://github.com/<owner>/<repo>`, to link the pull requests a plan names. */
  repoUrl?: string | undefined;
  /** The digest of the plan this one replaces, after origin moved. */
  replaces?: string | undefined;
}

const KIND_ICONS: Record<string, string> = {
  Branch: "🌿",
  Commit: "📝",
  Tag: "🏷️",
  Push: "⬆️",
  "Pull request": "🔀",
  "GitHub release": "📦",
};

const MUTATION = new RegExp(`^(${Object.keys(KIND_ICONS).join("|")}): (.*)$`);
const DETAIL = /^\s+([^:]+): (.*)$/;

function linkPullRequests(text: string, repoUrl: string | undefined): string {
  return repoUrl
    ? text.replace(/PR #(\d+)/g, `<${repoUrl}/pull/$1|PR #$1>`)
    : text;
}

const linkUrls = (text: string, repo: Repo): string =>
  text.replace(/https:\/\/[^\s<>|]+/g, (url) =>
    safeUrl(repo, url) ? `<${url}>` : url
  );

/** One line per change, its details folded in after it in italics. */
function changeLines(lines: string[], repoUrl: string | undefined): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const change = MUTATION.exec(line);
    if (change) {
      const [, kind, summary] = change as unknown as [string, string, string];
      out.push(
        `${KIND_ICONS[kind]} *${kind}* ` +
          linkPullRequests(escapeMrkdwn(summary), repoUrl)
      );
      continue;
    }
    const detail = DETAIL.exec(line);
    if (detail && out.length > 0) {
      const [, key, value] = detail as unknown as [string, string, string];
      out[out.length - 1] +=
        ` · _${escapeMrkdwn(key)}: ${linkUrls(escapeMrkdwn(value), repoUrl)}_`;
      continue;
    }
    out.push(escapeMrkdwn(line.trim()));
  }
  return out;
}

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: clip(text, 3000) },
});

/** The body of a plan rendered from its text: no state row, no footer. */
export function planTextBlocks(planText: string, ctx: PlanContext): Block[] {
  const plan = parsePlanText(planText);
  const blocks: Block[] = [
    header(`📋 ${planTitle(plan, ctx.tool)}`),
    ...replacesBlocks(ctx),
    context([
      "⚠️ *Unverified*: shown from the agent's text, not the tool's " +
        "checked plan. Approving applies the plan the tool computes for " +
        `digest ${mcode(ctx.digest)}, which may differ from this text.`,
    ]),
  ];

  const fields = [
    plan.branch && `*Branch*\n${mcode(plan.branch)}`,
    plan.version && `*Version*\n${mcode(plan.version)}`,
  ].filter((f): f is string => Boolean(f));
  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields: fields.map((text) => ({ type: "mrkdwn", text })),
    });
  }

  const warnings: Block[] = [];
  const notes: string[] = [];
  const outputs: Block[] = [];
  for (const s of plan.sections) {
    if (s.title === "Warnings") {
      warnings.push(
        section(
          "⚠️ *Warnings*\n" +
            s.lines.map((l) => `• *${escapeMrkdwn(bullet(l))}*`).join("\n")
        )
      );
    } else if (s.title === "Notes") {
      notes.push(...s.lines.map(bullet));
    } else if (s.title.startsWith("Would ")) {
      const icon = s.title === "Would delete" ? "🗑️ " : "";
      blocks.push(
        section(
          `${icon}*${escapeMrkdwn(s.title)}*\n` +
            changeLines(s.lines, ctx.repoUrl).join("\n")
        )
      );
    } else if (s.lines.length === 0) {
      blocks.push(section(escapeMrkdwn(s.title)));
    } else {
      const block = section(`*${escapeMrkdwn(s.title)}*\n${code(s.lines)}`);
      (s.title.startsWith("Output of ") ? outputs : blocks).push(block);
    }
  }

  if (notes.length > 0) {
    blocks.push(
      context([
        notes
          .map((n) => `ℹ️ ${linkPullRequests(escapeMrkdwn(n), ctx.repoUrl)}`)
          .join("\n"),
      ])
    );
  }
  blocks.push(...outputs);
  blocks.push(divider);
  blocks.push(...warnings);
  return blocks;
}

/**
 * A plan rendered from its text, when the structured plan is missing or
 * failed validation. The tier cannot be read reliably from text, so it is
 * always reviewed in the modal before approval.
 */
export function renderPlan(
  planText: string,
  context: PlanContext,
  state: PlanState
): Block[] {
  return fit([
    ...planTextBlocks(planText, context),
    stateBlock(state),
    footer(context),
  ]);
}

export function replacesBlocks(context: PlanContext): Block[] {
  return context.replaces
    ? [
        {
          type: "context",
          block_id: "replaces",
          elements: [
            {
              type: "mrkdwn",
              text:
                `↪️ Replaces plan ${mcode(context.replaces)}: origin moved ` +
                "after it was approved, so nothing was applied. Review this " +
                "one again.",
            },
          ],
        },
      ]
    : [];
}

export const STATE_BLOCK = "state";
export const FOOTER_BLOCK = "footer";

export function footer(context: PlanContext): Block {
  return {
    type: "context",
    block_id: FOOTER_BLOCK,
    elements: [
      {
        type: "mrkdwn",
        text:
          `Digest ${mcode(context.digest)} · requested by ` +
          `<@${context.requester}> · <${context.agentLink}|agent>`,
      },
    ],
  };
}

/** Swap a rendered plan's approval row for a new state, keeping the rest. */
export function withState(blocks: Block[], state: PlanState): Block[] {
  return blocks.map((block) =>
    block.block_id === STATE_BLOCK ? stateBlock(state) : block
  );
}

/**
 * A cancelled or superseded plan shrinks to its title, struck through, its
 * state and its footer, so a thread with several runs reads as a log.
 */
export function collapse(blocks: Block[], state: PlanState): Block[] {
  const head = blocks.find((b) => b.type === "header") as
    | { text?: { text?: string } }
    | undefined;
  const title = (head?.text?.text ?? "Plan").replace(/^📋\s*/, "");
  const stateIndex = blocks.findIndex((b) => b.block_id === STATE_BLOCK);
  const foot =
    blocks.find((b) => b.block_id === FOOTER_BLOCK) ??
    blocks.slice(stateIndex + 1).find((b) => b.type === "context");
  return [
    {
      type: "section",
      block_id: "record",
      text: {
        type: "mrkdwn",
        text: `📋 ~${escapeMrkdwn(title).replace(/~/g, "∼")}~`,
      },
    },
    stateBlock(state),
    ...(foot ? [foot] : []),
  ];
}

const at = (time: number | undefined): string =>
  time === undefined ? "" : ` at ${when(time)}`;

export function stateBlock(state: PlanState): Block {
  const row = (text: string): Block => context([text], STATE_BLOCK);
  switch (state.kind) {
    case "awaiting": {
      const cancel = button({
        actionId: "cancel",
        text: "Cancel",
        value: state.buttonValue,
      });
      if (state.tier === "risky") {
        return actions(
          [
            button({
              actionId: "review",
              text: "Review & approve…",
              style: state.deletes ? "danger" : "primary",
              value: state.buttonValue,
            }),
            cancel,
          ],
          STATE_BLOCK
        );
      }
      return actions(
        [
          button({
            actionId: "approve",
            text: "Approve",
            style: "primary",
            value: state.buttonValue,
            confirm: state.confirm ?? {
              title: "Apply this plan?",
              text: "Applying changes origin.",
              confirm: "Apply",
            },
          }),
          button({
            actionId: "details",
            text: "View details",
            value: state.buttonValue,
          }),
          cancel,
        ],
        STATE_BLOCK
      );
    }
    case "applying":
      return row(
        `⏳ *Applying* · approved by <@${state.approver}>${at(state.at)}` +
          (state.agentLink ? ` · <${state.agentLink}|agent>` : "")
      );
    case "applied":
      return row(
        `✅ *Applied* · approved by <@${state.approver}>${at(state.at)}` +
          " · result below"
      );
    case "cancelled":
      return row(
        `🚫 *Cancelled* by <@${state.by}>${at(state.at)} · ` +
          "nothing was changed"
      );
    case "failed":
      return row(
        `❌ *${escapeMrkdwn(state.title)}*` +
          (state.detail ? ` · ${escapeMrkdwn(clip(state.detail, 2500))}` : "")
      );
    case "unknown":
      return row(
        `⌛ *Outcome unknown* · ${escapeMrkdwn(state.reason)} · check the ` +
          `<${state.agentLink}|agent> or ask \`@release-manager list\` ` +
          "before approving again"
      );
    case "superseded":
      return row(
        "↪️ *Not applied* · origin changed" +
          (state.approver ? ` after <@${state.approver}> approved` : "") +
          " · a new plan is below"
      );
  }
}

export interface Placeholder {
  request: string;
  requester: string;
  agentLink?: string;
  startedAt?: number;
  minutes?: number;
}

/** "Planning …" while the agent works; the request stays literal. */
export function renderPlaceholder(p: Placeholder): Block[] {
  const parts = [`Requested by <@${p.requester}>`];
  if (p.startedAt !== undefined) {
    parts.push(`started ${when(p.startedAt)}`);
  }
  if (p.minutes) {
    parts.push(`still working (${p.minutes} min)`);
  }
  parts.push(p.agentLink ? `<${p.agentLink}|agent>` : "starting the agent");
  return [
    rich([
      {
        type: "rich_text_section",
        elements: [
          txt("⏳ Planning "),
          txt(clip(p.request, 500), { italic: true }),
          txt("…"),
        ],
      },
    ]),
    context([parts.join(" · ")]),
  ];
}

export function renderText(text: string): Block[] {
  return [rich([para([txt(clip(text, MAX_TEXT))])])];
}
