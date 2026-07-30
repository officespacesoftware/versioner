/**
 * Release Agent - intelligent agent for orchestrating Git Flow workflows
 */

import { VersionerAdapter, VersionInfo } from "./versioner-adapter.js";
import {
  GitFlowManager,
  BranchType,
  BranchTypeInfo,
  productionMergeWarning,
} from "./git-flow.js";
import {
  buildChangePlan,
  type ChangePlan,
  type PlannedMutation,
} from "./change-plan.js";

/**
 * Raised when the target branch cannot be determined safely. Propagated verbatim
 * rather than wrapped, because the message tells the operator how to proceed.
 */
export class BranchSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchSelectionError";
  }
}

/** `1.2.3-RC.4` → `1.2.3-RC.5`. Used to state the pending change before making it. */
export function predictIncrementedRC(version: string): string {
  const match = version.match(/^(.*)-RC\.(\d+)$/);
  if (!match) {
    return "unknown (not a release candidate)";
  }
  return `${match[1]}-RC.${parseInt(match[2] ?? "0", 10) + 1}`;
}

/** `1.2.3-RC.4` → `1.2.3`. Used to state the pending change before making it. */
export function predictPromotedVersion(version: string): string {
  return version.replace(/-RC\.\d+$/, "");
}

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

/** `1.2.3-RC.4` → `{ major: 1, minor: 2, patch: 3 }`; null when unparseable. */
function parseVersionParts(version: string): VersionParts | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1] ?? "0", 10),
    minor: parseInt(match[2] ?? "0", 10),
    patch: parseInt(match[3] ?? "0", 10),
  };
}

export interface ReleaseWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  releaseType: "major" | "minor" | "patch";
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
  pullRequestAction?: "created" | "updated";
}

export interface HotfixWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
  pullRequestAction?: "created" | "updated";
}

export interface IncrementRCWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  branchType: BranchType;
  branchInfo: BranchTypeInfo;
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
  pullRequestAction?: "created" | "updated";
  pullRequestError?: string;
}

export interface ReleaseVersionWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  branchType: BranchType;
  branchInfo: BranchTypeInfo;
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
  pullRequestAction?: "created" | "updated";
  pullRequestError?: string;
  releaseUrl?: string;
  releaseNotesWarning?: string;
}

export interface WorkflowStep {
  step: number;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  message?: string;
  error?: string;
}

/**
 * Intelligent Release Agent that orchestrates Git Flow workflows
 */
export class ReleaseAgent {
  private versionerAdapter: VersionerAdapter;
  private gitFlowManager: GitFlowManager;
  private context?:
    | ReleaseWorkflowContext
    | HotfixWorkflowContext
    | IncrementRCWorkflowContext
    | ReleaseVersionWorkflowContext;
  private workingDirectory: string;

  constructor(gitFlowManager: GitFlowManager, workingDirectory: string) {
    this.versionerAdapter = new VersionerAdapter();
    this.gitFlowManager = gitFlowManager;
    this.workingDirectory = workingDirectory;
  }

  /**
   * Initialize the release agent
   */
  async initialize(): Promise<void> {
    try {
      await this.versionerAdapter.initialize(undefined, this.workingDirectory);
      console.log("ReleaseAgent: Initialized successfully");
    } catch (error) {
      throw new Error(`Failed to initialize ReleaseAgent: ${error}`);
    }
  }

  /**
   * Execute the release candidate workflow (6-step Git Flow process)
   */
  async executeRCWorkflow(
    releaseType: "major" | "minor" | "patch",
    workingDirectory: string,
    dryRun: boolean = false
  ): Promise<ReleaseWorkflowContext> {
    console.log(
      `\n🚀 Starting ${
        releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
      } Release Candidate Workflow`
    );
    console.log(`📁 Working Directory: ${workingDirectory}`);
    console.log(`📋 Release Type: ${releaseType.toUpperCase()}`);
    console.log(`🔧 Dry Run: ${dryRun ? "Yes" : "No"}\n`);

    // Initialize workflow context
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      releaseType,
      dryRun,
      stepProgress: [
        {
          step: 1,
          name: "Verify main/develop synchronization",
          status: "pending",
        },
        { step: 2, name: "Checkout develop branch", status: "pending" },
        { step: 3, name: "Create release branch", status: "pending" },
        {
          step: 4,
          name: `Update version to ${releaseType} RC`,
          status: "pending",
        },
        { step: 5, name: "Push release branch and tag", status: "pending" },
        { step: 6, name: "Create pull request to develop", status: "pending" },
      ],
    };

    try {
      // Execute each step of the workflow
      await this.executeStep1_VerifyBranchSync();
      await this.executeStep2_CheckoutDevelop();
      await this.executeStep3_CreateReleaseBranch();
      await this.executeStep4_UpdateVersion();
      await this.executeStep5_PushBranchAndTag();
      await this.executeStep6_CreatePullRequest();

      console.log(
        `\n✅ ${
          releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
        } Release Candidate Workflow completed successfully!`
      );
      return this.context;
    } catch (error) {
      console.error(
        `\n❌ ${
          releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
        } Release Candidate Workflow failed:`,
        error
      );

      // Mark current step as failed
      const currentStep = this.context.stepProgress.find(
        (s) => s.status === "in_progress"
      );
      if (currentStep) {
        currentStep.status = "failed";
        currentStep.error =
          error instanceof Error ? error.message : String(error);
      }

      throw error;
    }
  }

  /**
   * Execute the hotfix workflow (6-step Git Flow hotfix process)
   */
  async executeHotfixWorkflow(
    workingDirectory: string,
    dryRun: boolean = false
  ): Promise<HotfixWorkflowContext> {
    console.log(`\n🚀 Starting Hotfix Workflow`);
    console.log(`📁 Working Directory: ${workingDirectory}`);
    console.log(`🔧 Workflow Type: HOTFIX (Patch Release)`);
    console.log(`🔧 Dry Run: ${dryRun ? "Yes" : "No"}\n`);

    // Initialize hotfix workflow context
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      dryRun,
      stepProgress: [
        { step: 1, name: "Fetch latest main branch", status: "pending" },
        { step: 2, name: "Checkout main branch", status: "pending" },
        { step: 3, name: "Create hotfix branch", status: "pending" },
        { step: 4, name: "Update version to patch RC", status: "pending" },
        { step: 5, name: "Push hotfix branch and tag", status: "pending" },
        { step: 6, name: "Create pull request to main", status: "pending" },
      ],
    };

    try {
      // Execute each step of the hotfix workflow
      await this.executeHotfixStep1_FetchMain();
      await this.executeHotfixStep2_CheckoutMain();
      await this.executeHotfixStep3_CreateHotfixBranch();
      await this.executeHotfixStep4_UpdateVersion();
      await this.executeHotfixStep5_PushBranchAndTag();
      await this.executeHotfixStep6_CreatePullRequest();

      console.log(`\n✅ Hotfix Workflow completed successfully!`);
      return this.context as HotfixWorkflowContext;
    } catch (error) {
      console.error(`\n❌ Hotfix Workflow failed:`, error);

      // Mark current step as failed
      const currentStep = this.context.stepProgress.find(
        (s) => s.status === "in_progress"
      );
      if (currentStep) {
        currentStep.status = "failed";
        currentStep.error =
          error instanceof Error ? error.message : String(error);
      }

      throw error;
    }
  }

  /**
   * Step 1: Make sure main has been merged into develop already
   */
  private async executeStep1_VerifyBranchSync(): Promise<void> {
    const step = this.updateStepStatus(1, "in_progress");
    console.log("📋 Step 1: Verifying main/develop synchronization...");

    try {
      // Use GitFlowManager to verify branch synchronization with real git commands
      const syncResult = await this.gitFlowManager.verifyMainDevelopSync();

      if (!syncResult.canProceed) {
        step.error = syncResult.message;
        throw new Error(
          `Branch synchronization check failed: ${syncResult.message}`
        );
      }

      step.message = syncResult.message;
      this.updateStepStatus(1, "completed");
      console.log(`   ✅ ${syncResult.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 1 failed: ${step.error}`);
    }
  }

  /**
   * Step 2: Checkout the develop branch (with fresh git pull)
   */
  private async executeStep2_CheckoutDevelop(): Promise<void> {
    const step = this.updateStepStatus(2, "in_progress");
    console.log("📋 Step 2: Checking out develop branch...");

    try {
      if (!this.context!.dryRun) {
        // Use GitFlowManager to checkout develop and pull latest changes
        await this.gitFlowManager.checkoutAndPull("develop");
        console.log(
          "   🔄 Checked out develop branch and pulled latest changes"
        );
      } else {
        console.log(
          "   🔄 [DRY RUN] Would checkout develop and pull latest changes"
        );
      }

      this.context!.currentBranch = "develop";
      step.message =
        "Successfully checked out develop branch and pulled latest changes";
      this.updateStepStatus(2, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 2 failed: ${step.error}`);
    }
  }

  /**
   * Step 3: Create a new release branch from develop
   */
  private async executeStep3_CreateReleaseBranch(): Promise<void> {
    const step = this.updateStepStatus(3, "in_progress");
    console.log("📋 Step 3: Creating release branch...");

    try {
      // Get current version to determine the release branch name
      const currentVersion = await this.versionerAdapter.getCurrentVersion();
      const releaseType = (this.context! as ReleaseWorkflowContext).releaseType;

      // Calculate next version based on release type
      let nextVersion: string;
      switch (releaseType) {
        case "major":
          nextVersion = `${currentVersion.major + 1}.0.0`;
          break;
        case "minor":
          nextVersion = `${currentVersion.major}.${currentVersion.minor + 1}.0`;
          break;
        case "patch":
          nextVersion = `${currentVersion.major}.${currentVersion.minor}.${currentVersion.patch + 1}`;
          break;
        default:
          throw new Error(`Invalid release type: ${releaseType}`);
      }

      if (!this.context!.dryRun) {
        // Use GitFlowManager to create the release branch
        const releaseBranchName = await this.gitFlowManager.createReleaseBranch(
          nextVersion
        );
        console.log(`   🔄 Created release branch: ${releaseBranchName}`);
        step.message = `Created release branch: ${releaseBranchName}`;
        // Update context with the actual release branch name
        this.context!.currentBranch = releaseBranchName;
      } else {
        const releaseBranchName = `release/${nextVersion}`;
        console.log(
          `   🔄 [DRY RUN] Would create branch: ${releaseBranchName}`
        );
        step.message = `[DRY RUN] Would create release branch: ${releaseBranchName}`;
        // Update context for dry run as well
        this.context!.currentBranch = releaseBranchName;
      }

      this.updateStepStatus(3, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 3 failed: ${step.error}`);
    }
  }

  /**
   * Step 4: Update the version for the release using versioner RC tools
   */
  private async executeStep4_UpdateVersion(): Promise<void> {
    const step = this.updateStepStatus(4, "in_progress");
    const releaseType = (this.context! as ReleaseWorkflowContext).releaseType;
    console.log(`📋 Step 4: Updating version to ${releaseType} RC...`);

    try {
      if (!this.context!.dryRun) {
        // Use versioner-mcp to create RC based on type
        const newVersion = await this.versionerAdapter.createReleaseCandidate(
          releaseType
        );
        this.context!.targetVersion = newVersion;
        step.message = `Updated version to: ${newVersion.version}`;
        console.log(`   ✅ ${step.message}`);
      } else {
        const currentVersion = await this.versionerAdapter.getCurrentVersion();
        let mockNewVersion: string;

        switch (releaseType) {
          case "major":
            mockNewVersion = `${currentVersion.major + 1}.0.0-RC.0`;
            break;
          case "minor":
            mockNewVersion = `${currentVersion.major}.${
              currentVersion.minor + 1
            }.0-RC.0`;
            break;
          case "patch":
            mockNewVersion = `${currentVersion.major}.${currentVersion.minor}.${
              currentVersion.patch + 1
            }-RC.0`;
            break;
          default:
            throw new Error(`Invalid release type: ${releaseType}`);
        }

        step.message = `[DRY RUN] Would update version to: ${mockNewVersion}`;
        console.log(`   ✅ ${step.message}`);
      }

      this.updateStepStatus(4, "completed");
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 4 failed: ${step.error}`);
    }
  }

  /**
   * Step 5: Push the release branch and git tag
   */
  private async executeStep5_PushBranchAndTag(): Promise<void> {
    const step = this.updateStepStatus(5, "in_progress");
    console.log("📋 Step 5: Pushing release branch and tag...");

    try {
      if (!this.context!.dryRun) {
        const version = this.context!.targetVersion?.version || "unknown";
        const releaseBranch = `release/${version.split("-")[0]}`;

        // Use GitFlowManager to push both branch and tag
        await this.gitFlowManager.pushBranchAndTag(releaseBranch, version);
        console.log(`   🔄 Pushed release branch: ${releaseBranch}`);
        console.log(`   🔄 Pushed version tag: ${version}`);

        step.message = `Pushed release branch and tag: ${version}`;
      } else {
        const version = this.context!.targetVersion?.version || "mock-version";
        step.message = `[DRY RUN] Would push release branch and tag: ${version}`;
      }

      this.updateStepStatus(5, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 5 failed: ${step.error}`);
    }
  }

  /**
   * Step 6: Create pull request from release branch to develop
   */
  private async executeStep6_CreatePullRequest(): Promise<void> {
    const step = this.updateStepStatus(6, "in_progress");
    console.log("📋 Step 6: Creating pull request to develop...");

    try {
      if (!this.context!.dryRun) {
        // Get version from context, fallback to getting current version from versioner
        let version = this.context!.targetVersion?.version;
        if (!version || version === "unknown") {
          const currentVersion =
            await this.versionerAdapter.getCurrentVersion();
          version = currentVersion.version;
        }

        // Get the actual branch name from context instead of reconstructing it
        const currentBranch = (this.context! as ReleaseWorkflowContext)
          .currentBranch;
        const releaseBranch =
          currentBranch || `release/${version.split("-")[0]}`;

        // Generate PR title and body with version information
        const releaseType = (this.context! as ReleaseWorkflowContext)
          .releaseType;
        const prTitle = `RC ${version} to develop`;
        const prBody = this.generateReleaseCandidatePRBody(
          version,
          releaseBranch,
          releaseType
        );

        // Create PR using GitFlowManager
        const prResult = await this.gitFlowManager.createPullRequest(
          releaseBranch,
          "develop",
          prTitle,
          prBody
        );

        // Store PR URL in context
        this.context!.pullRequestUrl = prResult.url;
        (this.context! as ReleaseWorkflowContext).pullRequestAction =
          prResult.action;

        const verb = prResult.action === "updated" ? "Updated" : "Created";
        console.log(`   🔄 ${verb} pull request: ${prResult.url}`);
        step.message = `${verb} pull request: ${prResult.url}`;
      } else {
        // No pull request URL is invented here: a fabricated link is worse than none,
        // because callers cannot tell it from a real one.
        const releaseBranch = this.context!.currentBranch;
        step.message = `Dry run: would open or update PR ${releaseBranch} → develop`;
        console.log(`   ⏭️  ${step.message}`);
        this.updateStepStatus(6, "skipped");
        console.log(`   ✅ ${step.message}`);
        return;
      }

      this.updateStepStatus(6, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 6 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 1: Fetch latest main branch
   */
  private async executeHotfixStep1_FetchMain(): Promise<void> {
    const step = this.updateStepStatus(1, "in_progress");
    console.log("📋 Step 1: Fetching latest main branch...");

    try {
      if (!this.context!.dryRun) {
        // Fetch only main; broad fetches can fail on unrelated branch-name conflicts.
        await this.gitFlowManager.fetchBranch("main");
        console.log("   🔄 Fetched latest main branch from origin");
      } else {
        console.log(
          "   🔄 [DRY RUN] Would fetch latest main branch from origin"
        );
      }

      step.message = "Successfully fetched latest main branch";
      this.updateStepStatus(1, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 1 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 2: Checkout main branch
   */
  private async executeHotfixStep2_CheckoutMain(): Promise<void> {
    const step = this.updateStepStatus(2, "in_progress");
    console.log("📋 Step 2: Checking out main branch...");

    try {
      if (!this.context!.dryRun) {
        // Use GitFlowManager to checkout main and pull latest changes
        await this.gitFlowManager.checkoutAndPull("main");
        console.log("   🔄 Checked out main branch and pulled latest changes");
      } else {
        console.log(
          "   🔄 [DRY RUN] Would checkout main and pull latest changes"
        );
      }

      this.context!.currentBranch = "main";
      step.message =
        "Successfully checked out main branch and pulled latest changes";
      this.updateStepStatus(2, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 2 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 3: Create hotfix branch from main
   */
  private async executeHotfixStep3_CreateHotfixBranch(): Promise<void> {
    const step = this.updateStepStatus(3, "in_progress");
    console.log("📋 Step 3: Creating hotfix branch...");

    try {
      // Get current version to determine the hotfix branch name
      const currentVersion = await this.versionerAdapter.getCurrentVersion();
      const nextVersion = `${currentVersion.major}.${currentVersion.minor}.${
        currentVersion.patch + 1
      }`;

      if (!this.context!.dryRun) {
        // Create hotfix branch (using hotfix/ prefix instead of release/)
        const hotfixBranchName = `hotfix/${nextVersion}`;
        await this.gitFlowManager["execGit"](`checkout -b ${hotfixBranchName}`);
        console.log(`   🔄 Created hotfix branch: ${hotfixBranchName}`);
        step.message = `Created hotfix branch: ${hotfixBranchName}`;
        // Update context with the actual hotfix branch name
        this.context!.currentBranch = hotfixBranchName;
      } else {
        const hotfixBranchName = `hotfix/${nextVersion}`;
        console.log(`   🔄 [DRY RUN] Would create branch: ${hotfixBranchName}`);
        step.message = `[DRY RUN] Would create hotfix branch: ${hotfixBranchName}`;
        // Update context for dry run as well
        this.context!.currentBranch = hotfixBranchName;
      }

      this.updateStepStatus(3, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 3 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 4: Update version to patch RC using versioner
   */
  private async executeHotfixStep4_UpdateVersion(): Promise<void> {
    const step = this.updateStepStatus(4, "in_progress");
    console.log("📋 Step 4: Updating version to patch RC...");

    try {
      if (!this.context!.dryRun) {
        // Use versioner-mcp to create patch RC
        const newVersion =
          await this.versionerAdapter.createPatchReleaseCandidate();
        this.context!.targetVersion = newVersion;
        step.message = `Updated version to: ${newVersion.version}`;
        console.log(`   ✅ ${step.message}`);
      } else {
        const currentVersion = await this.versionerAdapter.getCurrentVersion();
        const mockNewVersion = `${currentVersion.major}.${
          currentVersion.minor
        }.${currentVersion.patch + 1}-RC.0`;
        step.message = `[DRY RUN] Would update version to: ${mockNewVersion}`;
        console.log(`   ✅ ${step.message}`);
      }

      this.updateStepStatus(4, "completed");
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 4 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 5: Push hotfix branch and tag
   */
  private async executeHotfixStep5_PushBranchAndTag(): Promise<void> {
    const step = this.updateStepStatus(5, "in_progress");
    console.log("📋 Step 5: Pushing hotfix branch and tag...");

    try {
      if (!this.context!.dryRun) {
        const version = this.context!.targetVersion?.version || "unknown";
        const hotfixBranch = `hotfix/${version.split("-")[0]}`;

        // Use GitFlowManager to push both branch and tag
        await this.gitFlowManager.pushBranchAndTag(hotfixBranch, version);
        console.log(`   🔄 Pushed hotfix branch: ${hotfixBranch}`);
        console.log(`   🔄 Pushed version tag: ${version}`);

        step.message = `Pushed hotfix branch and tag: ${version}`;
      } else {
        const version = this.context!.targetVersion?.version || "mock-version";
        step.message = `[DRY RUN] Would push hotfix branch and tag: ${version}`;
      }

      this.updateStepStatus(5, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 5 failed: ${step.error}`);
    }
  }

  /**
   * Hotfix Step 6: Create pull request from hotfix branch to main
   */
  private async executeHotfixStep6_CreatePullRequest(): Promise<void> {
    const step = this.updateStepStatus(6, "in_progress");
    console.log("📋 Step 6: Creating pull request to main...");

    try {
      if (!this.context!.dryRun) {
        // Get version from context, fallback to getting current version from versioner
        let version = this.context!.targetVersion?.version;
        if (!version || version === "unknown") {
          const currentVersion =
            await this.versionerAdapter.getCurrentVersion();
          version = currentVersion.version;
        }

        // Get the actual branch name from context instead of reconstructing it
        const currentBranch = (this.context! as HotfixWorkflowContext)
          .currentBranch;
        const hotfixBranch = currentBranch || `hotfix/${version.split("-")[0]}`;

        // Generate PR title and body with hotfix information
        const prTitle = `RC ${version} to main`;
        const prBody = this.generateHotfixPRBody(version, hotfixBranch);

        // A hotfix exists to reach production, so its pull request targets main
        // from the outset. Every later RC increment and the final release update
        // this same head/base pair rather than opening another.
        const prResult = await this.gitFlowManager.createPullRequest(
          hotfixBranch,
          "main",
          prTitle,
          prBody
        );

        // Store PR URL in context
        this.context!.pullRequestUrl = prResult.url;
        (this.context! as HotfixWorkflowContext).pullRequestAction =
          prResult.action;

        const verb = prResult.action === "updated" ? "Updated" : "Created";
        console.log(`   🔄 ${verb} pull request: ${prResult.url}`);
        step.message = `${verb} pull request: ${prResult.url}`;
      } else {
        // No pull request URL is invented here: a fabricated link is worse than none,
        // because callers cannot tell it from a real one.
        const hotfixBranch = this.context!.currentBranch;
        step.message = `Dry run: would open or update PR ${hotfixBranch} → main`;
        console.log(`   ⏭️  ${step.message}`);
        this.updateStepStatus(6, "skipped");
        console.log(`   ✅ ${step.message}`);
        return;
      }

      this.updateStepStatus(6, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 6 failed: ${step.error}`);
    }
  }

  /** Generate the PR body for a hotfix RC targeting main. */
  private generateHotfixPRBody(version: string, hotfixBranch: string): string {
    return `
## Hotfix RC Branch: ${hotfixBranch}

${productionMergeWarning("hotfix")}

This pull request carries the hotfix release candidate **${version}** to main. Each RC increment and the final release update this same pull request.

### 📋 Hotfix RC Information
- **Version**: \`${version}\`
- **Branch**: \`${hotfixBranch}\`
- **Target**: \`main\`
- **Type**: hotfix release candidate

### 🔄 Changes
- Version bump to patch release candidate: \`${version}\`
- Hotfix branch preparation for integration testing

### 🔄 Next Steps
1. **Write the fix** on \`${hotfixBranch}\` and push it
2. **Further candidates**: use \`increment_release_candidate\` while testing
3. **Final release**: use \`release_version\` to promote this hotfix
4. **Deploy to production**, then merge this pull request
5. **Reconcile develop**: use \`downmerge_hotfix_to_develop\`

**Workflow Steps Completed:**
1. ✅ Latest main branch fetched
2. ✅ Main branch checked out and updated
3. ✅ Hotfix branch created from main
4. ✅ Version bumped to patch release candidate
5. ✅ Hotfix branch and tag pushed to origin
6. ✅ Pull request opened to main

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)
    `.trim();
  }

  /**
   * Generate PR body with release information
   */
  private generateReleaseCandidatePRBody(
    version: string,
    releaseBranch: string,
    releaseType: "major" | "minor" | "patch"
  ): string {
    return `
## Release Branch: ${releaseBranch}

This pull request contains the release branch for **${version}**.

### 📋 Release Information
- **Version**: \`${version}\`
- **Branch**: \`${releaseBranch}\`
- **Target**: \`develop\`
- **Type**: ${
      releaseType.charAt(0).toUpperCase() + releaseType.slice(1)
    } Release Candidate

### 🔄 Changes
- Version bump to release candidate: \`${version}\`
- Release branch preparation
- Git Flow workflow automation

**Workflow Steps Completed:**
1. ✅ Main/develop synchronization verified
2. ✅ Develop branch checked out and updated
3. ✅ Release branch created from develop
4. ✅ Version bumped to release candidate
5. ✅ Release branch and tag pushed to origin
6. ✅ Pull request created for integration

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)
    `.trim();
  }

  /**
   * Helper method to update step status
   */
  /** Every workflow context carries dryRun; read it without narrowing the union. */
  private isDryRun(): boolean {
    return this.context?.dryRun === true;
  }

  private updateStepStatus(
    stepNumber: number,
    status: WorkflowStep["status"]
  ): WorkflowStep {
    if (!this.context) {
      throw new Error("Workflow context not initialized");
    }

    const step = this.context.stepProgress.find((s) => s.step === stepNumber);
    if (!step) {
      throw new Error(`Step ${stepNumber} not found in workflow`);
    }

    step.status = status;
    return step;
  }

  /**
   * Get the current workflow context
   */
  getWorkflowContext():
    | ReleaseWorkflowContext
    | HotfixWorkflowContext
    | undefined {
    return this.context;
  }

  /**
   * Get workflow progress summary
   */
  getProgressSummary(): string {
    if (!this.context) {
      return "Workflow not started";
    }

    const summary = this.context.stepProgress
      .map((step) => {
        const statusIcon = {
          pending: "⏳",
          in_progress: "🔄",
          completed: "✅",
          failed: "❌",
          skipped: "⏭️",
        }[step.status];

        const suffix = step.status === "skipped" ? " (skipped)" : "";
        return `${statusIcon} Step ${step.step}: ${step.name}${suffix}`;
      })
      .join("\n");

    return summary;
  }

  /**
   * Execute the increment release candidate workflow (7-step process)
   */
  async executeIncrementRCWorkflow(
    workingDirectory: string,
    version?: string,
    dryRun: boolean = false
  ): Promise<IncrementRCWorkflowContext> {
    console.log(`\n🚀 Starting Increment Release Candidate Workflow`);
    console.log(`📁 Working Directory: ${workingDirectory}`);
    if (version) {
      console.log(`📋 Target Version: ${version}`);
    }
    console.log(`🔧 Dry Run: ${dryRun ? "Yes" : "No"}\n`);

    // Initialize the context before selecting, so a selection failure is attributable
    // to step 1 instead of surfacing as "Workflow not started".
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      dryRun,
      stepProgress: [
        { step: 1, name: "Select Target Branch", status: "pending" },
        { step: 2, name: "Checkout Release/Hotfix Branch", status: "pending" },
        { step: 3, name: "Pull Latest Changes", status: "pending" },
        { step: 4, name: "Validate Branch Version", status: "pending" },
        { step: 5, name: "Increment Release Candidate", status: "pending" },
        { step: 6, name: "Push Changes and Tag", status: "pending" },
        { step: 7, name: "Create Pull Request", status: "pending" },
      ],
    } as IncrementRCWorkflowContext;

    const branchInfo = await this.runSelectionStep(version);

    const incrementCtx = this.context as IncrementRCWorkflowContext;
    incrementCtx.branchType = branchInfo.type;
    incrementCtx.branchInfo = branchInfo;

    console.log(`🎯 Selected Branch: ${branchInfo.name} (${branchInfo.type})`);
    console.log(
      `📊 Version change: ${branchInfo.version.full} → ${predictIncrementedRC(
        branchInfo.version.full
      )}`
    );
    console.log(`🎯 Target PR Branch: ${branchInfo.targetBranch}\n`);

    try {
      // Step 2: Checkout the target branch
      await this.executeIncrementStep2_CheckoutBranch(branchInfo);

      // Step 3: Pull latest changes
      await this.executeIncrementStep3_PullChanges();

      // Step 4: Validate branch version
      await this.executeIncrementStep4_ValidateVersion(branchInfo);

      // Step 5: Increment release candidate
      await this.executeIncrementStep5_IncrementRC();

      // Step 6: Push changes and tag
      await this.executeIncrementStep6_PushChangesAndTag(branchInfo);

      // Step 7: Create pull request
      await this.executeIncrementStep7_CreatePullRequest(branchInfo);

      console.log(`\n✅ Increment RC Workflow completed successfully!`);
      return this.context as IncrementRCWorkflowContext;
    } catch (error) {
      console.error(`\n❌ Increment RC Workflow failed: ${error}`);

      // Mark current step as failed
      if (this.context) {
        const currentStep = (
          this.context as IncrementRCWorkflowContext
        ).stepProgress.find((step) => step.status === "in_progress");
        if (currentStep) {
          currentStep.status = "failed";
          currentStep.error =
            error instanceof Error ? error.message : String(error);
        }
      }

      throw error;
    }
  }

  /**
   * Step 2: Checkout the target branch
   */
  private async executeIncrementStep2_CheckoutBranch(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(2, "in_progress");

    try {
      if (!this.context || !("branchInfo" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      // Clean branch name (remove remotes/origin/ prefix if present)
      const cleanBranchName = branchInfo.name.replace(/^remotes\/origin\//, "");

      if (this.isDryRun()) {
        const step = this.updateStepStatus(2, "skipped");
        step.message = `Dry run: would check out ${cleanBranchName}`;
        console.log(
          `⏭️  Step 2: skipped (dry run) — would check out '${cleanBranchName}'`
        );
        return;
      }

      console.log(`🔄 Step 2: Checking out branch '${cleanBranchName}'`);
      await this.gitFlowManager.checkoutAndPull(cleanBranchName);

      const currentStatus = await this.gitFlowManager.getStatus();
      (this.context as IncrementRCWorkflowContext).currentBranch =
        currentStatus.currentBranch;

      this.updateStepStatus(2, "completed");
    } catch (error) {
      this.updateStepStatus(2, "failed");
      throw error;
    }
  }

  /**
   * Step 3: Pull latest changes
   */
  private async executeIncrementStep3_PullChanges(): Promise<void> {
    this.updateStepStatus(3, "in_progress");

    try {
      if (!this.context || !("branchInfo" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      const branchName = (
        this.context as IncrementRCWorkflowContext
      ).branchInfo.name.replace(/^remotes\/origin\//, "");

      if (this.isDryRun()) {
        const step = this.updateStepStatus(3, "skipped");
        step.message = `Dry run: would pull ${branchName}`;
        console.log(`⏭️  Step 3: skipped (dry run) — would pull ${branchName}`);
        return;
      }

      console.log(`🔄 Step 3: Pulling latest changes from ${branchName}`);
      await this.gitFlowManager.pullBranch(branchName);

      this.updateStepStatus(3, "completed");
    } catch (error) {
      this.updateStepStatus(3, "failed");
      throw error;
    }
  }

  /**
   * Step 4: Validate branch version
   */
  private async executeIncrementStep4_ValidateVersion(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(4, "in_progress");

    try {
      console.log(
        `🔄 Step 4: Validating ${branchInfo.name} version against ${branchInfo.baseBranch}`
      );

      if (!this.context || !("dryRun" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      // Validation runs in dry run too. These checks are read-only, and skipping them
      // was what let a dry run pass and the real run then fail on the same input.
      const currentVersion = await this.versionerAdapter.getCurrentVersion();

      if (!currentVersion.version.includes("-RC.")) {
        throw new Error(
          `Branch ${branchInfo.name} version ${currentVersion.version} is not a release candidate. Only RC versions can be incremented.`
        );
      }

      console.log(
        `✅ RC validation passed: ${currentVersion.version} is a release candidate`
      );

      const validation = await this.gitFlowManager.validateBranchVersion(
        branchInfo
      );

      if (!validation.valid) {
        throw new Error(validation.message);
      }

      console.log(`✅ Version validation passed: ${validation.message}`);

      this.updateStepStatus(4, "completed");
    } catch (error) {
      this.updateStepStatus(4, "failed");
      throw error;
    }
  }

  /**
   * Step 5: Increment release candidate
   */
  private async executeIncrementStep5_IncrementRC(): Promise<void> {
    this.updateStepStatus(5, "in_progress");

    try {
      if (!this.context || !("dryRun" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      console.log(`🔄 Step 5: Incrementing release candidate version`);

      if (!(this.context as IncrementRCWorkflowContext).dryRun) {
        const newVersion =
          await this.versionerAdapter.incrementReleaseCandidate();
        (this.context as IncrementRCWorkflowContext).targetVersion = newVersion;

        console.log(`🎯 New version: ${newVersion.version}`);
      } else {
        console.log(`🔧 Dry run: Would increment RC version`);
      }

      this.updateStepStatus(5, "completed");
    } catch (error) {
      this.updateStepStatus(5, "failed");
      throw error;
    }
  }

  /**
   * Step 6: Push changes and tag
   */
  private async executeIncrementStep6_PushChangesAndTag(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(6, "in_progress");

    try {
      if (!this.context || !("dryRun" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      const branchName = branchInfo.name.replace(/^remotes\/origin\//, "");

      console.log(`🔄 Step 6: Pushing changes and tag for ${branchName}`);

      if (!(this.context as IncrementRCWorkflowContext).dryRun) {
        const targetVersion = (this.context as IncrementRCWorkflowContext)
          .targetVersion;
        if (!targetVersion) {
          throw new Error("Target version not available for push operation");
        }

        const tagName = targetVersion.version;

        // Push the branch and tag
        await this.gitFlowManager.pushBranchAndTag(branchName, tagName);

        console.log(`🚀 Pushed ${branchName} and tag ${tagName}`);
      } else {
        console.log(`🔧 Dry run: Would push branch and create tag`);
      }

      this.updateStepStatus(6, "completed");
    } catch (error) {
      this.updateStepStatus(6, "failed");
      throw error;
    }
  }

  /**
   * Step 7: Create pull request
   */
  private async executeIncrementStep7_CreatePullRequest(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(7, "in_progress");

    try {
      if (!this.context || !("dryRun" in this.context)) {
        throw new Error("Invalid context for increment RC workflow");
      }

      const branchName = branchInfo.name.replace(/^remotes\/origin\//, "");
      // A release candidate integrates back into its own base: a release branch
      // into develop, a hotfix into main.
      const targetBranch = branchInfo.targetBranch;
      const targetVersion = (this.context as IncrementRCWorkflowContext)
        .targetVersion;

      console.log(
        `🔄 Step 7: Creating PR from ${branchName} to ${targetBranch}`
      );

      if (!(this.context as IncrementRCWorkflowContext).dryRun) {
        const prTitle = `RC ${
          targetVersion?.version || "new version"
        } to ${targetBranch}`;

        const warning =
          targetBranch === "main"
            ? `\n${productionMergeWarning(branchInfo.type)}\n`
            : "";

        const prBody = `## ${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        } Candidate Increment
${warning}
This PR increments the release candidate version for \`${branchName}\`.

### 📋 ${branchInfo.type === "release" ? "Release" : "Hotfix"} RC Information
- **Version**: \`${targetVersion?.version || "new version"}\`
- **Branch**: \`${branchName}\`
- **Target**: \`${targetBranch}\`
- **Type**: release candidate

### 🔄 Changes
- Incremented RC version to ${targetVersion?.version || "new version"}
- Updated VERSION file and git tag

**Workflow Steps Completed:**
1. ✅ Select Target Branch
2. ✅ Checkout Release/Hotfix Branch
3. ✅ Pull Latest Changes
4. ✅ Validate Branch Version
5. ✅ Increment Release Candidate
6. ✅ Push Changes and Tag
7. ✅ Create Pull Request

### 🔄 Next Steps
1. **Final release**: Use \`release_version\` tool when ready for production

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

        try {
          const prResult = await this.gitFlowManager.createPullRequest(
            branchName,
            targetBranch,
            prTitle,
            prBody
          );

          const ctx = this.context as IncrementRCWorkflowContext;
          ctx.pullRequestUrl = prResult.url;
          ctx.pullRequestAction = prResult.action;
          const verb = prResult.action === "updated" ? "Updated" : "Created";
          console.log(`🔗 ${verb} PR: ${prResult.url}`);
        } catch (prError) {
          const msg =
            prError instanceof Error ? prError.message : String(prError);
          // Don't fail the entire workflow — the version bump already succeeded —
          // but capture the error so the MCP output surfaces it to the user.
          (this.context as IncrementRCWorkflowContext).pullRequestError = msg;
          console.warn(`⚠️  Failed to create/update PR (continuing): ${msg}`);
        }
      } else {
        console.log(
          `🔧 Dry run: Would create PR from ${branchName} to ${targetBranch}`
        );
      }

      this.updateStepStatus(7, "completed");
    } catch (error) {
      this.updateStepStatus(7, "failed");
      throw error;
    }
  }

  /**
   * Execute the release version workflow (9-step process)
   */
  async executeReleaseWorkflow(
    workingDirectory: string,
    version?: string,
    dryRun: boolean = false
  ): Promise<ReleaseVersionWorkflowContext> {
    console.log(`\n🚀 Starting Release Version Workflow`);
    console.log(`📁 Working Directory: ${workingDirectory}`);
    if (version) {
      console.log(`📋 Specified Version: ${version}`);
    }
    console.log(`🔧 Dry Run: ${dryRun ? "Yes" : "No"}\n`);

    // Initialize the context before selecting, so a selection failure is attributable
    // to step 1 instead of surfacing as "Workflow not started".
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      dryRun,
      stepProgress: [
        { step: 1, name: "Select Target Branch", status: "pending" },
        { step: 2, name: "Checkout Release/Hotfix Branch", status: "pending" },
        { step: 3, name: "Pull Latest Changes", status: "pending" },
        { step: 4, name: "Release Version (RC → Final)", status: "pending" },
        { step: 5, name: "Push Changes", status: "pending" },
        { step: 6, name: "Push Version Tag", status: "pending" },
        { step: 7, name: "Create Pull Request", status: "pending" },
        {
          step: 8,
          name: "Add Hotfix Warning (if applicable)",
          status: "pending",
        },
        { step: 9, name: "Create GitHub Release", status: "pending" },
      ],
    } as ReleaseVersionWorkflowContext;

    const branchInfo = await this.runSelectionStep(version);

    const releaseCtx = this.context as ReleaseVersionWorkflowContext;
    releaseCtx.branchType = branchInfo.type;
    releaseCtx.branchInfo = branchInfo;

    console.log(`🎯 Selected Branch: ${branchInfo.name} (${branchInfo.type})`);
    console.log(
      `📊 Version change: ${branchInfo.version.full} → ${predictPromotedVersion(
        branchInfo.version.full
      )}`
    );
    console.log(`🎯 Target PR Branch: ${branchInfo.targetBranch}\n`);

    try {
      // Step 2: Checkout the target branch
      await this.executeReleaseStep2_CheckoutBranch(branchInfo);

      // Step 3: Pull latest changes
      await this.executeReleaseStep3_PullChanges();

      // Step 4: Release version (RC → Final)
      await this.executeReleaseStep4_ReleaseVersion();

      // Step 5: Push changes
      await this.executeReleaseStep5_PushChanges(branchInfo);

      // Step 6: Push version tag
      await this.executeReleaseStep6_PushTag();

      // Step 7: Create pull request
      await this.executeReleaseStep7_CreatePullRequest(branchInfo);

      // Step 8: Add hotfix warning (if applicable)
      await this.executeReleaseStep8_HotfixWarning(branchInfo);

      // Step 9: Create GitHub Release
      await this.executeReleaseStep9_CreateGitHubRelease(branchInfo);

      console.log(`\n✅ Release Version Workflow completed successfully!`);
      return this.context as ReleaseVersionWorkflowContext;
    } catch (error) {
      console.error(`\n❌ Release Version Workflow failed: ${error}`);

      // Mark current step as failed
      if (this.context) {
        const currentStep = (
          this.context as ReleaseVersionWorkflowContext
        ).stepProgress.find((step) => step.status === "in_progress");
        if (currentStep) {
          currentStep.status = "failed";
          currentStep.error =
            error instanceof Error ? error.message : String(error);
        }
      }

      throw error;
    }
  }

  /**
   * Describe what incrementing the release candidate would do, changing nothing.
   *
   * Selection, version resolution and every fact in the plan come from read-only
   * primitives, so this is safe to call before the operator has decided anything.
   */
  async planIncrementRC(version?: string): Promise<ChangePlan> {
    const branchInfo = await this.selectTargetReleaseBranch(version);
    const branch = branchInfo.name.replace(/^remotes\/origin\//, "");
    const currentVersion = branchInfo.version.full;
    const resultingVersion = predictIncrementedRC(currentVersion);

    return this.buildVersionBumpPlan({
      action: "increment_release_candidate",
      branch,
      currentVersion,
      resultingVersion,
      prBase: branchInfo.targetBranch,
      createsGitHubRelease: false,
    });
  }

  /**
   * Describe what promoting the release candidate to a final version would do,
   * changing nothing.
   */
  async planReleaseVersion(version?: string): Promise<ChangePlan> {
    const branchInfo = await this.selectTargetReleaseBranch(version);
    const branch = branchInfo.name.replace(/^remotes\/origin\//, "");
    const currentVersion = branchInfo.version.full;
    const resultingVersion = predictPromotedVersion(currentVersion);

    return this.buildVersionBumpPlan({
      action: "release_version",
      branch,
      currentVersion,
      resultingVersion,
      prBase: "main",
      createsGitHubRelease: true,
    });
  }

  /**
   * Shared plan shape for the two workflows that rewrite VERSION on an existing
   * branch: one commit, one annotated tag, two pushes, a pull request, and for a
   * final release a GitHub release.
   */
  private async buildVersionBumpPlan(opts: {
    action: string;
    branch: string;
    currentVersion: string;
    resultingVersion: string;
    prBase: string;
    createsGitHubRelease: boolean;
  }): Promise<ChangePlan> {
    const { action, branch, currentVersion, resultingVersion, prBase } = opts;

    // Refuse rather than describing an impossible change. Without this the
    // not-a-release-candidate sentinel would leak into every mutation summary and
    // the plan would read as though the action were viable.
    if (!currentVersion.includes("-RC.")) {
      throw new BranchSelectionError(
        `${branch} is at ${currentVersion}, which is not a release candidate, so ` +
          `${action} cannot be planned for it. Use list_versions to find a branch ` +
          `holding an RC.`
      );
    }

    const targetBranchHead = await this.gitFlowManager.getBranchHead(branch);
    const warnings: string[] = [];

    if (await this.gitFlowManager.tagExistsRemotely(resultingVersion)) {
      warnings.push(
        `Tag ${resultingVersion} already exists on origin; pushing it will fail.`
      );
    } else if (await this.gitFlowManager.tagExistsLocally(resultingVersion)) {
      warnings.push(
        `Tag ${resultingVersion} already exists locally; creating it will fail.`
      );
    }

    const existingPr = await this.gitFlowManager.findOpenPullRequest(
      branch,
      prBase
    );
    if (existingPr) {
      warnings.push(
        `PR #${existingPr.number} is already open for ${branch} → ${prBase}; it will be updated, not created.`
      );
    }

    const mutations: PlannedMutation[] = [
      {
        kind: "commit",
        summary: `"To version ${resultingVersion}" on ${branch}`,
        detail: { files: "VERSION" },
      },
      {
        kind: "tag",
        summary: `annotated tag ${resultingVersion}`,
        detail: { message: `Release version ${resultingVersion}` },
      },
      {
        kind: "push",
        summary: `${branch} and tag ${resultingVersion} to origin`,
      },
      {
        kind: "pull-request",
        summary: existingPr
          ? `update PR #${existingPr.number} (${branch} → ${prBase})`
          : `open ${branch} → ${prBase}`,
      },
    ];

    if (opts.createsGitHubRelease) {
      mutations.push({
        kind: "github-release",
        summary: `${resultingVersion} with auto-generated notes`,
        detail: { targetCommitish: branch },
      });
    }

    return buildChangePlan({
      action,
      targetBranch: branch,
      targetBranchHead,
      currentVersion,
      resultingVersion,
      mutations,
      warnings,
    });
  }

  /**
   * Describe what cutting a new release branch off develop would do, changing
   * nothing.
   */
  async planCreateReleaseCandidate(
    releaseType: "major" | "minor" | "patch"
  ): Promise<ChangePlan> {
    return this.buildBranchCreationPlan({
      action: "create_release_candidate",
      baseBranch: "develop",
      branchType: "release",
      prBase: "develop",
      nextBaseVersion: (v) => {
        switch (releaseType) {
          case "major":
            return `${v.major + 1}.0.0`;
          case "minor":
            return `${v.major}.${v.minor + 1}.0`;
          case "patch":
            return `${v.major}.${v.minor}.${v.patch + 1}`;
        }
      },
      extraWarnings: await this.describeMainDevelopSync(),
    });
  }

  /**
   * Describe what cutting a new hotfix branch off main would do, changing nothing.
   */
  async planCreateHotfix(): Promise<ChangePlan> {
    return this.buildBranchCreationPlan({
      action: "create_hotfix",
      baseBranch: "main",
      branchType: "hotfix",
      prBase: "main",
      nextBaseVersion: (v) => `${v.major}.${v.minor}.${v.patch + 1}`,
    });
  }

  /**
   * Shared plan shape for the two workflows that cut a branch off a base and set
   * it to an RC.0: a branch, a commit, an annotated tag, two pushes and a pull
   * request.
   */
  private async buildBranchCreationPlan(opts: {
    action: string;
    baseBranch: "develop" | "main";
    branchType: BranchType;
    prBase: "develop" | "main";
    nextBaseVersion: (parts: VersionParts) => string;
    extraWarnings?: string[];
  }): Promise<ChangePlan> {
    const { action, baseBranch, branchType, prBase } = opts;

    // Resolve the head first and read VERSION at that exact commit, so the version
    // the plan states and the commit it is anchored to cannot disagree.
    const baseBranchHead = await this.gitFlowManager.getBranchHead(baseBranch);
    const currentVersion = await this.gitFlowManager.readBranchVersion(
      baseBranchHead
    );
    if (!currentVersion) {
      throw new BranchSelectionError(
        `${baseBranch} has no readable VERSION file at ` +
          `${baseBranchHead.slice(0, 11)}, so ${action} cannot be planned. ` +
          `Use initialize_versioner to create one.`
      );
    }

    // The versioner refuses to open a new release candidate while one is still
    // active, so a plan that promised the transition would be describing a change
    // the apply cannot make.
    if (currentVersion.includes("-RC.")) {
      throw new BranchSelectionError(
        `${baseBranch} is at ${currentVersion}, which is still an active release ` +
          `candidate, so ${action} cannot be planned. Promote or retire that candidate ` +
          `first — release_version on its branch, then downmerge it into ${baseBranch} — ` +
          `so ${baseBranch} holds a final version.`
      );
    }

    const parts = parseVersionParts(currentVersion);
    if (!parts) {
      throw new BranchSelectionError(
        `${baseBranch} is at '${currentVersion}', which is not a semantic version, ` +
          `so ${action} cannot be planned.`
      );
    }

    const nextVersion = opts.nextBaseVersion(parts);
    const newBranch = `${branchType}/${nextVersion}`;
    const rcVersion = `${nextVersion}-RC.0`;
    const warnings = [...(opts.extraWarnings ?? [])];

    const existing = await this.gitFlowManager.findBranchesOfType(branchType);
    const alreadyExists = existing.some(
      (b) => b.name.replace(/^remotes\/origin\//, "") === newBranch
    );
    if (alreadyExists) {
      warnings.push(`Branch ${newBranch} already exists; creating it will fail.`);
    }

    if (await this.gitFlowManager.tagExistsRemotely(rcVersion)) {
      warnings.push(
        `Tag ${rcVersion} already exists on origin; pushing it will fail.`
      );
    } else if (await this.gitFlowManager.tagExistsLocally(rcVersion)) {
      warnings.push(
        `Tag ${rcVersion} already exists locally; creating it will fail.`
      );
    }

    const existingPr = await this.gitFlowManager.findOpenPullRequest(
      newBranch,
      prBase
    );
    if (existingPr) {
      warnings.push(
        `PR #${existingPr.number} is already open for ${newBranch} → ${prBase}; it will be updated, not created.`
      );
    }

    const mutations: PlannedMutation[] = [
      {
        kind: "branch",
        summary: `${newBranch} off ${baseBranch}`,
      },
      {
        kind: "commit",
        summary: `"To version ${rcVersion}" on ${newBranch}`,
        detail: { files: "VERSION" },
      },
      {
        kind: "tag",
        summary: `annotated tag ${rcVersion}`,
        detail: { message: `Release version ${rcVersion}` },
      },
      {
        kind: "push",
        summary: `${newBranch} and tag ${rcVersion} to origin`,
      },
      {
        kind: "pull-request",
        summary: existingPr
          ? `update PR #${existingPr.number} (${newBranch} → ${prBase})`
          : `open ${newBranch} → ${prBase}`,
        detail: { title: `RC ${rcVersion} to ${prBase}` },
      },
    ];

    return buildChangePlan({
      action,
      targetBranch: baseBranch,
      targetBranchHead: baseBranchHead,
      currentVersion,
      resultingVersion: rcVersion,
      mutations,
      warnings,
    });
  }

  /**
   * Describe what merging main back into develop would do, changing nothing.
   */
  async planDownmergeMainToDevelop(): Promise<ChangePlan> {
    const { title } = await this.gitFlowManager.describeMainDownmerge();

    return this.buildMergeBranchDownmergePlan({
      action: "downmerge_main_to_develop",
      baseBranch: "develop",
      sourceBranch: "main",
      mergeBranch: "main-into-develop-<unix-timestamp>",
      mergeCommitMessage: "Downmerge main into develop",
      prTitle: title,
    });
  }

  /**
   * Describe what merging a release branch into main would do, changing nothing.
   */
  async planDownmergeReleaseToMain(version?: string): Promise<ChangePlan> {
    const { branch, cleanName } =
      await this.gitFlowManager.resolveDownmergeBranch("release", version);

    return this.buildMergeBranchDownmergePlan({
      action: "downmerge_release_to_main",
      baseBranch: "main",
      sourceBranch: cleanName,
      mergeBranch: `release-${branch.version.full}-into-main-<unix-timestamp>`,
      mergeCommitMessage: `Merge ${cleanName} into main`,
      prTitle: `Release ${branch.version.full} to main`,
    });
  }

  /**
   * Describe what merging a hotfix back into develop would do, changing nothing.
   */
  async planDownmergeHotfixToDevelop(version?: string): Promise<ChangePlan> {
    const { branch, cleanName } =
      await this.gitFlowManager.resolveDownmergeBranch("hotfix", version);

    return this.buildMergeBranchDownmergePlan({
      action: "downmerge_hotfix_to_develop",
      baseBranch: "develop",
      sourceBranch: cleanName,
      mergeBranch: `hotfix-${branch.version.full}-into-develop-<unix-timestamp>`,
      mergeCommitMessage: `Merge ${cleanName} into develop`,
      prTitle: `Hotfix ${branch.version.full} to develop`,
    });
  }

  /**
   * Shared plan shape for the downmerges that go through a merge branch: a branch
   * off the base with the source merged in, a merge commit, one push and a pull
   * request. Each aborts without creating anything if the merge conflicts.
   *
   * The merge branch carries a Unix timestamp the plan cannot predict, so it is
   * named by its pattern. The source branch's head goes into a mutation summary,
   * which the digest covers, so a push to either side invalidates the plan.
   */
  private async buildMergeBranchDownmergePlan(opts: {
    action: string;
    baseBranch: "develop" | "main";
    sourceBranch: string;
    mergeBranch: string;
    mergeCommitMessage: string;
    prTitle: string;
  }): Promise<ChangePlan> {
    const { action, baseBranch, sourceBranch, mergeBranch } = opts;

    const baseBranchHead = await this.gitFlowManager.getBranchHead(baseBranch);
    const sourceHead = await this.gitFlowManager.getBranchHead(sourceBranch);
    const warnings: string[] = [];

    if (await this.gitFlowManager.checkIsAncestor(sourceHead, baseBranchHead)) {
      warnings.push(
        `${sourceBranch} is already merged into ${baseBranch}; the merge produces no ` +
          `commit and the pull request would be empty.`
      );
    }

    const probe = await this.gitFlowManager.previewMergeConflicts(
      baseBranchHead,
      sourceHead
    );
    if (probe.hasConflicts) {
      warnings.push(
        `Merging ${sourceBranch} into ${baseBranch} conflicts in ` +
          `${probe.conflictedFiles.length} file(s): ${probe.conflictedFiles.join(", ")}. ` +
          `The action aborts the merge, deletes the temporary branch, and creates nothing.`
      );
    }

    const mutations: PlannedMutation[] = [
      {
        kind: "branch",
        summary: `${mergeBranch} off ${baseBranch}, merging ${sourceBranch} at ${sourceHead.slice(0, 11)}`,
      },
      {
        kind: "commit",
        summary: `merge commit "${opts.mergeCommitMessage}" on ${mergeBranch}`,
      },
      { kind: "push", summary: `${mergeBranch} to origin` },
      {
        kind: "pull-request",
        summary: `open ${mergeBranch} → ${baseBranch}`,
        detail: { title: opts.prTitle },
      },
    ];

    return buildChangePlan({
      action,
      targetBranch: baseBranch,
      targetBranchHead: baseBranchHead,
      mutations,
      warnings,
    });
  }

  /**
   * Describe what merging a release branch back into develop would do, changing
   * nothing.
   *
   * The outcome depends on whether the merge conflicts, so the plan previews it
   * with `merge-tree` and describes only the path that would actually be taken.
   */
  async planDownmergeReleaseToDevelop(version?: string): Promise<ChangePlan> {
    const { branch, cleanName } =
      await this.gitFlowManager.resolveDownmergeBranch("release", version);
    const releaseVersion = branch.version.full;

    const baseBranchHead = await this.gitFlowManager.getBranchHead("develop");
    const sourceHead = await this.gitFlowManager.getBranchHead(cleanName);
    const shortSource = sourceHead.slice(0, 11);
    const warnings: string[] = [];
    const mutations: PlannedMutation[] = [];

    const probe = await this.gitFlowManager.previewMergeConflicts(
      baseBranchHead,
      sourceHead
    );
    const existingPr = await this.gitFlowManager.findOpenPullRequest(
      cleanName,
      "develop"
    );

    if (!probe.hasConflicts) {
      if (
        await this.gitFlowManager.checkIsAncestor(sourceHead, baseBranchHead)
      ) {
        warnings.push(
          `${cleanName} is already merged into develop; the pull request would be empty.`
        );
      }
      if (existingPr) {
        warnings.push(
          `PR #${existingPr.number} is already open for ${cleanName} → develop; it will be updated, not created.`
        );
      }
      mutations.push({
        kind: "pull-request",
        summary: existingPr
          ? `update PR #${existingPr.number} (${cleanName} at ${shortSource} → develop)`
          : `open ${cleanName} at ${shortSource} → develop`,
        detail: { title: `Release ${releaseVersion} to develop` },
      });

      return buildChangePlan({
        action: "downmerge_release_to_develop",
        targetBranch: "develop",
        targetBranchHead: baseBranchHead,
        mutations,
        warnings,
      });
    }

    const mergeBranch = `release-${releaseVersion}-into-develop-<unix-timestamp>`;
    warnings.push(
      `Merging ${cleanName} into develop conflicts in ${probe.conflictedFiles.length} ` +
        `file(s): ${probe.conflictedFiles.join(", ")}. They are committed with their ` +
        `markers intact, for resolution in the draft pull request.`
    );

    mutations.push(
      {
        kind: "branch",
        summary: `${mergeBranch} off develop, merging ${cleanName} at ${shortSource}`,
      },
      {
        kind: "commit",
        summary: `merge commit "Merge ${cleanName} into develop (conflicts unresolved — needs manual resolution)" on ${mergeBranch}`,
        detail: { files: probe.conflictedFiles.join(", ") },
      },
      { kind: "push", summary: `${mergeBranch} to origin` },
      {
        kind: "pull-request",
        summary: `open draft ${mergeBranch} → develop`,
        detail: { title: `Release ${releaseVersion} to develop (conflict resolution)` },
      }
    );

    if (existingPr) {
      warnings.push(
        `PR #${existingPr.number} is already open for ${cleanName} → develop, so the ` +
          `transient build-trigger pull request is skipped and CI is not re-triggered.`
      );
    } else {
      mutations.push({
        kind: "pull-request",
        summary: `open ${cleanName} → develop as a transient build trigger, then close it`,
        detail: { title: `[Build trigger] Release ${releaseVersion} → develop` },
      });
    }

    return buildChangePlan({
      action: "downmerge_release_to_develop",
      targetBranch: "develop",
      targetBranchHead: baseBranchHead,
      mutations,
      warnings,
    });
  }

  /**
   * Describe what opening the hotfix → main pull request would do, changing
   * nothing.
   *
   * A conflict is information rather than a blocker here: the pull request still
   * opens, and GitHub reports the conflict on it.
   */
  async planDownmergeHotfixToMain(version?: string): Promise<ChangePlan> {
    const { branch, cleanName } =
      await this.gitFlowManager.resolveDownmergeBranch("hotfix", version);

    const baseBranchHead = await this.gitFlowManager.getBranchHead("main");
    const sourceHead = await this.gitFlowManager.getBranchHead(cleanName);
    const warnings: string[] = [];

    if (await this.gitFlowManager.checkIsAncestor(sourceHead, baseBranchHead)) {
      warnings.push(
        `${cleanName} is already merged into main; the pull request would be empty.`
      );
    }

    const probe = await this.gitFlowManager.previewMergeConflicts(
      baseBranchHead,
      sourceHead
    );
    if (probe.hasConflicts) {
      warnings.push(
        `${cleanName} conflicts with main in ${probe.conflictedFiles.length} file(s): ` +
          `${probe.conflictedFiles.join(", ")}. The pull request still opens, recording ` +
          `the conflict in its body.`
      );
    }

    const existingPr = await this.gitFlowManager.findOpenPullRequest(
      cleanName,
      "main"
    );
    if (existingPr) {
      warnings.push(
        `PR #${existingPr.number} is already open for ${cleanName} → main; it will be updated, not created.`
      );
    }

    const shortSource = sourceHead.slice(0, 11);
    const mutations: PlannedMutation[] = [
      {
        kind: "pull-request",
        summary: existingPr
          ? `update PR #${existingPr.number} (${cleanName} at ${shortSource} → main)`
          : `open ${cleanName} at ${shortSource} → main`,
        detail: { title: `Release ${branch.version.full} to main` },
      },
    ];

    return buildChangePlan({
      action: "downmerge_hotfix_to_main",
      targetBranch: "main",
      targetBranchHead: baseBranchHead,
      mutations,
      warnings,
    });
  }

  /**
   * The read-only half of the main/develop synchronisation check that gates
   * creating a release branch.
   *
   * Compares the remote-tracking refs as they currently stand, because planning
   * must not write refs and a fetch would.
   */
  private async describeMainDevelopSync(): Promise<string[]> {
    const merged = await this.gitFlowManager.checkIsAncestor(
      "origin/main",
      "origin/develop"
    );
    if (merged) {
      return [];
    }

    const { ahead } = await this.gitFlowManager.compareBranches(
      "origin/main",
      "origin/develop"
    );
    if (ahead === 0) {
      return [];
    }

    const hasContentDiff = await this.gitFlowManager.checkContentDiff(
      "origin/develop",
      "origin/main"
    );
    if (!hasContentDiff) {
      return [];
    }

    return [
      `origin/main has ${ahead} commit(s) whose content is not in origin/develop, ` +
        `so the synchronization check aborts the action. This compares the ` +
        `remote-tracking refs as they stand; the action fetches them first.`,
    ];
  }

  /**
   * Run branch selection as step 1, so a failure is attributed to a step rather than
   * surfacing as "Workflow not started".
   */
  private async runSelectionStep(version?: string): Promise<BranchTypeInfo> {
    this.updateStepStatus(1, "in_progress");
    try {
      const branchInfo = await this.selectTargetReleaseBranch(version);
      const step = this.updateStepStatus(1, "completed");
      step.message = `Selected ${branchInfo.name} (${branchInfo.version.full})`;
      return branchInfo;
    } catch (error) {
      const step = this.updateStepStatus(1, "failed");
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Step 1: Enhanced branch selection algorithm for release workflow
   */
  private async selectTargetReleaseBranch(
    version?: string
  ): Promise<BranchTypeInfo> {
    try {
      // Option 1: Use provided version parameter to find matching branches
      if (version) {
        console.log(
          `🔍 Looking for release/{version} or hotfix/{version} branches...`
        );

        // Try to find release/{version} branch
        const releaseBranches = await this.gitFlowManager.findBranchesOfType(
          "release"
        );
        const releaseMatch = releaseBranches.find(
          (b) =>
            b.version.major + "." + b.version.minor + "." + b.version.patch ===
            version
        );

        // Try to find hotfix/{version} branch
        const hotfixBranches = await this.gitFlowManager.findBranchesOfType(
          "hotfix"
        );
        const hotfixMatch = hotfixBranches.find(
          (b) =>
            b.version.major + "." + b.version.minor + "." + b.version.patch ===
            version
        );

        if (releaseMatch && hotfixMatch) {
          throw new BranchSelectionError(
            `Ambiguous: Both release/${version} and hotfix/${version} branches exist. Please specify the full branch name.`
          );
        }

        if (releaseMatch) {
          const resolved = await this.resolveBranchVersion(releaseMatch);
          console.log(`📋 Found release branch: ${releaseMatch.name}`);
          return resolved ?? releaseMatch;
        }

        if (hotfixMatch) {
          const resolved = await this.resolveBranchVersion(hotfixMatch);
          console.log(`📋 Found hotfix branch: ${hotfixMatch.name}`);
          return resolved ?? hotfixMatch;
        }

        throw new BranchSelectionError(
          `No release/${version} or hotfix/${version} branch found for version ${version}`
        );
      }

      // Option 2: prefer the branch that is actually checked out.
      const currentStatus = await this.gitFlowManager.getStatus();
      const currentBranchType = this.gitFlowManager.detectBranchType(
        currentStatus.currentBranch
      );
      let currentBranchInfo: BranchTypeInfo | null = null;

      if (currentBranchType) {
        const branches = await this.gitFlowManager.findBranchesOfType(
          currentBranchType
        );
        const match = branches.find(
          (b) =>
            b.name === currentStatus.currentBranch ||
            b.name.endsWith(`/${currentStatus.currentBranch}`)
        );
        if (match) {
          currentBranchInfo = await this.resolveBranchVersion(match);
        }

        if (currentBranchInfo?.version.full.includes("-RC.")) {
          console.log(
            `📋 Using checked-out ${currentBranchType} branch: ` +
              `${currentStatus.currentBranch} (${currentBranchInfo.version.full})`
          );
          return currentBranchInfo;
        }

        // Standing on a release/hotfix branch that did not qualify. Auto-selecting a
        // different branch from here is how an unrelated release train gets modified.
        const detail = currentBranchInfo
          ? `is at ${currentBranchInfo.version.full}, which is not a release candidate`
          : `has no readable VERSION file`;
        throw new BranchSelectionError(
          `Checked-out branch '${currentStatus.currentBranch}' ${detail}. ` +
            `Refusing to auto-select a different branch, because that would modify a release ` +
            `train you are not on. Either pass an explicit version, or check out the branch you ` +
            `intend to act on. Use list_versions to see every candidate.`
        );
      }

      // Option 3: not on a release/hotfix branch — fall back to the most recent RC.
      const latestRelease = await this.findLatestRCBranch("release");
      const latestHotfix = await this.findLatestRCBranch("hotfix");

      if (!latestRelease && !latestHotfix) {
        throw new BranchSelectionError(
          "No release candidate branches found. Cannot determine target branch for release."
        );
      }

      // If only one type exists, use it
      if (latestRelease && !latestHotfix) {
        console.log(`📋 Using latest release RC branch: ${latestRelease.name}`);
        return latestRelease;
      }

      if (latestHotfix && !latestRelease) {
        console.log(`📋 Using latest hotfix RC branch: ${latestHotfix.name}`);
        return latestHotfix;
      }

      // If both exist, compare versions and use the latest
      if (latestRelease && latestHotfix) {
        const releaseVersion = latestRelease.version;
        const hotfixVersion = latestHotfix.version;

        // Compare semantic versions
        let useRelease = false;
        if (releaseVersion.major > hotfixVersion.major) {
          useRelease = true;
        } else if (releaseVersion.major === hotfixVersion.major) {
          if (releaseVersion.minor > hotfixVersion.minor) {
            useRelease = true;
          } else if (releaseVersion.minor === hotfixVersion.minor) {
            useRelease = releaseVersion.patch >= hotfixVersion.patch;
          }
        }

        const selectedBranch = useRelease ? latestRelease : latestHotfix;
        const other = useRelease ? latestHotfix : latestRelease;
        console.warn(
          `⚠️  Auto-selected the most recent RC branch: ${selectedBranch.name} ` +
            `(${selectedBranch.version.full}). Other candidate: ${other.name} ` +
            `(${other.version.full}). Pass an explicit version to choose deliberately.`
        );
        return selectedBranch;
      }

      throw new Error("Unexpected error in release branch selection logic");
    } catch (error) {
      if (error instanceof BranchSelectionError) {
        throw error;
      }
      throw new Error(`Failed to select target release branch: ${error}`);
    }
  }

  /**
   * Read a branch's authoritative version from its VERSION file.
   *
   * Branch names never carry the RC suffix — `hotfix/4.124.1` holds `4.124.1-RC.2` — so
   * any decision that depends on RC state must read the file rather than parse the name.
   * Returns null when the branch has no readable, parseable VERSION file.
   */
  private async resolveBranchVersion(
    branch: BranchTypeInfo
  ): Promise<BranchTypeInfo | null> {
    const versionContent = await this.gitFlowManager.readBranchVersion(
      branch.name
    );
    if (versionContent === null) {
      console.warn(`Could not read a version from ${branch.name}:VERSION`);
      return null;
    }

    const versionMatch = versionContent.match(
      /^(\d+)\.(\d+)\.(\d+)(-RC\.\d+)?/
    );
    if (!versionMatch) {
      console.warn(`Could not parse a version from ${branch.name}:VERSION`);
      return null;
    }

    const [fullVersion, majorStr, minorStr, patchStr] = versionMatch;
    return {
      ...branch,
      version: {
        major: parseInt(majorStr || "0", 10),
        minor: parseInt(minorStr || "0", 10),
        patch: parseInt(patchStr || "0", 10),
        full: fullVersion.trim(),
      },
    };
  }

  /**
   * Helper: Find latest RC branch of a specific type
   */
  private async findLatestRCBranch(
    branchType: BranchType
  ): Promise<BranchTypeInfo | null> {
    const branches = await this.gitFlowManager.findBranchesOfType(branchType);
    const rcBranches: BranchTypeInfo[] = [];

    for (const branch of branches) {
      const resolved = await this.resolveBranchVersion(branch);
      if (resolved?.version.full.includes("-RC.")) {
        rcBranches.push(resolved);
      }
    }

    if (rcBranches.length === 0) {
      return null;
    }

    // Sort by semantic version descending
    rcBranches.sort((a, b) => {
      if (a.version.major !== b.version.major) {
        return b.version.major - a.version.major;
      }
      if (a.version.minor !== b.version.minor) {
        return b.version.minor - a.version.minor;
      }
      return b.version.patch - a.version.patch;
    });

    return rcBranches[0] || null;
  }

  /**
   * Step 2: Checkout the target branch
   */
  private async executeReleaseStep2_CheckoutBranch(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(2, "in_progress");

    try {
      const cleanBranchName = branchInfo.name.replace(/^remotes\/origin\//, "");

      if (this.isDryRun()) {
        const step = this.updateStepStatus(2, "skipped");
        step.message = `Dry run: would check out ${cleanBranchName}`;
        console.log(
          `⏭️  Step 2: skipped (dry run) — would check out '${cleanBranchName}'`
        );
        return;
      }

      console.log(`🔄 Step 2: Checking out branch '${cleanBranchName}'`);
      await this.gitFlowManager.checkoutAndPull(cleanBranchName);

      const currentStatus = await this.gitFlowManager.getStatus();
      (this.context as ReleaseVersionWorkflowContext).currentBranch =
        currentStatus.currentBranch;

      this.updateStepStatus(2, "completed");
    } catch (error) {
      this.updateStepStatus(2, "failed");
      throw error;
    }
  }

  /**
   * Step 3: Pull latest changes
   */
  private async executeReleaseStep3_PullChanges(): Promise<void> {
    this.updateStepStatus(3, "in_progress");

    try {
      const branchName = (
        this.context as ReleaseVersionWorkflowContext
      ).branchInfo.name.replace(/^remotes\/origin\//, "");

      if (this.isDryRun()) {
        const step = this.updateStepStatus(3, "skipped");
        step.message = `Dry run: would pull ${branchName}`;
        console.log(`⏭️  Step 3: skipped (dry run) — would pull ${branchName}`);
        return;
      }

      console.log(`🔄 Step 3: Pulling latest changes from ${branchName}`);
      await this.gitFlowManager.pullBranch(branchName);

      this.updateStepStatus(3, "completed");
    } catch (error) {
      this.updateStepStatus(3, "failed");
      throw error;
    }
  }

  /**
   * Step 4: Release version (RC → Final)
   */
  private async executeReleaseStep4_ReleaseVersion(): Promise<void> {
    this.updateStepStatus(4, "in_progress");

    try {
      console.log(`🔄 Step 4: Releasing version (RC → Final)`);

      // Validation runs in dry run too. It is read-only, and skipping it is what let a
      // dry run pass on a branch the real run would immediately reject.
      const currentVersion = await this.versionerAdapter.getCurrentVersion();

      if (!currentVersion.version.includes("-RC.")) {
        throw new Error(
          `Branch version ${currentVersion.version} is not a release candidate. Only RC versions can be released.`
        );
      }

      console.log(
        `✅ RC validation passed: ${currentVersion.version} is a release candidate`
      );

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        const newVersion = await this.versionerAdapter.releaseVersion();
        (this.context as ReleaseVersionWorkflowContext).targetVersion =
          newVersion;

        console.log(`🎯 New final version: ${newVersion.version}`);
      } else {
        console.log(
          `🔧 Dry run: would promote ${
            currentVersion.version
          } → ${predictPromotedVersion(currentVersion.version)}`
        );
      }

      this.updateStepStatus(4, "completed");
    } catch (error) {
      this.updateStepStatus(4, "failed");
      throw error;
    }
  }

  /**
   * Step 5: Push changes
   */
  private async executeReleaseStep5_PushChanges(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(5, "in_progress");

    try {
      const branchName = branchInfo.name.replace(/^remotes\/origin\//, "");

      console.log(`🔄 Step 5: Pushing changes for ${branchName}`);

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        await this.gitFlowManager["execGit"](`push origin ${branchName}`);
        console.log(`🚀 Pushed changes to ${branchName}`);
      } else {
        console.log(`🔧 Dry run: Would push changes to ${branchName}`);
      }

      this.updateStepStatus(5, "completed");
    } catch (error) {
      this.updateStepStatus(5, "failed");
      throw error;
    }
  }

  /**
   * Step 6: Push version tag
   */
  private async executeReleaseStep6_PushTag(): Promise<void> {
    this.updateStepStatus(6, "in_progress");

    try {
      console.log(`🔄 Step 6: Pushing version tag`);

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        const targetVersion = (this.context as ReleaseVersionWorkflowContext)
          .targetVersion;
        if (!targetVersion) {
          throw new Error("Target version not available for tag operation");
        }

        const tagName = targetVersion.version;
        await this.gitFlowManager["execGit"](`push origin ${tagName}`);
        console.log(`🚀 Pushed tag ${tagName}`);
      } else {
        console.log(`🔧 Dry run: Would push version tag`);
      }

      this.updateStepStatus(6, "completed");
    } catch (error) {
      this.updateStepStatus(6, "failed");
      throw error;
    }
  }

  /**
   * Step 7: Create pull request
   */
  private async executeReleaseStep7_CreatePullRequest(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(7, "in_progress");

    try {
      const branchName = branchInfo.name.replace(/^remotes\/origin\//, "");
      const targetBranch = "main"; // All final version PRs target main
      const targetVersion = (this.context as ReleaseVersionWorkflowContext)
        .targetVersion;

      console.log(
        `🔄 Step 7: Creating PR from ${branchName} to ${targetBranch}`
      );

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        const prTitle = `Release ${
          targetVersion?.version || "new version"
        } to main`;

        const prBody = `## ${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        } Version ${targetVersion?.version || "new version"}

${productionMergeWarning(branchInfo.type)}

This PR contains the final release version for ${branchName}.

### 📋 ${branchInfo.type === "release" ? "Release" : "Hotfix"} Information
- **Version**: ${targetVersion?.version || "new version"}
- **Branch**: ${branchName}
- **Target**: ${targetBranch}
- **Type**: ${branchInfo.type}

### 🔄 Changes
- Released version ${
          targetVersion?.version || "new version"
        } (converted from RC)
- Updated VERSION file and git tag

---
🤖 Auto-generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)`;

        try {
          const prResult = await this.gitFlowManager.createPullRequest(
            branchName,
            targetBranch,
            prTitle,
            prBody
          );

          const ctx = this.context as ReleaseVersionWorkflowContext;
          ctx.pullRequestUrl = prResult.url;
          ctx.pullRequestAction = prResult.action;
          const verb = prResult.action === "updated" ? "Updated" : "Created";
          console.log(`🔗 ${verb} PR: ${prResult.url}`);
        } catch (prError) {
          const msg =
            prError instanceof Error ? prError.message : String(prError);
          // Don't fail the entire workflow — the release ops already succeeded —
          // but capture the error so the MCP output surfaces it to the user.
          (this.context as ReleaseVersionWorkflowContext).pullRequestError =
            msg;
          console.warn(`⚠️  Failed to create/update PR (continuing): ${msg}`);
        }
      } else {
        console.log(
          `🔧 Dry run: Would create PR from ${branchName} to ${targetBranch}`
        );
      }

      this.updateStepStatus(7, "completed");
    } catch (error) {
      this.updateStepStatus(7, "failed");
      throw error;
    }
  }

  /**
   * Step 8: Add hotfix warning (if applicable)
   */
  private async executeReleaseStep8_HotfixWarning(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(8, "in_progress");

    try {
      if (branchInfo.type === "hotfix") {
        console.log(`🔄 Step 8: Adding hotfix warning`);
        console.log(
          `⚠️  HOTFIX WARNING: This PR must be merged ONLY AFTER the hotfix has been deployed to production!`
        );
      } else {
        console.log(`🔄 Step 8: No hotfix warning needed (release branch)`);
      }

      this.updateStepStatus(8, "completed");
    } catch (error) {
      this.updateStepStatus(8, "failed");
      throw error;
    }
  }

  /**
   * Step 9: Create GitHub Release
   */
  private async executeReleaseStep9_CreateGitHubRelease(
    branchInfo: BranchTypeInfo
  ): Promise<void> {
    this.updateStepStatus(9, "in_progress");

    try {
      console.log(`🔄 Step 9: Creating GitHub Release`);

      const context = this.context as ReleaseVersionWorkflowContext;
      const branchName = branchInfo.name.replace(/^remotes\/origin\//, "");

      // A dry run never promotes, so targetVersion is unset; derive what the release
      // would be named instead of treating its absence as a failure.
      if (context.dryRun) {
        const predicted = predictPromotedVersion(branchInfo.version.full);
        const step = this.updateStepStatus(9, "skipped");
        step.message = `Dry run: would create GitHub release ${predicted} targeting ${branchName}`;
        console.log(`⏭️  Step 9: skipped (dry run) — ${step.message}`);
        return;
      }

      if (!context.targetVersion) {
        throw new Error("Target version not available in context");
      }

      const version = context.targetVersion.version;

      const { url: releaseUrl, notesWarning } =
        await this.gitFlowManager.createGitHubRelease(version, branchName);

      context.releaseUrl = releaseUrl;
      if (notesWarning) {
        context.releaseNotesWarning = notesWarning;
        console.warn(`⚠️  Release notes warning: ${notesWarning}`);
      }

      console.log(`🎯 GitHub Release created: ${releaseUrl}`);
      console.log(`📋 Version: ${version}`);
      console.log(`🌿 Target branch: ${branchName}`);

      this.updateStepStatus(9, "completed");
    } catch (error) {
      this.updateStepStatus(9, "failed");
      throw error;
    }
  }

  /**
   * Check if versioner is available
   */
  isVersionerAvailable(): boolean {
    return this.versionerAdapter.isVersionerAvailable();
  }

  /**
   * Cleanup and disconnect
   */
  async cleanup(): Promise<void> {
    await this.versionerAdapter.disconnect();
  }
}
