# Message catalog

Every message the release-management actions can show a human: refusals, plan warnings,
plan notes, conflict handoffs, pipeline-trigger results, failures part-way through an
apply, and problems an apply reports without failing. Use it to look up a message you
have been shown, or to check what an action can say before you approve it.

Per-action behaviour is in [actions.md](actions.md). Configuration messages come from
`.release-management.json`, described in [configuration.md](configuration.md).

## How this catalog was compiled

From the source, not from older documents. Every string below was found with:

```sh
cd js/packages
grep -nE 'throw new|warnings\.push|notices\.push|pipelineTrigger:|message:|notesWarning|lastWarning =|UsageError\(|console\.warn|step\.message|mergePreview =|manualDownmerge =' \
  release-management-core/src/*.ts \
  release-management-cli/src/*.ts release-management-cli/src/commands/*.ts \
  release-management-mcp/src/index.ts
grep -n 'throw new Error' versioner/lib/*.js
```

and each hit was read in context to find its condition and which actions reach it. Two
families are assembled away from their `throw`: the GitHub App failures G22–G24 (and the
G21 text) are returned by `describeFailure` in `release-management-core/src/github-app-auth.ts`,
and the G26 suffix by `explainForbidden` in `github-client.ts`; read both functions too.

**A pull request that adds, removes or rewords a message updates this catalog in the same
pull request.** See [Maintaining these documents](README.md#maintaining-these-documents).

## Reading the tables

**Placeholders** are in angle brackets: `<branch>` is a branch such as `release/1.4.0`,
`<v>` a version such as `1.4.0-RC.2`, `<sha11>` the first 11 characters of a commit,
`<err>` the text of an underlying error, `<n>` a count.

**Categories.**

| Category | Meaning | What has changed when you see it |
| --- | --- | --- |
| refusal | The action stopped before changing anything. An approval cannot get past it. | Nothing but remote-tracking refs, which every plan fetches |
| warning | Listed under "Warnings:" in a plan. The action can go ahead; a human should weigh it before confirming. Covered by the digest. | Nothing yet |
| note | Listed under "Notes:" in a plan. Informational. Covered by the digest. | Nothing yet |
| handoff | A downmerge conflicts. Nothing was created; the message is the procedure to finish by hand, or the decision to make. | Nothing |
| pipeline | About the pipeline trigger: the plan's prediction, or the apply's outcome. | The version is already on origin |
| apply failure | The action failed after it started changing things. Something may be left behind; see the action's *Partial failure and recovery* section. | Possibly local or remote changes |
| apply report | The action succeeded, but one secondary step did not. Reported with the result, not thrown. | The main change happened |
| log | Printed to the console only (stderr for the MCP server; silenced by the CLI's `--quiet` and `--json`). Not part of the result. | Varies |

**Action codes.** RC `create_release_candidate`, HF `create_hotfix`, INC
`increment_release_candidate`, REL `release_version`, REV `revert_version`, INIT
`initialize_versioner`, LV `list_versions`, DM `downmerge` (DM m→d, r→d, r→m, h→d, h→m for
one route), ALL every action that touches the repository.

**Where the text appears.** The MCP server prefixes a failure with a status line such as
`❌ Increment Release Candidate Workflow Failed` and puts the message after `💥 Error:`.
The CLI writes `Error: <message>` to stderr and exits `1` (user error) or `2`
(environment error); see [Exit codes](#cli-exit-codes).

---

## Guards (every action)

| ID | Exact text | Category | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| G1 | `Directory '<dir>' is not a Git repository` | refusal | ALL | `git rev-parse --git-dir` fails in the working directory | Pass the repository root as `workingDirectory` / `--working-directory` |
| G2 | `❌ Cannot proceed: Staged changes detected in git repository` followed by `📋 Staged files:`, the list, and three ways to unstage | refusal | RC, HF, INC, REL, REV, INIT, DM | `git status --porcelain` shows a staged file | Commit or unstage (`git reset HEAD`), then rerun |
| G3 | `Failed to validate git status: <err>` | refusal | as G2 | `git status` itself failed | Inspect the repository |
| G4 | `Versioner MCP is not available. Please ensure versioner-mcp is running.` | refusal | MCP: RC, HF. CLI: every plan-aware command, including `revert-version` | The versioner library did not load. In practice unreachable: the in-process client always reports itself connected | Reinstall the package |
| G5 | `Versioner is not available; the version management library failed to load.` | refusal | MCP: INC, REL | As G4 | As G4 |
| G6 | `Failed to initialize ReleaseAgent: Error: Failed to initialize versioner connection: <err>` | refusal | RC, HF, INC, REL, REV (and every CLI plan-aware command) | Loading the versioner library threw | As G4 |
| G7 | `No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run 'gh auth login' so `` `gh auth token` `` returns a token.` | refusal, or apply failure if first reached mid-apply | Any action that calls GitHub | No token from any source; see [token resolution](configuration.md#github-token-resolution) | Set a token |
| G8 | `Could not parse owner/repo from origin URL: <url>. Expected github.com SSH or HTTPS URL.` | refusal / apply failure | as G7 | `origin` is not `git@github.com:owner/repo(.git)` or `https://github.com/owner/repo(.git)` | Fix the `origin` remote |
| G9 | `Failed to look up existing PR for '<branch>' → '<base>': <err>` | refusal (plan) / apply failure | RC, HF, INC, REL, REV, DM r→d, h→d, h→m | The GitHub pull-request list call failed | Check the token's scope and GitHub status, rerun |
| G10 | `Failed to look up open PRs from '<branch>': <err>` | surfaces inside T5 | RC, HF, INC, REL, REV | As G9, for the pipeline trigger's lookup | As G9 |
| G11 | `Failed to look up the GitHub release for <tag>: <err>` | refusal | REV (final versions) | GitHub answered something other than 200 or 404 | As G9 |
| G12 | `Git command timed out after <ms>ms: git <command>. The operation may have partially completed — inspect the repository before retrying.` | apply failure (or refusal while planning) | ALL | A local git command ran past 30 s, or a network one (`fetch`, `push`, `pull`, `clone`, `ls-remote`, `remote`, `submodule`) past 300 s | Inspect the repository and origin before rerunning |
| G13 | `Git command failed: <err>` | apply failure (or refusal while planning) | ALL | Any git command exited non-zero where no more specific message applies. With a GitHub App, an installation token or its git header value in `<err>` reads `[REDACTED]` | Read `<err>` |
| G14 | `Could not resolve a commit for branch '<branch>'` | refusal | RC, HF, INC, REL, REV, DM | Neither `origin/<branch>` nor `<branch>` resolves | Fetch, or create the base branch |
| G15 | `Failed to look up open PRs into '<base>': <err>` | refusal | DM m→d, r→m, h→d | Listing the open pull requests into the target, to find an earlier run's merge-branch pull request, failed | As G9 |
| G16 | `A GitHub App private key is set (GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH) but GITHUB_APP_ID is not. Set GITHUB_APP_ID to authenticate as the app, or unset the key to use a token.` | refusal, or apply failure if first reached mid-apply | as G7, and every git network command | A key variable is non-empty and `GITHUB_APP_ID` is unset or empty; see [GitHub App authentication](configuration.md#github-app-authentication) | Set `GITHUB_APP_ID`, or unset the key |
| G17 | `GITHUB_APP_ID is set but no private key is: set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH, or unset GITHUB_APP_ID to use a token.` | as G16 | as G16 | `GITHUB_APP_ID` is non-empty and neither key variable is | Set a key, or unset `GITHUB_APP_ID` |
| G18 | `Both GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are set. Set only one of them.` | as G16 | as G16 | Both key variables are non-empty | Unset one |
| G19 | `<source> does not hold a valid RSA private key in PEM form. Use the whole .pem file GitHub generated for the app, including its BEGIN and END lines; literal \n sequences are accepted in place of newlines.` | as G16 | as G16 | The key does not parse, or is not RSA. `<source>` is `GITHUB_APP_PRIVATE_KEY` or `The file named by GITHUB_APP_PRIVATE_KEY_PATH (<path>)`. The key is never shown | Paste or point at the app's `.pem` file |
| G20 | `Could not read the GitHub App private key file named by GITHUB_APP_PRIVATE_KEY_PATH (<path>): <code>.` | as G16 | as G16 | Reading the file failed; `<code>` is the system error code, such as `ENOENT` or `EACCES` | Fix the path or the file's permissions |
| G21 | `GitHub App <id> is not installed on <owner>/<repo> (404). Install the app on that repository, or add the repository to the installation's selected repositories.` | as G16 | as G16 | `GET /repos/<owner>/<repo>/installation` answered 404 | Install the app on the repository |
| G22 | `GitHub rejected the credentials of GitHub App <id> (401) while <step>. Check that GITHUB_APP_ID is the app's ID or client ID, that the private key belongs to that app and has not been deleted, and that this machine's clock is correct.[ GitHub said: <msg>]` | as G16 | as G16 | GitHub refused the app's JWT, or the installation token when looking up the bot user. `<step>` is one of `looking up its installation on <owner>/<repo>`, `creating an installation token for <owner>/<repo>`, `reading the app`, `looking up its bot user <slug>[bot]` | Check the ID, the key and the clock |
| G23 | `GitHub refused <step> for GitHub App <id> (403).[ It needs the permission <perm>: grant it in the app's settings and approve the change on the installation.][ GitHub said: <msg>]` | as G16 | as G16 | One of the steps in G22 answered 403, for example a suspended installation. The permission sentence appears when GitHub names one | Grant the permission, or unsuspend the installation |
| G24 | `GitHub answered <status> while <step> for GitHub App <id>.[ GitHub said: <msg>]` | as G16 | as G16 | Any other non-success status from the steps in G22 | Read `<msg>`; check GitHub status |
| G25 | `Could not reach GitHub while <step> for GitHub App <id>: <err>` | as G16 | as G16 | The request to `api.github.com` failed before an answer (DNS, TLS, network) | Check the network, rerun |
| G26 | `<err> The GitHub App installation lacks a permission this request needs; GitHub accepts <perm>.` or `<err> The GitHub App installation may lack a permission this request needs.` | appended to the message that carries `<err>`, such as G9 | Any action that calls GitHub | A REST or GraphQL request made with an installation token answered 403. `<perm>` is GitHub's `X-Accepted-GitHub-Permissions` header, such as `pull_requests=write` | Grant the permission in the app's settings and approve it on the installation; see [Required app permissions](configuration.md#required-app-permissions) |

## CLI usage

| ID | Exact text | Category | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| U1 | `--plan cannot be combined with <--confirm\|--yes>. --plan only describes the change; <--confirm\|--yes> applies it. Pass one or the other.` | refusal | CLI RC, HF, INC, REL, REV | Contradictory flags. Checked before git is touched | Drop one flag |
| U2 | `--confirm cannot be combined with --yes. --confirm applies the plan you reviewed; --yes applies without review. Pass one or the other.` | refusal | as U1 | Both given | Drop one |
| U3 | `--confirm needs the plan digest printed by --plan (for example --confirm 3f2a1b0c9d8e).` | refusal | as U1 | `--confirm ''` | Pass the digest |
| U4 | `Error: --release-type must be one of major, minor, patch` | refusal | CLI RC | Any other value. Exit code 1 | Fix the flag |
| U5 | `releaseType must be one of: major, minor, patch (defaults to minor if not specified)` | refusal | MCP RC | Any other value. Returned as an MCP error (`isError: true`) | Fix the input |
| U6 | `There is no downmerge from '<source>' to '<target>'. Valid routes: main → develop, release → develop, release → main, hotfix → develop, hotfix → main.` | refusal | MCP DM | `source`/`target` is not one of the five routes | Pick a valid route |
| U7 | commander's `error: unknown option '--plan'` | refusal | CLI DM | `--plan` given to a downmerge; it is rejected rather than ignored, since a downmerge applies immediately | Omit it. `--confirm` and `--yes` are accepted and ignored |

## Plan protocol

| ID | Exact text | Category | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| D1 | `The repository changed since this plan was created. Expected digest <new>, got <offered>. Review the new plan and confirm again.` followed by the new plan | refusal | RC, HF, INC, REL, REV | The digest passed as `confirm` differs from the plan rebuilt now. See [what the digest covers](actions.md#what-the-digest-covers) | Read the new plan; confirm its digest if it is still right |
| D2 | `Nothing has been changed. To apply, confirm with digest: <digest>` | note (plan footer) | RC, HF, INC, REL, REV | Every rendered plan ends with it | Hand the digest back to apply |
| D3 | `Would change nothing.` | note (plan body) | any plan | A plan with no mutations. No current action produces one | — |

## Branch selection

| ID | Exact text | Category | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| S1 | `Ambiguous: Both release/<v> and hotfix/<v> branches exist. Pass the full branch name, release/<v> or hotfix/<v>, as the version.` | refusal | INC, REL | `version` is a bare `X.Y.Z` matching both a release and a hotfix branch | Pass `release/<v>` or `hotfix/<v>` as `version` |
| S2 | `No release/<v> or hotfix/<v> branch found for version <v>`, or for a full branch name `No <release\|hotfix>/<v> branch found` | refusal | INC, REL | `version` matches no branch, locally or on origin | Run `list_versions` |
| S3 | `Checked-out branch '<branch>' is at <v>, which is not a release candidate. Refusing to auto-select a different branch, because that would modify a release train you are not on. Either pass an explicit version, or check out the branch you intend to act on. Use list_versions to see every candidate.` | refusal | INC, REL | No `version`; standing on a release/hotfix branch whose VERSION (read from origin first) is final | Pass `version`, or check out the right branch |
| S4 | as S3 with `has no readable VERSION file` in place of `is at <v>, which is not a release candidate` | refusal | INC, REL | No `version`; the checked-out release/hotfix branch has no readable VERSION | as S3 |
| S5 | `No release candidate branches found. Cannot determine target branch for release.` | refusal | INC, REL | No `version`, not on a release/hotfix branch, and no branch holds an RC | Run `list_versions` |
| S6 | `⚠️  Auto-selected the most recent RC branch: <branch> (<v>). Other candidate: <branch> (<v>). Pass an explicit version to choose deliberately.` | log | INC, REL | Auto-selection found RCs on both a release and a hotfix branch, and took the higher version (a tie goes to the release) | Check the plan's `Branch:` line before confirming |
| S7 | `Failed to select target release branch: <err>` | refusal | INC, REL | An unexpected error while selecting | Read `<err>` |
| S8 | `Ambiguous: both release/<v> and hotfix/<v> exist. Pass the full branch name, release/<v> or hotfix/<v>, as the version, or check out the one you mean.` | refusal | REV | A bare `version` matches both | Pass the full branch name |
| S9 | `No release/<v> or hotfix/<v> branch found.`, or for a full branch name `No <release\|hotfix>/<v> branch found.` | refusal | REV | `version` matches neither | Run `list_versions` |
| S10 | `'<current>' is not a release or hotfix branch, and revert_version will not pick one for you — it deletes tags and can delete a branch. Check out the branch you mean, or pass its version. Use list_versions to see every candidate.` | refusal | REV | No `version` and the checked-out branch is not `release/X.Y.Z` or `hotfix/X.Y.Z` | Pass `version` |
| S11 | `Checked-out branch '<branch>' has no readable VERSION file, so there is no version to revert.` | refusal | REV | No `version`; the checked-out branch has no readable VERSION | — |
| S12 | `<Release\|Hotfix> branch for version <v> not found` (`<v>` as given) | refusal | DM r→d, r→m, h→d, h→m | `version` matches no branch name of the source type, including a full branch name of the other type | Run `list_versions` |
| S13 | `No <release\|hotfix> branches found` | refusal | as S12 | No `version` and no branch of the source type exists | — |

## Plan refusals

| ID | Exact text | Category | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| P1 | `<branch> is at <v>, which is not a release candidate, so <action> cannot be planned for it. Use list_versions to find a branch holding an RC.` | refusal | INC, REL | The selected branch's VERSION is final (reachable with an explicit `version`) | Pick a branch holding an RC |
| P2 | `Tag <tag> already exists on origin, so creating it again would fail. Use list_versions to see where that version stands.` | refusal | RC, HF, INC, REL | `git ls-remote --tags origin refs/tags/<tag>` finds the tag the action would create. A tag that exists only locally is not refused; the apply deletes it first | Find out why that version is already tagged |
| P3 | `<base> has no readable VERSION file at <sha11>, so <action> cannot be planned. Use initialize_versioner to create one.` | refusal | RC (`develop`), HF (`main`) | The base's VERSION is missing, or its first line does not start `X.Y.Z` | Initialize or repair VERSION on the base |
| P4 | `<base> is at <v>, which is still an active release candidate, so <action> cannot be planned. Promote or retire that candidate first — release_version on its branch, then downmerge it into <base> — so <base> holds a final version.` | refusal | RC, HF | The base's VERSION is an RC | Bring a final version into the base |
| P5 | `<base> is at '<v>', which is not a semantic version, so <action> cannot be planned.` | refusal | RC, HF | Defensive: P3 catches the same cases first | — |
| P6 | `Branch <branch> already exists on origin at <v>, not <X.Y.Z-RC.0>, so <action> cannot create it and there is no earlier run to resume. Use list_versions to see where it stands.` (`<v>` is `no readable version` when there is none) | refusal | RC, HF | `release/X.Y.Z` or `hotfix/X.Y.Z` is on origin at a version other than the planned `RC.0`. A branch only the clone has is replaced instead (W14), and one at exactly the planned `RC.0` is resumed (N5) | Use the existing branch: `increment_release_candidate` or `release_version` on it |
| P7 | `origin/main has <n> commit(s) whose content is not in origin/develop, so the synchronization check aborts the action. Downmerge main into develop first.` | refusal | RC | After the plan's fetch, `origin/main` is not an ancestor of `origin/develop`, has commits `origin/develop` lacks, and `git diff origin/develop...origin/main` is non-empty | Run the `main` → `develop` downmerge and merge its pull request |
| P8 | `<source> is already merged into <target>, so there is nothing to downmerge.` | refusal | DM (all routes) | The source head is an ancestor of the target head | Nothing to do |
| P9 | `<branch> has no readable VERSION file at <sha11>, so there is nothing to revert.` | refusal | REV | The head commit has no readable VERSION | — |
| P10 | `The head of <branch> is "<subject>", not "To version <v>". revert_version undoes a version bump and will not guess which earlier commit set the version. Revert by hand, or land the bump you mean to undo at the head of the branch.` | refusal | REV | The head commit's subject is not the bump of the version it holds (for example, a fix was pushed after the bump) | Revert by hand, or only revert immediately after a bump |
| P11 | `<v> is already in main, so it has shipped and cannot be reverted — it can only be superseded by a new version. Cut a new release candidate instead.` | refusal | REV | The head is an ancestor of `origin/main` | Cut a new candidate |
| P12 | `<branch> holds <n> commit(s) that are not in <base>, so abandoning it would destroy work:` then one `  <sha> <subject>` line per commit, then `Merge or cherry-pick them somewhere safe first. <v> is this branch's first version, so there is no earlier version to revert to and the branch cannot simply be rewound.` | refusal | REV (abandon shape) | Non-merge commits on the branch, other than the bump itself, are not in `origin/<base>` | Save those commits, then retry |
| P13 | `Could not compare '<source>' with '<base>': git merge-tree exited <n> — <stderr>. Check that both refs exist and share history.` | refusal | DM (all routes) | `git merge-tree` failed for a reason other than a conflict | Fetch both branches; check they share history |
| P14 | `<branch> is on origin at <X.Y.Z-RC.0> but tag <X.Y.Z-RC.0> is not, and no commit "To version <X.Y.Z-RC.0>" on the branch can be tagged. Tag the commit that set the version by hand, push the tag, and run this again.` | refusal | RC, HF (resume) | A resume would push the missing tag, but the branch has no version commit to put it on | Tag the commit that set `VERSION` by hand |
| P15 | `PR #<n> (<merge-branch> → <target>) is already open from an earlier downmerge of <source>, and <source> has moved on since: <sha11> is not in <merge-branch>. Merge or close PR #<n> first, then run the downmerge again.` | refusal | DM m→d, r→m, h→d | An earlier run's merge-branch pull request is open, and the source has commits that merge branch lacks | Merge or close that pull request, then run the downmerge again |
| P16 | `<branch> is at <v>, behind <base> at <base-v>: a newer version has already reached <base>, so <branch> is stale and increment_release_candidate cannot be planned for it. Promote it with release_version or abandon it, or cut <a new release candidate with create_release_candidate\|a new hotfix with create_hotfix> instead.` | refusal | INC | The branch's major.minor.patch is lower than its base's (`develop` for a release branch, `main` for a hotfix), read from `origin/<base>` first; the RC suffix is ignored. Typically a release branch never promoted after a newer release reached `develop`, or a hotfix cut before a release reached `main` | Promote or abandon the branch, or cut a new release candidate or hotfix |
| P17 | `Could not compare <branch> with <base>'s version (<err>), so increment_release_candidate cannot be planned. Check that origin/<base> has a readable VERSION file.` (`<err>` is the text of A14 or A15) | refusal | INC | The base's `VERSION` is missing or does not start `X.Y.Z` on `origin/<base>` and on the local `<base>`, or reading it failed | Restore `VERSION` on the base |

## Plan warnings

All are covered by the digest. None blocks the apply.

| ID | Exact text | Actions | Condition | What to do |
| --- | --- | --- | --- | --- |
| W1 | `<hotfix/a, hotfix/b> reached main but not <target>, so <target> is missing <a fix\|fixes> already in production.` then, for `develop`: `Downmerge <it\|them> into develop first.`; for a release branch: `No downmerge route targets a release branch: open a pull request from <hotfix/a\|each of them> into <target> by hand and merge it, then cut a new release candidate with increment_release_candidate, so the fix is tested before <target> ships.` | RC (`<target>` = `develop`); INC, REL (`<target>` = the `release/*` branch; not for hotfix branches) | A `hotfix/*` branch head is in `main` but not in `<target>` | As the message says: the `hotfix` → `develop` downmerge for `develop`; for a release branch, the pull request by hand and a new candidate ([manual-downmerge.md](manual-downmerge.md#into-main-a-decision-not-a-resolution)) |
| W2 | `Could not check for hotfixes missing from <target>: <err>` | as W1 | The W1 check failed | Check by hand with `list_versions` and `git merge-base --is-ancestor` |
| W3 | `main holds <n> commit(s) that <branch> does not, touching <k> file(s)<: file, file>. The artifact tagged from <branch> will not contain them, so main after the release merge will not match what was deployed, and the next branch cut from main inherits the difference. Merge main into <branch> and cut a new release candidate before promoting, so the two agree.` | REL | `origin/main` has non-merge commits the branch lacks | Usually: merge `main` into the branch, `increment_release_candidate`, then promote |
| W4 | `Merging <branch> into main conflicts in <n> file(s): <files>. The downmerge into main will create nothing and stop for a human decision until this is resolved.` | REL | `git merge-tree` of the branch into `origin/main` conflicts | As W3, before promoting |
| W5 | `Could not check whether <branch> merges cleanly into main: <err>` | REL; INC (hotfix branches) | The W4 or W15 preview failed, or a head for W15 did not resolve | Check by hand |
| W6 | `Could not resolve <branch> or main, so the merge into main was not checked: <err>` | REL | A head for W3/W4 did not resolve | Fetch, then plan again |
| W7 | `.release-management.json on <ref> at <sha11> is not valid (<reason>), so no pre-version checks ran.` | RC, HF, INC, REL | The configuration at the commit being versioned does not parse; `<reason>` is one of [C1–C10](#configuration-reasons) | Fix the file on that branch |
| W8 | `Pre-version check "<name>" failed on <ref> at <sha11> (exit <code>). Its output is at the end of the plan.` | RC, HF, INC, REL | A configured check exited non-zero. The tail of its output follows the plan as `Output of <name>:` (not in the digest) | Read the output; fix, or approve knowingly |
| W9 | `Pre-version check "<name>" did not finish within <s>s on <ref> at <sha11>.` | RC, HF, INC, REL | A check ran past its `timeoutSeconds` | Raise the timeout or fix the check |
| W10 | `Could not run the pre-version checks on <ref> at <sha11>: <err>` | RC, HF, INC, REL | The temporary checkout could not be made, or a check could not start | Read `<err>` |
| W11 | `.release-management.json on <ref> at <sha11> is not valid (<reason>), so the pipeline trigger cannot run. If <branch> has no open pull request after the push, start its build by hand.` | RC, HF, INC, REL, REV (revert shape) | The `pipeline` section, or the file, does not parse | Fix the file |
| W12 | `<v> is a FINAL version, not a release candidate.` | REV | The version being reverted is final: its GitHub release will be deleted | Approve only if the promotion was a mistake |
| W13 | `<v> is the first version on <branch>, so there is no earlier version to return to. The branch is abandoned rather than rewound.` | REV (abandon shape) | The bump's parent carries another release's version, or none | Approve only if the branch should be deleted |
| W14 | `Local <branch> has <n> commit(s) that origin/<branch> does not: <sha11> <subject>; …. ` then, by what the apply does with the branch: `Origin is the source of truth, so the apply resets <branch> to origin/<branch> and drops them from it.` (INC, REL, REV revert shape) or `The apply deletes <branch> locally as well as on origin, so they are dropped with it.` (REV abandon shape); then `To keep them, run git branch unpushed/<branch> <sha11> before confirming.` | INC, REL, REV | The local branch holds commits its remote-tracking ref does not, typically an earlier run's version commit whose push failed | Confirm to drop them, or keep them first with the command given |
| W15 | `Merging <branch> into main conflicts in <n> file(s): <files>. The apply still opens or updates the <branch> → main pull request, which cannot merge until this is resolved. main mirrors production, so how to resolve it is a human decision: see docs/manual-downmerge.md.` | INC (hotfix branches) | `git merge-tree` of the hotfix branch head into `origin/main` conflicts. Checked whatever the configuration | Decide as for H2 ([manual-downmerge.md](manual-downmerge.md#into-main-a-decision-not-a-resolution)) before or after approving; the pull request opens either way |

### Configuration reasons

`<reason>` in W7, W11, T4 and T6 is one of these, or the JSON parser's own message.

| ID | Text | Applies to |
| --- | --- | --- |
| C1 | `the top level must be an object` | the file |
| C2 | `"checks" must be an array` | checks |
| C3 | `checks[<i>] must be an object` | checks |
| C4 | `checks[<i>].name must be a non-empty string` | checks |
| C5 | `checks[<i>].run must be a non-empty string` | checks |
| C6 | `checks[<i>].on must list actions from: create_release_candidate, increment_release_candidate, release_version, create_hotfix` | checks |
| C7 | `checks[<i>].timeoutSeconds must be a positive number` | checks |
| C8 | `"pipeline" must be an object` | pipeline |
| C9 | `pipeline.trigger must be a non-empty string` | pipeline |
| C10 | `pipeline.timeoutSeconds must be a positive number` | pipeline |

A file that is not valid JSON, or whose top level is not an object, produces both W7 and
W11 in a versioning plan.

## Plan notes

| ID | Exact text | Actions | Condition |
| --- | --- | --- | --- |
| N1 | `PR #<n> is already open for <branch> → <base>; it will be updated, not created.` | RC, HF (both pairs), INC, REL (both pairs), DM r→d, h→m | An open pull request already exists for that head/base pair |
| N2 | `The <hotfix/X.Y.Z> → develop pull request opens as a draft holding only a version bump, and conflicts on VERSION until the fix lands and it is reconciled. It is a reminder, not a merge that is ready to take.` | HF | No open `hotfix/X.Y.Z` → `develop` pull request yet |
| N3 | `No tag <v> exists locally or on origin; nothing to delete.` | REV | The tag is already gone everywhere |
| N4 | `Deleting a tag does not undo a build or deployment it already triggered. Pushing to <branch> may itself trigger a new one.` | REV | Always |
| N5 | `<branch> is already on origin at <X.Y.Z-RC.0> (<sha11>), so an earlier run got as far as the push. This resumes it: the branch and the version commit are not made again.` | RC, HF | Origin holds the branch the action would create, at exactly the version it would set. The plan lists only the missing steps |
| N6 | `No <hotfix/X.Y.Z> → develop pull request is open, so one opens as a draft placeholder: it conflicts on VERSION by construction, and the hotfix → develop downmerge supersedes it after the deploy.` | REL (hotfix) | Promoting a hotfix with no open `develop` pull request |
| N7 | `PR #<n> (<merge-branch> → <target>) is already open from an earlier downmerge and holds <source> at <sha11>, so nothing new is created. Review and merge that one, or close it to reject the downmerge.` | DM m→d, r→m, h→d | An open pull request into the target heads on an earlier merge branch of the same route, which already contains the source head |
| N8 | `<branch> conflicts with develop in <n> file(s): <files>. No <branch> → develop pull request is open, so the apply will not open the one listed above: it returns a "Manual downmerge needed" handoff to resolve the conflicts on a merge branch instead, and the pipeline trigger starts the build. Checked again after the push.` | INC (release branches) | `.release-management.json` at the branch head has a valid `pipeline.trigger`, `git merge-tree` of the branch head into `origin/develop` conflicts, and no `<branch>` → `develop` pull request is open |
| N9 | `<branch> conflicts with develop in <n> file(s): <files>. PR #<n> stays open and is updated, and the apply also returns a "Manual downmerge needed" handoff to resolve the conflicts on a merge branch. Checked again after the push.` | INC (release branches) | As N8, with that pull request open |
| N10 | `Could not check whether <branch> merges cleanly into develop (<err>). The apply checks again after the push.` | INC (release branches) | As N8, but the preview failed or a head did not resolve |

N8–N10 are listed under "Notes:" but are not covered by the digest: they are the plan's
`mergePreview` field, not its `notices`. The apply previews the pushed commit again and acts
on that ([actions.md](actions.md#conflicts-into-develop)).


Otherwise the merge-branch downmerges (m→d, r→m, h→d) produce no notes and no warnings. A
downmerge prints its notes with the result, because it applies straight away.

## Downmerge handoffs

A conflicting downmerge returns one of these instead of a result, and creates nothing. An
increment of a release branch can return H1 alongside its result, after pushing the
version. The procedure behind them is [manual-downmerge.md](manual-downmerge.md).

| ID | First line | Actions | Condition |
| --- | --- | --- | --- |
| H1 | `Manual downmerge needed: <source> → develop` | DM m→d, r→d, h→d; INC (release branches, `<source>` = `release/X.Y.Z`) | `git merge-tree` of the source into `develop` reports conflicts, in the plan or again during the apply. For INC: on the pushed head, with a valid `pipeline.trigger` configured ([actions.md](actions.md#conflicts-into-develop)) |
| H2 | `Decision needed: <source> → main conflicts` | DM r→m, h→m | The same, into `main` |

The rest of the handoff, exactly:

```text
The merge conflicts, so nothing was created. Conflicted files:
  - <file>
  ...

Steps:                                   # H1
  1. Cut <resolution-branch> off origin/develop and merge origin/<source> into it.
  2. Resolve the conflicts in <files>. Keep develop's VERSION.
  3. Push <resolution-branch> and open a pull request into develop titled "<title>", listing each resolved file with a one-line reason.
  4. Close the draft <source> → develop pull request, if one is open, with a comment linking the new one.   # hotfix source only

The full procedure is docs/manual-downmerge.md in the versioner repository (https://github.com/officespacesoftware/versioner/blob/master/docs/manual-downmerge.md).
```

From an increment, the second line reads instead, with no pull request open:

```text
<v> is pushed and tagged, but <source> conflicts with develop, so no pull request into develop was opened. Conflicted files:
```

or, with one open:

```text
<v> is pushed and tagged, and PR #<n> (<source> → develop) stays open, but it cannot merge: <source> conflicts with develop. Conflicted files:
```

Everything else, steps included, is the `release` → `develop` downmerge's.

`<resolution-branch>` is `main-into-develop-<unix-timestamp>`,
`release-X.Y.Z-into-develop-<unix-timestamp>` or `hotfix-X.Y.Z-into-develop-<unix-timestamp>`.
`<title>` is the title the clean downmerge would have used: `Release <v> to develop` or
`Downmerge main into develop` for `main`, `Release X.Y.Z to develop`, `Hotfix X.Y.Z to develop`.

For H2, the line after the file list is:

```text
main mirrors production and holds changes <source> never received. Do not resolve this or merge main into <source>: that would deploy it to the release servers without a new release candidate. A human chooses one option:
  1. Option 1, take main's changes into a new candidate (usually right): <take-main>
  2. Option 2, leave them out of <source>: cut <source-slug>-into-main-<unix-timestamp> off origin/main, merge origin/<source> into it, resolve <files>, and open a pull request into main titled "Release X.Y.Z to main". Say in it that main will then differ from what production runs.
```

`<take-main>` for a release: `Run create_release_candidate with releaseType patch, merge
origin/main into the new release branch, promote it with release_version, have Ops deploy
it to every production host, then downmerge that release into main, which is clean by
then.` For a hotfix: `Run create_hotfix, which cuts a new hotfix off main and so already
holds main's changes, bring the fix from <source> over, promote it with release_version,
have Ops deploy it to every production host, then downmerge that hotfix into main, which
is clean by then.`

The error object behind a handoff (`ManualDownmergeRequired`) carries this one-line message,
which the MCP server and the CLI replace with the rendering above:
`<source> conflicts with <target> in <n> file(s): <files>. Nothing was created; follow docs/manual-downmerge.md to downmerge by hand.`
(into `develop`) or `...; a human has to choose how to proceed, see docs/manual-downmerge.md.`
(into `main`). The MCP server prefixes the rendering with `⚠️  `; the CLI prints it to
stderr and exits `1`. An increment throws nothing: its result carries the handoff as
`manualDownmerge`, the MCP server prints it after the pull request lines with the same
`⚠️  ` prefix, and the CLI prints it with the result, writes it to `$GITHUB_OUTPUT` as
`manual_downmerge`, and exits `0`.

## Pipeline trigger

See [configuration.md](configuration.md#pipeline-trigger) for when the trigger runs.

| ID | Exact text | Status | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| T1 | `Would start the pipeline for <branch>: it has no open pull request. Checked again after the push.` | plan line under `Pipeline:`; not in the digest | REV (revert shape); INC (release branches) with N8 | A `pipeline` section is configured, the action will not itself open or update a pull request on the branch, and the branch heads none | Nothing; informational |
| T2 | `Started the pipeline for <branch>: it has no open pull request.` | `started` | RC, HF, INC, REL, REV (revert shape) | The trigger ran and exited 0 | Nothing |
| T3 | `Did not start the pipeline for <branch>: PR #<n> is open, so its own build runs on the push.` | `skipped` | as T2 | The branch heads an open pull request, against any base | Nothing |
| T4 | `Could not read .release-management.json at <sha11> (<err>), so the pipeline trigger did not run. If <branch> has no open pull request, start its build by hand.` | `failed` | as T2 | Reading the file at the pushed commit failed | Start the build by hand if needed |
| T5 | `Could not check whether <branch> has an open pull request (<err>), so the pipeline was not started. If no build started, start it by hand.` | `failed` | as T2 | The pull-request lookup failed | as T4 |
| T6 | `.release-management.json at <sha11> is not valid (<reason>), so the pipeline for <branch> was not started, and it has no open pull request. Start the build for <branch> by hand.` | `failed` | as T2 | The configuration is invalid and no pull request is open. With a pull request open, an invalid section reports nothing | Fix the file; start the build by hand |
| T7 | `The pipeline trigger for <branch> did not finish within <s>s. Check whether a build started, and start it by hand if not.` | `failed` | as T2 | The command ran past `pipeline.timeoutSeconds` | Check your CI |
| T8 | `The pipeline trigger for <branch> failed (exit <code>), and <branch> has no open pull request. Start the build for <branch> by hand.` | `failed` | as T2 | The command exited non-zero | Start the build by hand |
| T9 | `Could not run the pipeline trigger for <branch>: <err>. Start the build for <branch> by hand.` | `failed` | as T2 | The temporary checkout could not be made, or the command could not start | as T8 |
| T10 | `Could not resolve the pushed head of <branch> (<err>), so the pipeline trigger did not run. If <branch> has no open pull request, start its build by hand.` | `failed` | as T2 | The branch head could not be resolved after the push | as T8 |

The MCP server shows a result as `🔧 Pipeline: <message>` (or `⚠️  Pipeline: <message>` for
`failed`), the CLI as `Pipeline: <message>` (or `Pipeline warning: <message>`), each
followed by `Output of the pipeline trigger:` and the tail of what the command printed,
when it printed anything. The CLI writes the status to `$GITHUB_OUTPUT` as
`pipeline_trigger`.

## Apply failures

Thrown after the apply has started. The action's section in [actions.md](actions.md) says
what each step leaves behind.

### `create_release_candidate` and `create_hotfix`

Each message is prefixed `Step <n> failed: `.

| ID | Exact text after the prefix | Step | Actions | Condition |
| --- | --- | --- | --- | --- |
| A1 | `Branch synchronization check failed: Main has <n> commits with actual content differences not in develop. Main must be merged into develop before creating release.` | 2 | RC | `origin/main` holds content `origin/develop` lacks. In practice unreachable: the rebuilt plan refuses first (P7) |
| A2 | `Branch synchronization check failed: Failed to verify branch synchronization: <err>` | 2 | RC | The comparison failed |
| A3 | `<develop\|main> has no readable VERSION file` | 1 | RC, HF | `origin/<base>` has no readable VERSION (the plan refuses this first, P3) |
| A4 | `Failed to create branch '<branch>' from refs/remotes/origin/<base>: <err>` | 3 (RC), 2 (HF) | RC, HF | `git checkout -B` failed, for example over an uncommitted change it would overwrite |
| A5 | Retired: the hotfix apply no longer fetches or runs a bare `git checkout -b` | — | — | — |
| A6 | `Failed to create <major\|minor\|patch> release candidate: <err>` | 4 (RC), 3 (HF) | RC, HF | The versioner refused or failed: commit or tag creation, including `Tag '<v>' already exists.` |
| A7 | `Failed to push branch '<branch>' and tag '<tag>': <err>` | 5 (RC), 4 (HF) | RC, HF | Either push was rejected |
| A8 | `Failed to create pull request: <err>` | — | RC, HF, and every pull-request step below | GitHub refused the pull request, other than "already exists". No longer thrown by RC or HF: reported as R1 |
| A9 | `No open PR found for head '<branch>' into '<base>'` | — | as A8 | GitHub said a pull request exists, but none could be found to update. Reported as R1 by RC and HF |
| A10 | `Failed to edit PR #<n>: <err>` | — | as A8 | Updating the existing pull request failed. Reported as R1 by RC and HF |
| A36 | `No commit "To version <X.Y.Z-RC.0>" on origin/<branch> to tag` | 5 (RC), 4 (HF) | RC, HF (resume) | The tag is missing on origin and the version commit cannot be found. In practice unreachable: the rebuilt plan refuses first (P14) |

### `increment_release_candidate` and `release_version`

No step prefix.

| ID | Exact text | Actions | Condition |
| --- | --- | --- | --- |
| A11 | `Failed to check out branch '<branch>': <err>` or `Failed to reset '<branch>' to origin/<branch>: <err>` | INC, REL | Checking out the target failed, or resetting it to origin would overwrite an uncommitted change (`git reset --keep`) |
| A12 | `Branch <branch> version <v> is not a release candidate. Only RC versions can be incremented.` | INC | The branch's VERSION is final: the working tree's after the checkout, or on a `dryRun`, the branch's as the plan reads it (see [dryRun](actions.md#dryrun)) |
| A13 | `<branch> version <v> is behind <base> version <base-v>. Cannot proceed with increment.` | INC | The branch's major.minor.patch is lower than its base's, read from `origin/<base>` first. In practice unreachable through the MCP tool and the CLI: the rebuilt plan refuses first (P16). Reached by calling `executeIncrementRCWorkflow` without a plan |
| A14 | `Could not read version from <base> branch VERSION file` | INC | As A13, base VERSION unreadable. The rebuilt plan refuses first (P17) |
| A15 | `Failed to validate branch version: <err>` | INC | As A13, unexpected error. The rebuilt plan refuses first (P17) |
| A16 | `Failed to increment release candidate: <err>` | INC | The versioner failed, including `Tag '<v>' already exists.` |
| A17 | `Target version not available for push operation` | INC | Internal: no version after step 5 |
| A18 | `Failed to push branch '<branch>' and tag '<tag>': <err>` | INC | Either push rejected |
| A19 | `Branch version <v> is not a release candidate. Only RC versions can be released.` | REL | As A12 |
| A20 | `Failed to release version: <err>` | REL | The versioner failed |
| A21 | `Git command failed: <err>` | REL | `git push origin <branch>` (step 5) or `git push origin <tag>` (step 6) rejected |
| A22 | `Target version not available for tag operation` / `Target version not available in context` | REL | Internal |
| A23 | `Failed to create GitHub release: <err>` | REL | GitHub refused the release (step 9). Fatal, though the tag is already on origin |

### `revert_version`

| ID | Exact text | Condition |
| --- | --- | --- |
| A24 | `Reverting <sha11> conflicts with the current state of the branch, so it was aborted and nothing was changed. Resolve by hand.` then git's output | `git revert` conflicted; it is aborted |
| A25 | `Failed to delete GitHub release <id>: <err>` | Deleting the release failed (after the tag was deleted) |
| A26 | `Failed to push branch '<branch>': <err>` | Pushing the revert commit failed (after the tag was deleted) |
| A37 | `Origin refused to delete tag <v>, so it is still on origin. ` then, abandon: `Nothing else was changed: <branch> and its pull request are untouched. ` or, revert: `The revert commit was made locally but not pushed, and nothing else was changed; the next revert_version plan drops the local commit (W14). ` then `Find out what protects the tag (a tag protection rule or a pre-receive hook), delete it by hand with git push origin :refs/tags/<v> once that allows it, then run revert_version again.` and a line `Origin refused to delete refs/tags/<v>: <git's output>` | `git push origin :refs/tags/<v>` left the tag on origin, as `git ls-remote` confirms |
| A38 | `Origin refused to delete <branch>, so it is still on origin, and the local branch was kept. Already done: tag <v> was deleted and its pull request was closed. Find out what protects the branch (branch protection or a pre-receive hook), then delete it by hand with git push origin --delete <branch>, or run revert_version again once that allows it.` and a line `Origin refused to delete refs/heads/<branch>: <git's output>`. The `Already done` sentence lists only what happened | Abandon: the branch is still on origin after its deletion was pushed |
| A39 | `Could not delete the local branch <branch>: <git's output>` | Abandon: the branch is gone from origin but `git branch -D` left it locally |
| A27 | `Failed to check out branch '<branch>': <err>` or `Failed to reset '<branch>' to origin/<branch>: <err>` (revert); `Failed to check out branch '<base>': <err>` (abandon) | Checking out the branch and resetting it to origin (revert), or checking out its base (abandon; nothing is pulled), failed |

### `downmerge`

Each is wrapped as `Failed to downmerge <main to develop\|release to develop\|release to main\|hotfix to develop\|hotfix to main>: <err>`.

| ID | Exact `<err>` | Routes | Condition |
| --- | --- | --- | --- |
| A28 | `Error: <source> is already merged into <base>, so the merge produced no commit. Nothing was pushed and no pull request was opened.` | m→d, r→m, h→d | The source landed in the base between the plan and the merge |
| A29 | `Error: Refusing to probe for merge conflicts with tracked changes in the working tree, because cleanup would discard them: <files>. Commit or stash first.` | r→d | Tracked files are modified (staged ones are refused earlier by G2) |
| A30 | `Error: Merge probe of '<source>' into 'develop' failed without producing conflicts, so this is not a conflict condition. Inspect the repository state before retrying.` | r→d | The trial merge failed for another reason |
| A31 | `Error: Failed to checkout and pull branch '<branch>': <err>`, `Error: Git command failed: <err>`, `Error: Failed to create pull request: <err>` | all | A checkout, pull, push or pull-request call failed |

### `initialize_versioner`

A32–A35 are checked before anything is written, so they are refusals in effect: nothing is
created. A failure while writing is the versioner's own message, prefixed `Failed to
initialize versioner project: Error: ` and followed by `Everything it created was removed,
so it can be run again.` The MCP server shows each under `❌ Failed to initialize
versioner` without marking the call as an error.

| ID | Exact text | Condition |
| --- | --- | --- |
| A32 | `Cannot initialize the project with a version file: The file VERSION already exists.` | A VERSION file is present (tracked or not) |
| A33 | `The usage of this tool requires an existing git project with at least one revision.` | The repository has no commits |
| A34 | `Invalid version format: <v>. Expected format: X.Y.Z or X.Y.Z-RC.N. Nothing was written.` | `version` is not `X.Y.Z` or `X.Y.Z-RC.N` |
| A35 | `Tag '<v>' already exists. Nothing was written.` | A local tag of that version exists |
| A40 | `<the failure> Removing what it created also failed (<err>): check for a VERSION file, a "To version <v>" commit and a tag <v>, and remove them by hand.` | Writing failed, and so did removing what it had created |

## Apply reports

Problems an apply reports alongside a successful result.

| ID | Exact text | Where it appears | Actions | Condition | What to do |
| --- | --- | --- | --- | --- | --- |
| R1 | the pull-request error (A8–A10 text, or G7–G9) | MCP `⚠️  PR step failed: <err>`; CLI `PR step failed: <err>`; `pull_request_error`. For RC and HF followed by `To recover, call <tool> again with the same inputs: it resumes from the push and opens the pull request. Or open <branch> → <base> by hand, titled "RC <v> to <base>".` (CLI: `To recover, run <command> again …`) | RC (step 6), HF (step 5), INC, REL (step 7) | The pull request to the base could not be opened or updated | RC, HF: run the action again, which resumes. INC, REL: open or edit it by hand |
| R2 | `GitHub returned empty release notes for <v> on <branch> (attempt <i>/3).` | MCP `⚠️  Release notes: …`; CLI `Release notes warning: …`; `release_notes_warning` | REL | Every notes request returned an empty body | Generate the notes on the release page |
| R3 | `generateReleaseNotes failed (attempt <i>/3): <err>` | as R2 | REL | The last notes request failed | as R2 |
| R4 | `GitHub returned empty release notes — generate them manually from the release page.` | as R2 | REL | No body and no recorded error | as R2 |
| R5 | `Failed to patch release notes after creation: <err>` | as R2 | REL | Notes appeared on the retry but the release could not be updated | as R2 |
| R6 | the pull-request error | MCP `⚠️  develop PR refresh failed: <err>`; CLI `develop PR refresh failed: <err>`; `own_base_pull_request_error` | REL (step 10) | The `develop` pull request could not be opened or updated. The label is the result's `ownBaseBranch`, which is `develop` for a release and a hotfix alike | Open or edit it by hand |
| R7 | the pull-request error | MCP `⚠️  Could not open the develop PR: <err>`; CLI `Could not open the develop PR: <err>` then `  Open it by hand as a draft, or rely on the hotfix-to-develop downmerge after the deploy.`; `tracking_pull_request_error` | HF (step 6) | The draft `develop` pull request could not be opened | Open it by hand, or rely on the `hotfix` → `develop` downmerge later |
| R8 | the pull-request error | MCP `⚠️  Pull request step failed: <err>`; CLI `PR step failed: <err>`; `pull_request_error` | REV | Updating (revert) or closing (abandon) the pull request failed | Edit or close it by hand |
| R9 | the GitHub error | MCP `⚠️  Could not close the superseded PR #<n> (<head> → <base>): <err>. Close it by hand.`; CLI `Could not close the superseded PR #<n> (<head> → <base>): <err>. Close it by hand.`; `superseded.error`, `superseded_pull_request_error` | DM h→d (`hotfix/X.Y.Z` → `develop`), r→m (`release/X.Y.Z` → `main`) | Closing, or looking up, the pull request the merge branch's pull request supersedes failed. The downmerge itself succeeded | Close it by hand |
| R10 | the GitHub error | MCP `⚠️  Could not close the promotion's PR into main: <err>. Close it by hand.`; CLI the same without the icon; `promotion_pull_request_error` | REV (revert of a release branch's final, step 7) | Closing the `release/X.Y.Z` → `main` pull request the promotion opened failed. The revert itself is done | Close it by hand |

## Log-only lines worth knowing

| Text | Actions | Meaning |
| --- | --- | --- |
| `🧹 Deleted stale local tag <tag>, which origin does not have` | RC, HF, INC, REL | Before tagging, a local tag of the same name that origin lacks was deleted (for example, left over from a reverted version) |
| `⚠️  HOTFIX WARNING: This PR must be merged ONLY AFTER the hotfix has been deployed to production!` | REL (hotfix) | Step 8; the same warning is in the pull request body |
| `ℹ️  No open PR for <branch>; nothing to update` / `ℹ️  No open PR for <branch>` | REV | No pull request to update or close |
| `⚠️  <branch> conflicts with develop; not opening a pull request into develop. Manual downmerge needed.` | INC (release branches) | Step 7 found a conflict and no open pull request; the handoff is in the result |
| `⚠️  Could not check whether <branch> merges cleanly into develop (<err>), so the pull request is opened or updated as usual.` | INC (release branches) | Step 7's preview failed, or the pushed head did not resolve; the increment behaves as without a trigger |
| S6 | INC, REL | See [Branch selection](#branch-selection) |

## Text written to GitHub

Not messages to the operator, but fixed text the actions put on GitHub.

| Text | Where | Actions |
| --- | --- | --- |
| `> [!WARNING]` / `> This PR must be merged **after** the <release\|hotfix> has been deployed to production.` | Body of every generated pull request into `main`, a reverted hotfix's included | HF, INC (hotfix), REL, REV (hotfix), DM r→m, h→m |
| ``Closed by `revert_version`: <v> was reverted on `<branch>`, which is back at `<resulting>`, so this promotion's pull request no longer applies. `release_version` opens a new one when the branch is promoted again.`` | Comment on the closed `release/X.Y.Z` → `main` pull request | REV (revert of a release branch's final) |
| `🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/master/js/packages/release-management-mcp)` | Last line of every generated pull request body | all that open pull requests |
| `<!-- RELEASE-MANAGEMENT-MCP:START -->` … `<!-- RELEASE-MANAGEMENT-MCP:END -->` | Wraps the generated body. An update replaces only the text between them, or appends a new block when they are missing | all that open pull requests |
| `Closed by `` `revert_version` ``: <v> was reverted, and it was the first version on `` `<branch>` ``, so the branch was abandoned rather than rewound.` + tag deleted + `The branch held no commits that were not already in `` `<base>` ``.` + `The branch tip was `` `<sha>` ``, so this is recoverable with `` `git branch <branch> <sha11>` `` until it is garbage collected.` | Comment on the closed pull request | REV (abandon) |
| `Superseded by <url>. It brings this <hotfix\|release> into <develop\|main> through a merge branch, so <develop\|main> has one open pull request for the <hotfix\|release> rather than two.` | Comment on the closed `hotfix/X.Y.Z` → `develop` draft, or `release/X.Y.Z` → `main` pull request | DM h→d, r→m |

## CLI exit codes

| Code | Meaning | Raised for |
| --- | --- | --- |
| 0 | success | — |
| 1 | user error | S1–S5, S8–S11, P1–P12, P16 and P17 (branch-selection refusals), U1–U4, D1, H1 and H2 from a downmerge (an increment that returns H1 exits `0`), A24, and any message containing `not a git repository`, `staged changes detected`, `not found`, `no release branches`, `no hotfix branches`, `is already merged into`, `refusing to`, `versioner mcp is not available` |
| 2 | environment error | everything else, including every apply failure not matched above, and `Fatal: <err>` from argument parsing |
| 3 | reserved for partial success | never returned |
