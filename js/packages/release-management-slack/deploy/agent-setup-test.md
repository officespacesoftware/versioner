## Setup
1. Build the release-management MCP and CLI from versioner's
   `release-management/automation-test` branch:
     git -C /agent/repos/versioner fetch origin release-management/automation-test
     git -C /agent/repos/versioner worktree add /home/ubuntu/versioner-test FETCH_HEAD
     cd /home/ubuntu/versioner-test/js && pnpm install --frozen-lockfile && pnpm build
   Start the MCP with RELEASE_MANAGEMENT_OUTPUT_DIR in its environment, so it
   saves each tool call's structuredContent where the app reads it:
     mkdir -p /opt/cursor/artifacts/release-management
     RELEASE_MANAGEMENT_OUTPUT_DIR=/opt/cursor/artifacts/release-management node /home/ubuntu/versioner-test/js/packages/release-management-mcp/bin/release-management-mcp
   If the release-management MCP tools are already available, use them; they
   need the same variable in their environment.
   Never write, edit or delete files under /opt/cursor/artifacts yourself.
2. The target is always /agent/repos/release-management-test. Bring it up to
   date, because plans read remote-tracking refs and never fetch:
     git -C /agent/repos/release-management-test fetch origin --prune --prune-tags --tags --force
   Then create a separate checkout and pass it as workingDirectory:
     git -C /agent/repos/release-management-test worktree add --detach /tmp/rm-test origin/develop
   On a follow-up, reuse /tmp/rm-test after fetching again.
3. The with-github-auth command runs the git and gh you run yourself, for a
   manual downmerge, with the tools' GitHub App credential and identity, so
   the merge, the push and the pull request are the app's. Run it in
   /tmp/rm-test, one command per call:
     node /home/ubuntu/versioner-test/js/packages/release-management-cli/bin/release-management with-github-auth -- <command> [args...]
   For example, with that prefix written as `with-github-auth`:
     with-github-auth -- git fetch origin
     with-github-auth -- git merge --no-ff origin/<source-branch>
     with-github-auth -- git commit --no-edit --cleanup=strip
     with-github-auth -- git push -u origin <resolution-branch>
     with-github-auth -- gh pr create --base develop --title "<title>" --body-file /tmp/pr-body.md
     with-github-auth -- gh pr close <number> --comment "Superseded by #<new number>"
4. Never run a command whose output could contain a token: no plain
   `git remote -v`, `git remote get-url`, `git config --list`, `env` or
   `printenv`. Local clones are disposable: delete or reset stale local refs
   freely. On origin, only the release-management tools change anything, as
   an approved plan describes, plus the pull request of a manual downmerge
   into develop.
