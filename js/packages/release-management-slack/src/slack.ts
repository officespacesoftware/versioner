import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects replays older than five minutes, and so do we. */
const MAX_SKEW_SECONDS = 300;

export type Block = Record<string, unknown>;

/**
 * Check a request's `X-Slack-Signature` against the signing secret, as Slack
 * documents: HMAC-SHA256 over `v0:<timestamp>:<raw body>`.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMs: number = Date.now()
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return false;
  }
  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Escape the three characters Slack's mrkdwn treats as markup. */
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async call(
    method: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.ok !== true) {
      throw new Error(
        `Slack ${method} failed: ${String(json.error ?? res.status)}`
      );
    }
    return json;
  }

  /** Post in a thread and return the new message's ts. */
  async postInThread(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: Block[]
  ): Promise<string> {
    const res = await this.call("chat.postMessage", {
      channel,
      thread_ts: threadTs,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
    });
    return String(res.ts);
  }

  async update(
    channel: string,
    ts: string,
    text: string,
    blocks: Block[]
  ): Promise<void> {
    await this.call("chat.update", { channel, ts, text, blocks });
  }

  /** Answer an interaction privately, through its response URL. */
  async respondEphemeral(
    responseUrl: string,
    text: string,
    blocks?: Block[]
  ): Promise<void> {
    if (!responseUrl.startsWith("https://hooks.slack.com/")) {
      throw new Error("Refusing to post to a response URL outside Slack");
    }
    await this.fetchFn(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text,
        ...(blocks ? { blocks } : {}),
      }),
    });
  }

  /** Open a modal from a button's trigger; returns the view's id. */
  async openView(triggerId: string, view: Block): Promise<string> {
    const res = await this.call("views.open", { trigger_id: triggerId, view });
    return String((res.view as { id?: unknown } | undefined)?.id ?? "");
  }

  async updateView(viewId: string, view: Block): Promise<void> {
    await this.call("views.update", { view_id: viewId, view });
  }
}
