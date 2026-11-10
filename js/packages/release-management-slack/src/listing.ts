/**
 * Read-only and conversational replies: what's in flight, help, a request
 * the agent did not understand, and "which branch?". The rows come from
 * list_versions' structured output; all wording and examples are the app's.
 */

import {
  actions,
  clip,
  context,
  divider,
  header,
  list,
  mcode,
  mlink,
  mrkdwn,
  para,
  quote,
  rich,
  txt,
  when,
  type Element,
} from "./kit.js";
import { branchUrl, isVersion, tagUrl, type Repo } from "./links.js";
import type { AgentReply } from "./reply.js";
import { startButton } from "./requests.js";
import type { Block } from "./slack.js";
import type { VersionRow } from "./structured.js";

export interface ListContext {
  requester: string;
  agentLink: string;
  repoUrl?: string | undefined;
  /** The request as typed, quoted back when it was not understood. */
  request: string;
  /** Unix seconds: when the listing was read. */
  at: number;
}

const MAX_ROWS = 10;

const tagRef = (repo: Repo, version: string): string => {
  const url = tagUrl(repo, version);
  return url ? mlink(url, version) : mcode(version);
};

const branchRef = (repo: Repo, name: string): string => {
  const url = branchUrl(repo, name);
  return url ? mlink(url, name) : mcode(name);
};

const base = (version: string): string => version.replace(/-RC\.\d+$/, "");

/** One unmerged branch: its version, what to do next, and a button for it. */
function row(entry: VersionRow, repo: Repo): Block {
  const v = entry.version;
  const kind = entry.kind === "rc" ? "RC" : entry.kind;
  const head =
    (v ? `*${tagRef(repo, v)}*` : "*no version*") +
    ` · ${kind} · ${branchRef(repo, entry.branch)}`;
  let next: string;
  let accessory: Element | undefined;
  if (entry.kind === "unknown" || !v || !isVersion(v)) {
    next = "⚠️ No readable VERSION on origin; check the branch";
  } else if (entry.tag !== "remote") {
    next = `⚠️ Tag ${mcode(v)} is not on origin`;
  } else if (entry.kind === "rc") {
    next =
      "Next: promote it, or " +
      `${mcode(`increment the RC ${entry.branch}`)} for another candidate`;
    accessory = startButton(`Promote ${v}`, `promote ${entry.branch}`);
  } else {
    next = "Next: once Ops has deployed it, downmerge it into main";
    accessory = startButton(
      `Downmerge ${v} to main`,
      `downmerge ${entry.type} ${base(v)} to main`
    );
  }
  return {
    ...mrkdwn(`${head}\n${next}`, `row:${entry.branch}`.slice(0, 255)),
    ...(accessory ? { accessory } : {}),
  };
}

function mergedLine(entries: VersionRow[], repo: Repo): Block[] {
  const merged = entries.filter((e) => e.mergedIntoProduction);
  if (merged.length === 0) {
    return [];
  }
  const latest = merged
    .filter((e) => e.version && isVersion(e.version))
    .slice(0, 3)
    .map((e) => tagRef(repo, e.version as string));
  return [
    context([
      `Merged into main: ${merged.length}` +
        (latest.length > 0 ? ` · latest ${latest.join(", ")}` : ""),
    ]),
  ];
}

function inFlight(entries: VersionRow[], repo: Repo): Block[] {
  const open = entries.filter((e) => !e.mergedIntoProduction);
  if (open.length === 0) {
    return [
      {
        ...mrkdwn(
          "No release or hotfix branch is waiting to reach main.\n" +
            "Next: cut a release candidate from develop."
        ),
        accessory: startButton("Create an RC (minor)", "create an RC"),
      },
    ];
  }
  return [
    ...open.slice(0, MAX_ROWS).map((e) => row(e, repo)),
    ...(open.length > MAX_ROWS
      ? [context([`…and ${open.length - MAX_ROWS} more unmerged branches`])]
      : []),
  ];
}

const footer = (ctx: ListContext, extra = ""): Block =>
  context(
    [
      `Listed ${when(ctx.at)} · requested by <@${ctx.requester}> · ` +
        `<${ctx.agentLink}|agent>${extra}`,
    ],
    "footer"
  );

interface Example {
  what: string;
  say: string;
  approval: string;
}

/** Requests that work as typed, built from the branches in flight. */
function examples(entries: VersionRow[]): Example[] {
  const open = entries.filter((e) => !e.mergedIntoProduction);
  const rc = open.find((e) => e.kind === "rc");
  const final = open.find((e) => e.kind === "final" && e.version);
  const any = rc ?? open[0];
  const atOnce = "Applies at once; waits for approval if the plan has warnings";
  return [
    {
      what: "Cut an RC from develop",
      say: "create an RC",
      approval: `${atOnce}. Add major or patch for another bump`,
    },
    ...(rc
      ? [
          {
            what: "Next RC on a branch",
            say: `increment the RC ${rc.branch}`,
            approval: atOnce,
          },
          {
            what: "Promote an RC to final",
            say: `promote ${rc.branch}`,
            approval: "Approve button",
          },
        ]
      : []),
    { what: "Hotfix from main", say: "hotfix", approval: "Approve button" },
    ...(any
      ? [
          {
            what: "Undo the last version bump",
            say: `revert ${any.branch}`,
            approval:
              "Review & approve: RC.n → RC.n-1, final → its RC; RC.0 " +
              "abandons the branch",
          },
        ]
      : []),
    {
      what: "Downmerge",
      say:
        final && final.version
          ? `downmerge ${final.type} ${base(final.version)} to main`
          : "downmerge main to develop",
      approval:
        "None: it opens a pull request, which is the review. Conflicts into " +
        "develop are resolved by the agent in a pull request",
    },
    { what: "What's in flight", say: "list", approval: "Read-only" },
  ];
}

function exampleList(items: Example[], withApproval: boolean): Element {
  return list(
    items.map((e) => [
      txt(e.say, { code: true }),
      txt(` ${e.what}`),
      ...(withApproval ? [txt(` · ${e.approval}`, { italic: true })] : []),
    ])
  );
}

const APPROVAL = [
  "Anything that changes origin posts a plan first, listing every change. " +
    "A release approver applies it, or cancels it.",
  "A plan with no warnings and no deletions has Approve, with a one-line " +
    "confirmation. A plan with a ⚠️ warning or a deletion has Review & " +
    "approve instead: the full plan opens, and approving happens there.",
  "Approve applies exactly the plan shown. If the repository moved in " +
    "between, nothing is applied and the new plan is posted for review.",
  "A downmerge into develop that conflicts is resolved by the agent in a " +
    "pull request; into main it stops for a human decision.",
];

export function renderVersions(
  reply: Extract<AgentReply, { kind: "versions" }>,
  ctx: ListContext
): Block[] {
  const repo = ctx.repoUrl;
  if (!reply.entries) {
    return [
      rich([pre(clip(reply.text || "No listing came back.", 2900))]),
      footer(ctx),
    ];
  }
  const entries = reply.entries;
  const open = entries.filter((e) => !e.mergedIntoProduction);
  switch (reply.purpose) {
    case "unrecognized":
      return [
        rich([
          para([
            txt("🤷 I didn't understand "),
            txt(clip(ctx.request, 300), { italic: true }),
            txt(". Mention me with one of these:"),
          ]),
          exampleList(examples(entries), false),
        ]),
        context([
          "`@release-manager help` explains approval and shows what's in " +
            `flight · requested by <@${ctx.requester}> · ` +
            `<${ctx.agentLink}|agent>`,
        ]),
      ];
    case "help":
      return [
        header("🧭 Release manager: what I can do"),
        mrkdwn("*In flight*"),
        ...inFlight(entries, repo),
        ...mergedLine(entries, repo),
        divider,
        rich([
          para([
            txt("What to say", { bold: true }),
            txt(" (mention me, then one of these)"),
          ]),
          exampleList(examples(entries), true),
        ]),
        rich([
          para([txt("How approval works", { bold: true })]),
          list(APPROVAL.map((t) => [txt(t)])),
        ]),
        footer(ctx),
      ];
    default:
      return [
        header(
          open.length === 0
            ? "🔎 In flight: nothing"
            : `🔎 In flight: ${open.length} branch${open.length === 1 ? "" : "es"}`
        ),
        ...inFlight(entries, repo),
        ...mergedLine(entries, repo),
        divider,
        footer(ctx, " · `@release-manager help` for every request"),
      ];
  }
}

const pre = (text: string): Element => ({
  type: "rich_text_preformatted",
  elements: [txt(text)],
});

const CHOOSE_VERBS: Record<string, string> = {
  release_version: "promote",
  increment_release_candidate: "increment",
  revert_version: "revert",
  downmerge: "downmerge",
};

/** Several branches fit: one button per branch starts the exact request. */
export function renderChoose(
  reply: Extract<AgentReply, { kind: "choose" }>,
  ctx: Omit<ListContext, "at">
): Block[] {
  const verb = CHOOSE_VERBS[reply.tool] ?? "use";
  const first = reply.options[0];
  return [
    mrkdwn(`❓ *Which branch should I ${verb}?*`),
    ...(reply.reason ? [rich([quote([txt(clip(reply.reason, 2000))])])] : []),
    actions(
      reply.options.map((o) =>
        startButton(
          o.version ? `${o.branch} (${o.version})` : o.branch,
          o.request
        )
      ),
      "state"
    ),
    context(
      [
        (first
          ? `Or mention me with ${mcode(`@release-manager ${first.request}`)} · `
          : "") + `requested by <@${ctx.requester}> · <${ctx.agentLink}|agent>`,
      ],
      "footer"
    ),
  ];
}

/**
 * After a start button is clicked: the "which branch?" row says who chose
 * what; a row or section loses its button and says it was started.
 */
export function markStarted(
  blocks: Block[],
  blockId: string,
  user: string,
  request: string
): Block[] {
  return blocks.map((block) => {
    if (!blockId || block.block_id !== blockId) {
      return block;
    }
    if (block.type === "actions") {
      return context(
        [`↪️ <@${user}> chose ${mcode(request)}; the plan follows below.`],
        blockId
      );
    }
    const { accessory: _accessory, ...rest } = block as Block & {
      text?: { type: string; text: string };
    };
    const text = (rest.text as { text?: string } | undefined)?.text ?? "";
    return {
      ...rest,
      text: {
        type: "mrkdwn",
        text: clip(
          `${text}\n↪️ <@${user}> started ${mcode(request)} below`,
          3000
        ),
      },
    };
  });
}
