import { Command } from "commander";
import type { RevertVersionWorkflowContext } from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

export function registerRevertVersion(parent: Command): void {
  parent
    .command("revert-version")
    .description(
      "Undo the most recent version bump on a release or hotfix branch, deleting its tag"
    )
    .option(
      "--version <version>",
      "Version identifying the branch (e.g. 1.2.0); defaults to the checked-out branch"
    )
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option(
      "--plan",
      "Describe the change and exit; touches nothing (the default when no apply flag is given)"
    )
    .option(
      "--confirm <digest>",
      "Apply the plan carrying this digest, as printed by --plan"
    )
    .option(
      "--yes",
      "Apply without a digest, printing the plan for the record (for automation)"
    )
    .option(
      "--dry-run",
      "Validate without making changes; prefer --plan, which is guaranteed not to mutate"
    )
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runPlanAwareCommand({
        commandName: "revert-version",
        opts,
        flags: cmdOpts,
        buildPlan: (agent) => agent.planRevertVersion(cmdOpts.version),
        execute: (agent) =>
          agent.executeRevertVersionWorkflow(
            opts.workingDirectory,
            cmdOpts.version,
            opts.dryRun
          ),
        onExecuted: (result) => {
          writeGithubOutput({
            branch: result.currentBranch,
            shape: result.shape,
            reverted_version: result.revertedVersion,
            resulting_version: result.resultingVersion,
            tag_deleted_remotely: String(result.tagDeletedRemotely),
            branch_deleted: String(result.branchDeleted ?? false),
            pull_request_url: result.pullRequestUrl,
            pull_request_action: result.pullRequestAction,
            pull_request_error: result.pullRequestError,
          });
          emit(result, opts, renderRevertVersion);
        },
      });
    });
}

function renderRevertVersion(r: RevertVersionWorkflowContext): string {
  const lines = [
    `Branch:   ${r.currentBranch}`,
    r.shape === "abandon"
      ? `Abandoned: ${r.revertedVersion} was the branch's first version`
      : `Version:  ${r.revertedVersion} -> ${r.resultingVersion}`,
    `Tag:      ${r.revertedVersion} ${
      r.tagDeletedRemotely ? "deleted on origin" : "not on origin"
    }, ${r.tagDeletedLocally ? "deleted locally" : "not local"}`,
  ];
  if (r.releaseDeletedUrl) {
    lines.push(
      "Release:  deleted; Latest now points at the previous release"
    );
  }
  if (r.branchDeleted) {
    lines.push("Branch:   deleted on origin and locally");
  }
  if (r.pullRequestUrl) {
    const verb = r.pullRequestAction === "closed" ? "Closed PR" : "Updated PR";
    lines.push(`${verb}: ${r.pullRequestUrl}`);
  }
  if (r.pullRequestError) {
    lines.push(`PR step failed: ${r.pullRequestError}`);
  }
  lines.push(
    "",
    "Deleting a tag does not undo a build or deployment it already triggered."
  );
  return lines.join("\n");
}
