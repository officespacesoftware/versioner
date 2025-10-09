# Versioner MCP Server

Model Context Protocol (MCP) server for [Versioner](https://github.com/officespacesoftware/versioner) - Git-integrated version management for your projects.

## Overview

This package provides an MCP server that exposes Versioner's functionality as tools for AI assistants. It allows AI models to manage semantic versioning, release candidates, and Git tags through a standardized interface.

## Features

- Full semantic versioning support (major.minor.patch)
- Release candidate workflow management
- Git integration with automatic commits and tags
- Compatible with any MCP-enabled AI assistant

## Installation

```bash
npm install @officespacesoftware/versioner-mcp
```

## Usage

### As an MCP Server

The versioner-mcp server can be used with any MCP-compatible client:

```bash
npx versioner-mcp
```

### Available Tools

The MCP server exposes the following tools:

- `versioner_init` - Initialize project with VERSION file
- `versioner_show` - Display current version
- `versioner_patch` - Create patch release (n.n.X)
- `versioner_minor` - Create minor release (n.X.n)
- `versioner_major` - Create major release (X.n.n)
- `versioner_patch_rc` - Create patch release candidate
- `versioner_minor_rc` - Create minor release candidate
- `versioner_major_rc` - Create major release candidate
- `versioner_increment_rc` - Increment release candidate
- `versioner_release` - Release current RC as stable version

### Configuration with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "versioner": {
      "command": "npx",
      "args": ["@officespacesoftware/versioner-mcp"]
    }
  }
}
```

### Configuration with Other MCP Clients

Refer to your MCP client's documentation for configuration details. The server communicates via stdio.

## Workflow Example

1. **Initialize a project:**
   ```
   Tool: versioner_init
   Args: { "version": "0.1.0-RC.0" }
   ```

2. **Create release candidates:**
   ```
   Tool: versioner_minor_rc
   Result: Version 0.2.0-RC.0 created
   ```

3. **Increment RC after testing:**
   ```
   Tool: versioner_increment_rc
   Result: Version 0.2.0-RC.1 created
   ```

4. **Release when ready:**
   ```
   Tool: versioner_release
   Result: Version 0.2.0 released
   ```

## Requirements

- Node.js >= 14.0.0
- Git repository initialized in the working directory
- Write access to create VERSION file and Git commits/tags

## Dependencies

This package depends on:
- `@officespacesoftware/versioner` - Core versioning functionality
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `zod` - Runtime type validation

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run in development mode
npm run dev
```

## License

MIT

## Author

Esteban Trejos

## Repository

[GitHub - versioner-mcp](https://github.com/officespacesoftware/versioner/tree/main/versioner-mcp)

## Issues

Report issues at: [GitHub Issues](https://github.com/officespacesoftware/versioner/issues)