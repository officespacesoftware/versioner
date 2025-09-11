/**
 * Core VersionFile class that manages version operations
 * Mirrors the Ruby VersionFile class functionality
 */

import { getVersionFilePath } from './options.js';
import { readVersionFile, writeVersionFile, createVersionFile, fileExists } from './file-utils.js';
import { getShortCommitHash } from './git-utils.js';
import {
  parseVersion,
  formatVersion,
  incrementMajor,
  incrementMinor,
  incrementPatch,
  makeReleaseCandidate,
  removeReleaseCandidate,
  incrementReleaseCandidate,
  getShortVersion
} from './version-parser.js';

export class VersionFile {
  /**
   * Create a new VersionFile instance
   * @param {string} filePath - Path to the VERSION file (optional)
   * @param {Object} options - Options for file creation
   */
  constructor(filePath = null, options = {}) {
    this.filePath = filePath || getVersionFilePath();

    // Handle file creation if options provided
    if (options.version && options.path) {
      this._createFile(options.version, options.path);
    }

    // Validate that file exists
    if (!fileExists(this.filePath)) {
      throw new Error(`Version file '${this.filePath}' does not exist.`);
    }

    // Read initial version data
    this._loadVersionData();
  }

  /**
   * Static method to create a new VERSION file
   * @param {Object} options - Creation options
   * @returns {VersionFile} New VersionFile instance
   */
  static create(options = {}) {
    const version = options.version || '0.1.0-RC.0';
    const path = options.path || getVersionFilePath();

    const gitHash = getShortCommitHash();
    createVersionFile(path, version, gitHash);

    return new VersionFile(path);
  }

  /**
   * Load version data from file
   * @private
   */
  _loadVersionData() {
    const data = readVersionFile(this.filePath);
    this._versionData = data;
    this._parsedVersion = parseVersion(data.version);
  }

  /**
   * Create a new version file
   * @param {string} version - Initial version
   * @param {string} path - File path
   * @private
   */
  _createFile(version, path) {
    const gitHash = getShortCommitHash();
    createVersionFile(path, version, gitHash);
  }

  /**
   * Write new version to file
   * @param {string} newVersion - New version string
   * @private
   */
  _writeVersion(newVersion) {
    const gitHash = getShortCommitHash();
    writeVersionFile(this.filePath, newVersion, gitHash);
    this._loadVersionData(); // Reload data after writing
    return newVersion;
  }

  /**
   * Get current version string
   * @returns {string} Current version
   */
  version() {
    return this._versionData.version;
  }

  /**
   * Get version without RC suffix
   * @returns {string} Short version
   */
  shortVersion() {
    if (!this.isReleaseCandidate()) {
      return this.version();
    }
    return getShortVersion(this._parsedVersion);
  }

  /**
   * Check if current version is a release candidate
   * @returns {boolean} True if version is RC
   */
  isReleaseCandidate() {
    return this._parsedVersion.isRC;
  }

  /**
   * Get current major version
   * @returns {string} Major version
   */
  currentMajorVersion() {
    return this._parsedVersion.major.toString();
  }

  /**
   * Get current minor version
   * @returns {string} Minor version
   */
  currentMinorVersion() {
    return this._parsedVersion.minor.toString();
  }

  /**
   * Get current patch version (without RC suffix)
   * @returns {string} Patch version
   */
  currentPatchVersion() {
    return this._parsedVersion.patch.toString();
  }

  /**
   * Get release candidate iteration number
   * @returns {string} RC iteration number
   */
  releaseCandidateIteration() {
    if (!this.isReleaseCandidate()) {
      return '';
    }
    return (this._parsedVersion.rcNumber || 0).toString();
  }

  /**
   * Increment patch version
   * @returns {string} New version string
   * @throws {Error} If current version is a release candidate
   */
  patch() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const patchVersion = formatVersion(incrementPatch(removeReleaseCandidate(this._parsedVersion)));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Release the RC (${currentVersion} → ${releaseVersion})\n` +
        `b) Release the RC first, then create patch version (${releaseVersion} → ${patchVersion})`);
    }

    const newVersion = incrementPatch(this._parsedVersion);
    return this._writeVersion(formatVersion(newVersion));
  }

  /**
   * Increment minor version
   * @returns {string} New version string
   * @throws {Error} If current version is a release candidate
   */
  minor() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const minorVersion = formatVersion(incrementMinor(removeReleaseCandidate(this._parsedVersion)));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Just release the RC as-is (${currentVersion} → ${releaseVersion})\n` +
        `b) Release the RC first, then create minor version (${releaseVersion} → ${minorVersion})`);
    }

    const newVersion = incrementMinor(this._parsedVersion);
    return this._writeVersion(formatVersion(newVersion));
  }

  /**
   * Increment major version
   * @returns {string} New version string
   * @throws {Error} If current version is a release candidate
   */
  major() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const majorVersion = formatVersion(incrementMajor(removeReleaseCandidate(this._parsedVersion)));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Just release the RC as-is (${currentVersion} → ${releaseVersion})\n` +
        `b) Release the RC first, then create major version (${releaseVersion} → ${majorVersion})`);
    }

    const newVersion = incrementMajor(this._parsedVersion);
    return this._writeVersion(formatVersion(newVersion));
  }

  /**
   * Create patch-level release candidate
   * @returns {string} New version string
   * @throws {Error} If current version is already a release candidate
   */
  patchReleaseCandidate() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const nextRcVersion = formatVersion(incrementReleaseCandidate(this._parsedVersion));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Just release the RC as-is (${currentVersion} → ${releaseVersion})\n` +
        `b) Increment the RC (${currentVersion} → ${nextRcVersion})`);
    }

    const patchedVersion = incrementPatch(this._parsedVersion);
    const rcVersion = makeReleaseCandidate(patchedVersion, 0);
    return this._writeVersion(formatVersion(rcVersion));
  }

  /**
   * Create minor-level release candidate
   * @returns {string} New version string
   * @throws {Error} If current version is already a release candidate
   */
  minorReleaseCandidate() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const nextRcVersion = formatVersion(incrementReleaseCandidate(this._parsedVersion));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Just release the RC as-is (${currentVersion} → ${releaseVersion})\n` +
        `b) Increment the RC (${currentVersion} → ${nextRcVersion})`);
    }

    const minorVersion = incrementMinor(this._parsedVersion);
    const rcVersion = makeReleaseCandidate(minorVersion, 0);
    return this._writeVersion(formatVersion(rcVersion));
  }

  /**
   * Create major-level release candidate
   * @returns {string} New version string
   * @throws {Error} If current version is already a release candidate
   */
  majorReleaseCandidate() {
    if (this.isReleaseCandidate()) {
      const currentVersion = this.version();
      const releaseVersion = this.shortVersion();
      const nextRcVersion = formatVersion(incrementReleaseCandidate(this._parsedVersion));
      throw new Error(`There's an active release candidate (${currentVersion}). Do you want to:\n` +
        `a) Just release the RC as-is (${currentVersion} → ${releaseVersion})\n` +
        `b) Increment the RC (${currentVersion} → ${nextRcVersion})`);
    }

    const majorVersion = incrementMajor(this._parsedVersion);
    const rcVersion = makeReleaseCandidate(majorVersion, 0);
    return this._writeVersion(formatVersion(rcVersion));
  }

  /**
   * Increment release candidate number
   * @returns {string} New version string
   * @throws {Error} If current version is not a release candidate
   */
  incrementReleaseCandidate() {
    if (!this.isReleaseCandidate()) {
      throw new Error('Cannot increment the release candidate version on a non release candidate.');
    }

    const newVersion = incrementReleaseCandidate(this._parsedVersion);
    return this._writeVersion(formatVersion(newVersion));
  }

  /**
   * Release current release candidate (remove RC suffix)
   * @returns {string} New version string
   * @throws {Error} If current version is not a release candidate
   */
  release() {
    if (!this.isReleaseCandidate()) {
      throw new Error('Cannot release a non release candidate.');
    }

    const releasedVersion = removeReleaseCandidate(this._parsedVersion);
    return this._writeVersion(formatVersion(releasedVersion));
  }
}

export default VersionFile;
