/**
 * Small Block Kit builders shared by every message, and Slack's limits.
 *
 * Text that comes from the agent or a tool goes into rich_text `text`
 * elements, which Slack never parses as mrkdwn, or through `escapeMrkdwn`
 * when it has to sit in mrkdwn.
 */

import { escapeMrkdwn, type Block } from "./slack.js";

export const MAX_BLOCKS = 50;
export const MAX_MODAL_BLOCKS = 100;
export const MAX_TEXT = 3000;
export const MAX_FIELD = 2000;
export const MAX_HEADER = 150;
/** Rich text blocks have no documented cap; stay well under section's. */
export const RICH_BUDGET = 2500;

export type Element = Record<string, unknown>;

export interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The last lines of some output, cut to a character budget from the end. */
export function tail(text: string, lines: number, chars: number): string {
  const kept = text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
  return kept.length > chars ? `…${kept.slice(kept.length - chars)}` : kept;
}

export const txt = (text: string, style?: Style): Element =>
  style ? { type: "text", text, style } : { type: "text", text };

export const link = (url: string, text: string, style?: Style): Element =>
  style ? { type: "link", url, text, style } : { type: "link", url, text };

export const emoji = (name: string): Element => ({ type: "emoji", name });

export const para = (elements: Element[]): Element => ({
  type: "rich_text_section",
  elements,
});

export const list = (
  items: Element[][],
  style: "bullet" | "ordered" = "bullet",
  indent = 0
): Element => ({
  type: "rich_text_list",
  style,
  indent,
  elements: items.map(para),
});

export const pre = (text: string): Element => ({
  type: "rich_text_preformatted",
  elements: [txt(text)],
});

export const quote = (elements: Element[]): Element => ({
  type: "rich_text_quote",
  elements,
});

export const rich = (elements: Element[], blockId?: string): Block => ({
  type: "rich_text",
  ...(blockId ? { block_id: blockId } : {}),
  elements,
});

export const plain = (text: string): Element => ({
  type: "plain_text",
  text,
  emoji: true,
});

export const header = (text: string): Block => ({
  type: "header",
  text: plain(clip(text, MAX_HEADER)),
});

export const mrkdwn = (text: string, blockId?: string): Block => ({
  type: "section",
  ...(blockId ? { block_id: blockId } : {}),
  text: { type: "mrkdwn", text: clip(text, MAX_TEXT) },
});

export const fields = (texts: string[]): Block => ({
  type: "section",
  fields: texts
    .slice(0, 10)
    .map((text) => ({ type: "mrkdwn", text: clip(text, MAX_FIELD) })),
});

export const context = (texts: string[], blockId?: string): Block => ({
  type: "context",
  ...(blockId ? { block_id: blockId } : {}),
  elements: texts
    .slice(0, 10)
    .map((text) => ({ type: "mrkdwn", text: clip(text, MAX_TEXT) })),
});

export const divider: Block = { type: "divider" };

export interface Confirm {
  title: string;
  text: string;
  confirm: string;
  danger?: boolean;
}

export const confirmDialog = (c: Confirm): Element => ({
  title: { type: "plain_text", text: clip(c.title, 100) },
  text: { type: "plain_text", text: clip(c.text, 300) },
  confirm: { type: "plain_text", text: clip(c.confirm, 30) },
  deny: { type: "plain_text", text: "Back" },
  ...(c.danger ? { style: "danger" } : {}),
});

export function button(opts: {
  actionId: string;
  text: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
  confirm?: Confirm;
}): Element {
  return {
    type: "button",
    action_id: opts.actionId,
    text: plain(clip(opts.text, 75)),
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.value === undefined ? {} : { value: opts.value }),
    ...(opts.url === undefined ? {} : { url: opts.url }),
    ...(opts.confirm ? { confirm: confirmDialog(opts.confirm) } : {}),
  };
}

export const actions = (elements: Element[], blockId?: string): Block => ({
  type: "actions",
  ...(blockId ? { block_id: blockId } : {}),
  elements: elements.slice(0, 25),
});

/** `<url|label>`, with the label escaped so it cannot close the link. */
export const mlink = (url: string, label: string): string =>
  `<${url}|${escapeMrkdwn(label).replace(/\|/g, "∣")}>`;

/** Inline code in mrkdwn; a backtick inside would end it early. */
export const mcode = (text: string): string =>
  `\`${escapeMrkdwn(text).replace(/`/g, "ˋ")}\``;

/** A Slack date token, which each reader sees in their own time zone. */
export const when = (at: number): string =>
  `<!date^${Math.floor(at)}^{date_short_pretty} {time}|` +
  `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC>`;

export const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Keep a message under Slack's block limit. Renderers stay well under it;
 * this is the backstop, and it keeps the last blocks (state row, footer).
 */
export function fit(blocks: Block[], max = MAX_BLOCKS, keepLast = 2): Block[] {
  if (blocks.length <= max) {
    return blocks;
  }
  return [
    ...blocks.slice(0, max - keepLast - 1),
    context(["…cut to fit Slack's block limit; the agent has the rest."]),
    ...blocks.slice(blocks.length - keepLast),
  ];
}

const textSize = (elements: Element[]): number =>
  elements.reduce(
    (n, e) => n + (typeof e.text === "string" ? e.text.length : 0),
    0
  );

/**
 * Split rich-text list items into groups that each fit one rich_text block:
 * at most `perGroup` items and about `budget` characters of text.
 */
export function chunkItems(
  items: Element[][],
  perGroup: number,
  budget = RICH_BUDGET
): Element[][][] {
  const groups: Element[][][] = [];
  let current: Element[][] = [];
  let used = 0;
  for (const item of items) {
    const size = textSize(item);
    if (
      current.length > 0 &&
      (current.length >= perGroup || used + size > budget)
    ) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}
