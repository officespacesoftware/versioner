# JavaScript workspace

A pnpm workspace (`versioner-js-workspace`, private) holding the four
`@officespacesoftware` packages. `pnpm-workspace.yaml` includes `packages/*`.

| Package | Directory | Version | Entry points |
| --- | --- | --- | --- |
| [`@officespacesoftware/versioner`](packages/versioner/README.md) | `packages/versioner` | `0.5.0-RC.0` | `lib/index.js`, bin `versioner` |
| [`@officespacesoftware/release-management-core`](packages/release-management-core/README.md) | `packages/release-management-core` | `0.5.0-RC.1` | `lib/index.js` + `lib/index.d.ts` |
| [`@officespacesoftware/release-management-cli`](packages/release-management-cli/README.md) | `packages/release-management-cli` | `0.3.0-RC.1` | `lib/cli.js`, bin `release-management` |
| [`@officespacesoftware/release-management-mcp`](packages/release-management-mcp/README.md) | `packages/release-management-mcp` | `0.5.0-RC.1` | `lib/index.js`, bin `release-management-mcp` |

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

The current line of all four packages is a prerelease on the `next` dist-tag. Install with
`@next`, or pin an exact version; `latest` is reserved for stable releases and will move
away from this line as soon as one is published.

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

## The packages

Each package documents its own install, surface and use. This file covers the workspace
they share.

### [`@officespacesoftware/versioner`](packages/versioner/README.md)

The version-mutation layer: it owns the `VERSION` file and creates the version commit and
annotated tag. A `versioner` CLI and a library, pure ESM with no dependencies and no build
step.

```sh
npx @officespacesoftware/versioner@next show
```

### [`@officespacesoftware/release-management-core`](packages/release-management-core/README.md)

The orchestration layer, exporting `GitFlowManager`, `ReleaseAgent`, `VersionerAdapter`,
`VersionerDirectClient`, the change-plan helpers and the shared guards. It depends on
`@octokit/rest`, `@octokit/graphql`, `js-yaml` and the versioner package; nothing in it
imports `commander` or the MCP SDK, which is what keeps the two front-ends
interchangeable.

### [`@officespacesoftware/release-management-cli`](packages/release-management-cli/README.md)

A `commander` CLI over the core, for shells and GitHub Actions. Twelve commands, global
`--json` and `--quiet`, results appended to `$GITHUB_OUTPUT`.

```sh
npx -p @officespacesoftware/release-management-cli@next release-management --help
```

### [`@officespacesoftware/release-management-mcp`](packages/release-management-mcp/README.md)

A Model Context Protocol stdio server over the core, exposing thirteen tools to AI
assistants. Its README carries the setup recipes for **Claude Code, Codex and Cursor**,
from the registry or from a local build, along with what each credential is for.

```sh
claude mcp add release-management --scope user \
  -- npx --yes @officespacesoftware/release-management-mcp@next
```

Both front-ends share one protocol for describing a change before making it: called without
an apply flag or confirmation digest, a mutating action reports the git objects it would
create and changes nothing. See
[../docs/actions.md](../docs/actions.md#the-planconfirm-protocol) for the protocol and
[../docs/actions.md](../docs/actions.md) for every action's ordered steps.

## Publishing

`scripts/release.mjs` bumps one package, commits, and tags:

```sh
pnpm release release-management-core 1.3.0
```

It validates that the version is semver-shaped and higher than the current one, writes
`package.json`, commits `Release <name>@<version>`, and creates the tag
`<name>@<version>`. Pass `--allow-downgrade` to renumber a package downwards on purpose.

Push that tag — and only that tag, since `git push --tags` would try to move older package
tags whose local and remote refs have diverged. It triggers
`.github/workflows/publish-js.yml`, which verifies the tag version matches `package.json`,
builds the workspace, and publishes to GitHub Packages.

A **stable** version must sit on a commit reachable from `origin/master`. A **prerelease**
(`0.5.0-RC.0`) is exempt: it publishes from any branch under the `next` dist-tag, so an
unfinished API can be exercised by real consumers before it is merged, without moving
`latest` off the last stable release.

Where there is no stable release to protect, the workflow also points `latest` at the
prerelease — holding it back on a package that has never published a stable version only
aims a plain `npm install` at nothing. All four packages are in that state today, so
`latest` and `next` resolve to the same version. The first stable publish claims `latest`
permanently. Install with `@next` either way: it is the tag that keeps meaning "the current
prerelease" once a stable line exists.

## Requirements

- Node.js 18 or newer (14 or newer for `@officespacesoftware/versioner` on its own)
- pnpm 9 or newer for workspace development
- Git
- A GitHub token, or an authenticated `gh` CLI, for any action that opens a pull request or
  creates a release

## License

MIT License — see the LICENSE file for details.
