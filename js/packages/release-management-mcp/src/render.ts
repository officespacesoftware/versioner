import {
  renderManualDownmerge,
  type IncrementRCWorkflowContext,
  type PipelineTriggerResult,
} from "@officespacesoftware/release-management-core";

export function renderPipelineTrigger(
  result: PipelineTriggerResult | undefined
): string {
  if (!result) {
    return "";
  }
  const icon = result.status === "failed" ? "⚠️ " : "🔧";
  const lines = [`${icon} Pipeline: ${result.message}`];
  if (result.output !== undefined) {
    lines.push(
      "Output of the pipeline trigger:",
      ...result.output.split("\n").map((line) => `  ${line}`)
    );
  }
  return `\n${lines.join("\n")}\n`;
}

export function renderIncrementResult(opts: {
  result: IncrementRCWorkflowContext;
  workingDirectory: string;
  dryRun: boolean;
  progressSummary: string;
}): string {
  const { result, workingDirectory, dryRun, progressSummary } = opts;
  const handoff = result.manualDownmerge
    ? `\n⚠️  ${renderManualDownmerge(result.manualDownmerge)}\n`
    : "";

  return `🚀 Increment Release Candidate Workflow ${
    dryRun ? "(Dry Run) " : ""
  }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Branch Type: ${result.branchType.toUpperCase()}
🎯 Selected Branch: ${result.branchInfo.name}

📋 Workflow Progress:
${progressSummary}

${result.targetVersion ? `🎯 New Version: ${result.targetVersion.version}` : ""}
${
  result.pullRequestUrl
    ? `🔗 ${
        result.pullRequestAction === "updated" ? "Updated PR" : "Pull Request"
      }: ${result.pullRequestUrl}`
    : ""
}
${
  result.pullRequestError ? `⚠️  PR step failed: ${result.pullRequestError}` : ""
}${handoff}${renderPipelineTrigger(result.pipelineTrigger)}

✅ All steps completed successfully.`;
}
