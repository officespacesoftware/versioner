/**
 * Slack's entry points. Slack needs an answer within three seconds, so
 * these only check the request, update the message, open a modal, and queue
 * a task; the work happens in handlers.ts.
 */

import { createHash } from "node:crypto";

import { collapse, withState } from "./blocks.js";
import { mrkdwn } from "./kit.js";
import { markStarted } from "./listing.js";
import { changesOriginAtOnce, isStartable } from "./requests.js";
import { loadingView, messageView, REVIEW_CALLBACK } from "./review.js";
import type { Block } from "./slack.js";
import {
  applyName,
  nowOf,
  ok,
  taskName,
  type ButtonValue,
  type Deps,
  type Reply,
  type Task,
  type Thread,
} from "./tasks.js";

const MAX_REQUEST_CHARS = 500;
const REVIEW_MINUTES = 15;
const ALREADY = "This plan was already approved or cancelled.";

/** Slack Events API: answer the URL check, queue a plan for each mention. */
export async function handleEvent(
  deps: Deps,
  body: Record<string, unknown>,
  isRetry: boolean
): Promise<Reply> {
  if (body.type === "url_verification") {
    return { status: 200, body: { challenge: body.challenge } };
  }
  if (body.type !== "event_callback" || isRetry) {
    return ok;
  }
  const event = body.event as Record<string, unknown> | undefined;
  if (
    !event ||
    event.type !== "app_mention" ||
    event.bot_id !== undefined ||
    typeof event.channel !== "string" ||
    !deps.config.channels.includes(event.channel)
  ) {
    return ok;
  }
  const request = String(event.text ?? "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim()
    .slice(0, MAX_REQUEST_CHARS);
  const task: Task = {
    kind: "plan",
    channel: event.channel,
    threadTs: String(event.thread_ts ?? event.ts),
    requester: String(event.user),
    request: request || "help",
  };
  await deps.queue.enqueue(task, {
    name: `plan-${String(body.event_id).replace(/[^A-Za-z0-9_-]/g, "")}`,
  });
  return ok;
}

export function readButton(value: unknown): ButtonValue | undefined {
  let b: Record<string, unknown> | null;
  try {
    b = JSON.parse(String(value)) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  const s = (v: unknown) => typeof v === "string";
  if (!b || !s(b.a) || !s(b.d) || !s(b.t) || !s(b.r) || !s(b.q)) {
    return undefined;
  }
  return b as unknown as ButtonValue;
}

const approverList = (deps: Deps): string =>
  deps.config.approvers.map((a) => `<@${a}>`).join(", ");

async function tell(
  deps: Deps,
  payload: Record<string, unknown>,
  text: string,
  icon = "🔒"
): Promise<void> {
  const responseUrl = payload.response_url;
  if (typeof responseUrl === "string") {
    await deps.slack.respondEphemeral(responseUrl, text, [
      mrkdwn(`${icon} ${text}`),
    ]);
  }
}

/** Slack interactivity: plan buttons, start buttons, and the review modal. */
export async function handleInteraction(
  deps: Deps,
  payload: Record<string, unknown>
): Promise<Reply> {
  if (payload.type === "view_submission") {
    return handleSubmission(deps, payload);
  }
  if (payload.type !== "block_actions") {
    return ok;
  }
  const action = (payload.actions as Array<Record<string, unknown>>)?.[0];
  const channel = (payload.channel as { id?: string } | undefined)?.id;
  const user = (payload.user as { id?: string } | undefined)?.id;
  const message = payload.message as
    | { ts?: string; thread_ts?: string; blocks?: Block[] }
    | undefined;
  if (
    !action ||
    !channel ||
    !user ||
    !message?.ts ||
    !deps.config.channels.includes(channel)
  ) {
    return ok;
  }
  const actionId = String(action.action_id ?? "");
  if (actionId.startsWith("link.")) {
    return ok;
  }
  const blocks = message.blocks ?? [];
  const thread: Thread = {
    channel,
    threadTs: message.thread_ts ?? message.ts,
  };
  const isApprover = deps.config.approvers.includes(user);

  if (actionId === "start_request") {
    return startRequest(deps, payload, {
      action,
      thread,
      messageTs: message.ts,
      blocks,
      user,
      isApprover,
    });
  }

  const button = readButton(action.value);
  if (!button) {
    return ok;
  }

  if (actionId === "review" || actionId === "details") {
    const triggerId = payload.trigger_id;
    if (typeof triggerId !== "string") {
      return ok;
    }
    const metadata = JSON.stringify({
      c: channel,
      m: message.ts,
      t: thread.threadTs,
      b: button,
      x: nowOf(deps) + REVIEW_MINUTES * 60,
    });
    const viewId = await deps.slack.openView(
      triggerId,
      loadingView(metadata, button.d)
    );
    const task: Task = {
      kind: "review",
      viewId,
      mode: actionId,
      canApprove: isApprover,
      button,
      metadata,
    };
    await deps.queue.enqueue(task);
    return ok;
  }

  if (actionId !== "approve" && actionId !== "cancel") {
    return ok;
  }
  if (!isApprover) {
    await tell(
      deps,
      payload,
      "Only release approvers can approve or cancel this plan: " +
        `${approverList(deps)}. Ask one of them in this thread.`
    );
    return ok;
  }

  if (actionId === "cancel") {
    const noop: Task = { kind: "noop" };
    if (!(await deps.queue.enqueue(noop, { name: applyName(button) }))) {
      await tell(deps, payload, ALREADY, "ℹ️");
      return ok;
    }
    await deps.slack.update(
      channel,
      message.ts,
      "Plan cancelled",
      collapse(blocks, { kind: "cancelled", by: user, at: nowOf(deps) })
    );
    return ok;
  }
  if (button.k !== "s") {
    return ok;
  }

  const approvedAt = nowOf(deps);
  const task: Task = {
    kind: "apply",
    ...thread,
    messageTs: message.ts,
    approver: user,
    button,
    blocks,
    approvedAt,
  };
  if (!(await deps.queue.enqueue(task, { name: applyName(button) }))) {
    await tell(deps, payload, ALREADY, "ℹ️");
    return ok;
  }
  await deps.slack.update(
    channel,
    message.ts,
    "Applying plan",
    withState(blocks, { kind: "applying", approver: user, at: approvedAt })
  );
  return ok;
}

/** The review modal's Approve: the same apply as the message's button. */
async function handleSubmission(
  deps: Deps,
  payload: Record<string, unknown>
): Promise<Reply> {
  const view = payload.view as
    | { callback_id?: string; private_metadata?: string }
    | undefined;
  const user = (payload.user as { id?: string } | undefined)?.id;
  if (view?.callback_id !== REVIEW_CALLBACK || !user) {
    return ok;
  }
  let meta: {
    c?: unknown;
    m?: unknown;
    t?: unknown;
    b?: unknown;
    x?: unknown;
  };
  try {
    meta = JSON.parse(String(view.private_metadata)) as typeof meta;
  } catch {
    return ok;
  }
  const button = readButton(JSON.stringify(meta.b ?? null));
  if (
    !button ||
    typeof meta.c !== "string" ||
    typeof meta.m !== "string" ||
    typeof meta.t !== "string" ||
    !deps.config.channels.includes(meta.c)
  ) {
    return ok;
  }
  const answer = (text: string): Reply => ({
    status: 200,
    body: {
      response_action: "update",
      view: messageView(String(view.private_metadata), text),
    },
  });
  if (!deps.config.approvers.includes(user)) {
    return answer(
      `🔒 Only release approvers can approve: ${approverList(deps)}.`
    );
  }
  if (typeof meta.x !== "number" || nowOf(deps) > meta.x) {
    return answer(
      `⌛ This review was open for over ${REVIEW_MINUTES} minutes. Close ` +
        "it and open it again from the message, which shows the plan's " +
        "current state."
    );
  }
  const task: Task = {
    kind: "apply",
    channel: meta.c,
    threadTs: meta.t,
    messageTs: meta.m,
    approver: user,
    button,
    approvedAt: nowOf(deps),
  };
  if (!(await deps.queue.enqueue(task, { name: applyName(button) }))) {
    return answer(`ℹ️ ${ALREADY}`);
  }
  return { status: 200, body: { response_action: "clear" } };
}

/**
 * A button that types a request for the person who clicks it. Requests
 * that change origin without an Approve step are for approvers only.
 */
async function startRequest(
  deps: Deps,
  payload: Record<string, unknown>,
  opts: {
    action: Record<string, unknown>;
    thread: Thread;
    messageTs: string;
    blocks: Block[];
    user: string;
    isApprover: boolean;
  }
): Promise<Reply> {
  let request: unknown;
  try {
    request = (JSON.parse(String(opts.action.value)) as { q?: unknown }).q;
  } catch {
    return ok;
  }
  if (typeof request !== "string" || !isStartable(request)) {
    return ok;
  }
  if (changesOriginAtOnce(request) && !opts.isApprover) {
    await tell(
      deps,
      payload,
      `Only release approvers can start \`${request}\`, because it can ` +
        `change origin without an Approve step: ${approverList(deps)}.`
    );
    return ok;
  }
  const blockId = String(opts.action.block_id ?? "");
  await deps.slack.update(
    opts.thread.channel,
    opts.messageTs,
    `Started ${request}`,
    markStarted(opts.blocks, blockId, opts.user, request)
  );
  const task: Task = {
    kind: "plan",
    ...opts.thread,
    requester: opts.user,
    request,
  };
  const hash = createHash("sha256")
    .update(`${blockId}\n${request}`)
    .digest("hex")
    .slice(0, 16);
  await deps.queue.enqueue(task, {
    name: taskName(`start-${opts.messageTs}-${hash}`),
  });
  return ok;
}
