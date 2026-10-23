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
  /**
   * True into main: the drift between main and the source is a decision for a
   * human, so the steps are options to choose from, not instructions to carry out.
   */
  requiresDecision: boolean;
  /** The branch being merged, e.g. `release/4.125.0` or `main`. */
  sourceBranch: string;
  /** The version a release or hotfix branch carries; absent for main. */
  version?: string;
  conflictedFiles: string[];
  /**
   * The branch to resolve the conflicts on, named by its pattern because it
   * carries a timestamp, and the branch its pull request goes into. Into main
   * these describe the second option, the one that accepts drift.
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
        (handoff.requiresDecision
          ? `a human has to choose how to proceed, see ${MANUAL_DOWNMERGE_DOC}.`
          : `follow ${MANUAL_DOWNMERGE_DOC} to downmerge by hand.`)
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
 * shape the tools use for a clean merge.
 *
 * Into main nothing is resolved. main mirrors production, so a conflict means
 * main holds changes the source never received, usually a hotfix that was not
 * downmerged into the release. Merging main into the source would deploy it to
 * the release servers without a new release candidate, so a human chooses
 * between taking main's changes through a new candidate and accepting drift.
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
    const resolutionBranch = `${slug(sourceBranch)}-into-main-<unix-timestamp>`;
    const takeMain =
      route.source === "release"
        ? `Run create_release_candidate with releaseType patch, merge origin/main ` +
          `into the new release branch, promote it with release_version, have Ops ` +
          `deploy it to every production host, then downmerge that release into ` +
          `main, which is clean by then.`
        : `Run create_hotfix, which cuts a new hotfix off main and so already holds ` +
          `main's changes, bring the fix from ${sourceBranch} over, promote it with ` +
          `release_version, have Ops deploy it to every production host, then ` +
          `downmerge that hotfix into main, which is clean by then.`;
    return {
      route,
      requiresDecision: true,
      sourceBranch,
      ...(version === undefined ? {} : { version }),
      conflictedFiles,
      resolutionBranch,
      resolutionBase: "main",
      pullRequestTitle: opts.pullRequestTitle,
      steps: [
        `Option 1, take main's changes into a new candidate (usually right): ${takeMain}`,
        `Option 2, leave them out of ${sourceBranch}: cut ${resolutionBranch} off ` +
          `origin/main, merge origin/${sourceBranch} into it, resolve ${files}, and ` +
          `open a pull request into main titled "${opts.pullRequestTitle}". Say in ` +
          `it that main will then differ from what production runs.`,
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
    requiresDecision: false,
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
  const target = handoff.route.target;
  return [
    handoff.requiresDecision
      ? `Decision needed: ${handoff.sourceBranch} → ${target} conflicts`
      : `Manual downmerge needed: ${handoff.sourceBranch} → ${target}`,
    "",
    "The merge conflicts, so nothing was created. Conflicted files:",
    ...handoff.conflictedFiles.map((f) => `  - ${f}`),
    "",
    ...(handoff.requiresDecision
      ? [
          `${target} mirrors production and holds changes ${handoff.sourceBranch} ` +
            `never received. Do not resolve this or merge ${target} into ` +
            `${handoff.sourceBranch}: that would deploy it to the release servers ` +
            `without a new release candidate. A human chooses one option:`,
        ]
      : ["Steps:"]),
    ...handoff.steps.map((step, i) => `  ${i + 1}. ${step}`),
    "",
    `The full procedure is ${MANUAL_DOWNMERGE_DOC} in the versioner repository ` +
      `(${MANUAL_DOWNMERGE_URL}).`,
  ].join("\n");
}
