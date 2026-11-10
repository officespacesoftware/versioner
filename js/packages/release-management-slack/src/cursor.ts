/**
 * The slice of Cursor's Cloud Agents API (v1) the app uses: start an agent,
 * send it a follow-up, read a run, and read the files it left as artifacts.
 */

const API = "https://api.cursor.com";

export interface AgentRun {
  agentId: string;
  runId: string;
}

export interface RunState {
  status: string;
  result: string | undefined;
  createdAt?: string;
  updatedAt?: string;
}

export interface Artifact {
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export const MAX_ARTIFACT_BYTES = 1_000_000;

const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function agentUrl(agentId: string): string {
  return `https://cursor.com/agents/${agentId}`;
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(message);
  }
}

const overCap = (size: number, max: number): Error =>
  new Error(`Artifact is ${size} bytes, over ${max}`);

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) {
    throw overCap(declared, max);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await reader.read(); !chunk.done; ) {
    total += chunk.value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw overCap(total, max);
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const artifactOf = (v: unknown): Artifact | undefined => {
  const o = (v ?? {}) as Record<string, unknown>;
  return typeof o.path === "string" && typeof o.updatedAt === "string"
    ? {
        path: o.path,
        sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : 0,
        updatedAt: o.updatedAt,
      }
    : undefined;
};

export interface CursorTarget {
  repos: string[];
  envName: string | undefined;
  model: string | undefined;
}

export class CursorClient {
  constructor(
    private readonly apiKey: string,
    private readonly target: CursorTarget,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async api(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok) {
      const code = typeof json.code === "string" ? json.code : undefined;
      const message =
        typeof json.message === "string" ? json.message : text.slice(0, 300);
      throw new CursorApiError(
        `Cursor ${method} ${path} failed (${res.status}): ${message}`,
        res.status,
        code
      );
    }
    return json;
  }

  private static runOf(res: Record<string, unknown>): string {
    const run = res.run as { id?: unknown } | undefined;
    const agent = res.agent as { latestRunId?: unknown } | undefined;
    const id = run?.id ?? agent?.latestRunId ?? res.id;
    if (typeof id !== "string") {
      throw new Error("Cursor did not return a run id");
    }
    return id;
  }

  async launch(name: string, prompt: string): Promise<AgentRun> {
    const res = await this.api("POST", "/v1/agents", {
      name,
      prompt: { text: prompt },
      ...(this.target.envName
        ? { env: { type: "cloud", name: this.target.envName } }
        : { repos: this.target.repos.map((url) => ({ url })) }),
      ...(this.target.model ? { model: { id: this.target.model } } : {}),
    });
    const agentId = (res.agent as { id?: unknown } | undefined)?.id;
    if (typeof agentId !== "string") {
      throw new Error("Cursor did not return an agent id");
    }
    return { agentId, runId: CursorClient.runOf(res) };
  }

  async followUp(agentId: string, prompt: string): Promise<AgentRun> {
    const res = await this.api("POST", `/v1/agents/${agentId}/runs`, {
      prompt: { text: prompt },
    });
    return { agentId, runId: CursorClient.runOf(res) };
  }

  async latestRun(agentId: string): Promise<string | undefined> {
    const res = await this.api("GET", `/v1/agents/${agentId}`);
    return typeof res.latestRunId === "string" ? res.latestRunId : undefined;
  }

  async getRun({ agentId, runId }: AgentRun): Promise<RunState> {
    const res = await this.api("GET", `/v1/agents/${agentId}/runs/${runId}`);
    return {
      status: String(res.status),
      result: typeof res.result === "string" ? res.result : undefined,
      ...(typeof res.createdAt === "string"
        ? { createdAt: res.createdAt }
        : {}),
      ...(typeof res.updatedAt === "string"
        ? { updatedAt: res.updatedAt }
        : {}),
    };
  }

  async listArtifacts(agentId: string): Promise<Artifact[]> {
    const res = await this.api("GET", `/v1/agents/${agentId}/artifacts`);
    const items = Array.isArray(res.items) ? res.items : [];
    return items.flatMap((item) => artifactOf(item) ?? []);
  }

  async downloadArtifact(
    agentId: string,
    path: string,
    max = MAX_ARTIFACT_BYTES
  ): Promise<string> {
    const query = new URLSearchParams({ path });
    const res = await this.api(
      "GET",
      `/v1/agents/${agentId}/artifacts/download?${query}`
    );
    const url = typeof res.url === "string" ? res.url : "";
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
      throw new Error(`Cursor returned no https URL for ${path}`);
    }
    const file = await this.fetchFn(url);
    if (!file.ok) {
      throw new Error(`Artifact ${path} download failed (${file.status})`);
    }
    return readCapped(file, max);
  }
}
