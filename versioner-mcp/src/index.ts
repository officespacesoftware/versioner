/**
 * Versioner MCP Server - Model Context Protocol server for version management
 * Exposes versioner commands as tools for AI assistants
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent,
  CallToolResult
} from '@modelcontextprotocol/sdk/types.js';

// Import versioner tasks from the main versioner package
import {
  init,
  patch,
  minor,
  major,
  patchReleaseCandidate,
  minorReleaseCandidate,
  majorReleaseCandidate,
  incrementReleaseCandidate,
  release,
  showVersion
} from '@officespacesoftware/versioner';

/**
 * Tool definition interface
 */
interface ToolDefinition {
  name: string;
  description: string;
  handler: (args: any) => string;
  hasVersionParam?: boolean;
}

/**
 * Versioner MCP Server class
 */
export class VersionerMCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition>;

  constructor() {
    this.server = new Server(
      {
        name: 'versioner-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize tool definitions
    this.tools = this.initializeTools();

    // Setup handlers
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  /**
   * Initialize tool definitions with their handlers
   */
  private initializeTools(): Map<string, ToolDefinition> {
    const tools = new Map<string, ToolDefinition>();

    tools.set('versioner_init', {
      name: 'versioner_init',
      description: 'Initialize project with VERSION file. Use this when VERSION file doesn\'t exist or project needs version management setup.',
      handler: (args: { version?: string }) => init(args.version || null),
      hasVersionParam: true
    });

    tools.set('versioner_show', {
      name: 'versioner_show',
      description: 'Show current version from VERSION file',
      handler: () => showVersion()
    });

    tools.set('versioner_patch', {
      name: 'versioner_patch',
      description: 'Create a new patch-level (n.n.X) release',
      handler: () => patch()
    });

    tools.set('versioner_minor', {
      name: 'versioner_minor',
      description: 'Create a new minor-level (n.X.n) release',
      handler: () => minor()
    });

    tools.set('versioner_major', {
      name: 'versioner_major',
      description: 'Create a new major-level (X.n.n) release',
      handler: () => major()
    });

    tools.set('versioner_patch_rc', {
      name: 'versioner_patch_rc',
      description: 'Create a new patch-level (n.n.X-RC.0) release candidate',
      handler: () => patchReleaseCandidate()
    });

    tools.set('versioner_minor_rc', {
      name: 'versioner_minor_rc',
      description: 'Create a new minor-level (n.X.n-RC.0) release candidate',
      handler: () => minorReleaseCandidate()
    });

    tools.set('versioner_major_rc', {
      name: 'versioner_major_rc',
      description: 'Create a new major-level (X.n.n-RC.0) release candidate',
      handler: () => majorReleaseCandidate()
    });

    tools.set('versioner_increment_rc', {
      name: 'versioner_increment_rc',
      description: 'Increment the current release candidate (n.n.n-RCX)',
      handler: () => incrementReleaseCandidate()
    });

    tools.set('versioner_release', {
      name: 'versioner_release',
      description: 'Release the current release candidate (n.n.n)',
      handler: () => release()
    });

    return tools;
  }

  /**
   * Setup error handling for the server
   */
  private setupErrorHandling(): void {
    this.server.onerror = (error: Error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Convert tool definition to MCP tool format
   */
  private toolDefinitionToMCPTool(tool: ToolDefinition): Tool {
    const mcpTool: Tool = {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.hasVersionParam
          ? {
              version: {
                type: 'string',
                description: 'Initial version (default: 0.1.0-RC.0)',
              }
            }
          : {},
      },
    };
    return mcpTool;
  }

  /**
   * Setup tool handlers for MCP requests
   */
  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map(tool =>
        this.toolDefinitionToMCPTool(tool)
      );

      return { tools };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const tool = this.tools.get(name);

        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }

        const result = tool.handler(args || {});

        const content: TextContent[] = [
          {
            type: 'text',
            text: result || 'Command executed successfully',
          },
        ];

        const response: CallToolResult = {
          content,
        };

        return response;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        const content: TextContent[] = [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ];

        const response: CallToolResult = {
          content,
          isError: true,
        };

        return response;
      }
    });
  }

  /**
   * Start the MCP server
   */
  public async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Versioner MCP server running on stdio');
  }
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  const server = new VersionerMCPServer();
  await server.run();
}