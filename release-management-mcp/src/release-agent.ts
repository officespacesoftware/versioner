/**
 * Release Agent - intelligent agent for orchestrating Git Flow workflows
 */

import { VersionerAdapter, VersionInfo } from "./versioner-adapter.js";
import { GitFlowManager, BranchType, BranchTypeInfo } from "./git-flow.js";

export interface ReleaseWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  releaseType: "major" | "minor";
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
}

export interface HotfixWorkflowContext {
  workingDirectory: string;
  currentBranch: string;
  targetVersion?: VersionInfo;
  dryRun: boolean;
  stepProgress: WorkflowStep[];
  pullRequestUrl?: string;
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
}

export interface WorkflowStep {
  step: number;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
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
    releaseType: "major" | "minor",
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
      } else {
        const releaseBranchName = `release/${nextVersion}`;
        console.log(
          `   🔄 [DRY RUN] Would create branch: ${releaseBranchName}`
        );
        step.message = `[DRY RUN] Would create release branch: ${releaseBranchName}`;
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
        const version = this.context!.targetVersion?.version || "unknown";
        const releaseBranch = `release/${version.split("-")[0]}`;

        // Generate PR title and body with version information
        const releaseType = (this.context! as ReleaseWorkflowContext)
          .releaseType;
        const prTitle = `Release: v${version} - ${releaseBranch} (${releaseType.toUpperCase()})`;
        const prBody = this.generatePRBody(version, releaseBranch, releaseType);

        // Create PR using GitFlowManager
        const prUrl = await this.gitFlowManager.createPullRequest(
          releaseBranch,
          "develop",
          prTitle,
          prBody
        );

        // Store PR URL in context
        this.context!.pullRequestUrl = prUrl;

        console.log(`   🔄 Created pull request: ${prUrl}`);
        step.message = `Created pull request: ${prUrl}`;
      } else {
        const version = this.context!.targetVersion?.version || "mock-version";
        const releaseBranch = `release/${version.split("-")[0]}`;
        const mockPrUrl = `https://github.com/example/repo/pull/123`;

        this.context!.pullRequestUrl = mockPrUrl;
        step.message = `[DRY RUN] Would create PR: ${releaseBranch} → develop`;
        console.log(
          `   🔄 [DRY RUN] Would create pull request from ${releaseBranch} to develop`
        );
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
        // Fetch latest changes from origin using git command
        await this.gitFlowManager["execGit"]("fetch origin main");
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
      } else {
        const hotfixBranchName = `hotfix/${nextVersion}`;
        console.log(`   🔄 [DRY RUN] Would create branch: ${hotfixBranchName}`);
        step.message = `[DRY RUN] Would create hotfix branch: ${hotfixBranchName}`;
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
        const version = this.context!.targetVersion?.version || "unknown";
        const hotfixBranch = `hotfix/${version.split("-")[0]}`;

        // Generate PR title and body with hotfix information
        const prTitle = `Hotfix: v${version} - ${hotfixBranch}`;
        const prBody = this.generateHotfixPRBody(version, hotfixBranch);

        // Create PR using GitFlowManager - targeting main instead of develop
        const prUrl = await this.gitFlowManager.createPullRequest(
          hotfixBranch,
          "main",
          prTitle,
          prBody
        );

        // Store PR URL in context
        this.context!.pullRequestUrl = prUrl;

        console.log(`   🔄 Created pull request: ${prUrl}`);
        step.message = `Created pull request: ${prUrl}`;
      } else {
        const version = this.context!.targetVersion?.version || "mock-version";
        const hotfixBranch = `hotfix/${version.split("-")[0]}`;
        const mockPrUrl = `https://github.com/example/repo/pull/456`;

        this.context!.pullRequestUrl = mockPrUrl;
        step.message = `[DRY RUN] Would create PR: ${hotfixBranch} → main`;
        console.log(
          `   🔄 [DRY RUN] Would create pull request from ${hotfixBranch} to main`
        );
      }

      this.updateStepStatus(6, "completed");
      console.log(`   ✅ ${step.message}`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Step 6 failed: ${step.error}`);
    }
  }

  /**
   * Generate PR body for hotfix with production deployment warning
   */
  private generateHotfixPRBody(version: string, hotfixBranch: string): string {
    return `
## Hotfix Branch: ${hotfixBranch}

> [!WARNING]
> This PR must be merged **after** the hotfix has been deployed to production.

This pull request contains the hotfix branch for **v${version}**.

### 📋 Hotfix Information
- **Version**: \`${version}\`
- **Branch**: \`${hotfixBranch}\`
- **Target**: \`main\`
- **Type**: Hotfix (Patch Release)

### 🔄 Changes
- Version bump to patch release candidate: \`${version}\`
- Hotfix branch preparation
- Production-ready bug fixes

### ✅ Pre-merge Checklist
- [ ] Hotfix has been deployed to production
- [ ] Production deployment successful
- [ ] All tests pass on hotfix branch
- [ ] Version number is correct in VERSION file
- [ ] Hotfix resolves the production issue

### 🚨 Deployment Process
1. **Deploy this hotfix to production first**
2. **Verify production deployment works correctly**
3. **Only then merge this PR**
4. **Create follow-up PR to merge changes back to develop**

### 🤖 Automation
This pull request was automatically created by the Release Management MCP following Git Flow hotfix practices.

**Workflow Steps Completed:**
1. ✅ Latest main branch fetched
2. ✅ Main branch checked out and updated
3. ✅ Hotfix branch created from main
4. ✅ Version bumped to patch release candidate
5. ✅ Hotfix branch and tag pushed to origin
6. ✅ Pull request created for production merge

---
*Generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)*
    `.trim();
  }

  /**
   * Generate PR body with release information
   */
  private generatePRBody(
    version: string,
    releaseBranch: string,
    releaseType: "major" | "minor"
  ): string {
    return `
## Release Branch: ${releaseBranch}

This pull request contains the release branch for **v${version}**.

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

### ✅ Pre-merge Checklist
- [ ] Version number is correct in VERSION file
- [ ] All tests pass on release branch
- [ ] Release artifacts build successfully
- [ ] Documentation has been updated
- [ ] Release notes have been prepared

### 🤖 Automation
This pull request was automatically created by the Release Management MCP following Git Flow best practices.

**Workflow Steps Completed:**
1. ✅ Main/develop synchronization verified
2. ✅ Develop branch checked out and updated
3. ✅ Release branch created from develop
4. ✅ Version bumped to release candidate
5. ✅ Release branch and tag pushed to origin
6. ✅ Pull request created for integration

---
*Generated by [Release Management MCP](https://github.com/officespacesoftware/versioner/tree/main/release-management-mcp)*
    `.trim();
  }

  /**
   * Helper method to update step status
   */
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
        }[step.status];

        return `${statusIcon} Step ${step.step}: ${step.name}`;
      })
      .join("\n");

    return summary;
  }

  /**
   * Execute the increment release candidate workflow (7-step process)
   */
  async executeIncrementRCWorkflow(
    workingDirectory: string,
    releaseBranch?: string,
    dryRun: boolean = false
  ): Promise<IncrementRCWorkflowContext> {
    console.log(`\n🚀 Starting Increment Release Candidate Workflow`);
    console.log(`📁 Working Directory: ${workingDirectory}`);
    if (releaseBranch) {
      console.log(`📋 Specified Branch: ${releaseBranch}`);
    }
    console.log(`🔧 Dry Run: ${dryRun ? "Yes" : "No"}\n`);

    // Step 1: Determine target branch using the intelligent selection algorithm
    const branchInfo = await this.selectTargetBranch(releaseBranch);

    console.log(`🎯 Selected Branch: ${branchInfo.name} (${branchInfo.type})`);
    console.log(`📊 Branch Version: ${branchInfo.version.full}`);
    console.log(`🎯 Target PR Branch: ${branchInfo.targetBranch}\n`);

    // Initialize increment RC workflow context
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      branchType: branchInfo.type,
      branchInfo,
      dryRun,
      stepProgress: [
        { step: 1, name: "Select Target Branch", status: "completed" },
        { step: 2, name: "Checkout Release/Hotfix Branch", status: "pending" },
        { step: 3, name: "Pull Latest Changes", status: "pending" },
        { step: 4, name: "Validate Branch Version", status: "pending" },
        { step: 5, name: "Increment Release Candidate", status: "pending" },
        { step: 6, name: "Push Changes and Tag", status: "pending" },
        { step: 7, name: "Create Pull Request", status: "pending" },
      ],
    } as IncrementRCWorkflowContext;

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
   * Step 1: Intelligent branch selection algorithm
   */
  private async selectTargetBranch(
    releaseBranch?: string
  ): Promise<BranchTypeInfo> {
    try {
      // First, fetch latest remote branches
      await this.gitFlowManager["execGit"]("fetch origin");

      // Option 1: Use provided releaseBranch parameter
      if (releaseBranch) {
        const branchType = this.gitFlowManager.detectBranchType(releaseBranch);
        if (!branchType) {
          throw new Error(
            `Branch '${releaseBranch}' does not match release or hotfix pattern`
          );
        }

        // Find the specific branch and get its info
        const branches = await this.gitFlowManager.findBranchesOfType(
          branchType
        );
        const cleanBranchName = releaseBranch.replace(/^remotes\/origin\//, "");
        const branch = branches.find(
          (b) =>
            b.name === releaseBranch ||
            b.name === `remotes/origin/${cleanBranchName}` ||
            b.name.endsWith(`/${cleanBranchName}`)
        );

        if (!branch) {
          throw new Error(
            `Branch '${releaseBranch}' not found in remote ${branchType} branches`
          );
        }

        return branch;
      }

      // Option 2: Check if current branch matches release/hotfix pattern
      const currentStatus = await this.gitFlowManager.getStatus();
      const currentBranchType = this.gitFlowManager.detectBranchType(
        currentStatus.currentBranch
      );

      if (currentBranchType) {
        const branches = await this.gitFlowManager.findBranchesOfType(
          currentBranchType
        );
        const currentBranch = branches.find(
          (b) =>
            b.name === currentStatus.currentBranch ||
            b.name.endsWith(`/${currentStatus.currentBranch}`)
        );

        if (currentBranch) {
          console.log(
            `📋 Using current branch: ${currentBranch.name} (${currentBranchType})`
          );
          return currentBranch;
        }
      }

      // Option 3: Find latest release and hotfix branches, select the most recent
      const latestRelease = await this.gitFlowManager.findLatestBranch(
        "release"
      );
      const latestHotfix = await this.gitFlowManager.findLatestBranch("hotfix");

      if (!latestRelease && !latestHotfix) {
        throw new Error(
          "No release or hotfix branches found. Cannot determine target branch for RC increment."
        );
      }

      // If only one type exists, use it
      if (latestRelease && !latestHotfix) {
        console.log(`📋 Using latest release branch: ${latestRelease.name}`);
        return latestRelease;
      }

      if (latestHotfix && !latestRelease) {
        console.log(`📋 Using latest hotfix branch: ${latestHotfix.name}`);
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
        console.log(
          `📋 Using most recent branch: ${selectedBranch.name} (${selectedBranch.version.full})`
        );
        return selectedBranch;
      }

      throw new Error("Unexpected error in branch selection logic");
    } catch (error) {
      throw new Error(`Failed to select target branch: ${error}`);
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

      console.log(`🔄 Step 3: Pulling latest changes from ${branchName}`);
      await this.gitFlowManager["execGit"](`pull origin ${branchName}`);

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

      if (!(this.context as IncrementRCWorkflowContext).dryRun) {
        const validation = await this.gitFlowManager.validateBranchVersion(
          branchInfo
        );

        if (!validation.valid) {
          throw new Error(validation.message);
        }

        console.log(`✅ Version validation passed: ${validation.message}`);
      } else {
        console.log(`🔧 Dry run: Skipping version validation`);
      }

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
      const targetBranch = branchInfo.targetBranch;
      const targetVersion = (this.context as IncrementRCWorkflowContext)
        .targetVersion;

      console.log(
        `🔄 Step 7: Creating PR from ${branchName} to ${targetBranch}`
      );

      if (!(this.context as IncrementRCWorkflowContext).dryRun) {
        const prTitle = `${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        }: Increment RC to ${targetVersion?.version || "new version"}`;

        const prBody = `## ${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        } Candidate Increment

This PR increments the release candidate version for ${branchName}.

### Changes
- Incremented RC version to ${targetVersion?.version || "new version"}
- Updated VERSION file and git tag

### Type
${
  branchInfo.type === "release"
    ? "- [ ] Ready for integration testing"
    : "- [ ] Ready for production deployment"
}

${
  branchInfo.type === "hotfix"
    ? `> [!WARNING]\n> This PR must be merged **after** the hotfix has been deployed to production.\n`
    : ""
}

🤖 Auto-generated by Release Management MCP`;

        try {
          const prUrl = await this.gitFlowManager.createPullRequest(
            branchName,
            targetBranch,
            prTitle,
            prBody
          );

          (this.context as IncrementRCWorkflowContext).pullRequestUrl = prUrl;
          console.log(`🔗 Created PR: ${prUrl}`);
        } catch (prError) {
          console.warn(`⚠️  Failed to create PR (continuing): ${prError}`);
          // Don't fail the entire workflow if PR creation fails
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
   * Execute the release version workflow (8-step process)
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

    // Step 1: Determine target branch using the intelligent selection algorithm
    const branchInfo = await this.selectTargetReleaseBranch(version);

    console.log(`🎯 Selected Branch: ${branchInfo.name} (${branchInfo.type})`);
    console.log(`📊 Branch Version: ${branchInfo.version.full}`);
    console.log(`🎯 Target PR Branch: ${branchInfo.targetBranch}\n`);

    // Validate that this is actually a release candidate
    if (!branchInfo.version.full.includes("-RC.")) {
      throw new Error(
        `Branch ${branchInfo.name} version ${branchInfo.version.full} is not a release candidate. Only RC versions can be released.`
      );
    }

    // Initialize release workflow context
    this.context = {
      workingDirectory,
      currentBranch: "unknown",
      branchType: branchInfo.type,
      branchInfo,
      dryRun,
      stepProgress: [
        { step: 1, name: "Select Target Branch", status: "completed" },
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
      ],
    } as ReleaseVersionWorkflowContext;

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
   * Step 1: Enhanced branch selection algorithm for release workflow
   */
  private async selectTargetReleaseBranch(
    version?: string
  ): Promise<BranchTypeInfo> {
    try {
      // First, fetch latest remote branches
      await this.gitFlowManager["execGit"]("fetch origin");

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
          throw new Error(
            `Ambiguous: Both release/${version} and hotfix/${version} branches exist. Please specify the full branch name.`
          );
        }

        if (releaseMatch) {
          console.log(`📋 Found release branch: ${releaseMatch.name}`);
          return releaseMatch;
        }

        if (hotfixMatch) {
          console.log(`📋 Found hotfix branch: ${hotfixMatch.name}`);
          return hotfixMatch;
        }

        throw new Error(
          `No release/${version} or hotfix/${version} branch found for version ${version}`
        );
      }

      // Option 2: Check if current branch matches release/hotfix pattern and is RC
      const currentStatus = await this.gitFlowManager.getStatus();
      const currentBranchType = this.gitFlowManager.detectBranchType(
        currentStatus.currentBranch
      );

      if (currentBranchType) {
        const branches = await this.gitFlowManager.findBranchesOfType(
          currentBranchType
        );
        const currentBranch = branches.find(
          (b) =>
            b.name === currentStatus.currentBranch ||
            b.name.endsWith(`/${currentStatus.currentBranch}`)
        );

        if (currentBranch && currentBranch.version.full.includes("-RC.")) {
          console.log(
            `📋 Using current RC branch: ${currentBranch.name} (${currentBranchType})`
          );
          return currentBranch;
        }
      }

      // Option 3: Find latest RC branches by type and select the most recent
      const latestRelease = await this.findLatestRCBranch("release");
      const latestHotfix = await this.findLatestRCBranch("hotfix");

      if (!latestRelease && !latestHotfix) {
        throw new Error(
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
        console.log(
          `📋 Using most recent RC branch: ${selectedBranch.name} (${selectedBranch.version.full})`
        );
        return selectedBranch;
      }

      throw new Error("Unexpected error in release branch selection logic");
    } catch (error) {
      throw new Error(`Failed to select target release branch: ${error}`);
    }
  }

  /**
   * Helper: Find latest RC branch of a specific type
   */
  private async findLatestRCBranch(
    branchType: BranchType
  ): Promise<BranchTypeInfo | null> {
    const branches = await this.gitFlowManager.findBranchesOfType(branchType);
    const rcBranches = branches.filter((b) => b.version.full.includes("-RC."));

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

      console.log(`🔄 Step 3: Pulling latest changes from ${branchName}`);
      await this.gitFlowManager["execGit"](`pull origin ${branchName}`);

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

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        const newVersion = await this.versionerAdapter.releaseVersion();
        (this.context as ReleaseVersionWorkflowContext).targetVersion =
          newVersion;

        console.log(`🎯 New final version: ${newVersion.version}`);
      } else {
        console.log(`🔧 Dry run: Would release RC to final version`);
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
      const targetBranch = branchInfo.targetBranch;
      const targetVersion = (this.context as ReleaseVersionWorkflowContext)
        .targetVersion;

      console.log(
        `🔄 Step 7: Creating PR from ${branchName} to ${targetBranch}`
      );

      if (!(this.context as ReleaseVersionWorkflowContext).dryRun) {
        const prTitle = `${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        }: ${targetVersion?.version || "new version"}`;

        const prBody = `## ${
          branchInfo.type === "release" ? "Release" : "Hotfix"
        } Version ${targetVersion?.version || "new version"}

This PR contains the final release version for ${branchName}.

### Changes
- Released version ${
          targetVersion?.version || "new version"
        } (converted from RC)
- Updated VERSION file and git tag

### Type
${
  branchInfo.type === "release"
    ? "- [ ] Ready for production deployment"
    : "- [ ] Ready for production deployment (CRITICAL HOTFIX)"
}

🤖 Auto-generated by Release Management MCP`;

        try {
          const prUrl = await this.gitFlowManager.createPullRequest(
            branchName,
            targetBranch,
            prTitle,
            prBody
          );

          (this.context as ReleaseVersionWorkflowContext).pullRequestUrl =
            prUrl;
          console.log(`🔗 Created PR: ${prUrl}`);
        } catch (prError) {
          console.warn(`⚠️  Failed to create PR (continuing): ${prError}`);
          // Don't fail the entire workflow if PR creation fails
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
