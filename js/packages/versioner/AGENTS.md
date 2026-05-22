# AGENTS.md - Development Guide for Versioner

## Build/Test Commands
- `npm test` - Run full test suite with Jest (uses NODE_OPTIONS=--experimental-vm-modules)
- `npm test -- test/version-file.test.js` - Run single test file
- `npm run dev:test` - Run tests in watch mode
- No build/lint commands - pure JavaScript, no transpilation

## Code Style
- **Module System**: ES Modules (`import`/`export`, `type: "module"` in package.json)
- **Imports**: Node.js built-ins only (fs, child_process, path, url); use named imports from local modules with `.js` extension
- **JSDoc**: Required for all functions with parameter types, return types, and @throws
- **Naming**: camelCase for functions/variables, PascalCase for classes
- **Error Handling**: Throw descriptive Error objects with user-friendly messages
- **Git Integration**: All version changes auto-commit and tag via git-utils.js
- **Testing**: Jest with @jest/globals imports, describe/test/beforeEach/afterEach structure
- **Private Methods**: Prefix with underscore (e.g., `_loadVersionData()`)

## Architecture Notes
- Core class: `VersionFile` (lib/version-file.js) manages VERSION file operations
- VERSION file format: line 1 = version (e.g. "1.2.3-RC.0"), line 2 = git short hash
- Tasks (lib/tasks.js) combine VersionFile ops with git add/commit/tag
- Release candidate workflow: create RC → increment RC → release (removes -RC suffix)
