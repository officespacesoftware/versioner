import { Command } from "commander";
import {
  ensureGitRepository,
  ensureNoStagedChanges,
  MergeConflictError,
  type DownmergeResult,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

export function registerDownmerge(parent: Command): void {
  const dm = parent.command("downmerge").description("Downmerge workflows");

  dm.command("main-to-develop")
    .description("PR main → develop via a merge branch")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          const url = await gfm.downmergeMainToDevelop(opts.dryRun);
          return { kind: "direct" as const, pullRequestUrl: url };
        },
        (result) => {
          writeGithubOutput({ pull_request_url: result.pullRequestUrl });
          emit(result, opts, renderDownmerge);
        }
      );
    });

  dm.command("release-to-develop")
    .description("PR release → develop (direct if clean, merge branch + build-trigger if conflicts)")
    .option("--version <version>", "Specific release version; auto-detect newest if omitted")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          return gfm.downmergeReleaseToDevelop(cmdOpts.version, opts.dryRun);
        },
        (result) => {
          writeDownmergeOutputs(result);
          emit(result, opts, renderDownmerge);
        }
      );
    });

  dm.command("release-to-main")
    .description("PR release → main via merge branch (never head=release/*)")
    .option("--version <version>", "Specific release version; auto-detect newest if omitted")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          try {
            return await gfm.downmergeReleaseToMain(cmdOpts.version, opts.dryRun);
          } catch (e) {
            if (e instanceof MergeConflictError) {
              const lines = [
                "Aborted: merge of release into main produced conflicts.",
                "Conflicted files:",
                ...e.conflictedFiles.map((f) => `  - ${f}`),
                "",
                "Resolve manually, then open the PR by hand or re-run once conflicts no longer occur.",
              ];
              const error = new Error(lines.join("\n"));
              throw error;
            }
            throw e;
          }
        },
        (result) => {
          writeDownmergeOutputs(result);
          emit(result, opts, renderDownmerge);
        }
      );
    });

  dm.command("hotfix-to-main")
    .description("PR hotfix → main")
    .option("--version <version>", "Specific hotfix version; auto-detect newest if omitted")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--dry-run", "Validate without making changes")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          const url = await gfm.downmergeHotfixToMain(cmdOpts.version, opts.dryRun);
          return { kind: "direct" as const, pullRequestUrl: url };
        },
        (result) => {
          writeGithubOutput({ pull_request_url: result.pullRequestUrl });
          emit(result, opts, renderDownmerge);
        }
      );
    });
}

function writeDownmergeOutputs(result: DownmergeResult): void {
  switch (result.kind) {
    case "direct":
      writeGithubOutput({
        kind: result.kind,
        pull_request_url: result.pullRequestUrl,
      });
      return;
    case "merge-branch":
      writeGithubOutput({
        kind: result.kind,
        pull_request_url: result.pullRequestUrl,
        merge_branch: result.mergeBranchName,
      });
      return;
    case "merge-branch-with-conflicts":
      writeGithubOutput({
        kind: result.kind,
        merge_branch: result.mergeBranchName,
        merge_pr_url: result.mergeBranchPullRequestUrl,
        build_trigger_pr_url: result.buildTriggerPullRequestUrl,
        build_trigger_pr_number: String(result.buildTriggerPullRequestNumber),
        checks_started: String(result.checksStarted),
        conflicted_files: result.conflictedFiles.join(","),
      });
      return;
  }
}

function renderDownmerge(r: DownmergeResult): string {
  switch (r.kind) {
    case "direct":
      return `Pull Request: ${r.pullRequestUrl}`;
    case "merge-branch":
      return [
        `Merge branch: ${r.mergeBranchName}`,
        `Pull Request: ${r.pullRequestUrl}`,
      ].join("\n");
    case "merge-branch-with-conflicts":
      return [
        `Merge branch (conflicts unresolved): ${r.mergeBranchName}`,
        `Draft merge-resolution PR: ${r.mergeBranchPullRequestUrl}`,
        `Build-trigger PR (auto-closed): ${r.buildTriggerPullRequestUrl}`,
        `CI checks observed before close: ${r.checksStarted ? "yes" : "no (60s timeout)"}`,
        ``,
        `Conflicted files:`,
        ...r.conflictedFiles.map((f) => `  - ${f}`),
      ].join("\n");
  }
}
