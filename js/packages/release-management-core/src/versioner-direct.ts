/**
 * Direct integration with versioner package
 * Replaces the MCP client approach with direct function calls
 */

import {
  init,
  patch,
  minor,
  major,
  patchReleaseCandidate,
  minorReleaseCandidate,
  majorReleaseCandidate,
  incrementReleaseCandidate,
  release,
  showVersion
} from '@officespacesoftware/versioner';

/**
 * Direct client for versioner operations
 * Provides a clean interface for versioner operations using direct function calls
 */
export interface VersionerClientOptions {
  gitEnvironment?: () => Promise<Record<string, string>>;
}

export class VersionerDirectClient {
  private workingDirectory: string | undefined;
  private originalCwd: string | undefined;
  private gitEnvironment: (() => Promise<Record<string, string>>) | undefined;

  /**
   * Initialize the versioner client
   * @param _versionerMCPCommand - Ignored, kept for compatibility
   * @param workingDirectory - Directory to run versioner commands in
   */
  async connect(
    _versionerMCPCommand?: string,
    workingDirectory?: string,
    options: VersionerClientOptions = {}
  ): Promise<void> {
    this.workingDirectory = workingDirectory;
    this.gitEnvironment = options.gitEnvironment;

    // Store original working directory
    if (workingDirectory) {
      this.originalCwd = process.cwd();
      console.log(`VersionerDirectClient: Configured to use working directory: ${workingDirectory}`);
    }

    console.log("VersionerDirectClient: Ready (using direct versioner package)");
  }

  /**
   * Change to working directory if configured
   */
  private changeToWorkingDirectory(): void {
    if (this.workingDirectory) {
      process.chdir(this.workingDirectory);
    }
  }

  /**
   * Restore original working directory
   */
  private restoreWorkingDirectory(): void {
    if (this.originalCwd) {
      process.chdir(this.originalCwd);
    }
  }

  /**
   * Execute a versioner function in the configured working directory
   */
  private async executeInWorkingDirectory<T>(fn: () => T): Promise<T> {
    const env = this.gitEnvironment ? await this.gitEnvironment() : {};
    const saved = Object.keys(env).map(
      (name) => [name, process.env[name]] as const
    );
    try {
      this.changeToWorkingDirectory();
      Object.assign(process.env, env);
      return fn();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.restoreWorkingDirectory();
    }
  }

  /**
   * Get available tools (simulated for compatibility)
   */
  getAvailableTools(): Array<{ name: string; description: string }> {
    return [
      { name: 'versioner_init', description: 'Initialize project with VERSION file' },
      { name: 'versioner_show', description: 'Show current version' },
      { name: 'versioner_patch', description: 'Create patch release' },
      { name: 'versioner_minor', description: 'Create minor release' },
      { name: 'versioner_major', description: 'Create major release' },
      { name: 'versioner_patch_rc', description: 'Create patch release candidate' },
      { name: 'versioner_minor_rc', description: 'Create minor release candidate' },
      { name: 'versioner_major_rc', description: 'Create major release candidate' },
      { name: 'versioner_increment_rc', description: 'Increment release candidate' },
      { name: 'versioner_release', description: 'Release current RC' }
    ];
  }

  /**
   * Check if client is connected (always true for direct client)
   */
  isConnected(): boolean {
    return true;
  }

  /**
   * Initialize versioner in a project
   */
  async initialize(initialVersion?: string): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return init(initialVersion || null);
    });
  }

  /**
   * Show current version
   */
  async showVersion(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return showVersion();
    });
  }

  /**
   * Create a major release candidate
   */
  async createMajorRC(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return majorReleaseCandidate();
    });
  }

  /**
   * Create a minor release candidate
   */
  async createMinorRC(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return minorReleaseCandidate();
    });
  }

  /**
   * Create a patch release candidate
   */
  async createPatchRC(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return patchReleaseCandidate();
    });
  }

  /**
   * Increment the current release candidate
   */
  async incrementReleaseCandidate(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return incrementReleaseCandidate();
    });
  }

  /**
   * Release the current release candidate
   */
  async releaseVersion(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return release();
    });
  }

  /**
   * Create a patch release
   */
  async createPatch(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return patch();
    });
  }

  /**
   * Create a minor release
   */
  async createMinor(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return minor();
    });
  }

  /**
   * Create a major release
   */
  async createMajor(): Promise<string> {
    return this.executeInWorkingDirectory(() => {
      return major();
    });
  }

  /**
   * Disconnect (no-op for direct client, kept for compatibility)
   */
  async disconnect(): Promise<void> {
    // Restore original working directory if changed
    this.restoreWorkingDirectory();
    console.log("VersionerDirectClient: Disconnected");
  }
}