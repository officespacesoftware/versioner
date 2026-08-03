import { Command } from "commander";
import type { ReleaseVersionWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerReleaseVersion(parent: Command): void {
  parent
    .command("release-version")
    .description("Convert an RC into a final version (release-version)")
    .option("--version <version>", "Specific version (e.g. 1.2.0); auto-detect newest if omitted")
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
        commandName: "release-version",
        opts,
        flags: cmdOpts,
        buildPlan: (agent) => agent.planReleaseVersion(cmdOpts.version),
        execute: (agent) =>
          agent.executeReleaseWorkflow(
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
            release_url: result.releaseUrl,
            release_notes_warning: result.releaseNotesWarning,
            own_base_pull_request_url: result.ownBasePullRequestUrl,
            own_base_pull_request_action: result.ownBasePullRequestAction,
            own_base_pull_request_error: result.ownBasePullRequestError,
          });
          emit(result, opts, renderReleaseVersion);
        },
      });
    });
}

function renderReleaseVersion(r: ReleaseVersionWorkflowContext): string {
  const lines = [
    `Branch type:  ${r.branchType}`,
    `Branch:       ${r.branchInfo?.name ?? "—"}`,
    `Final version: ${r.targetVersion?.version ?? "—"}`,
  ];
  if (r.pullRequestUrl) {
    const verb = r.pullRequestAction === "updated" ? "Updated PR" : "Pull Request";
    lines.push(`${verb}: ${r.pullRequestUrl}`);
  }
  if (r.pullRequestError) {
    lines.push(`PR step failed: ${r.pullRequestError}`);
  }
  if (r.releaseUrl) {
    lines.push(`GitHub Release: ${r.releaseUrl}`);
  }
  if (r.releaseNotesWarning) {
    lines.push(`Release notes warning: ${r.releaseNotesWarning}`);
  }
  if (r.ownBasePullRequestUrl) {
    const verb = r.ownBasePullRequestAction === "updated" ? "Updated" : "Opened";
    lines.push(
      `${verb} ${r.branchInfo?.targetBranch ?? "own-base"} PR: ${r.ownBasePullRequestUrl}`
    );
  }
  if (r.ownBasePullRequestError) {
    lines.push(
      `${r.branchInfo?.targetBranch ?? "Own-base"} PR refresh failed: ${r.ownBasePullRequestError}`
    );
  }
  return lines.join("\n");
}
