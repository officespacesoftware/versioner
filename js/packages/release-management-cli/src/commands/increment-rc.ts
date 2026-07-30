import { Command } from "commander";
import type { IncrementRCWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerIncrementRC(parent: Command): void {
  parent
    .command("increment-rc")
    .description("Increment the RC suffix on the active release or hotfix branch")
    .option("--version <version>", "Target version (e.g. 1.2.0); auto-detect newest if omitted")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--plan", "Describe the change and exit; touches nothing (the default when no apply flag is given)")
    .option("--confirm <digest>", "Apply the plan carrying this digest, as printed by --plan")
    .option("--yes", "Apply without a digest, printing the plan for the record (for automation)")
    .option(
      "--dry-run",
      "Validate without making changes; prefer --plan, which is guaranteed not to mutate"
    )
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runPlanAwareCommand({
        commandName: "increment-rc",
        opts,
        flags: cmdOpts,
        buildPlan: (agent) => agent.planIncrementRC(cmdOpts.version),
        execute: (agent) =>
          agent.executeIncrementRCWorkflow(
            opts.workingDirectory,
            cmdOpts.version,
            opts.dryRun
          ),
        onExecuted: (result) => {
          writeGithubOutput({
            branch: result.branchInfo?.name,
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
            pull_request_action: result.pullRequestAction,
            pull_request_error: result.pullRequestError,
          });
          emit(result, opts, renderIncrementRC);
        },
      });
    });
}

function renderIncrementRC(r: IncrementRCWorkflowContext): string {
  const lines = [
    `Branch type: ${r.branchType}`,
    `Branch:      ${r.branchInfo?.name ?? "—"}`,
    `New version: ${r.targetVersion?.version ?? "—"}`,
  ];
  if (r.pullRequestUrl) {
    const verb = r.pullRequestAction === "updated" ? "Updated PR" : "Pull Request";
    lines.push(`${verb}: ${r.pullRequestUrl}`);
  }
  if (r.pullRequestError) {
    lines.push(`PR step failed: ${r.pullRequestError}`);
  }
  return lines.join("\n");
}
