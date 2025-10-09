/**
 * Semantic version parsing and manipulation utilities
 * Handles version formats like "1.2.3" and "1.2.3-RC.0"
 */

/**
 * Parse a version string into its components
 * @param {string} versionString - Version string to parse
 * @returns {Object} Parsed version object
 * @throws {Error} If version string is invalid
 */
export function parseVersion(versionString) {
  if (!versionString || typeof versionString !== 'string') {
    throw new Error('Version string must be a non-empty string');
  }

  // Match semantic version pattern with optional release candidate
  const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-RC\.(\d+))?$/;
  const match = versionString.trim().match(versionPattern);

  if (!match) {
    throw new Error(`Invalid version format: ${versionString}. Expected format: X.Y.Z or X.Y.Z-RC.N`);
  }

  const [, major, minor, patch, rcNumber] = match;

  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    isRC: rcNumber !== undefined,
    rcNumber: rcNumber !== undefined ? parseInt(rcNumber, 10) : null
  };
}

/**
 * Format a version object back to string
 * @param {Object} versionObj - Version object to format
 * @returns {string} Formatted version string
 */
export function formatVersion(versionObj) {
  const { major, minor, patch, isRC, rcNumber } = versionObj;

  if (typeof major !== 'number' || typeof minor !== 'number' || typeof patch !== 'number') {
    throw new Error('Version object must have numeric major, minor, and patch values');
  }

  if (major < 0 || minor < 0 || patch < 0) {
    throw new Error('Version numbers cannot be negative');
  }

  const baseVersion = `${major}.${minor}.${patch}`;
  
  if (isRC) {
    if (typeof rcNumber !== 'number' || rcNumber < 0) {
      throw new Error('Release candidate number must be a non-negative number');
    }
    return `${baseVersion}-RC.${rcNumber}`;
  }

  return baseVersion;
}

/**
 * Increment the major version and reset minor and patch to 0
 * @param {Object} versionObj - Version object to increment
 * @returns {Object} New version object with incremented major
 */
export function incrementMajor(versionObj) {
  const parsed = { ...versionObj };
  return {
    major: parsed.major + 1,
    minor: 0,
    patch: 0,
    isRC: false,
    rcNumber: null
  };
}

/**
 * Increment the minor version and reset patch to 0
 * @param {Object} versionObj - Version object to increment
 * @returns {Object} New version object with incremented minor
 */
export function incrementMinor(versionObj) {
  const parsed = { ...versionObj };
  return {
    major: parsed.major,
    minor: parsed.minor + 1,
    patch: 0,
    isRC: false,
    rcNumber: null
  };
}

/**
 * Increment the patch version
 * @param {Object} versionObj - Version object to increment
 * @returns {Object} New version object with incremented patch
 */
export function incrementPatch(versionObj) {
  const parsed = { ...versionObj };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1,
    isRC: false,
    rcNumber: null
  };
}

/**
 * Convert a version to a release candidate
 * @param {Object} versionObj - Version object to convert
 * @param {number} rcNumber - Release candidate number (defaults to 0)
 * @returns {Object} New version object as release candidate
 */
export function makeReleaseCandidate(versionObj, rcNumber = 0) {
  if (typeof rcNumber !== 'number' || rcNumber < 0) {
    throw new Error('Release candidate number must be a non-negative number');
  }

  const parsed = { ...versionObj };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    isRC: true,
    rcNumber
  };
}

/**
 * Remove release candidate status from a version
 * @param {Object} versionObj - Version object to convert
 * @returns {Object} New version object without RC status
 */
export function removeReleaseCandidate(versionObj) {
  const parsed = { ...versionObj };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    isRC: false,
    rcNumber: null
  };
}

/**
 * Increment the release candidate number
 * @param {Object} versionObj - Version object to increment
 * @returns {Object} New version object with incremented RC number
 * @throws {Error} If version is not a release candidate
 */
export function incrementReleaseCandidate(versionObj) {
  if (!versionObj.isRC) {
    throw new Error('Cannot increment release candidate number on a non-release candidate version');
  }

  const parsed = { ...versionObj };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    isRC: true,
    rcNumber: (parsed.rcNumber || 0) + 1
  };
}

/**
 * Get the short version (without RC suffix)
 * @param {Object} versionObj - Version object
 * @returns {string} Short version string
 */
export function getShortVersion(versionObj) {
  return `${versionObj.major}.${versionObj.minor}.${versionObj.patch}`;
}

/**
 * Check if version string is a release candidate
 * @param {string} versionString - Version string to check
 * @returns {boolean} True if version is a release candidate
 */
export function isReleaseCandidate(versionString) {
  try {
    const parsed = parseVersion(versionString);
    return parsed.isRC;
  } catch (error) {
    return false;
  }
}

export default {
  parseVersion,
  formatVersion,
  incrementMajor,
  incrementMinor,
  incrementPatch,
  makeReleaseCandidate,
  removeReleaseCandidate,
  incrementReleaseCandidate,
  getShortVersion,
  isReleaseCandidate
};