# Actions

Every action the release-management stack exposes, what it does, and exactly which git
objects and remote effects it produces.

Each action is reachable two ways with the same underlying implementation in
`@officespacesoftware/release-management-core`:

- as an MCP tool from `js/packages/release-management-mcp/src/index.ts`
- as a CLI subcommand from `js/packages/release-management-cli/src/cli.ts`

`health_check` exists only as an MCP tool. Everything else has both surfaces.

## Summary

| Action | MCP tool | CLI command | Mutates? | Creates |
| --- | --- | --- | --- | --- |
| Health check | `health_check` | — | No | Nothing |
| List versions | `list_versions` | `list-versions` | No | Nothing |
| Create release candidate | `create_release_candidate` | `create-rc` | Yes | Branch, commit, annotated tag, 2 pushes, PR → `develop` |
| Create hotfix | `create_hotfix` | `create-hotfix` | Yes | Branch, commit, annotated tag, 2 pushes, PR → `main` |
| Increment release candidate | `increment_release_candidate` | `increment-rc` | Yes | Commit, annotated tag, 2 pushes, PR → the branch's own base |
| Release version | `release_version` | `release-version` | Yes | Commit, annotated tag, 2 pushes, PR → `main`, GitHub release |
| Revert version | `revert_version` | `revert-version` | Yes | Revert commit, 1 push, PR update — **deletes** the tag locally and on origin, the GitHub release for a final version, and the branch when abandoning |
| Initialize versioner | `initialize_versioner` | `initialize-versioner` | Yes (local only) | `VERSION` file, commit, annotated tag |
| Downmerge | `downmerge` | `downmerge <source>-to-<target>` | Yes | Clean merge: PR → the target, through a merge branch on three of the five routes. Conflicting merge: nothing; returns a [manual downmerge](manual-downmerge.md) handoff |

Read-only actions are `health_check` and `list_versions`.

## Conventions shared by every action

**Version commits and tags.** Whenever a version changes, the mutation happens inside
`@officespacesoftware/versioner`, whose `performGitOperations` runs exactly three commands:

| Command | Form |
| --- | --- |
| Stage | `git add "VERSION"` |
| Commit | `git commit -m "To version <version>"` |
| Tag | `git tag "<version>" -a -m "Release version <version>"` |

Tags are therefore always annotated, named for the version with no prefix, and carry the
message `Release version <version>`.

**Pull request bodies** are wrapped in watermarks:

```
<!-- RELEASE-MANAGEMENT-MCP:START -->
…body…
<!-- RELEASE-MANAGEMENT-MCP:END -->
```

`createPullRequest` posts to the GitHub REST API. When GitHub answers `422` with
"A pull request already exists", it looks up the open PR for that exact head/base pair and
updates its title and the watermarked region of its body instead, reporting the action as
`updated` rather than `created`. If no watermarks are present in the existing body, the
new content is appended.

**Preconditions.** Every mutating action first checks that the working directory is a git
repository and that nothing is staged; a staged file aborts the action. The four version
workflows additionally require the versioner library to have loaded (`revert_version` uses
git alone, so it does not). `list_versions`
checks only that the directory is a git repository, because it never mutates.

**`dryRun`.** The five version workflows, `revert_version` included, accept a dry-run flag: read-only validation still
runs and the mutating steps are skipped. The five downmerge actions have no such flag —
calling one without a confirmation digest returns a plan and is guaranteed not to mutate.
`initialize_versioner` has neither, because everything it creates is local.

**Working directory.** Every action except `health_check` accepts a working directory and
defaults to the process's current directory.

**Git timeouts.** Commands that talk to origin (`fetch`, `push`, `pull`, `clone`,
`ls-remote`, `remote`, `submodule`) time out after 300 s; all other git commands after
30 s.

## The plan/confirm protocol

Every mutating action except `initialize_versioner` is two-phase.

**Calling one without a confirmation digest returns a plan and changes nothing.** A plan
(`ChangePlan` in `js/packages/release-management-core/src/change-plan.ts`) states:

| Field | Meaning |
| --- | --- |
| `action` | the action being planned |
| `targetBranch` | the branch the plan is anchored to: the one being modified, or the base a new branch is cut from |
| `targetBranchHead` | that branch's HEAD commit when the plan was computed |
| `currentVersion` → `resultingVersion` | the version transition, absent for the downmerges, which create no version commit |
| `mutations` | the ordered list of objects the action would touch, each with a kind (`branch`, `commit`, `tag`, `push`, `pull-request`, `github-release`), an `operation` of `create` or `delete` (absent means `create`), and a one-line summary. `renderChangePlan` groups them under "Would create:" and "Would delete:" |
| `warnings` | conditions that do not block planning but change the outcome |
| `notices` | facts that shape the plan without putting the outcome at risk, such as a pull request being updated rather than opened; rendered under "Notes:" |
| `digest` | the confirmation token |

Every fact in a plan comes from read-only primitives: branch selection, `git rev-parse` for
the head commit, `git show <commit>:VERSION` for a branch's version, `git tag --list` and
`git ls-remote --tags` for tag existence, `git merge-base --is-ancestor` for whether a
merge would be empty, and a pull-request lookup for whether a PR would be updated rather
than opened. Where a plan needs to predict a merge, it uses `git merge-tree --write-tree`,
which merges in memory and writes only to the object database — no checkout, no index
change, no working-tree change. Rendering a plan ends with the line
`Nothing has been changed. To apply, confirm with digest: <digest>`.

A merge branch carries a Unix timestamp the plan cannot predict, so a downmerge plan names
it by its pattern — `release-X.Y.Z-into-main-<unix-timestamp>` — and puts the source
branch's head commit in a mutation summary, so a push to either side of the merge
invalidates the digest.

A plan refuses to be built at all when the action cannot happen, rather than describing a
transition that cannot be made: a version bump refuses when the target branch is not
holding a release candidate, and cutting a new branch refuses when the base branch has no
readable, semantic `VERSION`.

Where the action can happen but a condition changes the outcome, that condition is a
warning: the resulting tag already exists on origin or locally, a pull request for that
head/base pair is already open, the branch about to be created already exists, the source
of a merge is already an ancestor of its base so the merge would be empty, the merge
conflicts, or `main` holds content that `origin/develop` does not. The comparisons against
origin use the remote-tracking refs as they currently stand, because planning does not
fetch; the actions fetch them themselves before applying.

**Applying requires passing that plan's digest back.** The digest is the first 12 hex
characters of a SHA-256 over a canonical serialisation of the action, the target branch,
that branch's HEAD commit, the version transition, and the ordered mutations and warnings.
Because the HEAD commit is covered, any push to the target branch invalidates the digest;
because the warnings are covered, so does a tag appearing on origin or a pull request being
opened in the meantime.

**A stale digest refuses and returns a fresh plan.** On mismatch, `assertPlanIsCurrent`
raises `StalePlanError`, which carries the newly computed plan alongside the digest that
was offered, so the operator can see what moved and confirm again.

The CLI surface of the protocol is:

- `--plan` — print the plan and write `plan_digest` to `$GITHUB_OUTPUT`; change nothing.
  This is also what happens when no apply flag is given at all, so the default can never
  mutate the repository.
- `--confirm <digest>` — apply, provided the digest still matches.
- `--yes` — apply directly, for automation that cannot round-trip a digest; the plan is
  still emitted as a record of intent.

The three are mutually exclusive: combining `--plan` with either apply flag, or `--confirm`
with `--yes`, is a usage error resolved before anything touches git.

Read-only actions need no confirmation: they have nothing to plan.

The mutation tables in the sections below describe what an apply produces.

---

## `health_check`

**Purpose.** Confirm the MCP server process is responsive.

**Inputs.** None.

**Steps.**

1. Build a status object and return it as pretty-printed JSON.

**Mutations.** None. The action does not read the repository, run git, or contact GitHub.

The response reports the server name `Release Management MCP Server`, a version string, the
status `healthy`, an ISO timestamp, and a list of capability descriptions.

---

## `list_versions` — read-only

**Purpose.** Enumerate every release and hotfix branch with the facts needed to choose one
deliberately, before running an action that mutates.

**Inputs.**

| Input | Default |
| --- | --- |
| `workingDirectory` / `--working-directory` | current directory |
| `productionBranch` / `--production-branch` | `main` |

**Steps.**

1. Read `git status --porcelain -b` for the current branch.
2. Find every `release/X.Y.Z` and `hotfix/X.Y.Z` branch, locally and on origin
   (`git ls-remote --heads origin 'refs/heads/release/*'`, likewise for `hotfix/*`),
   de-duplicated by branch name.
3. For each branch, read its `VERSION` first line via `git show <branch>:VERSION`.
4. For each version, check `git tag --list <version>` and
   `git ls-remote --tags origin refs/tags/<version>`.
5. For each branch, check `git merge-base --is-ancestor <branch> origin/<productionBranch>`.
6. Sort with the checked-out branch first, then by version descending, and render.

**Mutations.** None. No checkout, no fetch, no commit, no tag, no push, no pull request.
Steps 2 and 4 read from origin with `ls-remote`, which creates no local refs.

Each row reports: branch, version, whether the version is an RC or final, whether the tag
exists remotely / locally only / not at all, whether the branch is already merged into the
production branch, and which branch is checked out.

CLI `$GITHUB_OUTPUT` keys: `current_branch`, `release_candidates`.

---

## `create_release_candidate`

**Purpose.** Cut a new release branch off `develop` and set it to an `RC.0` version.

**Inputs.**

| Input | Default |
| --- | --- |
| `confirm` / `--confirm` (plan digest) | absent — plan only |
| `releaseType` / `--release-type` (`major` \| `minor` \| `patch`) | `minor` |
| `workingDirectory` / `--working-directory` | current directory |
| `dryRun` / `--dry-run` | `false` |

The plan is anchored on `develop`: its head commit, the `VERSION` read at that commit, the
release branch and tag that would be created, and the pull request into `develop`.

**Steps.**

1. Verify main/develop synchronization: fetch the two base branches
   (`git fetch origin '+refs/heads/main:refs/remotes/origin/main'
   '+refs/heads/develop:refs/remotes/origin/develop'`), then accept if `origin/main` is an
   ancestor of `origin/develop`, or if there are no commits in
   `origin/develop..origin/main`, or if those commits produce no content diff. Otherwise
   abort.
2. Check out `develop` and pull it.
3. Compute the next base version from `develop`'s `VERSION` and the release type — major
   `(M+1).0.0`, minor `M.(m+1).0`, patch `M.m.(p+1)` — and create the branch. Aborts if
   the branch already exists locally or on origin.
4. Rewrite `VERSION` to the `RC.0` version through the versioner package, which commits and
   tags.
5. Push the branch and the tag.
6. Open or update the pull request to `develop`.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| Branch | `release/X.Y.Z` — `git checkout -b release/X.Y.Z` from `develop` |
| Commit | `To version X.Y.Z-RC.0` on `release/X.Y.Z`, staging `VERSION` |
| Tag | annotated `X.Y.Z-RC.0`, message `Release version X.Y.Z-RC.0` |
| Push | `git push -u origin release/X.Y.Z` (not forced) |
| Push | `git push origin X.Y.Z-RC.0` (not forced) |
| Pull request | head `release/X.Y.Z` → base `develop`, title `RC X.Y.Z-RC.0 to develop` |
| Remote refs | `refs/remotes/origin/main` and `refs/remotes/origin/develop` updated by step 1 |

CLI `$GITHUB_OUTPUT` keys: `release_type`, `version`, `pull_request_url`,
`pull_request_action`.

---

## `create_hotfix`

**Purpose.** Cut a hotfix branch off `main` and set it to a patch `RC.0` version.

**Inputs.**

| Input | Default |
| --- | --- |
| `confirm` / `--confirm` (plan digest) | absent — plan only |
| `workingDirectory` / `--working-directory` | current directory |
| `dryRun` / `--dry-run` | `false` |

The plan is anchored on `main`, the same way `create_release_candidate`'s is anchored on
`develop`. It does not consider main/develop synchronization, which gates only the release
branch.

**Steps.**

1. Fetch `main` only (`git fetch origin 'main'`).
2. Check out `main` and pull it.
3. Compute `M.m.(p+1)` from `main`'s `VERSION` and create the hotfix branch.
4. Rewrite `VERSION` to the patch `RC.0` version through the versioner package, which
   commits and tags.
5. Push the branch and the tag.
6. Open or update the pull request to `main`.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| Branch | `hotfix/X.Y.Z` — `git checkout -b hotfix/X.Y.Z` from `main` |
| Commit | `To version X.Y.Z-RC.0` on `hotfix/X.Y.Z`, staging `VERSION` |
| Tag | annotated `X.Y.Z-RC.0`, message `Release version X.Y.Z-RC.0` |
| Push | `git push -u origin hotfix/X.Y.Z` (not forced) |
| Push | `git push origin X.Y.Z-RC.0` (not forced) |
| Pull request | head `hotfix/X.Y.Z` → base `main`, title `RC X.Y.Z-RC.0 to main`; body opens with a `> [!WARNING]` block stating the PR must be merged after the hotfix has been deployed to production |

`hotfix/X.Y.Z` → `main` is the one head/base pair a hotfix uses. Step 6,
`increment_release_candidate`, `release_version` and the hotfix → main `downmerge` all resolve
to it, so whichever runs first opens the pull request and the rest update its title and the
watermarked region of its body.

Bringing the hotfix into `develop` is a separate action, the hotfix → develop `downmerge`.

CLI `$GITHUB_OUTPUT` keys: `version`, `pull_request_url`, `pull_request_action`.

---

## `increment_release_candidate`

**Purpose.** Raise the RC number on an existing release or hotfix branch, e.g.
`1.2.0-RC.1` → `1.2.0-RC.2`.

**Inputs.**

| Input | Default |
| --- | --- |
| `version` / `--version` (base version such as `1.2.0`) | auto-selected |
| `workingDirectory` / `--working-directory` | current directory |
| `dryRun` / `--dry-run` | `false` |

**Target selection**, in order:

1. the version passed explicitly — matched against `release/<version>` and
   `hotfix/<version>`; both existing at once is an error;
2. the checked-out release or hotfix branch, if its `VERSION` holds an RC;
3. otherwise the newest RC across all release and hotfix branches, compared by semantic
   version.

Standing on a release or hotfix branch whose `VERSION` is not an RC aborts rather than
selecting a different branch.

**Steps.**

1. Select the target branch.
2. Check out the branch and pull it.
3. Pull the branch again (`git pull origin <branch>`).
4. Validate: the branch's `VERSION` must contain `-RC.`, and the branch version must not be
   behind its base branch (`develop` for release branches, `main` for hotfix branches).
   This validation also runs under `dryRun`.
5. Increment the RC through the versioner package, which commits and tags.
6. Push the branch and the tag.
7. Open or update the pull request to the branch's own base — `develop` for a release
   branch, `main` for a hotfix branch.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| Commit | `To version X.Y.Z-RC.N` on the target branch, staging `VERSION` |
| Tag | annotated `X.Y.Z-RC.N`, message `Release version X.Y.Z-RC.N` |
| Push | `git push -u origin <target branch>` (not forced) |
| Push | `git push origin X.Y.Z-RC.N` (not forced) |
| Pull request | head `<target branch>` → base `develop` (release) or `main` (hotfix), title `RC X.Y.Z-RC.N to <base>`; a `main` base carries the `> [!WARNING]` production-merge block |

Step 4 checks out the base branch to read its `VERSION`, then returns to the branch it
started on. A failure in step 7 does not fail the action: the version bump has already
happened, so the pull-request error is reported alongside the result.

CLI `$GITHUB_OUTPUT` keys: `branch`, `version`, `pull_request_url`,
`pull_request_action`, `pull_request_error`.

---

## `release_version`

**Purpose.** Promote a release candidate to its final version, e.g. `1.2.0-RC.3` →
`1.2.0`.

**Inputs.**

| Input | Default |
| --- | --- |
| `version` / `--version` (base version such as `1.2.0`) | auto-selected |
| `workingDirectory` / `--working-directory` | current directory |
| `dryRun` / `--dry-run` | `false` |

**Target selection** is identical to `increment_release_candidate`.

**Preflight.** The plan rehearses the merge this branch will eventually make into `main`
and warns about three things, refusing none.

A conflict is reported with its files, since the release → main `downmerge` will stop for
a human decision — after the tag is already cut.

A hotfix whose branch is already in `main` but not in this release branch is named. It is
a fix already in production that the release would undo. `increment_release_candidate`
reports it too, and `create_release_candidate` reports the same for `develop`.

`main` holding commits the branch does not is reported more quietly, and is not a merge
failure at all: the merge combines both histories faithfully. The problem is that the
artifact tagged from the branch predates those commits, so `main` ends up holding changes
that were never deployed, and the next branch cut from `main` inherits them. A hotfix
landing after the release branch was cut is the ordinary cause. This is deliberately
reported at the commit level, not per file — whether a given hunk survives a three-way
merge depends on what both sides touched, so file-level claims over-report (the branch may
carry the same content under a different commit) or under-report to nothing (both sides
routinely edit one file in different places). The files those commits touch are listed as
context, not as a claim about which side wins.

The remedy in every case is to merge `main` into the release branch and cut a new
release candidate before promoting, so the change is deployed and tested like any other.
Whether to promote anyway is the operator's call. A check that could not run is reported as
such rather than passing silently. All of it is read-only: `merge-tree --write-tree`,
`rev-list` and `diff`.

**Steps.**

1. Select the target branch.
2. Check out the branch and pull it.
3. Pull the branch again.
4. Validate that `VERSION` holds an RC, then strip the RC suffix through the versioner
   package, which commits and tags. The validation runs under `dryRun` too.
5. Push the branch.
6. Push the tag.
7. Open or update the pull request to `main`.
8. For a hotfix branch, log the deploy-before-merge warning.
9. Create the GitHub release.
10. Update the pull request on the branch's own base, if one is open. Skipped for a
    hotfix, whose own base is `main` and therefore already written by step 7.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| Commit | `To version X.Y.Z` on the target branch, staging `VERSION` |
| Tag | annotated `X.Y.Z`, message `Release version X.Y.Z` |
| Push | `git push origin <target branch>` (not forced, no upstream set) |
| Push | `git push origin X.Y.Z` (not forced) |
| Pull request | head `<target branch>` → base `main`, title `Release X.Y.Z to main`; body opens with a `> [!WARNING]` block stating the PR must be merged after the release or hotfix has been deployed to production |
| GitHub release | tag `X.Y.Z`, name `Release X.Y.Z`, `target_commitish` = the target branch, body from GitHub's `generateReleaseNotes` for that tag and target |
| Pull request (release branches only) | the open PR on the branch's own base, retitled `Release X.Y.Z to develop`, body rewritten to the final version. Only ever updated, never opened: the own-base PR belongs to `create_release_candidate`, and opening one here would propose merging a release into develop off the back of a promotion. Same title the release → develop `downmerge` uses, so the two converge |

Release notes are requested up to three times with 1 s and 2 s backoff. If no body is
obtained the release is still created, then one further attempt is made and the body
patched in; if that also yields nothing the release keeps an empty body and the result
carries a notes warning. A failure in step 7 or step 10 does not fail the action; by then
the tag is pushed and the release is out, so the pull-request error is reported alongside
the result instead. `revert_version` writes the same own-base PR — see its table below.

CLI `$GITHUB_OUTPUT` keys: `branch`, `version`, `pull_request_url`,
`pull_request_action`, `pull_request_error`, `release_url`, `release_notes_warning`,
`own_base_pull_request_url`, `own_base_pull_request_error`.

---

## `revert_version`

**Purpose.** Undo the most recent version bump on a release or hotfix branch, and remove
the tag it created. This is the only action that deletes anything.

**Inputs.**

| Input | Default |
| --- | --- |
| `version` / `--version` (base version such as `1.2.0`) | the checked-out branch |
| `workingDirectory` / `--working-directory` | current directory |
| `dryRun` / `--dry-run` | `false` |

**Target selection**, in order:

1. the version passed explicitly — matched against `release/<version>` and
   `hotfix/<version>`; both existing at once is an error;
2. the checked-out release or hotfix branch.

There is deliberately **no third tier**. The other version workflows fall back to the
newest release candidate across all branches; reverting does not, because guessing which
branch to delete tags and branches from is not a risk worth taking to save typing a
version.

**Two shapes.** Which one applies is decided by the `VERSION` in the bump commit's
parent:

- **Revert** — the parent carries an earlier version of the same release (`RC.1` under
  `RC.2`, or the RC a final was promoted from), so `VERSION` goes back one step and the
  branch survives. This holds even when that earlier bump is already in the base,
  as it is once a release candidate's pull request into `develop` is merged. A revert
  commit is used, never a reset, because protected branches commonly forbid the
  force-push a reset would need.
- **Abandon** — the parent carries another release's version, or none, so this is the
  branch's first version and there is nothing to rewind to; reverting would leave the
  branch indistinguishable from its base. The branch is deleted instead.

Every line the plan adds is a note, not a warning: a revert always needs approval, and
the notes say what it destroys.

**Refusals.** Each of these aborts rather than warning:

1. the version is already merged into the production branch — it shipped, so it can only
   be superseded by a new version, never revoked;
2. the branch head is not the bump commit, i.e. its subject is not
   `To version <current version>`; there is nothing to revert and an earlier commit will
   not be guessed at;
3. the branch has no readable `VERSION`;
4. abandoning would delete a branch holding commits that are not in its base — those may
   exist nowhere else, so they are listed and the action stops.

**Steps** (revert shape).

1. Check out and pull the branch.
2. `git revert --no-edit <bump commit>`. A conflicting revert is aborted, leaving nothing.
3. Delete the tag on origin, then locally.
4. Delete the GitHub release for the tag, if the version is final and one exists.
5. Push the branch.
6. Update the open pull request, if there is one, to the version now held.

**Steps** (abandon shape).

1. Delete the tag on origin, then locally.
2. Comment on the open pull request explaining the abandonment, then close it.
3. Delete the branch on origin, then locally.

The ordering is chosen for what a partial failure leaves behind: tags go first, while the
commit they point at is still reachable; the pull-request record is written before the
branch disappears, so the explanation precedes the closure; the branch goes last, being
the least recoverable step. The plan states the branch head so a mistaken abandon can be
undone with `git branch <name> <sha>` until it is garbage collected.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| Commit (revert shape) | `Revert "To version X.Y.Z"` on the target branch, staging `VERSION` |
| Tag deletion | `X.Y.Z` removed locally (`git tag -d`) and on origin (`git push origin :refs/tags/X.Y.Z`) |
| GitHub release deletion | the release for tag `X.Y.Z`, when the version is final; this moves the `Latest` marker to the previous release and destroys that release's notes, including any hand edits |
| Push (revert shape) | `git push -u origin <target branch>` (not forced) |
| Pull request (revert shape) | the open PR on the branch's own base, retitled `RC X.Y.Z to <base>` |
| Pull request (abandon shape) | the open PR closed, with a comment naming the version, the deleted tag and the recovery command |
| Branch deletion (abandon shape) | `<target branch>` removed on origin and locally |

A missing tag is reported as a note rather than treated as a failure — a revert should
not abort because the thing it wanted gone was already gone. A failure in the pull-request
step does not fail the action: the git side has already happened, so the error is reported
alongside the result.

**Deleting a tag does not undo a build or deployment that tag already triggered**, and
pushing the revert commit may itself trigger a new one. Every plan says so.

CLI `$GITHUB_OUTPUT` keys: `branch`, `shape`, `reverted_version`, `resulting_version`,
`tag_deleted_remotely`, `branch_deleted`, `pull_request_url`, `pull_request_action`,
`pull_request_error`.

---

## `initialize_versioner`

**Purpose.** Bootstrap version management in a repository that has none.

**Inputs.**

| Input | Default |
| --- | --- |
| `version` / `--version` | `0.1.0-RC.0` |
| `workingDirectory` / `--working-directory` | current directory |

There is no dry-run option and no plan: this action neither pushes nor opens a pull
request, and it refuses outright if a `VERSION` file already exists.

**Steps.**

1. Check the directory is a git repository and nothing is staged.
2. Read the short HEAD hash; the repository must have at least one commit.
3. Create the `VERSION` file. An existing `VERSION` file is an error.
4. Commit and tag through the versioner package.

**Objects and remote effects.**

| Kind | Exact form |
| --- | --- |
| File | `VERSION`, two lines: the version, then the short HEAD hash |
| Commit | `To version <version>` on the current branch, staging `VERSION` |
| Tag | annotated `<version>`, message `Release version <version>` |

Nothing is pushed and no pull request is opened. All effects are local.

CLI `$GITHUB_OUTPUT` keys: `version`, `is_release_candidate`.

---

## `downmerge`

**Purpose.** Bring one branch into another through a pull request. One tool covers the
five routes:

| `source` → `target` | CLI command | Pull request head |
| --- | --- | --- |
| `main` → `develop` | `downmerge main-to-develop` | merge branch `main-into-develop-<unix-timestamp>` off `develop` |
| `release` → `develop` | `downmerge release-to-develop` | `release/X.Y.Z` itself |
| `release` → `main` | `downmerge release-to-main` | merge branch `release-X.Y.Z-into-main-<unix-timestamp>` off `main` |
| `hotfix` → `develop` | `downmerge hotfix-to-develop` | merge branch `hotfix-X.Y.Z-into-develop-<unix-timestamp>` off `develop` |
| `hotfix` → `main` | `downmerge hotfix-to-main` | `hotfix/X.Y.Z` itself |

**Inputs.**

| Input | Default |
| --- | --- |
| `source`, `target` (MCP only; the CLI names the route in the subcommand) | required |
| `confirm` / `--confirm` (plan digest) | absent — plan only |
| `version` / `--version` (release and hotfix sources) | newest branch of that type by semantic version |
| `workingDirectory` / `--working-directory` | current directory |

**Clean or conflicting.** The plan previews the merge with `merge-tree`. Only a clean
merge gets a plan. A conflicting one creates nothing and returns a handoff instead,
following [manual-downmerge.md](manual-downmerge.md). Into `develop` it is "Manual
downmerge needed": the conflicted files, the branch to resolve them on, the pull request
title, and numbered steps. Into `main` it is "Decision needed": `main` mirrors
production, so the handoff resolves nothing and lists two options for a human. The CLI prints
the handoff and exits with the user-error code. The tools never push a conflicted merge,
and the apply re-checks: a conflict that appears between plan and apply aborts the merge,
deletes the local branch, and returns the same handoff.

**Steps for a clean merge.**

1. Resolve the release or hotfix branch, by exact version or as the newest one.
2. Fetch, check out and pull the target and the source.
3. Merge-branch routes: create the merge branch off the target, merge the source in with
   `git merge --no-ff`, and push. A source already merged into the target produces no
   commit, so the action refuses rather than pushing an empty branch.
4. Open or update the pull request into the target.
5. `hotfix` → `develop` only: close the draft `hotfix/X.Y.Z` → `develop` pull request that
   `create_hotfix` opened, with a comment linking the new one. Failing to close it is
   reported, not fatal.

**Objects and remote effects.**

| Route | Commit | Pull request |
| --- | --- | --- |
| `main` → `develop` | `Downmerge main into develop` | title `Release <v> to develop` when `main`'s newest non-merge commit is `To version <v>`, else `Downmerge main into develop` |
| `release` → `develop` | none | title `Release X.Y.Z to develop` |
| `release` → `main` | `Merge release/X.Y.Z into main` | title `Release X.Y.Z to main` |
| `hotfix` → `develop` | `Merge hotfix/X.Y.Z into develop` | title `Hotfix X.Y.Z to develop` |
| `hotfix` → `main` | none | title `Release X.Y.Z to main` |

Merge-branch routes push their branch with `git push -u origin <branch>` (not forced).
Pull requests into `main` open with a `> [!WARNING]` block stating they must be merged
after the deploy. The merge branch keeps CI workflows keyed on a `release/*` or `hotfix/*`
head from rebuilding an artifact that was already cut.

CLI `$GITHUB_OUTPUT` keys: `kind`, `pull_request_url`; plus `merge_branch` on the
merge-branch routes.

---

## Version mutation primitives

The actions above delegate every version change to these. They are also usable on their
own, and they are the only code that writes the `VERSION` file. Each one rewrites
`VERSION`, then stages, commits, and creates an annotated tag as described under
[Conventions](#conventions-shared-by-every-action).

| Operation | `versioner` CLI | Rake task | JS function |
| --- | --- | --- | --- |
| Create `VERSION` (default `0.1.0-RC.0`) | `versioner init [VERSION]` | `rake version:init` (optional `VERSION=`) | `init(version)` |
| Patch release | `versioner patch` | `rake version:patch` | `patch()` |
| Minor release | `versioner minor` | `rake version:minor` | `minor()` |
| Major release | `versioner major` | `rake version:major` | `major()` |
| Patch RC | `versioner patch-rc` | `rake version:patch_release_candidate` | `patchReleaseCandidate()` |
| Minor RC | `versioner minor-rc` | `rake version:minor_release_candidate` | `minorReleaseCandidate()` |
| Major RC | `versioner major-rc` | `rake version:major_release_candidate` | `majorReleaseCandidate()` |
| Increment RC | `versioner increment-rc` | `rake version:increment_release_candidate` | `incrementReleaseCandidate()` |
| Promote RC to final | `versioner release` | `rake version:release` | `release()` |
| Print current version | `versioner show` | `rake version:show` | `showVersion()` |

`versioner show` and `rake version:show` are read-only: they print the first line of
`VERSION` and create nothing.

The `versioner` CLI also accepts the underscored aliases
`patch_release_candidate`, `minor_release_candidate`, `major_release_candidate`, and
`increment_release_candidate`, plus `help` / `--help` / `-h`. Running it with no arguments
prints help. `versioner init` takes its version from the argument, then the `VERSION`
environment variable, then the `0.1.0-RC.0` default.

**Guard rails**, identical in both implementations: `patch`, `minor`, `major`, and the
three `*-rc` operations refuse to run while an RC is active; `increment-rc` and `release`
refuse to run when the current version is not an RC; and `init` refuses when a `VERSION`
file already exists.
