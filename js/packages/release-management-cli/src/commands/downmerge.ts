import { Command } from "commander";
import {
  DOWNMERGE_ROUTES,
  type DownmergeResult,
  type DownmergeRoute,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

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
      "Downmerge workflows. A conflicting merge creates nothing and prints the " +
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
    .option("--plan", "Describe the change and exit; touches nothing (the default when no apply flag is given)")
    .option("--confirm <digest>", "Apply the plan carrying this digest, as printed by --plan")
    .option("--yes", "Apply without a digest, printing the plan for the record (for automation)");
  if (route.source !== "main") {
    command.option(
      "--version <version>",
      `Specific ${route.source} version; auto-detect newest if omitted`
    );
  }

  command.action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runPlanAwareCommand({
      commandName: `downmerge ${name}`,
      opts,
      flags: cmdOpts,
      requiresVersioner: false,
      buildPlan: (agent) => agent.planDownmerge(route, cmdOpts.version),
      execute: (_agent, gfm) => gfm.downmerge(route, cmdOpts.version),
      onExecuted: (result) => {
        writeDownmergeOutputs(result);
        emit(result, opts, renderDownmerge);
      },
    });
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

function renderDownmerge(r: DownmergeResult): string {
  switch (r.kind) {
    case "direct":
      return `Pull Request: ${r.pullRequestUrl}`;
    case "merge-branch":
      return [
        `Merge branch: ${r.mergeBranchName}`,
        `Pull Request: ${r.pullRequestUrl}`,
      ].join("\n");
  }
}
