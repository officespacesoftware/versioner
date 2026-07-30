import { Command } from "commander";
import {
  MergeConflictError,
  type DownmergeResult,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { runPlanAwareCommand } from "../plan.js";
import { resolveBaseOptions } from "../run.js";

/** The plan/confirm flags every downmerge subcommand takes. */
function withPlanFlags(command: Command): Command {
  return command
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option("--plan", "Describe the change and exit; touches nothing (the default when no apply flag is given)")
    .option("--confirm <digest>", "Apply the plan carrying this digest, as printed by --plan")
    .option("--yes", "Apply without a digest, printing the plan for the record (for automation)");
}

export function registerDownmerge(parent: Command): void {
  const dm = parent.command("downmerge").description("Downmerge workflows");

  withPlanFlags(
    dm
      .command("main-to-develop")
      .description("PR main → develop via a merge branch")
  ).action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runPlanAwareCommand({
      commandName: "downmerge main-to-develop",
      opts,
      flags: cmdOpts,
      requiresVersioner: false,
      buildPlan: (agent) => agent.planDownmergeMainToDevelop(),
      execute: async (_agent, gfm) => {
        try {
          const url = await gfm.downmergeMainToDevelop();
          return { kind: "direct" as const, pullRequestUrl: url };
        } catch (e) {
          throw asConflictError(e, "main", "develop");
        }
      },
      onExecuted: (result) => {
        writeGithubOutput({ pull_request_url: result.pullRequestUrl });
        emit(result, opts, renderDownmerge);
      },
    });
  });

  withPlanFlags(
    dm
      .command("release-to-develop")
      .description("PR release → develop (direct if clean, merge branch + build-trigger if conflicts)")
      .option("--version <version>", "Specific release version; auto-detect newest if omitted")
  ).action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runPlanAwareCommand({
      commandName: "downmerge release-to-develop",
      opts,
      flags: cmdOpts,
      requiresVersioner: false,
      buildPlan: (agent) => agent.planDownmergeReleaseToDevelop(cmdOpts.version),
      execute: (_agent, gfm) => gfm.downmergeReleaseToDevelop(cmdOpts.version),
      onExecuted: (result) => {
        writeDownmergeOutputs(result);
        emit(result, opts, renderDownmerge);
      },
    });
  });

  withPlanFlags(
    dm
      .command("release-to-main")
      .description("PR release → main via merge branch (never head=release/*)")
      .option("--version <version>", "Specific release version; auto-detect newest if omitted")
  ).action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runPlanAwareCommand({
      commandName: "downmerge release-to-main",
      opts,
      flags: cmdOpts,
      requiresVersioner: false,
      buildPlan: (agent) => agent.planDownmergeReleaseToMain(cmdOpts.version),
      execute: async (_agent, gfm) => {
        try {
          return await gfm.downmergeReleaseToMain(cmdOpts.version);
        } catch (e) {
          throw asConflictError(e, "release", "main");
        }
      },
      onExecuted: (result) => {
        writeDownmergeOutputs(result);
        emit(result, opts, renderDownmerge);
      },
    });
  });

  withPlanFlags(
    dm
      .command("hotfix-to-main")
      .description("PR hotfix → main")
      .option("--version <version>", "Specific hotfix version; auto-detect newest if omitted")
  ).action(async (cmdOpts) => {
    const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
    await runPlanAwareCommand({
      commandName: "downmerge hotfix-to-main",
      opts,
      flags: cmdOpts,
      requiresVersioner: false,
      buildPlan: (agent) => agent.planDownmergeHotfixToMain(cmdOpts.version),
      execute: async (_agent, gfm) => {
        const url = await gfm.downmergeHotfixToMain(cmdOpts.version);
        return { kind: "direct" as const, pullRequestUrl: url };
      },
      onExecuted: (result) => {
        writeGithubOutput({ pull_request_url: result.pullRequestUrl });
        emit(result, opts, renderDownmerge);
      },
    });
  });
}

/**
 * Turn a MergeConflictError into an operator-facing message. Every aborting merge
 * path reports the same way: the merge was undone, nothing was pushed, and the
 * conflicted files are listed.
 */
function asConflictError(
  error: unknown,
  source: string,
  target: string
): unknown {
  if (!(error instanceof MergeConflictError)) {
    return error;
  }
  return new Error(
    [
      `Aborted: merge of ${source} into ${target} produced conflicts.`,
      "The merge was aborted and no branch or PR was created.",
      "Conflicted files:",
      ...error.conflictedFiles.map((f) => `  - ${f}`),
      "",
      `Resolve manually, then open the PR by hand or re-run once ${source} and ${target} no longer conflict.`,
    ].join("\n")
  );
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
        build_trigger_pr_url: result.buildTriggerPullRequestUrl ?? "",
        build_trigger_pr_number: result.buildTriggerPullRequestNumber
          ? String(result.buildTriggerPullRequestNumber)
          : "",
        build_trigger_skipped_reason: result.buildTriggerSkippedReason ?? "",
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
        ...(r.buildTriggerSkippedReason
          ? [`Build-trigger PR skipped: ${r.buildTriggerSkippedReason}`]
          : [
              `Build-trigger PR (auto-closed): ${r.buildTriggerPullRequestUrl}`,
              `CI checks observed before close: ${r.checksStarted ? "yes" : "no (60s timeout)"}`,
            ]),
        ``,
        `Conflicted files:`,
        ...r.conflictedFiles.map((f) => `  - ${f}`),
      ].join("\n");
  }
}
