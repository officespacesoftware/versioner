import { Command } from "commander";
import {
  VersionerAdapter,
  ensureGitRepository,
  ensureNoStagedChanges,
  type VersionInfo,
} from "@officespacesoftware/release-management-core";
import { emit, writeGithubOutput } from "../output.js";
import {
  createGitFlowManager,
  resolveBaseOptions,
  runCommand,
} from "../run.js";

export function registerInitializeVersioner(parent: Command): void {
  parent
    .command("initialize-versioner")
    .description("Initialize versioner: create VERSION file + initial tag")
    .option("--version <version>", "Initial version (default 0.1.0-RC.0)")
    .option("--working-directory <path>", "Repo root (defaults to cwd)")
    .action(async (cmdOpts) => {
      const opts = resolveBaseOptions({ ...parent.opts(), ...cmdOpts });
      await runCommand(
        async () => {
          const gfm = createGitFlowManager(opts);
          await ensureGitRepository(gfm, opts.workingDirectory);
          await ensureNoStagedChanges(gfm);
          const adapter = new VersionerAdapter();
          await adapter.initialize(undefined, opts.workingDirectory);
          return adapter.initializeProject(cmdOpts.version);
        },
        (result) => {
          writeGithubOutput({
            version: result.version,
            is_release_candidate: String(result.isReleaseCandidate),
          });
          emit(result, opts, renderInitialize);
        }
      );
    });
}

function renderInitialize(r: VersionInfo): string {
  return [
    `Version: ${r.version}`,
    `Type:    ${r.isReleaseCandidate ? "Release Candidate" : "Final Release"}`,
  ].join("\n");
}
