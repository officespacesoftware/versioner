# JavaScript workspace

A pnpm workspace (`versioner-js-workspace`, private) holding the four
`@officespacesoftware` packages. `pnpm-workspace.yaml` includes `packages/*`.

| Package | Directory | Version | Entry points |
| --- | --- | --- | --- |
| `@officespacesoftware/versioner` | `packages/versioner` | `1.0.1` | `lib/index.js`, bin `versioner` |
| `@officespacesoftware/release-management-core` | `packages/release-management-core` | `1.2.0` | `lib/index.js` + `lib/index.d.ts` |
| `@officespacesoftware/release-management-cli` | `packages/release-management-cli` | `0.2.0` | `lib/cli.js`, bin `release-management` |
| `@officespacesoftware/release-management-mcp` | `packages/release-management-mcp` | `0.4.0` | `lib/index.js`, bin `release-management-mcp` |

The core depends on the versioner package; the CLI and MCP depend on the core. Nothing
depends on the CLI or the MCP. See
[../docs/architecture.md](../docs/architecture.md) for the dependency graph and layer
boundaries, and [../docs/actions.md](../docs/actions.md) for every action and the git
objects it creates.

Requirements: Node `>=18` and pnpm `>=9` for the workspace; the versioner package alone
declares Node `>=14`.

## Registry

All four packages publish to GitHub Packages (`https://npm.pkg.github.com`, access
`restricted`), and the repository-root `.npmrc` points the scope there:

```
@officespacesoftware:registry=https://npm.pkg.github.com
```

To install them elsewhere, add the same line to your project's `.npmrc` and provide a
token with `read:packages`:

```
@officespacesoftware:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Workspace commands

Run these from `js/`:

```sh
pnpm install --frozen-lockfile   # install
pnpm build                       # pnpm -r build
pnpm typecheck                   # pnpm -r build (tsc in every TypeScript package)
pnpm test                        # pnpm -r test
pnpm clean                       # pnpm -r clean
pnpm dev                         # pnpm -r --parallel dev (tsc --watch)
pnpm release <package-dir> <version>
```

Per-package scripts:

| Package | `build` | `test` | `dev` | `clean` |
| --- | --- | --- | --- | --- |
| `versioner` | placeholder echo (pure JS, no build) | `node --test test/*.test.js` | `dev:test` — `node --test --watch test/*.test.js` | — |
| `release-management-core` | `tsc` | `node --test test/*.test.mjs`, preceded by `pretest: tsc` | `tsc --watch` | `rm -rf lib/` |
| `release-management-cli` | `tsc` | — | `tsc --watch` | `rm -rf lib/` |
| `release-management-mcp` | `tsc` | — | `tsc --watch` | `rm -rf lib/` |

`pnpm test` therefore exercises the versioner and core packages. The CLI and MCP packages
are covered by `pnpm typecheck`.

TypeScript packages compile `src/` to `lib/` with declaration files, extending
`tsconfig.base.json` (ES2022, `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`). The versioner
package is plain ESM JavaScript with no compile step.

## `@officespacesoftware/versioner`

The version-mutation layer: it owns the `VERSION` file and creates the version commit and
annotated tag. Full documentation in
[packages/versioner/README.md](packages/versioner/README.md).

```sh
npx @officespacesoftware/versioner init
npx @officespacesoftware/versioner show
```

## `@officespacesoftware/release-management-core`

The orchestration layer. It exports `GitFlowManager`, `ReleaseAgent`, `VersionerAdapter`,
`VersionerDirectClient`, the change-plan helpers, the shared guards, and their types:

```ts
import {
  GitFlowManager,
  ReleaseAgent,
  VersionerAdapter,
  MergeConflictError,
  BranchSelectionError,
  buildChangePlan,
  renderChangePlan,
  assertPlanIsCurrent,
  StalePlanError,
} from "@officespacesoftware/release-management-core";

const gfm = new GitFlowManager(process.cwd());
const listing = await gfm.listVersions("main"); // read-only
```

It depends on `@octokit/rest`, `@octokit/graphql`, `js-yaml`, and the versioner package.
Nothing in it imports `commander` or the MCP SDK, so both front-ends stay interchangeable.

GitHub credentials resolve in this order: `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`,
`~/.config/gh/hosts.yml`. `owner`/`repo` come from the `origin` remote URL.

## `@officespacesoftware/release-management-cli`

A `commander` CLI, suitable for shells and GitHub Actions.

```sh
npx @officespacesoftware/release-management-cli --help
# or, once installed:
release-management --help
```

Global options: `--json` (structured JSON on stdout) and `--quiet` (suppress progress
logging). There is deliberately no global `--version` flag, because subcommands take
`--version <ver>` as a release version argument.

Commands:

```sh
release-management list-versions            [--production-branch <branch>]
release-management create-rc                [--release-type major|minor|patch]
release-management create-hotfix
release-management increment-rc             [--version <version>]
release-management release-version          [--version <version>]
release-management initialize-versioner     [--version <version>]
release-management downmerge main-to-develop
release-management downmerge release-to-develop  [--version <version>]
release-management downmerge release-to-main     [--version <version>]
release-management downmerge hotfix-to-main      [--version <version>]
```

Every command accepts `--working-directory <path>`, defaulting to the current directory.
The four version workflows — `create-rc`, `create-hotfix`, `increment-rc` and
`release-version` — also accept `--dry-run`.

How mutating commands describe a change before applying it — and the digest that has to be
handed back to apply it — is documented in
[../docs/actions.md](../docs/actions.md#the-planconfirm-protocol). Run
`release-management <command> --help` for the flags a given command takes.

Results are written to `$GITHUB_OUTPUT` when that variable is set, using the inline
`key=value` form for single-line values and the heredoc form for multi-line ones. The keys
each command writes are listed per action in
[../docs/actions.md](../docs/actions.md).

Exit codes: `0` on success, `1` for user errors (not a git repository, staged changes, no
matching branch, a refused branch selection), `2` for everything else. A fourth code, `3`,
is defined for partial success. A fatal parse-time error also exits `2`.

## `@officespacesoftware/release-management-mcp`

A Model Context Protocol stdio server exposing eleven tools: `health_check`,
`list_versions`, `create_release_candidate`, `create_hotfix`,
`increment_release_candidate`, `release_version`, `initialize_versioner`,
`downmerge_main_to_develop`, `downmerge_release_to_develop`,
`downmerge_release_to_main`, and `downmerge_hotfix_to_main`. Each is documented in
[../docs/actions.md](../docs/actions.md).

Every tool takes an optional `workingDirectory`; the server rebinds its `GitFlowManager`
and `ReleaseAgent` whenever that value changes, so consecutive calls can target different
repositories.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "npx",
      "args": ["--yes", "@officespacesoftware/release-management-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add-json release-management '{"type":"stdio","command":"npx","args":["--yes","@officespacesoftware/release-management-mcp"]}'
```

### From a local build

```sh
cd js
pnpm install
pnpm build
```

Then point the client at the built entry point:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "node",
      "args": ["/path/to/versioner/js/packages/release-management-mcp/bin/release-management-mcp"]
    }
  }
}
```

## Publishing

`scripts/release.mjs` bumps one package, commits, and tags:

```sh
pnpm release release-management-core 1.3.0
```

It validates that the version is semver-shaped and higher than the current one, writes
`package.json`, commits `Release <name>@<version>`, and creates the tag
`<name>@<version>`. Pushing that tag triggers
`.github/workflows/publish-js.yml`, which verifies the commit is reachable from
`origin/master`, verifies the tag version matches `package.json`, builds the workspace, and
publishes to GitHub Packages.

## Requirements

- Node.js 18 or newer (14 or newer for `@officespacesoftware/versioner` on its own)
- pnpm 9 or newer for workspace development
- Git
- A GitHub token, or an authenticated `gh` CLI, for any action that opens a pull request or
  creates a release

## License

MIT License — see the LICENSE file for details.
