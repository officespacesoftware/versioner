/**
 * The plan/confirm protocol, as the CLI presents it.
 *
 * Mirrors the MCP: a mutating command first describes what it would do and
 * stops. It applies only when the caller hands back the digest of a plan it has
 * seen (`--confirm`) or explicitly waives review (`--yes`). Passing none of the
 * three plans — the default can never mutate the repository.
 */

import {
  assertPlanIsCurrent,
  ensureGitRepository,
  ensureNoStagedChanges,
  ensureVersionerAvailable,
  renderChangePlan,
  StalePlanError,
  type ChangePlan,
  type ReleaseAgent,
} from "@officespacesoftware/release-management-core";
import { UsageError } from "./errors.js";
import { emit, writeGithubOutput } from "./output.js";
import {
  createGitFlowManager,
  createReleaseAgent,
  runCommand,
  type BaseOptions,
} from "./run.js";

export interface PlanFlags {
  plan?: boolean | undefined;
  confirm?: string | undefined;
  yes?: boolean | undefined;
}

export type PlanMode =
  /** `requested` distinguishes an explicit `--plan` from the safe default. */
  | { kind: "plan"; requested: boolean }
  | { kind: "confirm"; digest: string }
  | { kind: "apply" };

export function resolvePlanMode(flags: PlanFlags): PlanMode {
  const wantsPlan = flags.plan === true;
  const wantsApply = flags.yes === true;
  const confirm = flags.confirm;

  if (wantsPlan && (confirm !== undefined || wantsApply)) {
    const other = confirm !== undefined ? "--confirm" : "--yes";
    throw new UsageError(
      `--plan cannot be combined with ${other}. --plan only describes the change; ` +
        `${other} applies it. Pass one or the other.`
    );
  }
  if (confirm !== undefined && wantsApply) {
    throw new UsageError(
      "--confirm cannot be combined with --yes. --confirm applies the plan you " +
        "reviewed; --yes applies without review. Pass one or the other."
    );
  }
  if (confirm !== undefined) {
    const digest = confirm.trim();
    if (digest === "") {
      throw new UsageError(
        "--confirm needs the plan digest printed by --plan (for example --confirm 3f2a1b0c9d8e)."
      );
    }
    return { kind: "confirm", digest };
  }
  if (wantsApply) {
    return { kind: "apply" };
  }
  return { kind: "plan", requested: wantsPlan };
}

type PlanOutcome<T> =
  | { applied: false; plan: ChangePlan; requested: boolean }
  | { applied: true; result: T };

/**
 * Run a command that supports planning: shared repository guards, then either
 * print the plan or apply it, depending on the flags.
 */
export async function runPlanAwareCommand<T>(params: {
  /** Subcommand name, used in the "how to apply" instructions. */
  commandName: string;
  opts: BaseOptions;
  flags: PlanFlags;
  buildPlan: (agent: ReleaseAgent) => Promise<ChangePlan>;
  execute: (agent: ReleaseAgent) => Promise<T>;
  onExecuted: (result: T) => void;
}): Promise<never> {
  const { commandName, opts, flags } = params;

  return runCommand<PlanOutcome<T>>(
    async () => {
      // Resolved before anything touches git so a bad flag combination costs nothing.
      const mode = resolvePlanMode(flags);

      const gfm = createGitFlowManager(opts);
      await ensureGitRepository(gfm, opts.workingDirectory);
      await ensureNoStagedChanges(gfm);
      const agent = await createReleaseAgent(gfm, opts);
      ensureVersionerAvailable(agent);

      const plan = await params.buildPlan(agent);

      if (mode.kind === "plan") {
        return { applied: false, plan, requested: mode.requested };
      }
      if (mode.kind === "confirm") {
        assertPlanIsCurrent(plan, mode.digest);
      } else if (!opts.quiet) {
        // --yes waives review, so the plan still goes to the log as a record of intent.
        process.stderr.write(`${renderChangePlan(plan)}\n\n`);
      }

      return { applied: true, result: await params.execute(agent) };
    },
    (outcome) => {
      if (outcome.applied) {
        params.onExecuted(outcome.result);
        return;
      }
      writeGithubOutput({ plan_digest: outcome.plan.digest });
      const hint = renderApplyHint(commandName, outcome.plan, outcome.requested);
      emit(outcome.plan, opts, (plan) => `${renderChangePlan(plan)}\n\n${hint}`);
      if (opts.json && !opts.quiet) {
        // stdout belongs to the JSON document; the instructions go to the log.
        process.stderr.write(`${hint}\n`);
      }
    },
    (error) =>
      error instanceof StalePlanError
        ? renderStalePlan(error, commandName)
        : undefined
  );
}

function renderApplyHint(
  commandName: string,
  plan: ChangePlan,
  requested: boolean
): string {
  const lines: string[] = [];
  if (!requested) {
    lines.push(
      "Nothing was changed: none of --plan, --confirm or --yes was given, so this planned only."
    );
  }
  lines.push(
    `To apply, re-run with the same options plus: release-management ${commandName} --confirm ${plan.digest}`,
    `For automation that cannot round-trip a digest, use --yes instead.`
  );
  return lines.join("\n");
}

/** Report a refused apply, showing what the repository looks like now. */
function renderStalePlan(error: StalePlanError, commandName: string): string {
  return [
    `Error: ${error.message}`,
    "",
    "Nothing was changed. The current plan is:",
    "",
    renderChangePlan(error.plan),
    "",
    `To apply this plan instead: release-management ${commandName} --confirm ${error.plan.digest}`,
  ].join("\n");
}
