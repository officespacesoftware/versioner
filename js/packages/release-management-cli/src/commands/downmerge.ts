import { Command, Option } from "commander";
import {
  DOWNMERGE_ROUTES,
  ensureGitRepository,
  ensureNoStagedChanges,
  ManualDownmergeRequired,
  renderManualDownmerge,
  type DownmergeResult,
  type DownmergeRoute,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  createReleaseAgent,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

type DownmergeOutcome = DownmergeResult & {
  warnings: string[];
  notices: string[];
};

const DESCRIPTIONS: Record<string, string> = {
  "main-to-develop": "PR main → develop via a merge branch",
  "release-to-develop": "PR release → develop, straight from the release branch",
  "release-to-main": "PR release → main via merge branch (never head=release/*)",
  "hotfix-to-develop": "PR hotfix → develop via merge branch (never head=hotfix/*)",
  "hotfix-to-main": "PR hotfix → main",
};

export function registerDownmerge(parent: Command): void {
  const dm = parent
    .command("downmerge")
    .description(
      "Downmerge workflows. Each applies immediately: the pull request it opens " +
        "is the review. A conflicting merge creates nothing and prints the " +
        "steps to finish it by hand."
    );

  for (const route of DOWNMERGE_ROUTES) {
    registerRoute(parent, dm, route);
  }
}

function registerRoute(
  parent: Command,
  dm: Command,
  route: DownmergeRoute
): void {
  const name = `${route.source}-to-${route.target}`;
  const command = dm
    .command(name)
    .description(DESCRIPTIONS[name] ?? name)
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .addOption(new Option("--confirm <digest>").hideHelp())
    .addOption(new Option("--yes").hideHelp());
  if (route.source !== "main") {
    command.option(
      "--version <version>",
      `Specific ${route.source} version; auto-detect newest if omitted`
    );
  }

  // --confirm and --yes are accepted and ignored so scripts written for the
  // plan/confirm protocol keep working. --plan is gone rather than ignored:
  // ignoring it would apply what the caller asked only to see.
  command.action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runCommand<DownmergeOutcome>(
      async () => {
        const gfm = createGitFlowManager(opts);
        await ensureGitRepository(gfm, opts.workingDirectory);
        await ensureNoStagedChanges(gfm);
        const agent = await createReleaseAgent(gfm, opts, { initialize: false });
        const { result, warnings, notices } = await agent.applyDownmerge(
          route,
          cmdOpts.version
        );
        return { ...result, warnings, notices };
      },
      (outcome) => {
        writeDownmergeOutputs(outcome);
        emit(outcome, opts, renderDownmerge);
      },
      (error) =>
        error instanceof ManualDownmergeRequired
          ? renderManualDownmerge(error.handoff)
          : undefined
    );
  });
}

function writeDownmergeOutputs(result: DownmergeResult): void {
  switch (result.kind) {
    case "direct":
      writeGithubOutput({
        kind: result.kind,
        pull_request_url: result.pullRequestUrl,
      });
      return;
    case "merge-branch":
      writeGithubOutput({
        kind: result.kind,
        pull_request_url: result.pullRequestUrl,
        merge_branch: result.mergeBranchName,
      });
      return;
  }
}

function renderDownmerge(r: DownmergeOutcome): string {
  const lines =
    r.kind === "merge-branch"
      ? [`Merge branch: ${r.mergeBranchName}`, `Pull Request: ${r.pullRequestUrl}`]
      : [`Pull Request: ${r.pullRequestUrl}`];
  for (const [title, items] of [
    ["Warnings:", r.warnings],
    ["Notes:", r.notices],
  ] as const) {
    if (items.length > 0) {
      lines.push("", title, ...items.map((item) => `  - ${item}`));
    }
  }
  return lines.join("\n");
}
