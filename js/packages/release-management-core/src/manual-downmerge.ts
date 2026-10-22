/**
 * Downmerge routes, and the handoff a downmerge returns when the merge conflicts.
 *
 * A clean merge is mechanical and the tools do it. A conflicting one needs
 * judgement about which side of each hunk to keep, so the tools create nothing and
 * describe the manual downmerge instead, for an agent or a person to carry out.
 */

export type DownmergeSource = "main" | "release" | "hotfix";
export type DownmergeTarget = "develop" | "main";

export interface DownmergeRoute {
  source: DownmergeSource;
  target: DownmergeTarget;
}

export const DOWNMERGE_ROUTES: readonly DownmergeRoute[] = [
  { source: "main", target: "develop" },
  { source: "release", target: "develop" },
  { source: "release", target: "main" },
  { source: "hotfix", target: "develop" },
  { source: "hotfix", target: "main" },
];

/** Where the manual downmerge procedure is written down, in this repository. */
export const MANUAL_DOWNMERGE_DOC = "docs/manual-downmerge.md";

export const MANUAL_DOWNMERGE_URL =
  "https://github.com/officespacesoftware/versioner/blob/master/docs/manual-downmerge.md";

/**
 * Validate a source/target pair from an untrusted caller. Throws naming the
 * routes that exist, so a caller that guessed wrong can correct itself.
 */
export function parseDownmergeRoute(
  source: unknown,
  target: unknown
): DownmergeRoute {
  const route = DOWNMERGE_ROUTES.find(
    (r) => r.source === source && r.target === target
  );
  if (!route) {
    const valid = DOWNMERGE_ROUTES.map((r) => `${r.source} → ${r.target}`).join(
      ", "
    );
    throw new Error(
      `There is no downmerge from '${String(source)}' to '${String(target)}'. ` +
        `Valid routes: ${valid}.`
    );
  }
  return route;
}

/**
 * The title a clean downmerge gives its pull request, for a release or hotfix
 * source. Into main both read "Release", since either is what production ships.
 */
export function downmergePullRequestTitle(
  route: DownmergeRoute,
  version: string
): string {
  if (route.target === "main") {
    return `Release ${version} to main`;
  }
  const label = route.source === "hotfix" ? "Hotfix" : "Release";
  return `${label} ${version} to develop`;
}

export interface ManualDownmerge {
  route: DownmergeRoute;
  /** The branch being merged, e.g. `release/4.125.0` or `main`. */
  sourceBranch: string;
  /** The version a release or hotfix branch carries; absent for main. */
  version?: string;
  conflictedFiles: string[];
  /**
   * The branch to resolve the conflicts on, named by its pattern because it
   * carries a timestamp, and the branch its pull request goes into.
   */
  resolutionBranch: string;
  resolutionBase: string;
  pullRequestTitle: string;
  steps: string[];
}

export class ManualDownmergeRequired extends Error {
  readonly handoff: ManualDownmerge;

  constructor(handoff: ManualDownmerge) {
    super(
      `${handoff.sourceBranch} conflicts with ${handoff.route.target} in ` +
        `${handoff.conflictedFiles.length} file(s): ` +
        `${handoff.conflictedFiles.join(", ")}. Nothing was created; ` +
        `follow ${MANUAL_DOWNMERGE_DOC} to downmerge by hand.`
    );
    this.name = "ManualDownmergeRequired";
    this.handoff = handoff;
  }
}

function slug(sourceBranch: string): string {
  return sourceBranch.replace("/", "-");
}

/**
 * Describe the manual downmerge for a conflicting route.
 *
 * Into develop, the conflicts are resolved on a branch cut off develop, the same
 * shape the tools use for a clean merge. Into main they are not: main has to end
 * up holding what was deployed, so main is merged into the source branch instead,
 * and the downmerge is re-run once that lands and the merge is clean.
 */
export function describeManualDownmerge(opts: {
  route: DownmergeRoute;
  sourceBranch: string;
  version?: string;
  conflictedFiles: string[];
  /** The title the clean downmerge would have given its pull request. */
  pullRequestTitle: string;
}): ManualDownmerge {
  const { route, sourceBranch, version, conflictedFiles } = opts;
  const files = conflictedFiles.join(", ");

  if (route.target === "main") {
    const resolutionBranch = `main-into-${slug(sourceBranch)}-<unix-timestamp>`;
    return {
      route,
      sourceBranch,
      ...(version === undefined ? {} : { version }),
      conflictedFiles,
      resolutionBranch,
      resolutionBase: sourceBranch,
      pullRequestTitle: `Merge main into ${sourceBranch}`,
      steps: [
        `Cut ${resolutionBranch} off origin/${sourceBranch} and merge origin/main into it.`,
        `Resolve the conflicts in ${files}. Keep ${sourceBranch}'s VERSION.`,
        `Push ${resolutionBranch} and open a pull request into ${sourceBranch} ` +
          `titled "Merge main into ${sourceBranch}", listing each resolved file ` +
          `with a one-line reason.`,
        `Say in the pull request that ${sourceBranch} changes after it was ` +
          `tagged, so a human decides whether a new release candidate is needed ` +
          `before it reaches production.`,
        `Once it merges, run the ${route.source} → main downmerge again; it is ` +
          `clean now and opens "${opts.pullRequestTitle}".`,
      ],
    };
  }

  const resolutionBranch =
    route.source === "main"
      ? "main-into-develop-<unix-timestamp>"
      : `${slug(sourceBranch)}-into-develop-<unix-timestamp>`;
  const steps = [
    `Cut ${resolutionBranch} off origin/develop and merge origin/${sourceBranch} into it.`,
    `Resolve the conflicts in ${files}. Keep develop's VERSION.`,
    `Push ${resolutionBranch} and open a pull request into develop titled ` +
      `"${opts.pullRequestTitle}", listing each resolved file with a one-line reason.`,
  ];
  if (route.source === "hotfix") {
    steps.push(
      `Close the draft ${sourceBranch} → develop pull request, if one is open, ` +
        `with a comment linking the new one.`
    );
  }

  return {
    route,
    sourceBranch,
    ...(version === undefined ? {} : { version }),
    conflictedFiles,
    resolutionBranch,
    resolutionBase: "develop",
    pullRequestTitle: opts.pullRequestTitle,
    steps,
  };
}

export function renderManualDownmerge(handoff: ManualDownmerge): string {
  return [
    `Manual downmerge needed: ${handoff.sourceBranch} → ${handoff.route.target}`,
    "",
    "The merge conflicts, so nothing was created. Conflicted files:",
    ...handoff.conflictedFiles.map((f) => `  - ${f}`),
    "",
    "Steps:",
    ...handoff.steps.map((step, i) => `  ${i + 1}. ${step}`),
    "",
    `The full procedure is ${MANUAL_DOWNMERGE_DOC} in the versioner repository ` +
      `(${MANUAL_DOWNMERGE_URL}).`,
  ].join("\n");
}
