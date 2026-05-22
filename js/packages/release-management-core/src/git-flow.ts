/**
 * Git Flow Core Logic - Git operations and branch management
 */

import { exec } from "child_process";
import { promisify } from "util";
import { createGitHubClient } from "./github-client.js";

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

export interface PullRequestResult {
  url: string;
  action: "created" | "updated";
}

export type DownmergeResult =
  | { kind: "direct"; pullRequestUrl: string }
  | {
      kind: "merge-branch";
      pullRequestUrl: string;
      mergeBranchName: string;
    }
  | {
      kind: "merge-branch-with-conflicts";
      mergeBranchName: string;
      mergeBranchPullRequestUrl: string;
      buildTriggerPullRequestUrl: string;
      buildTriggerPullRequestNumber: number;
      checksStarted: boolean;
      conflictedFiles: string[];
    };

export interface MergeBranchResult {
  hasConflicts: boolean;
  sha: string;
  conflictedFiles: string[];
  branchName: string;
}

export class MergeConflictError extends Error {
  conflictedFiles: string[];
  constructor(message: string, conflictedFiles: string[]) {
    super(message);
    this.name = "MergeConflictError";
    this.conflictedFiles = conflictedFiles;
  }
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

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
  }

  /**
   * Execute git command in the working directory
   */
  private async execGit(command: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(`git ${command}`, {
        cwd: this.workingDirectory,
        timeout: 10000, // 10 second timeout
      });

      if (stderr) {
        console.warn(`Git warning: ${stderr}`);
      }

      return stdout.trim();
    } catch (error) {
      throw new Error(`Git command failed: ${error}`);
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
   * Verify that main has been merged into develop using robust three-step process
   */
  async verifyMainDevelopSync(): Promise<{
    synchronized: boolean;
    message: string;
    canProceed: boolean;
  }> {
    try {
      // First, fetch only the base branches needed for this comparison.
      await this.fetchBaseBranches();

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
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)
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
          defaultTitle,
          defaultBody
        );
      }
      throw new Error(`Failed to create pull request: ${message}`);
    }
  }

  private async updateExistingPullRequest(
    branchName: string,
    title: string,
    body: string
  ): Promise<PullRequestResult> {
    const client = await createGitHubClient(this.workingDirectory);
    let prNumber: number;
    let existingBody: string;
    let url: string;

    try {
      const { data: prs } = await client.rest.pulls.list({
        owner: client.owner,
        repo: client.repo,
        head: `${client.owner}:${branchName}`,
        state: "open",
        per_page: 1,
      });
      const pr = prs[0];
      if (!pr) {
        throw new Error(
          `No open PR found for head '${client.owner}:${branchName}'`
        );
      }
      prNumber = pr.number;
      existingBody = pr.body ?? "";
      url = pr.html_url;
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(
        `Failed to look up existing PR for '${branchName}': ${msg}`
      );
    }

    const updatedBody = replaceWatermarkedContent(existingBody, body);

    try {
      await client.rest.pulls.update({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
        title,
        body: updatedBody,
      });
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(`Failed to edit PR #${prNumber}: ${msg}`);
    }

    console.log(`🔄 Updated existing PR #${prNumber}: ${url}`);
    return { url, action: "updated" };
  }

  /**
   * Create a GitHub release via the REST API (auto-generated notes).
   */
  async createGitHubRelease(
    version: string,
    branchName: string
  ): Promise<string> {
    const client = await createGitHubClient(this.workingDirectory);
    const title = `Release ${version}`;

    try {
      // Generate release notes from commits since the previous tag.
      let notesBody = "";
      try {
        const { data: notes } = await client.rest.repos.generateReleaseNotes({
          owner: client.owner,
          repo: client.repo,
          tag_name: version,
          target_commitish: branchName,
        });
        notesBody = notes.body;
      } catch {
        // If notes generation fails (e.g. no previous tag), fall back to empty body.
      }

      const { data: release } = await client.rest.repos.createRelease({
        owner: client.owner,
        repo: client.repo,
        tag_name: version,
        name: title,
        target_commitish: branchName,
        body: notesBody,
      });
      return release.html_url;
    } catch (error) {
      const msg = octokitErrorMessage(error);
      throw new Error(`Failed to create GitHub release: ${msg}`);
    }
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
  ): Promise<boolean> {
    await this.checkoutAndPull(baseBranch);
    try {
      await this.execGit(
        `merge --no-commit --no-ff ${quoteGitArg(sourceBranch)}`
      );
      // Clean merge — abort so we leave no trace.
      try {
        await this.execGit("merge --abort");
      } catch {
        // `merge --abort` errors when there's no merge in progress (fast-forward
        // case). Ignore — the working tree may be ahead but we'll reset below.
      }
      // In case fast-forward changed HEAD, hard-reset to origin to be safe.
      try {
        await this.execGit(`reset --hard origin/${baseBranch}`);
      } catch {
        /* ignore */
      }
      return false;
    } catch {
      const conflicted = await this.getConflictedFiles();
      try {
        await this.execGit("merge --abort");
      } catch {
        /* ignore */
      }
      return conflicted.length > 0;
    }
  }

  /**
   * Create a new branch off `baseBranch`, merge `sourceBranch` into it, push.
   *
   * When `commitConflictMarkers` is true and the merge produces conflicts,
   * the conflicted files (with markers) are staged and committed so the
   * branch can be pushed for human resolution.
   *
   * When `commitConflictMarkers` is false and conflicts occur, throws a
   * MergeConflictError after aborting the merge and removing the local
   * branch (no remote side effects).
   */
  async createMergeBranch(opts: {
    baseBranch: string;
    sourceBranch: string;
    branchName: string;
    commitConflictMarkers: boolean;
    mergeCommitMessage?: string;
  }): Promise<MergeBranchResult> {
    const { baseBranch, sourceBranch, branchName, commitConflictMarkers } =
      opts;
    const mergeMessage =
      opts.mergeCommitMessage || `Merge ${sourceBranch} into ${baseBranch}`;

    await this.checkoutAndPull(baseBranch);
    await this.execGit(`checkout -b ${quoteGitArg(branchName)}`);

    let mergeFailed = false;
    try {
      await this.execGit(
        `merge --no-ff -m ${quoteGitArg(mergeMessage)} ${quoteGitArg(sourceBranch)}`
      );
    } catch {
      mergeFailed = true;
    }

    if (!mergeFailed) {
      await this.execGit(`push -u origin ${quoteGitArg(branchName)}`);
      const sha = await this.getCurrentCommit();
      return { hasConflicts: false, sha, conflictedFiles: [], branchName };
    }

    const conflictedFiles = await this.getConflictedFiles();

    if (!commitConflictMarkers) {
      try {
        await this.execGit("merge --abort");
      } catch {
        /* ignore */
      }
      try {
        await this.execGit(`checkout ${quoteGitArg(baseBranch)}`);
      } catch {
        /* ignore */
      }
      try {
        await this.execGit(`branch -D ${quoteGitArg(branchName)}`);
      } catch {
        /* ignore */
      }
      throw new MergeConflictError(
        `Merge of ${sourceBranch} into ${baseBranch} produced conflicts in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`,
        conflictedFiles
      );
    }

    // Commit conflict markers so the branch is pushable for human resolution.
    await this.execGit("add -A");
    await this.execGit(
      `commit -m ${quoteGitArg(
        `${mergeMessage} (conflicts unresolved — needs manual resolution)`
      )}`
    );
    await this.execGit(`push -u origin ${quoteGitArg(branchName)}`);
    const sha = await this.getCurrentCommit();
    return { hasConflicts: true, sha, conflictedFiles, branchName };
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
   * Extract a PR number from a PR URL (e.g. https://github.com/o/r/pull/123 → 123).
   */
  parsePullRequestNumber(prUrl: string): number {
    const match = prUrl.match(/\/pull\/(\d+)/);
    if (!match || !match[1]) {
      throw new Error(`Could not parse PR number from URL: ${prUrl}`);
    }
    return parseInt(match[1], 10);
  }

  /**
   * Poll the PR's checks until at least one appears, or timeout.
   * Returns true if checks were observed; false on timeout.
   */
  async waitForPullRequestChecksToStart(
    prNumber: number,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 60000;
    const pollIntervalMs = opts.pollIntervalMs ?? 3000;
    const deadline = Date.now() + timeoutMs;

    const client = await createGitHubClient(this.workingDirectory);
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    contexts(first: 1) {
                      totalCount
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    interface CheckRollupResponse {
      repository: {
        pullRequest: {
          commits: {
            nodes: Array<{
              commit: {
                statusCheckRollup: {
                  contexts: { totalCount: number };
                } | null;
              };
            }>;
          };
        };
      };
    }

    while (Date.now() < deadline) {
      try {
        const result = await client.graphql<CheckRollupResponse>(query, {
          owner: client.owner,
          repo: client.repo,
          number: prNumber,
        });
        const totalCount =
          result.repository.pullRequest.commits.nodes[0]?.commit
            .statusCheckRollup?.contexts.totalCount ?? 0;
        if (totalCount > 0) {
          return true;
        }
      } catch {
        // GraphQL errors when checks aren't yet attached — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
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
  async validateBranchVersion(
    branchInfo: BranchTypeInfo
  ): Promise<{ valid: boolean; message: string }> {
    try {
      // Checkout the base branch and get its VERSION file content
      const currentStatus = await this.getStatus();
      const originalBranch = currentStatus.currentBranch;

      try {
        await this.checkoutAndPull(branchInfo.baseBranch);

        // Read VERSION file from base branch
        const versionContent = await this.execGit("show HEAD:VERSION");
        const baseBranchVersion = versionContent.split("\n")[0]?.trim();

        if (!baseBranchVersion) {
          return {
            valid: false,
            message: `Could not read version from ${branchInfo.baseBranch} branch VERSION file`,
          };
        }

        // Parse base branch version
        const baseVersionMatch =
          baseBranchVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
        if (!baseVersionMatch) {
          return {
            valid: false,
            message: `Invalid version format in ${branchInfo.baseBranch} branch: ${baseBranchVersion}`,
          };
        }

        const [, baseMajorStr, baseMinorStr, basePatchStr] = baseVersionMatch;
        const baseMajor = parseInt(baseMajorStr || "0", 10);
        const baseMinor = parseInt(baseMinorStr || "0", 10);
        const basePatch = parseInt(basePatchStr || "0", 10);

        // Compare versions
        const branchVersion = branchInfo.version;

        // Branch version should be >= base branch version
        if (
          branchVersion.major > baseMajor ||
          (branchVersion.major === baseMajor &&
            branchVersion.minor > baseMinor) ||
          (branchVersion.major === baseMajor &&
            branchVersion.minor === baseMinor &&
            branchVersion.patch >= basePatch)
        ) {
          return {
            valid: true,
            message: `${branchInfo.name} version ${branchVersion.full} is valid against ${branchInfo.baseBranch} version ${baseBranchVersion}`,
          };
        } else {
          return {
            valid: false,
            message: `${branchInfo.name} version ${branchVersion.full} is behind ${branchInfo.baseBranch} version ${baseBranchVersion}. Cannot proceed with increment.`,
          };
        }
      } finally {
        // Always return to original branch
        if (originalBranch !== branchInfo.baseBranch) {
          await this.execGit(`checkout ${originalBranch}`);
        }
      }
    } catch (error) {
      return {
        valid: false,
        message: `Failed to validate branch version: ${error}`,
      };
    }
  }

  /**
   * Downmerge main branch into develop via pull request
   */
  async downmergeMainToDevelop(dryRun: boolean = false): Promise<string> {
    try {
      if (dryRun) {
        console.log(
          "🔧 Dry run: Would perform downmerge main to develop workflow"
        );
        return "Dry run completed - no actual changes made";
      }

      // Step 1: Fetch latest changes from origin
      await this.fetchBaseBranches();
      console.log("✅ Fetched latest main and develop branches from origin");

      // Step 2: Checkout and pull main branch
      await this.execGit("checkout main");
      await this.pullBranch("main");
      console.log("✅ Checked out and pulled main branch");

      // Step 3: Checkout and pull develop branch
      await this.execGit("checkout develop");
      await this.pullBranch("develop");
      console.log("✅ Checked out and pulled develop branch");

      // Step 4: Generate unique branch name using Unix timestamp
      const timestamp = Math.floor(Date.now() / 1000);
      const branchName = `main-into-develop-${timestamp}`;

      // Step 5: Create and checkout new branch from develop
      await this.execGit(`checkout -b ${branchName}`);
      console.log(`✅ Created new branch: ${branchName}`);

      // Check version BEFORE creating any commits - skip merge commits
      let prTitle = "Downmerge main into develop";
      let detectedVersion: string | undefined;
      try {
        const lastCommitMessage = await this.execGit(
          "log -1 --no-merges --pretty=format:%s origin/main"
        );
        const versionMatch = lastCommitMessage.match(/^To version (.+)$/);
        if (versionMatch) {
          const version = versionMatch[1];
          detectedVersion = version;
          prTitle = `Release ${version} to develop`;
        }
      } catch (error) {
        console.warn(
          "Could not determine last commit message, using default title"
        );
      }

      // Step 6: Merge main into the new branch
      await this.execGit('merge main --no-ff -m "Downmerge main into develop"');
      console.log("✅ Merged main into the new branch");

      // Step 7: Push the new branch to origin
      await this.execGit(`push origin ${branchName}`);
      console.log(`✅ Pushed branch ${branchName} to origin`);

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
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

      const prResult = await this.createPullRequest(
        branchName,
        "develop",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      return prResult.url;
    } catch (error) {
      throw new Error(`Failed to downmerge main to develop: ${error}`);
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
   * Resolve the release branch to downmerge — either by version or auto-detect latest.
   * Returns the BranchTypeInfo plus its clean ref name (without remotes/origin/ prefix).
   */
  private async resolveReleaseBranch(
    version: string | undefined
  ): Promise<{ branch: BranchTypeInfo; cleanName: string }> {
    let branch: BranchTypeInfo;
    if (version) {
      const branches = await this.findBranchesOfType("release");
      const match = branches.find((b) => b.version.full === version);
      if (!match) {
        throw new Error(`Release branch for version ${version} not found`);
      }
      branch = match;
    } else {
      const latest = await this.findLatestBranch("release");
      if (!latest) {
        throw new Error("No release branches found");
      }
      branch = latest;
    }
    const cleanName = branch.name.replace(/^remotes\/origin\//, "");
    return { branch, cleanName };
  }

  /**
   * Downmerge release → develop.
   * - No conflicts: direct PR release/X.Y.0 → develop.
   * - Conflicts: merge branch (off develop, with release merged in, conflict
   *   markers committed) + a draft PR for human resolution + a transient
   *   build-trigger PR (release/X.Y.0 → develop) that is auto-closed once CI
   *   checks start.
   */
  async downmergeReleaseToDevelop(
    version?: string,
    dryRun: boolean = false
  ): Promise<DownmergeResult> {
    try {
      if (dryRun) {
        console.log(
          "🔧 Dry run: Would perform downmerge release to develop workflow"
        );
        return {
          kind: "direct",
          pullRequestUrl: "(dry-run, no PR created)",
        };
      }

      const { branch, cleanName } = await this.resolveReleaseBranch(version);
      console.log(
        `📋 Using release branch: ${cleanName} (${branch.version.full})`
      );

      await this.checkoutAndPull("develop");
      await this.checkoutAndPull(cleanName);

      const hasConflicts = await this.detectMergeConflicts("develop", cleanName);

      if (!hasConflicts) {
        const prTitle = `Release ${branch.version.full} to develop`;
        const prBody = `## Release ${branch.version.full} to develop

This PR merges the release branch back into develop.

### 📋 Release Information
- **Version**: ${branch.version.full}
- **Branch**: ${cleanName}
- **Target**: develop
- **Type**: release

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

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

      // Conflict path: create merge branch (commits markers), open draft PR,
      // then open a transient build-trigger PR and close it once CI starts.
      const timestamp = Math.floor(Date.now() / 1000);
      const mergeBranchName = `release-${branch.version.full}-into-develop-${timestamp}`;
      const mergeResult = await this.createMergeBranch({
        baseBranch: "develop",
        sourceBranch: cleanName,
        branchName: mergeBranchName,
        commitConflictMarkers: true,
        mergeCommitMessage: `Merge ${cleanName} into develop`,
      });

      const conflictedList = mergeResult.conflictedFiles
        .map((f) => `- \`${f}\``)
        .join("\n");

      const mergePrTitle = `Release ${branch.version.full} to develop (conflict resolution)`;
      const mergePrBody = `## Release ${branch.version.full} → develop — needs conflict resolution

A direct merge of \`${cleanName}\` into \`develop\` produced conflicts. This branch was created off \`develop\` with \`${cleanName}\` merged in, and the conflicted files were committed with conflict markers intact so this PR can be opened for human resolution.

### ⚠️ Action required

1. Check out \`${mergeBranchName}\` locally.
2. Resolve the conflicts in the files listed below.
3. Commit and push the resolution.
4. Mark this PR ready for review and merge.

### 📋 Conflicted files
${conflictedList}

### 📋 Release Information
- **Version**: ${branch.version.full}
- **Source**: ${cleanName}
- **Target**: develop
- **Merge branch**: ${mergeBranchName}

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

      const mergePrResult = await this.createPullRequest(
        mergeBranchName,
        "develop",
        mergePrTitle,
        mergePrBody,
        true
      );
      console.log(
        `✅ Created draft merge-resolution PR: ${mergePrResult.url}`
      );

      const buildTriggerTitle = `[Build trigger] Release ${branch.version.full} → develop`;
      const buildTriggerBody = `## Build trigger PR — auto-closed

This PR exists solely so CI workflows that key on \`head = release/*\` fire for the release → develop downmerge. It will be auto-closed by the release-management MCP once checks start.

The actual merge resolution is happening in: ${mergePrResult.url}`;

      const buildTriggerResult = await this.createPullRequest(
        cleanName,
        "develop",
        buildTriggerTitle,
        buildTriggerBody
      );
      const buildTriggerNumber = this.parsePullRequestNumber(
        buildTriggerResult.url
      );
      console.log(
        `✅ Opened build-trigger PR #${buildTriggerNumber}: ${buildTriggerResult.url}`
      );

      const checksStarted = await this.waitForPullRequestChecksToStart(
        buildTriggerNumber,
        { timeoutMs: 60000, pollIntervalMs: 3000 }
      );

      const closingComment = checksStarted
        ? `Closing — CI checks triggered. Merge resolution PR: ${mergePrResult.url}`
        : `Closing — no checks registered within 60s. Merge resolution PR: ${mergePrResult.url}. Re-open if a build is still needed.`;

      try {
        await this.closePullRequest(buildTriggerNumber, {
          comment: closingComment,
        });
        console.log(`✅ Closed build-trigger PR #${buildTriggerNumber}`);
      } catch (closeError) {
        const msg =
          closeError instanceof Error ? closeError.message : String(closeError);
        console.warn(
          `⚠️  Failed to close build-trigger PR #${buildTriggerNumber}: ${msg}`
        );
      }

      return {
        kind: "merge-branch-with-conflicts",
        mergeBranchName,
        mergeBranchPullRequestUrl: mergePrResult.url,
        buildTriggerPullRequestUrl: buildTriggerResult.url,
        buildTriggerPullRequestNumber: buildTriggerNumber,
        checksStarted,
        conflictedFiles: mergeResult.conflictedFiles,
      };
    } catch (error) {
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
  async downmergeReleaseToMain(
    version?: string,
    dryRun: boolean = false
  ): Promise<DownmergeResult> {
    try {
      if (dryRun) {
        console.log(
          "🔧 Dry run: Would perform downmerge release to main workflow"
        );
        return {
          kind: "merge-branch",
          pullRequestUrl: "(dry-run, no PR created)",
          mergeBranchName: "(dry-run)",
        };
      }

      const { branch, cleanName } = await this.resolveReleaseBranch(version);
      console.log(
        `📋 Using release branch: ${cleanName} (${branch.version.full})`
      );

      await this.checkoutAndPull("main");
      await this.checkoutAndPull(cleanName);

      const timestamp = Math.floor(Date.now() / 1000);
      const mergeBranchName = `release-${branch.version.full}-into-main-${timestamp}`;

      const mergeResult = await this.createMergeBranch({
        baseBranch: "main",
        sourceBranch: cleanName,
        branchName: mergeBranchName,
        commitConflictMarkers: false,
        mergeCommitMessage: `Merge ${cleanName} into main`,
      });

      const prTitle = `Release ${branch.version.full} to main`;
      const prBody = `## Release ${branch.version.full} to main

This PR merges the release branch into main via a merge branch (\`${mergeBranchName}\`). The merge branch is used instead of a direct release/* head so CI workflows that build the release artifact do not re-trigger.

### 📋 Release Information
- **Version**: ${branch.version.full}
- **Source**: ${cleanName}
- **Target**: main
- **Merge branch**: ${mergeBranchName}

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

      const prResult = await this.createPullRequest(
        mergeResult.branchName,
        "main",
        prTitle,
        prBody
      );
      const verb = prResult.action === "updated" ? "Updated" : "Created";
      console.log(`✅ ${verb} pull request: ${prResult.url}`);

      return {
        kind: "merge-branch",
        pullRequestUrl: prResult.url,
        mergeBranchName: mergeResult.branchName,
      };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        throw error;
      }
      throw new Error(`Failed to downmerge release to main: ${error}`);
    }
  }

  /**
   * Create pull request to merge a hotfix branch directly to main
   */
  async downmergeHotfixToMain(
    version?: string,
    dryRun: boolean = false
  ): Promise<string> {
    try {
      if (dryRun) {
        console.log(
          "🔧 Dry run: Would perform downmerge hotfix to main workflow"
        );
        return "Dry run completed - no actual changes made";
      }

      // Step 1: Find the target hotfix branch
      let targetBranch: BranchTypeInfo;

      if (version) {
        // Find specific version branch
        const branches = await this.findBranchesOfType("hotfix");
        const versionBranch = branches.find((b) => b.version.full === version);

        if (!versionBranch) {
          throw new Error(`Hotfix branch for version ${version} not found`);
        }
        targetBranch = versionBranch;
      } else {
        // Find latest hotfix branch
        const latestBranch = await this.findLatestBranch("hotfix");
        if (!latestBranch) {
          throw new Error("No hotfix branches found");
        }
        targetBranch = latestBranch;
      }

      const cleanBranchName = targetBranch.name.replace(
        /^remotes\/origin\//,
        ""
      );
      console.log(
        `📋 Using hotfix branch: ${cleanBranchName} (${targetBranch.version.full})`
      );

      // Step 2: Create pull request from hotfix branch to main
      const prTitle = `Release ${targetBranch.version.full} to main`;
      const prBody = `## Hotfix ${targetBranch.version.full} to main

This PR merges the hotfix branch into main.

### 📋 Hotfix Information
- **Version**: ${targetBranch.version.full}
- **Branch**: ${cleanBranchName}
- **Target**: main
- **Type**: ${targetBranch.type}

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

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
      throw new Error(`Failed to downmerge hotfix to main: ${error}`);
    }
  }
}
