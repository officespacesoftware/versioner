# Release Management MCP

Git Flow Release Management MCP Server with AI-powered workflow orchestration.

This MCP server provides intelligent release management workflows that follow Git Flow patterns, integrating with the versioner-mcp for version management operations.

## Overview

This is a TypeScript implementation that provides Git Flow release management functionality with AI-powered workflow orchestration, designed to work seamlessly with AI assistants through the Model Context Protocol.

## Installation & Quick Start

### 🚀 One-Time Use (Recommended)

Execute directly without installing using any package manager:

```bash
# npm (Node.js 18+)
npx @officespacesoftware/release-management-mcp

# pnpm (fastest)
pnpm dlx @officespacesoftware/release-management-mcp

# Bun (fastest alternative)
bunx @officespacesoftware/release-management-mcp

# Yarn
yarn dlx @officespacesoftware/release-management-mcp
```

### 📦 Global Installation

Install globally for repeated use:

```bash
# from source
npm run build
npm install -g .

# npm
npm install -g @officespacesoftware/release-management-mcp

# pnpm
pnpm add -g @officespacesoftware/release-management-mcp

# Bun
bun add -g @officespacesoftware/release-management-mcp

# Yarn
yarn global add @officespacesoftware/release-management-mcp
```

### 🏗️ Development Setup

For contributing or local development:

```bash
# Clone repository
git clone git@github.com:officespacesoftware/versioner.git
cd versioner/release-management-mcp

# Development with npm
npm install
npm run build

# Or with Bun (recommended for faster development)
bun install
bun run build
```

## MCP Server Setup

### 🤖 Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "release-management": {
      "command": "npx",
      "args": [
        "--yes",
        "-p",
        "@officespacesoftware/release-management-mcp",
        "release-management-mcp"
      ]
    }
  }
}
```

**Setup with global installation:**

```json
{
  "mcpServers": {
    "release-management": {
      "command": "release-management-mcp"
    }
  }
}
```

### 💻 Claude Code

```sh
claude mcp add-json release-management '{"type":"stdio","command":"release-management-mcp"}'
```

### 🖱️ Cursor and Other Editors

For Cursor or other MCP-compatible editors, add to your MCP configuration:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "release-management-mcp",
      "args": []
    }
  }
}
```

### 🛠️ Setup from Source

For development or custom installations:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "node",
      "args": [
        "/path/to/versioner/release-management-mcp/bin/release-management-mcp"
      ]
    }
  }
}
```

## Features

- **Git Flow Workflow Orchestration**: Complete 5-step minor release candidate process
- **Branch Validation**: Automatic main/develop synchronization verification
- **Version Management Integration**: Seamless connection with versioner-mcp
- **Release Branch Management**: Automated creation and management of release branches
- **Pull Request Integration**: Automated PR creation via gh CLI
- **Dry Run Support**: Test workflows without making changes
- **Real-time Progress Tracking**: Detailed step-by-step workflow progress
- **Intelligent Error Handling**: Comprehensive error detection and reporting

## Usage

### Available Tools

#### `health_check`
Check the health and status of the Release Management MCP server:

```javascript
// Returns server status, capabilities, and version information
```

#### `create_minor_rc`
Execute the complete Git Flow minor release candidate workflow:

```javascript
{
  "workingDirectory": "/path/to/project",  // optional, defaults to current directory
  "dryRun": true                          // optional, defaults to false
}
```

### ⚡ Quick Examples

```bash
# Start the MCP server directly
release-management-mcp

# Or use with npx for one-time execution
npx @officespacesoftware/release-management-mcp
```

When connected to an AI assistant, you can:
- Ask to "create a minor release candidate"
- Request "health check of release management server"
- Run workflows with "create minor RC in dry run mode"

## Git Flow Workflow

The `create_minor_rc` tool follows this 5-step process:

1. **Verify Branch Synchronization**: Ensures main has been merged into develop
2. **Checkout Develop**: Switches to develop branch and pulls latest changes
3. **Create Release Branch**: Creates new release branch (release/X.Y.0)
4. **Update Version**: Uses versioner-mcp to bump to minor release candidate
5. **Push Changes**: Pushes release branch and version tag to origin

## Requirements

- **Node.js**: Version 18.0.0 or higher
- **Git**: For repository operations
- **versioner-mcp**: Must be available for version management operations
- **gh CLI**: Optional, for automated pull request creation

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run dev:test

# Build project
npm run build

# Development with watch mode
npm run dev
```

### Project Structure

```
release-management-mcp/
├── src/
│   ├── index.ts              # Main MCP server
│   ├── release-agent.ts      # Workflow orchestration
│   ├── versioner-adapter.ts  # Version management integration
│   ├── mcp-client.ts         # MCP protocol client
│   └── git-flow.ts          # Git operations
├── lib/                      # Compiled JavaScript
├── bin/
│   └── release-management-mcp # Executable
└── test/                     # Test files
```

## Compatibility

### Runtime Compatibility
- **Production**: Node.js 18+
- **Development**: Node.js 18+ or Bun
- **Library Code**: Uses only Node.js built-ins for maximum compatibility

### Integration Compatibility
- ✅ Claude Desktop
- ✅ Claude Code
- ✅ Cursor
- ✅ Any MCP-compatible AI assistant
- ✅ Works alongside versioner-mcp
- ✅ Compatible with existing Git workflows

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Build: `npm run build`
6. Commit your changes (`git commit -am 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## License

MIT License - see the LICENSE file for details.
