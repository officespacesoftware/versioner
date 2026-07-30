import { Command } from "commander";
import type { HotfixWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerCreateHotfix(parent: Command): void {
  parent
    .command("create-hotfix")
    .description("Create a new hotfix branch (hotfix/X.Y.Z) at RC.0")
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
        commandName: "create-hotfix",
        opts,
        flags: cmdOpts,
        buildPlan: (agent) => agent.planCreateHotfix(),
        execute: (agent) =>
          agent.executeHotfixWorkflow(opts.workingDirectory, opts.dryRun),
        onExecuted: (result) => {
          writeGithubOutput({
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
          });
          emit(result, opts, renderHotfix);
        },
      });
    });
}

function renderHotfix(r: HotfixWorkflowContext): string {
  const lines = [`Version: ${r.targetVersion?.version ?? "—"}`];
  if (r.pullRequestUrl) lines.push(`Pull Request: ${r.pullRequestUrl}`);
  return lines.join("\n");
}
