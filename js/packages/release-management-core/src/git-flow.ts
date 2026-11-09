/**
 * Git Flow Core Logic - Git operations and branch management
 */

import { exec } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import {
  createGitHubClient,
  describeGitHubAuth,
  gitCredentialEnv,
  gitIdentityEnv,
  type GitHubAuthStatus,
} from "./github-client.js";
import {
  isGitHubAppAuthConfigured,
  redactGitHubSecrets,
} from "./github-app-auth.js";
import {
  ManualDownmergeRequired,
  describeManualDownmerge,
  downmergePullRequestTitle,
  type DownmergeRoute,
} from "./manual-downmerge.js";

const execAsync = promisify(exec);

function isOctokitStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}

function octokitErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export const MCP_WATERMARK_START = "<!-- RELEASE-MANAGEMENT-MCP:START -->";
export const MCP_WATERMARK_END = "<!-- RELEASE-MANAGEMENT-MCP:END -->";

function wrapWithWatermarks(body: string): string {
  return `${MCP_WATERMARK_START}\n${body}\n${MCP_WATERMARK_END}`;
}

function replaceWatermarkedContent(
  existingBody: string,
  newContent: string
): string {
  const startIdx = existingBody.indexOf(MCP_WATERMARK_START);
  const endIdx = existingBody.indexOf(MCP_WATERMARK_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingBody.substring(0, startIdx);
    const after = existingBody.substring(endIdx + MCP_WATERMARK_END.length);
    return before + wrapWithWatermarks(newContent) + after;
  }
  // No existing watermarks — append
  return existingBody + "\n\n" + wrapWithWatermarks(newContent);
}

function quoteGitArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: string | undefined;
  commitHash: string;
  commitMessage: string;
}

export interface GitStatus {
  currentBranch: string;
  isClean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface BranchComparisonResult {
  ahead: number;
  behind: number;
  synchronized: boolean;
  divergent: boolean;
}

export type BranchType = "release" | "hotfix";

const DEFAULT_LOCAL_TIMEOUT_MS = 30_000;
/** A checkout of a large repository takes far longer than other local commands. */
const WORKTREE_TIMEOUT_MS = 300_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 300_000;

export interface GitTimeoutOptions {
  localTimeoutMs?: number;
  networkTimeoutMs?: number;
}

export interface MergeConflictProbe {
  hasConflicts: boolean;
  conflictedFiles: string[];
}

export interface BranchVersionValidation {
  valid: boolean;
  behind: boolean;
  baseVersion: string | null;
  message: string;
}

/**
 * What a branch's VERSION says about it. `unknown` is distinct from `final`: a
 * branch whose VERSION cannot be read makes no claim either way, and reporting it
 * as final asserts something we have not established.
 */
export type VersionKind = "rc" | "final" | "unknown";

export interface VersionListingEntry {
  branch: string;
  type: BranchType;
  /** First line of the branch's VERSION file, or null when unreadable. */
  version: string | null;
  kind: VersionKind;
  isCurrentBranch: boolean;
  tagExistsLocally: boolean;
  tagExistsRemotely: boolean;
  mergedIntoProduction: boolean;
  /**
   * A local branch of this name exists and its VERSION disagrees with the remote's.
   * `version` reports the remote, so this marks the local checkout as behind.
   */
  staleLocal: boolean;
}

export interface VersionListing {
  currentBranch: string;
  productionBranch: string;
  entries: VersionListingEntry[];
}

/** Subcommands that talk to the remote and so may legitimately take minutes. */
const NETWORK_GIT_SUBCOMMANDS = [
  "fetch",
  "push",
  "pull",
  "clone",
  "ls-remote",
  "remote",
  "submodule",
];

export function isNetworkGitCommand(command: string): boolean {
  const subcommand = command.trim().split(/\s+/)[0] ?? "";
  return NETWORK_GIT_SUBCOMMANDS.includes(subcommand);
}

const IDENTITY_GIT_SUBCOMMANDS = [
  "am",
  "cherry-pick",
  "commit",
  "merge",
  "pull",
  "rebase",
  "revert",
  "tag",
];

function createsGitObjects(command: string): boolean {
  const subcommand = command.trim().split(/\s+/)[0] ?? "";
  return IDENTITY_GIT_SUBCOMMANDS.includes(subcommand);
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("killed" in error || "signal" in error) &&
    (error as { signal?: string }).signal === "SIGTERM"
  );
}

/**
 * Warning banner for any PR that merges into the production branch.
 *
 * Shared so that every pull request targeting the production branch carries it.
 */
export function productionMergeWarning(kind: string): string {
  return [
    "> [!WARNING]",
    `> This PR must be merged **after** the ${kind} has been deployed to production.`,
  ].join("\n");
}

/** Where this tool lives, for the attribution line on every pull request it opens. */
export const RELEASE_MANAGEMENT_MCP_URL =
  "https://github.com/officespacesoftware/versioner/tree/master/js/packages/release-management-mcp";

/**
 * Attribution line closing every generated pull request body.
 *
 * Shared so the link cannot rot in one body while staying correct in the others —
 * it previously pointed at a path that moved, in eleven separate copies.
 */
export function autoGeneratedFooter(): string {
  return `🤖 Auto-generated by [Release Management MCP](${RELEASE_MANAGEMENT_MCP_URL})`;
}

export interface PullRequestResult {
  url: string;
  action: "created" | "updated";
}

export interface OpenPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
}

/**
 * An open `head` → `base` pull request a downmerge's merge-branch pull request
 * replaced, and closed with a comment linking the replacement. `error` is set
 * when closing it, or looking it up (then without a number), failed: it may
 * still be open.
 */
export interface SupersededPullRequest {
  head: string;
  base: string;
  number?: number;
  url?: string;
  error?: string;
}

export type DownmergeResult =
  | { kind: "direct"; pullRequestUrl: string }
  | {
      kind: "merge-branch";
      pullRequestUrl: string;
      mergeBranchName: string;
      /** Set when an open pull request was superseded by this one. */
      superseded?: SupersededPullRequest;
      /**
       * The pull request is one an earlier run of this downmerge opened, which
       * already holds the source; nothing new was created.
       */
      alreadyOpen?: boolean;
    };

export interface MergeBranchResult {
  sha: string;
  branchName: string;
}

/** Origin still has a ref after being asked to delete it. */
export class RemoteDeletionRefused extends Error {
  readonly ref: string;
  constructor(ref: string, detail: string) {
    super(
      `Origin refused to delete ${ref}${detail ? `: ${detail.trim()}` : ""}`
    );
    this.name = "RemoteDeletionRefused";
    this.ref = ref;
  }
}

export class MergeConflictError extends Error {
  conflictedFiles: string[];
  constructor(message: string, conflictedFiles: string[]) {
    super(message);
    this.name = "MergeConflictError";
    this.conflictedFiles = conflictedFiles;
  }
}

/**
 * A `version` input naming a branch: `X.Y.Z`, or the full branch name
 * `release/X.Y.Z` or `hotfix/X.Y.Z`, which also says which of the two is meant.
 */
export function parseVersionSelector(input: string): {
  type?: BranchType;
  version: string;
} {
  const trimmed = input.trim();
  const match = trimmed.match(/^(release|hotfix)\/(\d+\.\d+\.\d+)$/);
  if (match?.[1] && match[2]) {
    return { type: match[1] as BranchType, version: match[2] };
  }
  return { version: trimmed };
}

export interface BranchTypeInfo {
  name: string;
  type: BranchType;
  version: {
    major: number;
    minor: number;
    patch: number;
    full: string;
  };
  baseBranch: "develop" | "main";
  targetBranch: "develop" | "main";
}

/**
 * Git Flow operations for release management
 */
export class GitFlowManager {
  private workingDirectory: string;
  private localTimeoutMs: number;
  private networkTimeoutMs: number;

  constructor(
    workingDirectory: string = process.cwd(),
    options: GitTimeoutOptions = {}
  ) {
    this.workingDirectory = workingDirectory;
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  }

  /**
   * Execute git command in the working directory.
   *
   * Network subcommands get a far longer timeout than local ones: a fetch or push on a
   * large repository routinely exceeds ten seconds, and a timeout kill is
   * indistinguishable from a real failure while the operation may have partly completed.
   */
  private async execGit(command: string): Promise<string> {
    const timeout = isNetworkGitCommand(command)
      ? this.networkTimeoutMs
      : this.localTimeoutMs;

    const env = await this.gitEnvironment(command);
    try {
      const { stdout, stderr } = await execAsync(`git ${command}`, {
        cwd: this.workingDirectory,
        timeout,
        ...(env ? { env } : {}),
      });

      if (stderr) {
        console.warn(redactGitHubSecrets(`Git warning: ${stderr}`));
      }

      return stdout.trim();
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Git command timed out after ${timeout}ms: git ${command}. ` +
            `The operation may have partially completed — inspect the repository before retrying.`
        );
      }
      throw new Error(redactGitHubSecrets(`Git command failed: ${error}`));
    }
  }

  private async gitEnvironment(
    command: string
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!isGitHubAppAuthConfigured()) return undefined;
    const credentials = isNetworkGitCommand(command)
      ? await gitCredentialEnv(this.workingDirectory)
      : {};
    const identity = createsGitObjects(command)
      ? await gitIdentityEnv(this.workingDirectory)
      : {};
    return { ...process.env, ...credentials, ...identity };
  }

  async describeGitHubAuth(): Promise<GitHubAuthStatus> {
    return describeGitHubAuth(this.workingDirectory);
  }

  /**
   * Run git tolerating a non-zero exit, returning both stdout and the exit code.
   *
   * Needed for commands that use the exit code as a result rather than an error —
   * `merge-tree` exits 1 to report conflicts while still writing its answer to stdout.
   */
  private async execGitTolerant(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeout = isNetworkGitCommand(command)
      ? this.networkTimeoutMs
      : this.localTimeoutMs;

    const env = await this.gitEnvironment(command);
    try {
      const { stdout, stderr } = await execAsync(`git ${command}`, {
        cwd: this.workingDirectory,
        timeout,
        ...(env ? { env } : {}),
      });
      return {
        stdout: stdout.trim(),
        stderr: redactGitHubSecrets(stderr.trim()),
        exitCode: 0,
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Git command timed out after ${timeout}ms: git ${command}.`
        );
      }
      const shaped = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      if (typeof shaped.code === "number") {
        return {
          stdout: (shaped.stdout ?? "").trim(),
          stderr: redactGitHubSecrets((shaped.stderr ?? "").trim()),
          exitCode: shaped.code,
        };
      }
      throw new Error(redactGitHubSecrets(`Git command failed: ${error}`));
    }
  }

  /**
   * Get current git status
   */
  async getStatus(): Promise<GitStatus> {
    try {
      const statusOutput = await this.execGit("status --porcelain -b");
      const lines = statusOutput.split("\n").filter((line) => line.trim());

      const branchLine = lines.find((line) => line.startsWith("##"));
      const currentBranch = branchLine
        ? branchLine.split(" ")[1]?.split("...")[0] || "unknown"
        : "unknown";

      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];

      lines.forEach((line) => {
        if (line.startsWith("##")) return;

        const status = line.substring(0, 2);
        const fileName = line.substring(3);

        if (status[0] !== " " && status[0] !== "?") staged.push(fileName);
        if (status[1] !== " " && status[1] !== "?") modified.push(fileName);
        if (status.startsWith("??")) untracked.push(fileName);
      });

      return {
        currentBranch,
        isClean:
          staged.length === 0 &&
          modified.length === 0 &&
          untracked.length === 0,
        staged,
        modified,
        untracked,
      };
    } catch (error) {
      throw new Error(`Failed to get git status: ${error}`);
    }
  }

  /**
   * Validate that there are no staged changes in the repository
   * Throws an error if staged changes are found
   */
  async validateNoStagedChanges(): Promise<void> {
    try {
      const status = await this.getStatus();

      if (status.staged.length > 0) {
        const stagedFiles = status.staged.map((file) => `- ${file}`).join("\n");

        throw new Error(`❌ Cannot proceed: Staged changes detected in git repository

📋 Staged files:
${stagedFiles}

🔧 Please resolve staged changes before running this workflow:
  • Commit staged changes: git commit -m "your message"
  • Or unstage changes: git reset HEAD <file>
  • Or unstage all: git reset HEAD

⚠️  This prevents accidentally committing unrelated changes during the release workflow.`);
      }
    } catch (error) {
      // If error is already our custom validation error, re-throw it
      if (
        error instanceof Error &&
        error.message.includes("Cannot proceed: Staged changes detected")
      ) {
        throw error;
      }
      // Otherwise, wrap it as a validation failure
      throw new Error(`Failed to validate git status: ${error}`);
    }
  }

  /**
   * Get list of branches
   */
  async getBranches(): Promise<GitBranchInfo[]> {
    try {
      const output = await this.execGit(
        'branch -av --format="%(refname:short)|%(HEAD)|%(objectname:short)|%(contents:subject)"'
      );
      const lines = output.split("\n").filter((line) => line.trim());

      return lines.map((line) => {
        const [name, head, commitHash, commitMessage] = line.split("|");
        return {
          name: name?.trim() || "",
          current: head === "*",
          commitHash: commitHash?.trim() || "",
          commitMessage: commitMessage?.trim() || "",
          remote: name?.includes("remotes/") ? name.split("/")[1] : undefined,
        };
      });
    } catch (error) {
      throw new Error(`Failed to get branches: ${error}`);
    }
  }

  /**
   * Fetch only the long-lived base branches used by the release workflow.
   */
  async fetchBaseBranches(): Promise<void> {
    await this.execGit(
      [
        "fetch origin",
        quoteGitArg("+refs/heads/main:refs/remotes/origin/main"),
        quoteGitArg("+refs/heads/develop:refs/remotes/origin/develop"),
      ].join(" ")
    );
  }

  /**
   * Bring every remote-tracking ref a plan reads up to date: main, develop, and
   * each release/* and hotfix/* branch, pruning the ones origin no longer has.
   *
   * Plans call this first, so a plan always reflects origin, and an apply, which
   * rebuilds the plan before comparing digests, acts on exactly the state it just
   * fetched. Writes only refs/remotes/origin/*: no tags (a stale local tag of the
   * same name would make the fetch fail), no local branch, no working tree.
   * Explicit refspecs rather than a bare fetch, which can fail on unrelated
   * branch names that clash with local remote-tracking refs.
   */
  async fetchOrigin(): Promise<void> {
    const listed = await this.execGit(
      "ls-remote --heads origin refs/heads/main refs/heads/develop"
    );
    const present = new Set(
      listed
        .split("\n")
        .map((line) => line.split(/\s+/)[1])
        .filter((ref): ref is string => ref !== undefined)
    );
    const refspecs = ["main", "develop"]
      .filter((name) => present.has(`refs/heads/${name}`))
      .map((name) => `+refs/heads/${name}:refs/remotes/origin/${name}`);
    refspecs.push(
      "+refs/heads/release/*:refs/remotes/origin/release/*",
      "+refs/heads/hotfix/*:refs/remotes/origin/hotfix/*"
    );
    await this.execGit(
      `fetch --prune --no-tags origin ${refspecs.map(quoteGitArg).join(" ")}`
    );
  }

  /** Fetch one branch into its remote-tracking ref, without tags. */
  async fetchBranchRef(branchName: string): Promise<void> {
    await this.execGit(
      `fetch --no-tags origin ${quoteGitArg(
        `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`
      )}`
    );
  }

  /**
   * Fetch a single branch to FETCH_HEAD without updating every remote-tracking ref.
   */
  async fetchBranch(branchName: string): Promise<void> {
    await this.execGit(`fetch origin ${quoteGitArg(branchName)}`);
  }

  /**
   * Pull a single branch from origin.
   */
  async pullBranch(branchName: string): Promise<void> {
    await this.execGit(`pull origin ${quoteGitArg(branchName)}`);
  }

  /**
   * List remote release/hotfix branch names without creating remote-tracking refs.
   */
  private async getRemoteBranchesOfType(
    branchType: BranchType
  ): Promise<GitBranchInfo[]> {
    const output = await this.execGit(
      `ls-remote --heads origin ${quoteGitArg(`refs/heads/${branchType}/*`)}`
    );

    if (!output) {
      return [];
    }

    return output
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [commitHash, refName] = line.split(/\s+/);
        const branchName = refName?.replace(/^refs\/heads\//, "") || "";

        return {
          name: `remotes/origin/${branchName}`,
          current: false,
          remote: "origin",
          commitHash: commitHash?.substring(0, 7) || "",
          commitMessage: "",
        };
      });
  }

  /**
   * Check if one branch is an ancestor of another (i.e., cleanly merged)
   */
  async checkIsAncestor(
    ancestor: string,
    descendant: string
  ): Promise<boolean> {
    try {
      await this.execGit(`merge-base --is-ancestor ${ancestor} ${descendant}`);
      return true;
    } catch (error) {
      // merge-base --is-ancestor returns non-zero exit code when ancestor relationship doesn't exist
      return false;
    }
  }

  /**
   * The files `headRef` changed since it forked from `baseRef`, and nothing `baseRef`
   * changed — the three-dot form, so a base that has moved on does not inflate the list.
   *
   * Read-only, and tolerant: an unknown ref or absent shared history yields an empty
   * list rather than throwing, because callers use this to enrich a warning and must
   * not fail a plan over a diff they could not take.
   */
  async filesChangedSinceFork(
    baseRef: string,
    headRef: string
  ): Promise<string[]> {
    const { stdout, exitCode } = await this.execGitTolerant(
      `diff --name-only ${quoteGitArg(baseRef)}...${quoteGitArg(headRef)}`
    );
    if (exitCode !== 0) {
      return [];
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Check if there are actual content differences between branches
   */
  async checkContentDiff(branch1: string, branch2: string): Promise<boolean> {
    try {
      const diffOutput = await this.execGit(`diff ${branch1}...${branch2}`);
      return diffOutput.trim().length > 0;
    } catch (error) {
      throw new Error(
        `Failed to check content diff between ${branch1} and ${branch2}: ${error}`
      );
    }
  }

  /**
   * Compare two branches to check synchronization
   */
  async compareBranches(
    branch1: string,
    branch2: string
  ): Promise<BranchComparisonResult> {
    try {
      // Get commits ahead/behind
      const aheadOutput = await this.execGit(
        `rev-list --count ${branch2}..${branch1}`
      );
      const behindOutput = await this.execGit(
        `rev-list --count ${branch1}..${branch2}`
      );

      const ahead = parseInt(aheadOutput.trim(), 10) || 0;
      const behind = parseInt(behindOutput.trim(), 10) || 0;

      return {
        ahead,
        behind,
        synchronized: ahead === 0 && behind === 0,
        divergent: ahead > 0 && behind > 0,
      };
    } catch (error) {
      throw new Error(
        `Failed to compare branches ${branch1} and ${branch2}: ${error}`
      );
    }
  }

  /**
   * Verify that main has been merged into develop using robust three-step process.
   * Compares the remote-tracking refs as the plan fetched them; nothing is fetched
   * here, so the apply checks the state that was approved.
   */
  async verifyMainDevelopSync(): Promise<{
    synchronized: boolean;
    message: string;
    canProceed: boolean;
  }> {
    try {
      // Step 1: Check if main is an ancestor of develop (cleanly merged)
      const isAncestor = await this.checkIsAncestor(
        "origin/main",
        "origin/develop"
      );
      if (isAncestor) {
        return {
          synchronized: true,
          message:
            "Main has been cleanly merged into develop. Ready for release.",
          canProceed: true,
        };
      }

      // Step 2: Check if there are any commit differences
      const commitCountOutput = await this.execGit(
        "rev-list --count origin/develop..origin/main"
      );
      const commitCount = parseInt(commitCountOutput.trim(), 10) || 0;

      if (commitCount === 0) {
        return {
          synchronized: true,
          message:
            "No commit differences between main and develop. Ready for release.",
          canProceed: true,
        };
      }

      // Step 3: Check if there are actual content differences
      const hasContentDiff = await this.checkContentDiff(
        "origin/develop",
        "origin/main"
      );
      if (!hasContentDiff) {
        return {
          synchronized: true,
          message: `Main has ${commitCount} different commits but identical content to develop. Ready for release.`,
          canProceed: true,
        };
      }

      // If we reach here, there are actual content differences
      return {
        synchronized: false,
        message: `Main has ${commitCount} commits with actual content differences not in develop. Main must be merged into develop before creating release.`,
        canProceed: false,
      };
    } catch (error) {
      return {
        synchronized: false,
        message: `Failed to verify branch synchronization: ${error}`,
        canProceed: false,
      };
    }
  }

  /**
   * Checkout a branch and pull latest changes
   */
  async checkoutAndPull(branchName: string): Promise<void> {
    try {
      // Check if branch exists locally
      const branches = await this.getBranches();
      const localBranch = branches.find(
        (b) => b.name === branchName && !b.remote
      );

      if (localBranch) {
        await this.execGit(`checkout ${quoteGitArg(branchName)}`);
        await this.pullBranch(branchName);
      } else {
        await this.fetchBranch(branchName);
        const remoteBranch = await this.execGit(
          `rev-parse --verify FETCH_HEAD`
        );
        if (remoteBranch) {
          await this.execGit(
            `checkout -b ${quoteGitArg(branchName)} FETCH_HEAD`
          );
        } else {
          throw new Error(
            `Branch '${branchName}' not found locally or on remote`
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to checkout and pull branch '${branchName}': ${error}`
      );
    }
  }

  /**
   * Check out a new branch at origin's `baseBranch`, as last fetched. A local
   * branch of the same name that origin does not have is replaced: the plan
   * warned about the commits that drops (W14).
   */
  async createBranchFromOrigin(
    branchName: string,
    baseBranch: string
  ): Promise<void> {
    const baseRef = await this.originRef(baseBranch);
    try {
      await this.execGit(
        `checkout -B ${quoteGitArg(branchName)} ${quoteGitArg(baseRef)}`
      );
    } catch (error) {
      throw new Error(
        `Failed to create branch '${branchName}' from ${baseRef}: ${error}`
      );
    }
  }

  /**
   * The newest commit reachable from `ref` whose subject is exactly `subject`, or
   * null. Looks back a thousand commits, far beyond any version bump on a release
   * branch.
   */
  async findCommitWithSubject(
    ref: string,
    subject: string
  ): Promise<string | null> {
    const { stdout, exitCode } = await this.execGitTolerant(
      `log -n 1000 --format=${quoteGitArg("%H %s")} ${quoteGitArg(ref)}`
    );
    if (exitCode !== 0) {
      return null;
    }
    for (const line of stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0 && line.slice(space + 1) === subject) {
        return line.slice(0, space);
      }
    }
    return null;
  }

  /** Create the annotated tag the versioner would, on `commit`. */
  async createVersionTag(tag: string, commit: string): Promise<void> {
    await this.execGit(
      `tag ${quoteGitArg(tag)} -a -m ${quoteGitArg(
        `Release version ${tag}`
      )} ${quoteGitArg(commit)}`
    );
  }

  /** Push one tag to origin, by its full ref so it cannot be read as a branch. */
  async pushTag(tag: string): Promise<void> {
    await this.execGit(`push origin ${quoteGitArg(`refs/tags/${tag}`)}`);
  }

  /** Whether origin has `branchName`, as of the last fetch. */
  async remoteBranchExists(branchName: string): Promise<boolean> {
    return this.refExists(`refs/remotes/origin/${branchName}`);
  }

  /** `refs/remotes/origin/<branch>` when it exists, else the local branch. */
  private async originRef(branchName: string): Promise<string> {
    const remote = `refs/remotes/origin/${branchName}`;
    return (await this.refExists(remote)) ? remote : branchName;
  }

  /**
   * Check out a branch, creating it from origin's when there is no local one.
   * Nothing is fetched or pulled: the remote-tracking ref is what the plan read.
   */
  async checkoutBranch(branchName: string): Promise<void> {
    try {
      if (await this.refExists(`refs/heads/${branchName}`)) {
        await this.execGit(`checkout ${quoteGitArg(branchName)}`);
        return;
      }
      const remote = `refs/remotes/origin/${branchName}`;
      if (!(await this.refExists(remote))) {
        throw new Error(`Branch '${branchName}' not found locally or on origin`);
      }
      await this.execGit(
        `checkout -b ${quoteGitArg(branchName)} ${quoteGitArg(remote)}`
      );
    } catch (error) {
      throw new Error(`Failed to check out branch '${branchName}': ${error}`);
    }
  }

  /**
   * Move the checked-out branch to origin's head, as last fetched. A local branch
   * ahead of or diverged from origin loses its unpushed commits from the branch:
   * origin is the source of truth, and building on them would make the apply do
   * something other than the plan read. `--keep` carries uncommitted changes
   * along, or fails rather than overwrite them.
   *
   * Returns false, changing nothing, when origin has no such branch.
   */
  async resetToOrigin(branchName: string): Promise<boolean> {
    const remote = `refs/remotes/origin/${branchName}`;
    if (!(await this.refExists(remote))) {
      return false;
    }
    try {
      await this.execGit(`reset --keep ${quoteGitArg(remote)}`);
      return true;
    } catch (error) {
      throw new Error(
        `Failed to reset '${branchName}' to origin/${branchName}: ${error}`
      );
    }
  }

  /**
   * Commits on the local `branchName` that `againstRef` does not have, newest
   * first, as `<sha11> <subject>` lines. Empty when either ref is missing.
   */
  async unpushedCommits(
    branchName: string,
    againstRef: string
  ): Promise<string[]> {
    const local = `refs/heads/${branchName}`;
    if (!(await this.refExists(local)) || !(await this.refExists(againstRef))) {
      return [];
    }
    const { stdout, exitCode } = await this.execGitTolerant(
      `log --abbrev=11 --format=${quoteGitArg("%h %s")} ${quoteGitArg(
        againstRef
      )}..${quoteGitArg(local)}`
    );
    if (exitCode !== 0) {
      return [];
    }
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  }

  /**
   * Create a new release branch from the current branch
   */
  async createReleaseBranch(version: string): Promise<string> {
    try {
      const releaseBranchName = `release/${version}`;

      // Check if branch already exists
      const branches = await this.getBranches();
      const existingBranch = branches.find(
        (b) =>
          b.name === releaseBranchName ||
          b.name === `remotes/origin/${releaseBranchName}`
      );

      if (existingBranch) {
        throw new Error(`Release branch '${releaseBranchName}' already exists`);
      }

      // Create the new branch
      await this.execGit(`checkout -b ${releaseBranchName}`);

      return releaseBranchName;
    } catch (error) {
      throw new Error(
        `Failed to create release branch for version '${version}': ${error}`
      );
    }
  }

  /** Push a branch to origin, without a tag. Not forced. */
  async pushBranch(branchName: string): Promise<void> {
    try {
      await this.execGit(`push -u origin ${quoteGitArg(branchName)}`);
    } catch (error) {
      throw new Error(`Failed to push branch '${branchName}': ${error}`);
    }
  }

  /**
   * Push branch and tag to remote
   */
  async pushBranchAndTag(branchName: string, tagName: string): Promise<void> {
    try {
      // Push the branch
      await this.execGit(`push -u origin ${branchName}`);

      // Push the tag
      await this.execGit(`push origin ${tagName}`);
    } catch (error) {
      throw new Error(
        `Failed to push branch '${branchName}' and tag '${tagName}': ${error}`
      );
    }
  }

  /**
   * Create a pull request via the GitHub REST API.
   */
  async createPullRequest(
    branchName: string,
    baseBranch: string = "develop",
    title?: string,
    body?: string,
    draft: boolean = false
  ): Promise<PullRequestResult> {
    const defaultTitle = title || `Release ${branchName} to ${baseBranch}`;
    const defaultBody =
      body ||
      `
## Release Branch

This PR contains the release branch for ${branchName}.

### Changes
- Version bump to release candidate
- Release preparation

---
${autoGeneratedFooter()}
      `.trim();

    const watermarkedBody = wrapWithWatermarks(defaultBody);
    const client = await createGitHubClient(this.workingDirectory);

    try {
      const { data } = await client.rest.pulls.create({
        owner: client.owner,
        repo: client.repo,
        base: baseBranch,
        head: branchName,
        title: defaultTitle,
        body: watermarkedBody,
        draft,
      });
      return { url: data.html_url, action: "created" };
    } catch (error) {
      const message = octokitErrorMessage(error);
      // GitHub returns 422 with "A pull request already exists" when head/base pair already has an open PR.
      if (
        isOctokitStatus(error, 422) &&
        /pull request already exists/i.test(message)
      ) {
        return await this.updateExistingPullRequest(
          branchName,
          baseBranch,
          defaultTitle,
          defaultBody
        );
      }
      throw new Error(`Failed to create pull request: ${message}`);
    }
  }

  /**
   * Find the open pull request for a head/base pair, or null when there is none.
   *
   * Filters on base as well as head: one branch can have several open PRs against
   * different bases, and acting on the wrong one silently rewrites an unrelated PR.
   */
  async findOpenPullRequest(
    branchName: string,
    baseBranch: string
  ): Promise<OpenPullRequest | null> {
    const client = await createGitHubClient(this.workingDirectory);

    try {
      const { data: prs } = await client.rest.pulls.list({
        owner: client.owner,
        repo: client.repo,
        head: `${client.owner}:${branchName}`,
        base: baseBranch,
        state: "open",
      });
      const pr = prs[0];
      if (!pr) {
        return null;
      }
      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        body: pr.body ?? "",
      };
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(
        `Failed to look up existing PR for '${branchName}' → '${baseBranch}': ${msg}`
      );
    }
  }

  /**
   * Every open pull request whose head is `branchName`, whatever its base.
   */
  async findOpenPullRequestsFrom(
    branchName: string
  ): Promise<Array<{ number: number; url: string; base: string }>> {
    const client = await createGitHubClient(this.workingDirectory);

    try {
      const { data: prs } = await client.rest.pulls.list({
        owner: client.owner,
        repo: client.repo,
        head: `${client.owner}:${branchName}`,
        state: "open",
      });
      return prs.map((pr) => ({
        number: pr.number,
        url: pr.html_url,
        base: pr.base.ref,
      }));
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(
        `Failed to look up open PRs from '${branchName}': ${msg}`
      );
    }
  }

  /** Every open pull request into `baseBranch`, with its head branch. */
  async findOpenPullRequestsInto(
    baseBranch: string
  ): Promise<Array<{ number: number; url: string; head: string }>> {
    const client = await createGitHubClient(this.workingDirectory);
    try {
      const prs = await client.rest.paginate(client.rest.pulls.list, {
        owner: client.owner,
        repo: client.repo,
        base: baseBranch,
        state: "open",
        per_page: 100,
      });
      return prs.map((pr) => ({
        number: pr.number,
        url: pr.html_url,
        head: pr.head.ref,
      }));
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(`Failed to look up open PRs into '${baseBranch}': ${msg}`);
    }
  }

  private async updateExistingPullRequest(
    branchName: string,
    baseBranch: string,
    title: string,
    body: string
  ): Promise<PullRequestResult> {
    const existing = await this.findOpenPullRequest(branchName, baseBranch);
    if (!existing) {
      throw new Error(
        `No open PR found for head '${branchName}' into '${baseBranch}'`
      );
    }

    const client = await createGitHubClient(this.workingDirectory);
    const updatedBody = replaceWatermarkedContent(existing.body, body);

    try {
      await client.rest.pulls.update({
        owner: client.owner,
        repo: client.repo,
        pull_number: existing.number,
        title,
        body: updatedBody,
      });
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(`Failed to edit PR #${existing.number}: ${msg}`);
    }

    console.log(`🔄 Updated existing PR #${existing.number}: ${existing.url}`);
    return { url: existing.url, action: "updated" };
  }

  /**
   * Create a GitHub release via the REST API (auto-generated notes).
   *
   * Returns the release URL plus an optional `notesWarning` when GitHub's
   * `generate-notes` API failed or returned an empty body. We retry the
   * notes call with backoff to ride out the indexer lag that occurs when a
   * tag is pushed and a release is created back-to-back. If we still can't
   * get a body, the release is created first and the body is patched in
   * afterwards so the release itself is never blocked.
   */
  /**
   * The GitHub Release published for a tag, or null when there is none.
   *
   * A 404 is the ordinary answer for an RC, which is never released, so it is
   * reported rather than thrown.
   */
  async getGitHubRelease(
    tag: string
  ): Promise<{ id: number; url: string; name: string } | null> {
    const client = await createGitHubClient(this.workingDirectory);
    try {
      const { data } = await client.rest.repos.getReleaseByTag({
        owner: client.owner,
        repo: client.repo,
        tag,
      });
      return { id: data.id, url: data.html_url, name: data.name ?? tag };
    } catch (error) {
      if (isOctokitStatus(error, 404)) {
        return null;
      }
      throw new Error(
        `Failed to look up the GitHub release for ${tag}: ${octokitErrorMessage(
          error
        )}`
      );
    }
  }

  /**
   * Delete a GitHub Release.
   *
   * This destroys its notes, which a human may have edited, and moves the
   * `Latest` marker to the previous release. Callers must have said so in a plan
   * first.
   */
  async deleteGitHubRelease(releaseId: number): Promise<void> {
    const client = await createGitHubClient(this.workingDirectory);
    try {
      await client.rest.repos.deleteRelease({
        owner: client.owner,
        repo: client.repo,
        release_id: releaseId,
      });
    } catch (error) {
      throw new Error(
        `Failed to delete GitHub release ${releaseId}: ${octokitErrorMessage(
          error
        )}`
      );
    }
  }

  async createGitHubRelease(
    version: string,
    branchName: string
  ): Promise<{ url: string; notesWarning?: string }> {
    const client = await createGitHubClient(this.workingDirectory);
    const title = `Release ${version}`;

    const { body: notesBody, warning: notesWarning } =
      await this.generateReleaseNotesWithRetry(version, branchName);

    let releaseUrl: string;
    let releaseId: number;
    try {
      const { data: release } = await client.rest.repos.createRelease({
        owner: client.owner,
        repo: client.repo,
        tag_name: version,
        name: title,
        target_commitish: branchName,
        body: notesBody,
      });
      releaseUrl = release.html_url;
      releaseId = release.id;
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(`Failed to create GitHub release: ${msg}`);
    }

    // If we couldn't get notes before creating the release, try once more
    // now that the release object (and its tag reference) exists, then
    // patch the body in. This handles the case where GitHub's PR indexer
    // hadn't caught up at create time.
    if (!notesBody) {
      const retry = await this.generateReleaseNotesWithRetry(
        version,
        branchName
      );
      if (retry.body) {
        try {
          await client.rest.repos.updateRelease({
            owner: client.owner,
            repo: client.repo,
            release_id: releaseId,
            body: retry.body,
          });
          return { url: releaseUrl };
        } catch (error) {
          const msg = octokitErrorMessage(error);
          return {
            url: releaseUrl,
            notesWarning: `Failed to patch release notes after creation: ${msg}`,
          };
        }
      }
      return {
        url: releaseUrl,
        notesWarning:
          retry.warning ??
          notesWarning ??
          "GitHub returned empty release notes — generate them manually from the release page.",
      };
    }

    return { url: releaseUrl };
  }

  /**
   * Call `generateReleaseNotes` with retry/backoff. Returns the body and an
   * optional warning describing the last failure when no body was obtained.
   */
  private async generateReleaseNotesWithRetry(
    version: string,
    branchName: string,
    attempts: number = 3
  ): Promise<{ body: string; warning?: string }> {
    const client = await createGitHubClient(this.workingDirectory);
    let lastWarning: string | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        const { data: notes } = await client.rest.repos.generateReleaseNotes({
          owner: client.owner,
          repo: client.repo,
          tag_name: version,
          target_commitish: branchName,
        });
        if (notes.body && notes.body.trim().length > 0) {
          return { body: notes.body };
        }
        lastWarning = `GitHub returned empty release notes for ${version} on ${branchName} (attempt ${i + 1}/${attempts}).`;
        console.warn(`⚠️  ${lastWarning}`);
      } catch (error) {
        const msg = octokitErrorMessage(error);
        lastWarning = `generateReleaseNotes failed (attempt ${i + 1}/${attempts}): ${msg}`;
        console.warn(`⚠️  ${lastWarning}`);
      }
      if (i < attempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, i))
        );
      }
    }
    return lastWarning ? { body: "", warning: lastWarning } : { body: "" };
  }

  /**
   * Return the list of files currently in a conflicted/unmerged state.
   */
  private async getConflictedFiles(): Promise<string[]> {
    try {
      const output = await this.execGit(
        "diff --name-only --diff-filter=U"
      );
      return output.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Probe whether merging `sourceBranch` into `baseBranch` would produce conflicts,
   * without leaving anything in the working tree afterwards.
   */
  async detectMergeConflicts(
    baseBranch: string,
    sourceBranch: string
  ): Promise<MergeConflictProbe> {
    // The cleanup below moves HEAD, so refuse to probe over tracked local changes.
    // validateNoStagedChanges covers only staged files; unstaged edits would be lost.
    // Untracked files are safe — `reset --hard` leaves them alone.
    const preStatus = await this.getStatus();
    const dirty = [...preStatus.staged, ...preStatus.modified];
    if (dirty.length > 0) {
      throw new Error(
        `Refusing to probe for merge conflicts with tracked changes in the working tree, ` +
          `because cleanup would discard them: ${dirty.join(", ")}. Commit or stash first.`
      );
    }

    await this.checkoutAndPull(baseBranch);
    const headBefore = await this.getCurrentCommit();

    let mergeFailed = false;
    try {
      await this.execGit(
        `merge --no-commit --no-ff ${quoteGitArg(sourceBranch)}`
      );
    } catch {
      mergeFailed = true;
    }

    const conflictedFiles = await this.getConflictedFiles();

    try {
      await this.execGit("merge --abort");
    } catch {
      // No merge in progress — fast-forward, or the merge failed before starting.
    }

    // Rewind only if the probe actually moved HEAD. The previous unconditional
    // `reset --hard origin/<base>` discarded any local commits on the base branch.
    const headAfter = await this.getCurrentCommit();
    if (headAfter !== headBefore) {
      await this.execGit(`reset --hard ${quoteGitArg(headBefore)}`);
    }

    // A failed merge with no unmerged paths is not a conflict — it is some other
    // error (dirty tree, bad ref, unrelated histories). Reporting it as "no
    // conflicts" sent callers down the clean-merge path on a broken repository.
    if (mergeFailed && conflictedFiles.length === 0) {
      throw new Error(
        `Merge probe of '${sourceBranch}' into '${baseBranch}' failed without producing ` +
          `conflicts, so this is not a conflict condition. Inspect the repository state ` +
          `before retrying.`
      );
    }

    return {
      hasConflicts: conflictedFiles.length > 0,
      conflictedFiles,
    };
  }

  /**
   * Read the version at a ref — the first line of its VERSION file — or null when
   * the file is missing or unparseable. Takes a branch name or a commit sha.
   *
   * Branch names never carry the RC suffix, so this is the only source of truth for
   * whether a branch currently holds a release candidate.
   */
  async readBranchVersion(
    ref: string,
    prefer: "local" | "remote" = "local"
  ): Promise<string | null> {
    const cleanRef = ref.replace(/^remotes\/origin\//, "");
    const candidates =
      prefer === "remote"
        ? [`origin/${cleanRef}`, cleanRef]
        : [cleanRef, `origin/${cleanRef}`];

    for (const candidate of candidates) {
      try {
        const content = await this.readFileFromBranch(candidate, "VERSION");
        const firstLine = content.split("\n")[0]?.trim() ?? "";
        if (/^\d+\.\d+\.\d+/.test(firstLine)) {
          return firstLine;
        }
      } catch {
        // Try the next candidate: the ref may not exist on this side.
      }
    }
    return null;
  }

  /** Classify a version string, treating an unreadable VERSION as a non-claim. */
  private static versionKind(version: string | null): VersionKind {
    if (version === null) {
      return "unknown";
    }
    return version.includes("-RC.") ? "rc" : "final";
  }

  /**
   * Predict whether merging `sourceRef` into `baseRef` would conflict, touching
   * nothing.
   *
   * `merge-tree --write-tree` merges in memory and writes only to the object
   * database, so unlike detectMergeConflicts this is safe to call while building a
   * plan: no checkout, no index change, no working-tree change. It exits 1 to
   * report conflicts, which is a result rather than a failure.
   *
   * Output shape is a tree OID, then the conflicted paths, then a blank line,
   * then informational messages.
   */
  async previewMergeConflicts(
    baseRef: string,
    sourceRef: string
  ): Promise<MergeConflictProbe> {
    const { stdout, stderr, exitCode } = await this.execGitTolerant(
      `merge-tree --write-tree --name-only ${quoteGitArg(
        baseRef
      )} ${quoteGitArg(sourceRef)}`
    );

    if (exitCode === 0) {
      return { hasConflicts: false, conflictedFiles: [] };
    }

    const lines = stdout.split("\n");
    const treeOid = lines[0]?.trim() ?? "";

    // merge-tree exits 1 both for genuine conflicts and for errors such as an
    // unknown ref, differing only in that a real conflict still writes the merged
    // tree OID to stdout. Without this check an unmergeable ref would be reported
    // as a clean merge.
    if (exitCode > 1 || !/^[0-9a-f]{40,64}$/.test(treeOid)) {
      throw new Error(
        `Could not compare '${sourceRef}' with '${baseRef}': git merge-tree exited ${exitCode}` +
          `${stderr ? ` — ${stderr}` : ""}. Check that both refs exist and share history.`
      );
    }

    const conflictedFiles: string[] = [];
    // Conflicted paths follow the tree OID, terminated by a blank line.
    for (const line of lines.slice(1)) {
      if (line.trim() === "") break;
      conflictedFiles.push(line.trim());
    }

    return { hasConflicts: conflictedFiles.length > 0, conflictedFiles };
  }

  /**
   * Resolve a ref to its commit sha without checking anything out. Prefers the
   * remote-tracking ref when the branch exists on origin, since that is the state a
   * push would race against.
   */
  async getBranchHead(branchName: string): Promise<string> {
    const clean = branchName.replace(/^remotes\/origin\//, "");
    for (const ref of [`origin/${clean}`, clean]) {
      try {
        return await this.execGit(`rev-parse ${quoteGitArg(ref)}`);
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error(`Could not resolve a commit for branch '${clean}'`);
  }

  async tagExistsLocally(tag: string): Promise<boolean> {
    try {
      const out = await this.execGit(`tag --list ${quoteGitArg(tag)}`);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Delete a tag locally. Absent is a result, not a failure: a revert should not
   * abort because the thing it wanted gone was already gone.
   *
   * Returns whether a tag was actually removed.
   */
  async deleteTagLocally(tag: string): Promise<boolean> {
    const { exitCode } = await this.execGitTolerant(
      `tag -d ${quoteGitArg(tag)}`
    );
    return exitCode === 0;
  }

  /**
   * Delete a tag on origin. Absent is a result, not a failure; a deletion origin
   * rejects is a failure.
   *
   * The refspec form is deliberate: `push origin :refs/tags/<tag>` cannot be
   * misread as a branch, which `push --delete origin <tag>` can when a branch and
   * a tag share a name.
   *
   * Returns whether a tag was removed. Throws RemoteDeletionRefused when origin
   * still has the tag afterwards, as a protection rule or a pre-receive hook
   * leaves it.
   */
  async deleteTagRemotely(tag: string): Promise<boolean> {
    return this.deleteRemoteRef(`refs/tags/${tag}`);
  }

  /** Delete a branch on origin, verified as deleteTagRemotely is. */
  async deleteRemoteBranch(branchName: string): Promise<boolean> {
    return this.deleteRemoteRef(`refs/heads/${branchName}`);
  }

  /**
   * Push the deletion of `ref`, then ask origin whether it is gone: a non-zero
   * push is ambiguous between "already absent" and "refused", and only origin can
   * say which.
   */
  private async deleteRemoteRef(ref: string): Promise<boolean> {
    const { exitCode, stderr } = await this.execGitTolerant(
      `push origin ${quoteGitArg(`:${ref}`)}`
    );
    if (await this.remoteRefExists(ref)) {
      throw new RemoteDeletionRefused(ref, stderr);
    }
    return exitCode === 0;
  }

  /**
   * Whether origin has exactly `ref`, asked live. Unlike tagExistsRemotely this
   * throws when origin cannot be asked, because callers use it to confirm a
   * deletion and an unanswered question is not a "no".
   */
  async remoteRefExists(ref: string): Promise<boolean> {
    const out = await this.execGit(`ls-remote origin ${quoteGitArg(ref)}`);
    return out
      .split("\n")
      .some((line) => line.split(/\s+/)[1] === ref);
  }

  /**
   * Delete a branch locally, refusing to delete the one checked out. Returns
   * whether one was removed; throws when the branch is still there afterwards.
   */
  async deleteLocalBranch(branchName: string): Promise<boolean> {
    const { exitCode, stderr } = await this.execGitTolerant(
      `branch -D ${quoteGitArg(branchName)}`
    );
    if (await this.refExists(`refs/heads/${branchName}`)) {
      throw new Error(
        `Could not delete the local branch ${branchName}: ${stderr}`
      );
    }
    return exitCode === 0;
  }

  /** Subject line of a commit — the first line of its message. */
  async commitSubject(ref: string): Promise<string> {
    return this.execGit(
      `log -1 --no-merges --pretty=format:%s ${quoteGitArg(ref)}`
    );
  }

  /**
   * Commits reachable from `branch` but not from `base`, newest first, as
   * `<sha> <subject>` lines.
   *
   * Used to decide whether abandoning a release branch would destroy work: a
   * branch holding only its version bump is disposable, one holding merged fixes
   * is not.
   */
  async commitsNotIn(branch: string, base: string): Promise<string[]> {
    const { stdout, exitCode } = await this.execGitTolerant(
      `rev-list --no-merges --pretty=oneline --abbrev-commit ${quoteGitArg(
        base
      )}..${quoteGitArg(branch)}`
    );
    if (exitCode !== 0 || stdout.length === 0) {
      return [];
    }
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  }

  /**
   * Revert a commit, producing a new commit rather than rewriting history —
   * protected branches commonly forbid the force-push a reset would need.
   *
   * A conflicting revert is aborted rather than left half-applied in the index.
   */
  async revertCommit(sha: string): Promise<void> {
    const { exitCode, stderr, stdout } = await this.execGitTolerant(
      `revert --no-edit ${quoteGitArg(sha)}`
    );
    if (exitCode === 0) {
      return;
    }
    await this.execGitTolerant("revert --abort");
    throw new MergeConflictError(
      `Reverting ${sha.slice(0, 11)} conflicts with the current state of the ` +
        `branch, so it was aborted and nothing was changed. Resolve by hand.` +
        `\n${stderr || stdout}`,
      []
    );
  }

  /** Whether a ref resolves locally. Creates nothing and contacts no remote. */
  async refExists(ref: string): Promise<boolean> {
    try {
      await this.execGit(`rev-parse --verify --quiet ${quoteGitArg(ref)}`);
      return true;
    } catch {
      return false;
    }
  }

  async tagExistsRemotely(tag: string): Promise<boolean> {
    try {
      const out = await this.execGit(
        `ls-remote --tags origin ${quoteGitArg(`refs/tags/${tag}`)}`
      );
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Enumerate every release and hotfix branch with the facts needed to choose one
   * deliberately. Strictly read-only: no checkout, no fetch, no mutation.
   */
  async listVersions(
    productionBranch: string = "main"
  ): Promise<VersionListing> {
    const status = await this.getStatus();
    const branches = [
      ...(await this.findBranchesOfType("release")),
      ...(await this.findBranchesOfType("hotfix")),
    ];

    const entries: VersionListingEntry[] = [];
    for (const branch of branches) {
      const cleanName = branch.name.replace(/^remotes\/origin\//, "");

      // Report what origin holds: this listing describes the shared state, and a
      // branch discovered by ls-remote may have no local ref to read at all.
      const version = await this.readBranchVersion(cleanName, "remote");
      const localVersion = await this.readBranchVersion(cleanName, "local");

      // Ancestry must be asked of a ref that exists, or git errors and the failure
      // is indistinguishable from "not merged".
      const ancestryRef = (await this.refExists(`origin/${cleanName}`))
        ? `origin/${cleanName}`
        : cleanName;

      entries.push({
        branch: cleanName,
        type: branch.type,
        version,
        kind: GitFlowManager.versionKind(version),
        isCurrentBranch: cleanName === status.currentBranch,
        tagExistsLocally: version ? await this.tagExistsLocally(version) : false,
        tagExistsRemotely: version
          ? await this.tagExistsRemotely(version)
          : false,
        mergedIntoProduction: await this.checkIsAncestor(
          ancestryRef,
          `origin/${productionBranch}`
        ),
        staleLocal: localVersion !== null && localVersion !== version,
      });
    }

    entries.sort((a, b) => {
      if (a.isCurrentBranch !== b.isCurrentBranch) {
        return a.isCurrentBranch ? -1 : 1;
      }
      return (b.version ?? "").localeCompare(a.version ?? "", undefined, {
        numeric: true,
      });
    });

    return { currentBranch: status.currentBranch, productionBranch, entries };
  }

  /**
   * Create a new branch off origin's `baseBranch`, merge origin's `sourceBranch`
   * into it, push.
   *
   * Both sides are the remote-tracking refs the plan fetched, never local
   * branches: the pull request then carries exactly what the plan previewed, and
   * no commit that only this clone has reaches origin through it.
   *
   * When the merge conflicts, throws a MergeConflictError after aborting the
   * merge and removing the local branch, so nothing reaches the remote.
   */
  async createMergeBranch(opts: {
    baseBranch: string;
    sourceBranch: string;
    branchName: string;
    mergeCommitMessage?: string;
  }): Promise<MergeBranchResult> {
    const { baseBranch, sourceBranch, branchName } = opts;
    const mergeMessage =
      opts.mergeCommitMessage || `Merge ${sourceBranch} into ${baseBranch}`;
    const baseRef = await this.originRef(baseBranch);
    const sourceRef = await this.originRef(sourceBranch);

    await this.execGit(
      `checkout -b ${quoteGitArg(branchName)} ${quoteGitArg(baseRef)}`
    );

    let mergeFailed = false;
    try {
      await this.execGit(
        `merge --no-ff -m ${quoteGitArg(mergeMessage)} ${quoteGitArg(sourceRef)}`
      );
    } catch {
      mergeFailed = true;
    }

    if (!mergeFailed) {
      // `merge --no-ff` of a commit already reachable from the base reports
      // "Already up to date" and creates nothing, leaving a branch identical to
      // the base. Pushing it would put an empty branch on origin and GitHub would
      // then refuse the pull request for having no commits, so refuse here while
      // the only thing to undo is local.
      const sha = await this.getCurrentCommit();
      const baseSha = await this.execGit(`rev-parse ${quoteGitArg(baseRef)}`);
      if (sha === baseSha) {
        await this.discardLocalBranch(branchName, baseBranch);
        throw new Error(
          `${sourceBranch} is already merged into ${baseBranch}, so the merge ` +
            `produced no commit. Nothing was pushed and no pull request was opened.`
        );
      }

      await this.execGit(`push -u origin ${quoteGitArg(branchName)}`);
      return { sha, branchName };
    }

    const conflictedFiles = await this.getConflictedFiles();
    try {
      await this.execGit("merge --abort");
    } catch {
      /* ignore */
    }
    await this.discardLocalBranch(branchName, baseBranch);
    throw new MergeConflictError(
      `Merge of ${sourceBranch} into ${baseBranch} produced conflicts in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`,
      conflictedFiles
    );
  }

  /**
   * Return to `baseBranch` and delete a local-only merge branch, so an abandoned
   * merge leaves the repository as it was found. Each step is best-effort: the
   * caller is already reporting a failure and must not have it masked by another.
   */
  private async discardLocalBranch(
    branchName: string,
    baseBranch: string
  ): Promise<void> {
    try {
      await this.checkoutBranch(baseBranch);
    } catch {
      /* ignore */
    }
    try {
      await this.execGit(`branch -D ${quoteGitArg(branchName)}`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Close a pull request, optionally with a closing comment.
   */
  async closePullRequest(
    prNumber: number,
    opts: { comment?: string } = {}
  ): Promise<void> {
    const client = await createGitHubClient(this.workingDirectory);
    if (opts.comment && opts.comment.length > 0) {
      await client.rest.issues.createComment({
        owner: client.owner,
        repo: client.repo,
        issue_number: prNumber,
        body: opts.comment,
      });
    }
    await client.rest.pulls.update({
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      state: "closed",
    });
  }

  /**
   * Close the open `sourceBranch` → `baseBranch` pull request that a merge-branch
   * downmerge replaces, so the base only ever has one open pull request carrying
   * the release or hotfix.
   *
   * The two are different head/base pairs — one heads on the release or hotfix
   * branch, the other on a merge branch — so GitHub keeps them as separate pull
   * requests and neither closes the other. The direct one is the one that has to
   * go: a hotfix's is the unmergeable draft placeholder, and a release's into main
   * is the one release_version opened before the merge branch existed.
   *
   * Never fatal. By the time this runs the replacement exists, which is the
   * outcome that matters; a failure is returned for the caller to report.
   */
  async closeSupersededPullRequest(
    sourceBranch: string,
    baseBranch: string,
    replacementUrl: string
  ): Promise<SupersededPullRequest | undefined> {
    const kind = sourceBranch.startsWith("hotfix/") ? "hotfix" : "release";
    let open: OpenPullRequest | null;
    try {
      open = await this.findOpenPullRequest(sourceBranch, baseBranch);
    } catch (error) {
      return {
        head: sourceBranch,
        base: baseBranch,
        error: octokitErrorMessage(error),
      };
    }
    if (!open) {
      return undefined;
    }
    const found = {
      head: sourceBranch,
      base: baseBranch,
      number: open.number,
      url: open.url,
    };
    try {
      await this.closePullRequest(open.number, {
        comment:
          `Superseded by ${replacementUrl}. It brings this ${kind} into ` +
          `${baseBranch} through a merge branch, so ${baseBranch} has one open ` +
          `pull request for the ${kind} rather than two.`,
      });
      console.log(`✅ Closed superseded PR #${open.number}`);
      return found;
    } catch (error) {
      const message = octokitErrorMessage(error);
      console.warn(
        `⚠️  Could not close the superseded ${sourceBranch} → ${baseBranch} ` +
          `PR #${open.number}: ${message}`
      );
      return { ...found, error: message };
    }
  }

  /**
   * Check if the working directory is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.execGit("rev-parse --git-dir");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current commit hash
   */
  async getCurrentCommit(): Promise<string> {
    return this.execGit("rev-parse HEAD");
  }

  /**
   * Get latest tag
   */
  async getLatestTag(): Promise<string | null> {
    try {
      const tag = await this.execGit("describe --tags --abbrev=0");
      return tag;
    } catch {
      return null;
    }
  }

  /**
   * Detect branch type from branch name pattern
   */
  detectBranchType(branchName: string): BranchType | null {
    // Remove remotes/origin/ prefix if present
    const cleanBranchName = branchName.replace(/^remotes\/origin\//, "");

    if (/^release\/\d+\.\d+\.\d+$/.test(cleanBranchName)) {
      return "release";
    }

    if (/^hotfix\/\d+\.\d+\.\d+$/.test(cleanBranchName)) {
      return "hotfix";
    }

    return null;
  }

  /**
   * Get base branch for a given branch type
   */
  getBaseBranch(branchType: BranchType): "develop" | "main" {
    return branchType === "release" ? "develop" : "main";
  }

  /**
   * Get target branch for PRs based on branch type
   */
  getTargetBranch(branchType: BranchType): "develop" | "main" {
    return branchType === "release" ? "develop" : "main";
  }

  /**
   * Parse version from branch name
   */
  private parseVersionFromBranch(
    branchName: string
  ): { major: number; minor: number; patch: number; full: string } | null {
    const cleanBranchName = branchName.replace(/^remotes\/origin\//, "");
    const match = cleanBranchName.match(
      /^(release|hotfix)\/(\d+)\.(\d+)\.(\d+)(-RC\.\d+)?$/
    );

    if (!match) {
      return null;
    }

    const [, , majorStr, minorStr, patchStr, rcSuffix] = match;
    const major = parseInt(majorStr || "0", 10);
    const minor = parseInt(minorStr || "0", 10);
    const patch = parseInt(patchStr || "0", 10);
    const full = `${major}.${minor}.${patch}${rcSuffix || ""}`;

    return { major, minor, patch, full };
  }

  /**
   * Find branches of a specific type and return with version info
   */
  async findBranchesOfType(branchType: BranchType): Promise<BranchTypeInfo[]> {
    try {
      const localBranches = (await this.getBranches()).filter(
        (branch) => !branch.remote
      );
      const remoteBranches = await this.getRemoteBranchesOfType(branchType);
      const branches = [...localBranches, ...remoteBranches];
      const typedBranches: BranchTypeInfo[] = [];
      const seenBranches = new Set<string>();

      for (const branch of branches) {
        const detectedType = this.detectBranchType(branch.name);
        if (detectedType === branchType) {
          const version = this.parseVersionFromBranch(branch.name);
          if (version) {
            const cleanName = branch.name.replace(/^remotes\/origin\//, "");
            if (seenBranches.has(cleanName)) {
              continue;
            }
            seenBranches.add(cleanName);

            typedBranches.push({
              name: branch.name,
              type: branchType,
              version,
              baseBranch: this.getBaseBranch(branchType),
              targetBranch: this.getTargetBranch(branchType),
            });
          }
        }
      }

      return typedBranches;
    } catch (error) {
      throw new Error(`Failed to find ${branchType} branches: ${error}`);
    }
  }

  /**
   * Find the latest branch of a specific type by semantic version
   */
  async findLatestBranch(
    branchType: BranchType
  ): Promise<BranchTypeInfo | null> {
    try {
      const branches = await this.findBranchesOfType(branchType);

      if (branches.length === 0) {
        return null;
      }

      // Sort by semantic version descending (major, minor, patch)
      branches.sort((a, b) => {
        if (a.version.major !== b.version.major) {
          return b.version.major - a.version.major;
        }
        if (a.version.minor !== b.version.minor) {
          return b.version.minor - a.version.minor;
        }
        return b.version.patch - a.version.patch;
      });

      return branches[0] || null;
    } catch (error) {
      throw new Error(`Failed to find latest ${branchType} branch: ${error}`);
    }
  }

  /**
   * Validate branch version against its base branch
   */
  /**
   * Check that a branch's version is not behind its base branch.
   *
   * Reads both versions straight out of the branches with `git show`, so this
   * performs no checkout and is safe to call while planning. The comparison is on
   * major/minor/patch only; the RC suffix is deliberately ignored, since an RC of
   * the same patch level as the base is valid.
   */
  async validateBranchVersion(
    branchInfo: BranchTypeInfo
  ): Promise<BranchVersionValidation> {
    try {
      const baseBranchVersion = await this.readBranchVersion(
        branchInfo.baseBranch,
        "remote"
      );

      if (!baseBranchVersion) {
        return {
          valid: false,
          behind: false,
          baseVersion: null,
          message: `Could not read version from ${branchInfo.baseBranch} branch VERSION file`,
        };
      }

      const baseVersionMatch = baseBranchVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!baseVersionMatch) {
        return {
          valid: false,
          behind: false,
          baseVersion: baseBranchVersion,
          message: `Invalid version format in ${branchInfo.baseBranch} branch: ${baseBranchVersion}`,
        };
      }

      const [, baseMajorStr, baseMinorStr, basePatchStr] = baseVersionMatch;
      const baseMajor = parseInt(baseMajorStr || "0", 10);
      const baseMinor = parseInt(baseMinorStr || "0", 10);
      const basePatch = parseInt(basePatchStr || "0", 10);

      const branchVersion = branchInfo.version;
      const atOrAhead =
        branchVersion.major > baseMajor ||
        (branchVersion.major === baseMajor && branchVersion.minor > baseMinor) ||
        (branchVersion.major === baseMajor &&
          branchVersion.minor === baseMinor &&
          branchVersion.patch >= basePatch);

      return atOrAhead
        ? {
            valid: true,
            behind: false,
            baseVersion: baseBranchVersion,
            message: `${branchInfo.name} version ${branchVersion.full} is valid against ${branchInfo.baseBranch} version ${baseBranchVersion}`,
          }
        : {
            valid: false,
            behind: true,
            baseVersion: baseBranchVersion,
            message: `${branchInfo.name} version ${branchVersion.full} is behind ${branchInfo.baseBranch} version ${baseBranchVersion}. Cannot proceed with increment.`,
          };
    } catch (error) {
      return {
        valid: false,
        behind: false,
        baseVersion: null,
        message: `Failed to validate branch version: ${error}`,
      };
    }
  }

  /**
   * Downmerge main into develop via a merge branch and a pull request.
   */
  async downmergeMainToDevelop(): Promise<DownmergeResult> {
    try {
      // Nothing is fetched or pulled: the plan fetched origin, and the merge branch
      // is cut from the remote-tracking refs it read.
      const timestamp = Math.floor(Date.now() / 1000);
      const branchName = `main-into-develop-${timestamp}`;

      // Read the title before creating any commits, so a merge commit of our own
      // cannot become the subject it is derived from.
      const { title: prTitle, version: detectedVersion } =
        await this.describeMainDownmerge();

      // Branch off develop, merge main in, push. Delegated to
      // createMergeBranch so a conflict aborts the merge, deletes the temporary
      // branch, and returns to develop, instead of leaving the repository stranded
      // mid-merge with an unresolved index.
      await this.createMergeBranch({
        baseBranch: "develop",
        sourceBranch: "main",
        branchName,
        mergeCommitMessage: "Downmerge main into develop",
      });
      console.log(`✅ Created and pushed merge branch: ${branchName}`);

      const versionLine = detectedVersion
        ? `- **Version**: ${detectedVersion}`
        : "";

      const prBody = `## Downmerge Main to Develop

This PR merges the latest changes from main into develop to keep develop up to date.

### 📋 Downmerge Information
- **Source**: \`main\`
- **Target**: \`develop\`
${versionLine}

### 🔄 Changes
- Merge all commits from main into a temporary branch off develop
- Open PR targeting develop
- Keeps develop synchronized with production changes

---
${autoGeneratedFooter()}`;

      const prResult = await this.createPullRequest(
        branchName,
        "develop",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      return {
        kind: "merge-branch",
        pullRequestUrl: prResult.url,
        mergeBranchName: branchName,
      };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge main to develop: ${error}`);
    }
  }

  /**
   * Read a file at a ref, or null when the ref has no such file.
   */
  async readFileAtRef(ref: string, filePath: string): Promise<string | null> {
    const { stdout, exitCode } = await this.execGitTolerant(
      `show ${quoteGitArg(`${ref}:${filePath}`)}`
    );
    return exitCode === 0 ? stdout : null;
  }

  /**
   * Check out `commit` into a temporary detached worktree for the length of `fn`,
   * then remove it. Leaves the working directory and its branch untouched.
   */
  async withDetachedWorktree<T>(
    commit: string,
    fn: (dir: string) => Promise<T>
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "release-check-"));
    await execAsync(
      `git worktree add --detach ${quoteGitArg(dir)} ${quoteGitArg(commit)}`,
      { cwd: this.workingDirectory, timeout: WORKTREE_TIMEOUT_MS }
    );
    try {
      return await fn(dir);
    } finally {
      await this.execGitTolerant(`worktree remove --force ${quoteGitArg(dir)}`);
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Read file content from a specific branch
   */
  async readFileFromBranch(
    branchName: string,
    filePath: string
  ): Promise<string> {
    try {
      const stdout = await this.execGit(`show ${branchName}:${filePath}`);
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to read ${filePath} from branch ${branchName}: ${error}`
      );
    }
  }

  /**
   * Resolve the branch a downmerge acts on — either by version or the newest of
   * that type. Returns the BranchTypeInfo plus its clean ref name (without the
   * remotes/origin/ prefix). Read-only, so a plan and an apply can share it.
   */
  async resolveDownmergeBranch(
    branchType: BranchType,
    version: string | undefined
  ): Promise<{ branch: BranchTypeInfo; cleanName: string }> {
    let branch: BranchTypeInfo;
    if (version) {
      const selector = parseVersionSelector(version);
      const branches =
        selector.type === undefined || selector.type === branchType
          ? await this.findBranchesOfType(branchType)
          : [];
      const match = branches.find((b) => b.version.full === selector.version);
      if (!match) {
        const label = branchType === "release" ? "Release" : "Hotfix";
        throw new Error(`${label} branch for version ${version} not found`);
      }
      branch = match;
    } else {
      const latest = await this.findLatestBranch(branchType);
      if (!latest) {
        throw new Error(`No ${branchType} branches found`);
      }
      branch = latest;
    }
    const cleanName = branch.name.replace(/^remotes\/origin\//, "");
    return { branch, cleanName };
  }

  /**
   * Title for a main → develop pull request, and the version it names.
   *
   * Taken from main's newest non-merge commit subject: `To version <v>` names the
   * release that reached production, anything else is a plain downmerge.
   * Read-only.
   */
  async describeMainDownmerge(): Promise<{
    title: string;
    version: string | undefined;
  }> {
    try {
      const subject = await this.execGit(
        "log -1 --no-merges --pretty=format:%s origin/main"
      );
      const match = subject.match(/^To version (.+)$/);
      if (match?.[1]) {
        return { title: `Release ${match[1]} to develop`, version: match[1] };
      }
    } catch {
      console.warn(
        "Could not determine last commit message, using default title"
      );
    }
    return { title: "Downmerge main into develop", version: undefined };
  }

  /**
   * Downmerge release → develop: a direct PR release/X.Y.0 → develop. A conflict
   * throws MergeConflictError before anything is pushed or opened.
   */
  async downmergeReleaseToDevelop(version?: string): Promise<DownmergeResult> {
    try {
      const { branch, cleanName } = await this.resolveDownmergeBranch(
        "release",
        version
      );
      console.log(
        `📋 Using release branch: ${cleanName} (${branch.version.full})`
      );

      await this.checkoutAndPull("develop");
      await this.checkoutAndPull(cleanName);

      const probe = await this.detectMergeConflicts("develop", cleanName);

      if (!probe.hasConflicts) {
        const prTitle = `Release ${branch.version.full} to develop`;
        const prBody = `## Release ${branch.version.full} to develop

This PR merges the release branch back into develop.

### 📋 Release Information
- **Version**: ${branch.version.full}
- **Branch**: ${cleanName}
- **Target**: develop
- **Type**: release

---
${autoGeneratedFooter()}`;

        const prResult = await this.createPullRequest(
          cleanName,
          "develop",
          prTitle,
          prBody
        );
        const verb = prResult.action === "updated" ? "Updated" : "Created";
        console.log(`✅ ${verb} pull request: ${prResult.url}`);
        return { kind: "direct", pullRequestUrl: prResult.url };
      }

      throw new MergeConflictError(
        `Merge of ${cleanName} into develop produced conflicts in ` +
          `${probe.conflictedFiles.length} file(s): ${probe.conflictedFiles.join(", ")}`,
        probe.conflictedFiles
      );
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge release to develop: ${error}`);
    }
  }

  /**
   * Downmerge release → main via a merge branch.
   *
   * Always creates a merge branch (off main, release merged in) and opens
   * the PR from there — never directly from `release/*` — because the latter
   * would re-trigger CI workflows that build a fresh Docker image for a
   * release whose artifact was already cut.
   *
   * If the merge produces conflicts, aborts cleanly and surfaces a
   * MergeConflictError naming the conflicted files. No remote branch or PR
   * is created in that case.
   */
  async downmergeReleaseToMain(version?: string): Promise<DownmergeResult> {
    try {
      const { branch, cleanName } = await this.resolveDownmergeBranch(
        "release",
        version
      );
      console.log(
        `📋 Using release branch: ${cleanName} (${branch.version.full})`
      );

      const timestamp = Math.floor(Date.now() / 1000);
      const mergeBranchName = `release-${branch.version.full}-into-main-${timestamp}`;

      const mergeResult = await this.createMergeBranch({
        baseBranch: "main",
        sourceBranch: cleanName,
        branchName: mergeBranchName,
        mergeCommitMessage: `Merge ${cleanName} into main`,
      });

      const prTitle = `Release ${branch.version.full} to main`;
      const prBody = `## Release ${branch.version.full} to main

${productionMergeWarning("release")}

This PR merges the release branch into main via a merge branch (\`${mergeBranchName}\`). The merge branch is used instead of a direct release/* head so CI workflows that build the release artifact do not re-trigger.

### 📋 Release Information
- **Version**: ${branch.version.full}
- **Source**: ${cleanName}
- **Target**: main
- **Merge branch**: ${mergeBranchName}

---
${autoGeneratedFooter()}`;

      const prResult = await this.createPullRequest(
        mergeResult.branchName,
        "main",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      const superseded = await this.closeSupersededPullRequest(
        cleanName,
        "main",
        prResult.url
      );

      return {
        kind: "merge-branch",
        pullRequestUrl: prResult.url,
        mergeBranchName: mergeResult.branchName,
        ...(superseded ? { superseded } : {}),
      };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge release to main: ${error}`);
    }
  }

  /**
   * Downmerge hotfix → develop via a merge branch.
   *
   * Reconciles develop with a fix that went to production through main. The
   * merge branch is cut off develop with the hotfix merged in, so the pull
   * request head is never `hotfix/*` and CI workflows keyed on that head do not
   * rebuild an already-deployed hotfix.
   *
   * A conflict throws MergeConflictError before anything is pushed or opened.
   *
   * No build-trigger pull request: the hotfix has already been deployed, so
   * re-firing CI on a `hotfix/*` head has nothing to build.
   */
  async downmergeHotfixToDevelop(version?: string): Promise<DownmergeResult> {
    try {
      const { branch, cleanName } = await this.resolveDownmergeBranch(
        "hotfix",
        version
      );
      console.log(
        `📋 Using hotfix branch: ${cleanName} (${branch.version.full})`
      );

      const timestamp = Math.floor(Date.now() / 1000);
      const mergeBranchName = `hotfix-${branch.version.full}-into-develop-${timestamp}`;

      const mergeResult = await this.createMergeBranch({
        baseBranch: "develop",
        sourceBranch: cleanName,
        branchName: mergeBranchName,
        mergeCommitMessage: `Merge ${cleanName} into develop`,
      });

      const prTitle = `Hotfix ${branch.version.full} to develop`;
      const prBody = `## Hotfix ${branch.version.full} to develop

This PR brings the hotfix back into develop via a merge branch (\`${mergeBranchName}\`). The merge branch is used instead of a direct hotfix/* head so CI workflows that build the hotfix artifact do not re-trigger.

### 📋 Hotfix Information
- **Version**: ${branch.version.full}
- **Source**: ${cleanName}
- **Target**: develop
- **Merge branch**: ${mergeBranchName}

---
${autoGeneratedFooter()}`;

      const prResult = await this.createPullRequest(
        mergeResult.branchName,
        "develop",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      const superseded = await this.closeSupersededPullRequest(
        cleanName,
        "develop",
        prResult.url
      );

      return {
        kind: "merge-branch",
        pullRequestUrl: prResult.url,
        mergeBranchName: mergeResult.branchName,
        ...(superseded ? { superseded } : {}),
      };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge hotfix to develop: ${error}`);
    }
  }

  /**
   * Open the pull request hotfix/X.Y.Z → main. A conflict throws
   * MergeConflictError before the pull request is opened.
   */
  async downmergeHotfixToMain(version?: string): Promise<string> {
    try {
      // Step 1: Find the target hotfix branch
      const { branch: targetBranch, cleanName: cleanBranchName } =
        await this.resolveDownmergeBranch("hotfix", version);
      console.log(
        `📋 Using hotfix branch: ${cleanBranchName} (${targetBranch.version.full})`
      );

      // Step 2: refuse a conflicting merge while nothing has been opened yet,
      // against the refs the plan fetched.
      const probe = await this.previewMergeConflicts(
        "origin/main",
        `origin/${cleanBranchName}`
      );
      if (probe.hasConflicts) {
        throw new MergeConflictError(
          `Merge of ${cleanBranchName} into main produced conflicts in ` +
            `${probe.conflictedFiles.length} file(s): ${probe.conflictedFiles.join(", ")}`,
          probe.conflictedFiles
        );
      }

      // Step 3: Create pull request from hotfix branch to main
      const prTitle = `Release ${targetBranch.version.full} to main`;
      const prBody = `## Hotfix ${targetBranch.version.full} to main

${productionMergeWarning("hotfix")}

This PR merges the hotfix branch into main.

### 📋 Hotfix Information
- **Version**: ${targetBranch.version.full}
- **Branch**: ${cleanBranchName}
- **Target**: main
- **Type**: ${targetBranch.type}

---
${autoGeneratedFooter()}`;

      const prResult = await this.createPullRequest(
        cleanBranchName,
        "main",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      return prResult.url;
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge hotfix to main: ${error}`);
    }
  }
  /**
   * Run one downmerge route. A clean merge opens its pull request; a conflicting
   * one creates nothing and throws ManualDownmergeRequired, carrying the steps to
   * finish it by hand.
   */
  async downmerge(
    route: DownmergeRoute,
    version?: string
  ): Promise<DownmergeResult> {
    const source =
      route.source === "main"
        ? undefined
        : await this.resolveDownmergeBranch(route.source, version);
    const resolved = source?.branch.version.full;

    try {
      switch (`${route.source}->${route.target}`) {
        case "main->develop":
          return await this.downmergeMainToDevelop();
        case "release->develop":
          return await this.downmergeReleaseToDevelop(resolved);
        case "release->main":
          return await this.downmergeReleaseToMain(resolved);
        case "hotfix->develop":
          return await this.downmergeHotfixToDevelop(resolved);
        default:
          return {
            kind: "direct",
            pullRequestUrl: await this.downmergeHotfixToMain(resolved),
          };
      }
    } catch (error) {
      if (!(error instanceof MergeConflictError)) {
        throw error;
      }
      const pullRequestTitle =
        route.source === "main"
          ? (await this.describeMainDownmerge()).title
          : downmergePullRequestTitle(route, resolved!);
      throw new ManualDownmergeRequired(
        describeManualDownmerge({
          route,
          sourceBranch: source?.cleanName ?? "main",
          ...(resolved === undefined ? {} : { version: resolved }),
          conflictedFiles: error.conflictedFiles,
          pullRequestTitle,
        })
      );
    }
  }
}
