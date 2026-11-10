/**
 * Plans rendered from the MCP's structured plan, and the review modal.
 *
 * A plan answers, in order: what changes on origin (deletes first), which
 * code moves, which checks ran, and what needs a decision. Warnings sit
 * directly above the buttons. The tier decides how it is approved: a safe
 * plan has Approve with a one-sentence confirm; a risky one (any warning or
 * any deletion) is approved only from the modal that shows all of it.
 */

import {
  footer,
  replacesBlocks,
  stateBlock,
  type PlanContext,
  type PlanState,
  type Tier,
} from "./blocks.js";
import {
  chunkItems,
  clip,
  context,
  divider,
  emoji,
  fields,
  fit,
  header,
  link,
  list,
  mcode,
  mlink,
  para,
  plural,
  pre,
  rich,
  tail,
  txt,
  type Element,
  type Style,
} from "./kit.js";
import {
  branchUrl,
  commitUrl,
  compareUrl,
  isSha,
  pullUrl,
  type Repo,
} from "./links.js";
import { escapeMrkdwn, type Block } from "./slack.js";
import type { CommitRange, Mutation, Plan } from "./structured.js";

const sha11 = (sha: string): string => sha.slice(0, 11);

const branchRef = (repo: Repo, name: string): string => {
  const url = branchUrl(repo, name);
  return url ? mlink(url, name) : mcode(name);
};

/** Commits on the branch that no release candidate contained. */
const untested = (plan: Plan): number => {
  const since = plan.review.sinceVersion;
  return plan.action === "release_version" && since && since.filesChanged > 0
    ? since.count
    : 0;
};

export const planDeletes = (plan: Plan): boolean =>
  plan.mutations.some((m) => m.operation === "delete");

const unknownSince = (plan: Plan): boolean =>
  plan.action === "release_version" && !plan.review.sinceVersion;

export function planTier(plan: Plan): Tier {
  return plan.warnings.length > 0 ||
    planDeletes(plan) ||
    untested(plan) > 0 ||
    unknownSince(plan)
    ? "risky"
    : "safe";
}

const isFinalRevert = (plan: Plan): boolean =>
  plan.mutations.some(
    (m) => m.kind === "github-release" && m.operation === "delete"
  ) || plan.warnings.some((w) => w.code === "W12");

export function structuredTitle(plan: Plan): string {
  const from = plan.currentVersion ?? "";
  const to = plan.resultingVersion ?? "";
  switch (plan.action) {
    case "release_version":
      return `Promote ${from} → ${to}`;
    case "create_release_candidate":
      return `Create release candidate ${to}`;
    case "increment_release_candidate":
      return `Increment ${from} → ${to}`;
    case "create_hotfix":
      return `Create hotfix ${to}`;
    case "revert_version":
      if (plan.shape === "abandon") {
        return `Abandon ${plan.targetBranch} (deletes the branch)`;
      }
      return `${isFinalRevert(plan) ? "Revert final" : "Revert"} ${from} → ${to}`;
    default:
      return plan.action.replace(/_/g, " ");
  }
}

function rangeText(range: CommitRange, repo: Repo): string {
  if (range.count === 0) {
    return "no commits";
  }
  const url = compareUrl(repo, range.baseSha, range.headSha);
  return (
    `${plural(range.count, "commit")} · ${plural(range.filesChanged, "file")}` +
    (url ? ` · ${mlink(url, "compare")}` : "")
  );
}

function planFields(plan: Plan, repo: Repo): string[] {
  const out: string[] = [];
  const head = isSha(plan.targetBranchHead)
    ? ` at ${mcode(sha11(plan.targetBranchHead))}`
    : "";
  const created = plan.mutations.find(
    (m) => m.kind === "branch" && m.operation === "create" && m.ref.name
  );
  out.push(
    created?.ref.name
      ? `*New branch*\n${mcode(created.ref.name)} off ` +
          `${branchRef(repo, plan.targetBranch)}${head}`
      : `*Branch*\n${branchRef(repo, plan.targetBranch)}${head}`
  );
  if (plan.shape === "abandon" && plan.currentVersion) {
    out.push(
      `*Version*\n${mcode(plan.currentVersion)} → none ` +
        "(first version on the branch)"
    );
  } else if (plan.currentVersion && plan.resultingVersion) {
    out.push(
      `*Version*\n${mcode(plan.currentVersion)} → ` +
        mcode(plan.resultingVersion)
    );
  }
  const { ships, sinceVersion, reverts } = plan.review;
  switch (plan.action) {
    case "release_version":
      if (sinceVersion) {
        out.push(
          `*Since ${escapeMrkdwn(sinceVersion.base)}*\n` +
            (sinceVersion.count === 0
              ? "✅ Only `VERSION` changes. The tested build is the one " +
                "that ships."
              : sinceVersion.filesChanged === 0
                ? `✅ ${rangeText(sinceVersion, repo)}: no file differs, ` +
                  "so the tested build is the one that ships."
                : `⚠️ ${rangeText(sinceVersion, repo)}, in no release ` +
                  "candidate")
        );
      }
      if (ships) {
        out.push(`*Reaches main*\n${rangeText(ships, repo)}`);
      }
      break;
    case "create_release_candidate":
      if (ships) {
        out.push(`*In this release*\n${rangeText(ships, repo)}`);
      }
      break;
    case "increment_release_candidate":
      if (ships) {
        out.push(
          `*New since ${escapeMrkdwn(plan.currentVersion ?? ships.base)}*\n` +
            rangeText(ships, repo)
        );
      }
      break;
    case "create_hotfix":
      out.push("*Code*\nNone yet: the branch is main plus the version bump");
      break;
    case "revert_version":
      if (reverts) {
        const url = commitUrl(repo, reverts.sha);
        const label = `${reverts.sha.slice(0, 7)} ${reverts.subject}`;
        out.push(
          `*Undoes*\n${url ? mlink(url, label) : mcode(label)}` +
            (reverts.files.length > 0
              ? ` (${escapeMrkdwn(reverts.files.slice(0, 5).join(", "))})`
              : "")
        );
      }
      if (plan.shape === "abandon" && ships) {
        out.push(
          `*Work lost*\n` +
            (ships.count <= 1
              ? `None: only the version bump is not in ${mcode(ships.base)}`
              : `${plural(ships.count, "commit")} not in ` + mcode(ships.base))
        );
      }
      break;
  }
  return out;
}

export const LABELS: Record<Mutation["kind"], string> = {
  branch: "Branch",
  commit: "Commit",
  tag: "Tag",
  push: "Push",
  "pull-request": "Pull request",
  "github-release": "GitHub release",
};

const intoMain = (m: Mutation): boolean =>
  m.kind === "pull-request" && m.ref.base === "main" && m.operation !== "close";

function icon(m: Mutation): string {
  if (m.operation === "delete") {
    return m.kind === "github-release" ? "octagonal_sign" : "wastebasket";
  }
  if (m.operation === "close") {
    return "heavy_multiplication_x";
  }
  switch (m.kind) {
    case "branch":
      return "herb";
    case "commit":
      return "memo";
    case "tag":
      return "label";
    case "push":
      return "arrow_up";
    case "github-release":
      return "package";
    case "pull-request":
      return intoMain(m) ? "red_circle" : "twisted_rightwards_arrows";
  }
}

/** The summary, with its "PR #n" turned into a link built from the number. */
function summaryElements(m: Mutation, repo: Repo, style?: Style): Element[] {
  const url = pullUrl(repo, m.ref.number);
  const marker = `PR #${m.ref.number}`;
  const at = url ? m.summary.indexOf(marker) : -1;
  if (!url || at === -1) {
    return [txt(m.summary, style)];
  }
  return [
    ...(at > 0 ? [txt(m.summary.slice(0, at), style)] : []),
    link(url, marker, style),
    ...(at + marker.length < m.summary.length
      ? [txt(m.summary.slice(at + marker.length), style)]
      : []),
  ].filter((e) => e.type === "link" || e.text !== "");
}

const INLINE_DETAILS = new Set([
  "title",
  "files",
  "recovery",
  "irreversible",
  "effect",
  "url",
]);

const DETAIL_LABELS: Record<string, string> = {
  targetCommitish: "Points at",
  message: "Tag message",
  resulting: "VERSION becomes",
  comment: "Comment",
};

function mutationLine(m: Mutation, repo: Repo): Element[] {
  const destructive =
    m.operation === "delete" &&
    (m.kind === "github-release" || m.kind === "branch");
  const style = destructive ? { bold: true } : undefined;
  const out: Element[] = [
    emoji(icon(m)),
    txt(` ${LABELS[m.kind]}: `, style),
    ...summaryElements(m, repo, style),
  ];
  const { detail } = m;
  if (m.kind === "pull-request" && detail.title) {
    out.push(txt(`, titled “${detail.title}”`));
  }
  if (intoMain(m)) {
    out.push(txt(" (production)", { bold: true }));
  }
  if (m.kind === "commit" && detail.files) {
    out.push(txt(` · files: ${detail.files}`));
  }
  if (m.kind === "github-release" && m.operation === "delete") {
    out.push(
      txt(
        ". Cannot be undone: " +
          `${detail.irreversible ?? "its release notes are destroyed"}` +
          (detail.effect ? `; ${detail.effect}` : "") +
          ".",
        { bold: true }
      )
    );
  }
  if (
    m.kind === "tag" &&
    m.operation === "delete" &&
    /on origin$/.test(m.summary)
  ) {
    out.push(txt(". A build or deploy it already triggered is not undone."));
  }
  return out;
}

/** Sub-items under a change: the recovery command, and in the modal all. */
function mutationDetails(m: Mutation, modal: boolean): Element[][] {
  const out: Element[][] = [];
  for (const [key, value] of Object.entries(m.detail)) {
    if (key === "recovery") {
      out.push([txt("Recovery: "), txt(value, { code: true })]);
    } else if (modal && !INLINE_DETAILS.has(key)) {
      out.push([txt(`${DETAIL_LABELS[key] ?? key}: ${value}`)]);
    }
  }
  return out;
}

const GROUPS: Array<{
  ops: Mutation["operation"][];
  title: (ms: Mutation[]) => Element[];
}> = [
  {
    ops: ["delete"],
    title: (ms) => [
      txt(
        ms.some((m) => m.kind === "github-release")
          ? "Deletes, including what can't be undone"
          : "Deletes",
        { bold: true }
      ),
    ],
  },
  { ops: ["create"], title: () => [txt("Creates", { bold: true })] },
  {
    ops: ["update", "close"],
    title: (ms) => {
      const updates = ms.some((m) => m.operation === "update");
      const closes = ms.some((m) => m.operation === "close");
      const name =
        updates && closes
          ? "Updates and closes"
          : updates
            ? "Updates"
            : "Closes";
      return [txt(name, { bold: true })];
    },
  },
];

function changesBlock(plan: Plan, repo: Repo, modal: boolean): Block[] {
  const elements: Element[] = [];
  for (const group of GROUPS) {
    const ms = plan.mutations.filter((m) => group.ops.includes(m.operation));
    if (ms.length === 0) {
      continue;
    }
    elements.push(para(group.title(ms)));
    let run: Element[][] = [];
    for (const m of ms) {
      run.push(mutationLine(m, repo));
      const details = mutationDetails(m, modal);
      if (details.length > 0) {
        elements.push(list(run));
        elements.push(list(details, "bullet", 1));
        run = [];
      }
    }
    if (run.length > 0) {
      elements.push(list(run));
    }
  }
  return elements.length > 0 ? [rich(elements, "changes")] : [];
}

function commitHeading(plan: Plan, range: CommitRange): string {
  switch (plan.action) {
    case "release_version":
      return `What reaches main when the pull request into main merges (${range.count})`;
    case "create_release_candidate":
      return `Newest of the ${range.count} commits in this release`;
    case "increment_release_candidate":
      return `New in this release candidate (${range.count})`;
    case "revert_version":
      return `Commits on ${range.head} not in ${range.base} (${range.count})`;
    default:
      return `Commits (${range.count})`;
  }
}

function commitBlocks(
  plan: Plan,
  repo: Repo,
  limit: number,
  perBlock: number
): Block[] {
  const range = plan.review.ships;
  if (!range || range.commits.length === 0) {
    return [];
  }
  const shown = range.commits.slice(0, limit);
  const items = shown.map((c): Element[] => {
    const url = commitUrl(repo, c.sha);
    const sha = c.sha.slice(0, 7);
    return [
      url ? link(url, sha, { code: true }) : txt(sha, { code: true }),
      txt(` ${clip(c.subject, 200)} · ${clip(c.author, 60)}`),
    ];
  });
  const blocks = chunkItems(items, perBlock).map((group, i) =>
    rich(
      [
        ...(i === 0
          ? [para([txt(commitHeading(plan, range), { bold: true })])]
          : []),
        list(group),
      ],
      `commits-${i}`
    )
  );
  const more = range.count - shown.length;
  const url = compareUrl(repo, range.baseSha, range.headSha);
  if (more > 0) {
    const last = blocks[blocks.length - 1] as { elements: Element[] };
    last.elements.push(
      para([
        txt(`…and ${more} more. `, { italic: true }),
        ...(url ? [link(url, `All ${range.count} on GitHub`)] : []),
      ])
    );
  }
  return blocks;
}

const CHECK_ICONS = { passed: "✅", failed: "❌", timeout: "⏱️" } as const;

function checksBlock(plan: Plan): Block[] {
  if (plan.checks.length === 0) {
    return [];
  }
  const sha = plan.checks[0]?.sha;
  const runs = plan.checks.map((c) => {
    const facts = [
      c.status === "failed" && c.exitCode !== undefined
        ? `exit ${c.exitCode}`
        : c.status === "timeout"
          ? "timed out"
          : "",
      c.status !== "passed" && c.seconds ? `${Math.round(c.seconds)} s` : "",
    ].filter(Boolean);
    return (
      `${CHECK_ICONS[c.status]} ${escapeMrkdwn(c.name)}` +
      (facts.length > 0 ? ` (${facts.join(", ")})` : "")
    );
  });
  return [
    context([
      `Checks${isSha(sha) ? ` on ${mcode(sha11(sha))}` : ""}: ${runs.join(" · ")}`,
    ]),
  ];
}

/** N1 is the "update" on its line; N4 is on the tag deletion's line. */
const FOLDED = new Set(["N1", "N4"]);

function notesBlock(plan: Plan): Block[] {
  const notes = [
    ...plan.notices
      .filter((n) => !n.code || !FOLDED.has(n.code))
      .map((n) => `ℹ️ ${escapeMrkdwn(n.text)}`),
    ...(plan.mergePreview
      ? [`ℹ️ ${escapeMrkdwn(plan.mergePreview.text)}`]
      : []),
    ...(plan.pipelineTrigger
      ? [`🔧 ${escapeMrkdwn(plan.pipelineTrigger.text)}`]
      : []),
  ];
  return notes.length > 0 ? [context(notes)] : [];
}

const OUTPUT_LINES = 8;
const OUTPUT_CHARS = 800;
const CHUNK = 2900;
const MAX_CHUNKS = 6;

function warningTexts(plan: Plan): string[] {
  const texts = plan.warnings.map((w) => w.text);
  const since = plan.review.sinceVersion;
  if (untested(plan) > 0 && since) {
    texts.push(
      `${plan.targetBranch} has ${plural(since.count, "commit")} that no ` +
        "release candidate contained. Promoting ships them untested."
    );
  }
  if (unknownSince(plan)) {
    texts.push(
      `The plan does not say which commits on ${plan.targetBranch} no ` +
        "release candidate contained. Check the commits before promoting."
    );
  }
  return texts;
}

function warningBlocks(plan: Plan, modal: boolean): Block[] {
  const texts = warningTexts(plan);
  const outputs = plan.checkOutput.filter((o) => o.output.trim() !== "");
  if (texts.length === 0 && outputs.length === 0) {
    return [];
  }
  const items = texts.map((t) => [txt(modal ? t : clip(t, 500))]);
  const style = items.length > 1 ? "ordered" : "bullet";
  const groups = chunkItems(items, 30);
  let offset = 0;
  const blocks: Block[] = groups.map((group, i) => {
    const block = rich([
      ...(i === 0
        ? [
            para([
              emoji("warning"),
              txt(` ${plural(texts.length, "warning")} to decide on`, {
                bold: true,
              }),
            ]),
          ]
        : []),
      ...(group.length > 0
        ? [{ ...list(group, style), ...(offset ? { offset } : {}) }]
        : []),
    ]);
    offset += group.length;
    return block;
  });
  let cut = false;
  for (const o of outputs) {
    if (modal) {
      const full = o.output.replace(/\s+$/, "");
      const start = Math.max(0, full.length - CHUNK * MAX_CHUNKS);
      for (let i = start; i < full.length; i += CHUNK) {
        blocks.push(
          rich(
            [
              ...(i === start
                ? [para([txt(`Output of ${o.name}`, { bold: true })])]
                : []),
              pre(
                (i === start && start > 0 ? "…" : "") + full.slice(i, i + CHUNK)
              ),
            ],
            `output-${blocks.length}`
          )
        );
      }
    } else {
      const shown = tail(o.output, OUTPUT_LINES, OUTPUT_CHARS);
      cut ||= shown.length < o.output.trim().length;
      const lines = o.output.trim().split("\n").length;
      blocks.push(
        rich([
          para([
            txt(
              `Output of ${o.name}` +
                (lines > OUTPUT_LINES
                  ? `, last ${OUTPUT_LINES} of ${lines} lines`
                  : ""),
              { italic: true }
            ),
          ]),
          pre(shown),
        ])
      );
    }
  }
  if (cut) {
    blocks.push(
      rich([para([txt("Full output in Review & approve.", { italic: true })])])
    );
  }
  return blocks;
}

export function planBody(
  plan: Plan,
  ctx: PlanContext,
  modal: boolean
): Block[] {
  const repo = ctx.repoUrl;
  return [
    header(`📋 ${structuredTitle(plan)}`),
    ...replacesBlocks(ctx),
    fields(planFields(plan, repo)),
    ...changesBlock(plan, repo, modal),
    ...(modal
      ? commitBlocks(plan, repo, 50, 25)
      : commitBlocks(plan, repo, 5, 5)),
    ...checksBlock(plan),
    ...notesBlock(plan),
    divider,
    ...warningBlocks(plan, modal),
  ];
}

export function renderStructuredPlan(
  plan: Plan,
  ctx: PlanContext,
  state: PlanState
): Block[] {
  return fit([...planBody(plan, ctx, false), stateBlock(state), footer(ctx)]);
}
