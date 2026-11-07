/**
 * Pipeline trigger: a command a repository runs to start its CI pipeline on a
 * release or hotfix branch that has no open pull request, declared in the
 * `pipeline` section of `.release-management.json`:
 *
 *   {
 *     "pipeline": {
 *       "trigger": "scripts/start-pipeline.sh",
 *       "timeoutSeconds": 120
 *     }
 *   }
 *
 * Some CI setups build a branch only while it has an open pull request. Each
 * versioning action opens one, but once it is merged or closed a later push builds
 * nothing. Starting a pipeline while a pull request is open would cancel that pull
 * request's own build, so the trigger runs only when the branch heads none.
 *
 * Runs after the push, against the pushed commit, and never throws: the version is
 * already on origin, so a trigger that fails is a warning to start the build by
 * hand, not a reason to undo anything.
 */

import {
  PRE_VERSION_CONFIG,
  outputTail,
  parsePipelineConfig,
  runShellCommand,
  type PipelineConfig,
  type VersionAction,
} from "./pre-version-checks.js";

export type PipelineAction = VersionAction | "revert_version";

export interface PipelineTriggerResult {
  /**
   * `started` when the trigger ran and exited 0, `skipped` when the branch has an
   * open pull request, `failed` when no pipeline may have been started.
   */
  status: "started" | "skipped" | "failed";
  message: string;
  /** The tail of what the trigger printed, when it ran and printed anything. */
  output?: string;
}

export interface OpenPullRequestRef {
  number: number;
}

type ConfigRead =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "valid"; config: PipelineConfig };

async function readPipelineConfig(
  readConfig: () => Promise<string | null>
): Promise<ConfigRead> {
  const text = await readConfig();
  if (text === null) {
    return { kind: "absent" };
  }
  try {
    const config = parsePipelineConfig(text);
    return config === null ? { kind: "absent" } : { kind: "valid", config };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", message };
  }
}

export async function hasValidPipelineTrigger(
  readConfig: () => Promise<string | null>
): Promise<boolean> {
  try {
    return (await readPipelineConfig(readConfig)).kind === "valid";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a plan says about the trigger: a warning when its configuration is
 * invalid, and a line when the branch is expected to have no open pull request
 * after the apply. That line depends on pull requests to any base, which change
 * without the repository moving, so the caller keeps it out of the digest; the
 * apply checks again after the push either way.
 */
export async function describePipelineTrigger(opts: {
  branch: string;
  ref: string;
  commit: string;
  readConfig: () => Promise<string | null>;
  /** True when the action itself opens or updates a pull request on the branch. */
  branchWillHavePullRequest: boolean;
  findOpenPullRequests: () => Promise<OpenPullRequestRef[]>;
}): Promise<{ warnings: string[]; pipelineTrigger?: string }> {
  const read = await readPipelineConfig(opts.readConfig);
  if (read.kind === "absent") {
    return { warnings: [] };
  }
  if (read.kind === "invalid") {
    return {
      warnings: [
        `${PRE_VERSION_CONFIG} on ${opts.ref} at ${opts.commit.slice(0, 11)} is ` +
          `not valid (${read.message}), so the pipeline trigger cannot run. If ` +
          `${opts.branch} has no open pull request after the push, start its ` +
          `build by hand.`,
      ],
    };
  }
  if (opts.branchWillHavePullRequest) {
    return { warnings: [] };
  }
  const open = await opts.findOpenPullRequests();
  if (open.length > 0) {
    return { warnings: [] };
  }
  return {
    warnings: [],
    pipelineTrigger:
      `Would start the pipeline for ${opts.branch}: it has no open pull ` +
      `request. Checked again after the push.`,
  };
}

/**
 * After an action has pushed `commit` to `branch`, start the repository's pipeline
 * when the branch heads no open pull request. Undefined when the repository
 * configures no trigger, or configures an invalid one while a pull request is
 * open, since nothing would have run either way.
 */
export async function triggerPipelineWithoutPullRequest(opts: {
  action: PipelineAction;
  branch: string;
  version: string;
  commit: string;
  readConfig: () => Promise<string | null>;
  findOpenPullRequests: () => Promise<OpenPullRequestRef[]>;
  withCheckout: <T>(
    commit: string,
    fn: (dir: string) => Promise<T>
  ) => Promise<T>;
}): Promise<PipelineTriggerResult | undefined> {
  const { branch } = opts;
  const byHand = `Start the build for ${branch} by hand.`;

  let read: ConfigRead;
  try {
    read = await readPipelineConfig(opts.readConfig);
  } catch (error) {
    return {
      status: "failed",
      message:
        `Could not read ${PRE_VERSION_CONFIG} at ${opts.commit.slice(0, 11)} ` +
        `(${errorMessage(error)}), so the pipeline trigger did not run. ` +
        `If ${branch} has no open pull request, start its build by hand.`,
    };
  }
  if (read.kind === "absent") {
    return undefined;
  }

  let open: OpenPullRequestRef[];
  try {
    open = await opts.findOpenPullRequests();
  } catch (error) {
    return {
      status: "failed",
      message:
        `Could not check whether ${branch} has an open pull request ` +
        `(${errorMessage(error)}), so the pipeline was not started. If no ` +
        `build started, start it by hand.`,
    };
  }

  const first = open[0];
  if (first) {
    if (read.kind === "invalid") {
      return undefined;
    }
    return {
      status: "skipped",
      message:
        `Did not start the pipeline for ${branch}: PR #${first.number} is ` +
        `open, so its own build runs on the push.`,
    };
  }

  if (read.kind === "invalid") {
    return {
      status: "failed",
      message:
        `${PRE_VERSION_CONFIG} at ${opts.commit.slice(0, 11)} is not valid ` +
        `(${read.message}), so the pipeline for ${branch} was not started, and ` +
        `it has no open pull request. ${byHand}`,
    };
  }

  const { config } = read;
  try {
    const run = await opts.withCheckout(opts.commit, (dir) =>
      runShellCommand(config.trigger, dir, config.timeoutSeconds, {
        RELEASE_BRANCH: branch,
        RELEASE_VERSION: opts.version,
        RELEASE_ACTION: opts.action,
      })
    );
    const output =
      run.output.trim() === "" ? {} : { output: outputTail(run.output) };
    if (run.exitCode === 0) {
      return {
        status: "started",
        message: `Started the pipeline for ${branch}: it has no open pull request.`,
        ...output,
      };
    }
    return {
      status: "failed",
      message: run.timedOut
        ? `The pipeline trigger for ${branch} did not finish within ` +
          `${config.timeoutSeconds}s. Check whether a build started, and ` +
          `start it by hand if not.`
        : `The pipeline trigger for ${branch} failed (exit ${run.exitCode}), ` +
          `and ${branch} has no open pull request. ${byHand}`,
      ...output,
    };
  } catch (error) {
    return {
      status: "failed",
      message:
        `Could not run the pipeline trigger for ${branch}: ` +
        `${errorMessage(error)}. ${byHand}`,
    };
  }
}
