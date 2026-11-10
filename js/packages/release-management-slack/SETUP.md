# Setting up the Release Manager Slack app

Every step to build the app's environment from nothing: the accounts, the Cursor key and
environment, the Slack app, the Google Cloud resources, the deploy, the agent's setup, the
end-to-end check, the failures met so far and how to operate it afterwards.

The commands use placeholders for anything specific to an environment. Set them once in
your shell:

```bash
P=<gcp-project-id>                              # e.g. my-dev-project
R=<gcp-region>                                  # e.g. us-central1
SA=release-manager@$P.iam.gserviceaccount.com   # the service account created in 4.2
```

Other placeholders: `<service-url>` (the Cloud Run URL, see 4.6), `<channel-id>` and
`<user-id>` (Slack IDs, see 3.6), `<owner>/<repo>` (the repository whose releases the app
manages, the "target repository").

Steps marked **(by hand)** write a secret or open the service to the internet. Run them
yourself in a terminal; never paste a secret into a chat, an AI assistant or Slack. An AI
assistant's permission checks may refuse these steps anyway.

## Contents

0. [Order of work](#0-order-of-work)
1. [Prerequisites and accounts](#1-prerequisites-and-accounts)
2. [Cursor](#2-cursor)
3. [The Slack app](#3-the-slack-app)
4. [Google Cloud](#4-google-cloud)
5. [Deploying](#5-deploying)
6. [The agent setup](#6-the-agent-setup)
7. [Verifying end to end](#7-verifying-end-to-end)
8. [Troubleshooting](#8-troubleshooting)
9. [Operating](#9-operating)

### The test deployment

The values the first deployment used, as a worked example. None of them is a secret.

| Setting | Value |
| --- | --- |
| GCP project | `oss-development-323115` |
| Region | `us-central1` |
| Cloud Run service | `release-manager` |
| Service URL | `https://release-manager-6rhxlxxchq-uc.a.run.app` |
| Service account | `release-manager@oss-development-323115.iam.gserviceaccount.com` |
| Cloud Tasks queue | `release-manager` (`projects/oss-development-323115/locations/us-central1/queues/release-manager`), max attempts 5, max concurrent dispatches 10 |
| Secrets | `release-manager-cursor-api-key`, `release-manager-slack-signing-secret`, `release-manager-slack-bot-token` |
| Slack app | **Release Manager**, bot user `@release-manager` |
| Slack bot scopes | `app_mentions:read`, `chat:write` |
| Slack event | `app_mention` |
| Slack channel | a private test channel, `#release-manager-test` |
| Target repository | `https://github.com/officespacesoftware/release-management-test` |
| Cursor repositories | the target repository and `https://github.com/officespacesoftware/versioner` |
| Cursor model | `claude-sonnet-5-5` |
| Versioner branch the agent builds | `release-management/automation-test` |
| Cloud Run settings | min instances 0, max instances 3, 256 MiB, 60 s request timeout |

## 0. Order of work

The sections below are grouped by system, but the steps depend on each other across
systems. Work in this order:

1. Accounts and permissions (1).
2. The Cursor key and environment (2).
3. The Google Cloud APIs, service account, queue, IAM bindings and empty secrets
   (4.1 to 4.5).
4. The service URL (4.6). The Slack manifest needs it.
5. The Slack app, from the manifest, and its install request (3.1 to 3.3). The install
   waits for a workspace admin.
6. The signing secret and the Cursor key into Secret Manager, and a placeholder bot token
   until the install is approved (4.5).
7. The first deploy and public access (5). The service exits at startup if any secret is
   empty.
8. Slack's URL check (3.4), the real bot token once the install is approved (3.3, 4.5),
   the channel and the IDs (3.5, 3.6), and a redeploy with them (5).
9. The end-to-end check (7).

## 1. Prerequisites and accounts

**Tools on the machine you deploy from:** `gcloud` (signed in with `gcloud auth login`),
Node 20 or newer, `pnpm`, `python3`, `curl`, and a checkout of versioner with
`pnpm install --frozen-lockfile` run in `js/` (the deploy compiles the package with the
workspace's TypeScript).

**Google Cloud.** A project where you can:

- enable APIs, or find these already enabled: Cloud Run, Cloud Build, Artifact Registry,
  Cloud Tasks, Secret Manager, IAM;
- create a service account, a Cloud Tasks queue and secrets, and set IAM policies on them;
- deploy a Cloud Run service from source;
- grant `roles/run.invoker` to `allUsers` on that service. An organization policy can
  forbid this (`iam.allowedPolicyMemberDomains`). Check it first:

  ```bash
  gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains \
    --project $P --effective
  ```

  `allValues: ALLOW` means public services are allowed. Another public service in the
  project is a good sign too:

  ```bash
  gcloud run services list --project $P
  gcloud run services get-iam-policy <some-service> --region $R --project $P
  ```

The project Owner role covers all of this. To see your roles:

```bash
gcloud projects get-iam-policy $P --flatten=bindings \
  --filter="bindings.members:user:<your-email>" --format="value(bindings.role)"
```

**Slack.** You can create an app at api.slack.com/apps in the workspace. Installing it
usually needs a **workspace admin's approval**: workspaces that restrict app installs
show **Request to Workspace Install** instead of **Install to Workspace**. Find the admins
in Slack under **People**, filtered by **Account type → Admins**. A sandbox workspace where
you are an admin avoids the wait, but you also need permission to create apps there.

**Cursor.** A plan with Cloud Agents and the Cloud Agents API. Someone with admin rights
on the Cursor team to create the cloud environment and its secrets (2.2). The API key
belongs to a user (2.1).

**GitHub.** A GitHub App that the tools act as, so branches, tags, pull requests and
releases are made by the app's bot user rather than a person. The full reference is in
versioner's [configuration.md](../../../docs/configuration.md#github-app-authentication).
In short:

1. Create the app (organization settings → **Developer settings** → **GitHub Apps** →
   **New GitHub App**). The tools use no webhook.
2. Repository permissions:

   | Permission | Access |
   | --- | --- |
   | Contents | Read and write |
   | Pull requests | Read and write |
   | Workflows | Read and write |
   | Metadata | Read (granted automatically) |

3. Generate a private key on the app's settings page. GitHub downloads a `.pem` file.
   Note the app ID from the same page.
4. Install the app on the target repository (all repositories, or the target among the
   selected ones). After a later change to the permissions, an owner of the installation
   must approve it before new tokens carry it.
5. If a ruleset or branch protection rule requires pull requests or status checks on
   `release/*` or `hotfix/*`, add the app to its bypass list (**Bypass list → Add bypass →
   Apps**). The tools push the version commit and tag straight to those branches; without
   the bypass the push fails with `GH013: Repository rule violations found`.

## 2. Cursor

The app starts Cursor cloud agents through the Cloud Agents API (`api.cursor.com/v1`). The
agent clones the target repository and versioner, builds the MCP server from versioner,
and calls its tools. Everything the agent knows about GitHub comes from the cloud
environment's secrets; the app itself never talks to GitHub.

### 2.1 The API key

Create a **user API key** in the Cursor dashboard (your own API keys, not the
**Team API Keys** tab). Keep it out of chats and files that get shared.

A team API key does not work. Team API keys only work with Cursor's Admin API (members,
usage, settings), and the Cloud Agents API refuses them with a 401:

```
This is a team API key from the dashboard's Team API Keys tab, which only works with the
Cursor Admin API. Use a personal user API key, or a service account API key (Cursor
dashboard > Settings > API Keys > Service Accounts) instead.
```

An agent needs an identity for GitHub access, billing and run ownership, so it runs as the
key's user. A **service account API key** (dashboard → Settings → API Keys → Service
Accounts) would be better, because the app would then not act as a person. That section
was not visible on the team's plan when the test deployment was set up, so it uses a user
key. If you have the section, use a service account key.

To check a key without putting it on a command line, read it into a variable and give it
to `curl` on standard input:

```bash
printf 'Cursor API key: '; read -rs K; echo
printf 'user = "%s:"\n' "$K" | curl -s -K - https://api.cursor.com/v1/models | head -c 300; echo
printf 'user = "%s:"\n' "$K" | curl -s -K - 'https://api.cursor.com/v1/environments?limit=100' | head -c 600; echo
unset K
```

The API takes the key as the Basic username with an empty password. The first call lists
the models (2.4); the second lists the environments the key can see (2.3).

### 2.2 The cloud environment and its secrets

Create a cloud environment (Cursor dashboard → Cloud Agents) with two repositories:

- the target repository, `https://github.com/<owner>/<repo>`;
- `https://github.com/officespacesoftware/versioner`. The agent builds the MCP from it,
  and the prompt points the agent at `docs/manual-downmerge.md` in it.

Cursor clones them under `/agent/repos/<repo-name>`, which is where the
[agent setup](#6-the-agent-setup) expects them.

Add these secrets to the environment:

| Secret | Value | Needed |
| --- | --- | --- |
| `GITHUB_APP_ID` | The GitHub App's ID (or client ID) | Always |
| `GITHUB_APP_PRIVATE_KEY` | The contents of the app's `.pem` file. Flattened newlines (`\n`) are accepted | Always |
| `GITHUB_TOKEN` | A classic personal access token with `read:packages` | Only when something the agent runs installs `@officespacesoftware` packages from GitHub Packages, which accepts only classic tokens. Building versioner from source does not need it |

With `GITHUB_APP_ID` and the key set, the tools mint hour-long installation tokens and
ignore any `GITHUB_TOKEN` for their own GitHub calls. The agent runs its own `git` and
`gh` through `with-github-auth` (6), so those act as the app too.

Cursor uses the most specific value of a secret: values passed when an agent starts, then
environment secrets, then personal secrets, then team secrets. A stray `GITHUB_TOKEN` at
another level can be what an agent picks up; see 8.

### 2.3 Repositories or an environment name

The app picks the environment in one of two ways:

- **`CURSOR_REPOS`**: a comma-separated list of repository URLs. The agent starts with
  those repositories, and Cursor uses the saved environment for that set. The test
  environment has no name, so the test deployment uses this, with the target repository
  and versioner.
- **`CURSOR_ENV_NAME`**: the name of a saved cloud environment. When set, it is used
  instead of `CURSOR_REPOS`. Name the environment in the dashboard to use it.

To see an environment's ID, name and repositories:

```bash
printf 'Cursor API key: '; read -rs K; echo
printf 'user = "%s:"\n' "$K" | curl -s -K - 'https://api.cursor.com/v1/environments?limit=100' |
  node -e 'for (const e of JSON.parse(require("fs").readFileSync(0)).items)
    console.log(e.id, "|", e.name, "|", e.owner, "|", e.repos.map((r) => r.url).join(" "))'
unset K
```

### 2.4 The model

`CURSOR_MODEL` is a model ID from `GET /v1/models` (2.1), for example `claude-sonnet-5-5`.
Leave it unset to use Cursor's default. A plan takes about 100 seconds with a new agent,
most of it building the MCP; an apply, sent as a follow-up to the same agent, about 40.

## 3. The Slack app

### 3.1 The manifest

The app needs two bot scopes and no user scopes:

- **`app_mentions:read`**: the app receives only messages that mention it, never the rest
  of the channel.
- **`chat:write`**: it posts and updates its own messages. Modals need no extra scope.

It subscribes to one bot event, `app_mention`, and uses interactivity for buttons and the
review modal. It checks who clicked against `APPROVERS`, so it needs no scope to read
users. Replace `<service-url>` with the Cloud Run URL (4.6):

```yaml
display_information:
  name: Release Manager
  description: Plans releases and applies them when an approver clicks Approve.
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: release-manager
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
settings:
  event_subscriptions:
    request_url: https://<service-url>/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
    request_url: https://<service-url>/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Keep `token_rotation_enabled: false`: with rotation on, bot tokens expire after 12 hours
and the app has no code to refresh them.

### 3.2 Creating the app

1. Go to api.slack.com/apps → **Create New App** → **From a manifest**, and choose the
   workspace.
2. Paste the manifest and create the app.
3. Slack checks the Events request URL when the manifest is saved. Until the service is
   deployed and public, the check fails. That is expected: you retry it in 3.4.

### 3.3 Installing it, the signing secret and the bot token

1. Open the app's **Install App** page. If it shows **Install to Workspace**, install it.
   If it shows **Request to Workspace Install**, click it and send the request; mention
   that the app asks only for `app_mentions:read` and `chat:write`. The request is not sent
   until you click it: the app's **Basic Information** page saying "Your app has 0 authed
   users", with the button still there, means nothing was requested.
2. A workspace admin approves the request. Slackbot sends you a direct message when they
   approve or decline.
3. **Signing secret.** **Basic Information → App Credentials → Signing Secret → Show**.
   It is 32 letters and digits, and it exists before the install is approved. Store it as
   in 4.5. It is not the Client Secret on the same page.
4. **Bot token.** **OAuth & Permissions → OAuth Tokens → Bot User OAuth Token**. It starts
   with `xoxb-`, is about 55 characters long, and appears only after the install is
   approved. If the page still shows the install button after an approval, reload it.
   Store it as in 4.5. Until then, a placeholder lets the service start (4.5).

### 3.4 Verifying the request URL

After the service is deployed and public (5), open **Event Subscriptions** in the app's
settings and click **Retry** next to the Request URL. It shows **Verified** when the
service answered Slack's `url_verification` challenge with a valid signature. Interactivity
has no check; it works once events do.

If Slack shows a banner asking to reinstall the app after a settings change, reinstalling
goes through the admin approval again. Changing scopes always needs a reinstall.

### 3.5 The channel

1. Create a channel. A private one keeps release requests among the people who may make
   them. For a test deployment, use a new channel rather than one where another release
   bot already listens, or both answer the same messages.
2. Invite the bot: in the channel, run `/invite @release-manager`. In a private channel
   the bot receives mentions only once it is a member, and `chat:write` posts only in
   channels the bot is in.

Anyone in the workspace can invite the bot to any channel. The app ignores every mention
and button click from a channel not in `SLACK_CHANNELS`, without starting an agent.

### 3.6 Channel and user IDs

The app is configured with IDs, not names. Neither is a secret.

- **Channel ID:** click the channel name at the top of the channel → **About**; the ID is
  at the bottom and starts with `C`. Or right-click the channel in the sidebar → **Copy
  link**; the ID is the last part of the URL.
- **User ID:** open the person's profile → **⋯** → **Copy member ID**. It starts with `U`.

Several of either go in as a comma-separated list.

## 4. Google Cloud

### 4.1 APIs

```bash
gcloud services list --enabled --project $P --format="value(config.name)" |
  grep -E 'run|cloudbuild|artifactregistry|cloudtasks|secretmanager|iam\.'

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudtasks.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com --project $P
```

Cloud Build and Artifact Registry are for `gcloud run deploy --source`, which builds the
image from the package's `Dockerfile`. The first deploy from source creates an Artifact
Registry repository for the images.

### 4.2 The service account

The service runs as this account, and Cloud Tasks signs its calls to the service as it.

```bash
gcloud iam service-accounts create release-manager --project $P \
  --display-name "Release Manager Slack app"
```

### 4.3 The Cloud Tasks queue

The queue carries the plan, apply, poll and review steps.

```bash
gcloud tasks queues create release-manager --project $P --location $R \
  --max-attempts 5 --max-concurrent-dispatches 10
```

- **`--max-attempts 5`:** a step that fails (the service answers 500) is retried, up to
  five attempts in all.
- **`--max-concurrent-dispatches 10`:** at most ten steps run at once.
- Everything else is the default.

The app names its tasks (`plan-<Slack event ID>`, `apply-<agent>-<run>-<digest>`,
`poll-<run>-<attempt>`, …). Cloud Tasks refuses a second task with a name it has seen
recently (for about an hour after the first ran), with a 409. The app treats that 409 as
"already queued", which is how a Slack retry, a double click on Approve, or an Approve
from both the message and the modal queue only one step.

A deleted queue's name cannot be reused for about a week. Pick another name if you have to
recreate it sooner.

### 4.4 IAM bindings

Four bindings, each for one reason:

```bash
# 1. The service adds tasks to its queue.
gcloud tasks queues add-iam-policy-binding release-manager --project $P --location $R \
  --member serviceAccount:$SA --role roles/cloudtasks.enqueuer

# 2. Each task carries an OIDC token for the service account. Creating a task that acts
#    as an account needs iam.serviceAccounts.actAs on it, so the account may act as itself.
gcloud iam service-accounts add-iam-policy-binding $SA --project $P \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser

# 3. The service reads its three secrets (one binding per secret, in 4.5).
#    roles/secretmanager.secretAccessor on each secret.

# 4. Slack can reach the service: after the first deploy, in 5.3.
#    roles/run.invoker for allUsers on the service.
```

**Why `allUsers` as invoker is safe.** Slack cannot send Google credentials, so the
service has to accept unauthenticated requests. The code checks every request itself:

- `/slack/events` and `/slack/interactions` reject any request without a valid
  `X-Slack-Signature`: an HMAC-SHA256 of `v0:<timestamp>:<body>` with the signing secret,
  and a timestamp no more than five minutes from now.
- `/tasks/step` rejects any request without a Google-signed (RS256) ID token whose issuer
  is Google, whose audience is `SERVICE_URL`, whose email is `TASK_SERVICE_ACCOUNT` (with
  `email_verified`), and which has not expired.
- Bodies over 256 KiB are refused (413). Any method but POST gets 405; a signed request
  to another path gets 404.

The account needs no `run.invoker` itself, for the same reason: the service is public and
verifies the token in code.

### 4.5 Secrets

Create the three secrets, readable only by the service account:

```bash
for name in cursor-api-key slack-signing-secret slack-bot-token; do
  gcloud secrets create release-manager-$name --project $P --replication-policy automatic
  gcloud secrets add-iam-policy-binding release-manager-$name --project $P \
    --member serviceAccount:$SA --role roles/secretmanager.secretAccessor
done
```

| Secret | Environment variable | Value |
| --- | --- | --- |
| `release-manager-cursor-api-key` | `CURSOR_API_KEY` | The Cursor user API key (2.1) |
| `release-manager-slack-signing-secret` | `SLACK_SIGNING_SECRET` | The app's signing secret (3.3) |
| `release-manager-slack-bot-token` | `SLACK_BOT_TOKEN` | The `xoxb-` bot token (3.3) |

**Writing a value (by hand).** Read it into a hidden shell variable, then pipe it in. The
value never appears on screen, in your shell history or on a command line:

```bash
printf 'Signing secret: '; read -rs V; echo
printf %s "$V" | gcloud secrets versions add release-manager-slack-signing-secret \
  --project $P --data-file=-
unset V
```

Paste at the prompt (nothing shows) and press Enter. Do the same for
`release-manager-slack-bot-token` and `release-manager-cursor-api-key`.

Do not paste straight into `gcloud secrets versions add … --data-file=-` and finish with
Ctrl-D. In the test setup that stored empty values twice, and the service then exited at
startup (8).

**Before the install is approved,** store a placeholder bot token so the service can
start. Slack calls fail until it is replaced:

```bash
printf pending | gcloud secrets versions add release-manager-slack-bot-token \
  --project $P --data-file=-
```

**Checking a secret without showing it.** This prints only the length:

```bash
for n in cursor-api-key slack-signing-secret slack-bot-token; do
  printf '%s: ' $n
  gcloud secrets versions access latest --secret release-manager-$n --project $P | wc -c
done
```

Expect 32 for the signing secret and about 55 for a bot token. 0 means an empty value;
7 means the bot token is still the `pending` placeholder. To list the versions and when
they were added:

```bash
gcloud secrets versions list release-manager-slack-bot-token --project $P \
  --format="value(name,state,createTime)"
```

Empty or placeholder versions can stay: the service reads `latest`. A new version reaches
the service on the next deploy (5).

### 4.6 The service URL

The URL is needed before the first deploy: it goes in the Slack manifest, and the app
gives it to Cloud Tasks (`SERVICE_URL`) as the address and the token audience for its
callbacks.

Cloud Run URLs have the form `https://<service>-<hash>-<region code>.a.run.app`, and
`<hash>` is the same for every service in a project. If the project already has a Cloud
Run service, swap its name for `release-manager`:

```bash
gcloud run services list --project $P --format="table(metadata.name,region,status.url)"
```

For example, `https://engineering-bot-6rhxlxxchq-uc.a.run.app` gives
`https://release-manager-6rhxlxxchq-uc.a.run.app` in `us-central1` (`uc`).

Otherwise, deploy once with any URL in `deploy.sh`, read the real one from the deploy's
last line, put it in `deploy.sh` and the manifest, and deploy again.

Cloud Run also answers on `https://<service>-<project number>.<region>.run.app`. Both
reach the same service; use one of them, the same one, in `deploy.sh` and in the manifest.

## 5. Deploying

### 5.1 Configure `deploy.sh`

[`deploy/deploy.sh`](deploy/deploy.sh) is written for the test deployment. For another
one, edit the values at its top and in its environment block:

| In `deploy.sh` | Set to |
| --- | --- |
| `P`, `R` | Project and region |
| `SA` | The service account (4.2) |
| `URL` | The service URL (4.6) |
| `CURSOR_REPOS` | The repositories the agent starts with (2.3) |
| `CURSOR_MODEL` | The model (2.4) |
| `GITHUB_REPO_URL` | `https://github.com/<owner>/<repo>`, for the links in messages |
| `AGENT_SETUP` | Read from `deploy/agent-setup-test.md`; point it at your own setup file (6) |
| `TASKS_QUEUE` | Built from `P`, `R` and the queue name `release-manager` |

### 5.2 Run it

```bash
gcloud auth login   # when gcloud says it cannot reauthenticate
js/packages/release-management-slack/deploy/deploy.sh <channel ids> <approver ids>
```

For example `deploy.sh C0123456789 U0123456,U0654321`. The script:

1. writes the environment variables to a temporary YAML file (each value JSON-quoted, so
   the multi-line `AGENT_SETUP` survives), removed on exit;
2. compiles the package (`npx tsc`, into `lib/`);
3. runs `gcloud run deploy release-manager --source <package>`. Cloud Build builds the
   `Dockerfile`, which copies only `package.json` and `lib/` into a `node:22-slim` image
   and runs `node lib/main.js` as the `node` user. `.gcloudignore` keeps `src/`, `test/`,
   `deploy/`, `node_modules/` and the docs out of the upload;
4. prints the service URL. It should equal `URL`.

The deploy flags:

| Flag | Value | Why |
| --- | --- | --- |
| `--service-account` | `$SA` | The identity for Secret Manager, Cloud Tasks and the task tokens |
| `--env-vars-file` | the temporary file | The settings below. Replaces every environment variable the service had |
| `--set-secrets` | the three secrets, `:latest` | `CURSOR_API_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` |
| `--min-instances 0` | | Costs nothing while idle; the first request after a pause starts an instance |
| `--max-instances 3` | | Caps the cost of a burst |
| `--memory 256Mi` | | Enough for a Node server with no dependencies |
| `--timeout 60` | | Every request finishes quickly: the long waits happen between polls, in Cloud Tasks |

### 5.3 Make it public (by hand, once)

```bash
gcloud run services add-iam-policy-binding release-manager --project $P --region $R \
  --member allUsers --role roles/run.invoker

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<service-url>/slack/events
```

The `curl` should print **401**: the service is reachable and refuses an unsigned
request. **403** means it is still private.

`deploy.sh` passes neither `--allow-unauthenticated` nor `--no-allow-unauthenticated`, so
redeploys keep this binding. Do not add `--no-allow-unauthenticated`: it removes it.

### 5.4 Environment variables

All of them, from [`src/config.ts`](src/config.ts). The service refuses to start when a
required one is missing or blank, and the log says which (`<NAME> is not set`).

| Variable | Required | Set by | Meaning |
| --- | --- | --- | --- |
| `SLACK_SIGNING_SECRET` | yes | secret | Checks that a request came from Slack |
| `SLACK_BOT_TOKEN` | yes | secret | Posts and updates the app's messages and modals |
| `CURSOR_API_KEY` | yes | secret | Starts agents, sends follow-ups, reads runs and artifacts |
| `SLACK_CHANNELS` | yes | first argument | Channel IDs the app acts in. Mentions and clicks elsewhere are ignored |
| `APPROVERS` | yes | second argument | Slack user IDs that may approve or cancel a plan, and press the next-step buttons that change GitHub without an Approve step (create or increment an RC, downmerge) |
| `CURSOR_REPOS` | one of the two | `deploy.sh` | Repository URLs the agent starts with; selects their saved environment |
| `CURSOR_ENV_NAME` | one of the two | not set by `deploy.sh` | A named cloud environment, used instead of `CURSOR_REPOS` |
| `CURSOR_MODEL` | no | `deploy.sh` | The agent's model ID; Cursor's default when unset |
| `GITHUB_REPO_URL` | no | `deploy.sh` | `https://github.com/<owner>/<repo>`. Every link in a message is built from it; without it, messages carry no links |
| `AGENT_SETUP` | yes | `deploy.sh`, from a file | Repository-specific instructions the agent follows before the request (6) |
| `TASKS_QUEUE` | yes | `deploy.sh` | `projects/<project>/locations/<region>/queues/<queue>` |
| `SERVICE_URL` | yes | `deploy.sh` | The service's own URL: where tasks call back, and their token's audience |
| `TASK_SERVICE_ACCOUNT` | yes | `deploy.sh` | The account tasks are signed as, and the only email `/tasks/step` accepts |
| `PORT` | no | Cloud Run | The port to listen on; 8080 by default |

Anyone in an allowed channel can ask for a plan. Each request starts a Cursor agent on the
API key's account. A create-RC or increment-RC plan with no warnings is applied without an
Approve step, as the tools' plan rules say; everything else waits for an approver.

### 5.5 Checking the revision

```bash
gcloud run services describe release-manager --project $P --region $R \
  --format="value(status.latestReadyRevisionName,status.url)"
gcloud run revisions list --service release-manager --project $P --region $R --limit 3
gcloud run services get-iam-policy release-manager --project $P --region $R
```

The newest revision should be ready and serving all traffic, and the policy should list
`allUsers` with `roles/run.invoker`. If a deploy fails with "The user-provided container
failed to start", read that revision's startup log (7.2).

## 6. The agent setup

`AGENT_SETUP` is the first part of every prompt the app sends a new agent. The app adds
the request, the request-to-tool table, the plan and apply rules and the JSON reply
contract (`src/prompts.ts`); the setup says how to build the tools and where the target
repository is. [`deploy/agent-setup-test.md`](deploy/agent-setup-test.md) is the one for
the test repository. Its four steps:

1. **Build the MCP server and CLI from a versioner branch**, in a separate worktree, and
   start the MCP with `RELEASE_MANAGEMENT_OUTPUT_DIR=/opt/cursor/artifacts/release-management`.
   With that variable, the MCP writes each tool call's `structuredContent` to a JSON file
   named `<UTC timestamp>-<sequence>-<tool>.json`
   ([actions.md](../../../docs/actions.md#structured-tool-output),
   [configuration.md](../../../docs/configuration.md#environment-variables)). Cursor
   serves `/opt/cursor/artifacts` through its artifacts API as `artifacts/`; the app lists
   the run's files, picks the newest one written during the run for the tool the reply
   names, downloads it (1 MB at most) and renders from it. The agent must never write,
   edit or delete files there itself.
2. **Fetch the target repository** with
   `git fetch origin --prune --prune-tags --tags --force`, because plans read
   remote-tracking refs and never fetch, and the environment's snapshot can keep tags
   already deleted on origin (a stale tag blocks plans). Then make a detached worktree
   from `origin/develop` and pass it to every tool as `workingDirectory`.
3. **Run the agent's own `git` and `gh` through `with-github-auth`**
   ([configuration.md](../../../docs/configuration.md#running-your-own-git-and-gh-as-the-app)),
   one command per call, so the merge, the push and the pull request of a manual
   downmerge are the GitHub App's.
4. **Never run a command whose output could contain a token** (`git remote -v`,
   `git remote get-url`, `git config --list`, `env`, `printenv`), and change nothing on
   origin except through the tools, as an approved plan describes, plus the pull request
   of a manual downmerge into develop.

**Adapting it to another repository.** Copy it to `deploy/agent-setup-<name>.md`, point
`AGENT_SETUP` in `deploy.sh` at the copy, and change:

- **The versioner branch** in step 1. The test setup builds
  `release-management/automation-test`, a branch for trying changes before they reach
  `next`. A production setup should build `next`, or a fixed commit or tag, so a push to
  a test branch cannot change what the production agent runs. The branch must include
  versioner PR #24 (`RELEASE_MANAGEMENT_OUTPUT_DIR`); without it no artifact is written
  and every plan falls back to unverified text that needs the review modal.
- **The repository paths** in steps 2 and 3: `/agent/repos/<repo-name>`, and a worktree
  path of your choice.
- **The base branch** of the worktree, if it is not `develop`.
- Keep the `RELEASE_MANAGEMENT_OUTPUT_DIR` path exactly as it is: the app looks for
  `artifacts/release-management/`.
- `with-github-auth` takes `--repo <owner/name>` when it runs outside the repository's
  checkout.

The setup is plain text in an environment variable, so a change needs a redeploy (5).

## 7. Verifying end to end

### 7.1 The checks, in order

1. **Service up:** the `curl` in 5.3 prints 401.
2. **Slack reaches it:** **Event Subscriptions** shows **Verified** (3.4).
3. **A read-only request:** in the channel, post `@release-manager what's in flight`. A
   "Planning…" reply appears in the thread at once, with a link to the agent; within
   about two minutes it becomes the list of in-flight branches, each with a next-step
   button. `@release-manager help` shows what the app understands.
4. **A plan:** post `@release-manager promote <X.Y.Z>` for an RC on the target. The plan
   shows the changes (deletes first), the commits that reach main with a compare link,
   the VERSION change and any warnings, then:
   - **Approve**, **View details** and **Cancel** for a plan with no warning and nothing
     deleted; or
   - **Review & approve…** and **Cancel** for any warning or deletion. The modal opens
     with a loading view and fills in a few seconds; its submit is the only way to
     approve.
5. **Approve** (as a user in `APPROVERS`): the confirm dialog states the consequence; the
   message changes to "Applying, approved by …", and after about 40 seconds to
   "✅ Applied" with a result card linking the tag, the release and the pull requests.
   Check them on GitHub: commits, tags and pull requests are by the GitHub App's bot.
6. **A non-approver's click** gets a private "Only release approvers can approve: …".
7. **Cancel** collapses the plan to one struck-through line.

Use a throwaway target repository for the first applies: they really push.

### 7.2 Reading the logs

Every request, with its status:

```bash
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="release-manager"
  AND timestamp>="<UTC time, e.g. 2026-11-05T00:25:00Z>"' \
  --project $P --limit 40 \
  --format="value(timestamp,httpRequest.requestUrl,httpRequest.status,textPayload)" |
  grep -v '^\s*$' | sort
```

A healthy request looks like one `/slack/events` 200, then `/tasks/step` 200 about every
10 seconds while the agent works, then nothing. A button click is one
`/slack/interactions` 200 followed by more `/tasks/step` calls.

| You see | Meaning |
| --- | --- |
| `/slack/*` 401 | The Slack signature did not check out (8) |
| `/tasks/step` 401 | The task's token is not for `SERVICE_URL` and `TASK_SERVICE_ACCOUNT` (8) |
| `/tasks/step` 500 | The step threw; the line before it says why, and Cloud Tasks retries it |
| `Cursor getRun failed` | A poll could not read the run; the next poll tries again |
| `Cursor artifact read failed` | No usable structured output; the plan falls back to text |
| `chat.update failed` | Slack refused an update; the error names the Slack error code |

A failed revision's startup log, by revision name (from 5.5 or the deploy's error):

```bash
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.revision_name="release-manager-00001-abc"' \
  --project $P --limit 20 --format="value(textPayload)" | grep -v '^$'
```

Every message's footer links to the Cursor agent (`cursor.com/agents/<id>`), where the
agent's full transcript is. Tasks still waiting in the queue:

```bash
gcloud tasks list --queue release-manager --location $R --project $P
```

## 8. Troubleshooting

Every failure met while setting up the test deployment, then the ones the code reports.

**"Could not start the agent: Cursor POST /v1/agents failed (401): This is a team API
key…".** The Cursor secret holds a team API key. Store a user API key (2.1, 4.5) and
redeploy. If the team key was created only for this, revoke it: it has admin access.

**gcloud: "Reauthentication failed. cannot prompt during non-interactive execution".**
The gcloud login expired. Run `gcloud auth login` in your own terminal (it opens a
browser), then rerun the command.

**Deploy: "The user-provided container failed to start"; log: "Default STARTUP TCP probe
failed" and "Error: SLACK_SIGNING_SECRET is not set".** A secret's latest version is
empty. Check the lengths (4.5), store the value again with the `read -rs` pattern, and
redeploy. The same happens with any required variable (`<NAME> is not set`, or
"Set CURSOR_REPOS or CURSOR_ENV_NAME").

**A secret is stored with length 0.** Pasting straight into
`gcloud secrets versions add … --data-file=-` and ending with Ctrl-D stored an empty
value. Use the `read -rs` pattern (4.5).

**The bot token's length is 7.** That is the `pending` placeholder, so every Slack call
fails (`invalid_auth`) and the bot never answers. Copy the real `xoxb-` token from
**OAuth & Permissions**, store it again, check it is about 55, and redeploy. If it shows 7
again, the paste is not reaching the prompt; check what you copied with
`pbpaste | cut -c1-5` (prints only `xoxb-`).

**No bot token on OAuth & Permissions; "Your app has 0 authed users".** The install is
not approved, or was never requested: the **Install App** page still showing **Request to
Workspace Install** means the request was not sent (3.3).

**You cannot create apps in a sandbox workspace.** Creating apps needs that permission
there. The test deployment's app was created in the main workspace instead, and its
install was approved by a workspace admin.

**`curl` prints 403.** The service is private. Add the `allUsers` invoker binding (5.3).
An AI assistant may be refused this step and the secret writes by its permission checks;
run them yourself.

**Event Subscriptions does not verify.** The service is not deployed, not public, or the
signing secret is wrong. Check 5.3 and the logs, then click **Retry**.

**The bot does not answer a mention.** In order: the channel is not in `SLACK_CHANNELS`
(the app ignores it silently); the bot is not in the channel (`/invite @release-manager`);
the bot token is the placeholder; the Events URL is not verified. Messages from bots and
Slack's own retries (`X-Slack-Retry-Num`) are ignored on purpose.

**`/slack/*` returns 401 (signature failures).** The signing secret does not match the
app: the Client Secret was stored instead of the Signing Secret, the secret belongs to
another app, or it was rotated and the service was not redeployed. A request more than
five minutes from the service's clock is refused too.

**`/tasks/step` returns 401.** The token Cloud Tasks sends is checked against
`SERVICE_URL` (audience) and `TASK_SERVICE_ACCOUNT` (email). They come from the same
`deploy.sh` values, so a mismatch means one was edited by hand, or tasks queued before a
change of URL or account are still being delivered.

**"Cloud Tasks returned 403" in the log.** The service account lacks
`roles/cloudtasks.enqueuer` on the queue, or `roles/iam.serviceAccountUser` on itself
(4.4).

**Cloud Tasks returns 409.** Expected: a task with that name was already queued (4.3). The
app treats it as done.

**"Could not parse owner/repo from origin URL: https://x-access-token:[REDACTED]@github.com/…".**
Cursor's clones have an origin URL with a credential in it, which older versioner builds
rejected. Versioner accepts such URLs now and strips the credential from its messages
(versioner PR #22). Build a versioner that includes it; no workaround is needed in the
agent setup.

**The first GitHub call fails with "404 Not Found".** GitHub answers 404, not 403, when
the credential cannot see a private repository. In the test setup, the environment's
`GITHUB_TOKEN` had been replaced with a personal token without access to the target. Use
the GitHub App (1, 2.2). Ask the agent to run `health_check`: its `auth` field should
say `app <slug>`, and the permissions should include contents, pull requests and
workflows. Check
for a stray `GITHUB_TOKEN` at another secret level (2.2).

**A push to `release/*` or `hotfix/*` fails with "GH013: Repository rule violations
found".** The GitHub App is not on the ruleset's bypass list (1).

**"The agent's reply could not be read", or a plan with invented details.** The agent used
to copy the tool's structured output into its JSON reply. On a 7.5 KB plan it invented a
commit subject, dropped an author and left the JSON unclosed. The app now reads the MCP's
own file from the run's artifacts (6), and salvages the plan text and digest from a broken
reply. If plans keep showing ⚠️ *Unverified* and always need the review modal, no
artifact is being read: check that the setup starts the MCP with
`RELEASE_MANAGEMENT_OUTPUT_DIR=/opt/cursor/artifacts/release-management`, that the
versioner branch includes PR #24, and the log for `Cursor artifact read failed`.

**"the agent stayed busy for 60 s, so the apply was never sent".** Cursor refused the
follow-up with `agent_busy` six times, 10 seconds apart. Ask for a new plan.

**⌛ "Outcome unknown".** An apply ran past 15 minutes (90 polls), or the run ended with
`ERROR`, `CANCELLED` or `EXPIRED`. The agent may have pushed part of the change: open the
agent from the footer and check the repository before planning again.

**`pnpm install --frozen-lockfile` fails with `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`
(`importers["packages/release-management-slack"]`).** pnpm writes no lockfile importer for
a package with no dependencies. `pnpm-lock.yaml` carries an empty one; keep it. Agents run
this install when they build the MCP, so without it their builds fail.

## 9. Operating

**Changing approvers or channels.** Run `deploy.sh` again with the new lists. Because
`--env-vars-file` replaces every variable, a change made with
`gcloud run services update --update-env-vars` is lost on the next deploy; keep
`deploy.sh` the source of truth. A new channel also needs the bot invited (3.5).

**Changing the agent setup, the model or the repositories.** Edit the file or `deploy.sh`
and redeploy.

**Rotating a secret.** Add a new version (4.5), redeploy so new instances read it, then
retire the old value at its source. Old versions can be disabled with
`gcloud secrets versions disable <version> --secret <name> --project $P`.

| Secret | Rotate by |
| --- | --- |
| Slack signing secret | **Basic Information → App Credentials → Signing Secret → Regenerate**, store, redeploy. Requests are refused (401) between the regeneration and the redeploy |
| Slack bot token | Revoke the token on **OAuth & Permissions** and reinstall the app, which may need the admin's approval again; store the new `xoxb-` token, redeploy |
| Cursor API key | Create a new key, store it, redeploy, then delete the old key in the Cursor dashboard |
| GitHub App private key | Generate a new key on the app's settings page, put it in the Cursor environment's `GITHUB_APP_PRIVATE_KEY`, check with `health_check`, then delete the old key. Nothing in Google Cloud changes |
| `GITHUB_TOKEN` (packages) | Create a new classic token with `read:packages`, replace the Cursor environment secret, delete the old token |

If a secret is ever exposed, rotate it at once.

**Moving to production.** One service manages one target repository, because the
repositories, the links and the agent setup are per service, and one Slack app points at
one URL. For production, or for another repository:

1. A Cursor environment with the production target and versioner, and the GitHub App's
   secrets (2.2). The app must be installed on the target, with the ruleset bypass (1).
2. An agent setup that builds versioner `next` or a fixed commit, not the test branch (6).
3. Either a separate project, or a different service, queue, service account and secret
   names in the same project; `deploy.sh` hard-codes `release-manager`, so copy it and
   change the names.
4. A Slack app for that service (3), or the existing app's URLs pointed at the new service
   once the test service is retired. URL and scope changes may go back to the workspace
   admin.
5. The production channel's ID and the release approvers' IDs as the `deploy.sh`
   arguments, with the channel kept to people allowed to cut releases.
6. A Cursor API key for an account meant for this rather than a person, when the plan
   offers service account keys (2.1).
7. The end-to-end check (7), starting with a read-only request.
