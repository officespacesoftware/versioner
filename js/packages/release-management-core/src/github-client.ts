/**
 * GitHub client factory — resolves auth and origin owner/repo, returns Octokit handles.
 *
 * Token resolution order:
 *   1. GH_TOKEN env var
 *   2. GITHUB_TOKEN env var
 *   3. `gh auth token` (uses gh CLI's stored credentials — keychain or hosts.yml)
 *   4. ~/.config/gh/hosts.yml -> github.com.oauth_token (older gh versions)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

const execAsync = promisify(exec);

type GraphqlFn = typeof graphql;

export interface GitHubClient {
  owner: string;
  repo: string;
  rest: Octokit;
  graphql: GraphqlFn;
}

const cache = new Map<string, GitHubClient>();

export async function createGitHubClient(
  workingDirectory: string
): Promise<GitHubClient> {
  const cached = cache.get(workingDirectory);
  if (cached) return cached;

  const token = await resolveToken();
  if (!token) {
    throw new Error(
      "No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run 'gh auth login' so `gh auth token` returns a token."
    );
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
  } else {
    cache.clear();
  }
}

async function resolveToken(): Promise<string | undefined> {
  const envToken = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (envToken && envToken.length > 0) return envToken;

  // Newer gh versions store credentials in the OS keychain rather than hosts.yml.
  // `gh auth token` reads from whichever backend gh is configured to use.
  try {
    const { stdout } = await execAsync("gh auth token");
    const token = stdout.trim();
    if (token.length > 0) return token;
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
    if (stored && stored.length > 0) return stored;
  } catch {
    // hosts.yml missing or unreadable — fall through to undefined
  }
  return undefined;
}

async function parseOriginOwnerRepo(
  workingDirectory: string
): Promise<{ owner: string; repo: string }> {
  const { stdout } = await execAsync("git remote get-url origin", {
    cwd: workingDirectory,
  });
  const url = stdout.trim();

  // git@github.com:owner/repo(.git)?
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh && ssh[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };

  // https://github.com/owner/repo(.git)?
  const https = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (https && https[1] && https[2]) return { owner: https[1], repo: https[2] };

  throw new Error(
    `Could not parse owner/repo from origin URL: ${url}. Expected github.com SSH or HTTPS URL.`
  );
}
