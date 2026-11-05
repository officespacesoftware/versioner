import { Command } from "commander";
import type { ReleaseWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, renderPipelineTrigger, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerCreateRC(parent: Command): void {
  parent
    .command("create-rc")
    .description("Create a new release branch (release/X.Y.0) at RC.0")
    .option("--release-type <type>", "major | minor | patch (default: minor)", "minor")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--plan", "Describe the change and exit; touches nothing (the default when no apply flag is given)")
    .option("--confirm <digest>", "Apply the plan carrying this digest, as printed by --plan")
    .option("--yes", "Apply without a digest, printing the plan for the record (for automation)")
    .option(
      "--dry-run",
      "Validate without making changes; prefer --plan, which is guaranteed not to mutate"
    )
    .action(async (cmdOpts) => {
      if (!["major", "minor", "patch"].includes(cmdOpts.releaseType)) {
        process.stderr.write(`Error: --release-type must be one of major, minor, patch\n`);
        process.exit(1);
      }
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runPlanAwareCommand({
        commandName: "create-rc",
        opts,
        flags: cmdOpts,
        buildPlan: (agent) =>
          agent.planCreateReleaseCandidate(cmdOpts.releaseType),
        execute: (agent) =>
          agent.executeRCWorkflow(
            cmdOpts.releaseType,
            opts.workingDirectory,
            opts.dryRun
          ),
        onExecuted: (result) => {
          writeGithubOutput({
            release_type: result.releaseType,
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
            pull_request_action: result.pullRequestAction,
            pull_request_error: result.pullRequestError,
            resumed: String(result.resumed === true),
            pipeline_trigger: result.pipelineTrigger?.status,
          });
          emit(result, opts, renderCreateRC);
        },
      });
    });
}

function renderCreateRC(r: ReleaseWorkflowContext): string {
  const lines = [
    `Release type: ${r.releaseType}`,
    `Version:      ${r.targetVersion?.version ?? "—"}`,
  ];
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
      `  To recover, run create-rc again with the same --release-type: it resumes ` +
        `from the push and opens the pull request. Or open ${r.currentBranch} → ` +
        `develop by hand, titled "RC ${r.targetVersion?.version} to develop".`
    );
  }
  lines.push(...renderPipelineTrigger(r.pipelineTrigger));
  return lines.join("\n");
}
