/**
 * Result cards for applied actions: what was made, every object linked,
 * problems first, and the next step. Rendered from the structured result;
 * every link is built from the repository URL and a validated name.
 */

import { toolTitle } from "./blocks.js";
import { handoffBody } from "./handoffs.js";
import {
  actions,
  button,
  clip,
  context,
  divider,
  fields,
  header,
  list,
  mcode,
  mlink,
  mrkdwn,
  para,
  plural,
  pre,
  rich,
  tail,
  txt,
  type Element,
} from "./kit.js";
import {
  branchUrl,
  checksUrl,
  compareUrl,
  isVersion,
  pullUrl,
  safeUrl,
  tagUrl,
  type Repo,
} from "./links.js";
import type { AgentReply } from "./reply.js";
import { startButton } from "./requests.js";
import { escapeMrkdwn, type Block } from "./slack.js";
import type {
  AppliedPull,
  Applied,
  Handoff,
  Resolution,
} from "./structured.js";

export interface ResultContext {
  requester: string;
  /** Who approved the plan; absent when the run needed no approval. */
  approver?: string | undefined;
  agentLink: string;
  repoUrl?: string | undefined;
}

type Applied$ = Extract<AgentReply, { kind: "applied" }>;

const ref = (repo: Repo, name: string): string => {
  const url = branchUrl(repo, name);
  return url ? mlink(url, name) : mcode(name);
};

const tagRef = (repo: Repo, name: string): string => {
  const url = tagUrl(repo, name);
  return url ? mlink(url, name) : mcode(name);
};

const pullLink = (repo: Repo, p: { number?: number; url?: string }): string => {
  const url = pullUrl(repo, p.number) ?? safeUrl(repo, p.url);
  const label = p.number ? `PR #${p.number}` : "pull request";
  return url ? mlink(url, label) : escapeMrkdwn(label);
};

const footerBlock = (ctx: ResultContext, approval: string): Block =>
  context(
    [
      `Requested by <@${ctx.requester}> · ` +
        (ctx.approver ? `approved by <@${ctx.approver}>` : approval) +
        ` · <${ctx.agentLink}|agent>`,
    ],
    "footer"
  );

function title(reply: Applied$): { icon: string; text: string } {
  const r = reply.result;
  const from = r?.from ?? "";
  const to = r?.to ?? "";
  if (reply.tool === "downmerge") {
    if (reply.handoff && reply.resolution) {
      const draft =
        reply.resolution.draft || reply.resolution.unresolvedFiles.length > 0;
      return {
        icon: draft ? "⚠️" : "🔀",
        text:
          `Downmerge ${reply.handoff.sourceBranch} → ${reply.handoff.target}: ` +
          (draft ? "draft PR, needs a human" : "conflicts resolved in PR"),
      };
    }
    const route = r?.route;
    const pr = r?.pullRequests[0];
    return {
      icon: "🔀",
      text:
        `Downmerge ${route?.source ?? "?"} → ${route?.target ?? "?"}: ` +
        (pr?.change === "alreadyOpen"
          ? `${pr.number ? `PR #${pr.number}` : "PR"} already open`
          : "PR opened"),
    };
  }
  switch (reply.tool) {
    case "create_release_candidate":
      return {
        icon: "✅",
        text: `${r?.resumed ? "Finished" : "Created"} release candidate ${to}`,
      };
    case "create_hotfix":
      return { icon: "✅", text: `Created hotfix ${to}` };
    case "increment_release_candidate":
      return { icon: "✅", text: `Incremented ${from} → ${to}` };
    case "release_version":
      return { icon: "✅", text: `Promoted ${from} → ${to}` };
    case "revert_version":
      return r?.shape === "abandon"
        ? {
            icon: "✅",
            text: `Abandoned ${r.branch?.name ?? "the branch"} (${from})`,
          }
        : { icon: "✅", text: `Reverted ${from} → ${to}` };
    default:
      return { icon: "✅", text: `${toolTitle(reply.tool)} applied` };
  }
}

const PROBLEM_LABELS: Record<string, string> = {
  R1: "Pull request not opened or updated.",
  R2: "Release notes are empty.",
  R3: "Release notes failed.",
  R4: "Release notes are empty.",
  R5: "Release notes not saved.",
  R6: "Pull request into develop not refreshed.",
  R7: "Draft pull request into develop not opened.",
  R8: "Pull request not updated or closed.",
  R9: "Superseded pull request not closed.",
  R10: "Promotion's pull request into main not closed.",
};

function problemBlocks(r: Applied): Block[] {
  const blocks: Block[] = [];
  const branch = r.branch?.name ?? r.mergeBranch ?? "the branch";
  if (r.pipeline?.status === "failed") {
    blocks.push(
      mrkdwn(
        `⚠️ *No build is running for ${mcode(branch)}. Start it by hand.*\n` +
          escapeMrkdwn(r.pipeline.message)
      )
    );
    if (r.pipeline.output?.trim()) {
      blocks.push(rich([pre(tail(r.pipeline.output, 8, 800))]));
    }
  }
  if (r.problems.length > 0) {
    blocks.push(
      rich([
        list(
          r.problems.map((p) => [
            txt(`${PROBLEM_LABELS[p.code ?? ""] ?? "A step needs a hand."} `, {
              bold: true,
            }),
            txt(clip(p.text, 600)),
          ])
        ),
      ])
    );
  }
  return blocks;
}

const CHANGES: Record<AppliedPull["change"], string> = {
  opened: "opened",
  updated: "updated",
  closed: "closed",
  superseded: "closed as superseded",
  alreadyOpen: "already open, nothing new created",
};

function pullField(p: AppliedPull, repo: Repo, hotfix: boolean): string {
  const label =
    p.change === "superseded"
      ? "Closed"
      : p.base === "main" || p.base === "develop"
        ? `Into ${p.base}`
        : "Pull request";
  const notes = [
    CHANGES[p.change],
    p.draft ? "draft" : "",
    p.base === "main" && p.change === "opened"
      ? `merge after the ${hotfix ? "hotfix" : "release"} is deployed`
      : "",
  ].filter(Boolean);
  return (
    `*${label}*\n${pullLink(repo, p)}` +
    (p.title ? ` ${escapeMrkdwn(p.title)}` : "") +
    ` (${notes.join(", ")})`
  );
}

function resultFields(reply: Applied$, r: Applied, repo: Repo): string[] {
  const out: string[] = [];
  const b = r.branch;
  if (b) {
    out.push(
      `*Branch*\n` +
        (b.change === "deleted"
          ? `~${escapeMrkdwn(b.name)}~ deleted`
          : ref(repo, b.name) +
            (b.change === "created"
              ? ` (new${b.base ? `, off ${escapeMrkdwn(b.base)}` : ""})`
              : b.change === "existing"
                ? " (already on origin)"
                : r.shape === "revert"
                  ? " (revert commit pushed)"
                  : ""))
    );
  }
  if (r.from && r.to && r.shape !== "abandon") {
    out.push(`*Version*\n${mcode(r.from)} → ${mcode(r.to)}`);
  }
  if (r.tag) {
    const t = r.tag;
    out.push(
      `*Tag*\n` +
        (t.change === "deleted"
          ? `~${escapeMrkdwn(t.name)}~ deleted`
          : t.change === "absent"
            ? `${mcode(t.name)} was already gone`
            : tagRef(repo, t.name) +
              (t.change === "existing" ? " (already on origin)" : ""))
    );
  }
  if (r.githubRelease) {
    const g = r.githubRelease;
    out.push(
      `*GitHub release*\n` +
        (g.change === "deleted"
          ? `~${escapeMrkdwn(g.tag)}~ deleted`
          : `${tagRef(repo, g.tag)} (Latest)`)
    );
  }
  const hotfix =
    /^hotfix\//.test(b?.name ?? "") || r.route?.source === "hotfix";
  for (const p of r.pullRequests) {
    out.push(pullField(p, repo, hotfix));
  }
  if (
    r.pullRequests.length === 0 &&
    reply.tool !== "downmerge" &&
    !r.manualDownmerge &&
    b
  ) {
    out.push(`*Pull request*\nnone open on ${mcode(b.name)}`);
  }
  if (r.mergeBranch) {
    out.push(`*Merge branch*\n${ref(repo, r.mergeBranch)}`);
  }
  const compare =
    (reply.tool === "create_release_candidate" ||
      reply.tool === "increment_release_candidate") &&
    isVersion(r.from) &&
    isVersion(r.to)
      ? compareUrl(repo, r.from, r.to)
      : undefined;
  if (compare && r.from && r.to) {
    out.push(`*Changes*\n${mlink(compare, `${r.from}…${r.to}`)}`);
  }
  return out;
}

/** What the agent did with an H1 handoff: one line per resolved file. */
export function resolutionBlocks(
  handoff: Handoff,
  resolution: Resolution,
  repo: Repo,
  heading?: string
): Block[] {
  const blocks: Block[] = [];
  const done = resolution.resolvedFiles;
  if (heading) {
    blocks.push(mrkdwn(heading));
  }
  if (done.length > 0) {
    blocks.push(
      mrkdwn(
        `*${plural(done.length, "conflicted file")} resolved.* ` +
          "Check each one in the PR:"
      )
    );
  }
  const elements: Element[] = [];
  if (done.length > 0) {
    elements.push(
      list(
        done
          .slice(0, 30)
          .map((f) => [txt(f.path, { code: true }), txt(` ${f.reason}`)])
      )
    );
  }
  if (resolution.unresolvedFiles.length > 0) {
    elements.push(para([txt("Left for a human:", { bold: true })]));
    elements.push(
      list(
        resolution.unresolvedFiles
          .slice(0, 30)
          .map((f) => [txt(f.path, { code: true }), txt(` ${f.reason}`)])
      )
    );
  }
  if (elements.length > 0) {
    blocks.push(rich(elements));
  }
  blocks.push(
    fields([
      `*Into ${handoff.target}*\n` +
        `${pullLink(repo, { number: resolution.pullRequest })} ` +
        `${escapeMrkdwn(handoff.title)}${resolution.draft ? " (draft)" : ""}`,
      `*Branch*\n${ref(repo, resolution.branch)}`,
      ...resolution.closedPullRequests.map(
        (n) => `*Closed*\n${pullLink(repo, { number: n })} (superseded)`
      ),
    ])
  );
  return blocks;
}

function linkButtons(reply: Applied$, repo: Repo): Element[] {
  const r = reply.result;
  const out: Element[] = [];
  const add = (kind: string, text: string, url: string | undefined) => {
    if (url && out.length < 3) {
      out.push(
        button({
          actionId: `link.${kind}`,
          text,
          url,
          ...(out.length === 0 ? { style: "primary" as const } : {}),
        })
      );
    }
  };
  if (reply.resolution) {
    const url = pullUrl(repo, reply.resolution.pullRequest);
    add(
      "resolution",
      `Review PR #${reply.resolution.pullRequest}`,
      url && `${url}/files`
    );
  }
  if (r?.pipeline?.status === "failed" && r.branch) {
    add(
      "checks",
      `Open ${r.branch.name} checks`,
      checksUrl(repo, r.branch.name)
    );
  }
  if (r?.githubRelease?.change === "created") {
    add("release", "Release notes", tagUrl(repo, r.githubRelease.tag));
  }
  for (const p of r?.pullRequests ?? []) {
    if (p.change === "opened" || p.change === "alreadyOpen") {
      add(
        "pr",
        `${reply.tool === "downmerge" ? "Review" : "Open"} PR #${p.number}`,
        pullUrl(repo, p.number)
      );
    }
  }
  return out;
}

const versionOf = (branch: string | undefined): string | undefined =>
  /^(?:release|hotfix)\/(\d+\.\d+\.\d+)$/.exec(branch ?? "")?.[1];

function nextStep(
  reply: Applied$
): { text: string; button?: Element } | undefined {
  const r = reply.result;
  const branch = r?.branch?.name ?? "";
  const to = r?.to ?? "";
  const code = (s: string) => mcode(s);
  switch (reply.tool) {
    case "create_release_candidate":
      return {
        text:
          `test ${escapeMrkdwn(to)} on staging. Fixes go on ${code(branch)}, ` +
          `then ${code(`@release-manager increment the RC ${branch}`)}; when ` +
          `it passes, ${code(`@release-manager promote ${branch}`)}.`,
        button: startButton(`Promote ${to}`, `promote ${branch}`),
      };
    case "increment_release_candidate":
      return {
        text:
          `test ${escapeMrkdwn(to)}. When it passes, ` +
          `${code(`@release-manager promote ${branch}`)}.`,
        button: startButton(`Promote ${to}`, `promote ${branch}`),
      };
    case "release_version": {
      const type = branch.startsWith("hotfix/") ? "hotfix" : "release";
      const version = versionOf(branch) ?? to;
      const toMain = `downmerge ${type} ${version} to main`;
      return {
        text:
          `deploy ${escapeMrkdwn(to)} to production. Then ` +
          `${code(`@release-manager ${toMain}`)}, and ` +
          code(`@release-manager downmerge ${type} ${version} to develop`) +
          ".",
        button: startButton(`Downmerge ${to} to main`, toMain, "danger"),
      };
    }
    case "create_hotfix":
      return {
        text:
          `push the fix to ${code(branch)}, then ` +
          `${code(`@release-manager promote ${branch}`)}. After the deploy, ` +
          code(
            `@release-manager downmerge hotfix ${versionOf(branch) ?? to} ` +
              "to develop"
          ) +
          ".",
      };
    case "revert_version":
      return r?.shape === "abandon"
        ? undefined
        : {
            text:
              `push the fix to ${code(branch)}, then ` +
              `${code(`@release-manager increment the RC ${branch}`)}.`,
          };
    case "downmerge": {
      const n = reply.resolution?.pullRequest ?? r?.pullRequests[0]?.number;
      const pr = n ? `PR #${n}` : "the pull request";
      const target = reply.handoff?.target ?? r?.route?.target;
      return {
        text:
          target === "main"
            ? `merge ${pr} only after the ${r?.route?.source ?? "release"} ` +
              "is deployed to production, or close it to reject the downmerge."
            : `review ${pr} and its checks; merge once green, or close it ` +
              "to reject the downmerge.",
      };
    }
    default:
      return undefined;
  }
}

/** A result card: what was applied, with every object it made linked. */
export function renderApplied(reply: Applied$, ctx: ResultContext): Block[] {
  const repo = ctx.repoUrl;
  const r = reply.result;
  if (!r && !(reply.handoff && reply.resolution)) {
    return [
      mrkdwn(
        `✅ *${escapeMrkdwn(toolTitle(reply.tool))} applied.* ` +
          escapeMrkdwn(clip(reply.summary, 2800))
      ),
      footerBlock(ctx, "no approval needed"),
    ];
  }
  const head = title(reply);
  const failedPipeline = r?.pipeline?.status === "failed";
  const problems = r?.problems.length ?? 0;
  const pending = Boolean(reply.handoff && !reply.resolution);
  const icon = failedPipeline || problems > 0 || pending ? "⚠️" : head.icon;
  const suffix = failedPipeline
    ? ": no build started"
    : pending
      ? ": develop conflict needs a manual downmerge"
      : problems > 0
        ? `, ${plural(problems, "step")} need${problems === 1 ? "s" : ""} a hand`
        : "";
  const blocks: Block[] = [
    header(`${r?.dryRun ? "🧪 Dry run: " : ""}${icon} ${head.text}${suffix}`),
  ];
  if (r) {
    blocks.push(...problemBlocks(r));
  }
  if (r) {
    const f = resultFields(reply, r, repo);
    if (f.length > 0) {
      blocks.push(fields(f));
    }
  }
  if (reply.handoff && reply.resolution) {
    blocks.push(
      ...resolutionBlocks(
        reply.handoff,
        reply.resolution,
        repo,
        reply.tool === "downmerge"
          ? undefined
          : `🔀 *${escapeMrkdwn(reply.handoff.sourceBranch)} conflicted with ` +
              "develop*, so the agent resolved it in a pull request."
      )
    );
  }
  if (r) {
    if (reply.handoff && !reply.resolution) {
      blocks.push(divider, ...handoffBody(reply.handoff));
    }
    const notes = [
      ...(r.pipeline && r.pipeline.status !== "failed"
        ? [`🔧 Pipeline: ${escapeMrkdwn(r.pipeline.message)}`]
        : []),
      ...(r.resumed
        ? ["ℹ️ This resumed an earlier run that got as far as the push."]
        : []),
      ...r.warnings.map((w) => `⚠️ ${escapeMrkdwn(w.text)}`),
      ...r.notices.map((n) => `ℹ️ ${escapeMrkdwn(n.text)}`),
    ];
    if (notes.length > 0) {
      blocks.push(context(notes));
    }
  }
  const links = linkButtons(reply, repo);
  if (links.length > 0) {
    blocks.push(actions(links));
  }
  const next = nextStep(reply);
  if (next) {
    blocks.push({
      ...mrkdwn(`➡️ *Next:* ${next.text}`),
      ...(next.button ? { accessory: next.button } : {}),
    });
  }
  blocks.push(
    footerBlock(
      ctx,
      reply.resolution
        ? "resolved by the agent (the PR is the review)"
        : reply.tool === "downmerge"
          ? "no approval needed (the PR is the review)"
          : "no approval needed (no warnings)"
    )
  );
  return blocks;
}
