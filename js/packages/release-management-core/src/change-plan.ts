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

export interface PlannedMutation {
  kind: MutationKind;
  /** One line, in the imperative: "Create annotated tag 4.124.1-RC.2". */
  summary: string;
  detail?: Record<string, string>;
}

export interface ChangePlan {
  action: string;
  targetBranch: string;
  /** HEAD of the target branch when the plan was computed. */
  targetBranchHead: string;
  currentVersion: string;
  resultingVersion: string;
  mutations: PlannedMutation[];
  /** Conditions that do not block planning but change the outcome. */
  warnings: string[];
  digest: string;
}

export type ChangePlanInput = Omit<ChangePlan, "digest" | "warnings"> & {
  warnings?: string[];
};

const DIGEST_LENGTH = 12;

/**
 * Canonical serialisation the digest is taken over.
 *
 * Includes the target branch HEAD so a push to that branch invalidates the plan,
 * and the warnings because they encode remote facts the HEAD sha does not cover —
 * whether a tag already exists, whether a pull request will be updated rather
 * than created.
 */
function canonicalForm(plan: Omit<ChangePlan, "digest">): string {
  return [
    `action:${plan.action}`,
    `branch:${plan.targetBranch}`,
    `head:${plan.targetBranchHead}`,
    `from:${plan.currentVersion}`,
    `to:${plan.resultingVersion}`,
    ...plan.mutations.map((m) => `mutation:${m.kind}:${m.summary}`),
    ...plan.warnings.map((w) => `warning:${w}`),
  ].join("\n");
}

export function buildChangePlan(input: ChangePlanInput): ChangePlan {
  const withWarnings = { ...input, warnings: input.warnings ?? [] };
  const digest = createHash("sha256")
    .update(canonicalForm(withWarnings))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);

  return { ...withWarnings, digest };
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
  if (provided !== plan.digest) {
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
    `Version: ${plan.currentVersion} → ${plan.resultingVersion}`,
    "",
  ];

  if (plan.mutations.length === 0) {
    lines.push("Would change nothing.");
  } else {
    lines.push("Would create:");
    for (const mutation of plan.mutations) {
      lines.push(`  ${KIND_LABELS[mutation.kind]}: ${mutation.summary}`);
      for (const [key, value] of Object.entries(mutation.detail ?? {})) {
        lines.push(`      ${key}: ${value}`);
      }
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push(
    "",
    `Nothing has been changed. To apply, confirm with digest: ${plan.digest}`
  );

  return lines.join("\n");
}
