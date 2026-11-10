/**
 * The MCP writes each tool call's structuredContent to a file under
 * artifacts/release-management/, named by when it was called. The app reads
 * the run's file instead of trusting the agent to copy it into its reply.
 */

import type { AgentRun, Artifact, CursorClient, RunState } from "./cursor.js";

export type ArtifactReader = Pick<
  CursorClient,
  "listArtifacts" | "downloadArtifact"
>;

const NAME =
  /^artifacts\/release-management\/(\d{8}T\d{9}Z)-\d+-([a-z_]+)\.json$/;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

interface Written {
  path: string;
  tool: string;
  calledAt: number;
  updatedAt: number;
}

function writtenOf(artifact: Artifact): Written | undefined {
  const m = NAME.exec(artifact.path);
  if (!m) {
    return undefined;
  }
  const [, stamp = "", tool = ""] = m;
  return {
    path: artifact.path,
    tool,
    calledAt: Date.parse(stamp.replace(STAMP, "$1-$2-$3T$4:$5:$6.$7Z")),
    updatedAt: Date.parse(artifact.updatedAt),
  };
}

const forTool = (written: Written, tool: string): boolean =>
  written.tool === tool || written.tool.startsWith(`${tool}_`);

/**
 * The structured output of a run: the newest file written since the run
 * started and called before it ended, of the tool the reply names if any.
 */
export function pickArtifact(
  artifacts: Artifact[],
  run: Pick<RunState, "createdAt" | "updatedAt">,
  tool: string
): string | undefined {
  const start = Date.parse(run.createdAt ?? "");
  const end = Date.parse(run.updatedAt ?? "");
  if (Number.isNaN(start)) {
    return undefined;
  }
  const ours = artifacts
    .flatMap((a) => writtenOf(a) ?? [])
    .filter(
      (w) =>
        w.updatedAt >= start && (Number.isNaN(end) || w.calledAt <= end)
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const named = tool ? ours.filter((w) => forTool(w, tool)) : [];
  return (named.length > 0 ? named : ours).at(-1)?.path;
}

/** The parsed structured output of a run, or undefined on any failure. */
export async function structuredOfRun(
  cursor: ArtifactReader,
  run: AgentRun,
  state: RunState,
  tool: string,
  log?: (message: string, error: unknown) => void
): Promise<unknown> {
  try {
    const artifacts = await cursor.listArtifacts(run.agentId);
    const path = pickArtifact(artifacts, state, tool);
    return path === undefined
      ? undefined
      : JSON.parse(await cursor.downloadArtifact(run.agentId, path));
  } catch (error) {
    log?.("Cursor artifact read failed", error);
    return undefined;
  }
}
