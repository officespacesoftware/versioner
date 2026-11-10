/**
 * The agent's final reply: the kind, the tool, the plan's digest and text.
 * The structure comes from the MCP's own file of the call when there is
 * one, then from an `output` the agent copied, then from the text.
 */

import { isBranch, isVersion, SOURCE_BRANCH } from "./links.js";
import { isStartable } from "./requests.js";
import {
  digestOf,
  readOutput,
  readResolution,
  type Applied,
  type Handoff,
  type Plan,
  type Resolution,
  type Step,
  type VersionRow,
} from "./structured.js";

export type Purpose = "list" | "help" | "unrecognized";

export interface ChooseOption {
  branch: string;
  request: string;
  version?: string;
}

export type AgentReply =
  | {
      kind: "plan";
      tool: string;
      digest: string;
      planText: string;
      plan?: Plan;
      /** The digest a D1 refused, when the plan came back as `stale`. */
      replaces?: string;
    }
  | {
      kind: "applied";
      tool: string;
      summary: string;
      result?: Applied;
      /** An H1 handoff the agent carried out, with what it did. */
      handoff?: Handoff;
      resolution?: Resolution;
    }
  | { kind: "handoff"; tool: string; text: string; handoff?: Handoff }
  | { kind: "refused"; tool: string; text: string; code?: string }
  | {
      kind: "failed";
      tool: string;
      text: string;
      code?: string;
      steps: Step[];
    }
  | { kind: "versions"; purpose: Purpose; entries?: VersionRow[]; text: string }
  | {
      kind: "choose";
      tool: string;
      reason?: string;
      options: ChooseOption[];
    }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string };

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const DIGEST = /^[0-9a-f]{6,64}$/i;

const FIELDS = new Set([
  "kind",
  "tool",
  "digest",
  "planText",
  "summary",
  "text",
  "purpose",
  "reason",
]);

/** The end of the JSON string that opens at `at`, or -1 if unclosed. */
function stringEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (text[i] === '"') {
      return i;
    }
  }
  return -1;
}

const decode = (literal: string): string | undefined => {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
};

const skipSpace = (text: string, at: number): number => {
  let i = at;
  while (/\s/.test(text[i] ?? "")) {
    i++;
  }
  return i;
};

/**
 * The top-level string fields of a reply whose JSON does not parse, scanned
 * up to where it breaks.
 */
export function salvageReply(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  let depth = 0;
  for (let i = text.indexOf("{"); i !== -1 && i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (c === '"') {
      const end = stringEnd(text, i);
      if (end === -1) {
        break;
      }
      const colon = skipSpace(text, end + 1);
      const value = skipSpace(text, colon + 1);
      if (depth === 1 && text[colon] === ":" && text[value] === '"') {
        const valueEnd = stringEnd(text, value);
        if (valueEnd === -1) {
          break;
        }
        const key = decode(text.slice(i, end + 1)) ?? "";
        const decoded = decode(text.slice(value, valueEnd + 1));
        if (FIELDS.has(key) && !(key in found) && decoded !== undefined) {
          found[key] = decoded;
        }
        i = valueEnd;
      } else {
        i = end;
      }
    }
  }
  return found;
}

/** The reply's JSON object, or what could be salvaged from it. */
function replyJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const json: unknown = JSON.parse(text.slice(start, end + 1));
      if (json && typeof json === "object" && !Array.isArray(json)) {
        return json as Record<string, unknown>;
      }
    } catch {
      return salvageReply(text);
    }
  }
  return salvageReply(text);
}

/** The tool the reply names, to pick the run's structured output with. */
export function replyTool(result: string | undefined): string {
  return str(replyJson((result ?? "").trim()).tool);
}

const CARRIES: Record<string, string[]> = {
  plan: ["plan", "stale"],
  applied: ["applied", "handoff"],
  handoff: ["handoff"],
  refused: ["refused"],
  failed: ["failed"],
  versions: ["versions"],
};

/** Whether a structured output can stand for a reply of this kind. */
function carries(kind: unknown, structured: unknown): boolean {
  const outputKind = (structured as { kind?: unknown } | null)?.kind;
  return (
    kind === undefined ||
    (typeof kind === "string" &&
      typeof outputKind === "string" &&
      (CARRIES[kind]?.includes(outputKind) ?? false))
  );
}

/**
 * Read the agent's final reply, with the structured output the MCP wrote
 * for the run if one was found. Tolerates a code fence or prose around the
 * object, and salvages the plain fields of one that does not parse; with
 * nothing usable it becomes an error that shows the raw reply.
 */
export function parseAgentReply(
  result: string | undefined,
  structured?: unknown
): AgentReply {
  const text = (result ?? "").trim();
  const json = replyJson(text);
  const fromFile =
    structured !== undefined && carries(json.kind, structured)
      ? fromOutput({ ...json, output: structured })
      : undefined;
  return (
    fromFile ??
    fromOutput(json) ??
    fromText(json) ?? {
      kind: "error",
      text: `The agent's reply could not be read:\n${text.slice(0, 1500)}`,
    }
  );
}

/** The structured reply, when `output` is a valid structuredContent. */
function fromOutput(json: Record<string, unknown>): AgentReply | undefined {
  const output = readOutput(json.output);
  if (!output) {
    return undefined;
  }
  switch (output.kind) {
    case "plan":
    case "stale": {
      const digest = output.plan.digest;
      const claimed = str(json.digest);
      if (
        !DIGEST.test(digest) ||
        !same(digestOf(output.plan), digest) ||
        (claimed && !same(claimed, digest))
      ) {
        return undefined;
      }
      return {
        kind: "plan",
        tool: output.tool,
        digest,
        planText: str(json.planText),
        plan: output.plan,
        ...(output.kind === "stale" && DIGEST.test(output.provided)
          ? { replaces: output.provided }
          : {}),
      };
    }
    case "applied": {
      const handoff = output.result.manualDownmerge;
      const resolution = handoff && readResolution(json.resolution, handoff);
      return {
        kind: "applied",
        tool: output.tool,
        summary: str(json.summary),
        result: output.result,
        ...(handoff ? { handoff } : {}),
        ...(resolution ? { resolution } : {}),
      };
    }
    case "handoff": {
      const { handoff } = output;
      const resolution =
        handoff.code === "H1"
          ? readResolution(json.resolution, handoff)
          : undefined;
      if (resolution) {
        return {
          kind: "applied",
          tool: "downmerge",
          summary: str(json.summary),
          handoff,
          resolution,
        };
      }
      return {
        kind: "handoff",
        tool: "downmerge",
        text: handoff.text,
        handoff,
      };
    }
    case "refused":
      return refusedOrChoose(output.tool, output.text, output.code);
    case "failed":
      return {
        kind: "failed",
        tool: output.tool,
        text: output.text,
        ...(output.code ? { code: output.code } : {}),
        steps: output.steps,
      };
    case "versions":
      return {
        kind: "versions",
        purpose: purposeOf(json.purpose),
        entries: output.entries,
        text: "",
      };
  }
}

/** The text-only reply: the contract before structured output, kept. */
function fromText(json: Record<string, unknown>): AgentReply | undefined {
  switch (json.kind) {
    case "plan":
      if (
        !DIGEST.test(str(json.digest)) ||
        !str(json.planText) ||
        !str(json.tool)
      ) {
        return undefined;
      }
      return {
        kind: "plan",
        tool: str(json.tool),
        digest: str(json.digest),
        planText: str(json.planText),
      };
    case "applied":
      return {
        kind: "applied",
        tool: str(json.tool),
        summary: str(json.summary),
      };
    case "handoff":
      return { kind: "handoff", tool: "downmerge", text: str(json.text) };
    case "refused":
      return refusedOrChoose(str(json.tool), str(json.text), undefined);
    case "failed":
      return {
        kind: "failed",
        tool: str(json.tool),
        text: str(json.text),
        steps: [],
      };
    case "versions":
      return {
        kind: "versions",
        purpose: purposeOf(json.purpose),
        text: str(json.text),
      };
    case "choose":
      return chooseOf(json);
    case "message":
      return { kind: "message", text: str(json.text) };
    case "error":
      return { kind: "error", text: str(json.text) };
    default:
      return undefined;
  }
}

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const purposeOf = (value: unknown): Purpose =>
  value === "help" || value === "unrecognized" ? value : "list";

const VERBS: Record<string, string> = {
  release_version: "promote",
  increment_release_candidate: "increment the RC",
  revert_version: "revert",
};

/**
 * S1 and S8 refuse because two branches fit; the branches are in the text,
 * so the app offers both rather than showing a refusal.
 */
function refusedOrChoose(
  tool: string,
  text: string,
  code: string | undefined
): AgentReply {
  const verb = VERBS[tool];
  if (verb && (code === "S1" || code === "S8")) {
    const branches = [
      ...new Set(text.match(/\b(?:release|hotfix)\/\d+\.\d+\.\d+\b/g) ?? []),
    ];
    if (branches.length >= 2) {
      return {
        kind: "choose",
        tool,
        reason: text,
        options: branches.map((branch) => ({
          branch,
          request: `${verb} ${branch}`,
        })),
      };
    }
  }
  return { kind: "refused", tool, text, ...(code ? { code } : {}) };
}

function chooseOf(json: Record<string, unknown>): AgentReply {
  const raw = Array.isArray(json.options) ? json.options.slice(0, 5) : [];
  const options: ChooseOption[] = [];
  for (const entry of raw) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const branch = str(o.branch);
    const request = str(o.request);
    const version = str(o.version);
    if (
      SOURCE_BRANCH.test(branch) &&
      isStartable(request) &&
      request.includes(branch.split("/")[1] as string)
    ) {
      options.push({
        branch,
        request,
        ...(isVersion(version) ? { version } : {}),
      });
    }
  }
  if (options.length < 2) {
    const named = options.map((o) => o.branch).filter(isBranch);
    return {
      kind: "message",
      text:
        "Several branches could match. Mention me with the full branch " +
        `name, such as ${named[0] ?? "release/1.4.0"}.`,
    };
  }
  return {
    kind: "choose",
    tool: str(json.tool),
    ...(str(json.reason) ? { reason: str(json.reason).slice(0, 2000) } : {}),
    options,
  };
}
