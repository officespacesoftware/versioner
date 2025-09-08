/**
 * File utilities for VERSION file operations
 * Uses only Node.js built-ins for compatibility
 */

import fs from 'fs';
import path from 'path';

/**
 * Check if a file exists
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if file exists
 */
export function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

/**
 * Read VERSION file and parse its contents
 * @param {string} filePath - Path to the VERSION file
 * @returns {Object} Object with version and gitHash properties
 * @throws {Error} If file doesn't exist or cannot be read
 */
export function readVersionFile(filePath) {
  if (!fileExists(filePath)) {
    throw new Error(`Version file '${filePath}' does not exist.`);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    
    if (lines.length < 1) {
      throw new Error(`Version file '${filePath}' is empty or invalid.`);
    }

    const version = lines[0].trim();
    const gitHash = lines.length > 1 ? lines[1].trim() : '';

    if (!version) {
      throw new Error(`Version file '${filePath}' contains no version information.`);
    }

    return {
      version,
      gitHash
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Version file '${filePath}' does not exist.`);
    }
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied reading version file '${filePath}'.`);
    }
    throw error;
  }
}

/**
 * Write version and git hash to VERSION file
 * @param {string} filePath - Path to the VERSION file
 * @param {string} version - Version string to write
 * @param {string} gitHash - Git hash to write (optional)
 * @throws {Error} If file cannot be written
 */
export function writeVersionFile(filePath, version, gitHash = '') {
  if (!version || typeof version !== 'string') {
    throw new Error('Version must be a non-empty string');
  }

  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = gitHash ? `${version}\n${gitHash}\n` : `${version}\n`;
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (error) {
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied writing to version file '${filePath}'.`);
    }
    if (error.code === 'ENOENT') {
      throw new Error(`Cannot write to version file '${filePath}' - directory may not exist.`);
    }
    throw new Error(`Failed to write version file '${filePath}': ${error.message}`);
  }
}

/**
 * Create a new VERSION file with initial version and git hash
 * @param {string} filePath - Path to the VERSION file
 * @param {string} version - Initial version string
 * @param {string} gitHash - Git hash to include
 * @throws {Error} If file already exists or cannot be created
 */
export function createVersionFile(filePath, version, gitHash = '') {
  if (fileExists(filePath)) {
    throw new Error(`Cannot initialize the project with a version file: The file ${filePath} already exists.`);
  }

  writeVersionFile(filePath, version, gitHash);
}

export default {
  fileExists,
  readVersionFile,
  writeVersionFile,
  createVersionFile
};