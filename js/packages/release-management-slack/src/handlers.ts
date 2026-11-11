/**
 * Cloud Tasks steps: start a plan or an apply on a Cursor agent, poll it by
 * queueing itself again, and show what it returned. Slack's own entry points
 * are in interactions.ts and only queue these.
 *
 * Nothing is stored: each task carries the Slack message it updates and the
 * agent it watches, and an Approve button carries the agent, its run and the
 * digest. The release-management tools refuse a digest that no longer
 * matches, so a stale button cannot apply a plan that has changed.
 */

import { structuredOfRun } from "./artifacts.js";
import {
  footer,
  renderPlaceholder,
  renderPlan,
  renderText,
  STATE_BLOCK,
  toolTitle,
  withState,
  collapse,
  type PlanContext,
  type PlanState,
} from "./blocks.js";
import {
  agentUrl,
  CursorApiError,
  isTerminal,
  type AgentRun,
  type RunState,
} from "./cursor.js";
import {
  renderAgentError,
  renderFailed,
  renderLaunchError,
  renderRefused,
  renderRunEnded,
} from "./errors.js";
import { renderHandoff } from "./handoffs.js";
import { clip, context, mcode, mrkdwn } from "./kit.js";
import { renderChoose, renderVersions } from "./listing.js";
import { planDeletes, planTier, renderStructuredPlan } from "./plan.js";
import { applyFollowUp, applyFresh, planPrompt } from "./prompts.js";
import { parseAgentReply, replyTool, type AgentReply } from "./reply.js";
import { renderApplied, type ResultContext } from "./results.js";
import { messageView, planConfirm, reviewView } from "./review.js";
import { escapeMrkdwn, type Block } from "./slack.js";
import {
  nowOf,
  ok,
  taskName,
  type ButtonValue,
  type Deps,
  type Reply,
  type Request,
  type Task,
} from "./tasks.js";

export { handleEvent, handleInteraction } from "./interactions.js";
export type { ButtonValue, Deps, Reply, Task } from "./tasks.js";

const POLL_SECONDS = 10;
const MAX_POLLS = 90;
const MINUTES = (MAX_POLLS * POLL_SECONDS) / 60;
/** Polls after which the placeholder says the agent is still working. */
const STILL_WORKING = new Set([30, 60]);
const BUSY_RETRIES = 6;

/** Cloud Tasks: one step of a plan, an apply, or a review. */
export async function handleTask(deps: Deps, task: Task): Promise<Reply> {
  switch (task.kind) {
    case "plan":
      await startPlan(deps, task);
      return ok;
    case "apply":
      await startApply(deps, task);
      return ok;
    case "poll":
      await poll(deps, task);
      return ok;
    case "review":
      await showReview(deps, task);
      return ok;
    case "noop":
      return ok;
  }
}

async function startPlan(deps: Deps, task: Request): Promise<void> {
  const messageTs = await deps.slack.postInThread(
    task.channel,
    task.threadTs,
    "Planning…",
    renderPlaceholder({ request: task.request, requester: task.requester })
  );
  let run: AgentRun;
  try {
    run = await deps.cursor.launch(
      `Slack: ${task.request}`.slice(0, 100),
      planPrompt(deps.config.agentSetup, task.request, `<@${task.requester}>`)
    );
  } catch (error) {
    await deps.slack.update(
      task.channel,
      messageTs,
      "Could not start the agent",
      renderLaunchError(messageOf(error))
    );
    return;
  }
  const startedAt = nowOf(deps);
  await deps.slack.update(
    task.channel,
    messageTs,
    "Planning…",
    renderPlaceholder({
      request: task.request,
      requester: task.requester,
      agentLink: agentUrl(run.agentId),
      startedAt,
    })
  );
  await queuePoll(deps, {
    kind: "poll",
    mode: "plan",
    channel: task.channel,
    threadTs: task.threadTs,
    requester: task.requester,
    request: task.request,
    messageTs,
    run,
    attempt: 0,
    startedAt,
  });
}

type PlanReply = Extract<AgentReply, { kind: "plan" }>;

/** A finished run's reply, read with the structured output it left. */
async function replyOfRun(
  deps: Deps,
  run: AgentRun,
  state: RunState
): Promise<AgentReply> {
  const structured = await structuredOfRun(
    deps.cursor,
    run,
    state,
    replyTool(state.result),
    deps.log
  );
  return parseAgentReply(state.result, structured);
}

/** The plan reply from a run, re-read for the modal or a modal approval. */
async function planOfRun(
  deps: Deps,
  button: ButtonValue
): Promise<PlanReply | undefined> {
  if (!button.u) {
    return undefined;
  }
  const run = { agentId: button.a, runId: button.u };
  const state = await deps.cursor.getRun(run);
  if (state.status !== "FINISHED") {
    return undefined;
  }
  const reply = await replyOfRun(deps, run, state);
  return reply.kind === "plan" &&
    reply.digest.toLowerCase() === button.d.toLowerCase()
    ? reply
    : undefined;
}

async function showReview(
  deps: Deps,
  task: Extract<Task, { kind: "review" }>
): Promise<void> {
  const { button } = task;
  const link = agentUrl(button.a);
  const reply = await planOfRun(deps, button).catch(() => undefined);
  const view = reply
    ? reviewView(
        reply.plan ? { plan: reply.plan } : { planText: reply.planText },
        {
          metadata: task.metadata,
          mode: task.mode,
          canApprove: task.canApprove,
          ctx: {
            tool: reply.tool,
            digest: reply.digest,
            requester: button.r,
            agentLink: link,
            repoUrl: deps.config.githubRepoUrl,
            replaces: button.p,
          },
        }
      )
    : messageView(
        task.metadata,
        `Couldn't load plan ${mcode(button.d)}; open the <${link}|agent>.`
      );
  await deps.slack.updateView(task.viewId, view);
}

async function quietly(
  deps: Deps,
  what: string,
  step: () => Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (error) {
    deps.log?.(`${what} failed`, error);
  }
}

const isBusy = (error: unknown): boolean =>
  error instanceof CursorApiError && error.code === "agent_busy";

const notAccepted = (error: unknown): boolean =>
  error instanceof CursorApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 429].includes(error.status) &&
  !isBusy(error);

function recordOf(button: ButtonValue): Block[] {
  return [
    mrkdwn(
      `📋 ${escapeMrkdwn(toolTitle(button.t))} · plan ${mcode(button.d)}`,
      "record"
    ),
    { type: "context", block_id: STATE_BLOCK, elements: [] },
    footer({
      tool: button.t,
      digest: button.d,
      requester: button.r,
      agentLink: agentUrl(button.a),
    }),
  ];
}

async function planBlocksOf(deps: Deps, button: ButtonValue): Promise<Block[]> {
  const reply = await planOfRun(deps, button);
  return reply
    ? planMessage(deps, reply, {
        run: { agentId: button.a, runId: button.u ?? "" },
        requester: button.r,
        request: button.q,
        ...(button.p ? { replaces: button.p } : {}),
      })[1]
    : recordOf(button);
}

async function sentApply(
  deps: Deps,
  button: ButtonValue
): Promise<AgentRun | undefined> {
  if (!button.u) {
    return undefined;
  }
  const latest = await deps.cursor.latestRun(button.a);
  return latest && latest !== button.u
    ? { agentId: button.a, runId: latest }
    : undefined;
}

async function retryBusy(
  deps: Deps,
  task: Extract<Task, { kind: "apply" }>,
  blocks: Block[],
  fail: (detail: string) => Promise<void>
): Promise<void> {
  const busy = (task.busy ?? 0) + 1;
  if (busy > BUSY_RETRIES) {
    await fail(
      `the agent stayed busy for ${BUSY_RETRIES * POLL_SECONDS} s, so the ` +
        "apply was never sent · ask for a new plan"
    );
    return;
  }
  const { button } = task;
  await deps.queue.enqueue(
    { ...task, blocks, busy },
    {
      delaySeconds: POLL_SECONDS,
      name: taskName(
        `apply-busy-${button.a}-${button.u ?? ""}-${button.d}-${busy}`
      ),
    }
  );
}

async function startApply(
  deps: Deps,
  task: Extract<Task, { kind: "apply" }>
): Promise<void> {
  const { button } = task;
  const blocks = task.blocks ?? (await planBlocksOf(deps, button));
  const update = (text: string, state: PlanState) =>
    quietly(deps, "chat.update", () =>
      deps.slack.update(
        task.channel,
        task.messageTs,
        text,
        withState(blocks, state)
      )
    );
  const applying = (agentLink?: string) =>
    update("Applying plan", {
      kind: "applying",
      approver: task.approver,
      ...(task.approvedAt ? { at: task.approvedAt } : {}),
      ...(agentLink ? { agentLink } : {}),
    });
  const fail = (detail: string) =>
    update("Could not apply", { kind: "failed", title: "Not applied", detail });
  if (!task.blocks) {
    await applying();
  }
  let run: AgentRun;
  try {
    run =
      (await sentApply(deps, button)) ??
      (await deps.cursor.followUp(
        button.a,
        applyFollowUp(button.t, button.d, `<@${task.approver}>`)
      ));
  } catch (error) {
    if (isBusy(error)) {
      await retryBusy(deps, task, blocks, fail);
      return;
    }
    if (!notAccepted(error)) {
      throw error;
    }
    try {
      run = await deps.cursor.launch(
        `Slack apply: ${button.q}`.slice(0, 100),
        applyFresh(
          deps.config.agentSetup,
          button.q,
          `<@${button.r}>`,
          button.t,
          button.d,
          `<@${task.approver}>`
        )
      );
    } catch (launchError) {
      await fail(`could not start the agent: ${messageOf(launchError)}`);
      return;
    }
  }
  await queuePoll(deps, {
    kind: "poll",
    mode: "apply",
    channel: task.channel,
    threadTs: task.threadTs,
    requester: button.r,
    request: button.q,
    messageTs: task.messageTs,
    approver: task.approver,
    blocks,
    ...(task.approvedAt ? { approvedAt: task.approvedAt } : {}),
    digest: button.d,
    run,
    attempt: 0,
  });
  await applying(agentUrl(run.agentId));
}

async function queuePoll(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>
): Promise<void> {
  await deps.queue.enqueue(task, {
    delaySeconds: POLL_SECONDS,
    name: `poll-${task.run.runId}-${task.attempt}`.replace(
      /[^A-Za-z0-9_-]/g,
      ""
    ),
  });
}

async function poll(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>
): Promise<void> {
  const state = await deps.cursor.getRun(task.run).catch((error) => {
    deps.log?.("Cursor getRun failed", error);
    return undefined;
  });
  if (!state || !isTerminal(state.status)) {
    const attempt = task.attempt + 1;
    if (attempt >= MAX_POLLS) {
      await reportEnded(deps, task, "timeout");
      return;
    }
    if (task.mode === "plan" && STILL_WORKING.has(attempt)) {
      await deps.slack.update(
        task.channel,
        task.messageTs,
        "Planning…",
        renderPlaceholder({
          request: task.request,
          requester: task.requester,
          agentLink: agentUrl(task.run.agentId),
          ...(task.startedAt ? { startedAt: task.startedAt } : {}),
          minutes: (attempt * POLL_SECONDS) / 60,
        })
      );
    }
    await queuePoll(deps, { ...task, attempt });
    return;
  }
  if (state.status !== "FINISHED") {
    await reportEnded(deps, task, state.status);
    return;
  }
  await report(deps, task, await replyOfRun(deps, task.run, state));
}

function resultContext(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>
): ResultContext {
  return {
    requester: task.requester,
    approver: task.mode === "apply" ? task.approver : undefined,
    agentLink: agentUrl(task.run.agentId),
    repoUrl: deps.config.githubRepoUrl,
  };
}

/** A run that ended without a reply, or never ended within the timeout. */
async function reportEnded(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>,
  status: string
): Promise<void> {
  const ctx = resultContext(deps, task);
  const blocks = renderRunEnded(status, task.mode, ctx, MINUTES);
  const text =
    status === "timeout"
      ? `The agent did not finish within ${MINUTES} minutes`
      : `The agent run ended with ${status}`;
  if (task.mode === "plan") {
    await deps.slack.update(task.channel, task.messageTs, text, blocks);
    return;
  }
  const planBlocks = task.blocks;
  if (planBlocks) {
    await quietly(deps, "chat.update", () =>
      deps.slack.update(
        task.channel,
        task.messageTs,
        "Outcome unknown",
        withState(planBlocks, {
          kind: "unknown",
          reason:
            status === "timeout"
              ? `the agent was still running after ${MINUTES} min and may ` +
                "yet push"
              : `the agent run ended with ${status} and may have partly ` +
                "applied",
          agentLink: ctx.agentLink,
        })
      )
    );
  }
  await deps.slack.postInThread(task.channel, task.threadTs, text, blocks);
}

/** Show a finished run's reply: in place of the placeholder, or under the plan. */
async function report(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>,
  reply: AgentReply
): Promise<void> {
  const { channel, threadTs, messageTs } = task;

  if (task.mode === "plan") {
    const [text, blocks] = replyBlocks(deps, task, reply, "plan");
    await deps.slack.update(channel, messageTs, text, blocks);
    return;
  }

  const approver = task.approver ?? "";
  const planBlocks = task.blocks;
  const setPlan = async (text: string, state: PlanState) => {
    if (!planBlocks) {
      return;
    }
    const blocks =
      state.kind === "superseded"
        ? collapse(planBlocks, state)
        : withState(planBlocks, state);
    await quietly(deps, "chat.update", () =>
      deps.slack.update(channel, messageTs, text, blocks)
    );
  };
  const [text, blocks] = replyBlocks(deps, task, reply, "apply");
  await setPlan(...appliedState(reply, approver, task.approvedAt));
  await deps.slack.postInThread(channel, threadTs, text, blocks);
}

function appliedState(
  reply: AgentReply,
  approver: string,
  approvedAt: number | undefined
): [string, PlanState] {
  switch (reply.kind) {
    case "applied":
      return [
        "Plan applied",
        {
          kind: "applied",
          approver,
          ...(approvedAt ? { at: approvedAt } : {}),
        },
      ];
    case "plan":
      return ["Plan changed", { kind: "superseded", approver }];
    case "refused":
      return [
        "Not applied",
        {
          kind: "failed",
          title: "Not applied",
          detail: "the tool refused, so nothing was changed · details below",
        },
      ];
    case "failed":
      return [
        "Apply failed",
        {
          kind: "failed",
          title: "Failed part-way",
          detail: "something may have changed on origin · details below",
        },
      ];
    default:
      return [
        "Apply failed",
        { kind: "failed", title: "Apply failed", detail: "details below" },
      ];
  }
}

/** A plan message with its buttons, for a run that returned a plan. */
function planMessage(
  deps: Deps,
  reply: PlanReply,
  source: {
    run: AgentRun;
    requester: string;
    request: string;
    replaces?: string;
  }
): [string, Block[]] {
  const plan = reply.plan;
  const tier = plan ? planTier(plan) : "risky";
  const button: ButtonValue = {
    a: source.run.agentId,
    u: source.run.runId,
    d: reply.digest,
    t: reply.tool,
    r: source.requester,
    q: source.request,
    k: tier === "safe" ? "s" : "r",
    ...(source.replaces ? { p: source.replaces } : {}),
  };
  const ctx: PlanContext = {
    tool: reply.tool,
    digest: reply.digest,
    requester: source.requester,
    agentLink: agentUrl(source.run.agentId),
    repoUrl: deps.config.githubRepoUrl,
    replaces: source.replaces,
  };
  const state: PlanState = {
    kind: "awaiting",
    buttonValue: JSON.stringify(button),
    tier,
    ...(plan && tier === "safe" ? { confirm: planConfirm(plan) } : {}),
    ...(plan && planDeletes(plan) ? { deletes: true } : {}),
  };
  return [
    `Plan ${reply.digest} needs approval`,
    plan
      ? renderStructuredPlan(plan, ctx, state)
      : renderPlan(reply.planText, ctx, state),
  ];
}

function replyBlocks(
  deps: Deps,
  task: Extract<Task, { kind: "poll" }>,
  reply: AgentReply,
  stage: "plan" | "apply"
): [string, Block[]] {
  const ctx = resultContext(deps, task);
  switch (reply.kind) {
    case "plan": {
      const replaces =
        stage === "apply" ? (reply.replaces ?? task.digest) : undefined;
      return planMessage(deps, reply, {
        run: task.run,
        requester: task.requester,
        request: task.request,
        ...(replaces ? { replaces } : {}),
      });
    }
    case "applied":
      return ["Applied", renderApplied(reply, ctx)];
    case "handoff":
      return [
        reply.handoff?.code === "H2"
          ? "Decision needed"
          : "Manual downmerge needed",
        renderHandoff(reply, ctx),
      ];
    case "refused":
      return ["Refused", renderRefused(reply, ctx)];
    case "failed":
      return ["Failed", renderFailed(reply, stage, ctx)];
    case "versions":
      return [
        reply.purpose === "help" ? "Release manager help" : "In flight",
        renderVersions(reply, {
          requester: task.requester,
          agentLink: ctx.agentLink,
          repoUrl: ctx.repoUrl,
          request: task.request,
          at: nowOf(deps),
        }),
      ];
    case "choose":
      return [
        "Which branch?",
        renderChoose(reply, {
          requester: task.requester,
          agentLink: ctx.agentLink,
          repoUrl: ctx.repoUrl,
          request: task.request,
        }),
      ];
    case "message":
      return [
        escapeMrkdwn(clip(reply.text, 150)),
        [...renderText(reply.text), context([`<${ctx.agentLink}|agent>`])],
      ];
    case "error":
      return ["Failed", renderAgentError(reply.text, stage, ctx)];
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
