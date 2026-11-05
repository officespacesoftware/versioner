# Configuration

What a repository and the environment can configure: `.release-management.json`
(pre-version checks and the pipeline trigger), the GitHub token, and the environment
variables the tools read and set. Examples use a generic `acme/widgets` repository.

## `.release-management.json`

An optional JSON file at the repository root. Without it, no checks run and no pipeline is
triggered. It is never read from the working tree: each use reads it with
`git show <commit>:.release-management.json` from the commit the action is about to
version or has just pushed, so a branch carries its own configuration.

```json
{
  "checks": [
    {
      "name": "dependency-audit",
      "run": "npm audit --audit-level=high",
      "on": ["create_release_candidate", "release_version"],
      "timeoutSeconds": 300
    }
  ],
  "pipeline": {
    "trigger": "scripts/start-pipeline.sh",
    "timeoutSeconds": 120
  }
}
```

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `checks` | array | no | `[]` | Pre-version checks |
| `checks[].name` | non-empty string | yes | — | Shown in warnings and as `Output of <name>:` |
| `checks[].run` | non-empty string | yes | — | Command run with `/bin/bash` |
| `checks[].on` | array of action names | no | all four | Any of `create_release_candidate`, `increment_release_candidate`, `release_version`, `create_hotfix` |
| `checks[].timeoutSeconds` | positive number | no | `300` | Killed after this long (W9) |
| `pipeline` | object | no | none | The pipeline trigger |
| `pipeline.trigger` | non-empty string | yes, when `pipeline` is present | — | Command run with `/bin/bash` |
| `pipeline.timeoutSeconds` | positive number | no | `120` | Killed after this long (T7) |

Anything else in the file is ignored. Anything ambiguous is refused, never silently
skipped: an invalid file or section is a warning in the plan (W7, W11) and, for the
pipeline, a `failed` result at apply time (T6). The validation messages are
[C1–C10](messages.md#configuration-reasons).

## Pre-version checks

**When.** While a plan is built for `create_release_candidate`, `create_hotfix`,
`increment_release_candidate` or `release_version`, and again when the plan is rebuilt to
check a confirmation. Not for `revert_version`, downmerges or `initialize_versioner`, nor
for a `create_release_candidate` or `create_hotfix` that resumes an earlier run (the version
commit already exists).

**Against what.** The commit that will be versioned:

| Action | Commit | `<ref>` in messages |
| --- | --- | --- |
| `create_release_candidate` | `develop`'s head | `develop` |
| `create_hotfix` | `main`'s head | `main` |
| `increment_release_candidate`, `release_version` | the branch head | the branch |

The head is `origin/<branch>` when it exists. The plan fetches origin before reading it.

**How.** The configuration is read from that commit. If any check applies to the action,
the commit is checked out with `git worktree add --detach` into a temporary directory,
each check runs there in turn with `/bin/bash`, inheriting the environment, and the
checkout is removed afterwards. The working directory and its branch are never touched.

**Results.** A check that exits `0` adds nothing. A check that exits non-zero (W8) or runs
past its timeout (W9) adds a warning, and the last 40 lines (at most 4,000 characters) of
its output follow the plan as `Output of <name>:`. A checkout or start failure is W10.
Every warning is covered by the digest, so a check that starts or stops failing between the
plan and the confirmation makes the plan stale. The output itself is not covered.

Warnings do not block: the approver decides. To make a failing check block in practice,
have the approver treat W8 as a refusal.

## Pipeline trigger

Some CI setups build a branch only while it has an open pull request. Each versioning
action opens or updates one, but once it is merged or closed, a later push to the branch
builds nothing. The trigger starts the pipeline in that case.

**When it runs.** After `create_release_candidate`, `create_hotfix`,
`increment_release_candidate`, `release_version`, or a `revert_version` that rewinds a
branch, has pushed and finished its pull-request steps, including when a pull-request step
failed (that failure is reported, not thrown, so the branch may have no pull request and the
trigger starts its build). It does not run after a failure that stops the action (such as a
rejected push), on a dry run, after an abandon (the branch is gone), or after a downmerge (they
always leave a pull request open).

**Decision.**

```text
no pipeline section at the pushed commit          → nothing, no result
the branch heads an open pull request, any base   → skipped (T3); invalid section → nothing
section invalid, no open pull request             → failed (T6)
otherwise                                          → run the command: started (T2) or failed (T7–T9)
```

A pull request's own build runs on the push, and starting another pipeline could cancel
it, so an open pull request always wins. The diagram is in
[flows.md](flows.md#pipeline-trigger).

**How it runs.** The configuration is read from the commit just pushed (the branch's head).
The command runs with `/bin/bash` in a temporary detached checkout of that commit, removed
afterwards. It inherits the environment of the process running the action, so CI tokens
reach it, plus:

| Variable | Value |
| --- | --- |
| `RELEASE_BRANCH` | the pushed branch, such as `release/1.4.0` |
| `RELEASE_VERSION` | the version it now holds, such as `1.4.0-RC.3` (after a revert, the resulting version) |
| `RELEASE_ACTION` | `create_release_candidate`, `create_hotfix`, `increment_release_candidate`, `release_version` or `revert_version` |

The tail of what it prints is shown with the result, so it must not print credentials.

**Results.** `started`, `skipped` or `failed`, with the messages T2–T10. A failure is never
a rollback: the version is already on origin, and the message says to start the build by
hand. The CLI writes the status to `$GITHUB_OUTPUT` as `pipeline_trigger`.

**In plans.** A plan warns when the section is invalid (W11). When the action will not
itself open or update a pull request on the branch and the branch heads none, the plan
shows T1 under `Pipeline:`. In practice only a rewinding `revert_version` shows it, since
every other versioning action writes a pull request on the branch. The line is not covered
by the digest.

**Examples.** A CircleCI pipeline through its API:

```bash
#!/usr/bin/env bash
# scripts/start-pipeline.sh
set -euo pipefail
# The token goes in on stdin, not the command line, where other processes can read it.
printf 'Circle-Token: %s\n' "$CIRCLECI_TOKEN" |
  curl --fail-with-body -sS -X POST \
    "https://circleci.com/api/v2/project/gh/acme/widgets/pipeline" \
    -H @- -H "Content-Type: application/json" \
    -d "{\"branch\": \"${RELEASE_BRANCH}\"}"
```

A GitHub Actions workflow with a `workflow_dispatch` trigger:

```json
{
  "pipeline": {
    "trigger": "gh workflow run ci.yml --ref \"$RELEASE_BRANCH\""
  }
}
```

## GitHub token resolution

`createGitHubClient` (`js/packages/release-management-core/src/github-client.ts`) takes
the first token it finds:

1. `GH_TOKEN`, or, when `GH_TOKEN` is unset or empty, `GITHUB_TOKEN`;
2. the output of `gh auth token` (which reads the keychain or `hosts.yml`, whichever `gh`
   uses);
3. `github.com.oauth_token` in `~/.config/gh/hosts.yml` (older `gh` versions).

An empty variable counts as unset: `GH_TOKEN=""` falls through to `GITHUB_TOKEN`. With no
token, any call to GitHub fails with G7. The token needs `repo` scope (pull requests,
releases, comments); pushes use git's own credentials, not this token.

`owner` and `repo` come from `git remote get-url origin`, which must be
`git@github.com:owner/repo(.git)` or `https://github.com/owner/repo(.git)` (G8). Clients
are cached per working directory for the life of the process.

Which actions call GitHub: every versioning plan and apply (pull-request lookups and
writes; release lookups for `revert_version`; release creation for `release_version`),
every downmerge apply, and the `release` → `develop`, `hotfix` → `develop` and
`hotfix` → `main` downmerge plans. `list_versions`, `initialize_versioner` and
`health_check` do not.

## Environment variables

| Variable | Read or set | By | Effect |
| --- | --- | --- | --- |
| `GH_TOKEN` | read | core | GitHub token, first choice |
| `GITHUB_TOKEN` | read | core | GitHub token, when `GH_TOKEN` is unset |
| `GITHUB_OUTPUT` | read | CLI | When set, results are appended to that file as `key=value` lines (heredoc form for multi-line values). Keys per command are listed in [actions.md](actions.md) and the CLI README |
| `RELEASE_BRANCH`, `RELEASE_VERSION`, `RELEASE_ACTION` | set | core | For the pipeline trigger only |
| everything else | inherited | checks and trigger | Both run with the full environment of the process |
| `VERSION` | read | `versioner init` (the standalone CLI) | Version to initialize with, when no argument is given |

Git itself uses its normal configuration and credentials. Commits are authored by the
configured `user.name` and `user.email`.

## CLI flags shared by every command

| Flag | Effect |
| --- | --- |
| `--json` | One JSON document on stdout; everything human-facing on stderr; console progress silenced |
| `--quiet` | Console progress silenced; `--yes` no longer prints the plan to stderr |
| `--working-directory <path>` | The repository to act on |

## MCP server

Every tool takes `workingDirectory`. The server rebinds to a new directory whenever it
changes between calls, except that `initialize_versioner` stays bound to the first
directory it was called with. Setup for Claude Code, Codex and Cursor, including passing
`GH_TOKEN` through the client's `env`, is in the
[MCP README](../js/packages/release-management-mcp/README.md).
