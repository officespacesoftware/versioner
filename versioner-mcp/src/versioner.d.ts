/**
 * Type declarations for @officespacesoftware/versioner
 */
declare module '@officespacesoftware/versioner' {
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

  export class VersionFile {
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
}