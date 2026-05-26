#!/usr/bin/env node

/**
 * Release Management MCP Server - Model Context Protocol server for Git Flow release management
 * Orchestrates complex release workflows using AI agents and integrates with versioner-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  GitFlowManager,
  MergeConflictError,
  ReleaseAgent,
  VersionerAdapter,
  type DownmergeResult,
} from "@officespacesoftware/release-management-core";

/**
 * Release Management MCP Server
 *
 * This server provides intelligent Git Flow release management workflows:
 * - Release candidate creation (major, minor, patch) following the 6-step process
 * - Branch validation and synchronization checks
 * - Integration with versioner-mcp for version management
 * - Automated PR creation and workflow orchestration
 */
class ReleaseManagementMCPServer {
  private server: Server;
  private releaseAgent?: ReleaseAgent;
  private gitFlowManager?: GitFlowManager;
  private versionerAdapter?: VersionerAdapter;
  private boundWorkingDirectory?: string;

  /**
   * Ensure gitFlowManager and releaseAgent are bound to `workingDirectory`.
   *
   * The MCP server is a long-lived stdio process; without this, the very first
   * tool call would lock these to whatever cwd it used and every subsequent call
   * — even with a different `workingDirectory` arg — would silently operate on
   * the original repo. Re-instantiate whenever the directory changes.
   */
  private async bindWorkingDirectory(
    workingDirectory: string,
    options: { initializeReleaseAgent?: boolean } = {}
  ): Promise<void> {
    if (this.boundWorkingDirectory !== workingDirectory) {
      this.gitFlowManager = new GitFlowManager(workingDirectory);
      delete this.releaseAgent;
      this.boundWorkingDirectory = workingDirectory;
    } else if (!this.gitFlowManager) {
      this.gitFlowManager = new GitFlowManager(workingDirectory);
    }

    if (options.initializeReleaseAgent && !this.releaseAgent) {
      this.releaseAgent = new ReleaseAgent(
        this.gitFlowManager!,
        workingDirectory
      );
      await this.releaseAgent.initialize();
    }
  }

  constructor() {
    this.server = new Server(
      {
        name: "release-management-mcp",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) =>
      console.error("[Release Management MCP Error]", error);

    process.on("SIGINT", async () => {
      await this.cleanup();
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "health_check",
            title: "Health Check",
            description: `🩺  Health Check

Runs a quick self-test to ensure the Release Management MCP server is responsive.

What you get:
- Server name, version, and status
- ISO timestamp
- Supported capabilities`,
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "create_release_candidate",
            title: "Create Release Candidate",
            description: `🎯  Create Release Candidate (RC)

Creates a Git Flow release branch and initializes an RC version.

- Types: major (X.0.0-RC.0), minor (x.X.0-RC.0), or patch (x.x.X-RC.0)
- Branch: release/X.Y.Z
- Process: 6-step Git Flow with PR to develop
- Defaults: releaseType=minor, dryRun=false`,
            inputSchema: {
              type: "object",
              properties: {
                releaseType: {
                  type: "string",
                  enum: ["major", "minor", "patch"],
                  description:
                    "The type of release candidate to create: major (X.0.0-RC.0), minor (x.X.0-RC.0), or patch (x.x.X-RC.0). Defaults to minor if not specified.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "create_hotfix",
            title: "Create Hotfix",
            description: `🚑  Create Hotfix (Patch RC)

Creates a Git Flow hotfix branch and initializes an RC version.

- Branch: hotfix/X.Y.Z
- Process: 6-step Git Flow with PR to main
- For urgent production fixes
- Defaults: dryRun=false`,
            inputSchema: {
              type: "object",
              properties: {
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "increment_release_candidate",
            title: "Increment Release Candidate",
            description: `🔼  Increment Release Candidate

Bumps the RC number for an existing release or hotfix branch.

- Input: optional base version (e.g., 1.2.0)
- Auto-selects target branch (latest RC) unless a version is provided
- Works with both release/X.Y.0 and hotfix/X.Y.Z
- Creates commit and optional PR`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional target version to increment (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "release_version",
            title: "Release Version",
            description: `🏁  Release Version (RC → Final)

Converts a release candidate into a final version.

- Input: optional base version (e.g., 1.2.0)
- Auto-select order: provided version → current RC branch → latest RC
- Updates VERSION, tags, and creates PR
- 8-step Git Flow release`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional specific version to release (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "initialize_versioner",
            title: "Initialize Versioner",
            description: `📦  Initialize Versioner

Bootstraps version management by creating a VERSION file and initial tag.

- Input: optional initial version (e.g., 0.1.0-RC.0)
- Default version: 0.1.0-RC.0
- Makes initial commit and tag
- Works in any Git repo (no staged changes allowed)`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Initial version (optional, defaults to 0.1.0-RC.0)",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "downmerge_main_to_develop",
            title: "Downmerge Main to Develop",
            description: `⬇️  Downmerge main → develop

Creates a PR to bring production changes back into develop.

- Fetch, branch, and merge main into a new branch from develop
- Push and open PR targeting develop
- Use after hotfixes or direct main updates
- Supports dry runs`,
            inputSchema: {
              type: "object",
              properties: {
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, shows what would happen without making changes (default: false)",
                },
              },
            },
          },
          {
            name: "downmerge_release_to_develop",
            title: "Downmerge Release to Develop",
            description: `⬇️  PR: release → develop

Brings a release branch back into develop after the release is cut.

- No conflicts: opens a direct PR release/X.Y.0 → develop
- Conflicts: opens a draft merge-branch PR (off develop, with release merged in, conflict markers committed) for human resolution, plus a transient build-trigger PR that is auto-closed once CI starts
- Input: optional version to merge (e.g., 1.2.0); auto-detects newest release when omitted`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent release version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, shows what would happen without making changes (default: false)",
                },
              },
            },
          },
          {
            name: "downmerge_release_to_main",
            title: "Downmerge Release to Main",
            description: `📤  PR: release → main (via merge branch)

Creates a merge branch off main with the release merged in, then opens a PR
from that branch into main. Never opens a PR with head=release/* — that would
re-trigger CI workflows that build a fresh Docker image for an already-cut release.

- Input: optional version to merge (e.g., 1.2.0)
- Auto-detects latest release when version is not provided
- Aborts with an error listing conflicted files if the merge has conflicts`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent release version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, shows what would happen without making changes (default: false)",
                },
              },
            },
          },
          {
            name: "downmerge_hotfix_to_main",
            title: "Downmerge Hotfix to Main",
            description: `🔥  PR: hotfix → main

Creates a PR to merge a hotfix branch into main.

- Input: optional version to merge (e.g., 1.2.1)
- Auto-detects latest hotfix when version is not provided
- Production-critical: merge only after deployment
- Validates branch and opens PR`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.1'). " +
                    "When not provided, automatically finds the most recent hotfix version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, shows what would happen without making changes (default: false)",
                },
              },
            },
          },
        ],
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: string;

        switch (name) {
          case "health_check":
            result = await this.handleHealthCheck();
            break;

          case "create_release_candidate":
            result = await this.handleCreateRC(args);
            break;

          case "create_hotfix":
            result = await this.handleCreateHotfix(args);
            break;

          case "increment_release_candidate":
            result = await this.handleIncrementRC(args);
            break;

          case "release_version":
            result = await this.handleReleaseVersion(args);
            break;

          case "initialize_versioner":
            result = await this.handleInitializeVersioner(args);
            break;

          case "downmerge_main_to_develop":
            result = await this.handleDownmergeMainToDevelop(args);
            break;

          case "downmerge_release_to_develop":
            result = await this.handleDownmergeReleaseToDevelop(args);
            break;

          case "downmerge_release_to_main":
            result = await this.handleDownmergeReleaseToMain(args);
            break;

          case "downmerge_hotfix_to_main":
            result = await this.handleDownmergeHotfixToMain(args);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`Error executing tool ${name}:`, error);

        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleInitializeVersioner(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();

    try {
      // Initialize versioner adapter if needed
      if (!this.versionerAdapter) {
        this.versionerAdapter = new VersionerAdapter();
        await this.versionerAdapter.initialize(undefined, workingDirectory);
      }

      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      const versionInfo = await this.versionerAdapter.initializeProject(
        version
      );

      return `✅ Versioner Initialized Successfully!

📁 Working Directory: ${workingDirectory}
🏷️  Created Version: ${versionInfo.version}
📊 Release Type: ${
        versionInfo.isReleaseCandidate ? "Release Candidate" : "Final Release"
      }

📋 Next Steps:
1. VERSION file has been created in your project
2. Initial git commit and tag have been created
3. You can now use other versioning tools to manage releases`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Failed to initialize versioner

📁 Working Directory: ${workingDirectory}
${
  version
    ? `🔍 Requested Version: ${version}`
    : "🔍 Default Version: 0.1.0-RC.0"
}
💥 Error: ${errorMessage}

Common issues:
- Directory may not be a git repository
- Versioner MCP may not be running
- Permission issues with file creation`;
    }
  }

  private async handleDownmergeMainToDevelop(args: any): Promise<string> {
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      const prUrl = await this.gitFlowManager!.downmergeMainToDevelop(dryRun);

      return `🚀 Downmerge Main to Develop ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

${
  dryRun
    ? "🔧 Would have performed the following actions:"
    : "✅ Completed the following actions:"
}
1. Fetched latest changes from origin
2. Checked out and pulled main branch
3. Checked out and pulled develop branch
4. Created new branch from develop
5. Merged main into the new branch
6. Pushed the new branch to origin
7. Created pull request targeting develop

${!dryRun && prUrl ? `🔗 Pull Request: ${prUrl}` : ""}

📋 Next Steps:
1. Review the pull request for merge conflicts
2. Test the merged changes in a development environment
3. Merge the PR when ready to integrate main changes into develop`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Main to Develop Failed

📁 Working Directory: ${workingDirectory}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}
💥 Error: ${errorMessage}

Common issues:
- Not in a git repository
- Missing main or develop branches
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private formatDownmergeResult(result: DownmergeResult): string {
    switch (result.kind) {
      case "direct":
        return `🔗 Pull Request: ${result.pullRequestUrl}`;
      case "merge-branch":
        return `🌿 Merge branch: \`${result.mergeBranchName}\`
🔗 Pull Request: ${result.pullRequestUrl}`;
      case "merge-branch-with-conflicts": {
        const checksLine = result.checksStarted
          ? "✅ Build-trigger CI checks observed before close"
          : "⚠️  Build-trigger PR closed without checks registering within 60s";
        const conflictedList = result.conflictedFiles
          .map((f) => `   - ${f}`)
          .join("\n");
        return `🌿 Merge branch (conflicts unresolved): \`${result.mergeBranchName}\`
🔗 Draft merge-resolution PR: ${result.mergeBranchPullRequestUrl}
🛠️  Build-trigger PR (auto-closed): ${result.buildTriggerPullRequestUrl}
${checksLine}

⚠️  Conflicted files (resolve in the draft PR):
${conflictedList}`;
      }
    }
  }

  private async handleDownmergeReleaseToDevelop(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      await this.gitFlowManager!.validateNoStagedChanges();

      const result = await this.gitFlowManager!.downmergeReleaseToDevelop(
        version,
        dryRun
      );

      const resultSummary = dryRun
        ? "🔧 Dry run — no PRs created."
        : this.formatDownmergeResult(result);

      const nextSteps =
        result.kind === "merge-branch-with-conflicts"
          ? `📋 Next Steps:
1. Check out the merge branch locally and resolve the conflicts listed above
2. Push the resolution and mark the draft PR ready for review
3. Merge the resolution PR once CI is green`
          : `📋 Next Steps:
1. Review the pull request and CI checks
2. Merge once green`;

      return `🚀 Downmerge Release to Develop ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Release"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

${resultSummary}

${nextSteps}`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Release to Develop Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}
💥 Error: ${errorMessage}

Common issues:
- No release branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleDownmergeReleaseToMain(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      await this.gitFlowManager!.validateNoStagedChanges();

      const result = await this.gitFlowManager!.downmergeReleaseToMain(
        version,
        dryRun
      );

      const resultSummary = dryRun
        ? "🔧 Dry run — no PR created."
        : this.formatDownmergeResult(result);

      return `🚀 Downmerge Release to Main ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Release"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

${
  dryRun
    ? "🔧 Would have performed the following actions:"
    : "✅ Completed the following actions:"
}
1. Validated target release branch exists
2. Fetched latest main and release branches from origin
3. Created merge branch off main and merged release into it
4. Pushed merge branch and opened PR targeting main

${resultSummary}

📋 Next Steps:
1. Review the pull request
2. Merge the PR when ready`;
    } catch (error) {
      if (error instanceof MergeConflictError) {
        const conflictedList = error.conflictedFiles
          .map((f) => `   - ${f}`)
          .join("\n");
        return `❌ Downmerge Release to Main Aborted — Merge Conflicts

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}

The merge of the release branch into main produced conflicts. No remote branch was pushed and no PR was opened.

⚠️  Conflicted files:
${conflictedList}

📋 To resolve:
1. Manually create a branch off main, merge the release branch in, and resolve the conflicts
2. Push that branch and open a PR to main yourself
3. Re-run this tool only once main and release no longer conflict`;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Release to Main Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}
💥 Error: ${errorMessage}

Common issues:
- No release branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleDownmergeHotfixToMain(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      const prUrl = await this.gitFlowManager!.downmergeHotfixToMain(
        version,
        dryRun
      );

      return `🚀 Downmerge Hotfix to Main ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Hotfix"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

${
  dryRun
    ? "🔧 Would have performed the following actions:"
    : "✅ Completed the following actions:"
}
1. Validated target hotfix branch exists
2. Fetched latest changes from origin
3. Created pull request from hotfix branch to main

${!dryRun && prUrl ? `🔗 Pull Request: ${prUrl}` : ""}

⚠️  IMPORTANT: This is a HOTFIX merge to production.

📋 Next Steps:
1. Review the pull request for merge conflicts
2. Deploy the hotfix to production environment FIRST
3. Verify the hotfix is working correctly in production
4. THEN merge the PR after successful deployment
5. Create follow-up PR to merge hotfix changes back to develop`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Hotfix to Main Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Hotfix"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}
💥 Error: ${errorMessage}

Common issues:
- No hotfix branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleHealthCheck(): Promise<string> {
    const status = {
      server: "Release Management MCP Server",
      version: "0.1.0",
      status: "healthy",
      timestamp: new Date().toISOString(),
      capabilities: [
        "Git Flow workflow orchestration",
        "Release candidate creation (major, minor)",
        "Hotfix branch creation for patch releases",
        "Branch validation and synchronization",
        "Integration with versioner-mcp",
        "Automated PR management",
      ],
    };

    return JSON.stringify(status, null, 2);
  }

  private async handleCreateRC(args: any): Promise<string> {
    const releaseType = args?.releaseType || "minor"; // Default to minor
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    // Validate release type
    if (!["major", "minor", "patch"].includes(releaseType)) {
      throw new Error(
        "releaseType must be one of: major, minor, patch (defaults to minor if not specified)"
      );
    }

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the RC workflow with the specified release type
      const workflowResult = await this.releaseAgent!.executeRCWorkflow(
        releaseType,
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 ${
        releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
      } Release Candidate Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Target Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 Pull Request: ${workflowResult.pullRequestUrl}`
    : ""
}

✅ All steps completed successfully. The ${releaseType} release candidate has been created and is ready for testing.

${
  workflowResult.pullRequestUrl
    ? `
📋 Next steps:
1. Review the pull request: ${workflowResult.pullRequestUrl}
2. Run integration tests on the release branch
3. Merge the PR when ready to integrate to develop
4. Deploy to staging environment for testing`
    : `
📋 Next steps:
1. Review the release branch
2. Run integration tests
3. Create PR to develop branch (Step 6 completed)
4. Deploy to staging environment for testing`
}`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`${releaseType} RC workflow failed:`, error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ ${
        releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
      } Release Candidate Workflow Failed

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleCreateHotfix(args: any): Promise<string> {
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the hotfix workflow
      const workflowResult = await this.releaseAgent!.executeHotfixWorkflow(
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Hotfix Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
🔧 Workflow Type: HOTFIX (Patch Release)

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Target Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 Pull Request: ${workflowResult.pullRequestUrl}`
    : ""
}

✅ All steps completed successfully.

${
  workflowResult.pullRequestUrl
    ? `
📋 Next steps:
1. Review the pull request: ${workflowResult.pullRequestUrl}
2. Deploy the hotfix to production environment
3. Merge the PR AFTER successful production deployment
4. Create follow-up PR to merge hotfix changes back to develop`
    : `
📋 Next steps:
1. Review the hotfix branch
2. Deploy to production environment
3. Create PR to main branch (Step 6 completed)
4. Merge AFTER successful production deployment`
}`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Hotfix workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Hotfix Workflow Failed

📁 Working Directory: ${workingDirectory}
🔧 Workflow Type: HOTFIX (Patch Release)
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleIncrementRC(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the increment RC workflow
      const workflowResult = await this.releaseAgent!.executeIncrementRCWorkflow(
        workingDirectory,
        version,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Increment Release Candidate Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Branch Type: ${workflowResult.branchType.toUpperCase()}
🎯 Selected Branch: ${workflowResult.branchInfo.name}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 New Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}
${
  workflowResult.pullRequestError
    ? `⚠️  PR step failed: ${workflowResult.pullRequestError}`
    : ""
}

✅ All steps completed successfully.`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Increment RC workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Increment Release Candidate Workflow Failed

📁 Working Directory: ${workingDirectory}
${
  version
    ? `📋 Target Version: ${version}`
    : "📋 Version Selection: Auto-detect"
}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleReleaseVersion(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the release workflow
      const workflowResult = await this.releaseAgent!.executeReleaseWorkflow(
        workingDirectory,
        version,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Release Version Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Branch Type: ${workflowResult.branchType.toUpperCase()}
🎯 Selected Branch: ${workflowResult.branchInfo.name}
${version ? `🔍 Requested Version: ${version}` : "🔍 Auto-detected RC Branch"}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Final Version: ${workflowResult.targetVersion.version} (Released from RC)`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}
${
  workflowResult.pullRequestError
    ? `⚠️  PR step failed: ${workflowResult.pullRequestError}`
    : ""
}
${
  workflowResult.releaseUrl
    ? `📦 GitHub Release: ${workflowResult.releaseUrl}`
    : ""
}
${
  workflowResult.releaseNotesWarning
    ? `⚠️  Release notes: ${workflowResult.releaseNotesWarning}`
    : ""
}

✅ All steps completed successfully. The release candidate has been converted to final version and is ready for ${
        workflowResult.branchType === "release"
          ? "production deployment"
          : "production hotfix deployment"
      }.`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Release version workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Release Version Workflow Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Requested Version: ${version}` : "🔍 Auto-detect RC Branch"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.

Common issues:
- Ensure you're on a release candidate branch (contains '-RC.')
- Verify the VERSION file exists and is properly formatted
- Check that versioner-mcp is running and accessible
- Ensure you have proper git permissions for pushing and PR creation`;
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Release Management MCP server running on stdio");
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.releaseAgent) {
        await this.releaseAgent.cleanup();
      }
      console.error("Release Management MCP: Cleanup completed");
    } catch (error) {
      console.error("Release Management MCP: Cleanup error:", error);
    }
  }
}

// Start the server
async function main() {
  const server = new ReleaseManagementMCPServer();
  await server.run();
}

main().catch((error) => {
  console.error("Failed to start Release Management MCP server:", error);
  process.exit(1);
});
