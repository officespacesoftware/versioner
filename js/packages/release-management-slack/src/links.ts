/**
 * Every URL the app shows is built here from `GITHUB_REPO_URL` and a name or
 * SHA that matched a strict pattern. URLs in the agent's reply are ignored,
 * except one that already starts with the repository URL.
 */

export const VERSION = /^\d+\.\d+\.\d+(?:-RC\.\d+)?$/;
export const SOURCE_BRANCH = /^(?:release|hotfix)\/\d+\.\d+\.\d+$/;
const MERGE_BRANCH =
  /^(?:main|(?:release|hotfix)-\d+\.\d+\.\d+)-into-(?:develop|main)-\d+$/;
const SHA = /^[0-9a-f]{7,40}$/;

export const isVersion = (v: string | undefined): v is string =>
  v !== undefined && VERSION.test(v);

export const isBranch = (name: string | undefined): name is string =>
  name !== undefined &&
  (name === "main" ||
    name === "develop" ||
    SOURCE_BRANCH.test(name) ||
    MERGE_BRANCH.test(name));

export const isSha = (sha: string | undefined): sha is string =>
  sha !== undefined && SHA.test(sha);

export const isPullNumber = (n: number | undefined): n is number =>
  n !== undefined && Number.isInteger(n) && n > 0 && n < 10_000_000;

export type Repo = string | undefined;

export const branchUrl = (repo: Repo, name: string): string | undefined =>
  repo && isBranch(name) ? `${repo}/tree/${name}` : undefined;

export const tagUrl = (repo: Repo, version: string): string | undefined =>
  repo && isVersion(version) ? `${repo}/releases/tag/${version}` : undefined;

export const commitUrl = (repo: Repo, sha: string): string | undefined =>
  repo && isSha(sha) ? `${repo}/commit/${sha}` : undefined;

export const pullUrl = (
  repo: Repo,
  n: number | undefined
): string | undefined =>
  repo && isPullNumber(n) ? `${repo}/pull/${n}` : undefined;

export const checksUrl = (repo: Repo, branch: string): string | undefined =>
  repo && isBranch(branch) ? `${repo}/commits/${branch}` : undefined;

const isRef = (ref: string): boolean =>
  isSha(ref) || isVersion(ref) || isBranch(ref);

export const compareUrl = (
  repo: Repo,
  base: string,
  head: string
): string | undefined =>
  repo && isRef(base) && isRef(head)
    ? `${repo}/compare/${base}...${head}`
    : undefined;

/** A URL from the reply, accepted only inside the configured repository. */
export function safeUrl(
  repo: Repo,
  url: string | undefined
): string | undefined {
  if (!repo || !url || !url.startsWith(`${repo}/`)) {
    return undefined;
  }
  return /^[^\s<>|"'`\\]+$/.test(url) && !url.includes("..") ? url : undefined;
}
