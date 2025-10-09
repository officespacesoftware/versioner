/**
 * Task functions that mirror the Ruby rake tasks
 * Each task combines VersionFile operations with Git operations
 */

import { VersionFile } from './version-file.js';
import { gitAdd, gitCommit, gitTag } from './git-utils.js';
import { getVersionFilePath } from './options.js';

/**
 * Get current version from VERSION file
 * @returns {string} Current version string
 */
function getCurrentVersion() {
  const versionFile = new VersionFile();
  return versionFile.version();
}

/**
 * Get the version file path
 * @returns {string} Path to VERSION file
 */
function getFileName() {
  return getVersionFilePath();
}

/**
 * Perform git operations: add, commit, and tag
 * @param {string} version - Version string for commit and tag messages
 */
function performGitOperations(version) {
  const fileName = getFileName();
  
  // Add the VERSION file to git
  gitAdd(fileName);
  
  // Commit with version message
  gitCommit(`To version ${version}`);
  
  // Create annotated tag
  gitTag(version, `Release version ${version}`);
}

/**
 * Initialize project with VERSION file
 * @param {string} version - Initial version (optional, defaults to 0.1.0-RC.0)
 * @returns {string} Created version
 */
export function init(version = null) {
  const options = {};
  if (version) {
    options.version = version;
  }
  
  const versionFile = VersionFile.create(options);
  const createdVersion = versionFile.version();
  
  performGitOperations(createdVersion);
  return createdVersion;
}

/**
 * Create a new patch-level release
 * @returns {string} New version
 */
export function patch() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.patch();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Create a new minor-level release
 * @returns {string} New version
 */
export function minor() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.minor();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Create a new major-level release
 * @returns {string} New version
 */
export function major() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.major();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Create a new patch-level release candidate
 * @returns {string} New version
 */
export function patchReleaseCandidate() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.patchReleaseCandidate();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Create a new minor-level release candidate
 * @returns {string} New version
 */
export function minorReleaseCandidate() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.minorReleaseCandidate();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Create a new major-level release candidate
 * @returns {string} New version
 */
export function majorReleaseCandidate() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.majorReleaseCandidate();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Increment the current release candidate
 * @returns {string} New version
 */
export function incrementReleaseCandidate() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.incrementReleaseCandidate();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Release the current release candidate
 * @returns {string} New version
 */
export function release() {
  const versionFile = new VersionFile();
  const newVersion = versionFile.release();
  
  performGitOperations(newVersion);
  return newVersion;
}

/**
 * Show the current version
 * @returns {string} Current version
 */
export function show() {
  return getCurrentVersion();
}

/**
 * Print the current version to console
 */
export function showVersion() {
  const version = show();
  console.log(version);
}

// Export all tasks for convenience
export default {
  init,
  patch,
  minor,
  major,
  patchReleaseCandidate,
  minorReleaseCandidate,
  majorReleaseCandidate,
  incrementReleaseCandidate,
  release,
  show,
  showVersion
};