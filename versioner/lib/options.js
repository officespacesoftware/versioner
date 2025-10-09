/**
 * Configuration options for versioner
 * Provides a simple way to manage versioner settings
 */

const defaultOptions = {
  version_file_path: 'VERSION'
};

// Create a mutable copy of default options
let options = { ...defaultOptions };

/**
 * Get all options
 * @returns {Object} Current options object
 */
export function getOptions() {
  return { ...options };
}

/**
 * Set a specific option
 * @param {string} key - Option key
 * @param {any} value - Option value
 */
export function setOption(key, value) {
  options[key] = value;
}

/**
 * Update multiple options at once
 * @param {Object} newOptions - Object containing options to update
 */
export function updateOptions(newOptions) {
  options = { ...options, ...newOptions };
}

/**
 * Reset options to defaults
 */
export function resetOptions() {
  options = { ...defaultOptions };
}

/**
 * Get the version file path
 * @returns {string} Path to the VERSION file
 */
export function getVersionFilePath() {
  return options.version_file_path;
}

// Default export for convenience
export default {
  get: getOptions,
  set: setOption,
  update: updateOptions,
  reset: resetOptions,
  getVersionFilePath
};