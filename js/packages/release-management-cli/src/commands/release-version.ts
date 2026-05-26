import { Command } from "commander";
import {
  ensureGitRepository,
  ensureNoStagedChanges,
  ensureVersionerAvailable,
  type ReleaseVersionWorkflowContext,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  createReleaseAgent,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

export function registerReleaseVersion(parent: Command): void {
  parent
    .command("release-version")
    .description("Convert an RC into a final version (release-version)")
    .option("--version <version>", "Specific version (e.g. 1.2.0); auto-detect newest if omitted")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          const agent = await createReleaseAgent(gfm, opts);
          ensureVersionerAvailable(agent);
          return agent.executeReleaseWorkflow(
            opts.workingDirectory,
            cmdOpts.version,
            opts.dryRun
          );
        },
        (result) => {
          writeGithubOutput({
            branch: result.branchInfo?.name,
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
            pull_request_action: result.pullRequestAction,
            pull_request_error: result.pullRequestError,
            release_url: result.releaseUrl,
            release_notes_warning: result.releaseNotesWarning,
          });
          emit(result, opts, renderReleaseVersion);
        }
      );
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
  return lines.join("\n");
}
