/**
 * Requests a button can start for the person who clicks it. Each is one the
 * person could have typed in a mention; the button only saves the typing.
 * Values come back from Slack, so they are checked against this grammar.
 */

import { button, type Confirm, type Element } from "./kit.js";

const V = String.raw`\d+\.\d+\.\d+`;
const RC = String.raw`${V}(?:-RC\.\d+)?`;
const TARGET = String.raw`(?:(?:release|hotfix)\/)?${RC}`;

const GRAMMAR = new RegExp(
  "^(?:" +
    [
      "create an RC(?: major| minor| patch)?",
      `increment the RC ${TARGET}`,
      `promote ${TARGET}`,
      "hotfix",
      `revert ${TARGET}`,
      `downmerge (?:main|release ${V}|hotfix ${V}) to (?:develop|main)`,
      "list",
      "help",
    ].join("|") +
    ")$"
);

export const isStartable = (request: string): boolean =>
  request.length <= 100 && GRAMMAR.test(request);

/**
 * Requests that change origin without an Approve step: a release candidate
 * without warnings applies at once, and a downmerge opens its pull request.
 */
export const changesOriginAtOnce = (request: string): boolean =>
  /^(?:create an RC|increment the RC|downmerge)\b/.test(request);

/** The confirm dialog a start button carries, or none for plan-only ones. */
export function startConfirm(request: string): Confirm | undefined {
  if (/^create an RC/.test(request)) {
    return {
      title: "Create a release candidate?",
      text:
        `Plans "${request}". If the plan has no warnings it applies at ` +
        "once, without an Approve step: a release branch, tag and pull " +
        "request on origin.",
      confirm: "Create it",
    };
  }
  if (/^increment the RC/.test(request)) {
    return {
      title: "Cut the next release candidate?",
      text:
        `Plans "${request}". If the plan has no warnings it applies at ` +
        "once, without an Approve step: a version commit and tag on origin.",
      confirm: "Increment",
    };
  }
  const downmerge = /^downmerge (\S+)(?: (\S+))? to (\S+)$/.exec(request);
  if (downmerge) {
    const [, source, version, target] = downmerge as unknown as [
      string,
      string,
      string | undefined,
      string,
    ];
    const what = version ? `${source} ${version}` : source;
    return target === "main"
      ? {
          title: `Downmerge ${what} into main?`,
          text:
            `Only after Ops has deployed ${version ?? source} to every ` +
            "production host. This opens the pull request into main at " +
            "once; that pull request is the review, there is no Approve step.",
          confirm: "Open the PR",
          danger: true,
        }
      : {
          title: `Downmerge ${what} into develop?`,
          text:
            "Opens a pull request into develop at once; that pull request " +
            "is the review, there is no Approve step. If it conflicts, the " +
            "agent resolves it in a pull request.",
          confirm: "Open the PR",
        };
  }
  return undefined;
}

/** The request a start button carries, as its value. */
export const startValue = (request: string): string =>
  JSON.stringify({ q: request });

export const startButton = (
  text: string,
  request: string,
  style?: "primary" | "danger"
): Element => {
  const confirm = startConfirm(request);
  return button({
    actionId: "start_request",
    text,
    value: startValue(request),
    ...(style ? { style } : {}),
    ...(confirm ? { confirm } : {}),
  });
};
