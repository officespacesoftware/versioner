/**
 * Pre-version checks: commands a repository asks to run before a version is cut,
 * declared in `.release-management.json` at its root:
 *
 *   {
 *     "checks": [
 *       {
 *         "name": "bundle-audit",
 *         "run": "bundle exec bundle-audit check --update",
 *         "on": ["create_release_candidate", "release_version"],
 *         "timeoutSeconds": 300
 *       }
 *     ]
 *   }
 *
 * The configuration is read from the commit that will be versioned, and each check
 * runs in a detached checkout of that commit, so it judges exactly what would be
 * tagged. A failing check becomes a warning on the plan: the approver decides
 * whether it matters, as with any other warning.
 */

import { exec } from "child_process";

import type { CheckOutput } from "./change-plan.js";

export const PRE_VERSION_CONFIG = ".release-management.json";

export const VERSION_ACTIONS = [
  "create_release_candidate",
  "increment_release_candidate",
  "release_version",
  "create_hotfix",
] as const;

export type VersionAction = (typeof VERSION_ACTIONS)[number];

export interface PreVersionCheck {
  name: string;
  run: string;
  on: VersionAction[];
  timeoutSeconds: number;
}

export interface PreVersionCheckResult {
  warnings: string[];
  checkOutput: CheckOutput[];
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4000;

/**
 * Parse the configuration, refusing anything ambiguous. A check without `on` runs
 * for every action that cuts a version.
 */
export function parsePreVersionConfig(text: string): PreVersionCheck[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the top level must be an object");
  }
  const checks = (parsed as { checks?: unknown }).checks ?? [];
  if (!Array.isArray(checks)) {
    throw new Error('"checks" must be an array');
  }

  return checks.map((raw, index) => {
    const where = `checks[${index}]`;
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${where} must be an object`);
    }
    const { name, run, on, timeoutSeconds } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`${where}.name must be a non-empty string`);
    }
    if (typeof run !== "string" || run.trim() === "") {
      throw new Error(`${where}.run must be a non-empty string`);
    }
    if (
      on !== undefined &&
      (!Array.isArray(on) ||
        !on.every((a) => (VERSION_ACTIONS as readonly unknown[]).includes(a)))
    ) {
      throw new Error(
        `${where}.on must list actions from: ${VERSION_ACTIONS.join(", ")}`
      );
    }
    if (
      timeoutSeconds !== undefined &&
      (typeof timeoutSeconds !== "number" ||
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0)
    ) {
      throw new Error(`${where}.timeoutSeconds must be a positive number`);
    }
    return {
      name: name.trim(),
      run,
      on: (on as VersionAction[] | undefined) ?? [...VERSION_ACTIONS],
      timeoutSeconds: (timeoutSeconds as number | undefined) ??
        DEFAULT_TIMEOUT_SECONDS,
    };
  });
}

function tail(output: string): string {
  const lines = output.trimEnd().split("\n");
  const kept = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  return kept.length > OUTPUT_TAIL_CHARS
    ? kept.slice(kept.length - OUTPUT_TAIL_CHARS)
    : kept;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number
): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        shell: "/bin/bash",
        timeout: timeoutSeconds * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter((s) => s.trim() !== "").join("\n");
        if (!error) {
          resolve({ exitCode: 0, timedOut: false, output });
          return;
        }
        const timedOut = error.killed === true && error.signal === "SIGTERM";
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolve({ exitCode, timedOut, output });
      }
    );
  });
}

/**
 * Run the checks configured for `action` against `commit`, describing failures as
 * warnings. Never throws: a check that could not run is itself reported, since a
 * check that quietly did not run reads as a pass.
 */
export async function runPreVersionChecks(opts: {
  action: VersionAction;
  ref: string;
  commit: string;
  readConfig: () => Promise<string | null>;
  withCheckout: <T>(
    commit: string,
    fn: (dir: string) => Promise<T>
  ) => Promise<T>;
}): Promise<PreVersionCheckResult> {
  const result: PreVersionCheckResult = { warnings: [], checkOutput: [] };
  const at = `${opts.ref} at ${opts.commit.slice(0, 11)}`;

  const text = await opts.readConfig();
  if (text === null) {
    return result;
  }

  let checks: PreVersionCheck[];
  try {
    checks = parsePreVersionConfig(text).filter((c) =>
      c.on.includes(opts.action)
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.warnings.push(
      `${PRE_VERSION_CONFIG} on ${at} is not valid (${msg}), so no ` +
        `pre-version checks ran.`
    );
    return result;
  }
  if (checks.length === 0) {
    return result;
  }

  try {
    await opts.withCheckout(opts.commit, async (dir) => {
      for (const check of checks) {
        const run = await runCommand(check.run, dir, check.timeoutSeconds);
        if (run.exitCode === 0) {
          continue;
        }
        result.warnings.push(
          run.timedOut
            ? `Pre-version check "${check.name}" did not finish within ` +
                `${check.timeoutSeconds}s on ${at}.`
            : `Pre-version check "${check.name}" failed on ${at} ` +
                `(exit ${run.exitCode}). Its output is at the end of the plan.`
        );
        if (run.output.trim() !== "") {
          result.checkOutput.push({ name: check.name, output: tail(run.output) });
        }
      }
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.warnings.push(
      `Could not run the pre-version checks on ${at}: ${msg}`
    );
  }

  return result;
}
