import { Command } from "commander";
import {
  renderManualDownmerge,
  type IncrementRCWorkflowContext,
} from "@officespacesoftware/release-management-core";
import { emit, renderPipelineTrigger, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerIncrementRC(parent: Command): void {
  parent
    .command("increment-rc")
    .description("Increment the RC suffix on the active release or hotfix branch")
    .option("--version <version>", "Target version (e.g. 1.2.0, or release/1.2.0 / hotfix/1.2.0); auto-detect newest if omitted")
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
          writeGithubOutput(incrementRCOutputs(result));
          emit(result, opts, renderIncrementRC);
        },
      });
    });
}

export function incrementRCOutputs(
  result: IncrementRCWorkflowContext
): Record<string, string | undefined> {
  return {
    branch: result.branchInfo?.name,
    version: result.targetVersion?.version,
    pull_request_url: result.pullRequestUrl,
    pull_request_action: result.pullRequestAction,
    pull_request_error: result.pullRequestError,
    manual_downmerge: result.manualDownmerge
      ? renderManualDownmerge(result.manualDownmerge)
      : undefined,
    pipeline_trigger: result.pipelineTrigger?.status,
  };
}

export function renderIncrementRC(r: IncrementRCWorkflowContext): string {
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
  if (r.manualDownmerge) {
    lines.push("", renderManualDownmerge(r.manualDownmerge));
  }
  const pipeline = renderPipelineTrigger(r.pipelineTrigger);
  if (r.manualDownmerge && pipeline.length > 0) {
    lines.push("");
  }
  lines.push(...pipeline);
  return lines.join("\n");
}
