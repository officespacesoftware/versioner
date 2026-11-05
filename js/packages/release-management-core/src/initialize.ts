/**
 * initialize_versioner, shared by the MCP server and the CLI.
 *
 * Everything that can refuse is checked before anything is written, and a failure
 * after writing removes what this created, so a failed run never leaves state that
 * makes the next one refuse.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { VersionerAdapter, type VersionInfo } from "./versioner-adapter.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_INITIAL_VERSION = "0.1.0-RC.0";

/** What the versioner accepts: `X.Y.Z` or `X.Y.Z-RC.N`. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-RC\.\d+)?$/;

/**
 * Create VERSION in `workingDirectory`, commit it and tag it, through a versioner
 * bound to that directory for this call alone.
 */
export async function initializeVersioner(
  workingDirectory: string,
  version?: string
): Promise<VersionInfo> {
  const initial = version || DEFAULT_INITIAL_VERSION;
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: workingDirectory })).stdout.trim();

  if (!VERSION_PATTERN.test(initial)) {
    throw new Error(
      `Invalid version format: ${initial}. Expected format: X.Y.Z or X.Y.Z-RC.N. ` +
        `Nothing was written.`
    );
  }
  const versionFile = join(workingDirectory, "VERSION");
  if (existsSync(versionFile)) {
    throw new Error(
      "Cannot initialize the project with a version file: The file VERSION already exists."
    );
  }
  let headBefore: string;
  try {
    headBefore = await git("rev-parse", "--verify", "HEAD");
  } catch {
    throw new Error(
      "The usage of this tool requires an existing git project with at least one revision."
    );
  }
  if ((await git("tag", "--list", initial)) !== "") {
    throw new Error(`Tag '${initial}' already exists. Nothing was written.`);
  }

  const adapter = new VersionerAdapter();
  await adapter.initialize(undefined, workingDirectory);
  try {
    return await adapter.initializeProject(initial);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await undoInitialization(git, versionFile, headBefore, initial);
    } catch (cleanup) {
      throw new Error(
        `${message} Removing what it created also failed (${cleanup}): check ` +
          `for a VERSION file, a "To version ${initial}" commit and a tag ` +
          `${initial}, and remove them by hand.`
      );
    }
    throw new Error(
      `${message} Everything it created was removed, so it can be run again.`
    );
  } finally {
    await adapter.disconnect();
  }
}

/**
 * Remove what a failed initialization created: its commit, only when it is the
 * one commit on top of where HEAD was; its tag, which did not exist before; and
 * the VERSION file, which did not exist before either, from the index and disk.
 */
async function undoInitialization(
  git: (...args: string[]) => Promise<string>,
  versionFile: string,
  headBefore: string,
  tag: string
): Promise<void> {
  const head = await git("rev-parse", "HEAD");
  if (head !== headBefore) {
    const parent = await git("rev-parse", "HEAD^");
    if (parent === headBefore) {
      await git("reset", "-q", "--soft", headBefore);
    }
  }
  if ((await git("tag", "--list", tag)) !== "") {
    await git("tag", "-d", tag);
  }
  await git("reset", "-q", "--", "VERSION");
  await rm(versionFile, { force: true });
}
