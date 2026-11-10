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
shows T1 under `Pipeline:`. A rewinding `revert_version` shows it, and an
`increment_release_candidate` that predicts a conflict into `develop` with no pull request
open (N8); every other versioning action writes a pull request on the branch. The line is
not covered by the digest.

**What a valid trigger changes in `increment_release_candidate`.** On a release branch,
after the push, the increment previews the merge of the pushed head into `develop`. If it
conflicts, the increment does not open a pull request into `develop` (one already open is
still updated) and returns the same "Manual downmerge needed" handoff as the `release` →
`develop` downmerge, so the conflict gets resolved; the trigger then starts the build of a
branch left without an open pull request. Without a valid trigger nothing else would start
that build, so the pull request is opened even when it conflicts. Hotfix branches are not
affected. Details are in [actions.md](actions.md#conflicts-into-develop).

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

`createGitHubClient` (`js/packages/release-management-core/src/github-client.ts`) uses the
first credential it finds:

1. a [GitHub App](#github-app-authentication) installation token, when `GITHUB_APP_ID` and
   a private key (`GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`) are set;
2. `GH_TOKEN`, or, when `GH_TOKEN` is unset or empty, `GITHUB_TOKEN`;
3. the output of `gh auth token` (which reads the keychain or `hosts.yml`, whichever `gh`
   uses);
4. `github.com.oauth_token` in `~/.config/gh/hosts.yml` (older `gh` versions).

An empty variable counts as unset: `GH_TOKEN=""` falls through to `GITHUB_TOKEN`. With no
token, any call to GitHub fails with G7. A configured GitHub App wins over every token,
including `GH_TOKEN`, and a broken app configuration fails (G16–G25) rather than falling
back to a token. Without an app, pushes and fetches use git's own credentials, not this
token; see [Token scopes](#token-scopes) for when those are the same token. With an app,
git uses the installation token too; see [How git authenticates](#how-git-authenticates).

The CLI's [`with-github-auth`](#running-your-own-git-and-gh-as-the-app) resolves a
credential in the same order for commands you run yourself.

`owner` and `repo` come from `git remote get-url origin`, which must be
`git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo(.git)` or
`https://github.com/owner/repo(.git)` (G8). An HTTPS URL may carry a credential, as hosted
agents' checkouts do (`https://x-access-token:<token>@github.com/owner/repo`); the
credential is ignored for parsing and never shown in G8. Clients
are cached per working directory for the life of the process.

Which actions call GitHub: every versioning plan and apply (pull-request lookups and
writes; release lookups for `revert_version`; release creation for `release_version`),
every downmerge apply, and the `release` → `develop`, `hotfix` → `develop` and
`hotfix` → `main` downmerge plans. `list_versions` and `initialize_versioner` do not.
`health_check` does only when a GitHub App is configured, to report the installation.

## GitHub App authentication

The tools can act as a GitHub App installation instead of as a person. Branches, tags,
pull requests and releases are then created by the app's bot user (`<slug>[bot]`), so any
person can review and approve its pull requests, and no long-lived personal token is
needed: the tools mint installation tokens that last an hour, from the app's ID and
private key.

### Variables

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The app's ID (a number) or its client ID, from the app's settings page |
| `GITHUB_APP_PRIVATE_KEY` | The app's private key: the contents of the `.pem` file GitHub generated |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Instead of `GITHUB_APP_PRIVATE_KEY`: the path of that `.pem` file |

App authentication is on when `GITHUB_APP_ID` and exactly one of the two key variables are
non-empty. Setting only some of them is refused (G16, G17, G18) rather than ignored, so a
half-configured app never falls back to a personal token unnoticed.

`GITHUB_APP_PRIVATE_KEY` accepts the key as PEM text. Secret stores often flatten newlines,
so literal `\n` (or `\r\n`) sequences, Windows line endings, newlines replaced by spaces
and surrounding quotes are all accepted. `GITHUB_APP_PRIVATE_KEY_PATH` suits key files
mounted by a secret manager or a downloaded `.pem`: nothing needs flattening, and the key
itself is not in the environment that [checks and the pipeline trigger](#environment-variables)
inherit (the file is still readable by them). A key that does not parse as an RSA private
key is G19; an unreadable file is G20. Neither message contains the key.

### What happens

For each repository (`origin`'s owner and name), on first use:

1. Sign a JWT with the private key (RS256; issued 60 seconds in the past to allow for
   clock drift; expires 9 minutes after now; issuer the app ID).
2. Find the app's installation on the repository: `GET /repos/{owner}/{repo}/installation`.
   A 404 means the app is not installed there (G21).
3. Mint an installation token limited to that one repository:
   `POST /app/installations/{id}/access_tokens` with `repositories: [repo]`.

The token is cached and reused until less than five minutes of its hour remain; the next
GitHub call or git network command then mints a new one. Every REST and GraphQL request
reads the current token when it is sent, so a long run never uses an expired token.
Failures are G21–G25; none contains the key, the JWT or a token.

### Required app permissions

Repository permissions:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Fetch and push branches and tags, create and delete releases, delete branches |
| Pull requests | Read and write | Find, open, update, comment on and close pull requests |
| Workflows | Read and write | Push commits that add or change files under `.github/workflows/`. Like a token without the `workflow` scope, an app without it can push everything else and fails only on releases that carry a workflow change |
| Metadata | Read | Mandatory for every app; GitHub grants it automatically |

The app must be **installed on the target repository** (on all repositories of the owner,
or with this repository among the selected ones). After changing the app's permissions, an
owner of the installation has to approve the change before new tokens carry it.

The tools push straight to release and hotfix branches: the version commit, the tag and the
release candidate. A ruleset or branch protection rule that requires a pull request (or
status checks) on those branches rejects the push ("GH013: Repository rule violations
found") unless the pusher may bypass it. A personal token with the admin role usually can;
an app cannot until it is added to the rule's bypass list (for a ruleset: **Bypass list →
Add bypass → Apps**). Pull requests into the base branches are unaffected, since the tools
only open them.

A 403 from GitHub on a request made with the installation token gets the permission GitHub
says the request needs appended (G26), from GitHub's `X-Accepted-GitHub-Permissions`
header, for example `pull_requests=write`. `health_check` lists the permissions the
installation token was granted.

### How git authenticates

With an app, every git command the tools run that talks to origin (`fetch`, `push`,
`pull`, `clone`, `ls-remote`, `remote`, `submodule`) gets the current installation token
through the environment, never on the command line or in the remote URL:

```
GIT_CONFIG_COUNT=<n + 4>
GIT_CONFIG_KEY_<n>=http.https://github.com/.extraheader      GIT_CONFIG_VALUE_<n>=
GIT_CONFIG_KEY_<n+1>=http.https://github.com/.extraheader    GIT_CONFIG_VALUE_<n+1>=AUTHORIZATION: basic <base64 of x-access-token:TOKEN>
GIT_CONFIG_KEY_<n+2>=url.https://github.com/.insteadOf       GIT_CONFIG_VALUE_<n+2>=git@github.com:
GIT_CONFIG_KEY_<n+3>=url.https://github.com/.insteadOf       GIT_CONFIG_VALUE_<n+3>=ssh://git@github.com/
```

`<n>` is an existing `GIT_CONFIG_COUNT`, so configuration already passed this way is kept.
The empty value first clears any `extraheader` set for `https://github.com/` in git's
configuration files (as `actions/checkout` leaves in `.git/config`), so git sends one
`Authorization` header, not two. The `insteadOf` entries send an SSH `origin` over HTTPS,
so it too uses the app rather than an SSH key. This needs git 2.31 or newer.

Only network commands get the token, and only the git processes the tools start: the
tools never write it to `process.env`, so checks and the pipeline trigger do not see it.
To give the same credential to git and `gh` commands you run yourself, see
[Running your own git and gh as the app](#running-your-own-git-and-gh-as-the-app).
A git error or warning that contains the token or its header value has it replaced with
`[REDACTED]` before it is shown (G13). Git's own hooks run under these git processes and
can read the environment, as they can any credential git has.

Without an app, git runs exactly as before: no added environment, its own configuration and
credentials.

### Commit identity

With an app, the commits and tags the tools create are authored, committed and tagged by
the app's bot user: name `<slug>[bot]`, email
`<bot user ID>+<slug>[bot]@users.noreply.github.com`, so GitHub links them to the app. The
slug comes from `GET /app` (with the JWT) and the bot user ID from
`GET /users/<slug>[bot]`; both are looked up once per repository. This covers the version
commit and tag the versioner creates for `create_release_candidate`, `create_hotfix`,
`increment_release_candidate` and `release_version`, the version tags and merge-branch
merge commits created directly with git, and `revert_version`'s revert commit. It is set
with `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`
for those git processes only. `initialize_versioner` runs locally without GitHub and keeps
the repository's configured `user.name` and `user.email`.

The commits are not signed. A branch rule that requires signed commits rejects them, as it
would the same commits made with a personal token.

### Running your own git and gh as the app

The tools authenticate only the git processes they start. When an automation, or a
person, finishes work by hand, such as a [manual downmerge](manual-downmerge.md), its own
`git merge`, `git push`, `gh pr create` and `gh pr close` would otherwise run with
whatever credential that environment has, and the commits and pull requests would show
that account instead of the app. The CLI's `with-github-auth` command runs one command
with the credential and identity the tools use:

```sh
release-management with-github-auth [--repo <owner/name>] -- <command> [args...]
```

```sh
release-management with-github-auth -- git merge --no-ff origin/release/1.4.0
release-management with-github-auth -- git push -u origin <resolution-branch>
release-management with-github-auth -- gh pr create --base develop --title "<title>" --body-file body.md
release-management with-github-auth --repo octo-org/octo-repo -- gh pr close 42 --comment "Superseded"
```

It resolves the credential exactly as the tools do
([GitHub token resolution](#github-token-resolution)): with a GitHub App, it mints an
installation token limited to the repository, which is `--repo` when given and otherwise
the `origin` of the current directory (G8). Without an app it uses the first token found,
for any repository; `--repo` then only has to be well formed (U8). It then starts the
command directly, without a shell, in the current directory, with the terminal's input
and output, and with the environment of the caller plus:

| Variable | Value |
| --- | --- |
| `GH_TOKEN`, `GITHUB_TOKEN` | The token, for `gh` and for anything else that reads either |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` | The entries in [How git authenticates](#how-git-authenticates), with and without an app, so `git fetch` and `git push` use the token over HTTPS, and over SSH-style `origin` URLs too |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | With an app only: the bot user from [Commit identity](#commit-identity), so `git merge` and `git commit` are authored by `<slug>[bot]` |

`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_PRIVATE_KEY_PATH` are removed from
the command's environment: it gets the hour-long token for one repository, not the key.
The token goes only into that environment, never on a command line, and `with-github-auth`
prints nothing of its own unless it fails. A credential that cannot be resolved fails with
the tools' messages (G7, G8, G16–G25) before the command starts. The command's exit code
is passed through; a command killed by a signal exits `128` plus the signal's number; see
[CLI exit codes](messages.md#cli-exit-codes).

Each call mints its own token, valid for an hour from then; a command still running after
that loses access part-way. Run one command per call rather than a long script.

### The pipeline trigger and installing the packages

The pipeline trigger and checks run with the process's environment. The installation
token is not added to it, so a trigger command that calls GitHub (for example
`gh workflow run`) needs its own credential in the environment, such as `GH_TOKEN`, or can
run as the app through
[`with-github-auth`](#running-your-own-git-and-gh-as-the-app).

Installing the `@officespacesoftware` packages from GitHub Packages may still need a
classic personal access token with `read:packages`. GitHub's documentation states that
"GitHub Packages only supports authentication using a personal access token (classic)",
and inside GitHub Actions also accepts the workflow's `GITHUB_TOKEN`; it does not list
GitHub App installation tokens
([Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
[About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)).
Keep a `read:packages` token in `.npmrc` or `NODE_AUTH_TOKEN` for the install; it needs no
other scope when the app does the rest.

### Token scopes

The alternative to a [GitHub App](#github-app-authentication). A classic personal access
token that runs the tools (and, in an automation, installs
them and pushes for them) needs three scopes:

| Scope | Why |
| --- | --- |
| `repo` | Pull requests, releases and comments. Tick the parent `repo` box: its sub-scopes (`repo:status`, `public_repo`, ...) do not grant access to private repositories, and a token with only those gets 404s |
| `read:packages` | Installing the `@officespacesoftware` packages from GitHub Packages |
| `workflow` | Pushing a commit that adds or changes a file under `.github/workflows/`. GitHub refuses such a push from a token without this scope ("refusing to allow a Personal Access Token to create or update workflow ... without `workflow` scope"). Downmerges, release candidates and hotfixes push whatever commits the source branch carries, so this fails only on the releases that include a workflow change |

`workflow` matters only when git pushes with the same token, as it does in an automation
whose git credential is the token. If the organization enforces SAML SSO, authorize the
token for it (**Configure SSO** on the token page) or calls return 403 or 404 despite the
scopes.

To check a token's scopes, read the `X-OAuth-Scopes` header without putting the token on a
command line:

```sh
printf 'header = "Authorization: token %s"\n' "$GH_TOKEN" |
  curl -sI -K - https://api.github.com/user | grep -i x-oauth-scopes
```

## Environment variables

| Variable | Read or set | By | Effect |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | read | core | GitHub App ID or client ID; with a private key, [app authentication](#github-app-authentication), ahead of every token |
| `GITHUB_APP_PRIVATE_KEY` | read | core | The app's private key as PEM text; flattened newlines accepted |
| `GITHUB_APP_PRIVATE_KEY_PATH` | read | core | Instead of `GITHUB_APP_PRIVATE_KEY`: path of the `.pem` file |
| `GH_TOKEN` | read, and set for `with-github-auth`'s command | core | GitHub token, first choice without an app. `with-github-auth` sets it to the resolved token; see [Running your own git and gh as the app](#running-your-own-git-and-gh-as-the-app) |
| `GITHUB_TOKEN` | read, and set for `with-github-auth`'s command | core | GitHub token, when `GH_TOKEN` is unset. `with-github-auth` sets it as `GH_TOKEN` |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` | read, and set for git | core | With an app, entries are appended for git network commands; see [How git authenticates](#how-git-authenticates). `with-github-auth` appends them for its command, with or without an app |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | set for git | core | With an app, the bot user, for the git and versioner processes that commit or tag, and for `with-github-auth`'s command; see [Commit identity](#commit-identity) |
| `GITHUB_OUTPUT` | read | CLI | When set, results are appended to that file as `key=value` lines (heredoc form for multi-line values). Keys per command are listed in [actions.md](actions.md) and the CLI README |
| `RELEASE_BRANCH`, `RELEASE_VERSION`, `RELEASE_ACTION` | set | core | For the pipeline trigger only |
| everything else | inherited | checks and trigger | Both run with the full environment of the process |
| `VERSION` | read | `versioner init` (the standalone CLI) | Version to initialize with, when no argument is given |

Without a GitHub App, git itself uses its normal configuration and credentials, and
commits are authored by the configured `user.name` and `user.email`. With one, see
[How git authenticates](#how-git-authenticates) and [Commit identity](#commit-identity).

## CLI flags shared by every command

| Flag | Effect |
| --- | --- |
| `--json` | One JSON document on stdout; everything human-facing on stderr; console progress silenced |
| `--quiet` | Console progress silenced; `--yes` no longer prints the plan to stderr |
| `--working-directory <path>` | The repository to act on. Not taken by `with-github-auth`, which runs its command in the current directory |

## MCP server

Every tool takes `workingDirectory`. The server rebinds to a new directory whenever it
changes between calls, except that `initialize_versioner` stays bound to the first
directory it was called with. Setup for Claude Code, Codex and Cursor, including passing
`GH_TOKEN` through the client's `env`, is in the
[MCP README](../js/packages/release-management-mcp/README.md).
