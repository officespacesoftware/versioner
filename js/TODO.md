# TODO

Deferred follow-ups for the release-management workspace. Not blocking the initial CLI/MCP split — pick up when the trigger condition fires.

## Replace `gh` CLI with Octokit

**What:** Swap the `gh` subprocess calls in `packages/core/src/git-flow.ts` (`gh pr create`, `gh pr edit`, `gh pr close`, `gh pr checks`, `gh api`, `gh release create`, `gh pr view`) for direct REST/GraphQL calls via `@octokit/rest`.

**Why defer:** `ubuntu-latest` runners include `gh` preinstalled and the local dev story works with `gh auth login`. Spawning `gh` is ~200ms per call which is unmeasurable in the workflow we have today.

**Trigger to revisit:**
- A runner image without `gh` becomes important (self-hosted runner, smaller base image), or
- We add a workflow that does >10 PR operations in sequence and the subprocess overhead becomes visible, or
- We need a feature `gh` doesn't surface ergonomically (e.g. fine-grained GraphQL queries on review state).

**Sketch:** introduce a `GitHubClient` interface in `packages/core` with two implementations (`GhCliClient`, `OctokitClient`). GitFlowManager takes one via constructor; defaults to `GhCliClient` for back-compat.

## Composite GitHub Action wrapper

**What:** Publish a `officespacesoftware/release-management-action` repo with a composite `action.yml` so users can write `uses: officespacesoftware/release-management-action@v1` with `command: increment-rc` instead of `npx -p @officespacesoftware/release-management-cli@latest release-management increment-rc`.

**Why defer:** ergonomic sugar, not new capability. We need real users on the CLI first to learn which command/flag combinations are common enough to deserve `with:` inputs vs. a generic `args:` passthrough.

**Trigger to revisit:** at least two real workflows in the wild using the CLI directly, with overlapping invocation shapes worth abstracting.

**Sketch:** composite action that runs:
1. `actions/setup-node@v4` (only if node missing).
2. `npx -p @officespacesoftware/release-management-cli@${{ inputs.version || 'latest' }} release-management ${{ inputs.command }} ${{ inputs.args }}`.
3. Re-exports `$GITHUB_OUTPUT` from the inner run (free — it's the same file).

## Deprecate the MCP

**What:** When the CLI has stabilized and feedback shows it covers the same use cases, mark `packages/mcp/package.json` with `"deprecated": "use @officespacesoftware/release-management-cli"` and stop publishing new versions.

**Why defer:** the MCP is still actively used by Claude Code workflows; deprecation is a downstream decision, not a code change blocker.

**Trigger to revisit:** explicit decision by the team to sunset the MCP.
