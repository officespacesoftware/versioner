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
import { ReleaseAgent } from "./release-agent.js";
import { GitFlowManager } from "./git-flow.js";

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
            description:
              "Check the health and status of the Release Management MCP server",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "create_release_candidate",
            description:
              "Create a release candidate (major or minor) following Git Flow workflow (6-step process). Defaults to minor release if not specified.",
            inputSchema: {
              type: "object",
              properties: {
                releaseType: {
                  type: "string",
                  enum: ["major", "minor"],
                  description:
                    "The type of release candidate to create: major (X.0.0-RC.0) or minor (x.X.0-RC.0). Defaults to minor if not specified.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "If true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "create_hotfix",
            description:
              "Create a hotfix branch for patch releases following Git Flow hotfix workflow (6-step process)",
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
                    "If true, performs validation checks without making any changes (default: false)",
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
    if (!["major", "minor"].includes(releaseType)) {
      throw new Error(
        "releaseType must be one of: major, minor (defaults to minor if not specified)"
      );
    }

    try {
      // Initialize components if not already done
      if (!this.gitFlowManager) {
        this.gitFlowManager = new GitFlowManager(workingDirectory);
      }

      if (!this.releaseAgent) {
        this.releaseAgent = new ReleaseAgent(
          this.gitFlowManager,
          workingDirectory
        );
        await this.releaseAgent.initialize();
      }

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check if versioner is available
      if (!this.releaseAgent.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the RC workflow with the specified release type
      const workflowResult = await this.releaseAgent.executeRCWorkflow(
        releaseType,
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent.getProgressSummary();

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
      // Initialize components if not already done
      if (!this.gitFlowManager) {
        this.gitFlowManager = new GitFlowManager(workingDirectory);
      }

      if (!this.releaseAgent) {
        this.releaseAgent = new ReleaseAgent(
          this.gitFlowManager,
          workingDirectory
        );
        await this.releaseAgent.initialize();
      }

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check if versioner is available
      if (!this.releaseAgent.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Execute the hotfix workflow
      const workflowResult = await this.releaseAgent.executeHotfixWorkflow(
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent.getProgressSummary();

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

✅ All steps completed successfully. The hotfix has been created and is ready for production deployment.

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
