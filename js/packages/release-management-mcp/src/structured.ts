import {
  codedMessage,
  messageCode,
  mutationOperation,
  renderManualDownmerge,
  type ChangePlan,
  type CheckOutput,
  type CheckRun,
  type CodedMessage,
  type DecisionOption,
  type DownmergeResult,
  type DownmergeRoute,
  type DownmergeSource,
  type DownmergeTarget,
  type GitHubAuthStatus,
  type HotfixWorkflowContext,
  type IncrementConflict,
  type IncrementRCWorkflowContext,
  type ManualDownmerge,
  type MutationKind,
  type MutationOperation,
  type MutationRef,
  type PipelineTriggerResult,
  type PlanReview,
  type ReleaseVersionWorkflowContext,
  type ReleaseWorkflowContext,
  type RevertVersionWorkflowContext,
  type VersionListing,
  type VersionKind,
  type WorkflowStep,
} from "@officespacesoftware/release-management-core";

export type { CodedMessage };

export type PlanTool =
  | "create_release_candidate"
  | "create_hotfix"
  | "increment_release_candidate"
  | "release_version"
  | "revert_version";

export type ToolName =
  | PlanTool
  | "health_check"
  | "initialize_versioner"
  | "downmerge"
  | "list_versions";

export interface StructuredMutation {
  kind: MutationKind;
  operation: MutationOperation;
  summary: string;
  detail?: Record<string, string>;
  ref?: MutationRef;
}

export interface StructuredPlan {
  action: string;
  targetBranch: string;
  targetBranchHead: string;
  currentVersion?: string;
  resultingVersion?: string;
  shape?: "revert" | "abandon";
  mutations: StructuredMutation[];
  warnings: CodedMessage[];
  notices: CodedMessage[];
  mergePreview?: CodedMessage;
  pipelineTrigger?: CodedMessage;
  checks: CheckRun[];
  checkOutput: CheckOutput[];
  review?: PlanReview;
  digest: string;
}

export interface StructuredHandoff {
  code: "H1" | "H2";
  text: string;
  source: DownmergeSource;
  target: DownmergeTarget;
  requiresDecision: boolean;
  sourceBranch: string;
  version?: string;
  conflictedFiles: string[];
  resolutionBranch: string;
  resolutionBase: string;
  title: string;
  steps: string[];
  options: DecisionOption[];
  increment?: IncrementConflict;
}

export interface AppliedPullRequest {
  number?: number;
  url?: string;
  head: string;
  base: string;
  title?: string;
  change: "opened" | "updated" | "closed" | "superseded" | "alreadyOpen";
  draft?: boolean;
}

export interface PipelineOutcome {
  status: "started" | "skipped" | "failed";
  code?: string;
  message: string;
  output?: string;
}

export interface AppliedResult {
  dryRun: boolean;
  branch?: {
    name: string;
    change: "created" | "existing" | "updated" | "deleted";
    base?: string;
  };
  from?: string;
  to?: string;
  shape?: "revert" | "abandon";
  resumed?: boolean;
  tag?: {
    name: string;
    change: "created" | "existing" | "deleted" | "absent";
    deletedLocally?: boolean;
    deletedOnOrigin?: boolean;
  };
  githubRelease?: {
    tag: string;
    change: "created" | "deleted";
    url?: string;
  };
  route?: DownmergeRoute;
  mergeBranch?: string;
  pullRequests: AppliedPullRequest[];
  pipeline?: PipelineOutcome;
  manualDownmerge?: StructuredHandoff;
  warnings: CodedMessage[];
  notices: CodedMessage[];
  problems: CodedMessage[];
  steps: WorkflowStep[];
  nextSteps: string[];
}

export interface PlanOutput {
  kind: "plan";
  tool: PlanTool;
  plan: StructuredPlan;
}

export interface StaleOutput {
  kind: "stale";
  tool: PlanTool;
  code: "D1";
  text: string;
  provided: string;
  plan: StructuredPlan;
}

export interface AppliedOutput {
  kind: "applied";
  tool: PlanTool | "downmerge";
  result: AppliedResult;
}

export interface HandoffOutput {
  kind: "handoff";
  tool: "downmerge";
  handoff: StructuredHandoff;
}

export interface RefusedOutput {
  kind: "refused";
  tool: ToolName;
  code?: string;
  text: string;
}

export interface FailedOutput {
  kind: "failed";
  tool: ToolName;
  code?: string;
  text: string;
  steps: WorkflowStep[];
}

export interface VersionRow {
  branch: string;
  type: "release" | "hotfix";
  version: string | null;
  kind: VersionKind;
  current: boolean;
  tag: "remote" | "local-only" | "none";
  mergedIntoProduction: boolean;
  staleLocal: boolean;
}

export interface VersionsOutput {
  kind: "versions";
  tool: "list_versions";
  workingDirectory: string;
  currentBranch: string;
  productionBranch: string;
  entries: VersionRow[];
  candidates: number;
}

export interface HealthOutput {
  kind: "health";
  tool: "health_check";
  server: string;
  version: string;
  build: { commit: string; time: string };
  status: string;
  timestamp: string;
  auth: GitHubAuthStatus;
  capabilities: string[];
}

export interface InitializedOutput {
  kind: "initialized";
  tool: "initialize_versioner";
  workingDirectory: string;
  version: string;
  isReleaseCandidate: boolean;
}

export type PlanToolOutput =
  | PlanOutput
  | StaleOutput
  | AppliedOutput
  | RefusedOutput
  | FailedOutput;
export type DownmergeOutput =
  | AppliedOutput
  | HandoffOutput
  | RefusedOutput
  | FailedOutput;
export type ListVersionsOutput = VersionsOutput | RefusedOutput;
export type InitializeVersionerOutput =
  | InitializedOutput
  | RefusedOutput
  | FailedOutput;
export type HealthCheckOutput = HealthOutput;

export type ToolOutput =
  | PlanToolOutput
  | DownmergeOutput
  | ListVersionsOutput
  | InitializeVersionerOutput
  | HealthCheckOutput;

export function structuredPlan(plan: ChangePlan): StructuredPlan {
  return {
    action: plan.action,
    targetBranch: plan.targetBranch,
    targetBranchHead: plan.targetBranchHead,
    ...(plan.currentVersion === undefined
      ? {}
      : { currentVersion: plan.currentVersion }),
    ...(plan.resultingVersion === undefined
      ? {}
      : { resultingVersion: plan.resultingVersion }),
    ...(plan.shape === undefined ? {} : { shape: plan.shape }),
    mutations: plan.mutations.map((m) => ({
      kind: m.kind,
      operation: mutationOperation(m),
      summary: m.summary,
      ...(m.detail === undefined ? {} : { detail: m.detail }),
      ...(m.ref === undefined ? {} : { ref: m.ref }),
    })),
    warnings: plan.warnings.map((w) => codedMessage(w, plan.action)),
    notices: plan.notices.map((n) => codedMessage(n, plan.action)),
    ...(plan.mergePreview === undefined
      ? {}
      : { mergePreview: codedMessage(plan.mergePreview, plan.action) }),
    ...(plan.pipelineTrigger === undefined
      ? {}
      : { pipelineTrigger: codedMessage(plan.pipelineTrigger, plan.action) }),
    checks: plan.checks ?? [],
    checkOutput: plan.checkOutput ?? [],
    ...(plan.review === undefined ? {} : { review: plan.review }),
    digest: plan.digest,
  };
}

export function structuredHandoff(handoff: ManualDownmerge): StructuredHandoff {
  return {
    code: handoff.requiresDecision ? "H2" : "H1",
    text: renderManualDownmerge(handoff),
    source: handoff.route.source,
    target: handoff.route.target,
    requiresDecision: handoff.requiresDecision,
    sourceBranch: handoff.sourceBranch,
    ...(handoff.version === undefined ? {} : { version: handoff.version }),
    conflictedFiles: handoff.conflictedFiles,
    resolutionBranch: handoff.resolutionBranch,
    resolutionBase: handoff.resolutionBase,
    title: handoff.pullRequestTitle,
    steps: handoff.steps,
    options: handoff.options ?? [],
    ...(handoff.increment === undefined
      ? {}
      : { increment: handoff.increment }),
  };
}

export function pipelineOutcome(
  result: PipelineTriggerResult | undefined
): PipelineOutcome | undefined {
  if (!result) {
    return undefined;
  }
  const code = messageCode(result.message);
  return {
    status: result.status,
    ...(code === undefined ? {} : { code }),
    message: result.message,
    ...(result.output === undefined ? {} : { output: result.output }),
  };
}

export function pullRequestNumber(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)\/?$/);
  return match ? Number(match[1]) : undefined;
}

export function appliedPullRequest(opts: {
  url: string;
  head: string;
  base: string;
  change: AppliedPullRequest["change"];
  plan?: ChangePlan;
  draft?: boolean;
  title?: string;
}): AppliedPullRequest {
  const planned = opts.plan?.mutations.find(
    (m) =>
      m.kind === "pull-request" &&
      m.ref?.head === opts.head &&
      m.ref?.base === opts.base
  )?.ref;
  const number = pullRequestNumber(opts.url) ?? planned?.number;
  const title = opts.title ?? planned?.title;
  const draft =
    opts.draft ?? (opts.change === "opened" ? planned?.draft : undefined);
  return {
    ...(number === undefined ? {} : { number }),
    url: opts.url,
    head: opts.head,
    base: opts.base,
    ...(title === undefined ? {} : { title }),
    change: opts.change,
    ...(draft === undefined ? {} : { draft }),
  };
}

export function pullRequestChange(
  action: "created" | "updated" | undefined
): "opened" | "updated" {
  return action === "updated" ? "updated" : "opened";
}

export function problem(code: string, text: string): CodedMessage {
  return { code, text };
}

export function plannedChange(
  plan: ChangePlan | undefined,
  kind: MutationKind
): "created" | "existing" {
  return plan?.mutations.some(
    (m) => m.kind === kind && mutationOperation(m) === "create"
  )
    ? "created"
    : "existing";
}

export function downmergePullRequests(opts: {
  result: DownmergeResult;
  route: DownmergeRoute;
  plan: ChangePlan;
}): AppliedPullRequest[] {
  const { result, route, plan } = opts;
  if (result.kind === "direct") {
    const planned = plan.mutations.find((m) => m.kind === "pull-request");
    const head = planned?.ref?.head ?? "";
    return [
      appliedPullRequest({
        url: result.pullRequestUrl,
        head,
        base: route.target,
        change:
          planned && mutationOperation(planned) === "update"
            ? "updated"
            : "opened",
        plan,
      }),
    ];
  }
  const planned = plan.mutations.find(
    (m) => m.kind === "pull-request" && mutationOperation(m) === "create"
  );
  const pullRequests: AppliedPullRequest[] = [
    {
      ...appliedPullRequest({
        url: result.pullRequestUrl,
        head: result.mergeBranchName,
        base: route.target,
        change: result.alreadyOpen ? "alreadyOpen" : "opened",
      }),
      ...(planned?.ref?.title === undefined
        ? {}
        : { title: planned.ref.title }),
    },
  ];
  const superseded = result.superseded;
  if (superseded && !superseded.error) {
    pullRequests.push({
      ...(superseded.number === undefined ? {} : { number: superseded.number }),
      ...(superseded.url === undefined ? {} : { url: superseded.url }),
      head: superseded.head,
      base: superseded.base,
      change: "superseded",
    });
  }
  return pullRequests;
}

export function versionsOutput(
  listing: VersionListing,
  workingDirectory: string
): VersionsOutput {
  return {
    kind: "versions",
    tool: "list_versions",
    workingDirectory,
    currentBranch: listing.currentBranch,
    productionBranch: listing.productionBranch,
    entries: listing.entries.map((e) => ({
      branch: e.branch,
      type: e.type,
      version: e.version,
      kind: e.kind,
      current: e.isCurrentBranch,
      tag: e.tagExistsRemotely
        ? "remote"
        : e.tagExistsLocally
        ? "local-only"
        : "none",
      mergedIntoProduction: e.mergedIntoProduction,
      staleLocal: e.staleLocal,
    })),
    candidates: listing.entries.filter((e) => e.kind === "rc").length,
  };
}

export function refused(
  tool: ToolName,
  text: string,
  action?: string
): RefusedOutput {
  const code = messageCode(text, action ?? tool);
  return { kind: "refused", tool, ...(code === undefined ? {} : { code }), text };
}

export function failed(
  tool: ToolName,
  text: string,
  steps: WorkflowStep[]
): FailedOutput {
  const code = messageCode(text, tool);
  return {
    kind: "failed",
    tool,
    ...(code === undefined ? {} : { code }),
    text,
    steps,
  };
}

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const int: Schema = { type: "integer" };
const num: Schema = { type: "number" };
const bool: Schema = { type: "boolean" };
const nullableStr: Schema = { type: ["string", "null"] };
const arr = (items: Schema): Schema => ({ type: "array", items });
const oneOfStrings = (...values: string[]): Schema => ({
  type: "string",
  enum: values,
});
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
});
const kindOf = (kind: string): Schema => ({ const: kind });
const stringMap: Schema = {
  type: "object",
  additionalProperties: { type: "string" },
};

const codedMessageSchema = obj({ code: str, text: str }, ["text"]);

const mutationRefSchema = obj({
  name: str,
  sha: str,
  url: str,
  number: int,
  head: str,
  base: str,
  title: str,
  draft: bool,
});

const mutationSchema = obj(
  {
    kind: oneOfStrings(
      "branch",
      "commit",
      "tag",
      "push",
      "pull-request",
      "github-release"
    ),
    operation: oneOfStrings("create", "update", "close", "delete"),
    summary: str,
    detail: stringMap,
    ref: mutationRefSchema,
  },
  ["kind", "operation", "summary"]
);

const checkRunSchema = obj(
  {
    name: str,
    status: oneOfStrings("passed", "failed", "timeout"),
    exitCode: int,
    seconds: num,
    ref: str,
    sha: str,
    output: str,
  },
  ["name", "status", "exitCode", "seconds", "ref", "sha"]
);

const commitRangeSchema = obj(
  {
    base: str,
    head: str,
    baseSha: str,
    headSha: str,
    count: int,
    filesChanged: int,
    commits: arr(
      obj({ sha: str, subject: str, author: str }, ["sha", "subject", "author"])
    ),
    compareUrl: str,
  },
  ["base", "head", "baseSha", "headSha", "count", "filesChanged", "commits"]
);

const reviewSchema = obj({
  repoUrl: str,
  versionFile: obj({ path: { const: "VERSION" }, from: str, to: str }, [
    "path",
    "from",
    "to",
  ]),
  ships: commitRangeSchema,
  sinceVersion: commitRangeSchema,
  reverts: obj({ sha: str, subject: str, files: arr(str), url: str }, [
    "sha",
    "subject",
    "files",
  ]),
});

const planSchema = obj(
  {
    action: str,
    targetBranch: str,
    targetBranchHead: str,
    currentVersion: str,
    resultingVersion: str,
    shape: oneOfStrings("revert", "abandon"),
    mutations: arr(mutationSchema),
    warnings: arr(codedMessageSchema),
    notices: arr(codedMessageSchema),
    mergePreview: codedMessageSchema,
    pipelineTrigger: codedMessageSchema,
    checks: arr(checkRunSchema),
    checkOutput: arr(obj({ name: str, output: str }, ["name", "output"])),
    review: reviewSchema,
    digest: str,
  },
  [
    "action",
    "targetBranch",
    "targetBranchHead",
    "mutations",
    "warnings",
    "notices",
    "checks",
    "checkOutput",
    "digest",
  ]
);

const handoffSchema = obj(
  {
    code: oneOfStrings("H1", "H2"),
    text: str,
    source: oneOfStrings("main", "release", "hotfix"),
    target: oneOfStrings("develop", "main"),
    requiresDecision: bool,
    sourceBranch: str,
    version: str,
    conflictedFiles: arr(str),
    resolutionBranch: str,
    resolutionBase: str,
    title: str,
    steps: arr(str),
    options: arr(
      obj({ label: str, text: str, recommended: bool }, [
        "label",
        "text",
        "recommended",
      ])
    ),
    increment: obj({ version: str, openPullRequest: int }, ["version"]),
  },
  [
    "code",
    "text",
    "source",
    "target",
    "requiresDecision",
    "sourceBranch",
    "conflictedFiles",
    "resolutionBranch",
    "resolutionBase",
    "title",
    "steps",
    "options",
  ]
);

const stepSchema = obj(
  {
    step: int,
    name: str,
    status: oneOfStrings(
      "pending",
      "in_progress",
      "completed",
      "failed",
      "skipped"
    ),
    message: str,
    error: str,
  },
  ["step", "name", "status"]
);

const appliedResultSchema = obj(
  {
    dryRun: bool,
    branch: obj(
      {
        name: str,
        change: oneOfStrings("created", "existing", "updated", "deleted"),
        base: str,
      },
      ["name", "change"]
    ),
    from: str,
    to: str,
    shape: oneOfStrings("revert", "abandon"),
    resumed: bool,
    tag: obj(
      {
        name: str,
        change: oneOfStrings("created", "existing", "deleted", "absent"),
        deletedLocally: bool,
        deletedOnOrigin: bool,
      },
      ["name", "change"]
    ),
    githubRelease: obj(
      { tag: str, change: oneOfStrings("created", "deleted"), url: str },
      ["tag", "change"]
    ),
    route: obj(
      {
        source: oneOfStrings("main", "release", "hotfix"),
        target: oneOfStrings("develop", "main"),
      },
      ["source", "target"]
    ),
    mergeBranch: str,
    pullRequests: arr(
      obj(
        {
          number: int,
          url: str,
          head: str,
          base: str,
          title: str,
          change: oneOfStrings(
            "opened",
            "updated",
            "closed",
            "superseded",
            "alreadyOpen"
          ),
          draft: bool,
        },
        ["head", "base", "change"]
      )
    ),
    pipeline: obj(
      {
        status: oneOfStrings("started", "skipped", "failed"),
        code: str,
        message: str,
        output: str,
      },
      ["status", "message"]
    ),
    manualDownmerge: handoffSchema,
    warnings: arr(codedMessageSchema),
    notices: arr(codedMessageSchema),
    problems: arr(codedMessageSchema),
    steps: arr(stepSchema),
    nextSteps: arr(str),
  },
  [
    "dryRun",
    "pullRequests",
    "warnings",
    "notices",
    "problems",
    "steps",
    "nextSteps",
  ]
);

const toolNameSchema = oneOfStrings(
  "health_check",
  "create_release_candidate",
  "create_hotfix",
  "increment_release_candidate",
  "release_version",
  "initialize_versioner",
  "downmerge",
  "list_versions",
  "revert_version"
);

const planOutputSchema = obj(
  { kind: kindOf("plan"), tool: toolNameSchema, plan: planSchema },
  ["kind", "tool", "plan"]
);
const staleOutputSchema = obj(
  {
    kind: kindOf("stale"),
    tool: toolNameSchema,
    code: { const: "D1" },
    text: str,
    provided: str,
    plan: planSchema,
  },
  ["kind", "tool", "code", "text", "provided", "plan"]
);
const appliedOutputSchema = obj(
  { kind: kindOf("applied"), tool: toolNameSchema, result: appliedResultSchema },
  ["kind", "tool", "result"]
);
const handoffOutputSchema = obj(
  { kind: kindOf("handoff"), tool: toolNameSchema, handoff: handoffSchema },
  ["kind", "tool", "handoff"]
);
const refusedOutputSchema = obj(
  { kind: kindOf("refused"), tool: toolNameSchema, code: str, text: str },
  ["kind", "tool", "text"]
);
const failedOutputSchema = obj(
  {
    kind: kindOf("failed"),
    tool: toolNameSchema,
    code: str,
    text: str,
    steps: arr(stepSchema),
  },
  ["kind", "tool", "text", "steps"]
);
const versionsOutputSchema = obj(
  {
    kind: kindOf("versions"),
    tool: toolNameSchema,
    workingDirectory: str,
    currentBranch: str,
    productionBranch: str,
    entries: arr(
      obj(
        {
          branch: str,
          type: oneOfStrings("release", "hotfix"),
          version: nullableStr,
          kind: oneOfStrings("rc", "final", "unknown"),
          current: bool,
          tag: oneOfStrings("remote", "local-only", "none"),
          mergedIntoProduction: bool,
          staleLocal: bool,
        },
        [
          "branch",
          "type",
          "version",
          "kind",
          "current",
          "tag",
          "mergedIntoProduction",
          "staleLocal",
        ]
      )
    ),
    candidates: int,
  },
  [
    "kind",
    "tool",
    "workingDirectory",
    "currentBranch",
    "productionBranch",
    "entries",
    "candidates",
  ]
);
const healthOutputSchema = obj(
  {
    kind: kindOf("health"),
    tool: toolNameSchema,
    server: str,
    version: str,
    build: obj({ commit: str, time: str }, ["commit", "time"]),
    status: str,
    timestamp: str,
    auth: obj(
      {
        source: str,
        appId: str,
        repository: str,
        installationId: int,
        permissions: stringMap,
        tokenExpiresAt: str,
        error: str,
      },
      ["source"]
    ),
    capabilities: arr(str),
  },
  [
    "kind",
    "tool",
    "server",
    "version",
    "build",
    "status",
    "timestamp",
    "auth",
    "capabilities",
  ]
);
const initializedOutputSchema = obj(
  {
    kind: kindOf("initialized"),
    tool: toolNameSchema,
    workingDirectory: str,
    version: str,
    isReleaseCandidate: bool,
  },
  ["kind", "tool", "workingDirectory", "version", "isReleaseCandidate"]
);

const union = (...members: Schema[]): Schema & { type: "object" } => ({
  type: "object",
  oneOf: members,
});

export const OUTPUT_SCHEMAS: Record<ToolName, Schema & { type: "object" }> = {
  health_check: union(healthOutputSchema),
  create_release_candidate: union(
    planOutputSchema,
    staleOutputSchema,
    appliedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  create_hotfix: union(
    planOutputSchema,
    staleOutputSchema,
    appliedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  increment_release_candidate: union(
    planOutputSchema,
    staleOutputSchema,
    appliedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  release_version: union(
    planOutputSchema,
    staleOutputSchema,
    appliedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  revert_version: union(
    planOutputSchema,
    staleOutputSchema,
    appliedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  initialize_versioner: union(
    initializedOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  downmerge: union(
    appliedOutputSchema,
    handoffOutputSchema,
    refusedOutputSchema,
    failedOutputSchema
  ),
  list_versions: union(versionsOutputSchema, refusedOutputSchema),
};

function withPipeline(
  result: PipelineTriggerResult | undefined
): { pipeline?: PipelineOutcome } {
  const pipeline = pipelineOutcome(result);
  return pipeline === undefined ? {} : { pipeline };
}

function cleanBranch(name: string): string {
  return name.replace(/^remotes\/origin\//, "");
}

export function releaseCandidateNextSteps(
  result: ReleaseWorkflowContext
): string[] {
  return result.pullRequestUrl
    ? [
        `Review the pull request: ${result.pullRequestUrl}`,
        "Run integration tests on the release branch",
        "Merge the PR when ready to integrate to develop",
        "Deploy to staging environment for testing",
      ]
    : [
        "Review the release branch",
        "Run integration tests",
        "Create PR to develop branch (Step 6 completed)",
        "Deploy to staging environment for testing",
      ];
}

export function hotfixNextSteps(result: HotfixWorkflowContext): string[] {
  return [
    "Commit the actual fix on the hotfix branch and push it",
    ...(result.pullRequestUrl
      ? [`Track it on the → main PR: ${result.pullRequestUrl}`]
      : []),
    "Promote the RC to a final version with release_version",
    "Deploy to production",
    "Merge the → main PR only AFTER the deployment succeeds",
    "Bring the hotfix into develop with downmerge (source: hotfix, target: develop)",
  ];
}

export function downmergeNextSteps(route: DownmergeRoute): string[] {
  return route.target === "main"
    ? [
        "Review the pull request, or close it to reject the downmerge",
        `Merge it only after the ${route.source} has been deployed to production`,
      ]
    : [
        "Review the pull request and CI checks, or close it to reject the downmerge",
        "Merge once green",
      ];
}

interface ApplyContext {
  plan: ChangePlan;
  dryRun: boolean;
  steps: WorkflowStep[];
}

export function createdOutput(
  opts: ApplyContext &
    (
      | { tool: "create_release_candidate"; result: ReleaseWorkflowContext }
      | { tool: "create_hotfix"; result: HotfixWorkflowContext }
    )
): AppliedOutput {
  const { plan, result } = opts;
  const base = opts.tool === "create_hotfix" ? "main" : "develop";
  const version = result.targetVersion?.version;
  const pullRequests: AppliedPullRequest[] = [];
  const problems: CodedMessage[] = [];
  if (result.pullRequestUrl) {
    pullRequests.push(
      appliedPullRequest({
        url: result.pullRequestUrl,
        head: result.currentBranch,
        base,
        change: pullRequestChange(result.pullRequestAction),
        plan,
      })
    );
  }
  if (result.pullRequestError) {
    problems.push(problem("R1", result.pullRequestError));
  }
  if (opts.tool === "create_hotfix") {
    const hotfix = opts.result;
    if (hotfix.trackingPullRequestUrl) {
      pullRequests.push(
        appliedPullRequest({
          url: hotfix.trackingPullRequestUrl,
          head: hotfix.currentBranch,
          base: "develop",
          change: pullRequestChange(hotfix.trackingPullRequestAction),
          plan,
        })
      );
    }
    if (hotfix.trackingPullRequestError) {
      problems.push(problem("R7", hotfix.trackingPullRequestError));
    }
  }
  return {
    kind: "applied",
    tool: opts.tool,
    result: {
      dryRun: opts.dryRun,
      branch: {
        name: result.currentBranch,
        change: plannedChange(plan, "branch"),
        base,
      },
      ...(plan.currentVersion === undefined ? {} : { from: plan.currentVersion }),
      ...(version === undefined ? {} : { to: version }),
      resumed: result.resumed === true,
      ...(version === undefined
        ? {}
        : { tag: { name: version, change: plannedChange(plan, "tag") } }),
      pullRequests,
      ...withPipeline(result.pipelineTrigger),
      warnings: [],
      notices: [],
      problems,
      steps: opts.steps,
      nextSteps:
        opts.tool === "create_hotfix"
          ? hotfixNextSteps(opts.result)
          : releaseCandidateNextSteps(opts.result),
    },
  };
}

export function incrementOutput(
  opts: ApplyContext & { result: IncrementRCWorkflowContext }
): AppliedOutput {
  const { plan, result } = opts;
  const branch = cleanBranch(result.branchInfo.name);
  const version = result.targetVersion?.version;
  const handoff = result.manualDownmerge
    ? structuredHandoff(result.manualDownmerge)
    : undefined;
  return {
    kind: "applied",
    tool: "increment_release_candidate",
    result: {
      dryRun: opts.dryRun,
      branch: { name: branch, change: "updated" },
      ...(plan.currentVersion === undefined ? {} : { from: plan.currentVersion }),
      ...(version === undefined ? {} : { to: version }),
      ...(version === undefined
        ? {}
        : { tag: { name: version, change: "created" } }),
      pullRequests: result.pullRequestUrl
        ? [
            appliedPullRequest({
              url: result.pullRequestUrl,
              head: branch,
              base: result.branchInfo.targetBranch,
              change: pullRequestChange(result.pullRequestAction),
              plan,
            }),
          ]
        : [],
      ...withPipeline(result.pipelineTrigger),
      ...(handoff === undefined ? {} : { manualDownmerge: handoff }),
      warnings: [],
      notices: [],
      problems: result.pullRequestError
        ? [problem("R1", result.pullRequestError)]
        : [],
      steps: opts.steps,
      nextSteps: [
        ...(handoff === undefined
          ? []
          : [
              `Carry out the manual downmerge of ${handoff.sourceBranch} into ` +
                `develop: resolve the conflicts on ${handoff.resolutionBranch} ` +
                `and open a pull request titled "${handoff.title}"`,
            ]),
        "Promote the release candidate with release_version when it is ready for production",
      ],
    },
  };
}

export function releaseOutput(
  opts: ApplyContext & { result: ReleaseVersionWorkflowContext }
): AppliedOutput {
  const { plan, result } = opts;
  const branch = cleanBranch(result.branchInfo.name);
  const version = result.targetVersion?.version;
  const source = result.branchType;
  const pullRequests: AppliedPullRequest[] = [];
  if (result.pullRequestUrl) {
    pullRequests.push(
      appliedPullRequest({
        url: result.pullRequestUrl,
        head: branch,
        base: "main",
        change: pullRequestChange(result.pullRequestAction),
        plan,
      })
    );
  }
  if (result.ownBasePullRequestUrl) {
    pullRequests.push(
      appliedPullRequest({
        url: result.ownBasePullRequestUrl,
        head: branch,
        base: result.ownBaseBranch ?? "develop",
        change: pullRequestChange(result.ownBasePullRequestAction),
        plan,
      })
    );
  }
  return {
    kind: "applied",
    tool: "release_version",
    result: {
      dryRun: opts.dryRun,
      branch: { name: branch, change: "updated" },
      ...(plan.currentVersion === undefined ? {} : { from: plan.currentVersion }),
      ...(version === undefined ? {} : { to: version }),
      ...(version === undefined
        ? {}
        : { tag: { name: version, change: "created" } }),
      ...(version !== undefined && result.releaseUrl
        ? {
            githubRelease: {
              tag: version,
              change: "created",
              url: result.releaseUrl,
            },
          }
        : {}),
      pullRequests,
      ...withPipeline(result.pipelineTrigger),
      warnings: [],
      notices: [],
      problems: [
        ...(result.pullRequestError
          ? [problem("R1", result.pullRequestError)]
          : []),
        ...(result.releaseNotesWarning
          ? [codedMessage(result.releaseNotesWarning)]
          : []),
        ...(result.ownBasePullRequestError
          ? [problem("R6", result.ownBasePullRequestError)]
          : []),
      ],
      steps: opts.steps,
      nextSteps: [
        `Deploy ${version ?? "the release"} to production`,
        `After the deploy, run downmerge (source: ${source}, target: main) and merge its pull request`,
        `Then run downmerge (source: ${source}, target: develop) and merge that pull request`,
      ],
    },
  };
}

export function revertOutput(
  opts: ApplyContext & { result: RevertVersionWorkflowContext }
): AppliedOutput {
  const { plan, result } = opts;
  const ownBase =
    plan.mutations.find(
      (m) =>
        m.kind === "pull-request" &&
        m.ref?.head === result.currentBranch &&
        m.ref?.base !== "main"
    )?.ref?.base ?? (result.branchType === "hotfix" ? "main" : "develop");
  const pullRequests: AppliedPullRequest[] = [];
  if (result.pullRequestUrl) {
    pullRequests.push(
      appliedPullRequest({
        url: result.pullRequestUrl,
        head: result.currentBranch,
        base: ownBase,
        change: result.pullRequestAction === "closed" ? "closed" : "updated",
        plan,
      })
    );
  }
  if (result.promotionPullRequestUrl) {
    pullRequests.push(
      appliedPullRequest({
        url: result.promotionPullRequestUrl,
        head: result.currentBranch,
        base: "main",
        change: "closed",
        plan,
      })
    );
  }
  const abandoned = result.shape === "abandon";
  return {
    kind: "applied",
    tool: "revert_version",
    result: {
      dryRun: opts.dryRun,
      branch: {
        name: result.currentBranch,
        change: abandoned && result.branchDeleted ? "deleted" : "updated",
      },
      from: result.revertedVersion,
      ...(result.resultingVersion === undefined
        ? {}
        : { to: result.resultingVersion }),
      shape: result.shape,
      tag: {
        name: result.revertedVersion,
        change:
          result.tagDeletedLocally || result.tagDeletedRemotely
            ? "deleted"
            : "absent",
        deletedLocally: result.tagDeletedLocally,
        deletedOnOrigin: result.tagDeletedRemotely,
      },
      ...(result.releaseDeletedUrl
        ? {
            githubRelease: {
              tag: result.revertedVersion,
              change: "deleted",
              url: result.releaseDeletedUrl,
            },
          }
        : {}),
      pullRequests,
      ...withPipeline(result.pipelineTrigger),
      warnings: [],
      notices: [],
      problems: [
        ...(result.pullRequestError
          ? [problem("R8", result.pullRequestError)]
          : []),
        ...(result.promotionPullRequestError
          ? [problem("R10", result.promotionPullRequestError)]
          : []),
      ],
      steps: opts.steps,
      nextSteps: abandoned
        ? [
            result.branchType === "hotfix"
              ? "Cut a new hotfix with create_hotfix when one is needed"
              : "Cut a new release candidate with create_release_candidate when one is needed",
          ]
        : [
            `Push the fixes to ${result.currentBranch}, then cut the next candidate with increment_release_candidate`,
          ],
    },
  };
}

export function downmergeOutput(opts: {
  route: DownmergeRoute;
  result: DownmergeResult;
  warnings: string[];
  notices: string[];
  plan: ChangePlan;
}): AppliedOutput {
  const { route, result } = opts;
  const superseded =
    result.kind === "merge-branch" ? result.superseded : undefined;
  return {
    kind: "applied",
    tool: "downmerge",
    result: {
      dryRun: false,
      route,
      ...(result.kind === "merge-branch"
        ? { mergeBranch: result.mergeBranchName }
        : {}),
      pullRequests: downmergePullRequests({ result, route, plan: opts.plan }),
      warnings: opts.warnings.map((w) => codedMessage(w, "downmerge")),
      notices: opts.notices.map((n) => codedMessage(n, "downmerge")),
      problems: superseded?.error ? [problem("R9", superseded.error)] : [],
      steps: [],
      nextSteps: downmergeNextSteps(route),
    },
  };
}
