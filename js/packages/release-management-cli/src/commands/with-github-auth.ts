import { spawn } from "child_process";
import { constants } from "os";
import { Command } from "commander";
import type { GitHubRepository } from "@officespacesoftware/release-management-core";
import { UsageError } from "../errors.js";
import {
  classifyError,
  createGitFlowManager,
  resolveBaseOptions,
} from "../run.js";

const NAME = "with-github-auth";

export function registerWithGitHubAuth(parent: Command): void {
  parent
    .command(NAME)
    .description(
      "Run a command, such as git or gh, as the GitHub identity the release " +
        "tools use: their credential and, with a GitHub App, the app's bot " +
        "as commit author"
    )
    .usage("[--repo <owner/name>] -- <command> [args...]")
    .argument("[command...]", "The command to run and its arguments, after --")
    .option(
      "--repo <owner/name>",
      "Repository the credential is for (default: the current directory's " +
        "origin)"
    )
    .action(async (_command: string[], cmdOpts: { repo?: string }) => {
      let command: string[];
      let env: NodeJS.ProcessEnv;
      try {
        command = commandAfterSeparator(process.argv);
        const repository =
          cmdOpts.repo === undefined
            ? undefined
            : parseRepository(cmdOpts.repo);
        const gfm = createGitFlowManager(resolveBaseOptions(parent.opts()));
        env = await gfm.githubCommandEnv(repository);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(classifyError(error, message));
      }
      process.exit(await runCommandWithEnv(command, env));
    });
}

export function commandAfterSeparator(argv: string[]): string[] {
  const separator = argv.indexOf("--", argv.indexOf(NAME) + 1);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (command.length === 0) {
    throw new UsageError(
      `${NAME} needs the command to run after --, for example: ` +
        `release-management ${NAME} -- git push origin HEAD`
    );
  }
  return command;
}

export function parseRepository(value: string): GitHubRepository {
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw new UsageError(
      `--repo must be owner/name, such as octo-org/octo-repo, not '${value}'.`
    );
  }
  return { owner: match[1], repo: match[2] };
}

export function runCommandWithEnv(
  command: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const [file, ...args] = command as [string, ...string[]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const wait = () => undefined;
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    process.on("SIGINT", wait);
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
      process.off("SIGINT", wait);
      resolve(code);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(
        `Error: Could not run '${file}': ${error.message}\n`
      );
      finish(error.code === "ENOENT" ? 127 : 126);
    });
    child.on("close", (code, signal) => {
      finish(signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1);
    });
  });
}
