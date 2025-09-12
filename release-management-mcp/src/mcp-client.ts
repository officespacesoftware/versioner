/**
 * MCP Client for discovering and interacting with versioner-mcp tools
 */

import { spawn } from 'child_process';
import { z } from 'zod';

// Define the structure of MCP tool responses
const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()).optional(),
  }),
});

const MCPListToolsResponseSchema = z.object({
  tools: z.array(MCPToolSchema),
});

const MCPCallToolResponseSchema = z.object({
  content: z.array(z.object({
    type: z.literal('text'),
    text: z.string(),
  })),
  isError: z.boolean().optional(),
});

export type MCPTool = z.infer<typeof MCPToolSchema>;
export type MCPCallToolResponse = z.infer<typeof MCPCallToolResponseSchema>;

/**
 * Client for interacting with MCP servers via stdio
 */
export class MCPClient {
  private serverProcess: any = null;
  private messageId = 0;

  /**
   * Connect to an MCP server using stdio transport
   */
  async connect(serverCommand: string, workingDirectory?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Parse the server command
        const parts = serverCommand.split(' ');
        const command = parts[0];
        const args = parts.slice(1);

        this.serverProcess = spawn(command!, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: workingDirectory || process.cwd(),
        });

        this.serverProcess.on('error', (error: Error) => {
          reject(new Error(`Failed to start MCP server: ${error.message}`));
        });

        this.serverProcess.on('spawn', () => {
          resolve();
        });

        // Handle stderr for debugging
        this.serverProcess.stderr.on('data', (data: Buffer) => {
          console.error(`MCP Server stderr: ${data.toString()}`);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Discover available tools from the connected MCP server
   */
  async discoverTools(): Promise<MCPTool[]> {
    if (!this.serverProcess) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    const request = {
      jsonrpc: '2.0',
      id: ++this.messageId,
      method: 'tools/list',
      params: {},
    };

    const response = await this.sendRequest(request);
    
    try {
      const parsed = MCPListToolsResponseSchema.parse(response.result);
      return parsed.tools;
    } catch (error) {
      throw new Error(`Invalid tools/list response: ${error}`);
    }
  }

  /**
   * Call a tool on the connected MCP server
   */
  async callTool(toolName: string, args: Record<string, any> = {}): Promise<MCPCallToolResponse> {
    if (!this.serverProcess) {
      throw new Error('MCP client not connected. Call connect() first.');
    }

    const request = {
      jsonrpc: '2.0',
      id: ++this.messageId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await this.sendRequest(request);
    
    try {
      return MCPCallToolResponseSchema.parse(response.result);
    } catch (error) {
      throw new Error(`Invalid tools/call response: ${error}`);
    }
  }

  /**
   * Send a JSON-RPC request to the MCP server
   */
  private async sendRequest(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.serverProcess) {
        reject(new Error('MCP client not connected'));
        return;
      }

      const requestString = JSON.stringify(request) + '\n';
      
      // Set up one-time response handler
      let responseData = '';
      
      const onData = (data: Buffer) => {
        const chunk = data.toString();
        responseData += chunk;
        
        // Look for JSON-RPC responses in the accumulated data
        const lines = responseData.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const response = JSON.parse(line.trim());
            
            // Verify this is the response to our request
            if (response.id === request.id && response.jsonrpc === '2.0') {
              this.serverProcess.stdout.removeListener('data', onData);
              
              if (response.error) {
                reject(new Error(`MCP Server Error: ${response.error.message || JSON.stringify(response.error)}`));
              } else {
                resolve(response);
              }
              return;
            }
          } catch (e) {
            // Not a valid JSON line, continue
          }
        }
      };

      this.serverProcess.stdout.on('data', onData);
      
      // Send the request
      this.serverProcess.stdin.write(requestString);
      
      // Set a timeout
      setTimeout(() => {
        this.serverProcess.stdout.removeListener('data', onData);
        reject(new Error(`MCP request timeout for method: ${request.method}`));
      }, 10000); // 10 second timeout
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }
}

/**
 * Versioner MCP Client - specialized client for versioner-mcp operations
 */
export class VersionerMCPClient {
  private mcpClient: MCPClient;
  private availableTools: MCPTool[] = [];

  constructor() {
    this.mcpClient = new MCPClient();
  }

  /**
   * Connect to the versioner-mcp server and discover available tools
   */
  async connect(versionerMCPCommand?: string, workingDirectory?: string): Promise<void> {
    // Default command to run versioner-mcp
    const command = versionerMCPCommand || 'node /Volumes/Projects/versioner/node/bin/versioner-mcp';
    
    try {
      await this.mcpClient.connect(command, workingDirectory);
      this.availableTools = await this.mcpClient.discoverTools();
      
      console.log(`Connected to versioner-mcp. Available tools: ${this.availableTools.map(t => t.name).join(', ')}`);
      if (workingDirectory) {
        console.log(`Versioner-mcp running in directory: ${workingDirectory}`);
      }
    } catch (error) {
      throw new Error(`Failed to connect to versioner-mcp: ${error}`);
    }
  }

  /**
   * Get the list of available versioner tools
   */
  getAvailableTools(): MCPTool[] {
    return this.availableTools;
  }

  /**
   * Check if versioner-mcp is connected and ready
   */
  isConnected(): boolean {
    return this.availableTools.length > 0;
  }

  /**
   * Call a versioner tool
   */
  async callVersionerTool(toolName: string, args: Record<string, any> = {}): Promise<string> {
    const tool = this.availableTools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Versioner tool '${toolName}' not found. Available tools: ${this.availableTools.map(t => t.name).join(', ')}`);
    }

    try {
      const response = await this.mcpClient.callTool(toolName, args);
      
      if (response.isError) {
        throw new Error(`Versioner tool error: ${response.content[0]?.text || 'Unknown error'}`);
      }

      return response.content[0]?.text || 'Success';
    } catch (error) {
      throw new Error(`Failed to call versioner tool '${toolName}': ${error}`);
    }
  }

  /**
   * Show current version
   */
  async showVersion(): Promise<string> {
    return this.callVersionerTool('versioner_show');
  }

  /**
   * Create a major release candidate
   */
  async createMajorRC(): Promise<string> {
    return this.callVersionerTool('versioner_major_rc');
  }

  /**
   * Create a minor release candidate
   */
  async createMinorRC(): Promise<string> {
    return this.callVersionerTool('versioner_minor_rc');
  }

  /**
   * Create a patch release candidate
   */
  async createPatchRC(): Promise<string> {
    return this.callVersionerTool('versioner_patch_rc');
  }

  /**
   * Initialize versioner (if needed)
   */
  async initialize(version?: string): Promise<string> {
    const args = version ? { version } : {};
    return this.callVersionerTool('versioner_init', args);
  }

  /**
   * Disconnect from versioner-mcp
   */
  async disconnect(): Promise<void> {
    await this.mcpClient.disconnect();
    this.availableTools = [];
  }
}