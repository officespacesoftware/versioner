/**
 * Versioner Adapter - High-level abstraction for versioner operations
 * Provides a clean interface between Release Management workflows and versioner-mcp
 */

import { VersionerMCPClient } from "./mcp-client.js";

export interface VersionInfo {
  version: string;
  isReleaseCandidate: boolean;
  major: number;
  minor: number;
  patch: number;
  rcNumber: number | undefined;
}

/**
 * Adapter class that provides high-level versioning operations
 */
export class VersionerAdapter {
  private versionerClient: VersionerMCPClient;
  private isConnected = false;

  constructor() {
    this.versionerClient = new VersionerMCPClient();
  }

  /**
   * Initialize connection to versioner-mcp
   */
  async initialize(
    versionerMCPCommand?: string,
    workingDirectory?: string
  ): Promise<void> {
    try {
      await this.versionerClient.connect(versionerMCPCommand, workingDirectory);
      this.isConnected = true;
      console.log("VersionerAdapter: Successfully connected to versioner-mcp");
      if (workingDirectory) {
        console.log(
          `VersionerAdapter: Using working directory: ${workingDirectory}`
        );
      }
    } catch (error) {
      console.error(
        "VersionerAdapter: Failed to connect to versioner-mcp:",
        error
      );
      throw new Error(`Failed to initialize versioner connection: ${error}`);
    }
  }

  /**
   * Ensure the adapter is connected
   */
  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error(
        "VersionerAdapter not connected. Call initialize() first."
      );
    }
  }

  /**
   * Get current version information
   */
  async getCurrentVersion(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const versionString = await this.versionerClient.showVersion();
      return this.parseVersionString(versionString);
    } catch (error) {
      throw new Error(`Failed to get current version: ${error}`);
    }
  }

  /**
   * Create a major release candidate
   */
  async createMajorReleaseCandidate(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const result = await this.versionerClient.createMajorRC();
      console.log("Versioner result:", result);

      // Get the new version info
      const newVersion = await this.getCurrentVersion();
      return newVersion;
    } catch (error) {
      throw new Error(`Failed to create major release candidate: ${error}`);
    }
  }

  /**
   * Create a minor release candidate
   */
  async createMinorReleaseCandidate(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const result = await this.versionerClient.createMinorRC();
      console.log("Versioner result:", result);

      // Get the new version info
      const newVersion = await this.getCurrentVersion();
      return newVersion;
    } catch (error) {
      throw new Error(`Failed to create minor release candidate: ${error}`);
    }
  }

  /**
   * Create a patch release candidate
   */
  async createPatchReleaseCandidate(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const result = await this.versionerClient.createPatchRC();
      console.log("Versioner result:", result);

      // Get the new version info
      const newVersion = await this.getCurrentVersion();
      return newVersion;
    } catch (error) {
      throw new Error(`Failed to create patch release candidate: ${error}`);
    }
  }

  /**
   * Create a release candidate of the specified type
   */
  async createReleaseCandidate(
    releaseType: "major" | "minor" | "patch"
  ): Promise<VersionInfo> {
    switch (releaseType) {
      case "major":
        return this.createMajorReleaseCandidate();
      case "minor":
        return this.createMinorReleaseCandidate();
      case "patch":
        return this.createPatchReleaseCandidate();
      default:
        throw new Error(
          `Invalid release type: ${releaseType}. Must be major, minor, or patch.`
        );
    }
  }

  /**
   * Increment the current release candidate
   */
  async incrementReleaseCandidate(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const result = await this.versionerClient.incrementReleaseCandidate();
      console.log("Versioner increment RC result:", result);

      // Get the new version info
      const newVersion = await this.getCurrentVersion();
      return newVersion;
    } catch (error) {
      throw new Error(`Failed to increment release candidate: ${error}`);
    }
  }

  /**
   * Release the current release candidate to final version
   */
  async releaseVersion(): Promise<VersionInfo> {
    this.ensureConnected();

    try {
      const result = await this.versionerClient.releaseVersion();
      console.log("Versioner release result:", result);

      // Get the new version info
      const newVersion = await this.getCurrentVersion();
      return newVersion;
    } catch (error) {
      throw new Error(`Failed to release version: ${error}`);
    }
  }

  /**
   * Initialize versioner in a project (creates VERSION file)
   */
  async initializeProject(initialVersion?: string): Promise<VersionInfo> {
    try {
      const result = await this.versionerClient.initialize(initialVersion);
      console.log("Versioner init result:", result);

      // Get the initialized version info
      const versionInfo = await this.getCurrentVersion();
      return versionInfo;
    } catch (error) {
      throw new Error(`Failed to initialize versioner project: ${error}`);
    }
  }

  /**
   * Check if versioner is available and connected
   */
  isVersionerAvailable(): boolean {
    return this.isConnected && this.versionerClient.isConnected();
  }

  /**
   * Get available versioner tools
   */
  getAvailableTools(): string[] {
    if (!this.isConnected) {
      return [];
    }
    return this.versionerClient.getAvailableTools().map((tool) => tool.name);
  }

  /**
   * Parse version string into structured information
   */
  private parseVersionString(versionString: string): VersionInfo {
    // Extract version from the versioner output
    // The output might contain additional info, so we need to extract just the version
    const lines = versionString.trim().split("\n");
    const versionLine = lines.find((line) =>
      /^\d+\.\d+\.\d+/.test(line.trim())
    );

    if (!versionLine) {
      throw new Error(`Could not parse version from: ${versionString}`);
    }

    const version = versionLine.trim();
    const isReleaseCandidate = version.includes("-RC");

    // Parse semantic version components
    const versionRegex = /^(\d+)\.(\d+)\.(\d+)(?:-RC\.(\d+))?$/;
    const match = version.match(versionRegex);

    if (!match) {
      throw new Error(`Invalid version format: ${version}`);
    }

    const [, majorStr, minorStr, patchStr, rcStr] = match;

    return {
      version,
      isReleaseCandidate,
      major: parseInt(majorStr || "0", 10),
      minor: parseInt(minorStr || "0", 10),
      patch: parseInt(patchStr || "0", 10),
      rcNumber: rcStr ? parseInt(rcStr, 10) : undefined,
    };
  }

  /**
   * Disconnect from versioner-mcp
   */
  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.versionerClient.disconnect();
      this.isConnected = false;
      console.log("VersionerAdapter: Disconnected from versioner-mcp");
    }
  }
}
