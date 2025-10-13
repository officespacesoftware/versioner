# Versioner

Version-numbering tasks that create the appropriate Git objects. Available in both Ruby (gem) and Node.js (npm packages) implementations.

## Ruby Gem

The Ruby implementation provides Rake tasks for version management in Ruby and Rails projects.

### Installation

Add this line to your application's Gemfile:

```ruby
gem 'versioner', git: 'git@github.com:officespacesoftware/versioner.git'
```

And then execute:

    $ bundle

Or install it yourself as:

    $ git clone git@github.com:officespacesoftware/versioner.git
    $ cd versioner
    $ gem build versioner.gemspec
    $ gem install versioner-VERSION.gem

### Usage

The tasks are automatically loaded on Rails projects. On non-Rails projects you can add this to your Rakefile:

```ruby
require 'versioner/rake'
```

Then you can run:

```sh
rake version:init                         # initializes the project with the version file (optional VERSION=0.1.0-RC1)
rake version:increment_release_candidate  # increments the current release candidate (n.n.n-RCX)
rake version:major                        # create a new major-level (X.n.n) release
rake version:major_release_candidate      # create a new major-level (X.n.n-RC.0) release candidate
rake version:minor                        # create a new minor-level (n.X.n) release
rake version:minor_release_candidate      # create a new minor-level (n.X.n-RC.0) release candidate
rake version:patch                        # create a new patch-level (n.n.X) release
rake version:patch_release_candidate      # create a new patch-level (n.n.X-RC.0) release candidate
rake version:release                      # releases the current release candidate (n.n.n)
rake version:show                         # print the current version level from the VERSION file
```

### Configuration

You can customize the VERSION file location by adding this to an initializer:

```ruby
require 'versioner/options'
Versioner.options[:version_file_path] = '/some/other/path/VERSION_FILE'
```

## Node.js Packages

The Node.js implementation provides three npm packages for different use cases:

### 1. [@officespacesoftware/versioner](./versioner/README.md)

Core version management CLI tool and library for Node.js projects.

**Quick Start:**
```bash
npx @officespacesoftware/versioner init
npx @officespacesoftware/versioner patch
```

**Use Cases:**
- Command-line version management
- Programmatic API for version operations
- Drop-in replacement for Ruby gem in Node.js projects

**[📚 Full Documentation →](./versioner/README.md)**

### 2. [@officespacesoftware/versioner-mcp](./versioner-mcp/README.md)

Model Context Protocol (MCP) server that exposes versioner commands as tools for AI assistants.

**Quick Start:**
```bash
npx @officespacesoftware/versioner-mcp
```

**Use Cases:**
- AI-assisted version management with Claude Desktop
- Integration with MCP-compatible AI tools
- Automated versioning workflows

**[📚 Full Documentation →](./versioner-mcp/README.md)**

### 3. [@officespacesoftware/release-management-mcp](./release-management-mcp/README.md)

Git Flow Release Management MCP Server with AI-powered workflow orchestration.

**Quick Start:**
```bash
npx @officespacesoftware/release-management-mcp
```

**Use Cases:**
- Git Flow release workflows
- Complex multi-step release orchestration
- AI-assisted release management

**[📚 Full Documentation →](./release-management-mcp/README.md)**

## VERSION File Format

Both Ruby and Node.js implementations use the same VERSION file format, ensuring full compatibility:

- **Line 1:** Version string (e.g., "1.2.3" or "1.2.3-RC.1")
- **Line 2:** Git commit hash (short format)

This allows you to switch between Ruby and Node.js implementations seamlessly without any migration needed.

## License

MIT License - see the LICENSE file for details.
