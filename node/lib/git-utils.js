/**
 * Git integration utilities
 * Uses only Node.js built-ins for compatibility
 */

import { execSync } from 'child_process';

/**
 * Execute a git command synchronously
 * @param {string} command - Git command to execute
 * @param {Object} options - Options for execSync
 * @returns {string} Command output
 * @throws {Error} If command fails
 */
function executeGitCommand(command, options = {}) {
  try {
    const result = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return result.trim();
  } catch (error) {
    throw new Error(`Git command failed: ${command}\n${error.message}`);
  }
}

/**
 * Check if current directory is a git repository
 * @returns {boolean} True if current directory is a git repo
 */
export function isGitRepository() {
  try {
    executeGitCommand('git rev-parse --git-dir');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get the current git commit hash (short format)
 * @returns {string} Short commit hash
 * @throws {Error} If not in a git repository or no commits exist
 */
export function getShortCommitHash() {
  if (!isGitRepository()) {
    throw new Error('The usage of this tool requires an existing git project with at least one revision.');
  }

  try {
    const hash = executeGitCommand('git rev-parse --short HEAD');
    if (!hash) {
      throw new Error('No commits found in the repository.');
    }
    return hash;
  } catch (error) {
    if (error.message.includes('bad revision')) {
      throw new Error('The usage of this tool requires an existing git project with at least one revision.');
    }
    throw error;
  }
}

/**
 * Stage a file for commit
 * @param {string} filePath - Path to the file to stage
 * @throws {Error} If git add fails
 */
export function gitAdd(filePath) {
  if (!isGitRepository()) {
    throw new Error('Not in a git repository.');
  }

  try {
    executeGitCommand(`git add "${filePath}"`);
  } catch (error) {
    throw new Error(`Failed to stage file '${filePath}': ${error.message}`);
  }
}

/**
 * Create a git commit with a message
 * @param {string} message - Commit message
 * @throws {Error} If git commit fails
 */
export function gitCommit(message) {
  if (!isGitRepository()) {
    throw new Error('Not in a git repository.');
  }

  if (!message || typeof message !== 'string') {
    throw new Error('Commit message must be a non-empty string.');
  }

  try {
    executeGitCommand(`git commit -m "${message.replace(/"/g, '\\"')}"`);
  } catch (error) {
    // Handle case where there's nothing to commit
    if (error.message.includes('nothing to commit')) {
      throw new Error('Nothing to commit. Make sure files are staged with git add.');
    }
    throw new Error(`Failed to create commit: ${error.message}`);
  }
}

/**
 * Create an annotated git tag
 * @param {string} tag - Tag name
 * @param {string} message - Tag message
 * @throws {Error} If git tag fails
 */
export function gitTag(tag, message) {
  if (!isGitRepository()) {
    throw new Error('Not in a git repository.');
  }

  if (!tag || typeof tag !== 'string') {
    throw new Error('Tag name must be a non-empty string.');
  }

  if (!message || typeof message !== 'string') {
    throw new Error('Tag message must be a non-empty string.');
  }

  try {
    executeGitCommand(`git tag "${tag}" -a -m "${message.replace(/"/g, '\\"')}"`);
  } catch (error) {
    if (error.message.includes('already exists')) {
      throw new Error(`Tag '${tag}' already exists.`);
    }
    throw new Error(`Failed to create tag '${tag}': ${error.message}`);
  }
}

/**
 * Check if there are uncommitted changes
 * @returns {boolean} True if there are uncommitted changes
 */
export function hasUncommittedChanges() {
  if (!isGitRepository()) {
    return false;
  }

  try {
    const status = executeGitCommand('git status --porcelain');
    return status.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get current branch name
 * @returns {string} Current branch name
 * @throws {Error} If not in a git repository
 */
export function getCurrentBranch() {
  if (!isGitRepository()) {
    throw new Error('Not in a git repository.');
  }

  try {
    return executeGitCommand('git branch --show-current');
  } catch (error) {
    throw new Error(`Failed to get current branch: ${error.message}`);
  }
}

export default {
  isGitRepository,
  getShortCommitHash,
  gitAdd,
  gitCommit,
  gitTag,
  hasUncommittedChanges,
  getCurrentBranch
};