/**
 * Versioner - Main entry point
 * Exports all functionality for programmatic use
 */

// Core classes
export { VersionFile } from './version-file.js';

// Task functions
export {
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
} from './tasks.js';

// Utility modules
export * as options from './options.js';
export * as fileUtils from './file-utils.js';
export * as gitUtils from './git-utils.js';
export * as versionParser from './version-parser.js';

// Default export with everything
export default {
  VersionFile: VersionFile,
  tasks: {
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
  },
  options,
  fileUtils,
  gitUtils,
  versionParser
};

// Re-import tasks for default export
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
  show,
  showVersion
} from './tasks.js';

import { VersionFile } from './version-file.js';
import * as options from './options.js';
import * as fileUtils from './file-utils.js';
import * as gitUtils from './git-utils.js';
import * as versionParser from './version-parser.js';