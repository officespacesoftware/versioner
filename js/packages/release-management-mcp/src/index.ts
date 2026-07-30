#!/usr/bin/env node

/**
 * Release Management MCP Server — Model Context Protocol server for Git Flow
 * release management.
 *
 * Mutating actions follow a plan/confirm protocol: called without a confirmation
 * digest they describe the git objects they would create and change nothing.
 */

import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  GitFlowManager,
  MergeConflictError,
  ReleaseAgent,
  StalePlanError,
  VersionerAdapter,
  assertPlanIsCurrent,
  renderChangePlan,
  type ChangePlan,
  type DownmergeResult,
} from "@officespacesoftware/release-management-core";

/** Reported over the MCP handshake and by health_check; taken from the package itself. */
const SERVER_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/**
 * Present a plan for a human to approve, making it unambiguous that nothing has
 * happened yet and stating exactly how to proceed.
 */
function renderPlanForApproval(plan: ChangePlan, toolName: string): string {
  return `📋 Plan — nothing has been changed yet

${renderChangePlan(plan)}

To apply, call ${toolName} again with:
  confirm: "${plan.digest}"`;
}

/** Format a rejected apply, showing what the repository looks like now. */
function renderStalePlan(error: StalePlanError, toolName: string): string {
  return `⚠️  Not applied — the repository changed since this plan was made

${error.message}

The current plan is:

${renderChangePlan(error.plan)}

To apply this one instead, call ${toolName} with:
  confirm: "${error.plan.digest}"`;
}

/**
 * Release Management MCP Server
 *
 * This server provides intelligent Git Flow release management workflows:
 * - Release candidate creation (major, minor, patch) following the 6-step process
 * - Branch validation and synchronization checks
 * - Integration with versioner-mcp for version management
 * - Automated PR creation and workflow orchestration
 */
class ReleaseManagementMCPServer {
  private server: Server;
  private releaseAgent?: ReleaseAgent;
  private gitFlowManager?: GitFlowManager;
  private versionerAdapter?: VersionerAdapter;
  private boundWorkingDirectory?: string;

  /**
   * Ensure gitFlowManager and releaseAgent are bound to `workingDirectory`.
   *
   * The MCP server is a long-lived stdio process; without this, the very first
   * tool call would lock these to whatever cwd it used and every subsequent call
   * — even with a different `workingDirectory` arg — would silently operate on
   * the original repo. Re-instantiate whenever the directory changes.
   */
  private async bindWorkingDirectory(
    workingDirectory: string,
    options: { initializeReleaseAgent?: boolean } = {}
  ): Promise<void> {
    if (this.boundWorkingDirectory !== workingDirectory) {
      this.gitFlowManager = new GitFlowManager(workingDirectory);
      delete this.releaseAgent;
      this.boundWorkingDirectory = workingDirectory;
    } else if (!this.gitFlowManager) {
      this.gitFlowManager = new GitFlowManager(workingDirectory);
    }

    if (options.initializeReleaseAgent && !this.releaseAgent) {
      this.releaseAgent = new ReleaseAgent(
        this.gitFlowManager!,
        workingDirectory
      );
      await this.releaseAgent.initialize();
    }
  }

  /**
   * A ReleaseAgent for planning a downmerge. Not initialized, because a downmerge
   * reads git and GitHub and never rewrites VERSION; requiring the versioner
   * library to have loaded would refuse a plan it does not need.
   */
  private planningAgent(): ReleaseAgent {
    return new ReleaseAgent(this.gitFlowManager!, this.boundWorkingDirectory!);
  }

  constructor() {
    this.server = new Server(
      {
        name: "release-management-mcp",
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) =>
      console.error("[Release Management MCP Error]", error);

    process.on("SIGINT", async () => {
      await this.cleanup();
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "health_check",
            title: "Health Check",
            description: `🩺  Health Check (read-only)

Reports whether the Release Management MCP server process is responsive.

Creates nothing. It does not read the repository, run git, or contact GitHub.

Returns the server name, its package version, the status, an ISO timestamp, and a
list of capability descriptions.`,
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "create_release_candidate",
            title: "Create Release Candidate",
            description: `🎯  Create Release Candidate (RC)

Cuts a new release branch off develop and sets it to an RC.0 version.

- Input: releaseType — major (X+1.0.0), minor (X.Y+1.0) or patch (X.Y.Z+1),
  applied to develop's own VERSION. Defaults to minor.
- Aborts unless main is already merged into develop: a release must not be cut
  from a develop that is missing production changes.

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
branch, commit, tag, pushes and pull request it would create, plus a digest. Pass
that digest back as 'confirm' to apply. If the repository changed in between, the
digest no longer matches and it refuses, returning a fresh plan.

Applying creates: the branch release/X.Y.Z off develop, a commit
"To version X.Y.Z-RC.0" touching only VERSION, an annotated tag X.Y.Z-RC.0, a push
of the branch and a push of the tag, and a pull request release/X.Y.Z → develop
titled "RC X.Y.Z-RC.0 to develop" (opened, or updated if one is already open).`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                releaseType: {
                  type: "string",
                  enum: ["major", "minor", "patch"],
                  description:
                    "The type of release candidate to create: major (X.0.0-RC.0), minor (x.X.0-RC.0), or patch (x.x.X-RC.0). Defaults to minor if not specified.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "create_hotfix",
            title: "Create Hotfix",
            description: `🚑  Create Hotfix (Patch RC)

Cuts a hotfix branch off main and sets it to the next patch RC.0 version.

- Version: main's own VERSION with the patch number incremented
- Opens the pull request to **main**, the one head/base pair that every later
  increment_release_candidate and release_version updates rather than duplicates
- Does NOT bring the hotfix into develop; use downmerge_hotfix_to_develop for
  that, once the fix is written

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
branch, commit, tag, pushes and pull request it would create, plus a digest. Pass
that digest back as 'confirm' to apply. If the repository changed in between, the
digest no longer matches and it refuses, returning a fresh plan.

Applying creates: the branch hotfix/X.Y.Z off main, a commit
"To version X.Y.Z-RC.0" touching only VERSION, an annotated tag X.Y.Z-RC.0, a push
of the branch and a push of the tag, and a pull request hotfix/X.Y.Z → main titled
"RC X.Y.Z-RC.0 to main", carrying a warning not to merge before the hotfix has
been deployed. If a pull request for that head/base pair is already open, its
title and the watermarked region of its body are updated instead.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "increment_release_candidate",
            title: "Increment Release Candidate",
            description: `🔼  Increment Release Candidate

Bumps the RC number for an existing release or hotfix branch (e.g. RC.1 → RC.2).

- Input: optional base version (e.g., 1.2.0)
- Target selection, in order:
  1. the version you pass explicitly;
  2. the currently checked-out release/hotfix branch, if it holds an RC;
  3. otherwise the newest RC across all branches.
- If a release/hotfix branch IS checked out but does not hold an RC, this ABORTS
  rather than silently acting on a different release train. Use list_versions to
  see every candidate, then pass the version you want.
- Works with both release/X.Y.0 and hotfix/X.Y.Z

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
commit, tag, pushes and pull request it would create, plus a digest. Pass that
digest back as 'confirm' to apply. If the repository changed in between, the
digest no longer matches and it refuses, returning a fresh plan.

Applying creates: a commit "To version X.Y.Z-RC.<n+1>" touching only VERSION, an
annotated tag of the same name, a push of both to origin, and a pull request to the
branch's own base — develop for release/X.Y.Z, main for hotfix/X.Y.Z — opened, or
updated if one is already open.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                version: {
                  type: "string",
                  description:
                    "Optional target version to increment (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "release_version",
            title: "Release Version",
            description: `🏁  Release Version (RC → Final)

Promotes a release candidate to a final version (e.g. 1.2.0-RC.3 → 1.2.0).

- Input: optional base version (e.g., 1.2.0)
- Target selection, in order:
  1. the version you pass explicitly;
  2. the currently checked-out release/hotfix branch, if it holds an RC;
  3. otherwise the newest RC across all branches.
- If a release/hotfix branch IS checked out but does not hold an RC, this ABORTS
  rather than promoting a different release train. Use list_versions first.

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
commit, tag, pushes, pull request and GitHub release it would create, plus a
digest. Pass that digest back as 'confirm' to apply. If the repository changed in
between, the digest no longer matches and it refuses, returning a fresh plan.

Applying creates: a commit "To version X.Y.Z" touching only VERSION, an annotated
tag of the same name, pushes of the branch and the tag, a pull request to main
carrying a warning not to merge before the deployment, and a GitHub release whose
target is the release branch.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                version: {
                  type: "string",
                  description:
                    "Optional specific version to release (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Optional: if true, performs validation checks without making any changes (default: false)",
                },
              },
            },
          },
          {
            name: "initialize_versioner",
            title: "Initialize Versioner",
            description: `📦  Initialize Versioner

Bootstraps version management in a repository that has none.

- Input: optional initial version; defaults to 0.1.0-RC.0
- Requires at least one commit, and nothing staged
- Refuses if a VERSION file already exists

Creates, all locally: the VERSION file, holding two lines — the version, then the
short HEAD hash; a commit "To version <version>" on the current branch staging only
VERSION; and an annotated tag <version> with the message "Release version
<version>".

Nothing is pushed and no pull request is opened, so there is no plan to confirm.`,
            inputSchema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Initial version (optional, defaults to 0.1.0-RC.0)",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "downmerge_main_to_develop",
            title: "Downmerge Main to Develop",
            description: `⬇️  Downmerge main → develop

Brings production changes on main back into develop through a pull request.

- Merges main into a fresh branch cut off develop, never into develop directly
- On conflict the merge is aborted, the temporary branch is deleted, the
  repository is left on develop, and nothing is pushed
- Use after a hotfix or any direct update to main

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
branch, merge commit, push and pull request it would create, plus a digest. Pass
that digest back as 'confirm' to apply. If either main or develop moved in
between, the digest no longer matches and it refuses, returning a fresh plan.

Applying creates: the branch main-into-develop-<unix-timestamp> off develop, a
merge commit "Downmerge main into develop", a push of that branch, and a pull
request main-into-develop-<unix-timestamp> → develop, titled "Release <v> to
develop" when main's newest non-merge commit is a version bump and "Downmerge main
into develop" otherwise.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "downmerge_release_to_develop",
            title: "Downmerge Release to Develop",
            description: `⬇️  PR: release → develop

Brings a release branch back into develop after the release is cut.

- Input: optional version to merge (e.g. 1.2.0); auto-detects the newest release
  branch when omitted
- What it creates depends on whether the merge conflicts

Called WITHOUT 'confirm', this changes nothing: it previews the merge with
git merge-tree — which merges in memory and touches neither the index nor the
working tree — and returns a plan for the one path that would actually be taken,
plus a digest. Pass that digest back as 'confirm' to apply. If either branch moved
in between, the digest no longer matches and it refuses, returning a fresh plan.

Applying, when the merge is clean, creates: one pull request release/X.Y.Z →
develop titled "Release X.Y.Z to develop".

Applying, when the merge conflicts, creates: the branch
release-X.Y.Z-into-develop-<unix-timestamp> off develop, a commit staging only the
conflicted paths with their markers left intact, a push of that branch, a DRAFT
pull request into develop titled "Release X.Y.Z to develop (conflict resolution)"
for a human to resolve, and — unless a pull request for release/X.Y.Z → develop is
already open — a transient "[Build trigger] Release X.Y.Z → develop" pull request
that this action closes again once CI checks start.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent release version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "downmerge_release_to_main",
            title: "Downmerge Release to Main",
            description: `📤  PR: release → main (via merge branch)

Merges a release branch into main through a merge branch.

- Input: optional version to merge (e.g. 1.2.0); auto-detects the newest release
  branch when omitted
- The pull request head is always the merge branch, never release/* — the latter
  would re-trigger CI workflows that build a fresh artifact for an already-cut
  release
- On conflict the merge is aborted, the local merge branch is deleted, and nothing
  is pushed; the error lists the conflicted files

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the
branch, merge commit, push and pull request it would create, plus a digest. Pass
that digest back as 'confirm' to apply. If either branch moved in between, the
digest no longer matches and it refuses, returning a fresh plan.

Applying creates: the branch release-X.Y.Z-into-main-<unix-timestamp> off main, a
merge commit "Merge release/X.Y.Z into main", a push of that branch, and a pull
request into main titled "Release X.Y.Z to main", whose body opens with a warning
that it must be merged only after the release has been deployed to production.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.0'). " +
                    "When not provided, automatically finds the most recent release version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "downmerge_hotfix_to_main",
            title: "Downmerge Hotfix to Main",
            description: `🔥  PR: hotfix → main

Opens the pull request that merges a hotfix branch into main.

- Input: optional version to merge (e.g. 1.2.1); auto-detects the newest hotfix
  branch when omitted
- A merge conflict does not block it: the pull request opens either way and
  records the merge-check result in its body, where GitHub reports the conflict too
- Production-critical: merge only after the hotfix has been deployed

Called WITHOUT 'confirm', this changes nothing: it returns a plan listing the pull
request it would create, plus a digest. Pass that digest back as 'confirm' to
apply. If either branch moved in between, the digest no longer matches and it
refuses, returning a fresh plan.

Applying creates: one pull request hotfix/X.Y.Z → main titled "Release X.Y.Z to
main", whose body opens with a warning that it must be merged only after the
hotfix has been deployed to production. No branch, commit, tag or push.`,
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "string",
                  description:
                    "Digest of the plan you are approving, taken from a previous call made without this parameter. " +
                    "Omit to receive a plan without changing anything.",
                },
                version: {
                  type: "string",
                  description:
                    "Optional specific version to merge (e.g., '1.2.1'). " +
                    "When not provided, automatically finds the most recent hotfix version available on the upstream Git repository. " +
                    "If provided, this parameter must be entered by a human user.",
                },
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
              },
            },
          },
          {
            name: "list_versions",
            title: "List Versions",
            description: `🔎  List Versions (read-only)

Lists every release and hotfix branch with the facts needed to pick one deliberately.

For each branch: its VERSION, whether that version is an RC or final, whether the
matching tag exists locally and on the remote, whether the branch is already merged
into the production branch, and which branch is currently checked out.

Creates nothing: no branch, commit, tag, push, pull request, checkout or fetch. It
reads local refs and queries origin with git ls-remote, which creates no local refs.

Use this BEFORE increment_release_candidate or release_version when you are not
certain which branch should be acted on, then pass that version explicitly.`,
            inputSchema: {
              type: "object",
              properties: {
                workingDirectory: {
                  type: "string",
                  description:
                    "The working directory path for the project (optional, defaults to current directory)",
                },
                productionBranch: {
                  type: "string",
                  description:
                    "Branch treated as production when reporting merge status (optional, defaults to 'main')",
                },
              },
            },
          },
        ],
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: string;

        switch (name) {
          case "health_check":
            result = await this.handleHealthCheck();
            break;

          case "create_release_candidate":
            result = await this.handleCreateRC(args);
            break;

          case "create_hotfix":
            result = await this.handleCreateHotfix(args);
            break;

          case "increment_release_candidate":
            result = await this.handleIncrementRC(args);
            break;

          case "release_version":
            result = await this.handleReleaseVersion(args);
            break;

          case "initialize_versioner":
            result = await this.handleInitializeVersioner(args);
            break;

          case "downmerge_main_to_develop":
            result = await this.handleDownmergeMainToDevelop(args);
            break;

          case "downmerge_release_to_develop":
            result = await this.handleDownmergeReleaseToDevelop(args);
            break;

          case "downmerge_release_to_main":
            result = await this.handleDownmergeReleaseToMain(args);
            break;

          case "downmerge_hotfix_to_main":
            result = await this.handleDownmergeHotfixToMain(args);
            break;

          case "list_versions":
            result = await this.handleListVersions(args);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`Error executing tool ${name}:`, error);

        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleInitializeVersioner(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();

    try {
      // Initialize versioner adapter if needed
      if (!this.versionerAdapter) {
        this.versionerAdapter = new VersionerAdapter();
        await this.versionerAdapter.initialize(undefined, workingDirectory);
      }

      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      const versionInfo = await this.versionerAdapter.initializeProject(
        version
      );

      return `✅ Versioner Initialized Successfully!

📁 Working Directory: ${workingDirectory}
🏷️  Created Version: ${versionInfo.version}
📊 Release Type: ${
        versionInfo.isReleaseCandidate ? "Release Candidate" : "Final Release"
      }

📋 Next Steps:
1. VERSION file has been created in your project
2. Initial git commit and tag have been created
3. You can now use other versioning tools to manage releases`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Failed to initialize versioner

📁 Working Directory: ${workingDirectory}
${
  version
    ? `🔍 Requested Version: ${version}`
    : "🔍 Default Version: 0.1.0-RC.0"
}
💥 Error: ${errorMessage}

Common issues:
- Directory may not be a git repository
- Versioner MCP may not be running
- Permission issues with file creation`;
    }
  }

  private async handleListVersions(args: any): Promise<string> {
    const workingDirectory = args?.workingDirectory || process.cwd();
    const productionBranch = args?.productionBranch || "main";

    try {
      await this.bindWorkingDirectory(workingDirectory);

      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      const listing = await this.gitFlowManager!.listVersions(productionBranch);

      if (listing.entries.length === 0) {
        return `🔎 No release or hotfix branches found

📁 Working Directory: ${workingDirectory}
🌿 Current Branch: ${listing.currentBranch}`;
      }

      const rows = listing.entries.map((e) => {
        const marker = e.isCurrentBranch ? "👉" : "  ";
        const kind = e.isReleaseCandidate ? "RC" : "final";
        const flags = [
          e.tagExistsRemotely
            ? "tag:remote"
            : e.tagExistsLocally
            ? "tag:local-only"
            : "tag:none",
          e.mergedIntoProduction ? `merged→${productionBranch}` : "unmerged",
        ].join(", ");
        return `${marker} ${e.branch}  ${e.version ?? "no VERSION"}  [${kind}]  (${flags})`;
      });

      const candidates = listing.entries.filter((e) => e.isReleaseCandidate);

      return `🔎 Release & Hotfix Branches

📁 Working Directory: ${workingDirectory}
🌿 Current Branch: ${listing.currentBranch}
🏁 Production Branch: ${productionBranch}

${rows.join("\n")}

${candidates.length} release candidate(s) available.

📋 Notes:
- 👉 marks the branch currently checked out
- Pass the version explicitly to increment_release_candidate or release_version
  to act on a specific branch
- "merged→${productionBranch}" means that branch is already in production history`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ List Versions Failed

📁 Working Directory: ${workingDirectory}
💥 Error: ${errorMessage}`;
    }
  }

  private async handleDownmergeMainToDevelop(args: any): Promise<string> {
    const workingDirectory = args?.workingDirectory || process.cwd();
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.planningAgent().planDownmergeMainToDevelop();
      if (!confirm) {
        return renderPlanForApproval(plan, "downmerge_main_to_develop");
      }
      assertPlanIsCurrent(plan, confirm);

      const prUrl = await this.gitFlowManager!.downmergeMainToDevelop();

      return `🚀 Downmerge Main to Develop Completed Successfully!

📁 Working Directory: ${workingDirectory}

✅ Completed the following actions:
1. Fetched latest changes from origin
2. Checked out and pulled main branch
3. Checked out and pulled develop branch
4. Created new branch from develop
5. Merged main into the new branch
6. Pushed the new branch to origin
7. Created pull request targeting develop

${prUrl ? `🔗 Pull Request: ${prUrl}` : ""}

📋 Next Steps:
1. Review the pull request for merge conflicts
2. Test the merged changes in a development environment
3. Merge the PR when ready to integrate main changes into develop`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "downmerge_main_to_develop");
      }
      if (error instanceof MergeConflictError) {
        const conflictedList = error.conflictedFiles
          .map((f) => `   - ${f}`)
          .join("\n");
        return `❌ Downmerge Main to Develop Aborted — Merge Conflicts

📁 Working Directory: ${workingDirectory}

The merge of main into develop produced conflicts. The merge was aborted, the
temporary branch was deleted, and the repository is back on develop. No remote
branch was pushed and no PR was opened.

⚠️  Conflicted files:
${conflictedList}

📋 To resolve:
1. Create a branch off develop, merge main in, and resolve the conflicts
2. Push that branch and open a PR to develop yourself
3. Re-run this tool only once main and develop no longer conflict`;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Main to Develop Failed

📁 Working Directory: ${workingDirectory}
💥 Error: ${errorMessage}

Common issues:
- Not in a git repository
- Missing main or develop branches
- Network issues with git operations
- Permission issues with git push or PR creation
- Tracked local changes in the working tree (commit or stash first)`;
    }
  }

  private formatDownmergeResult(result: DownmergeResult): string {
    switch (result.kind) {
      case "direct":
        return `🔗 Pull Request: ${result.pullRequestUrl}`;
      case "merge-branch":
        return `🌿 Merge branch: \`${result.mergeBranchName}\`
🔗 Pull Request: ${result.pullRequestUrl}`;
      case "merge-branch-with-conflicts": {
        const buildTriggerLines = result.buildTriggerSkippedReason
          ? `⏭️  Build-trigger PR skipped: ${result.buildTriggerSkippedReason}`
          : [
              `🛠️  Build-trigger PR (auto-closed): ${result.buildTriggerPullRequestUrl}`,
              result.checksStarted
                ? "✅ Build-trigger CI checks observed before close"
                : "⚠️  Build-trigger PR closed without checks registering within 60s",
            ].join("\n");
        const conflictedList = result.conflictedFiles
          .map((f) => `   - ${f}`)
          .join("\n");
        return `🌿 Merge branch (conflicts unresolved): \`${result.mergeBranchName}\`
🔗 Draft merge-resolution PR: ${result.mergeBranchPullRequestUrl}
${buildTriggerLines}

⚠️  Conflicted files (resolve in the draft PR):
${conflictedList}`;
      }
    }
  }

  private async handleDownmergeReleaseToDevelop(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      await this.gitFlowManager!.validateNoStagedChanges();

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.planningAgent().planDownmergeReleaseToDevelop(
        version
      );
      if (!confirm) {
        return renderPlanForApproval(plan, "downmerge_release_to_develop");
      }
      assertPlanIsCurrent(plan, confirm);

      const result = await this.gitFlowManager!.downmergeReleaseToDevelop(
        version
      );

      const nextSteps =
        result.kind === "merge-branch-with-conflicts"
          ? `📋 Next Steps:
1. Check out the merge branch locally and resolve the conflicts listed above
2. Push the resolution and mark the draft PR ready for review
3. Merge the resolution PR once CI is green`
          : `📋 Next Steps:
1. Review the pull request and CI checks
2. Merge once green`;

      return `🚀 Downmerge Release to Develop Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Release"}

${this.formatDownmergeResult(result)}

${nextSteps}`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "downmerge_release_to_develop");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Release to Develop Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}
💥 Error: ${errorMessage}

Common issues:
- No release branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleDownmergeReleaseToMain(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      await this.gitFlowManager!.validateNoStagedChanges();

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.planningAgent().planDownmergeReleaseToMain(
        version
      );
      if (!confirm) {
        return renderPlanForApproval(plan, "downmerge_release_to_main");
      }
      assertPlanIsCurrent(plan, confirm);

      const result = await this.gitFlowManager!.downmergeReleaseToMain(version);

      return `🚀 Downmerge Release to Main Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Release"}

✅ Completed the following actions:
1. Validated target release branch exists
2. Fetched latest main and release branches from origin
3. Created merge branch off main and merged release into it
4. Pushed merge branch and opened PR targeting main

${this.formatDownmergeResult(result)}

📋 Next Steps:
1. Review the pull request
2. Merge the PR when ready`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "downmerge_release_to_main");
      }
      if (error instanceof MergeConflictError) {
        const conflictedList = error.conflictedFiles
          .map((f) => `   - ${f}`)
          .join("\n");
        return `❌ Downmerge Release to Main Aborted — Merge Conflicts

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}

The merge of the release branch into main produced conflicts. No remote branch was pushed and no PR was opened.

⚠️  Conflicted files:
${conflictedList}

📋 To resolve:
1. Manually create a branch off main, merge the release branch in, and resolve the conflicts
2. Push that branch and open a PR to main yourself
3. Re-run this tool only once main and release no longer conflict`;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Release to Main Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Release"}
💥 Error: ${errorMessage}

Common issues:
- No release branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleDownmergeHotfixToMain(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory);

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.planningAgent().planDownmergeHotfixToMain(
        version
      );
      if (!confirm) {
        return renderPlanForApproval(plan, "downmerge_hotfix_to_main");
      }
      assertPlanIsCurrent(plan, confirm);

      const prUrl = await this.gitFlowManager!.downmergeHotfixToMain(version);

      return `🚀 Downmerge Hotfix to Main Completed Successfully!

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detected Latest Hotfix"}

✅ Completed the following actions:
1. Validated target hotfix branch exists
2. Fetched latest changes from origin
3. Created pull request from hotfix branch to main

${prUrl ? `🔗 Pull Request: ${prUrl}` : ""}

⚠️  IMPORTANT: This is a HOTFIX merge to production.

📋 Next Steps:
1. Review the pull request for merge conflicts
2. Deploy the hotfix to production environment FIRST
3. Verify the hotfix is working correctly in production
4. THEN merge the PR after successful deployment
5. Create follow-up PR to merge hotfix changes back to develop`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "downmerge_hotfix_to_main");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `❌ Downmerge Hotfix to Main Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Target Version: ${version}` : "🔍 Auto-detect Latest Hotfix"}
💥 Error: ${errorMessage}

Common issues:
- No hotfix branches found matching the criteria
- Network issues with git operations
- Permission issues with git push or PR creation
- GitHub CLI (gh) not available or not authenticated`;
    }
  }

  private async handleHealthCheck(): Promise<string> {
    const status = {
      server: "Release Management MCP Server",
      version: SERVER_VERSION,
      status: "healthy",
      timestamp: new Date().toISOString(),
      capabilities: [
        "Git Flow workflow orchestration",
        "Release candidate creation (major, minor)",
        "Hotfix branch creation for patch releases",
        "Branch validation and synchronization",
        "Integration with versioner-mcp",
        "Automated PR management",
      ],
    };

    return JSON.stringify(status, null, 2);
  }

  private async handleCreateRC(args: any): Promise<string> {
    const releaseType = args?.releaseType || "minor"; // Default to minor
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;
    const confirm: string | undefined = args?.confirm;

    // Validate release type
    if (!["major", "minor", "patch"].includes(releaseType)) {
      throw new Error(
        "releaseType must be one of: major, minor, patch (defaults to minor if not specified)"
      );
    }

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.releaseAgent!.planCreateReleaseCandidate(
        releaseType
      );
      if (!confirm) {
        return renderPlanForApproval(plan, "create_release_candidate");
      }
      assertPlanIsCurrent(plan, confirm);

      // Execute the RC workflow with the specified release type
      const workflowResult = await this.releaseAgent!.executeRCWorkflow(
        releaseType,
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 ${
        releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
      } Release Candidate Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Target Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}

✅ All steps completed successfully. The ${releaseType} release candidate has been created and is ready for testing.

${
  workflowResult.pullRequestUrl
    ? `
📋 Next steps:
1. Review the pull request: ${workflowResult.pullRequestUrl}
2. Run integration tests on the release branch
3. Merge the PR when ready to integrate to develop
4. Deploy to staging environment for testing`
    : `
📋 Next steps:
1. Review the release branch
2. Run integration tests
3. Create PR to develop branch (Step 6 completed)
4. Deploy to staging environment for testing`
}`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "create_release_candidate");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`${releaseType} RC workflow failed:`, error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ ${
        releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
      } Release Candidate Workflow Failed

📁 Working Directory: ${workingDirectory}
📋 Release Type: ${releaseType.toUpperCase()}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleCreateHotfix(args: any): Promise<string> {
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner MCP is not available. Please ensure versioner-mcp is running."
        );
      }

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.releaseAgent!.planCreateHotfix();
      if (!confirm) {
        return renderPlanForApproval(plan, "create_hotfix");
      }
      assertPlanIsCurrent(plan, confirm);

      // Execute the hotfix workflow
      const workflowResult = await this.releaseAgent!.executeHotfixWorkflow(
        workingDirectory,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Hotfix Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
🔧 Workflow Type: HOTFIX (Patch Release)

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Target Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}

✅ All steps completed successfully.

${
  workflowResult.pullRequestUrl
    ? `
📋 Next steps:
1. Commit the actual fix on the hotfix branch and push it
2. Track it on the → main PR: ${workflowResult.pullRequestUrl}
3. Promote the RC to a final version with release_version
4. Deploy to production
5. Merge the → main PR only AFTER the deployment succeeds
6. Bring the hotfix into develop with downmerge_hotfix_to_develop`
    : `
📋 Next steps:
1. Commit the actual fix on the hotfix branch and push it
2. Promote the RC to a final version with release_version
3. Deploy to production
4. Merge the → main PR only AFTER the deployment succeeds
5. Bring the hotfix into develop with downmerge_hotfix_to_develop`
}`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "create_hotfix");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Hotfix workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Hotfix Workflow Failed

📁 Working Directory: ${workingDirectory}
🔧 Workflow Type: HOTFIX (Patch Release)
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleIncrementRC(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner is not available; the version management library failed to load."
        );
      }

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.releaseAgent!.planIncrementRC(version);
      if (!confirm) {
        return renderPlanForApproval(plan, "increment_release_candidate");
      }
      assertPlanIsCurrent(plan, confirm);

      // Execute the increment RC workflow
      const workflowResult = await this.releaseAgent!.executeIncrementRCWorkflow(
        workingDirectory,
        version,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Increment Release Candidate Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Branch Type: ${workflowResult.branchType.toUpperCase()}
🎯 Selected Branch: ${workflowResult.branchInfo.name}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 New Version: ${workflowResult.targetVersion.version}`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}
${
  workflowResult.pullRequestError
    ? `⚠️  PR step failed: ${workflowResult.pullRequestError}`
    : ""
}

✅ All steps completed successfully.`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "increment_release_candidate");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Increment RC workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Increment Release Candidate Workflow Failed

📁 Working Directory: ${workingDirectory}
${
  version
    ? `📋 Target Version: ${version}`
    : "📋 Version Selection: Auto-detect"
}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.`;
    }
  }

  private async handleReleaseVersion(args: any): Promise<string> {
    const version = args?.version;
    const workingDirectory = args?.workingDirectory || process.cwd();
    const dryRun = args?.dryRun || false;
    const confirm: string | undefined = args?.confirm;

    try {
      await this.bindWorkingDirectory(workingDirectory, {
        initializeReleaseAgent: true,
      });

      // Check if we're in a git repository
      const isGitRepo = await this.gitFlowManager!.isGitRepository();
      if (!isGitRepo) {
        throw new Error(
          `Directory '${workingDirectory}' is not a Git repository`
        );
      }

      // Check for staged changes (prevents committing unrelated changes)
      await this.gitFlowManager!.validateNoStagedChanges();

      // Check if versioner is available
      if (!this.releaseAgent!.isVersionerAvailable()) {
        throw new Error(
          "Versioner is not available; the version management library failed to load."
        );
      }

      // Without a confirmation digest, describe the change and stop.
      const plan = await this.releaseAgent!.planReleaseVersion(version);
      if (!confirm) {
        return renderPlanForApproval(plan, "release_version");
      }
      assertPlanIsCurrent(plan, confirm);

      // Execute the release workflow
      const workflowResult = await this.releaseAgent!.executeReleaseWorkflow(
        workingDirectory,
        version,
        dryRun
      );

      // Generate workflow summary
      const progressSummary = this.releaseAgent!.getProgressSummary();

      return `🚀 Release Version Workflow ${
        dryRun ? "(Dry Run) " : ""
      }Completed Successfully!

📁 Working Directory: ${workingDirectory}
📋 Branch Type: ${workflowResult.branchType.toUpperCase()}
🎯 Selected Branch: ${workflowResult.branchInfo.name}
${version ? `🔍 Requested Version: ${version}` : "🔍 Auto-detected RC Branch"}

📋 Workflow Progress:
${progressSummary}

${
  workflowResult.targetVersion
    ? `🎯 Final Version: ${workflowResult.targetVersion.version} (Released from RC)`
    : ""
}
${
  workflowResult.pullRequestUrl
    ? `🔗 ${
        workflowResult.pullRequestAction === "updated"
          ? "Updated PR"
          : "Pull Request"
      }: ${workflowResult.pullRequestUrl}`
    : ""
}
${
  workflowResult.pullRequestError
    ? `⚠️  PR step failed: ${workflowResult.pullRequestError}`
    : ""
}
${
  workflowResult.releaseUrl
    ? `📦 GitHub Release: ${workflowResult.releaseUrl}`
    : ""
}
${
  workflowResult.releaseNotesWarning
    ? `⚠️  Release notes: ${workflowResult.releaseNotesWarning}`
    : ""
}

✅ All steps completed successfully. The release candidate has been converted to final version and is ready for ${
        workflowResult.branchType === "release"
          ? "production deployment"
          : "production hotfix deployment"
      }.`;
    } catch (error) {
      if (error instanceof StalePlanError) {
        return renderStalePlan(error, "release_version");
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Release version workflow failed:", error);

      // Include progress summary even on failure
      const progressSummary =
        this.releaseAgent?.getProgressSummary() || "Workflow not started";

      return `❌ Release Version Workflow Failed

📁 Working Directory: ${workingDirectory}
${version ? `🔍 Requested Version: ${version}` : "🔍 Auto-detect RC Branch"}
🔧 Dry Run: ${dryRun ? "Yes" : "No"}

📋 Workflow Progress:
${progressSummary}

💥 Error: ${errorMessage}

Please review the error and fix any issues before retrying the workflow.

Common issues:
- Ensure you're on a release candidate branch (contains '-RC.')
- Verify the VERSION file exists and is properly formatted
- Check that versioner-mcp is running and accessible
- Ensure you have proper git permissions for pushing and PR creation`;
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Release Management MCP server running on stdio");
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.releaseAgent) {
        await this.releaseAgent.cleanup();
      }
      console.error("Release Management MCP: Cleanup completed");
    } catch (error) {
      console.error("Release Management MCP: Cleanup error:", error);
    }
  }
}

// Start the server
async function main() {
  const server = new ReleaseManagementMCPServer();
  await server.run();
}

main().catch((error) => {
  console.error("Failed to start Release Management MCP server:", error);
  process.exit(1);
});
