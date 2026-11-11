/**
 * Settings come from the environment. Secrets reach it through Cloud Run's
 * Secret Manager bindings, never through files in the image.
 */

export interface Config {
  slackSigningSecret: string;
  slackBotToken: string;
  cursorApiKey: string;
  /** Channels the app acts in. Mentions elsewhere are ignored. */
  channels: string[];
  /** Slack user IDs allowed to approve or cancel a plan. */
  approvers: string[];
  /** Repositories the agent starts with, which selects their saved environment. */
  cursorRepos: string[];
  /** A named Cursor environment, used instead of `cursorRepos` when set. */
  cursorEnvName: string | undefined;
  cursorModel: string | undefined;
  /** `https://github.com/<owner>/<repo>`, to link pull requests in plans. */
  githubRepoUrl: string | undefined;
  /** Repository-specific setup the agent runs before planning. */
  agentSetup: string;
  /** `projects/<p>/locations/<l>/queues/<q>`. */
  tasksQueue: string;
  /** This service's base URL, which Cloud Tasks calls back. */
  serviceUrl: string;
  /** The identity Cloud Tasks signs its calls with. */
  taskServiceAccount: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function loadConfig(env: Env = process.env): Config {
  const cursorRepos = list(env.CURSOR_REPOS);
  const cursorEnvName = env.CURSOR_ENV_NAME?.trim() || undefined;
  if (cursorRepos.length === 0 && cursorEnvName === undefined) {
    throw new Error("Set CURSOR_REPOS or CURSOR_ENV_NAME");
  }
  const channels = list(env.SLACK_CHANNELS);
  if (channels.length === 0) {
    throw new Error("SLACK_CHANNELS is not set");
  }
  const approvers = list(env.APPROVERS);
  if (approvers.length === 0) {
    throw new Error("APPROVERS is not set");
  }

  return {
    slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
    slackBotToken: required(env, "SLACK_BOT_TOKEN"),
    cursorApiKey: required(env, "CURSOR_API_KEY"),
    channels,
    approvers,
    cursorRepos,
    cursorEnvName,
    cursorModel: env.CURSOR_MODEL?.trim() || undefined,
    githubRepoUrl: env.GITHUB_REPO_URL?.trim().replace(/\/+$/, "") || undefined,
    agentSetup: required(env, "AGENT_SETUP"),
    tasksQueue: required(env, "TASKS_QUEUE"),
    serviceUrl: required(env, "SERVICE_URL").replace(/\/+$/, ""),
    taskServiceAccount: required(env, "TASK_SERVICE_ACCOUNT"),
  };
}
