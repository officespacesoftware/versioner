import { createPrivateKey, sign, type KeyObject } from "crypto";
import { readFileSync } from "fs";

export const GITHUB_API_URL = "https://api.github.com";

export const GITHUB_APP_ENV_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
] as const;

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const REMEMBERED_SECRETS = 32;

export interface GitHubAppConfig {
  appId: string;
  privateKey: KeyObject;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
}

export interface GitHubAppInfo {
  id: number;
  slug: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubAppAuthOptions {
  config: GitHubAppConfig;
  owner: string;
  repo: string;
  fetch?: FetchFn;
  now?: () => number;
}

const knownSecrets: string[] = [];

function rememberSecret(secret: string): void {
  if (secret.length === 0 || knownSecrets.includes(secret)) return;
  knownSecrets.push(secret);
  if (knownSecrets.length > REMEMBERED_SECRETS) knownSecrets.shift();
}

export function redactGitHubSecrets(text: string): string {
  let redacted = text;
  for (const secret of knownSecrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export function isGitHubAppAuthConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return GITHUB_APP_ENV_VARS.some((name) => nonEmpty(env[name]) !== undefined);
}

export function normalizePrivateKey(raw: string): string {
  let text = raw.trim();
  const quote = text[0];
  if (
    text.length >= 2 &&
    (quote === '"' || quote === "'") &&
    text.endsWith(quote)
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n");
  const pem = text.match(
    /^(-----BEGIN [A-Z0-9 ]+-----)([\s\S]*?)(-----END [A-Z0-9 ]+-----)$/
  );
  if (!pem || !pem[1] || pem[2] === undefined || !pem[3]) return `${text}\n`;
  const body = pem[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return [pem[1], ...lines, pem[3]].join("\n") + "\n";
}

function parsePrivateKey(text: string, source: string): KeyObject {
  const invalid = new Error(
    `${source} does not hold a valid RSA private key in PEM form. Use the whole ` +
      `.pem file GitHub generated for the app, including its BEGIN and END lines; ` +
      `literal \\n sequences are accepted in place of newlines.`
  );
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: normalizePrivateKey(text), format: "pem" });
  } catch {
    throw invalid;
  }
  if (key.asymmetricKeyType !== "rsa") throw invalid;
  return key;
}

export function readGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env
): GitHubAppConfig | undefined {
  const appId = nonEmpty(env.GITHUB_APP_ID)?.trim();
  const inlineKey = nonEmpty(env.GITHUB_APP_PRIVATE_KEY);
  const keyPath = nonEmpty(env.GITHUB_APP_PRIVATE_KEY_PATH)?.trim();

  if (!appId && !inlineKey && !keyPath) return undefined;
  if (!appId) {
    throw new Error(
      "A GitHub App private key is set (GITHUB_APP_PRIVATE_KEY or " +
        "GITHUB_APP_PRIVATE_KEY_PATH) but GITHUB_APP_ID is not. Set GITHUB_APP_ID " +
        "to authenticate as the app, or unset the key to use a token."
    );
  }
  if (!inlineKey && !keyPath) {
    throw new Error(
      "GITHUB_APP_ID is set but no private key is: set GITHUB_APP_PRIVATE_KEY or " +
        "GITHUB_APP_PRIVATE_KEY_PATH, or unset GITHUB_APP_ID to use a token."
    );
  }
  if (inlineKey && keyPath) {
    throw new Error(
      "Both GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are set. Set " +
        "only one of them."
    );
  }

  if (inlineKey) {
    return {
      appId,
      privateKey: parsePrivateKey(inlineKey, "GITHUB_APP_PRIVATE_KEY"),
    };
  }

  let text: string;
  try {
    text = readFileSync(keyPath as string, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unreadable";
    throw new Error(
      `Could not read the GitHub App private key file named by ` +
        `GITHUB_APP_PRIVATE_KEY_PATH (${keyPath}): ${code}.`
    );
  }
  return {
    appId,
    privateKey: parsePrivateKey(
      text,
      `The file named by GITHUB_APP_PRIVATE_KEY_PATH (${keyPath})`
    ),
  };
}

export function createAppJwt(
  appId: string,
  privateKey: KeyObject,
  nowSeconds: number
): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: /^\d+$/.test(appId) ? Number(appId) : appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    privateKey
  ).toString("base64url");
  const jwt = `${signingInput}.${signature}`;
  rememberSecret(jwt);
  return jwt;
}

export function gitBasicAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  rememberSecret(encoded);
  return `AUTHORIZATION: basic ${encoded}`;
}

export function buildGitCredentialEnv(
  token: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const entries: Array<[string, string]> = [
    ["http.https://github.com/.extraheader", ""],
    ["http.https://github.com/.extraheader", gitBasicAuthHeader(token)],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  const result: Record<string, string> = {
    GIT_CONFIG_COUNT: String(start + entries.length),
  };
  entries.forEach(([key, value], offset) => {
    result[`GIT_CONFIG_KEY_${start + offset}`] = key;
    result[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  });
  return result;
}

export function buildGitIdentityEnv(
  identity: GitIdentity
): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export class GitHubAppAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(redactGitHubSecrets(message));
    this.name = "GitHubAppAuthError";
    this.status = status;
  }
}

export class GitHubAppAuth {
  readonly appId: string;
  readonly owner: string;
  readonly repo: string;
  private readonly privateKey: KeyObject;
  private readonly fetchImpl: FetchFn;
  private readonly now: () => number;
  private installationId: number | undefined;
  private current: InstallationToken | undefined;
  private pending: Promise<InstallationToken> | undefined;
  private app: Promise<GitHubAppInfo> | undefined;
  private identity: Promise<GitIdentity> | undefined;

  constructor(options: GitHubAppAuthOptions) {
    this.appId = options.config.appId;
    this.privateKey = options.config.privateKey;
    this.owner = options.owner;
    this.repo = options.repo;
    this.fetchImpl =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  get repository(): string {
    return `${this.owner}/${this.repo}`;
  }

  get installation(): number | undefined {
    return this.installationId;
  }

  async token(): Promise<string> {
    return (await this.installationToken()).token;
  }

  async installationToken(): Promise<InstallationToken> {
    const current = this.current;
    if (current && current.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      return current;
    }
    if (!this.pending) {
      this.pending = this.mintToken().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  async appInfo(): Promise<GitHubAppInfo> {
    if (!this.app) {
      this.app = this.request<GitHubAppInfo>(
        "GET",
        "/app",
        `Bearer ${this.jwt()}`,
        "reading the app"
      ).catch((error: unknown) => {
        this.app = undefined;
        throw error;
      });
    }
    return this.app;
  }

  async botIdentity(): Promise<GitIdentity> {
    if (!this.identity) {
      this.identity = this.lookUpBotIdentity().catch((error: unknown) => {
        this.identity = undefined;
        throw error;
      });
    }
    return this.identity;
  }

  private async lookUpBotIdentity(): Promise<GitIdentity> {
    const { slug } = await this.appInfo();
    const login = `${slug}[bot]`;
    const user = await this.request<{ id: number }>(
      "GET",
      `/users/${encodeURIComponent(login)}`,
      `token ${await this.token()}`,
      `looking up its bot user ${login}`
    );
    return {
      name: login,
      email: `${user.id}+${login}@users.noreply.github.com`,
    };
  }

  private jwt(): string {
    return createAppJwt(
      this.appId,
      this.privateKey,
      Math.floor(this.now() / 1000)
    );
  }

  private async mintToken(): Promise<InstallationToken> {
    const jwt = this.jwt();
    if (this.installationId === undefined) {
      const installation = await this.request<{ id: number }>(
        "GET",
        `/repos/${this.owner}/${this.repo}/installation`,
        `Bearer ${jwt}`,
        `looking up its installation on ${this.repository}`
      );
      this.installationId = installation.id;
    }
    const minted = await this.request<{
      token: string;
      expires_at: string;
      permissions?: Record<string, string>;
    }>(
      "POST",
      `/app/installations/${this.installationId}/access_tokens`,
      `Bearer ${jwt}`,
      `creating an installation token for ${this.repository}`,
      { repositories: [this.repo] }
    );
    rememberSecret(minted.token);
    const expiresAt = Date.parse(minted.expires_at);
    const token: InstallationToken = {
      token: minted.token,
      expiresAt: Number.isNaN(expiresAt) ? this.now() : expiresAt,
      permissions: minted.permissions ?? {},
    };
    this.current = token;
    return token;
  }

  private async request<T>(
    method: string,
    path: string,
    authorization: string,
    step: string,
    body?: object
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "release-management",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
    };
    if (body) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await this.fetchImpl(`${GITHUB_API_URL}${path}`, init);
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : "";
      throw new GitHubAppAuthError(
        `Could not reach GitHub while ${step} for GitHub App ${this.appId}: ` +
          `${error instanceof Error ? error.message : String(error)}${cause}`
      );
    }

    if (response.ok) return (await response.json()) as T;
    throw new GitHubAppAuthError(
      await this.describeFailure(response, step),
      response.status
    );
  }

  private async describeFailure(
    response: Response,
    step: string
  ): Promise<string> {
    let detail = "";
    try {
      const parsed = (await response.json()) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      detail = "";
    }
    const said = detail ? ` GitHub said: ${detail}` : "";
    const app = `GitHub App ${this.appId}`;

    switch (response.status) {
      case 401:
        return (
          `GitHub rejected the credentials of ${app} (401) while ${step}. Check ` +
          `that GITHUB_APP_ID is the app's ID or client ID, that the private key ` +
          `belongs to that app and has not been deleted, and that this machine's ` +
          `clock is correct.${said}`
        );
      case 404:
        if (step.startsWith("looking up its installation")) {
          return (
            `${app} is not installed on ${this.repository} (404). Install the ` +
            `app on that repository, or add the repository to the ` +
            `installation's selected repositories.`
          );
        }
        return `GitHub answered 404 while ${step} for ${app}.${said}`;
      case 403: {
        const needed = response.headers.get("x-accepted-github-permissions");
        const permission = needed
          ? ` It needs the permission ${needed}: grant it in the app's ` +
            `settings and approve the change on the installation.`
          : "";
        return `GitHub refused ${step} for ${app} (403).${permission}${said}`;
      }
      default:
        return `GitHub answered ${response.status} while ${step} for ${app}.${said}`;
    }
  }
}
