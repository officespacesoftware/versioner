/**
 * Shared environment/state guards used by both the MCP and CLI front-ends.
 *
 * Each guard throws on failure with a clear message; callers convert the
 * exception into their preferred output shape (MCP returns a formatted text
 * block, CLI exits non-zero with the message on stderr).
 */

import type { GitFlowManager } from "./git-flow.js";
import type { ReleaseAgent } from "./release-agent.js";

export async function ensureGitRepository(
  gitFlowManager: GitFlowManager,
  workingDirectory: string
): Promise<void> {
  const isGitRepo = await gitFlowManager.isGitRepository();
  if (!isGitRepo) {
    throw new Error(`Directory '${workingDirectory}' is not a Git repository`);
  }
}

export async function ensureNoStagedChanges(
  gitFlowManager: GitFlowManager
): Promise<void> {
  await gitFlowManager.validateNoStagedChanges();
}

export function ensureVersionerAvailable(releaseAgent: ReleaseAgent): void {
  if (!releaseAgent.isVersionerAvailable()) {
    throw new Error(
      "Versioner MCP is not available. Please ensure versioner-mcp is running."
    );
  }
}
