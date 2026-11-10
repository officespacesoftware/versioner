/**
 * GitHub client factory — resolves auth and origin owner/repo, returns Octokit handles.
 *
 * Token resolution order (an empty variable counts as unset):
 *   1. GitHub App installation token, when GITHUB_APP_ID and a private key are set
 *   2. GH_TOKEN env var
 *   3. GITHUB_TOKEN env var
 *   4. `gh auth token` (uses gh CLI's stored credentials — keychain or hosts.yml)
 *   5. ~/.config/gh/hosts.yml -> github.com.oauth_token (older gh versions)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import {
  GITHUB_APP_ENV_VARS,
  GitHubAppAuth,
  GitHubAppAuthError,
  buildGitCredentialEnv,
  buildGitIdentityEnv,
  isGitHubAppAuthConfigured,
  readGitHubAppConfig,
  redactGitHubSecrets,
} from "./github-app-auth.js";

const execAsync = promisify(exec);

type GraphqlFn = typeof graphql;

export interface GitHubClient {
  owner: string;
  repo: string;
  rest: Octokit;
  graphql: GraphqlFn;
}

export type GitHubTokenSource = "GH_TOKEN" | "GITHUB_TOKEN" | "gh" | "gh hosts.yml";

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface GitHubAuthStatus {
  source: string;
  appId?: string;
  repository?: string;
  installationId?: number;
  permissions?: Record<string, string>;
  tokenExpiresAt?: string;
  error?: string;
}

const NO_TOKEN_MESSAGE =
  "No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run 'gh auth login' so `gh auth token` returns a token.";

const cache = new Map<string, GitHubClient>();
const appAuthCache = new Map<string, Promise<GitHubAppAuth | undefined>>();

/** Test hook: pre-seed the client cache so tests can swap in fakes without
 *  reaching into network/auth code. Not part of the public API. */
export function _setGitHubClientForTesting(
  workingDirectory: string,
  client: GitHubClient
): void {
  cache.set(workingDirectory, client);
}

export async function createGitHubClient(
  workingDirectory: string
): Promise<GitHubClient> {
  const cached = cache.get(workingDirectory);
  if (cached) return cached;

  const app = await getGitHubAppAuth(workingDirectory);
  if (app) {
    const rest = createAppOctokit(app);
    const appClient: GitHubClient = {
      owner: app.owner,
      repo: app.repo,
      rest,
      graphql: rest.graphql,
    };
    cache.set(workingDirectory, appClient);
    return appClient;
  }

  const token = (await resolveToken())?.token;
  if (!token) {
    throw new Error(NO_TOKEN_MESSAGE);
  }

  const { owner, repo } = await parseOriginOwnerRepo(workingDirectory);
  const rest = new Octokit({ auth: token });
  const graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  const client: GitHubClient = { owner, repo, rest, graphql: graphqlWithAuth };
  cache.set(workingDirectory, client);
  return client;
}

export function clearGitHubClientCache(workingDirectory?: string): void {
  if (workingDirectory) {
    cache.delete(workingDirectory);
    appAuthCache.delete(workingDirectory);
  } else {
    cache.clear();
    appAuthCache.clear();
  }
}

export async function getGitHubAppAuth(
  workingDirectory: string
): Promise<GitHubAppAuth | undefined> {
  if (!isGitHubAppAuthConfigured()) return undefined;
  const cached = appAuthCache.get(workingDirectory);
  if (cached) return cached;

  const created = (async () => {
    const config = readGitHubAppConfig();
    if (!config) return undefined;
    const { owner, repo } = await parseOriginOwnerRepo(workingDirectory);
    return new GitHubAppAuth({ config, owner, repo });
  })();
  appAuthCache.set(workingDirectory, created);
  created.catch(() => {
    if (appAuthCache.get(workingDirectory) === created) {
      appAuthCache.delete(workingDirectory);
    }
  });
  return created;
}

export async function gitCredentialEnv(
  workingDirectory: string
): Promise<Record<string, string>> {
  const app = await getGitHubAppAuth(workingDirectory);
  return app ? buildGitCredentialEnv(await app.token()) : {};
}

export async function gitIdentityEnv(
  workingDirectory: string
): Promise<Record<string, string>> {
  const app = await getGitHubAppAuth(workingDirectory);
  return app ? buildGitIdentityEnv(await app.botIdentity()) : {};
}

export async function githubCommandEnv(
  workingDirectory: string,
  repository?: GitHubRepository
): Promise<NodeJS.ProcessEnv> {
  const config = readGitHubAppConfig();
  let added: Record<string, string>;
  if (config) {
    const { owner, repo } =
      repository ?? (await parseOriginOwnerRepo(workingDirectory));
    const app = new GitHubAppAuth({ config, owner, repo });
    added = {
      ...tokenCommandEnv(await app.token()),
      ...buildGitIdentityEnv(await app.botIdentity()),
    };
  } else {
    const resolved = await resolveToken();
    if (!resolved) throw new Error(NO_TOKEN_MESSAGE);
    added = tokenCommandEnv(resolved.token);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...added };
  for (const name of GITHUB_APP_ENV_VARS) delete env[name];
  return env;
}

function tokenCommandEnv(token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    ...buildGitCredentialEnv(token),
  };
}

export async function describeGitHubAuth(
  workingDirectory: string
): Promise<GitHubAuthStatus> {
  if (isGitHubAppAuthConfigured()) {
    let app: GitHubAppAuth | undefined;
    try {
      app = await getGitHubAppAuth(workingDirectory);
      if (!app) return { source: "none" };
      const token = await app.installationToken();
      const { slug } = await app.appInfo();
      const status: GitHubAuthStatus = {
        source: `app ${slug}`,
        appId: app.appId,
        repository: app.repository,
        permissions: token.permissions,
        tokenExpiresAt: new Date(token.expiresAt).toISOString(),
      };
      if (app.installation !== undefined) {
        status.installationId = app.installation;
      }
      return status;
    } catch (error) {
      const status: GitHubAuthStatus = {
        source: "app",
        error: redactGitHubSecrets(
          error instanceof Error ? error.message : String(error)
        ),
      };
      if (app) {
        status.appId = app.appId;
        status.repository = app.repository;
      }
      return status;
    }
  }

  const resolved = await resolveToken();
  if (resolved) return { source: resolved.source };
  return {
    source: "none",
    error: NO_TOKEN_MESSAGE,
  };
}

function createAppOctokit(app: GitHubAppAuth): Octokit {
  const rest = new Octokit();
  rest.hook.before("request", async (options) => {
    options.headers.authorization = `token ${await app.token()}`;
  });
  rest.hook.error("request", (error) => {
    throw explainForbidden(error);
  });
  return rest;
}

function explainForbidden(error: unknown): unknown {
  const shaped = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Record<string, string | undefined> };
  };
  if (
    typeof error !== "object" ||
    error === null ||
    error instanceof GitHubAppAuthError ||
    shaped.status !== 403 ||
    typeof shaped.message !== "string"
  ) {
    return error;
  }
  const needed = shaped.response?.headers?.["x-accepted-github-permissions"];
  const hint = needed
    ? ` The GitHub App installation lacks a permission this request needs; GitHub accepts ${needed}.`
    : " The GitHub App installation may lack a permission this request needs.";
  (error as { message: string }).message = `${shaped.message}${hint}`;
  return error;
}

async function resolveToken(): Promise<
  { token: string; source: GitHubTokenSource } | undefined
> {
  // An empty variable counts as unset, so GH_TOKEN="" does not hide GITHUB_TOKEN.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const envToken = process.env[name];
    if (envToken && envToken.length > 0) return { token: envToken, source: name };
  }

  // Newer gh versions store credentials in the OS keychain rather than hosts.yml.
  // `gh auth token` reads from whichever backend gh is configured to use.
  try {
    const { stdout } = await execAsync("gh auth token");
    const token = stdout.trim();
    if (token.length > 0) return { token, source: "gh" };
  } catch {
    // gh missing or not authenticated — fall through
  }

  // Final fallback for older gh versions that stored the token directly in hosts.yml.
  try {
    const hostsPath = join(homedir(), ".config", "gh", "hosts.yml");
    const raw = readFileSync(hostsPath, "utf8");
    const parsed = yaml.load(raw) as
      | { "github.com"?: { oauth_token?: string } }
      | undefined;
    const stored = parsed?.["github.com"]?.oauth_token;
    if (stored && stored.length > 0) {
      return { token: stored, source: "gh hosts.yml" };
    }
  } catch {
    // hosts.yml missing or unreadable — fall through to undefined
  }
  return undefined;
}

export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}

export function parseGitHubRemoteUrl(
  url: string
): { owner: string; repo: string } | undefined {
  const ssh = url.match(
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/
  );
  if (ssh && ssh[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };

  const https = redactRemoteUrl(url).match(
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/
  );
  if (https && https[1] && https[2]) return { owner: https[1], repo: https[2] };

  return undefined;
}

async function parseOriginOwnerRepo(
  workingDirectory: string
): Promise<{ owner: string; repo: string }> {
  const { stdout } = await execAsync("git remote get-url origin", {
    cwd: workingDirectory,
  });
  const url = stdout.trim();
  const parsed = parseGitHubRemoteUrl(url);
  if (parsed) return parsed;

  throw new Error(
    `Could not parse owner/repo from origin URL: ${redactRemoteUrl(url)}. Expected github.com SSH or HTTPS URL.`
  );
}
