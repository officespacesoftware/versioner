import { Command } from "commander";
import type { HotfixWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, renderPipelineTrigger, writeGithubOutput } from "../output.js";
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
            pull_request_action: result.pullRequestAction,
            pull_request_error: result.pullRequestError,
            tracking_pull_request_url: result.trackingPullRequestUrl,
            tracking_pull_request_action: result.trackingPullRequestAction,
            tracking_pull_request_error: result.trackingPullRequestError,
            resumed: String(result.resumed === true),
            pipeline_trigger: result.pipelineTrigger?.status,
          });
          emit(result, opts, renderHotfix);
        },
      });
    });
}

export function renderHotfix(r: HotfixWorkflowContext): string {
  const lines = [`Version: ${r.targetVersion?.version ?? "—"}`];
  if (r.resumed) {
    lines.push(
      `Resumed: ${r.currentBranch} was already on origin at ${r.targetVersion?.version}`
    );
  }
  if (r.pullRequestUrl) {
    const verb = r.pullRequestAction === "updated" ? "Updated PR" : "Pull Request";
    lines.push(`${verb}: ${r.pullRequestUrl}`);
  }
  if (r.pullRequestError) {
    lines.push(
      `PR step failed: ${r.pullRequestError}`,
      `  To recover, run create-hotfix again: it resumes from the push and opens ` +
        `the pull request. Or open ${r.currentBranch} → main by hand, titled ` +
        `"RC ${r.targetVersion?.version} to main", with the production warning.`
    );
  }
  if (r.trackingPullRequestUrl) {
    const verb =
      r.trackingPullRequestAction === "updated" ? "Updated draft PR" : "Draft PR";
    lines.push(`${verb} to develop: ${r.trackingPullRequestUrl}`);
  }
  if (r.trackingPullRequestError) {
    lines.push(
      `Could not open the develop PR: ${r.trackingPullRequestError}`,
      `  Open it by hand as a draft, or rely on the hotfix-to-develop downmerge after the deploy.`
    );
  }
  lines.push(...renderPipelineTrigger(r.pipelineTrigger));
  return lines.join("\n");
}
