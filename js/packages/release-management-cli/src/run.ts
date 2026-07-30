import {
  GitFlowManager,
  ReleaseAgent,
  BranchSelectionError,
  StalePlanError,
} from "@officespacesoftware/release-management-core";
import { UsageError } from "./errors.js";
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

/**
 * Create a ReleaseAgent. `initialize` loads the versioner library, which only the
 * commands that rewrite VERSION need; a downmerge reads git and GitHub alone, and
 * failing on an absent versioner would be a false negative.
 */
export async function createReleaseAgent(
  gfm: GitFlowManager,
  opts: BaseOptions,
  { initialize = true }: { initialize?: boolean } = {}
): Promise<ReleaseAgent> {
  const agent = new ReleaseAgent(gfm, opts.workingDirectory);
  if (initialize) {
    await agent.initialize();
  }
  return agent;
}

/**
 * Standard wrapper: run an async command, render its result, translate
 * thrown errors into process exit codes + stderr messages.
 *
 * `renderError` lets a command replace the default one-line stderr message for
 * errors it can report more usefully; returning undefined keeps the default.
 */
export async function runCommand<T>(
  fn: () => Promise<T>,
  onSuccess: (result: T) => void,
  renderError?: (error: unknown) => string | undefined
): Promise<never> {
  try {
    const result = await fn();
    onSuccess(result);
    process.exit(ExitCode.Success);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${renderError?.(error) ?? `Error: ${message}`}\n`);
    process.exit(classifyError(error, message));
  }
}

export function classifyError(error: unknown, message: string): ExitCode {
  // A refused branch selection is the operator's to resolve, not an environment fault.
  if (error instanceof BranchSelectionError) {
    return ExitCode.UserError;
  }
  // Contradictory flags, and a plan the repository has moved past, are both the
  // operator's to resolve: re-run with different arguments.
  if (error instanceof UsageError || error instanceof StalePlanError) {
    return ExitCode.UserError;
  }
  const lower = message.toLowerCase();
  if (
    lower.includes("not a git repository") ||
    lower.includes("staged changes detected") ||
    lower.includes("not found") ||
    lower.includes("no release branches") ||
    lower.includes("no hotfix branches") ||
    lower.includes("is already merged into") ||
    lower.includes("refusing to") ||
    lower.includes("versioner mcp is not available")
  ) {
    return ExitCode.UserError;
  }
  return ExitCode.EnvironmentError;
}
