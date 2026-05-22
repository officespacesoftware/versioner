import { Command } from "commander";
import {
  ensureGitRepository,
  ensureNoStagedChanges,
  ensureVersionerAvailable,
  type ReleaseWorkflowContext,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  createReleaseAgent,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

export function registerCreateRC(parent: Command): void {
  parent
    .command("create-rc")
    .description("Create a new release branch (release/X.Y.0) at RC.0")
    .option("--release-type <type>", "major | minor | patch (default: minor)", "minor")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      if (!["major", "minor", "patch"].includes(cmdOpts.releaseType)) {
        process.stderr.write(`Error: --release-type must be one of major, minor, patch\n`);
        process.exit(1);
      }
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          const agent = await createReleaseAgent(gfm, opts);
          ensureVersionerAvailable(agent);
          return agent.executeRCWorkflow(
            cmdOpts.releaseType,
            opts.workingDirectory,
            opts.dryRun
          );
        },
        (result) => {
          writeGithubOutput({
            release_type: result.releaseType,
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
          });
          emit(result, opts, renderCreateRC);
        }
      );
    });
}

function renderCreateRC(r: ReleaseWorkflowContext): string {
  const lines = [
    `Release type: ${r.releaseType}`,
    `Version:      ${r.targetVersion?.version ?? "—"}`,
  ];
  if (r.pullRequestUrl) lines.push(`Pull Request: ${r.pullRequestUrl}`);
  return lines.join("\n");
}
