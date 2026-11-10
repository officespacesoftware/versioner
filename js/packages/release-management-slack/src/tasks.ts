/**
 * What the Slack handlers and the task steps share: the tasks queued for
 * Cloud Tasks, what a plan's buttons carry, and the dependencies.
 */

import type { Config } from "./config.js";
import type { AgentRun, CursorClient } from "./cursor.js";
import type { TaskQueue } from "./google.js";
import type { Block, SlackClient } from "./slack.js";

export interface Thread {
  channel: string;
  threadTs: string;
}

export interface Request extends Thread {
  requester: string;
  request: string;
}

/**
 * What a plan's buttons carry. Short keys: values cap at 2000 characters.
 * `u` is the run that returned the plan, so the review modal can re-read
 * it; `k` is the tier ("s" safe, "r" risky); `p` the digest it replaced.
 */
export interface ButtonValue {
  a: string;
  u?: string;
  d: string;
  t: string;
  r: string;
  q: string;
  k?: "s" | "r";
  p?: string;
}

export type Task =
  | ({ kind: "plan" } & Request)
  | ({
      kind: "apply";
      messageTs: string;
      approver: string;
      button: ButtonValue;
      /** The plan message; absent when approved from the modal. */
      blocks?: Block[];
      approvedAt?: number;
      busy?: number;
    } & Thread)
  | ({
      kind: "poll";
      mode: "plan" | "apply";
      messageTs: string;
      run: AgentRun;
      attempt: number;
      approver?: string;
      blocks?: Block[];
      startedAt?: number;
      approvedAt?: number;
      digest?: string;
    } & Request)
  | {
      kind: "review";
      viewId: string;
      mode: "review" | "details";
      canApprove: boolean;
      button: ButtonValue;
      metadata: string;
    }
  | { kind: "noop" };

export interface Deps {
  config: Config;
  slack: SlackClient;
  cursor: CursorClient;
  queue: TaskQueue;
  /** Unix seconds; injected so tests can fix it. */
  now?: () => number;
  log?: (message: string, error: unknown) => void;
}

export interface Reply {
  status: number;
  body?: unknown;
}

export const ok: Reply = { status: 200 };

export const nowOf = (deps: Deps): number =>
  deps.now ? deps.now() : Math.floor(Date.now() / 1000);

export const taskName = (text: string): string =>
  text.replace(/[^A-Za-z0-9_-]/g, "");

/** Approving twice, from the button and the modal, queues one apply. */
export const applyName = (button: ButtonValue): string =>
  taskName(`apply-${button.a}-${button.u ?? ""}-${button.d}`);
