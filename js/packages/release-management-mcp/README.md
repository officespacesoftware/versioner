# @officespacesoftware/release-management-mcp

A Model Context Protocol stdio server that gives an AI assistant the Git Flow release
workflow: cut a release candidate, increment it, promote it to a final version, revert one,
and open the pull requests that carry changes between `main`, `develop`, `release/*` and
`hotfix/*`.

Thirteen tools, over the same
[`@officespacesoftware/release-management-core`](../release-management-core/README.md) the
[`release-management` CLI](../release-management-cli/README.md) uses, so an assistant and a
shell script do the same thing.

Every mutating tool follows a **plan/confirm protocol**: called without a digest it
describes the git objects it would create and changes nothing. That is what makes it safe to
hand to an agent.

Node 18 or newer.

## Prerequisites

Two credentials, for two different things. Getting one and not the other is the usual
reason a fresh install does not work.

### 1. Registry access — to install the server

The package publishes to GitHub Packages under a restricted scope, so `npx` cannot fetch it
without auth. In `~/.npmrc`:

```
@officespacesoftware:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` on the `officespacesoftware` organization. Either
export it in the environment your MCP client inherits, or write the token in place of
`${GITHUB_TOKEN}`.

This step is not needed if you [install from a local build](#install-from-a-local-build).

### 2. A GitHub token — for what the server does

The server itself calls the GitHub API to open pull requests and create releases. It
resolves a token from the first non-empty of:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. the output of `gh auth token`
4. `~/.config/gh/hosts.yml` → `github.com.oauth_token`

**Run `gh auth login` once and no client config needs an `env` block at all** — step 3 picks
it up, including from the macOS keychain. `gh` is not required at runtime; it is only one of
four ways to find a token. On a host without `gh`, set `GH_TOKEN` to a PAT with `repo`
scope, as shown in the fallback snippets below.

`owner` and `repo` come from the repository's `origin` remote, which must be a `github.com`
SSH or HTTPS URL.

## Install from GitHub Packages

The current line is a prerelease published under the `next` dist-tag, so **the `@next` in
these commands is required** — a bare package name resolves `latest`, which this line does
not set.

### Claude Code

```sh
claude mcp add release-management \
  --scope user \
  -- npx --yes @officespacesoftware/release-management-mcp@next
```

`--scope user` makes it available in every project. Use `--scope project` instead to write
it to the repository's `.mcp.json` and share it with the team, or omit `--scope` for this
project only.

To check it in to a repository directly, `.mcp.json`:

```json
{
  "mcpServers": {
    "release-management": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@officespacesoftware/release-management-mcp@next"]
    }
  }
}
```

Without `gh` on the host, pass the token explicitly:

```sh
claude mcp add release-management --scope user \
  --env GH_TOKEN=ghp_yourtoken \
  -- npx --yes @officespacesoftware/release-management-mcp@next
```

Verify with `claude mcp list`, then ask the assistant to run a health check.

### Codex

```sh
codex mcp add release-management \
  -- npx --yes @officespacesoftware/release-management-mcp@next
```

Or edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.release-management]
command = "npx"
args = ["--yes", "@officespacesoftware/release-management-mcp@next"]
startup_timeout_sec = 30
```

`startup_timeout_sec` is worth setting: a cold `npx` fetch from GitHub Packages can take
longer than the default budget, and the failure looks like a broken server rather than a
slow download. Warm the cache once with
`npx --yes @officespacesoftware/release-management-mcp@next --help` and subsequent starts
are fast.

Without `gh` on the host:

```toml
[mcp_servers.release-management]
command = "npx"
args = ["--yes", "@officespacesoftware/release-management-mcp@next"]
env = { GH_TOKEN = "ghp_yourtoken" }
startup_timeout_sec = 30
```

or, on the command line, `codex mcp add release-management --env GH_TOKEN=ghp_yourtoken --
npx …`.

A trusted project may also carry its own `.codex/config.toml` with the same block. Verify
with `codex mcp list`.

### Cursor

Cursor has no CLI for this; write the JSON. `.cursor/mcp.json` in the repository for one
project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "npx",
      "args": ["--yes", "@officespacesoftware/release-management-mcp@next"]
    }
  }
}
```

Without `gh` on the host:

```json
{
  "mcpServers": {
    "release-management": {
      "command": "npx",
      "args": ["--yes", "@officespacesoftware/release-management-mcp@next"],
      "env": { "GH_TOKEN": "ghp_yourtoken" }
    }
  }
}
```

Cursor also accepts `"envFile": "/path/to/.env"` on a stdio server, which keeps the token
out of a file you might commit. Enable the server in **Settings → MCP**.

## Install from a local build

For working on the server itself, or running an unpublished change. Build first — `bin/` is
a shim onto `lib/`, which is git-ignored, so an unbuilt clone will not start:

```sh
git clone git@github.com:officespacesoftware/versioner.git
cd versioner/js
pnpm install
pnpm build
```

Then point the client at the built entry point by **absolute** path. Substitute your own
clone location for `/path/to/versioner`.

**Claude Code**

```sh
claude mcp add release-management-local --scope user \
  -- node /path/to/versioner/js/packages/release-management-mcp/bin/release-management-mcp
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.release-management-local]
command = "node"
args = ["/path/to/versioner/js/packages/release-management-mcp/bin/release-management-mcp"]
```

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "release-management-local": {
      "command": "node",
      "args": [
        "/path/to/versioner/js/packages/release-management-mcp/bin/release-management-mcp"
      ]
    }
  }
}
```

Naming the local server distinctly — `release-management-local` — lets you keep the
published one registered alongside it and tell from the tool namespace which you are
talking to.

After changing the source, `pnpm build` again and **restart the client**: the server is a
long-lived stdio process and will not pick up a rebuild on its own.

## Verifying the install

Ask the assistant to run `health_check`, or to list the release branches with
`list_versions` — both are read-only and neither touches the repository.

`health_check` answers with the server name, its package version, the commit and time it
was built from, and its capability list:

```json
{
  "server": "Release Management MCP Server",
  "version": "0.5.0-RC.1",
  "build": { "commit": "d239ec470d1", "time": "2026-08-06T14:02:11.417Z" },
  "status": "healthy",
  "timestamp": "2026-08-06T14:05:44.902Z",
  "capabilities": ["..."]
}
```

The `build` fields are the useful part when you have both a published and a local server
registered: the package version alone cannot tell you which copy answered. A commit
suffixed `-dirty` was built from an uncommitted working tree — which is exactly what you
want to know when a fix appears not to have taken effect.

## Tools

Thirteen tools. Full step-by-step behaviour and the exact git objects each creates are in
[docs/actions.md](../../../docs/actions.md); each row links to its section.

| Tool | Inputs beyond `workingDirectory` | What it does |
| --- | --- | --- |
| [`health_check`](../../../docs/actions.md#health_check) | *none* | Reports that the server is responsive. Reads nothing. |
| [`list_versions`](../../../docs/actions.md#list_versions--read-only) | `productionBranch` | Every release/hotfix branch with its version, tag presence and merge status. Read-only. |
| [`create_release_candidate`](../../../docs/actions.md#create_release_candidate) | `confirm`, `releaseType`, `dryRun` | Cuts `release/X.Y.0` off `develop` at `RC.0`. |
| [`create_hotfix`](../../../docs/actions.md#create_hotfix) | `confirm`, `dryRun` | Cuts `hotfix/X.Y.Z` off the production branch at `RC.0`. |
| [`increment_release_candidate`](../../../docs/actions.md#increment_release_candidate) | `confirm`, `version`, `dryRun` | Bumps the RC suffix on a release or hotfix branch. |
| [`release_version`](../../../docs/actions.md#release_version) | `confirm`, `version`, `dryRun` | Promotes an RC to a final version, tags it, creates the GitHub release. |
| [`revert_version`](../../../docs/actions.md#revert_version) | `confirm`, `version`, `dryRun` | Undoes the most recent version bump and deletes its tag. |
| [`initialize_versioner`](../../../docs/actions.md#initialize_versioner) | `version` | Creates the `VERSION` file and its initial tag. Local only. |
| [`downmerge_main_to_develop`](../../../docs/actions.md#downmerge_main_to_develop) | `confirm` | PRs `main` → `develop` via a merge branch. |
| [`downmerge_release_to_develop`](../../../docs/actions.md#downmerge_release_to_develop) | `confirm`, `version` | PRs `release` → `develop`; direct when clean, merge branch plus build trigger when not. |
| [`downmerge_release_to_main`](../../../docs/actions.md#downmerge_release_to_main) | `confirm`, `version` | PRs `release` → `main` via a merge branch, never with `head=release/*`. |
| [`downmerge_hotfix_to_develop`](../../../docs/actions.md#downmerge_hotfix_to_develop) | `confirm`, `version` | PRs `hotfix` → `develop` via a merge branch. |
| [`downmerge_hotfix_to_main`](../../../docs/actions.md#downmerge_hotfix_to_main) | `confirm`, `version` | PRs `hotfix` → `main`. |

`releaseType` is `major`, `minor` or `patch`, defaulting to `minor`. `version` identifies
which branch to act on; when omitted, the newest matching branch on the upstream repository
is selected — except for `revert_version`, which deliberately has no automatic fallback and
uses the checked-out branch instead, because it deletes tags.

No tool declares a `required` array, so every field is optional and an assistant can call
any of them with no arguments at all. The tool descriptions note that `version`, when
supplied, must come from a human rather than being guessed.

### The plan/confirm protocol

Omit `confirm` and a mutating tool returns a plan — the branches, commits, tags, pushes,
pull requests and releases it would create or delete, any warnings, and a digest:

```
📋 Plan — nothing has been changed yet

Action:  release_version
Branch:  release/1.4.0 (at 8f2c1e0a9b3)
Version: 1.4.0-RC.2 → 1.4.0

Would create:
  Commit: To version 1.4.0
  Tag: annotated tag 1.4.0
  …

Nothing has been changed. To apply, confirm with digest: 3f2a1b0c9d8e
```

Call the same tool again with `confirm: "3f2a1b0c9d8e"` to apply it. The digest covers the
target branch's `HEAD` and the plan's warnings, so if anyone pushed to the branch, or a tag
or pull request appeared in the meantime, the confirm is refused and a fresh plan comes
back instead. Nothing is changed by a refusal.

`dryRun` validates without changing anything, but prefer omitting `confirm` — planning is
guaranteed not to mutate.

Documented in full at
[docs/actions.md](../../../docs/actions.md#the-planconfirm-protocol).

### `workingDirectory`

Every tool takes an optional `workingDirectory`, defaulting to the server process's current
directory. The server rebinds its `GitFlowManager` and `ReleaseAgent` whenever that value
changes, so consecutive calls can target different repositories from one server instance.

In practice, pass the repository root explicitly. An MCP server's cwd is whatever its client
started it in, which is not always the project you are asking about.

## Troubleshooting

**`E404` or `ENEEDAUTH` when the server starts.** `npx` cannot reach the restricted scope.
Check `~/.npmrc` has both lines from [Registry access](#1-registry-access--to-install-the-server)
and that the token has `read:packages`. Test outside the client:
`npx --yes @officespacesoftware/release-management-mcp@next --help`.

**`No matching version found`.** The `@next` suffix is missing. This line publishes under
the `next` dist-tag and does not set `latest`.

**"No GitHub token available".** Nothing in the four-step resolution order produced one. Run
`gh auth login`, or add `GH_TOKEN` to the server's `env` in your client config. Note that a
GUI-launched client may not inherit a shell-exported variable — the `env` block is the
reliable route there.

**Server times out on startup.** A cold `npx` download is the usual cause. Raise
`startup_timeout_sec` (Codex), or pre-warm the cache with one manual `npx` run.

**Tools report a stale version, or a fix seems not to have applied.** Run `health_check` and
read `build.commit`. If it is not the commit you expect, the client is running a different
copy — rebuild and restart it. A `-dirty` suffix means the build came from an uncommitted
tree.

**A tool reports "not a git repository" for a repository that plainly is.** The server's cwd
is not where you think. Pass `workingDirectory` explicitly.

**Garbled JSON-RPC or a client that drops the connection.** Over stdio, stdout is the
protocol channel; anything else written there corrupts the stream. The server redirects
`console.log`/`info`/`debug` to stderr before connecting the transport, because the core
library logs progress with `console.log` for the CLI's benefit. If you are patching the
server, keep new output on stderr.

## Development

From this directory:

```sh
pnpm build         # prebuild writes src/build-info.ts, then tsc
pnpm dev           # tsc --watch
pnpm clean         # rm -rf lib/
pnpm start         # node bin/release-management-mcp
```

`pnpm start` is mostly useful for confirming the process comes up: with nothing speaking
JSON-RPC on stdin it will sit and wait. The real check is registering it in a client and
calling `health_check`.

`scripts/write-build-info.mjs` runs as `prebuild` and generates the git-ignored
`src/build-info.ts` with the commit and timestamp `health_check` reports. A published
package is not a git checkout, so the value has to be baked in at build time; in CI,
`GITHUB_SHA` is the authority.

This package has no test suite of its own — it is covered by `pnpm typecheck` at the
workspace root, and the behaviour it exposes is tested in the core package.

```
src/
├── index.ts        # tool declarations and dispatch
└── build-info.ts   # generated at build time, git-ignored
```

## Related documentation

- [../../../docs/actions.md](../../../docs/actions.md) — every tool, its ordered steps, and
  the exact git objects it creates
- [../../../docs/architecture.md](../../../docs/architecture.md) — where this package sits
  in the wider system
- [../release-management-core/README.md](../release-management-core/README.md) — the library
  underneath
- [../release-management-cli/README.md](../release-management-cli/README.md) — the same
  workflows for shells and GitHub Actions

## License

MIT License — see the LICENSE file for details.
