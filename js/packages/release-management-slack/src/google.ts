/**
 * Google Cloud without client libraries: an access token from the metadata
 * server, Cloud Tasks over REST, and verification of the ID tokens Cloud Tasks
 * signs its calls with.
 */

import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const CERTS_TTL_MS = 60 * 60 * 1000;

export function metadataTokenSource(
  fetchFn: typeof fetch = fetch
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const res = await fetchFn(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok) {
      throw new Error(`Metadata server returned ${res.status}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    cached = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return cached.token;
  };
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

export interface IdTokenExpectation {
  audience: string;
  email: string;
}

/**
 * Verify a Google-signed ID token (RS256) for the given audience and service
 * account. Returns false for anything that does not check out.
 */
export function idTokenVerifier(
  fetchFn: typeof fetch = fetch
): (token: string, expected: IdTokenExpectation) => Promise<boolean> {
  let certs: { keys: Jwk[]; fetchedAt: number } | undefined;

  const keyFor = async (kid: string): Promise<Jwk | undefined> => {
    const fresh = certs && Date.now() - certs.fetchedAt < CERTS_TTL_MS;
    let key = fresh ? certs?.keys.find((k) => k.kid === kid) : undefined;
    if (!key) {
      const res = await fetchFn(GOOGLE_CERTS_URL);
      if (!res.ok) {
        return undefined;
      }
      certs = {
        keys: ((await res.json()) as { keys: Jwk[] }).keys,
        fetchedAt: Date.now(),
      };
      key = certs.keys.find((k) => k.kid === kid);
    }
    return key;
  };

  return async (token, expected) => {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return false;
    }
    const [rawHeader, rawPayload, rawSignature] = parts as [
      string,
      string,
      string,
    ];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(rawHeader, "base64url").toString());
      claims = JSON.parse(Buffer.from(rawPayload, "base64url").toString());
    } catch {
      return false;
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return false;
    }
    const jwk = await keyFor(header.kid);
    if (!jwk) {
      return false;
    }
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${rawHeader}.${rawPayload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(rawSignature, "base64url")
    );
    return (
      signed &&
      GOOGLE_ISSUERS.has(String(claims.iss)) &&
      claims.aud === expected.audience &&
      claims.email === expected.email &&
      claims.email_verified === true &&
      typeof claims.exp === "number" &&
      claims.exp > Date.now() / 1000
    );
  };
}

export interface EnqueueOptions {
  delaySeconds?: number;
  /** A task name; Cloud Tasks refuses a second task with the same name. */
  name?: string;
}

export interface TaskQueue {
  enqueue(payload: unknown, options?: EnqueueOptions): Promise<boolean>;
}

export class CloudTasksQueue implements TaskQueue {
  constructor(
    private readonly settings: {
      queue: string;
      url: string;
      audience: string;
      serviceAccount: string;
    },
    private readonly accessToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async enqueue(
    payload: unknown,
    options: EnqueueOptions = {}
  ): Promise<boolean> {
    const { queue, url, audience, serviceAccount } = this.settings;
    const task = {
      ...(options.name ? { name: `${queue}/tasks/${options.name}` } : {}),
      ...(options.delaySeconds
        ? {
            scheduleTime: new Date(
              Date.now() + options.delaySeconds * 1000
            ).toISOString(),
          }
        : {}),
      httpRequest: {
        httpMethod: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: { serviceAccountEmail: serviceAccount, audience },
      },
    };
    const res = await this.fetchFn(
      `https://cloudtasks.googleapis.com/v2/${queue}/tasks`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ task }),
      }
    );
    if (res.status === 409) {
      return false;
    }
    if (!res.ok) {
      throw new Error(
        `Cloud Tasks returned ${res.status}: ${(await res.text()).slice(0, 300)}`
      );
    }
    return true;
  }
}
