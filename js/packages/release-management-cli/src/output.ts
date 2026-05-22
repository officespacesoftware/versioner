import { appendFileSync } from "fs";

export interface GlobalOptions {
  json: boolean;
  quiet: boolean;
}

/**
 * Emit a result to stdout.
 *
 * - `json` mode: serializes the result as JSON (one line).
 * - default: passes the result through a render function that returns a
 *   human-friendly string.
 */
export function emit<T>(
  result: T,
  opts: GlobalOptions,
  render: (r: T) => string
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(render(result) + "\n");
  }
}

/**
 * Append key=value pairs to $GITHUB_OUTPUT when set (no-op otherwise).
 *
 * Single-line values use the inline `key=value` form. Multi-line values
 * use the heredoc form per the GH Actions spec.
 */
export function writeGithubOutput(kv: Record<string, string | undefined>): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;

  const lines: string[] = [];
  for (const [key, raw] of Object.entries(kv)) {
    if (raw === undefined) continue;
    const value = String(raw);
    if (value.includes("\n")) {
      const delimiter = `RELEASE_MGMT_EOF_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      lines.push(`${key}<<${delimiter}`);
      lines.push(value);
      lines.push(delimiter);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  if (lines.length === 0) return;
  appendFileSync(path, lines.join("\n") + "\n", "utf-8");
}
