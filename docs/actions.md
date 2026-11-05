# Actions

Every action the release-management stack exposes: its inputs, how it picks the branch it
acts on, whether it waits for a confirmation, the exact git and GitHub effects in order,
every message it can show, and what is left behind when a step fails.

Each action is reachable two ways, over one implementation in
`@officespacesoftware/release-management-core`:

- as an MCP tool, from `js/packages/release-management-mcp/src/index.ts`;
- as a CLI subcommand, from `js/packages/release-management-cli/src/cli.ts`.

`health_check` exists only as an MCP tool.

Related documents: [messages.md](messages.md) catalogues every message by ID (G1, P2, W3…,
used below); [flows.md](flows.md) has the lifecycle diagrams;
[configuration.md](configuration.md) covers `.release-management.json`, tokens and
environment variables; [manual-downmerge.md](manual-downmerge.md) is the procedure behind
a conflicting downmerge.

## Summary

| Action | MCP tool | CLI command | Mode | Creates or changes |
| --- | --- | --- | --- | --- |
| Health check | `health_check` | — | read-only | Nothing |
| List versions | `list_versions` | `list-versions` | read-only | Nothing |
| Create release candidate | `create_release_candidate` | `create-rc` | plan → confirm | Branch `release/X.Y.Z`, commit, tag `X.Y.Z-RC.0`, two pushes, PR → `develop` |
| Create hotfix | `create_hotfix` | `create-hotfix` | plan → confirm | Branch `hotfix/X.Y.Z`, commit, tag `X.Y.Z-RC.0`, two pushes, PR → `main`, draft PR → `develop` |
| Increment release candidate | `increment_release_candidate` | `increment-rc` | plan → confirm | Commit, tag `X.Y.Z-RC.n`, two pushes, PR → the branch's base |
| Release version | `release_version` | `release-version` | plan → confirm | Commit, tag `X.Y.Z`, two pushes, PR → `main`, GitHub release, PR → `develop` |
| Revert version | `revert_version` | `revert-version` | plan → confirm | Revert: revert commit, push, tag deleted, GitHub release deleted for a final, PR updated. Abandon: tag deleted, PR closed, branch deleted |
| Initialize versioner | `initialize_versioner` | `initialize-versioner` | immediate, local only | `VERSION` file, commit, tag |
| Downmerge | `downmerge` | `downmerge <source>-to-<target>` | immediate; the PR is the review | Clean: a PR into the target, through a merge branch on three of the five routes. Conflicting: nothing; a [handoff](#downmerge-conflicts) |

## Conventions shared by every action

### Preconditions

Checked before anything else, in this order.

| Check | Message | `list_versions` | `initialize_versioner` | `downmerge` | `revert_version` | the other four |
| --- | --- | --- | --- | --- | --- | --- |
| Working directory is a git repository | G1 | yes | yes | yes | yes | yes |
| Nothing is staged | G2 | — | yes | yes | yes | yes |
| Versioner library available | G4, G5 | — | — (loads it to run) | — | CLI only | yes |

Unstaged and untracked changes are not refused by these checks. Actions that check out
other branches carry tracked modifications along or fail on them in git; the
`release` → `develop` downmerge refuses them explicitly (A29). Start from a clean working
tree.

### Remote state

Every plan starts by fetching origin, so it always reflects origin:

```sh
git ls-remote --heads origin refs/heads/main refs/heads/develop
git fetch --prune --no-tags origin '+refs/heads/main:refs/remotes/origin/main' \
  '+refs/heads/develop:refs/remotes/origin/develop' \
  '+refs/heads/release/*:refs/remotes/origin/release/*' \
  '+refs/heads/hotfix/*:refs/remotes/origin/hotfix/*'
```

(`main` and `develop` only when origin has them.) That writes remote-tracking refs and
nothing else: no tag, no local branch, no working tree. The plan then reads commits and
`VERSION` files from those refs (`origin/<branch>`), asks origin live which branch names and
tags exist (`git ls-remote`), and asks GitHub about pull requests and releases.

**Applies do not fetch or pull.** An apply rebuilds the plan, which fetches, compares the
digest, and then acts on exactly the remote-tracking refs that rebuilt plan read: new
branches are cut from `origin/<base>`, existing ones are reset to `origin/<branch>`, and
merge branches merge `origin/<source>` into `origin/<target>`. If origin moved after the
plan was approved, the rebuilt plan differs and the apply refuses with D1 and the new plan.

- **Origin is the source of truth; the clone is disposable.** `increment_release_candidate`,
  `release_version` and `revert_version` act on the branch exactly as origin has it: the
  apply checks the branch out and resets it to `origin/<branch>` (`git reset --keep`), so
  commits an earlier run made but never pushed are dropped from it rather than built on.
  The plan names them first (W14), with a command to keep them.

### Version commits and tags

Every version change goes through `@officespacesoftware/versioner`, which runs exactly:

| Command | Form |
| --- | --- |
| Stage | `git add "VERSION"` |
| Commit | `git commit -m "To version <version>"` |
| Tag | `git tag "<version>" -a -m "Release version <version>"` |

Tags are annotated, named for the bare version, with the message `Release version
<version>`. Before tagging, `create_release_candidate`, `create_hotfix`,
`increment_release_candidate` and `release_version` delete a local tag of the same name
that origin does not have (a clone keeps tags that origin has since deleted, such as a
reverted version's).

### Pull requests

`createPullRequest` posts to the GitHub REST API with `draft: false`, except for the
tracking pull request `create_hotfix` opens. When GitHub answers 422 "A pull request
already exists" it finds the open pull request for that exact head/base pair and updates
its **title and the watermarked part of its body** only; base and draft state are
unchanged. The result then says `updated` instead of `created`.

Generated bodies sit between `<!-- RELEASE-MANAGEMENT-MCP:START -->` and
`<!-- RELEASE-MANAGEMENT-MCP:END -->`. Text outside the markers survives updates. A body
without the markers gets a new marked block appended. Every body ends with the
`🤖 Auto-generated by …` footer, and every body for a pull request into `main` carries the
production warning, except a reverted hotfix's:

```markdown
> [!WARNING]
> This PR must be merged **after** the <release|hotfix> has been deployed to production.
```

Several actions write the same head/base pair, so one pull request is opened once and
then retitled as the branch moves on:

| Head → base | Opened by | Then updated by | Closed by | Titles | Draft |
| --- | --- | --- | --- | --- | --- |
| `release/X.Y.Z` → `develop` | `create_release_candidate` | `increment_release_candidate`, `release_version` (step 10), the `release` → `develop` downmerge, `revert_version` (revert shape). All but the revert open it when none is open | `revert_version` (abandon), with a comment | `RC X.Y.Z-RC.n to develop`, then `Release X.Y.Z to develop` | no |
| `release/X.Y.Z` → `main` | `release_version` (step 7) | — | GitHub, once its head reaches `main` through the `release` → `main` downmerge | `Release X.Y.Z to main` | no |
| `hotfix/X.Y.Z` → `main` | `create_hotfix` | `increment_release_candidate`, `release_version` (step 7), the `hotfix` → `main` downmerge, `revert_version` (revert shape). All but the revert open it when none is open | `revert_version` (abandon), with a comment | `RC X.Y.Z-RC.n to main`, then `Release X.Y.Z to main` | no |
| `hotfix/X.Y.Z` → `develop` | `create_hotfix` (as a draft) | `release_version` (step 10), which opens it, not as a draft, when none is open | the `hotfix` → `develop` downmerge, with a comment | `Hotfix X.Y.Z to develop` | yes when `create_hotfix` opens it |
| `main-into-develop-<ts>` → `develop` | `main` → `develop` downmerge | — | — | `Release <v> to develop`, or `Downmerge main into develop` | no |
| `release-X.Y.Z-into-main-<ts>` → `main` | `release` → `main` downmerge | — | — | `Release X.Y.Z to main` | no |
| `hotfix-X.Y.Z-into-develop-<ts>` → `develop` | `hotfix` → `develop` downmerge | — | — | `Hotfix X.Y.Z to develop` | no |

`<ts>` is a Unix timestamp in seconds, so every merge-branch downmerge opens a new pull
request.

### Where each action leaves the working tree

| Action | Checked out afterwards |
| --- | --- |
| `create_release_candidate` | `release/X.Y.Z` |
| `create_hotfix` | `hotfix/X.Y.Z` |
| `increment_release_candidate`, `release_version` | the target branch |
| `revert_version` | the branch (revert shape), or its base (abandon shape) |
| `downmerge` `main` → `develop`, `release` → `main`, `hotfix` → `develop` | the merge branch |
| `downmerge` `release` → `develop` | `develop` |
| `downmerge` `hotfix` → `main` | unchanged |
| `initialize_versioner`, `list_versions`, `health_check`, any plan | unchanged (a plan updates remote-tracking refs only) |

### Git timeouts

`fetch`, `push`, `pull`, `clone`, `ls-remote`, `remote` and `submodule` time out after
300 s; creating the temporary checkout for checks and the pipeline trigger after 300 s;
every other git command after 30 s. A timeout reports G12: the command may have partly
completed.

---

## The plan/confirm protocol

`create_release_candidate`, `create_hotfix`, `increment_release_candidate`,
`release_version` and `revert_version` are two-phase. `downmerge` applies immediately,
because the pull request it opens is the review: closing it unmerged rejects the
downmerge. `initialize_versioner` applies immediately because everything it creates is
local. The diagram is in [flows.md](flows.md#plan-and-confirm).

1. **Called without a confirmation, the action returns a plan and changes nothing**
   beyond the fetch into remote-tracking refs described in [Remote state](#remote-state).
   Building it runs the preconditions, the fetch, branch selection, every refusal, the
   read-only checks behind the warnings and notes, and the configured pre-version checks.
2. **A human approves by handing the plan's digest back**, as `confirm` (MCP) or
   `--confirm <digest>` (CLI). The MCP tool descriptions require the round trip: an agent
   must present the plan, end its turn, and let a person send the digest.
3. **The action rebuilds the plan, fetching again, and compares digests.** If they differ
   it refuses with D1 and returns the fresh plan and its digest; nothing is changed. If
   they match, it applies, to the state it has just fetched. Refusals are re-evaluated at
   this point, and the pre-version checks run again.

A plan (`ChangePlan` in `js/packages/release-management-core/src/change-plan.ts`) holds:

| Field | Meaning |
| --- | --- |
| `action` | The action, or `downmerge <source> → <target>` |
| `targetBranch`, `targetBranchHead` | The branch the plan is anchored to and its head commit: the branch modified, the base a new branch is cut from, or the downmerge target |
| `currentVersion` → `resultingVersion` | The version transition. Absent for downmerges; `resultingVersion` is absent for an abandon |
| `mutations` | Ordered. Each has a kind (`branch`, `commit`, `tag`, `push`, `pull-request`, `github-release`), an operation (`create`, or `delete`), a one-line summary, and optional detail lines |
| `warnings` | Conditions to weigh before approving (W1–W13). A confirmed plan with warnings is applied |
| `notices` | Facts that shape the plan without risk (N1–N4), rendered as "Notes:" |
| `checkOutput` | The tail of each failing pre-version check's output |
| `pipelineTrigger` | T1, when the apply is expected to start the pipeline |
| `digest` | The confirmation token |

Rendered, a plan reads:

```text
Action:  increment_release_candidate
Branch:  release/1.4.0 (at 3f2a1b0c9d8)
Version: 1.4.0-RC.1 → 1.4.0-RC.2

Would create:
  Commit: "To version 1.4.0-RC.2" on release/1.4.0
      files: VERSION
  Tag: annotated tag 1.4.0-RC.2
      message: Release version 1.4.0-RC.2
  Push: release/1.4.0 and tag 1.4.0-RC.2 to origin
  Pull request: update PR #41 (release/1.4.0 → develop)

Notes:
  - PR #41 is already open for release/1.4.0 → develop; it will be updated, not created.

Nothing has been changed. To apply, confirm with digest: 9c1e0d2b7a44
```

Deletions are grouped under `Would delete:`. `Warnings:`, `Notes:`, `Pipeline:` and
`Output of <check>:` blocks follow when present. The MCP server wraps the plan in
`📋 Plan — nothing has been changed yet` and `To apply, call <tool> again with:
confirm: "<digest>"`.

**CLI.** `--plan` prints the plan and writes `plan_digest` to `$GITHUB_OUTPUT`. Passing no
apply flag does the same, so the default never mutates. `--confirm <digest>` applies if
the digest matches. `--yes` applies without a digest, for automation that cannot round-trip
one, and prints the plan to stderr as a record. Contradictory flags are refused before git
is touched (U1–U3). A stale digest exits `1` with the new plan.

### What the digest covers

The digest is the first 12 hex characters of a SHA-256 over these lines, in order:

| Covered | Why |
| --- | --- |
| `action` | A digest for one action cannot apply another |
| `targetBranch` and `targetBranchHead` | Any push to the anchor branch invalidates the plan |
| `currentVersion`, `resultingVersion` (when set) | The transition approved is the one made |
| each mutation's operation, kind and **summary** | The objects approved. Summaries carry the facts that must invalidate a plan when they move: a downmerge source's head, a reverted commit's sha, a pull request's number, update versus open |
| each warning | A new risk (a check now failing, a hotfix now shipped) needs a new approval |
| each notice | Remote facts the head does not capture, such as a pull request opened meanwhile |

A notice and a warning with the same text digest differently.

| Not covered | Why |
| --- | --- |
| mutation `detail` lines (pull request titles, tag messages, file lists, recovery commands, release URLs) | Derived from covered facts, or presentation |
| `checkOutput` | Output carries timings and download progress that differ between two runs of the same check; the warning naming the failure is covered |
| `pipelineTrigger` | It depends on pull requests to any base, which open and close without the repository moving; the apply checks again after the push regardless. The configuration it reads is covered through the branch head |
| local branches other than the one acted on | Applies cut and reset from origin's refs, which the plan fetched. See [Remote state](#remote-state) |
| local commits not on origin | Version reads prefer origin, and the apply resets the branch to origin. The commits it drops are named in W14, which is covered |

### `dryRun`

`create_release_candidate`, `create_hotfix`, `increment_release_candidate`,
`release_version` and `revert_version` accept `dryRun` (MCP) or `--dry-run` (CLI). It is
older than the plan and less reliable; **use the plan instead**. Specifically:

- It only takes effect on an apply: the MCP tool needs `confirm`, the CLI `--confirm` or
  `--yes`. Without one, a plan is returned and `dryRun` is ignored.
- It skips checkouts, so every version it reads comes from the branch it is about, as the
  plan reads it (`origin/<branch>` first): `develop` for a release candidate, `main` for a
  hotfix, the selected branch for an increment or promotion. What is checked out does not
  matter.
- `create_release_candidate`'s dry run still fetches `main` and `develop` (step 1).
- It never runs the pipeline trigger. `revert_version`'s dry run does run every guard.

### Pre-version checks and the pipeline trigger

A repository can configure commands in `.release-management.json`: checks that run while a
plan is built for the four versioning actions, turning failures into warnings W7–W10, and
a trigger that starts CI after a push when the branch has no open pull request (T1–T10).
Both are described in [configuration.md](configuration.md).

---

## `health_check`

**Purpose.** Confirm the MCP server process is responsive. MCP only.

**Inputs.** None. **Mode.** Read-only. It does not read the repository, run git or contact
GitHub.

**Returns** pretty-printed JSON: `server` (`Release Management MCP Server`), `version` (the
package version), `build` (`commit` and `time` of the build; a commit suffixed `-dirty`
was built from an uncommitted tree), `status` (`healthy`), `timestamp` (ISO), and
`capabilities` (a list of descriptions).

---

## `list_versions` — read-only

**Purpose.** Show every release and hotfix branch with the facts needed to pick one
deliberately, before a mutating action.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `workingDirectory` | `--working-directory` | current directory |
| `productionBranch` | `--production-branch` | `main` |

**Steps.**

1. Read the checked-out branch (`git status --porcelain -b`).
2. Find every branch named exactly `release/X.Y.Z` or `hotfix/X.Y.Z`, locally and on origin
   (`git ls-remote --heads origin 'refs/heads/release/*'`, likewise `hotfix/*`),
   de-duplicated by name.
3. Per branch: read `VERSION` from `origin/<branch>` first, then the local branch; read the
   local branch's too, to detect staleness; check the tag locally (`git tag --list`) and
   on origin (`git ls-remote --tags`); check `git merge-base --is-ancestor
   <origin/branch, else branch> origin/<productionBranch>`.
4. Sort: the checked-out branch first, then by version, highest first.

**Effects.** None: no checkout, fetch, commit, tag, push or pull request.

**Each row.** Branch, version (or `no VERSION`), kind (`RC`, `final`, or `unknown` when no
VERSION is readable on either side), tag (`tag:remote`, `tag:local-only`, `tag:none`),
merge status (`merged→<productionBranch>` or `unmerged`), and `local-stale` when the local
branch holds a different VERSION from origin's. The tag column is live; merge status is
only as fresh as the last fetch.

**Messages.** G1, G13. MCP failures are returned as `❌ List Versions Failed`.

**CLI `$GITHUB_OUTPUT`.** `current_branch`, `release_candidates` (comma-separated RC
versions).

---

## `create_release_candidate`

**Purpose.** Cut a new release branch off `develop` and set it to `X.Y.Z-RC.0`.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `confirm` | `--plan` / `--confirm <digest>` / `--yes` | plan only |
| `releaseType`: `major`, `minor`, `patch` | `--release-type` | `minor` |
| `workingDirectory` | `--working-directory` | current directory |
| `dryRun` | `--dry-run` | `false` (see [dryRun](#dryrun)) |

**Version.** From `develop`'s `VERSION` `M.m.p`: major → `(M+1).0.0`, minor → `M.(m+1).0`,
patch → `M.m.(p+1)`. The branch is `release/<that>` and the version `<that>-RC.0`.

**Mode.** Plan → confirm.

**Plan.** Anchored on `develop` (`origin/develop` when it exists) and the `VERSION` at that
commit. Mutations: branch `release/X.Y.Z off develop`; commit `"To version X.Y.Z-RC.0" on
release/X.Y.Z`; tag `annotated tag X.Y.Z-RC.0`; push `release/X.Y.Z and tag X.Y.Z-RC.0 to
origin`; pull request `open release/X.Y.Z → develop`, or `update PR #n (…)`. Pre-version
checks run against `develop`'s head.

**Apply, in order.**

Nothing is fetched or pulled: the plan rebuilt just before the apply fetched, and every
step reads the remote-tracking refs it fetched.

1. Require `origin/main` to be in `origin/develop`, or to add no commits, or to add commits
   with no content difference. Otherwise A1. Runs on a dry run too.
2. Read `origin/develop`'s `VERSION` and compute the version and branch name from it.
3. `git checkout -B release/X.Y.Z origin/develop`. A local `release/X.Y.Z` that origin does
   not have is replaced (the plan warned, W14). Skipped on a dry run.
4. Delete a stale local tag `X.Y.Z-RC.0`; the versioner writes `VERSION`, commits and tags.
5. `git push -u origin release/X.Y.Z`, then `git push origin X.Y.Z-RC.0`.
6. Open the pull request (or update it, on 422). **A failure here fails the action.**
7. [Pipeline trigger](configuration.md#pipeline-trigger): normally `skipped`, since step 6
   opened a pull request.

**Pull request.** `release/X.Y.Z` → `develop`, title `RC X.Y.Z-RC.0 to develop`, not a
draft, no production warning. Body: `## Release Branch: release/X.Y.Z`, the version,
branch, target and type (such as `Minor Release Candidate`), the changes, and the six
completed workflow steps.

**Messages.** Refusals G1, G2, G4, G6, G7–G9, G14, U4/U5, P2–P7, D1. Warnings W1
(`develop`), W2, W7–W11, W14. Notes N1. Pipeline T2–T10. Apply failures A1–A4, A6–A10,
G12, G13.

**CLI `$GITHUB_OUTPUT`.** `release_type`, `version`, `pull_request_url`,
`pull_request_action`, `pipeline_trigger`.

### `create_release_candidate`: decision table

| Condition | Outcome |
| --- | --- |
| `releaseType` is not major, minor or patch | U4/U5 refusal |
| `origin/main` holds content `origin/develop` lacks | P7 refusal |
| `develop` has no readable `VERSION` | P3 refusal |
| `develop`'s `VERSION` is an RC | P4 refusal |
| `release/X.Y.Z` exists on origin | P6 refusal |
| `release/X.Y.Z` exists only locally | Replaced by the apply; W14 names any commits it holds that `origin/develop` does not |
| Tag `X.Y.Z-RC.0` exists on origin | P2 refusal |
| Tag `X.Y.Z-RC.0` exists only locally | No message; the apply deletes it before tagging |
| A shipped `hotfix/*` is not in `develop` | W1 warning |
| A configured check fails, times out or cannot run; its configuration is invalid | W7–W10 warning |
| `pipeline` section invalid | W11 warning |
| `release/X.Y.Z` → `develop` already open | N1 note; the pull request is updated |
| No `confirm` | Plan returned, nothing changed |
| `confirm` differs from the rebuilt plan | D1 refusal with a fresh plan |
| `confirm` matches | Apply |
| At apply, `origin/main` holds content `origin/develop` lacks | A1; nothing created. In practice unreachable: the rebuilt plan refuses first (P7) |

### `create_release_candidate`: partial failure and recovery

| Failed at | Left behind | Recover |
| --- | --- | --- |
| 1 | Nothing | Downmerge `main` into `develop`, plan again |
| 2 | Nothing | Repair `develop`'s `VERSION`, plan again |
| 3–4 | Local `release/X.Y.Z`, maybe a local commit and tag | Plan again: the local branch is replaced from `origin/develop` (W14) and the local tag dropped before tagging |
| 5, branch push | Local branch, commit and tag | As 3–4 |
| 5, tag push | Branch on origin without its tag | `git push origin X.Y.Z-RC.0`, then open the pull request by hand. Rerunning is refused (P6) |
| 6 | Branch and tag on origin, no pull request, and the pipeline trigger has not run | Open `release/X.Y.Z` → `develop` titled `RC X.Y.Z-RC.0 to develop` by hand (`gh pr create --base develop --head release/X.Y.Z`). Rerunning is refused (P6) |

---

## `create_hotfix`

**Purpose.** Cut a hotfix branch off `main` at the next patch `RC.0`, open its pull request
into `main`, and open a draft pull request into `develop` so the second destination is
visible from the start.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `confirm` | `--plan` / `--confirm <digest>` / `--yes` | plan only |
| `workingDirectory` | `--working-directory` | current directory |
| `dryRun` | `--dry-run` | `false` |

**Version.** `main`'s `VERSION` `M.m.p` → `hotfix/M.m.(p+1)` at `M.m.(p+1)-RC.0`.

**Mode.** Plan → confirm.

**Plan.** Anchored on `main`. It does not check `main`/`develop` synchronization or missing
hotfixes. Mutations: branch, commit, tag and push as for a release candidate; pull request
`open hotfix/X.Y.Z → main` (or update); pull request `open draft hotfix/X.Y.Z → develop`
(or `update PR #n (…)`). That last one's detail line reads `title: hotfix X.Y.Z to
develop`; the title actually used is `Hotfix X.Y.Z to develop`. Pre-version checks run
against `main`'s head.

**Apply, in order.**

Nothing is fetched or pulled, as for a release candidate.

1. Read `origin/main`'s `VERSION` and compute the version and branch name from it.
2. `git checkout -B hotfix/X.Y.Z origin/main`, replacing a local-only `hotfix/X.Y.Z` (W14).
   Skipped on a dry run.
3. Delete a stale local tag; the versioner commits and tags.
4. `git push -u origin hotfix/X.Y.Z`, then `git push origin X.Y.Z-RC.0`.
5. Pull request into `main`. **A failure here fails the action.**
6. Draft pull request into `develop`. A failure is reported (R7), not thrown.
7. Pipeline trigger: normally `skipped`.

**Pull requests.**

| Head → base | Title | Draft | Body |
| --- | --- | --- | --- |
| `hotfix/X.Y.Z` → `main` | `RC X.Y.Z-RC.0 to main` | no | `## Hotfix RC Branch: hotfix/X.Y.Z`, the production warning, "Each RC increment and the final release update this same pull request", version details, next steps (write the fix, increment, release, deploy then merge, downmerge into develop) |
| `hotfix/X.Y.Z` → `develop` | `Hotfix X.Y.Z to develop` | yes (an already-open one keeps its state) | `## Hotfix X.Y.Z to develop`, "Draft placeholder…", **This is not ready to merge** (it conflicts on `VERSION` by construction), next steps: ship through `main`, run the `hotfix` → `develop` downmerge after the deploy, close this draft once that one is merged |

**Messages.** Refusals G1, G2, G4, G6, G7–G9, G14, P2–P6, D1. Warnings W7–W11. Notes N1
(either pair), N2. Warning W14. Pipeline T2–T10. Apply failures A3, A6–A10. Report R7.

**CLI `$GITHUB_OUTPUT`.** `version`, `pull_request_url`, `pull_request_action`,
`pipeline_trigger`. The draft pull request's URL and error appear only in `--json`
(`trackingPullRequestUrl`, `trackingPullRequestError`).

### `create_hotfix`: decision table

| Condition | Outcome |
| --- | --- |
| `main` has no readable `VERSION` | P3 refusal |
| `main`'s `VERSION` is an RC | P4 refusal |
| `hotfix/X.Y.Z` exists on origin | P6 refusal |
| `hotfix/X.Y.Z` exists only locally | Replaced by the apply; W14 names any commits it holds that `origin/main` does not |
| Tag `X.Y.Z-RC.0` on origin | P2 refusal |
| Check or configuration problems | W7–W11 warnings |
| `hotfix/X.Y.Z` → `main` already open | N1; updated |
| `hotfix/X.Y.Z` → `develop` already open | N1; updated, keeps its draft state |
| `hotfix/X.Y.Z` → `develop` not open | N2; opened as a draft |
| Draft pull request fails | R7; the action still succeeds |

### `create_hotfix`: partial failure and recovery

As [`create_release_candidate`](#create_release_candidate-partial-failure-and-recovery),
with `hotfix/X.Y.Z` and `main`, and every step number one lower (there is no
synchronization step). If step 6 fails, open the draft by hand, or skip it: the
`hotfix` → `develop` downmerge does not need it.

---

## `increment_release_candidate`

**Purpose.** Raise the RC number on an existing release or hotfix branch:
`1.4.0-RC.1` → `1.4.0-RC.2`.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `confirm` | `--plan` / `--confirm <digest>` / `--yes` | plan only |
| `version` (base version, such as `1.4.0`) | `--version` | selected, see below |
| `workingDirectory` | `--working-directory` | current directory |
| `dryRun` | `--dry-run` | `false` |

### Branch selection for increment and release

Used by `increment_release_candidate` and `release_version`. Branch names carry no RC
suffix, so every decision reads `VERSION`, from `origin/<branch>` first and the local
branch second.

1. **`version` given.** Match it against the names `release/<version>` and
   `hotfix/<version>`, locally and on origin. Both exist: S1. Neither: S2. The match's
   version is read from `VERSION`; if unreadable, the name's version is used, and the plan
   then refuses with P1.
2. **No `version`, standing on `release/X.Y.Z` or `hotfix/X.Y.Z`.** Use it if its `VERSION`
   is an RC. Otherwise refuse (S3, or S4 when unreadable) rather than act on another
   release train.
3. **Otherwise.** The highest RC among release branches and the highest among hotfix
   branches, by major.minor.patch. If both exist, the higher wins, a tie going to the
   release branch, and S6 is logged. None: S5.

**Mode.** Plan → confirm.

**Plan.** Anchored on the branch (`origin/<branch>` when it exists). Mutations: commit
`"To version X.Y.Z-RC.(n+1)" on <branch>`; tag; push `<branch> and tag … to origin`; pull
request `open <branch> → <base>` or `update PR #n (<branch> → <base>)`, where `<base>` is
`develop` for a release branch and `main` for a hotfix branch. Pre-version checks run
against the branch head. W1 is checked for release branches only.

**Apply, in order.**

1. Select the branch again.
2. `git checkout <branch>`, or `git checkout -b <branch> origin/<branch>` when there is no
   local branch. Nothing is pulled.
3. `git reset --keep origin/<branch>`, so the branch is exactly what the plan read: commits
   only the clone has are dropped from it (the plan warned, W14), and uncommitted changes
   are kept or the reset fails. Skipped for a branch origin does not have.
4. Validate: the working tree's `VERSION` must be an RC (A12), and the branch's
   major.minor.patch must not be below its base's (A13, A14). The base's `VERSION` is read
   with `git show`, from `origin/<base>` first. This check is not in the plan.
5. Delete a stale local tag; the versioner commits and tags.
6. `git push -u origin <branch>`, then `git push origin <tag>`.
7. Open or update the pull request. A failure is reported (R1), not thrown.
8. Pipeline trigger: normally `skipped`; it can start a build if step 7 failed and the
   branch heads no other open pull request.

**Pull request.** `<branch>` → `develop` (release) or `main` (hotfix), title
`RC X.Y.Z-RC.n to <base>`, not a draft, production warning when the base is `main`. Body:
`## <Release|Hotfix> Candidate Increment`, version details, the seven completed steps, and
"Use `release_version` tool when ready for production".

**Messages.** Refusals G1, G2, G5, G6, G7–G9, G14, S1–S5, S7, P1, P2, D1. Warnings W1, W2
(release branches), W7–W11, W14. Notes N1. Pipeline T2–T10. Apply failures A11–A18. Report R1.

**CLI `$GITHUB_OUTPUT`.** `branch`, `version`, `pull_request_url`, `pull_request_action`,
`pull_request_error`, `pipeline_trigger`.

### `increment_release_candidate`: decision table

| Condition | Outcome |
| --- | --- |
| Selection fails | S1–S5 refusal |
| Selected branch is not at an RC | P1 refusal |
| Next RC tag on origin | P2 refusal |
| Release branch missing a shipped hotfix | W1 warning |
| Local branch has commits origin does not | W14 warning; the apply resets the branch to origin |
| Check or configuration problems | W7–W11 warnings |
| Pull request to the base already open | N1; updated |
| At apply, branch below its base's version | A13; nothing created |
| Pull request step fails | R1; the version is already pushed |

### `increment_release_candidate`: partial failure and recovery

| Failed at | Left behind | Recover |
| --- | --- | --- |
| 2–4 | Branch checked out, maybe pulled | Fix the cause, plan again |
| 5 | Maybe a local commit and tag | Plan again. The plan warns about the local commit (W14), and the apply resets the branch to origin and drops the local tag before tagging |
| 6, branch push | Local commit and tag ahead of origin | As 5: plan again. The plan promises `RC.(n+1)` from origin and the apply produces it, dropping the unpushed commit and tag first |
| 6, tag push | Commit on origin, tag only local | `git push origin <tag>`. `list_versions` shows `tag:local-only` |
| 7 | Everything on origin, pull request not written (R1) | Edit or open the pull request by hand |

---

## `release_version`

**Purpose.** Promote a release candidate to its final version (`1.4.0-RC.3` → `1.4.0`), tag
it, create the GitHub release, and open the pull requests that take it to `main` and back
to `develop`.

**Inputs.** As `increment_release_candidate`. **Selection.** The same
[branch selection](#branch-selection-for-increment-and-release).

**Mode.** Plan → confirm.

**Plan.** Anchored on the branch. Mutations: commit `"To version X.Y.Z" on <branch>`; tag;
push; pull request `open <branch> → main` (or update); GitHub release `X.Y.Z with
auto-generated notes`; pull request `open <branch> → develop` (or update). The plan also
rehearses the eventual merge into `main`, read-only (`git rev-list`, `git diff`,
`git merge-tree`), and warns (W3–W6) rather than refusing: promotion is the last cheap
moment to take `main`'s changes in first. W1 is checked for release branches only.

**Apply, in order.** The numbers match the progress list the tools print.

1. Select the branch again.
2. Check it out, as `increment_release_candidate` step 2.
3. Reset it to `origin/<branch>`, as `increment_release_candidate` step 3.
4. Require the working tree's `VERSION` to be an RC (A19), delete a stale local tag, then
   the versioner commits `To version X.Y.Z` and tags `X.Y.Z`.
5. `git push origin <branch>` (no upstream set).
6. `git push origin X.Y.Z`.
7. Open or update `<branch>` → `main`. A failure is reported (R1), not thrown.
8. For a hotfix, log the deploy-before-merge warning.
9. Create the GitHub release. Release notes are requested from GitHub's
   `generateReleaseNotes` up to three times (waiting 1 s, then 2 s). The release is created
   with tag `X.Y.Z`, name `Release X.Y.Z`, `target_commitish` the branch, and the notes as
   its body. If no notes were obtained, up to three more attempts follow and the body is
   patched in; otherwise R2–R5. **A failure to create the release fails the action** (A23).
10. Open or update `<branch>` → `develop`, for release **and** hotfix branches. A failure
    is reported (R6), not thrown.

Then the pipeline trigger: normally `skipped`.

**Pull requests.**

| Head → base | Title | Draft | Body |
| --- | --- | --- | --- |
| `<branch>` → `main` | `Release X.Y.Z to main` | no | `## <Release\|Hotfix> Version X.Y.Z`, the production warning, version details, "Released version X.Y.Z (converted from RC)" |
| `<branch>` → `develop` | `Release X.Y.Z to develop`, or `Hotfix X.Y.Z to develop` | no when opened here; a hotfix's draft stays a draft | `## <Release\|Hotfix> X.Y.Z to develop`, "has been promoted from a release candidate to X.Y.Z, and this PR merges it back into develop", version details, next step "Merge once X.Y.Z has been deployed to production" |

The `develop` titles match the `release` → `develop` downmerge's and the hotfix tracking
draft's, so those actions converge on one pull request. For a hotfix, this rewrites the
draft placeholder's body with the "merge once deployed" text, or opens a non-draft
`hotfix/X.Y.Z` → `develop` pull request when the draft was closed.

**GitHub release.** Tag `X.Y.Z`, name `Release X.Y.Z`, target the branch, auto-generated
notes. Not a draft or a prerelease, so GitHub makes it the Latest release by default.

**Messages.** Refusals as `increment_release_candidate`. Warnings W1, W2, W3–W6, W7–W11, W14.
Notes N1 (both pairs). Pipeline T2–T10. Apply failures A11, A19–A23. Reports R1–R6.

**CLI `$GITHUB_OUTPUT`.** `branch`, `version`, `pull_request_url`, `pull_request_action`,
`pull_request_error`, `release_url`, `release_notes_warning`, `own_base_pull_request_url`,
`own_base_pull_request_action`, `own_base_pull_request_error`, `pipeline_trigger`.

### `release_version`: decision table

| Condition | Outcome |
| --- | --- |
| Selection fails, branch not at an RC, tag `X.Y.Z` on origin | S1–S5, P1, P2 refusal |
| `main` has commits the branch lacks | W3 warning |
| Merging the branch into `main` would conflict | W4 warning; the downmerge into `main` will hand off H2 |
| Those checks could not run | W5, W6 warning |
| Release branch missing a shipped hotfix | W1 warning |
| Local branch has commits origin does not | W14 warning; the apply resets the branch to origin |
| Check or configuration problems | W7–W11 warnings |
| Pull request to `main` or `develop` already open | N1; updated |
| Branch is a hotfix | The deploy warning is logged; the `develop` pull request is `hotfix/X.Y.Z` → `develop` |
| A pull request step fails | R1 or R6; the version, tag and release exist |
| Release creation fails | A23; tag on origin, no release, no `develop` pull request |

### `release_version`: partial failure and recovery

| Failed at | Left behind | Recover |
| --- | --- | --- |
| 2–3 | Branch checked out, maybe pulled | Fix the cause, plan again |
| 4 | Maybe a local commit and tag | Plan again; the apply resets the branch to origin (W14) |
| 5 | Local commit and tag ahead of origin | Plan again. The plan reads origin (still the RC), warns about the unpushed final commit (W14), and the apply promotes origin's RC afresh |
| 6 | Final commit on origin, tag local | `git push origin X.Y.Z`, then do 7, 9 and 10 by hand. A rerun is refused (P1: the branch is no longer an RC) |
| 7 | Reported (R1) | Open `<branch>` → `main` by hand with the production warning |
| 9 | Tag on origin, no GitHub release, no `develop` pull request | `gh release create X.Y.Z --target <branch> --title "Release X.Y.Z" --generate-notes`, then open or update `<branch>` → `develop` by hand. Rerunning is refused (P1) |
| 10 | Reported (R6) | Open or edit `<branch>` → `develop` by hand |

To undo the promotion instead, use [`revert_version`](#revert_version).

---

## `revert_version`

**Purpose.** Undo the most recent version bump on a release or hotfix branch and remove the
tag it created. The only action that deletes things.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `confirm` | `--plan` / `--confirm <digest>` / `--yes` | plan only |
| `version` (base version, such as `1.4.0`) | `--version` | the checked-out branch |
| `workingDirectory` | `--working-directory` | current directory |
| `dryRun` | `--dry-run` | `false` |

**Selection.** `version` given: match the names `release/<version>` and `hotfix/<version>`
(both: S8; neither: S9). Otherwise the checked-out branch, which must be a release or
hotfix branch (S10) with a readable `VERSION` (S11). There is no fallback to the newest
branch: this action deletes tags and can delete a branch. Final versions are accepted.

**Guards, in order** (all refusals): no readable `VERSION` at the head (P9); the head's
subject is not `To version <current version>` (P10); the head is already in `origin/main`
(P11); for the abandon shape, the branch holds other commits not in `origin/<base>` (P12).

**Shape.** Decided by the `VERSION` in the bump commit's parent:

| Parent's `VERSION` | Shape | Example |
| --- | --- | --- |
| None | abandon | — |
| The same as the head's | abandon | — |
| A different release (with RC suffixes stripped, it differs from the head's) | abandon | `1.5.0-RC.0` whose parent is `develop`'s `1.4.0` |
| Another version of the same release | revert | `1.4.0-RC.2` → `1.4.0-RC.1`; `1.4.0` → `1.4.0-RC.3` |

This holds even when the earlier version is already in `develop`, as it is once a release
candidate's pull request into `develop` is merged. The diagram is in
[flows.md](flows.md#revert-shape).

**Mode.** Plan → confirm. Every guard runs again at apply time.

**Plan.** Anchored on the branch head. The base is `develop` for a release branch and
`main` for a hotfix branch.

- Revert shape: commit `revert of <sha11> "To version <v>" on <branch>`; tag deletions
  (`<v> locally`, `<v> on origin`) for whichever exist; for a final with a GitHub release,
  its deletion (details: its URL, `the Latest marker moves to the previous release`,
  `release notes are destroyed, including any hand edits`); push `<branch> to origin`;
  pull request `update PR #n to <resulting>` if one is open on the base.
- Abandon shape: tag deletions; GitHub release deletion; pull request `close PR #n, with a
  comment explaining why`; branch `<branch> on origin and locally, at <sha11>` with the
  detail `recovery: git branch <branch> <sha11> — if you act before gc`.

**Apply, revert shape.**

1. Check out the branch and reset it to `origin/<branch>`, as `increment_release_candidate`
   steps 2 and 3. Nothing is pulled.
2. `git revert --no-edit <head>`, giving the commit `Revert "To version <v>"`. A conflict is
   aborted (A24); nothing is changed.
3. Delete the tag on origin (`git push origin :refs/tags/<v>`), then locally (`git tag -d`),
   each only if it exists.
4. Delete the GitHub release, for a final version that has one (A25 on failure).
5. `git push -u origin <branch>` (A26 on failure).
6. If a pull request is open on the base, update it. A failure is reported (R8).
7. Pipeline trigger, with `RELEASE_VERSION` set to the resulting version: `started` when no
   pull request is open on the branch (the plan showed T1), otherwise `skipped`.

**Apply, abandon shape.**

1. Delete the tag on origin, then locally.
2. If a pull request is open on the base, comment and close it. A failure is reported (R8).
3. Check out and pull the base, then delete the branch on origin
   (`git push origin :refs/heads/<branch>`) and locally (`git branch -D`).

No pipeline trigger: the branch is gone. The order is chosen for partial failure: tags
first while their commit is still reachable, the explanation before the closure, and the
least recoverable step last.

**Pull requests.** Revert: the open pull request on the base gets the title
`RC <resulting> to <base>` and a body headed `## Release Candidate Reverted`, naming the
reverted commit and version, the resulting version, the deleted tag, and "Deleting the tag
does not undo a build or deployment it already triggered." Abandon: the open pull request
on the base is closed with the comment in
[messages.md](messages.md#text-written-to-github). Only the pull request on the branch's
base is touched: after reverting a promoted release, the `release/X.Y.Z` → `main` pull
request keeps its `Release X.Y.Z to main` title, and a hotfix's `develop` pull request is
left as it was (GitHub closes it, without a comment, when an abandon deletes the branch).

**Messages.** Refusals G1, G2, G4 (CLI), G6, G7–G9, G11, S8–S11, P9–P12, D1. Warnings W11
(revert shape), W12, W13, W14. Notes N3, N4. Pipeline T1–T10 (revert shape). Apply failures
A24–A27. Report R8.

**CLI `$GITHUB_OUTPUT`.** `branch`, `shape` (`revert` or `abandon`), `reverted_version`,
`resulting_version`, `tag_deleted_remotely`, `branch_deleted`, `pull_request_url`,
`pull_request_action` (`updated` or `closed`), `pull_request_error`, `pipeline_trigger`.

### `revert_version`: decision table

| Condition | Outcome |
| --- | --- |
| No `version`, not on a release or hotfix branch | S10 refusal |
| Head is not `To version <v>` | P10 refusal |
| Head is in `origin/main` | P11 refusal |
| Parent holds another version of the same release | revert shape |
| Otherwise | abandon shape, W13 |
| Abandon, and the branch holds other commits not in its base | P12 refusal |
| Version is final | W12; its GitHub release is deleted if there is one |
| Local branch has commits origin does not | W14; the revert resets the branch to origin first, the abandon deletes it with them |
| Tag missing locally and on origin | N3; no tag deletion planned |
| Always | N4 |
| Revert shape, no open pull request on the branch | T1 in the plan; the trigger runs after the push |
| `git revert` conflicts | A24; nothing changed |

### `revert_version`: partial failure and recovery

| Failed at | Left behind | Recover |
| --- | --- | --- |
| Revert 2 | Nothing (the revert is aborted) | Revert by hand |
| Revert 3 | Local revert commit; perhaps the tag deleted on origin | Delete the remaining tag, push the branch, by hand |
| Revert 4 | Local revert commit, tag deleted | Delete the release by hand, then `git push origin <branch>` |
| Revert 5 | Local revert commit, tag and release deleted | `git push origin <branch>`, then update the pull request by hand |
| Revert 6 | Reported (R8) | Edit the pull request by hand |
| Abandon 2 | Reported (R8); the branch is still deleted | Close the pull request by hand |
| Abandon 3 | Tag deleted, pull request closed, branch maybe still on origin | `git push origin --delete <branch>` |

A deletion that origin rejects (for example a protected branch or tag) is not reported as
a failure: the result says `not on origin` for the tag, and still reports the branch as
deleted. Check with `git ls-remote origin` after an abandon. To undo an abandon, recreate
the branch from the sha in the plan or the closing comment:
`git branch <branch> <sha> && git push origin <branch>`.

---

## `initialize_versioner`

**Purpose.** Bootstrap version management in a repository that has none.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `version` | `--version` | `0.1.0-RC.0` |
| `workingDirectory` | `--working-directory` | current directory |

**Mode.** Immediate. No plan and no dry run: nothing leaves the clone.

**Apply, in order.**

1. Check the directory is a git repository (G1) and nothing is staged (G2).
2. Read the short `HEAD` hash; the repository needs a commit (A33).
3. Create `VERSION` with two lines, the version then the hash. An existing `VERSION`,
   tracked or not, refuses (A32).
4. `git add VERSION`, `git commit -m "To version <version>"`,
   `git tag "<version>" -a -m "Release version <version>"`, on the current branch.

Nothing is pushed and no pull request is opened.

In the MCP server, the versioner is bound to the `workingDirectory` of the first
`initialize_versioner` call the process serves; restart the server before initializing a
second repository.

**Messages.** G1, G2, A32–A35. The MCP server reports a failure as text under
`❌ Failed to initialize versioner`, without marking the call as an error.

**CLI `$GITHUB_OUTPUT`.** `version`, `is_release_candidate`.

### `initialize_versioner`: partial failure and recovery

| Failed at | Left behind | Recover |
| --- | --- | --- |
| 3, malformed `version` (A34) | An untracked `VERSION` holding the bad value; a rerun is refused (A32) | `rm VERSION`, rerun with a valid version |
| 4, tag exists (A35) | The commit `To version <v>`, no new tag | Inspect the existing tag; tag by hand or reset the commit |

---

## `downmerge`

**Purpose.** Bring one branch into another through a pull request. One tool covers five
routes:

| `source` → `target` | CLI command | Pull request head | Merge commit |
| --- | --- | --- | --- |
| `main` → `develop` | `downmerge main-to-develop` | merge branch `main-into-develop-<ts>` off `develop` | `Downmerge main into develop` |
| `release` → `develop` | `downmerge release-to-develop` | `release/X.Y.Z` itself | none |
| `release` → `main` | `downmerge release-to-main` | merge branch `release-X.Y.Z-into-main-<ts>` off `main` | `Merge release/X.Y.Z into main` |
| `hotfix` → `develop` | `downmerge hotfix-to-develop` | merge branch `hotfix-X.Y.Z-into-develop-<ts>` off `develop` | `Merge hotfix/X.Y.Z into develop` |
| `hotfix` → `main` | `downmerge hotfix-to-main` | `hotfix/X.Y.Z` itself | none |

A merge branch keeps CI workflows keyed on a `release/*` or `hotfix/*` head from rebuilding
an artifact that was already cut.

**Inputs.**

| MCP | CLI | Default |
| --- | --- | --- |
| `source`, `target` | the subcommand name | required |
| `version` (release and hotfix sources; ignored for `main`) | `--version` | the newest branch of the source type |
| `workingDirectory` | `--working-directory` | current directory |

**Source selection.** By branch **name**, locally and on origin: `version` must equal the
`X.Y.Z` in `release/X.Y.Z` or `hotfix/X.Y.Z` (S12). Without it, the highest
major.minor.patch of that type is taken (S13 if none), whatever its `VERSION` and even if
it is already merged, in which case the plan refuses with P8. Pass `version` when more
than one branch of the type exists. Titles use the version from the branch name.

**Mode.** Immediate: there is no plan to confirm, and no dry run. The MCP tool takes no
`confirm`; one sent anyway is ignored. The CLI accepts `--confirm` and `--yes` and ignores
them, and rejects `--plan` (U7). Before creating anything, the downmerge builds the plan it
used to show and stops if that refuses or hands off. The plan's warnings and notes are
returned with the result.

**Checks before anything is created.** Preconditions G1 and G2 (no versioner needed).
Then, comparing `origin/<target>` and the source as they stand in the clone: a
`git merge-tree` preview (P13 if it cannot run), a conflict hands off (H1 into `develop`,
H2 into `main`), and a source already in the target refuses (P8). For `release` →
`develop` and `hotfix` → `main`, an open pull request for the pair is noted (N1) and
updated.

### Apply, per route

The plan built first fetched origin ([Remote state](#remote-state)); the merge-branch routes
fetch and pull nothing more, and merge only remote-tracking refs, so the pull request
carries exactly what the plan previewed and no commit that only the clone has.

**`main` → `develop`.**

1. Title from `main`'s newest non-merge commit (`git log -1 --no-merges origin/main`):
   `To version <v>` gives `Release <v> to develop`; anything else gives
   `Downmerge main into develop`.
2. `git checkout -b main-into-develop-<ts> origin/develop`,
   `git merge --no-ff -m "Downmerge main into develop" origin/main`. A conflict aborts the
   merge, deletes the local branch, returns to `develop` and hands off H1. A merge that adds
   nothing deletes the local branch and fails with A28.
3. `git push -u origin main-into-develop-<ts>`.
4. Open the pull request into `develop`. Body: `## Downmerge Main to Develop`, source,
   target, and the version when detected. No warning.

The result reports only the pull request URL; the merge branch name is not returned
(`kind` is `direct`). Look it up on the pull request.

**`release` → `develop`.**

1. Check out and pull `develop`, then `release/X.Y.Z`.
2. Trial merge in the working tree: refuse tracked modifications (A29), check out and pull
   `develop`, `git merge --no-commit --no-ff release/X.Y.Z`, list conflicts,
   `git merge --abort`, and `git reset --hard` to where `develop` was if the trial moved it.
   Conflicts hand off H1; a failure without conflicts is A30.
3. Open or update `release/X.Y.Z` → `develop`, titled `Release X.Y.Z to develop`. Body:
   `## Release X.Y.Z to develop`, "This PR merges the release branch back into develop",
   the version, branch, target and type. No warning. This is usually the pull request
   `release_version` already opened, so it is updated.

**`release` → `main`.**

1. As `main` → `develop` step 2: `release-X.Y.Z-into-main-<ts>` off `origin/main`, merging
   `origin/release/X.Y.Z` with the message `Merge release/X.Y.Z into main`. A conflict hands
   off H2.
2. `git push -u origin release-X.Y.Z-into-main-<ts>`.
3. Open the pull request into `main`, titled `Release X.Y.Z to main`. Body:
   `## Release X.Y.Z to main`, the production warning, why a merge branch is used, and the
   version, source, target and merge branch.

`release_version` already opened `release/X.Y.Z` → `main`, so `main` has two open pull
requests for the release until one is merged; GitHub marks the other merged once its head
is in `main`.

**`hotfix` → `develop`.**

1. As `main` → `develop` step 2: `hotfix-X.Y.Z-into-develop-<ts>` off `origin/develop`,
   merging `origin/hotfix/X.Y.Z` with the message `Merge hotfix/X.Y.Z into develop`. A
   conflict hands off H1.
2. `git push -u origin hotfix-X.Y.Z-into-develop-<ts>`.
3. Open the pull request into `develop`, titled `Hotfix X.Y.Z to develop`. Body:
   `## Hotfix X.Y.Z to develop`, why a merge branch is used, version details. No warning.
4. Find the open `hotfix/X.Y.Z` → `develop` pull request (the draft from `create_hotfix`, or
   the one `release_version` opened), comment `Superseded by <url>…` and close it. A
   failure is only logged (R9).

**`hotfix` → `main`.**

1. Preview the merge of `origin/hotfix/X.Y.Z` into `origin/main` again, on the refs the plan
   fetched; a conflict hands off H2. No checkout.
2. Open or update `hotfix/X.Y.Z` → `main` (normally the one `create_hotfix` opened), titled
   `Release X.Y.Z to main`. Body: `## Hotfix X.Y.Z to main`, the production warning, and
   version details.

### Downmerge conflicts

A conflict creates nothing: no branch, no push, no pull request. The tools never push a
conflicted merge. Into `develop` the handoff is work to carry out (H1, "Manual downmerge
needed"): the conflicted files, the branch to resolve them on, the title, and numbered
steps. Into `main` it is a decision for a human (H2, "Decision needed"): `main` mirrors
production, so nothing is resolved and two options are offered. The MCP server returns the
handoff as text; the CLI prints it to stderr and exits `1`. The procedure is
[manual-downmerge.md](manual-downmerge.md); the exact text is in
[messages.md](messages.md#downmerge-handoffs).

**Messages.** Refusals G1, G2, G7–G9, G14, U6, U7, S12, S13, P8, P13. Notes N1. Handoffs H1,
H2. Apply failures A28–A31. Report R9. MCP failures are returned as `❌ Downmerge Failed`.

**CLI `$GITHUB_OUTPUT`.** `kind` (`direct` or `merge-branch`), `pull_request_url`, and
`merge_branch` for `release` → `main` and `hotfix` → `develop`. `main` → `develop` reports
`kind=direct` and no `merge_branch`, although it uses one.

### `downmerge`: decision table

| Condition | Outcome |
| --- | --- |
| Not one of the five routes | U6 refusal |
| No branch of the source type, or none named for `version` | S13, S12 refusal |
| `git merge-tree` cannot compare the two | P13 refusal |
| The merge conflicts, target `develop` | H1 handoff; nothing created |
| The merge conflicts, target `main` | H2 handoff; nothing created |
| The source is already in the target | P8 refusal |
| `release` → `develop` with tracked changes in the working tree | A29; nothing created |
| A pull request for the pair is already open (direct routes) | N1; updated |
| A merge-branch route run twice before the first pull request merges | A second merge branch and pull request |
| The conflict appears only during the apply | The same handoff; the local merge branch is deleted |
| Closing the superseded draft fails (`hotfix` → `develop`) | R9, logged only |

### `downmerge`: partial failure and recovery

| Route | Failed at | Left behind | Recover |
| --- | --- | --- | --- |
| merge-branch routes | push | A local merge branch, checked out | `git checkout <target> && git branch -D <merge-branch>`, rerun |
| merge-branch routes | pull request | The merge branch on origin, no pull request | Open the pull request from it by hand with the route's title, or delete it (`git push origin --delete <merge-branch>`) and rerun. A rerun creates a new merge branch; it does not reuse this one |
| `hotfix` → `develop` | closing the draft | The new pull request, and the draft still open | Close the draft by hand |
| `release` → `develop`, `hotfix` → `main` | pull request | Nothing on origin | Rerun |

---

## Version mutation primitives

The actions delegate every version change to these, which are also usable on their own and
are the only code that writes `VERSION`. Each rewrites `VERSION`, then stages, commits and
tags as in [Version commits and tags](#version-commits-and-tags).

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

`versioner show` and `rake version:show` are read-only. The `versioner` CLI also accepts
the underscored aliases `patch_release_candidate`, `minor_release_candidate`,
`major_release_candidate` and `increment_release_candidate`, plus `help`, `--help` and
`-h`; with no arguments it prints help. `versioner init` takes its version from the
argument, then the `VERSION` environment variable, then `0.1.0-RC.0`.

**Guard rails**, identical in both implementations: `patch`, `minor`, `major` and the three
`*-rc` operations refuse while an RC is active (`There's an active release candidate
(<v>). Do you want to: …`); `increment-rc` refuses on a final version (`Cannot increment
the release candidate version on a non release candidate.`); `release` refuses on a final
version (`Cannot release a non release candidate.`); `init` refuses when `VERSION` exists.
