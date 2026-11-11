# @officespacesoftware/release-management-slack

A Slack app that runs the release-management tools from a mention and puts every change
behind an **Approve** button. Someone writes `@release-manager promote 1.4.0` in an allowed
channel; the app starts a Cursor cloud agent that builds the
[MCP server](../release-management-mcp/README.md) and asks for a plan; the plan comes back
as Block Kit with the changes, the commits and the warnings; an approver clicks
**Approve**, and the same agent applies exactly that plan.

One Cloud Run service, with no runtime dependencies. It is stateless: everything a step
needs travels in the Cloud Tasks task or in the Slack button.

| Route | Called by | Checked with | Does |
| --- | --- | --- | --- |
| `POST /slack/events` | Slack Events API | Slack signature, at most 5 minutes old | Answers the URL check; queues a `plan` task for each `app_mention` in an allowed channel |
| `POST /slack/interactions` | Slack interactivity | Slack signature | Buttons and the review modal; only approvers can approve or cancel |
| `POST /tasks/step` | Cloud Tasks | Google-signed OIDC token for the app's service account | Starts the agent, polls it every 10 s, renders the result |

What the agent returns is not trusted. The MCP writes each tool call's structured output
to the agent's artifacts (`RELEASE_MANAGEMENT_OUTPUT_DIR`); the app downloads that file,
recomputes the plan's digest the way the core does, and renders from it. A plan it cannot
verify always needs the review modal.

- **Setting it up from nothing:** [SETUP.md](SETUP.md): accounts, Cursor, the Slack app,
  Google Cloud, deploying, the agent setup, verifying, troubleshooting and operating.
- **Deploying:** [`deploy/deploy.sh`](deploy/deploy.sh) `<channel ids> <approver ids>`.
- **The agent's setup for the test repository:**
  [`deploy/agent-setup-test.md`](deploy/agent-setup-test.md).
- **Settings:** every environment variable is in [`src/config.ts`](src/config.ts) and in
  [SETUP.md](SETUP.md#5-deploying).

## Development

```bash
cd js && pnpm install --frozen-lockfile
cd packages/release-management-slack
npm test          # compiles, then runs test/*.test.mjs
npm run mockups   # prints a Block Kit Builder link for every message
```

`test/fixtures/mockups/` holds every message the app can post, rendered from real MCP
output; a test fails when the code and the fixtures drift apart.
