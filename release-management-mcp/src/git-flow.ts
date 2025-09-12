/**
 * Git Flow Core Logic - Git operations and branch management
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
      // First, fetch latest changes
      await this.execGit("fetch origin");

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
        await this.execGit(`checkout ${branchName}`);
        await this.execGit(`pull origin ${branchName}`);
      } else {
        // Branch doesn't exist locally, check if it exists on remote
        const remoteBranch = branches.find(
          (b) => b.name === `remotes/origin/${branchName}`
        );
        if (remoteBranch) {
          await this.execGit(`checkout -b ${branchName} origin/${branchName}`);
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
   * Create a pull request using gh CLI
   */
  async createPullRequest(
    branchName: string,
    baseBranch: string = "develop",
    title?: string,
    body?: string
  ): Promise<string> {
    try {
      // Check if gh CLI is available
      await execAsync("which gh", { cwd: this.workingDirectory });

      const defaultTitle = title || `Release: ${branchName}`;
      const defaultBody =
        body ||
        `
## Release Branch

This PR contains the release branch for ${branchName}.

### Changes
- Version bump to release candidate
- Release preparation

### Testing
- [ ] Version bump is correct
- [ ] All tests pass
- [ ] Release artifacts build successfully

Auto-generated by Release Management MCP
      `.trim();

      // Create PR using gh CLI
      const command = `gh pr create --base ${baseBranch} --head ${branchName} --title "${defaultTitle}" --body "${defaultBody}"`;
      const output = await execAsync(command, { cwd: this.workingDirectory });

      // Extract PR URL from output
      const prUrl = output.stdout.trim();
      return prUrl;
    } catch (error) {
      throw new Error(`Failed to create pull request: ${error}`);
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

    if (/^release\/\d+\.\d+\.\d+(-RC\.\d+)?$/.test(cleanBranchName)) {
      return "release";
    }

    if (/^hotfix\/\d+\.\d+\.\d+(-RC\.\d+)?$/.test(cleanBranchName)) {
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
      const branches = await this.getBranches();
      const typedBranches: BranchTypeInfo[] = [];

      for (const branch of branches) {
        const detectedType = this.detectBranchType(branch.name);
        if (detectedType === branchType) {
          const version = this.parseVersionFromBranch(branch.name);
          if (version) {
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
      // First, fetch latest changes
      await this.execGit("fetch origin");

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
}
