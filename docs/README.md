# Documentation

The reference for versioner's release-management tools: what each action does, what it
says, and how it fails. Every statement here is checked against the code in
`js/packages/release-management-core/src`, `js/packages/release-management-cli/src` and
`js/packages/release-management-mcp/src`; where the two disagree, the code is right and
the document has a bug.

| Document | Read it for |
| --- | --- |
| [actions.md](actions.md) | Each action: inputs, branch selection, plan or immediate, git effects in order, pull requests, GitHub releases, messages, decision table, partial failure and recovery. Also the plan/confirm protocol and what the digest covers |
| [messages.md](messages.md) | Every refusal, warning, note, handoff, pipeline result and apply failure, with its exact text, condition and what to do |
| [flows.md](flows.md) | Diagrams: release lifecycle, hotfix lifecycle, plan and confirm, downmerge, revert shape, pipeline trigger |
| [configuration.md](configuration.md) | `.release-management.json` (pre-version checks, pipeline trigger), GitHub token resolution, environment variables |
| [manual-downmerge.md](manual-downmerge.md) | Finishing a conflicting downmerge by hand, or deciding one into `main` |
| [architecture.md](architecture.md) | Components, dependency direction, layers, the `VERSION` file contract |

Package READMEs cover installation and API surfaces:
[CLI](../js/packages/release-management-cli/README.md),
[MCP server](../js/packages/release-management-mcp/README.md),
[core library](../js/packages/release-management-core/README.md),
[versioner](../js/packages/versioner/README.md).

## Maintaining these documents

These documents are kept accurate by the pull requests that change behaviour, not by
periodic rewrites. A pull request that changes what an action does updates them in the
same pull request. Before asking for review, check each line that applies:

- [ ] **Action section** in [actions.md](actions.md): inputs, selection, plan mutations,
      apply steps in order, pull request titles, bodies and draft state, `$GITHUB_OUTPUT`
      keys.
- [ ] **Decision table** for that action: a new condition, or a changed outcome.
- [ ] **Partial failure and recovery** for that action: a new step, a step that changed
      from fatal to reported or back, or a new thing left behind.
- [ ] **Message catalog** in [messages.md](messages.md): every added, removed or reworded
      string from `throw new`, `warnings.push`, `notices.push`, a pipeline-trigger
      `message`, or an apply-report field. Run the grep at the top of that file and compare.
      Keep IDs stable: retire an ID rather than reuse it, and give new messages the next
      free number.
- [ ] **Pull requests by head/base pair** in
      [actions.md](actions.md#pull-requests): a pull request that is now opened, updated or
      closed by a different action.
- [ ] **Digest** in [actions.md](actions.md#what-the-digest-covers): a new plan field, or
      a fact moved between a summary (covered) and a detail line (not covered).
- [ ] **Diagrams** in [flows.md](flows.md): a new step, branch or decision in a lifecycle.
- [ ] **Configuration** in [configuration.md](configuration.md): a new key, default or
      environment variable.
- [ ] **Package READMEs and MCP tool descriptions**, where they repeat any of the above.

When the code and a document disagree and the code is wrong, fix the code or file the bug;
do not document the bug as intended behaviour. Known gaps are listed in the action's
section so readers are not surprised by them.
