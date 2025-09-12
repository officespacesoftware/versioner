/**
 * Release Agent - intelligent agent for orchestrating Git Flow workflows
 */

import { VersionerAdapter, VersionInfo } from "./versioner-adapter.js";
import { GitFlowManager } from "./git-flow.js";

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
  private context?: ReleaseWorkflowContext | HotfixWorkflowContext;
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
