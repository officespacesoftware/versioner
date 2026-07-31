import { Command } from "commander";
import {
  ensureGitRepository,
  type VersionListing,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import { createGitFlowManager, resolveBaseOptions, runCommand } from "../run.js";

export function registerListVersions(parent: Command): void {
  parent
    .command("list-versions")
    .description(
      "List every release/hotfix branch with its version, tag and merge status (read-only)"
    )
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .option(
      "--production-branch <branch>",
      "Branch treated as production for merge status (default: main)"
    )
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          // No staged-changes guard: this command never mutates the repository.
          return gfm.listVersions(cmdOpts.productionBranch || "main");
        },
        (result) => {
          const candidates = result.entries.filter((e) => e.kind === "rc");
          writeGithubOutput({
            current_branch: result.currentBranch,
            release_candidates: candidates.map((e) => e.version).join(","),
          });
          emit(result, opts, renderListing);
        }
      );
    });
}

function renderListing(r: VersionListing): string {
  if (r.entries.length === 0) {
    return `No release or hotfix branches found (current branch: ${r.currentBranch})`;
  }

  const rows = r.entries.map((e) => {
    const marker = e.isCurrentBranch ? "*" : " ";
    const kind = e.kind === "rc" ? "RC" : e.kind;
    const tag = e.tagExistsRemotely
      ? "tag:remote"
      : e.tagExistsLocally
      ? "tag:local-only"
      : "tag:none";
    const merged = e.mergedIntoProduction
      ? `merged->${r.productionBranch}`
      : "unmerged";
    const flags = [tag, merged, ...(e.staleLocal ? ["local-stale"] : [])];
    return `${marker} ${e.branch}  ${
      e.version ?? "no VERSION"
    }  [${kind}]  (${flags.join(", ")})`;
  });

  return [
    `Current branch: ${r.currentBranch}`,
    `Production branch: ${r.productionBranch}`,
    "",
    ...rows,
    "",
    "* marks the checked-out branch",
    "Versions come from what origin holds; local-stale means your local branch of",
    "that name holds a different version",
    "[unknown] means no VERSION could be read on either side — not the same as [final]",
    "Tag columns are live; merge status is only as fresh as your last fetch",
  ].join("\n");
}
