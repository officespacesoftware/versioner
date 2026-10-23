# Manual downmerge

The `downmerge` tool and the CLI's `downmerge` commands only push merges that apply
cleanly. When the merge conflicts they create nothing and return a handoff: the
conflicted files, the branch to resolve them on, the pull request title, and numbered
steps. This document is the procedure behind those steps. Into `develop` the handoff is
work to carry out; into `main` it is a decision for a human. It is written for an agent
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

## Into `main`: a decision, not a resolution

Routes: `release` → `main`, `hotfix` → `main`.

`main` mirrors production. If the source conflicts with it, `main` holds changes the
source never received, almost always a hotfix that shipped while the release was being
prepared and was never downmerged into it. Do not resolve this, and do not merge `main`
into the source branch: any change to a release branch goes out as a new release
candidate, and a merge would deploy to the release servers without one.

The handoff starts with "Decision needed". Post it and stop. A human picks one option:

1. **Take `main`'s changes into a new candidate.** Usually the right answer.
   - For a release: `create_release_candidate` with `releaseType: patch`, merge
     `origin/main` into the new release branch, promote it with `release_version`, have
     Ops deploy it to every production host, then downmerge that release into `main`.
   - For a hotfix: `create_hotfix` cuts a new hotfix off `main`, which already holds
     `main`'s changes. Bring the fix over, promote, deploy, then downmerge.
   - The downmerge into `main` is clean by then, and `main` matches production again.
2. **Leave them out of the source.** For when the source fixed the same problem a
   different way. Cut the handoff's branch off `origin/main`, merge the source into it,
   resolve the listed files, and open a pull request into `main` with the handoff's
   title. Say in the pull request that `main` will then differ from what production
   runs. This is drift, and only a human accepts it.

The way to never reach this point is to downmerge every hotfix into the release in
flight. `create_release_candidate`, `increment_release_candidate` and `release_version`
warn when a hotfix that is already in `main` is missing from the branch they act on.

## Reporting back

Post the pull request link and the list of resolved files with their reasons. If you
stopped instead of resolving, say which files and why.
