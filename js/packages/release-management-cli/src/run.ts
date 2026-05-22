import { GitFlowManager, ReleaseAgent } from "@officespacesoftware/release-management-core";
import { ExitCode } from "./exit-codes.js";

export interface BaseOptions {
  workingDirectory: string;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
}

export function resolveBaseOptions(opts: {
  workingDirectory?: string;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
}): BaseOptions {
  return {
    workingDirectory: opts.workingDirectory ?? process.cwd(),
    dryRun: opts.dryRun ?? false,
    json: opts.json ?? false,
    quiet: opts.quiet ?? false,
  };
}

/**
 * Create a GitFlowManager bound to `workingDirectory`. Silence its `console.log`
 * progress chatter when `--quiet` is set (the underlying class doesn't take an
 * option for it; we override the global console.log just for this process).
 *
 * The MCP relies on these logs being printed; the CLI shouldn't.
 */
export function createGitFlowManager(opts: BaseOptions): GitFlowManager {
  if (opts.quiet || opts.json) {
    // JSON callers don't want stray ✅ lines polluting their stdout.
    const noop = () => undefined;
    console.log = noop;
    console.warn = noop;
  }
  return new GitFlowManager(opts.workingDirectory);
}

export async function createReleaseAgent(
  gfm: GitFlowManager,
  opts: BaseOptions
): Promise<ReleaseAgent> {
  const agent = new ReleaseAgent(gfm, opts.workingDirectory);
  await agent.initialize();
  return agent;
}

/**
 * Standard wrapper: run an async command, render its result, translate
 * thrown errors into process exit codes + stderr messages.
 */
export async function runCommand<T>(
  fn: () => Promise<T>,
  onSuccess: (result: T) => void
): Promise<never> {
  try {
    const result = await fn();
    onSuccess(result);
    process.exit(ExitCode.Success);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(classifyError(message));
  }
}

function classifyError(message: string): ExitCode {
  const lower = message.toLowerCase();
  if (
    lower.includes("not a git repository") ||
    lower.includes("staged changes detected") ||
    lower.includes("not found") ||
    lower.includes("no release branches") ||
    lower.includes("no hotfix branches") ||
    lower.includes("versioner mcp is not available")
  ) {
    return ExitCode.UserError;
  }
  return ExitCode.EnvironmentError;
}
