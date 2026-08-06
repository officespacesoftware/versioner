# @officespacesoftware/release-management-cli

Git Flow release management from any shell or GitHub Actions job.

The same workflows the
[MCP server](../release-management-mcp/README.md) exposes to AI assistants, as a plain
`commander` CLI: cut a release candidate, increment it, promote it to a final version,
revert one, and downmerge between `main`, `develop`, `release/*` and `hotfix/*`. Both
front-ends call the same
[`@officespacesoftware/release-management-core`](../release-management-core/README.md), so
they behave identically.

TypeScript compiled to ESM. Node 18 or newer.

## Install

The package publishes to GitHub Packages, so the scope needs to be pointed there. In your
project's `.npmrc` (or `~/.npmrc`):

```
@officespacesoftware:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The token needs `read:packages`. Then:

```sh
npm install -g @officespacesoftware/release-management-cli@next
# or run it without installing
npx -p @officespacesoftware/release-management-cli@next release-management --help
```

The current line is a prerelease published under the `next` dist-tag. Install with `@next`,
or pin an exact version; `latest` is reserved for stable releases.

It also needs a GitHub token for the API calls — see [Authentication](#authentication).

## Global options

```
--json     Emit structured JSON instead of human-readable text
--quiet    Suppress progress logging; only emit the final result
```

There is deliberately no global `--version` flag: subcommands take `--version <ver>` as a
*release version* argument, and a global flag would short-circuit it. Run
`release-management <command> --help` for one command's flags.

Every command takes `--working-directory <path>`, defaulting to the current directory.

## Commands

```sh
release-management list-versions            [--production-branch <branch>]
release-management create-rc                [--release-type major|minor|patch]
release-management create-hotfix
release-management increment-rc             [--version <version>]
release-management release-version          [--version <version>]
release-management revert-version           [--version <version>]
release-management initialize-versioner     [--version <version>]
release-management downmerge main-to-develop
release-management downmerge release-to-develop  [--version <version>]
release-management downmerge release-to-main     [--version <version>]
release-management downmerge hotfix-to-develop   [--version <version>]
release-management downmerge hotfix-to-main      [--version <version>]
```

| Command | What it does |
| --- | --- |
| `list-versions` | Lists every release/hotfix branch with its version, tag and merge status. Read-only. |
| `create-rc` | Cuts `release/X.Y.0` off `develop` at `RC.0`. `--release-type` defaults to `minor`. |
| `create-hotfix` | Cuts `hotfix/X.Y.Z` off `main` at `RC.0`. |
| `increment-rc` | Bumps the RC suffix on the active release or hotfix branch. |
| `release-version` | Promotes an RC to a final version, tags it, and creates the GitHub release. |
| `revert-version` | Undoes the most recent version bump and deletes the tag it created. |
| `initialize-versioner` | Creates the `VERSION` file and its initial tag. Defaults to `0.1.0-RC.0`. |
| `downmerge …` | Opens the pull request that carries one branch's changes into another. |

Where `--version` is omitted, the newest matching branch on the upstream repository is
selected. `docs/actions.md` records the ordered steps and the exact git objects for each of
these — see [Related documentation](#related-documentation).

## Planning before applying

Every mutating command describes what it would do and stops. It applies only when you hand
back the digest of a plan you have seen.

```sh
# 1. plan — touches nothing
$ release-management release-version
Action:  release_version
Branch:  release/1.4.0 (at 8f2c1e0a9b3)
Version: 1.4.0-RC.2 → 1.4.0

Would create:
  Commit: To version 1.4.0
  Tag: annotated tag 1.4.0
  Push: release/1.4.0 and tag 1.4.0 to origin
  GitHub release: Release 1.4.0

Nothing has been changed. To apply, confirm with digest: 3f2a1b0c9d8e

# 2. apply that exact plan
$ release-management release-version --confirm 3f2a1b0c9d8e
```

| Flag | Effect |
| --- | --- |
| *(none)* | Plans only. **The default can never mutate the repository.** |
| `--plan` | Same, stated explicitly. |
| `--confirm <digest>` | Applies the plan carrying this digest. |
| `--yes` | Applies without a digest, printing the plan to stderr as a record. For automation that cannot round-trip a digest. |
| `--dry-run` | Validates without changing anything. Prefer `--plan`, which is guaranteed not to mutate. |

If the repository moved since the plan was computed — a push to the target branch, a tag
appearing, a pull request opening — `--confirm` refuses, prints the new plan, and exits `1`.
Nothing is changed. `--plan` cannot be combined with `--confirm` or `--yes`, and `--confirm`
cannot be combined with `--yes`; each contradiction is rejected before anything touches git.

Two commands take no plan flags, because they have nothing to plan:
`list-versions` is read-only, and `initialize-versioner` is purely local and pushes nothing.
`--dry-run` exists on the five version workflows (`create-rc`, `create-hotfix`,
`increment-rc`, `release-version`, `revert-version`) but not on the `downmerge`
subcommands.

The protocol is documented in full, including what the digest covers, in
[docs/actions.md](../../../docs/actions.md#the-planconfirm-protocol).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | User error — not a git repository, staged changes, no matching branch, a refused branch selection, contradictory flags, a stale plan digest, an unresolved merge conflict |
| `2` | Environment error, and any fatal parse-time failure |
| `3` | Reserved for partial success. Defined in `src/exit-codes.ts` but not currently returned by any code path. |

## GitHub Actions

Results are appended to `$GITHUB_OUTPUT` whenever that variable is set — the inline
`key=value` form for single-line values, the heredoc form for multi-line ones.

```yaml
name: Create release candidate
on:
  workflow_dispatch:
    inputs:
      release_type:
        type: choice
        options: [major, minor, patch]
        default: minor
      cli_version:
        description: Version of the CLI to run
        default: next

permissions:
  contents: write
  pull-requests: write
  packages: read

jobs:
  create-rc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # branch discovery needs full history

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: "https://npm.pkg.github.com"
          scope: "@officespacesoftware"

      - name: Configure git identity
        run: |
          git config user.name  "release-management-bot"
          git config user.email "release-management-bot@users.noreply.github.com"

      - name: Create release candidate
        id: rc
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # installs the CLI
          GH_TOKEN:        ${{ secrets.GITHUB_TOKEN }}   # the API calls it makes
        run: |
          npx -y -p @officespacesoftware/release-management-cli@${{ inputs.cli_version }} \
            release-management create-rc \
            --release-type ${{ inputs.release_type }} \
            --yes

      - run: echo "Opened ${{ steps.rc.outputs.pull_request_url }}"
```

Three things that are easy to get wrong:

- **`--yes` is required.** Without one of `--confirm` or `--yes`, the command prints a plan
  and exits `0` having changed nothing — which looks like success in a green job.
- **Two tokens, two purposes.** `NODE_AUTH_TOKEN` authenticates the `npx` install from the
  restricted scope; `GH_TOKEN` authenticates the pull request and release calls. The
  built-in `secrets.GITHUB_TOKEN` serves both.
- **`fetch-depth: 0`.** The default shallow clone hides the branches and tags these
  commands look for.

### `$GITHUB_OUTPUT` keys

| Command | Keys |
| --- | --- |
| any planned command | `plan_digest` |
| `list-versions` | `current_branch`, `release_candidates` |
| `create-rc` | `release_type`, `version`, `pull_request_url`, `pull_request_action` |
| `create-hotfix` | `version`, `pull_request_url`, `pull_request_action` |
| `increment-rc` | `branch`, `version`, `pull_request_url`, `pull_request_action`, `pull_request_error` |
| `release-version` | `branch`, `version`, `pull_request_url`, `pull_request_action`, `pull_request_error`, `release_url`, `release_notes_warning`, `own_base_pull_request_url`, `own_base_pull_request_action`, `own_base_pull_request_error` |
| `revert-version` | `branch`, `shape`, `reverted_version`, `resulting_version`, `tag_deleted_remotely`, `branch_deleted`, `pull_request_url`, `pull_request_action`, `pull_request_error` |
| `initialize-versioner` | `version`, `is_release_candidate` |
| `downmerge …` | `kind`, `pull_request_url`; plus `merge_branch` when a merge branch was used; plus `merge_pr_url`, `build_trigger_pr_url`, `build_trigger_pr_number`, `build_trigger_skipped_reason`, `checks_started`, `conflicted_files` when conflicts were carried |

`pull_request_action` is `created` or `updated`. `revert-version`'s `shape` is `revert`
(rewind one version) or `abandon` (delete the branch). A downmerge's `kind` is `direct`,
`merge-branch`, or `merge-branch-with-conflicts`.

With `--json`, the full result object goes to stdout as one line and every human-facing
note — progress, apply instructions — goes to stderr, so the document on stdout stays
parseable.

## Authentication

The CLI reaches GitHub through the core package, which resolves a token from the first
non-empty of:

1. `GH_TOKEN`
2. `GITHUB_TOKEN` (set automatically in GitHub Actions)
3. the output of `gh auth token`
4. `~/.config/gh/hosts.yml` → `github.com.oauth_token`

Locally, `gh auth login` once is enough. In a non-interactive shell, export `GH_TOKEN` with
`repo` scope. No `gh` binary is needed at runtime — it is only one of four ways to find a
token. `owner`/`repo` come from the `origin` remote URL.

## Development

From this directory:

```sh
pnpm build         # tsc — src/ to lib/
pnpm dev           # tsc --watch
pnpm clean         # rm -rf lib/
pnpm start         # node bin/release-management
```

This package has no test suite of its own; it is covered by `pnpm typecheck` at the
workspace root, and the behaviour it drives is tested in the core package.

```
src/
├── cli.ts              # program definition and subcommand registration
├── plan.ts             # the plan/confirm protocol
├── run.ts              # shared option resolution, error → exit code mapping
├── output.ts           # text/JSON emission, $GITHUB_OUTPUT
├── exit-codes.ts
├── errors.ts           # UsageError
└── commands/           # one file per workflow
```

`bin/release-management` is a shim onto `lib/cli.js`, so a clone needs `pnpm build` before
the CLI will run.

## Related documentation

- [../../../docs/actions.md](../../../docs/actions.md) — every action, its ordered steps,
  and the exact git objects it creates
- [../../../docs/architecture.md](../../../docs/architecture.md) — where this package sits
  in the wider system
- [../release-management-core/README.md](../release-management-core/README.md) — the
  library underneath
- [../release-management-mcp/README.md](../release-management-mcp/README.md) — the same
  workflows for AI assistants

## License

MIT License — see the LICENSE file for details.
