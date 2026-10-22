# Manual downmerge

The `downmerge` tool and the CLI's `downmerge` commands only push merges that apply
cleanly. When the merge conflicts they create nothing and return a handoff: the
conflicted files, the branch to resolve them on, the pull request title, and numbered
steps. This document is the procedure behind those steps. It is written for an agent
carrying out the handoff, and works the same for a person.

Follow the handoff's names exactly. They match the ones the tools use for a clean merge,
so a reviewer sees the same branch and title either way.

## Rules for every route

- Never push to `main`, `develop`, `release/*` or `hotfix/*` directly. Every change lands
  through a pull request from a branch you create.
- Never force-push.
- Start from the remote state: `git fetch origin` first, and cut branches from
  `origin/<branch>`, not from a local branch that may be stale.
- Resolve only the files the handoff lists. If the merge reports conflicts in other files,
  the repository moved since the handoff: stop and run the downmerge again for a fresh one.
- Keep the merge commit: use `git merge --no-ff`, resolve, then `git commit` with git's
  default merge message. Do not squash or rebase.
- In the pull request body, list every resolved file with a one-line reason for the
  resolution, so the reviewer can check each decision.
- When a conflict needs a product decision rather than a mechanical one, such as two
  incompatible changes to the same behaviour, resolve nothing. Open the pull request as a
  draft with the markers committed, and say which hunks need a human.

## Into `develop`

Routes: `main` → `develop`, `release` → `develop`, `hotfix` → `develop`.

```sh
git fetch origin
git switch -c <resolution-branch> origin/develop
git merge --no-ff origin/<source-branch>
# resolve the listed files
git add <files>
git commit --no-edit
git push -u origin <resolution-branch>
```

Then open a pull request from `<resolution-branch>` into `develop` with the handoff's
title. `<resolution-branch>` comes from the handoff with `<unix-timestamp>` replaced by
`date +%s`.

**`VERSION`.** Keep develop's side: `git checkout --ours VERSION`. `develop` and the
source are on different version lines, so this conflict is expected after every hotfix
and never means the merge is wrong.

**Hotfix source.** `create_hotfix` opened a draft `hotfix/X.Y.Z` → `develop` pull
request as a reminder. Close it with a comment linking the new pull request, so `develop`
has one open pull request for the hotfix.

**Release source.** The `release/X.Y.Z` → `develop` pull request that `release_version`
opened stays open. GitHub marks it merged once your pull request lands, because its head
is then contained in `develop`.

## Into `main`

Routes: `release` → `main`, `hotfix` → `main`.

`main` has to end up holding exactly what was deployed, so do not resolve on a branch cut
off `main`. Bring `main` into the source branch instead, then run the downmerge again.

```sh
git fetch origin
git switch -c <resolution-branch> origin/<source-branch>
git merge --no-ff origin/main
# resolve the listed files, keeping the source branch's VERSION
git add <files>
git commit --no-edit
git push -u origin <resolution-branch>
```

Open a pull request from `<resolution-branch>` into the source branch, titled
`Merge main into <source-branch>`. Say in its body that the source branch changes after
it was tagged, so a human decides whether a new release candidate is needed before it
reaches production. Once it merges, run the downmerge into `main` again. It is clean now,
and opens the pull request the handoff named.

## Reporting back

Post the pull request link and the list of resolved files with their reasons. If you
stopped instead of resolving, say which files and why.
