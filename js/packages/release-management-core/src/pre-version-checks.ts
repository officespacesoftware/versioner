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
 *
 * The same file holds the pipeline trigger, a `pipeline` section read by
 * pipeline-trigger.ts.
 */

import { exec } from "child_process";

import type { CheckOutput, CheckRun } from "./change-plan.js";

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

export interface PipelineConfig {
  trigger: string;
  timeoutSeconds: number;
}

export interface PreVersionCheckResult {
  warnings: string[];
  checkOutput: CheckOutput[];
  checks: CheckRun[];
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_PIPELINE_TIMEOUT_SECONDS = 120;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4000;

/**
 * Parse the configuration, refusing anything ambiguous. A check without `on` runs
 * for every action that cuts a version.
 */
export function parsePreVersionConfig(text: string): PreVersionCheck[] {
  const checks = parseConfigObject(text)["checks"] ?? [];
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
    if (timeoutSeconds !== undefined && !isPositiveNumber(timeoutSeconds)) {
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

function parseConfigObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the top level must be an object");
  }
  return parsed as Record<string, unknown>;
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Parse the `pipeline` section, or null when there is none. Throws on anything
 * ambiguous, as the checks do.
 */
export function parsePipelineConfig(text: string): PipelineConfig | null {
  const pipeline = parseConfigObject(text)["pipeline"];
  if (pipeline === undefined) {
    return null;
  }
  if (
    typeof pipeline !== "object" ||
    pipeline === null ||
    Array.isArray(pipeline)
  ) {
    throw new Error('"pipeline" must be an object');
  }
  const { trigger, timeoutSeconds } = pipeline as Record<string, unknown>;
  if (typeof trigger !== "string" || trigger.trim() === "") {
    throw new Error("pipeline.trigger must be a non-empty string");
  }
  if (timeoutSeconds !== undefined && !isPositiveNumber(timeoutSeconds)) {
    throw new Error("pipeline.timeoutSeconds must be a positive number");
  }
  return {
    trigger,
    timeoutSeconds: (timeoutSeconds as number | undefined) ??
      DEFAULT_PIPELINE_TIMEOUT_SECONDS,
  };
}

export function outputTail(output: string): string {
  const lines = output.trimEnd().split("\n");
  const kept = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  return kept.length > OUTPUT_TAIL_CHARS
    ? kept.slice(kept.length - OUTPUT_TAIL_CHARS)
    : kept;
}

/**
 * Run `command` with bash in `cwd`. `env` is added to the inherited environment,
 * never replacing it.
 */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        shell: "/bin/bash",
        timeout: timeoutSeconds * 1000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...env },
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

const COMMAND_NOT_FOUND = 127;
const COMMAND_NOT_EXECUTABLE = 126;

/**
 * Bash exits 127 when the command is not found and 126 when it cannot be
 * executed. Neither means the check found a problem: it never ran.
 */
function describeFailedCheck(
  check: PreVersionCheck,
  at: string,
  run: { exitCode: number; timedOut: boolean }
): string {
  if (run.timedOut) {
    return (
      `Pre-version check "${check.name}" did not finish within ` +
      `${check.timeoutSeconds}s on ${at}.`
    );
  }
  if (
    run.exitCode === COMMAND_NOT_FOUND ||
    run.exitCode === COMMAND_NOT_EXECUTABLE
  ) {
    return (
      `Pre-version check "${check.name}" could not run on ${at} ` +
      `(exit ${run.exitCode}: its command was not found or is not ` +
      `executable), so it checked nothing. Its output is at the end of ` +
      `the plan.`
    );
  }
  return (
    `Pre-version check "${check.name}" failed on ${at} ` +
    `(exit ${run.exitCode}). Its output is at the end of the plan.`
  );
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
  const result: PreVersionCheckResult = {
    warnings: [],
    checkOutput: [],
    checks: [],
  };
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
        const started = Date.now();
        const run = await runShellCommand(check.run, dir, check.timeoutSeconds);
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        const tail = run.output.trim() === "" ? undefined : outputTail(run.output);
        result.checks.push({
          name: check.name,
          status:
            run.exitCode === 0 ? "passed" : run.timedOut ? "timeout" : "failed",
          exitCode: run.exitCode,
          seconds,
          ref: opts.ref,
          sha: opts.commit,
          ...(run.exitCode === 0 || tail === undefined ? {} : { output: tail }),
        });
        if (run.exitCode === 0) {
          continue;
        }
        result.warnings.push(describeFailedCheck(check, at, run));
        if (tail !== undefined) {
          result.checkOutput.push({ name: check.name, output: tail });
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
