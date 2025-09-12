#!/usr/bin/env node

/**
 * Release Management MCP Server - Model Context Protocol server for Git Flow release management
 * Orchestrates complex release workflows using AI agents and integrates with versioner-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ReleaseAgent } from './release-agent.js';
import { GitFlowManager } from './git-flow.js';

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
        name: 'release-management-mcp',
        version: '0.1.0',
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
    this.server.onerror = (error) => console.error('[Release Management MCP Error]', error);
    
    process.on('SIGINT', async () => {
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
            name: 'health_check',
            description: 'Check the health and status of the Release Management MCP server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'create_release_candidate',
            description: 'Create a release candidate (major, minor, or patch) following Git Flow workflow (6-step process)',
            inputSchema: {
              type: 'object',
              properties: {
                releaseType: {
                  type: 'string',
                  enum: ['major', 'minor', 'patch'],
                  description: 'The type of release candidate to create: major (X.0.0-RC.0), minor (x.X.0-RC.0), or patch (x.x.X-RC.0)',
                },
                workingDirectory: {
                  type: 'string',
                  description: 'The working directory path for the project (optional, defaults to current directory)',
                },
                dryRun: {
                  type: 'boolean',
                  description: 'If true, performs validation checks without making any changes (default: false)',
                },
              },
              required: ['releaseType'],
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
          case 'health_check':
            result = await this.handleHealthCheck();
            break;

          case 'create_release_candidate':
            result = await this.handleCreateRC(args);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error executing tool ${name}:`, error);
        
        return {
          content: [
            {
              type: 'text',
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
      server: 'Release Management MCP Server',
      version: '0.1.0',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      capabilities: [
        'Git Flow workflow orchestration',
        'Release candidate creation (major, minor, patch)',
        'Branch validation and synchronization',
        'Integration with versioner-mcp',
        'Automated PR management'
      ]
    };

    return JSON.stringify(status, null, 2);
  }

  private async handleCreateRC(args: any): Promise<string> {
    const releaseType = args?.releaseType;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;

    // Validate release type
    if (!releaseType || !['major', 'minor', 'patch'].includes(releaseType)) {
      throw new Error('releaseType is required and must be one of: major, minor, patch');
    }

    try {
      // Initialize components if not already done
      if (!this.gitFlowManager) {
        this.gitFlowManager = new GitFlowManager(workingDirectory);
      }

      if (!this.releaseAgent) {
        this.releaseAgent = new ReleaseAgent(this.gitFlowManager, workingDirectory);
        await this.releaseAgent.initialize();
      }

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager.isGitRepository();
      if (!isGitRepo) {
        throw new Error(`Directory '${workingDirectory}' is not a Git repository`);
      }

      // Check if versioner is available
      if (!this.releaseAgent.isVersionerAvailable()) {
        throw new Error('Versioner MCP is not available. Please ensure versioner-mcp is running.');
      }

      // Execute the RC workflow with the specified release type
      const workflowResult = await this.releaseAgent.executeRCWorkflow(releaseType, workingDirectory, dryRun);
      
      // Generate workflow summary
      const progressSummary = this.releaseAgent.getProgressSummary();
      
      return `🚀 ${releaseType.charAt(0).toUpperCase() + releaseType.slice(1)} Release Candidate Workflow ${dryRun ? '(Dry Run) ' : ''}Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}

📋 Workflow Progress:
${progressSummary}

${workflowResult.targetVersion ? `🎯 Target Version: ${workflowResult.targetVersion.version}` : ''}
${workflowResult.pullRequestUrl ? `🔗 Pull Request: ${workflowResult.pullRequestUrl}` : ''}

✅ All steps completed successfully. The ${releaseType} release candidate has been created and is ready for testing.

${workflowResult.pullRequestUrl ? `
📋 Next steps:
1. Review the pull request: ${workflowResult.pullRequestUrl}
2. Run integration tests on the release branch
3. Merge the PR when ready to integrate to develop
4. Deploy to staging environment for testing` : `
📋 Next steps:
1. Review the release branch
2. Run integration tests
3. Create PR to develop branch (Step 6 completed)
4. Deploy to staging environment for testing`}`;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`${releaseType} RC workflow failed:`, error);
      
      // Include progress summary even on failure
      const progressSummary = this.releaseAgent?.getProgressSummary() || 'Workflow not started';
      
      return `❌ ${releaseType.charAt(0).toUpperCase() + releaseType.slice(1)} Release Candidate Workflow Failed

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}
🔧 Dry Run: ${dryRun ? 'Yes' : 'No'}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Release Management MCP server running on stdio');
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.releaseAgent) {
        await this.releaseAgent.cleanup();
      }
      console.error('Release Management MCP: Cleanup completed');
    } catch (error) {
      console.error('Release Management MCP: Cleanup error:', error);
    }
  }
}

// Start the server
async function main() {
  const server = new ReleaseManagementMCPServer();
  await server.run();
}

main().catch((error) => {
  console.error('Failed to start Release Management MCP server:', error);
  process.exit(1);
});