/**
 * Change plans: what an action would do, computed before it does anything.
 *
 * Every mutating workflow can describe its intended git objects without creating
 * any of them. A plan carries a digest of the repository state it was computed
 * against, so applying it later can detect that the repository moved and refuse
 * rather than acting on stale intent.
 */

import { createHash } from "node:crypto";

export type MutationKind =
  | "branch"
  | "commit"
  | "tag"
  | "push"
  | "pull-request"
  | "github-release";

export type MutationOperation = "create" | "update" | "close" | "delete";

export interface MutationRef {
  name?: string;
  sha?: string;
  url?: string;
  number?: number;
  head?: string;
  base?: string;
  title?: string;
  draft?: boolean;
}

export interface PlannedMutation {
  kind: MutationKind;
  operation?: MutationOperation;
  /** One line, in the imperative: "Create annotated tag 4.124.1-RC.2". */
  summary: string;
  detail?: Record<string, string>;
  ref?: MutationRef;
}

export function mutationOperation(
  mutation: PlannedMutation
): MutationOperation {
  return mutation.operation ?? "create";
}

export interface ChangePlan {
  action: string;
  targetBranch: string;
  /** HEAD of the target branch when the plan was computed. */
  targetBranchHead: string;
  /**
   * The version transition, set together or not at all. An action that creates no
   * version commit — a downmerge — leaves both unset rather than claiming a
   * transition it does not make.
   */
  currentVersion?: string;
  resultingVersion?: string;
  mutations: PlannedMutation[];
  /** Conditions that do not block planning but change the outcome. */
  warnings: string[];
  /**
   * Facts about the repository that shape the plan without putting the outcome at
   * risk, such as a pull request being updated rather than opened. Nothing to act
   * on before approving.
   */
  notices: string[];
  /**
   * What a failing pre-version check printed, for the approver to read. Left out of
   * the digest: output carries timings and download progress that differ between
   * two runs of the same check, and the warning naming the failure is covered.
   */
  checkOutput?: CheckOutput[];
  /**
   * Set when the apply is expected to start the repository's pipeline, because the
   * branch will have no open pull request after the push. Left out of the digest:
   * it depends on pull requests to any base, which open and close without the
   * repository moving, and the apply checks again after the push regardless.
   */
  pipelineTrigger?: string;
  mergePreview?: string;
  shape?: "revert" | "abandon";
  checks?: CheckRun[];
  review?: PlanReview;
  digest: string;
}

export interface CheckOutput {
  name: string;
  output: string;
}

export interface CheckRun {
  name: string;
  status: "passed" | "failed" | "timeout";
  exitCode: number;
  seconds: number;
  ref: string;
  sha: string;
  output?: string;
}

export interface ReviewCommit {
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
  commits: ReviewCommit[];
  compareUrl?: string;
}

export interface PlanReview {
  repoUrl?: string;
  versionFile?: { path: "VERSION"; from: string; to: string };
  ships?: CommitRange;
  sinceVersion?: CommitRange;
  reverts?: {
    sha: string;
    subject: string;
    files: string[];
    url?: string;
  };
}

export const REVIEW_COMMIT_LIMIT = 50;

export type ChangePlanInput = Omit<
  ChangePlan,
  "digest" | "warnings" | "notices"
> & {
  warnings?: string[];
  notices?: string[];
};

export const DIGEST_LENGTH = 6;

/**
 * Canonical serialisation the digest is taken over.
 *
 * Includes the target branch HEAD so a push to that branch invalidates the plan,
 * and the warnings and notices because they encode remote facts the HEAD sha
 * does not cover — whether a tag already exists, whether a pull request will be
 * updated rather than created.
 */
function canonicalForm(plan: Omit<ChangePlan, "digest">): string {
  return [
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
      (m) => `mutation:${mutationOperation(m)}:${m.kind}:${m.summary}`
    ),
    ...plan.warnings.map((w) => `warning:${w}`),
    ...plan.notices.map((n) => `notice:${n}`),
  ].join("\n");
}

export function buildChangePlan(input: ChangePlanInput): ChangePlan {
  const complete = {
    ...input,
    warnings: input.warnings ?? [],
    notices: input.notices ?? [],
  };
  const digest = createHash("sha256")
    .update(canonicalForm(complete))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);

  return { ...complete, digest };
}

/**
 * Raised when an apply is attempted with a digest that no longer matches the
 * repository. Carries the freshly computed plan so the caller can show what
 * changed and confirm again.
 */
export class StalePlanError extends Error {
  readonly plan: ChangePlan;
  readonly provided: string;

  constructor(plan: ChangePlan, provided: string) {
    super(
      `The repository changed since this plan was created. ` +
        `Expected digest ${plan.digest}, got ${provided}. ` +
        `Review the new plan and confirm again.`
    );
    this.name = "StalePlanError";
    this.plan = plan;
    this.provided = provided;
  }
}

/** Throw unless `provided` matches the freshly computed plan's digest. */
export function assertPlanIsCurrent(plan: ChangePlan, provided: string): void {
  if (provided.trim().toLowerCase() !== plan.digest) {
    throw new StalePlanError(plan, provided);
  }
}

const KIND_LABELS: Record<MutationKind, string> = {
  branch: "Branch",
  commit: "Commit",
  tag: "Tag",
  push: "Push",
  "pull-request": "Pull request",
  "github-release": "GitHub release",
};

export function renderChangePlan(plan: ChangePlan): string {
  const lines = [
    `Action:  ${plan.action}`,
    `Branch:  ${plan.targetBranch} (at ${plan.targetBranchHead.slice(0, 11)})`,
  ];

  if (plan.currentVersion !== undefined && plan.resultingVersion !== undefined) {
    lines.push(`Version: ${plan.currentVersion} → ${plan.resultingVersion}`);
  }

  lines.push("");

  if (plan.mutations.length === 0) {
    lines.push("Would change nothing.");
  } else {
    const headings: Array<[MutationOperation[], string]> = [
      [["create", "update"], "Would create:"],
      [["delete", "close"], "Would delete:"],
    ];
    let first = true;
    for (const [operations, heading] of headings) {
      const group = plan.mutations.filter((m) =>
        operations.includes(mutationOperation(m))
      );
      if (group.length === 0) {
        continue;
      }
      if (!first) {
        lines.push("");
      }
      first = false;
      lines.push(heading);
      for (const mutation of group) {
        lines.push(`  ${KIND_LABELS[mutation.kind]}: ${mutation.summary}`);
        for (const [key, value] of Object.entries(mutation.detail ?? {})) {
          lines.push(`      ${key}: ${value}`);
        }
      }
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  const notes = [
    ...plan.notices,
    ...(plan.mergePreview === undefined ? [] : [plan.mergePreview]),
  ];
  if (notes.length > 0) {
    lines.push("", "Notes:");
    for (const notice of notes) {
      lines.push(`  - ${notice}`);
    }
  }

  if (plan.pipelineTrigger !== undefined) {
    lines.push("", "Pipeline:", `  - ${plan.pipelineTrigger}`);
  }

  for (const check of plan.checkOutput ?? []) {
    lines.push("", `Output of ${check.name}:`);
    for (const line of check.output.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  lines.push(
    "",
    `Nothing has been changed. To apply, confirm with digest: ${plan.digest}`
  );

  return lines.join("\n");
}
