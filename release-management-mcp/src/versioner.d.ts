/**
 * Type declarations for @officespacesoftware/versioner package
 */
declare module '@officespacesoftware/versioner' {
  // Core versioning functions
  export function init(version?: string | null): string;
  export function patch(): string;
  export function minor(): string;
  export function major(): string;
  export function patchReleaseCandidate(): string;
  export function minorReleaseCandidate(): string;
  export function majorReleaseCandidate(): string;
  export function incrementReleaseCandidate(): string;
  export function release(): string;
  export function show(): string;
  export function showVersion(): string;

  // VersionFile class
  export class VersionFile {
    constructor();
    version(): string;
    patch(): string;
    minor(): string;
    major(): string;
    patchReleaseCandidate(): string;
    minorReleaseCandidate(): string;
    majorReleaseCandidate(): string;
    incrementReleaseCandidate(): string;
    release(): string;
    static create(options?: { version?: string }): VersionFile;
  }

  // Options module
  export namespace options {
    export function getVersionFilePath(): string;
    export function setVersionFilePath(path: string): void;
  }

  // Git utilities
  export namespace gitUtils {
    export function gitAdd(file: string): void;
    export function gitCommit(message: string): void;
    export function gitTag(tag: string, message: string): void;
    export function getCurrentBranch(): string;
    export function getRemoteUrl(remote?: string): string | null;
  }

  // File utilities
  export namespace fileUtils {
    export function readFile(path: string): string;
    export function writeFile(path: string, content: string): void;
    export function fileExists(path: string): boolean;
  }

  // Version parser utilities
  export namespace versionParser {
    export function parse(version: string): {
      major: number;
      minor: number;
      patch: number;
      isReleaseCandidate: boolean;
      rcNumber?: number;
    };
    export function toString(versionObj: {
      major: number;
      minor: number;
      patch: number;
      isReleaseCandidate: boolean;
      rcNumber?: number;
    }): string;
  }
}