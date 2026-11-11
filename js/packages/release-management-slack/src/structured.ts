/**
 * The release-management MCP's structuredContent (versioner PR #23,
 * `release-management-mcp/src/structured.ts`), as the agent copies it into
 * its reply. It passes through an LLM, so each reader checks every field it
 * keeps and returns undefined when a part the app relies on is wrong; the
 * caller then falls back to the text. Fields only shown, never acted on, are
 * dropped one by one instead. URLs in it are never read here.
 */

import { createHash } from "node:crypto";

export interface Coded {
  code?: string;
  text: string;
}

export type MutationKind =
  | "branch"
  | "commit"
  | "tag"
  | "push"
  | "pull-request"
  | "github-release";

export type Operation = "create" | "update" | "close" | "delete";

export interface MutationRef {
  name?: string;
  sha?: string;
  number?: number;
  head?: string;
  base?: string;
  title?: string;
  draft?: boolean;
}

export interface Mutation {
  kind: MutationKind;
  operation: Operation;
  summary: string;
  detail: Record<string, string>;
  ref: MutationRef;
}

export interface CheckRun {
  name: string;
  status: "passed" | "failed" | "timeout";
  exitCode?: number;
  seconds?: number;
  sha?: string;
}

export interface CheckOutput {
  name: string;
  output: string;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
}

export interface CommitRange {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  count: number;
  filesChanged: number;
  commits: Commit[];
}

export interface Review {
  versionFile?: { from: string; to: string };
  ships?: CommitRange;
  sinceVersion?: CommitRange;
  reverts?: { sha: string; subject: string; files: string[] };
}

export interface Plan {
  action: string;
  targetBranch: string;
  targetBranchHead: string;
  currentVersion?: string;
  resultingVersion?: string;
  shape?: "revert" | "abandon";
  mutations: Mutation[];
  warnings: Coded[];
  notices: Coded[];
  mergePreview?: Coded;
  pipelineTrigger?: Coded;
  checks: CheckRun[];
  checkOutput: CheckOutput[];
  review: Review;
  digest: string;
}

export interface DecisionOption {
  label: string;
  text: string;
  recommended: boolean;
}

export interface Handoff {
  code: "H1" | "H2";
  text: string;
  source: "main" | "release" | "hotfix";
  target: "develop" | "main";
  sourceBranch: string;
  version?: string;
  conflictedFiles: string[];
  resolutionBranch: string;
  title: string;
  steps: string[];
  options: DecisionOption[];
  increment?: { version: string; openPullRequest?: number };
}

export type PullChange =
  | "opened"
  | "updated"
  | "closed"
  | "superseded"
  | "alreadyOpen";

export interface AppliedPull {
  number?: number;
  url?: string;
  head: string;
  base: string;
  title?: string;
  change: PullChange;
  draft?: boolean;
}

export interface Pipeline {
  status: "started" | "skipped" | "failed";
  code?: string;
  message: string;
  output?: string;
}

export interface Step {
  name: string;
  status: string;
  error?: string;
}

export interface Applied {
  dryRun: boolean;
  branch?: { name: string; change: string; base?: string };
  from?: string;
  to?: string;
  shape?: "revert" | "abandon";
  resumed?: boolean;
  tag?: { name: string; change: string };
  githubRelease?: { tag: string; change: "created" | "deleted" };
  route?: { source: string; target: string };
  mergeBranch?: string;
  pullRequests: AppliedPull[];
  pipeline?: Pipeline;
  manualDownmerge?: Handoff;
  warnings: Coded[];
  notices: Coded[];
  problems: Coded[];
  steps: Step[];
  nextSteps: string[];
}

export interface VersionRow {
  branch: string;
  type: "release" | "hotfix";
  version: string | null;
  kind: "rc" | "final" | "unknown";
  tag: "remote" | "local-only" | "none";
  mergedIntoProduction: boolean;
}

export type Output =
  | { kind: "plan"; tool: string; plan: Plan }
  | { kind: "stale"; tool: string; text: string; provided: string; plan: Plan }
  | { kind: "applied"; tool: string; result: Applied }
  | { kind: "handoff"; tool: string; handoff: Handoff }
  | { kind: "refused"; tool: string; code?: string; text: string }
  | { kind: "failed"; tool: string; code?: string; text: string; steps: Step[] }
  | { kind: "versions"; tool: string; entries: VersionRow[] };

type Obj = Record<string, unknown>;

/** Thrown inside a reader when a required field is wrong. */
class Invalid extends Error {}

const LONG = 20_000;

const obj = (v: unknown): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Invalid();
  }
  return v as Obj;
};

const str = (v: unknown, max = 4000): string => {
  if (typeof v !== "string" || v.length > max) {
    throw new Invalid();
  }
  return v;
};

const optStr = (v: unknown, max = 4000): string | undefined =>
  v === undefined ? undefined : str(v, max);

const int = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Invalid();
  }
  return v;
};

const optInt = (v: unknown): number | undefined =>
  v === undefined ? undefined : int(v);

const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") {
    throw new Invalid();
  }
  return v;
};

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => {
  if (!values.includes(v as T)) {
    throw new Invalid();
  }
  return v as T;
};

const arr = <T>(v: unknown, max: number, item: (v: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) {
    throw new Invalid();
  }
  return v.map(item);
};

/** Items that fail are dropped: for lists that are only shown. */
const some = <T>(v: unknown, max: number, item: (v: unknown) => T): T[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: T[] = [];
  for (const entry of v.slice(0, max)) {
    const read = attempt(() => item(entry));
    if (read !== undefined) {
      out.push(read);
    }
  }
  return out;
};

/** A field only shown: wrong means absent, not invalid. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof Invalid) {
      return undefined;
    }
    throw error;
  }
}

const def = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const coded = (v: unknown): Coded => {
  const o = obj(v);
  const code = optStr(o.code, 8);
  return { ...def("code", code), text: str(o.text, LONG) };
};

const MUTATION_KINDS = [
  "branch",
  "commit",
  "tag",
  "push",
  "pull-request",
  "github-release",
] as const;
const OPERATIONS = ["create", "update", "close", "delete"] as const;

function mutationRef(v: unknown): MutationRef {
  if (v === undefined) {
    return {};
  }
  const o = obj(v);
  return {
    ...def(
      "name",
      attempt(() => optStr(o.name, 200))
    ),
    ...def(
      "sha",
      attempt(() => optStr(o.sha, 64))
    ),
    ...def(
      "number",
      attempt(() => optInt(o.number))
    ),
    ...def(
      "head",
      attempt(() => optStr(o.head, 200))
    ),
    ...def(
      "base",
      attempt(() => optStr(o.base, 200))
    ),
    ...def(
      "title",
      attempt(() => optStr(o.title, 300))
    ),
    ...def(
      "draft",
      attempt(() => (o.draft === undefined ? undefined : bool(o.draft)))
    ),
  };
}

function mutation(v: unknown): Mutation {
  const o = obj(v);
  const detail: Record<string, string> = {};
  if (o.detail !== undefined) {
    for (const [key, value] of Object.entries(obj(o.detail)).slice(0, 20)) {
      detail[str(key, 100)] = str(value, 2000);
    }
  }
  return {
    kind: oneOf(o.kind, MUTATION_KINDS),
    operation: oneOf(o.operation, OPERATIONS),
    summary: str(o.summary, 1000),
    detail,
    ref: mutationRef(o.ref),
  };
}

const checkRun = (v: unknown): CheckRun => {
  const o = obj(v);
  return {
    name: str(o.name, 200),
    status: oneOf(o.status, ["passed", "failed", "timeout"] as const),
    ...def(
      "exitCode",
      attempt(() =>
        typeof o.exitCode === "number" ? Math.trunc(o.exitCode) : undefined
      )
    ),
    ...def(
      "seconds",
      attempt(() =>
        typeof o.seconds === "number" && o.seconds >= 0 ? o.seconds : undefined
      )
    ),
    ...def(
      "sha",
      attempt(() => optStr(o.sha, 64))
    ),
  };
};

const checkOutput = (v: unknown): CheckOutput => {
  const o = obj(v);
  return { name: str(o.name, 200), output: str(o.output, 200_000) };
};

const commit = (v: unknown): Commit => {
  const o = obj(v);
  return {
    sha: str(o.sha, 64),
    subject: str(o.subject, 500),
    author: str(o.author, 200),
  };
};

const range = (v: unknown): CommitRange => {
  const o = obj(v);
  return {
    base: str(o.base, 200),
    head: str(o.head, 200),
    baseSha: str(o.baseSha, 64),
    headSha: str(o.headSha, 64),
    count: int(o.count),
    filesChanged: int(o.filesChanged),
    commits: some(o.commits, 50, commit),
  };
};

function review(v: unknown): Review {
  if (v === undefined) {
    return {};
  }
  const o = obj(v);
  return {
    ...def(
      "versionFile",
      attempt(() => {
        const f = obj(o.versionFile);
        return { from: str(f.from, 50), to: str(f.to, 50) };
      })
    ),
    ...def(
      "ships",
      attempt(() => range(o.ships))
    ),
    ...def(
      "sinceVersion",
      attempt(() => range(o.sinceVersion))
    ),
    ...def(
      "reverts",
      attempt(() => {
        const r = obj(o.reverts);
        return {
          sha: str(r.sha, 64),
          subject: str(r.subject, 500),
          files: some(r.files, 50, (f) => str(f, 300)),
        };
      })
    ),
  };
}

function plan(v: unknown): Plan {
  const o = obj(v);
  return {
    action: str(o.action, 100),
    targetBranch: str(o.targetBranch, 200),
    targetBranchHead: str(o.targetBranchHead, 64),
    ...def("currentVersion", optStr(o.currentVersion, 50)),
    ...def("resultingVersion", optStr(o.resultingVersion, 50)),
    ...def(
      "shape",
      o.shape === undefined
        ? undefined
        : oneOf(o.shape, ["revert", "abandon"] as const)
    ),
    mutations: arr(o.mutations, 40, mutation),
    warnings: arr(o.warnings, 30, coded),
    notices: arr(o.notices, 30, coded),
    ...def(
      "mergePreview",
      attempt(() =>
        o.mergePreview === undefined ? undefined : coded(o.mergePreview)
      )
    ),
    ...def(
      "pipelineTrigger",
      attempt(() =>
        o.pipelineTrigger === undefined ? undefined : coded(o.pipelineTrigger)
      )
    ),
    checks: some(o.checks, 20, checkRun),
    checkOutput: some(o.checkOutput, 20, checkOutput),
    review: attempt(() => review(o.review)) ?? {},
    digest: str(o.digest, 64),
  };
}

export function digestOf(plan: Plan): string {
  const lines = [
    `action:${plan.action}`,
    `branch:${plan.targetBranch}`,
    `head:${plan.targetBranchHead}`,
    ...(plan.currentVersion === undefined
      ? []
      : [`from:${plan.currentVersion}`]),
    ...(plan.resultingVersion === undefined
      ? []
      : [`to:${plan.resultingVersion}`]),
    ...plan.mutations.map(
      (m) => `mutation:${m.operation}:${m.kind}:${m.summary}`
    ),
    ...plan.warnings.map((w) => `warning:${w.text}`),
    ...plan.notices.map((n) => `notice:${n.text}`),
  ];
  return createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 6);
}

const ROUTE_SOURCES = ["main", "release", "hotfix"] as const;
const ROUTE_TARGETS = ["develop", "main"] as const;

function handoff(v: unknown): Handoff {
  const o = obj(v);
  const increment = attempt(() => {
    if (o.increment === undefined) return undefined;
    const i = obj(o.increment);
    const open = optInt(i.openPullRequest);
    return { version: str(i.version, 50), ...def("openPullRequest", open) };
  });
  return {
    code: oneOf(o.code, ["H1", "H2"] as const),
    text: str(o.text, LONG),
    source: oneOf(o.source, ROUTE_SOURCES),
    target: oneOf(o.target, ROUTE_TARGETS),
    sourceBranch: str(o.sourceBranch, 200),
    ...def("version", optStr(o.version, 50)),
    conflictedFiles: arr(o.conflictedFiles, 500, (f) => str(f, 500)),
    resolutionBranch: str(o.resolutionBranch, 200),
    title: str(o.title, 300),
    steps: arr(o.steps, 20, (s) => str(s, 4000)),
    options: arr(o.options ?? [], 5, (x) => {
      const d = obj(x);
      return {
        label: str(d.label, 300),
        text: str(d.text, 4000),
        recommended: bool(d.recommended),
      };
    }),
    ...def("increment", increment),
  };
}

const PULL_CHANGES = [
  "opened",
  "updated",
  "closed",
  "superseded",
  "alreadyOpen",
] as const;

const appliedPull = (v: unknown): AppliedPull => {
  const o = obj(v);
  return {
    ...def("number", optInt(o.number)),
    ...def(
      "url",
      attempt(() => optStr(o.url, 500))
    ),
    head: str(o.head, 200),
    base: str(o.base, 200),
    ...def(
      "title",
      attempt(() => optStr(o.title, 300))
    ),
    change: oneOf(o.change, PULL_CHANGES),
    ...def("draft", o.draft === undefined ? undefined : bool(o.draft)),
  };
};

const step = (v: unknown): Step => {
  const o = obj(v);
  return {
    name: str(o.name, 200),
    status: str(o.status, 20),
    ...def(
      "error",
      attempt(() => optStr(o.error, 2000))
    ),
  };
};

function applied(v: unknown): Applied {
  const o = obj(v);
  return {
    dryRun: o.dryRun === true,
    ...def(
      "branch",
      o.branch === undefined
        ? undefined
        : (() => {
            const b = obj(o.branch);
            return {
              name: str(b.name, 200),
              change: str(b.change, 20),
              ...def("base", optStr(b.base, 200)),
            };
          })()
    ),
    ...def("from", optStr(o.from, 50)),
    ...def("to", optStr(o.to, 50)),
    ...def(
      "shape",
      o.shape === undefined
        ? undefined
        : oneOf(o.shape, ["revert", "abandon"] as const)
    ),
    ...def("resumed", o.resumed === undefined ? undefined : bool(o.resumed)),
    ...def(
      "tag",
      o.tag === undefined
        ? undefined
        : (() => {
            const t = obj(o.tag);
            return { name: str(t.name, 50), change: str(t.change, 20) };
          })()
    ),
    ...def(
      "githubRelease",
      o.githubRelease === undefined
        ? undefined
        : (() => {
            const r = obj(o.githubRelease);
            return {
              tag: str(r.tag, 50),
              change: oneOf(r.change, ["created", "deleted"] as const),
            };
          })()
    ),
    ...def(
      "route",
      o.route === undefined
        ? undefined
        : (() => {
            const r = obj(o.route);
            return {
              source: oneOf(r.source, ROUTE_SOURCES),
              target: oneOf(r.target, ROUTE_TARGETS),
            };
          })()
    ),
    ...def("mergeBranch", optStr(o.mergeBranch, 200)),
    pullRequests: arr(o.pullRequests, 10, appliedPull),
    ...def(
      "pipeline",
      o.pipeline === undefined
        ? undefined
        : (() => {
            const p = obj(o.pipeline);
            return {
              status: oneOf(p.status, [
                "started",
                "skipped",
                "failed",
              ] as const),
              ...def(
                "code",
                attempt(() => optStr(p.code, 8))
              ),
              message: str(p.message, 4000),
              ...def(
                "output",
                attempt(() => optStr(p.output, LONG))
              ),
            };
          })()
    ),
    ...def(
      "manualDownmerge",
      o.manualDownmerge === undefined ? undefined : handoff(o.manualDownmerge)
    ),
    warnings: some(o.warnings, 30, coded),
    notices: some(o.notices, 30, coded),
    problems: arr(o.problems ?? [], 20, coded),
    steps: some(o.steps, 30, step),
    nextSteps: some(o.nextSteps, 20, (s) => str(s, 1000)),
  };
}

const versionRow = (v: unknown): VersionRow => {
  const o = obj(v);
  return {
    branch: str(o.branch, 200),
    type: oneOf(o.type, ["release", "hotfix"] as const),
    version: o.version === null ? null : str(o.version, 50),
    kind: oneOf(o.kind, ["rc", "final", "unknown"] as const),
    tag: oneOf(o.tag, ["remote", "local-only", "none"] as const),
    mergedIntoProduction: bool(o.mergedIntoProduction),
  };
};

const TOOLS = [
  "create_release_candidate",
  "create_hotfix",
  "increment_release_candidate",
  "release_version",
  "revert_version",
  "downmerge",
  "list_versions",
  "health_check",
  "initialize_versioner",
] as const;

/** Read an MCP tool's structuredContent, or undefined when it is not one. */
export function readOutput(v: unknown): Output | undefined {
  return attempt(() => {
    const o = obj(v);
    const tool = oneOf(o.tool, TOOLS);
    switch (o.kind) {
      case "plan":
        return { kind: "plan", tool, plan: plan(o.plan) };
      case "stale":
        return {
          kind: "stale",
          tool,
          text: str(o.text, 2000),
          provided: str(o.provided, 64),
          plan: plan(o.plan),
        };
      case "applied":
        return { kind: "applied", tool, result: applied(o.result) };
      case "handoff":
        return { kind: "handoff", tool, handoff: handoff(o.handoff) };
      case "refused":
      case "failed": {
        const code = attempt(() => optStr(o.code, 8));
        const text = str(o.text, LONG);
        return o.kind === "refused"
          ? { kind: "refused", tool, ...def("code", code), text }
          : {
              kind: "failed",
              tool,
              ...def("code", code),
              text,
              steps: some(o.steps, 30, step),
            };
      }
      case "versions":
        return {
          kind: "versions",
          tool,
          entries: arr(o.entries, 200, versionRow),
        };
      default:
        throw new Invalid();
    }
  });
}

export interface Resolution {
  pullRequest: number;
  draft: boolean;
  branch: string;
  resolvedFiles: { path: string; reason: string }[];
  unresolvedFiles: { path: string; reason: string }[];
  closedPullRequests: number[];
}

/**
 * What the agent reports after carrying out an H1 handoff. The branch must
 * be the handoff's own pattern with the timestamp filled in.
 */
export function readResolution(
  v: unknown,
  handoff: Handoff
): Resolution | undefined {
  return attempt(() => {
    const o = obj(v);
    const pattern = new RegExp(
      `^${handoff.resolutionBranch
        .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
        .replace("<unix-timestamp>", "\\d{9,11}")}$`
    );
    const branch = str(o.branch, 200);
    if (!pattern.test(branch)) {
      throw new Invalid();
    }
    const file = (x: unknown) => {
      const f = obj(x);
      return { path: str(f.path, 300), reason: str(f.reason, 300) };
    };
    const pullRequest = int(o.pullRequest);
    if (pullRequest === 0) {
      throw new Invalid();
    }
    return {
      pullRequest,
      draft: o.draft === true,
      branch,
      resolvedFiles: arr(o.resolvedFiles ?? [], 100, file),
      unresolvedFiles: arr(o.unresolvedFiles ?? [], 100, file),
      closedPullRequests: some(o.closedPullRequests, 5, (n) => {
        const value = int(n);
        if (value === 0) throw new Invalid();
        return value;
      }),
    };
  });
}
