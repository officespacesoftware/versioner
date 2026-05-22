import { Command } from "commander";
import {
  ensureGitRepository,
  ensureNoStagedChanges,
  ensureVersionerAvailable,
  type HotfixWorkflowContext,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  createReleaseAgent,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

export function registerCreateHotfix(parent: Command): void {
  parent
    .command("create-hotfix")
    .description("Create a new hotfix branch (hotfix/X.Y.Z) at RC.0")
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
          return agent.executeHotfixWorkflow(opts.workingDirectory, opts.dryRun);
        },
        (result) => {
          writeGithubOutput({
            version: result.targetVersion?.version,
            pull_request_url: result.pullRequestUrl,
          });
          emit(result, opts, renderHotfix);
        }
      );
    });
}

function renderHotfix(r: HotfixWorkflowContext): string {
  const lines = [`Version: ${r.targetVersion?.version ?? "—"}`];
  if (r.pullRequestUrl) lines.push(`Pull Request: ${r.pullRequestUrl}`);
  return lines.join("\n");
}
