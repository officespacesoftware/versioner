import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'temp-git-test');
const CLI_SCRIPT = path.join(__dirname, '../bin/versioner');

/**
 * Execute CLI command in test directory
 * @param {string[]} args - CLI arguments
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runCLI(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode || 0
      });
    });

    proc.on('error', (error) => {
      resolve({
        stdout: '',
        stderr: error.message,
        exitCode: 1
      });
    });
  });
}

/**
 * Setup a temporary git repository for testing
 */
function setupGitRepo() {
  // Create test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Initialize git repo
  execSync('git init', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: TEST_DIR, stdio: 'pipe' });

  // Create initial commit
  fs.writeFileSync(path.join(TEST_DIR, 'README.md'), '# Test Project\n');
  execSync('git add README.md', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: TEST_DIR, stdio: 'pipe' });
}

/**
 * Clean up test directory
 */
function cleanupGitRepo() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

/**
 * Check if git tag exists
 * @param {string} tag - Tag name
 * @returns {boolean}
 */
function gitTagExists(tag) {
  try {
    execSync(`git tag -l "${tag}"`, { cwd: TEST_DIR, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git commit count
 * @returns {number}
 */
function getCommitCount() {
  try {
    const result = execSync('git rev-list --count HEAD', {
      cwd: TEST_DIR,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

describe("CLI Integration Tests", () => {
  beforeEach(() => {
    setupGitRepo();
  });

  afterEach(() => {
    cleanupGitRepo();
  });

  describe("help command", () => {
    test("shows help with no arguments", async () => {
      const result = await runCLI([]);
      assert.ok(result.stdout.includes('Versioner - Version management tool'));
      assert.ok(result.stdout.includes('Usage:'));
      assert.strictEqual(result.exitCode, 0);
    });

    test("shows help with help command", async () => {
      const result = await runCLI(['help']);
      assert.ok(result.stdout.includes('Versioner - Version management tool'));
      assert.ok(result.stdout.includes('Commands:'));
      assert.strictEqual(result.exitCode, 0);
    });

    test("shows help with --help flag", async () => {
      const result = await runCLI(['--help']);
      assert.ok(result.stdout.includes('Versioner - Version management tool'));
      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe("init command", () => {
    test("initializes project with default version", async () => {
      const result = await runCLI(['init']);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(fs.existsSync(path.join(TEST_DIR, 'VERSION')), true);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^0\.1\.0-RC\.0\n/);
    });

    test("initializes project with specified version", async () => {
      const result = await runCLI(['init', '2.0.0-RC.1']);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(fs.existsSync(path.join(TEST_DIR, 'VERSION')), true);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^2\.0\.0-RC\.1\n/);
    });

    test("creates git commit and tag", async () => {
      const initialCommitCount = getCommitCount();

      const result = await runCLI(['init']);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(getCommitCount(), initialCommitCount + 1);
      assert.strictEqual(gitTagExists('0.1.0-RC.0'), true);
    });

    test("uses environment variable VERSION", async () => {
      await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [CLI_SCRIPT, 'init'], {
          cwd: TEST_DIR,
          env: { ...process.env, VERSION: '3.0.0' },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.on('close', () => resolve());
        proc.on('error', reject);
      });

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^3\.0\.0\n/);
    });
  });

  describe("version increment commands", () => {
    beforeEach(async () => {
      // Initialize with a base version first
      await runCLI(['init', '1.0.0']);
    });

    test("patch command increments patch version", async () => {
      const result = await runCLI(['patch']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.0\.1\n/);
      assert.strictEqual(gitTagExists('1.0.1'), true);
    });

    test("minor command increments minor version", async () => {
      const result = await runCLI(['minor']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.1\.0\n/);
      assert.strictEqual(gitTagExists('1.1.0'), true);
    });

    test("major command increments major version", async () => {
      const result = await runCLI(['major']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^2\.0\.0\n/);
      assert.strictEqual(gitTagExists('2.0.0'), true);
    });
  });

  describe("release candidate commands", () => {
    beforeEach(async () => {
      await runCLI(['init', '1.0.0']);
    });

    test("patch-rc creates patch release candidate", async () => {
      const result = await runCLI(['patch-rc']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.0\.1-RC\.0\n/);
      assert.strictEqual(gitTagExists('1.0.1-RC.0'), true);
    });

    test("minor-rc creates minor release candidate", async () => {
      const result = await runCLI(['minor-rc']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.1\.0-RC\.0\n/);
      assert.strictEqual(gitTagExists('1.1.0-RC.0'), true);
    });

    test("major-rc creates major release candidate", async () => {
      const result = await runCLI(['major-rc']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^2\.0\.0-RC\.0\n/);
      assert.strictEqual(gitTagExists('2.0.0-RC.0'), true);
    });

    test("increment-rc increments release candidate number", async () => {
      await runCLI(['patch-rc']);
      const result = await runCLI(['increment-rc']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.0\.1-RC\.1\n/);
      assert.strictEqual(gitTagExists('1.0.1-RC.1'), true);
    });

    test("release removes RC suffix", async () => {
      await runCLI(['patch-rc']);
      const result = await runCLI(['release']);

      assert.strictEqual(result.exitCode, 0);

      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      assert.match(versionContent, /^1\.0\.1\n/);
      assert.strictEqual(gitTagExists('1.0.1'), true);
    });
  });

  describe("show command", () => {
    test("shows current version", async () => {
      await runCLI(['init', '2.5.3']);
      const result = await runCLI(['show']);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), '2.5.3');
    });
  });

  describe("error handling", () => {
    test("shows error for unknown command", async () => {
      const result = await runCLI(['unknown-command']);

      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.stderr.includes('Unknown command: unknown-command'));
    });

    test("shows error when VERSION file doesn't exist", async () => {
      const result = await runCLI(['show']);

      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.stderr.includes("Version file 'VERSION' does not exist. Do you want to:"));
    });

    test("shows error when trying to patch a release candidate", async () => {
      await runCLI(['init', '1.0.0-RC.0']);
      const result = await runCLI(['patch']);

      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.stderr.includes("There's an active release candidate"));
    });
  });

  describe("git integration", () => {
    test("all version commands create commits", async () => {
      const initialCommitCount = getCommitCount();

      await runCLI(['init', '1.0.0']);
      assert.strictEqual(getCommitCount(), initialCommitCount + 1);

      await runCLI(['patch']);
      assert.strictEqual(getCommitCount(), initialCommitCount + 2);

      await runCLI(['patch-rc']);
      assert.strictEqual(getCommitCount(), initialCommitCount + 3);
    });

    test("commits have proper messages", async () => {
      await runCLI(['init', '1.0.0']);

      const commitMessage = execSync('git log -1 --pretty=format:"%s"', {
        cwd: TEST_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      });

      assert.strictEqual(commitMessage, 'To version 1.0.0');
    });

    test("tags have proper messages", async () => {
      await runCLI(['init', '1.0.0']);

      const tagMessage = execSync('git tag -l --format="%(contents)" 1.0.0', {
        cwd: TEST_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      });

      assert.strictEqual(tagMessage.trim(), 'Release version 1.0.0');
    });
  });
});
