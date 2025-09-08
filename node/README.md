# Versioner (Node.js)

A Node.js/JavaScript implementation of the versioner tool for Git-integrated semantic version management.

## Overview

This is a pure JavaScript implementation that provides the same functionality as the Ruby version, with the added benefit of using Bun for development and testing while maintaining full Node.js compatibility.

## Installation

### For Development (with Bun)

```bash
git clone git@github.com:officespacesoftware/versioner.git
cd versioner/node
bun install
```

### For Production (with Node.js)

```bash
git clone git@github.com:officespacesoftware/versioner.git
cd versioner/node
npm install -g .
```

Or install directly from the repository:

```bash
npm install -g git+https://github.com/officespacesoftware/versioner.git#node
```

## Usage

### Command Line Interface

After installation, use the `versioner` command:

```bash
# Initialize project with VERSION file
versioner init [VERSION]

# Version increment commands
versioner patch                  # Create patch-level release (n.n.X)
versioner minor                  # Create minor-level release (n.X.n)
versioner major                  # Create major-level release (X.n.n)

# Release candidate commands  
versioner patch-rc               # Create patch-level RC (n.n.X-RC.0)
versioner minor-rc               # Create minor-level RC (n.X.n-RC.0)
versioner major-rc               # Create major-level RC (X.n.n-RC.0)
versioner increment-rc           # Increment RC number (n.n.n-RC.X)
versioner release                # Release current RC (remove RC suffix)

# Utility commands
versioner show                   # Display current version
versioner help                  # Show help information
```

### Programmatic API

```javascript
import { VersionFile, tasks } from 'versioner';

// Using VersionFile class directly
const vf = new VersionFile('./VERSION');
console.log(vf.version());        // "1.2.3"
vf.patch();                       // Increment to "1.2.4"

// Using task functions
import { patch, minor, show } from 'versioner';

const newVersion = patch();       // Increment patch and commit/tag
console.log(show());              // Display current version
```

### Environment Variables

- `VERSION`: Default version for `init` command

```bash
VERSION=2.0.0-RC.1 versioner init
```

## Development

This project uses **Bun** for development and testing, but the library code uses only Node.js built-ins for compatibility.

### Development Setup

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone and setup
git clone git@github.com:officespacesoftware/versioner.git
cd versioner/node
bun install
```

### Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test test/version-file.test.js
```

### Project Structure

```
node/
├── lib/
│   ├── index.js           # Main entry point
│   ├── version-file.js    # Core VersionFile class
│   ├── tasks.js          # Task functions (patch, minor, etc.)
│   ├── options.js        # Configuration management
│   ├── file-utils.js     # File I/O utilities
│   ├── git-utils.js      # Git integration
│   └── version-parser.js # Semantic version parsing
├── bin/
│   └── versioner         # CLI script
├── test/
│   ├── version-file.test.js # Core functionality tests
│   ├── cli.test.js       # CLI integration tests
│   └── fixtures/         # Test fixtures
└── package.json
```

## VERSION File Format

Both Ruby and Node.js implementations use the same file format:

```
1.2.3
abc123
```

- Line 1: Version string (e.g., "1.2.3" or "1.2.3-RC.1")
- Line 2: Git commit hash (short format)

This ensures full compatibility between implementations.

## Compatibility

### Runtime Compatibility

- **Development**: Bun (recommended for faster testing)
- **Production**: Node.js 14+ or Bun
- **Library Code**: Uses only Node.js built-ins (fs, child_process, path)

### Feature Compatibility

This Node.js implementation provides identical functionality to the Ruby version:

- ✅ Semantic versioning (major.minor.patch)
- ✅ Release candidate workflow
- ✅ Git integration (commits and tags)
- ✅ Same VERSION file format
- ✅ Same CLI commands and behavior
- ✅ Same error handling and validation

### Migration from Ruby Version

No migration required! Both versions:
- Use the same VERSION file format
- Create identical Git commits and tags
- Follow the same versioning rules
- Share the same project configuration

You can switch between Ruby and Node.js versions seamlessly.

## API Reference

### VersionFile Class

```javascript
import { VersionFile } from 'versioner';

// Constructor
const vf = new VersionFile(filePath);     // Use specific file
const vf = new VersionFile();             // Use default 'VERSION'

// Static methods
VersionFile.create({ version, path });    // Create new VERSION file

// Instance methods
vf.version()                              // Get current version
vf.shortVersion()                         // Get version without RC suffix
vf.isReleaseCandidate()                   // Check if RC
vf.patch()                                // Increment patch
vf.minor()                                // Increment minor
vf.major()                                // Increment major
vf.patchReleaseCandidate()                // Create patch RC
vf.minorReleaseCandidate()                // Create minor RC
vf.majorReleaseCandidate()                // Create major RC
vf.incrementReleaseCandidate()            // Increment RC number
vf.release()                              // Release RC
```

### Task Functions

```javascript
import { 
  init, patch, minor, major,
  patchReleaseCandidate, minorReleaseCandidate, majorReleaseCandidate,
  incrementReleaseCandidate, release, show
} from 'versioner';

// All functions return the new version string
// All functions (except init and show) require existing VERSION file
```

### Utility Modules

```javascript
import { options, fileUtils, gitUtils, versionParser } from 'versioner';

// Configuration
options.setOption('version_file_path', 'custom/VERSION');
options.getVersionFilePath();

// File operations
fileUtils.readVersionFile(path);
fileUtils.writeVersionFile(path, version, hash);

// Git operations  
gitUtils.getShortCommitHash();
gitUtils.gitAdd(file);
gitUtils.gitCommit(message);
gitUtils.gitTag(tag, message);

// Version parsing
versionParser.parseVersion('1.2.3-RC.1');
versionParser.formatVersion(versionObj);
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `bun test`
5. Commit your changes (`git commit -am 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see the LICENSE file for details.