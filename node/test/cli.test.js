/**
 * CLI Integration tests
 * Tests the CLI interface and Git integration using Bun's test framework
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TEST_DIR = path.join(import.meta.dir, 'temp-git-test');
const CLI_SCRIPT = path.join(import.meta.dir, '../bin/versioner');

/**
 * Execute CLI command in test directory
 * @param {string[]} args - CLI arguments
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runCLI(args) {
  try {
    const proc = spawn([process.execPath, CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const result = await proc.exited;
    
    return {
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode: result
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: error.message,
      exitCode: 1
    };
  }
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
      expect(result.stdout).toContain('Versioner - Version management tool');
      expect(result.stdout).toContain('Usage:');
      expect(result.exitCode).toBe(0);
    });

    test("shows help with help command", async () => {
      const result = await runCLI(['help']);
      expect(result.stdout).toContain('Versioner - Version management tool');
      expect(result.stdout).toContain('Commands:');
      expect(result.exitCode).toBe(0);
    });

    test("shows help with --help flag", async () => {
      const result = await runCLI(['--help']);
      expect(result.stdout).toContain('Versioner - Version management tool');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("init command", () => {
    test("initializes project with default version", async () => {
      const result = await runCLI(['init']);
      
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(TEST_DIR, 'VERSION'))).toBe(true);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^0\.1\.0-RC\.0\n/);
    });

    test("initializes project with specified version", async () => {
      const result = await runCLI(['init', '2.0.0-RC.1']);
      
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(TEST_DIR, 'VERSION'))).toBe(true);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^2\.0\.0-RC\.1\n/);
    });

    test("creates git commit and tag", async () => {
      const initialCommitCount = getCommitCount();
      
      const result = await runCLI(['init']);
      
      expect(result.exitCode).toBe(0);
      expect(getCommitCount()).toBe(initialCommitCount + 1);
      expect(gitTagExists('0.1.0-RC.0')).toBe(true);
    });

    test("uses environment variable VERSION", async () => {
      const proc = spawn([process.execPath, CLI_SCRIPT, 'init'], {
        cwd: TEST_DIR,
        env: { ...process.env, VERSION: '3.0.0' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      await proc.exited;
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^3\.0\.0\n/);
    });
  });

  describe("version increment commands", () => {
    beforeEach(async () => {
      // Initialize with a base version first
      await runCLI(['init', '1.0.0']);
    });

    test("patch command increments patch version", async () => {
      const result = await runCLI(['patch']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.0\.1\n/);
      expect(gitTagExists('1.0.1')).toBe(true);
    });

    test("minor command increments minor version", async () => {
      const result = await runCLI(['minor']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.1\.0\n/);
      expect(gitTagExists('1.1.0')).toBe(true);
    });

    test("major command increments major version", async () => {
      const result = await runCLI(['major']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^2\.0\.0\n/);
      expect(gitTagExists('2.0.0')).toBe(true);
    });
  });

  describe("release candidate commands", () => {
    beforeEach(async () => {
      await runCLI(['init', '1.0.0']);
    });

    test("patch-rc creates patch release candidate", async () => {
      const result = await runCLI(['patch-rc']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.0\.1-RC\.0\n/);
      expect(gitTagExists('1.0.1-RC.0')).toBe(true);
    });

    test("minor-rc creates minor release candidate", async () => {
      const result = await runCLI(['minor-rc']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.1\.0-RC\.0\n/);
      expect(gitTagExists('1.1.0-RC.0')).toBe(true);
    });

    test("major-rc creates major release candidate", async () => {
      const result = await runCLI(['major-rc']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^2\.0\.0-RC\.0\n/);
      expect(gitTagExists('2.0.0-RC.0')).toBe(true);
    });

    test("increment-rc increments release candidate number", async () => {
      await runCLI(['patch-rc']);
      const result = await runCLI(['increment-rc']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.0\.1-RC\.1\n/);
      expect(gitTagExists('1.0.1-RC.1')).toBe(true);
    });

    test("release removes RC suffix", async () => {
      await runCLI(['patch-rc']);
      const result = await runCLI(['release']);
      
      expect(result.exitCode).toBe(0);
      
      const versionContent = fs.readFileSync(path.join(TEST_DIR, 'VERSION'), 'utf8');
      expect(versionContent).toMatch(/^1\.0\.1\n/);
      expect(gitTagExists('1.0.1')).toBe(true);
    });
  });

  describe("show command", () => {
    test("shows current version", async () => {
      await runCLI(['init', '2.5.3']);
      const result = await runCLI(['show']);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('2.5.3');
    });
  });

  describe("error handling", () => {
    test("shows error for unknown command", async () => {
      const result = await runCLI(['unknown-command']);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown command: unknown-command');
    });

    test("shows error when VERSION file doesn't exist", async () => {
      const result = await runCLI(['show']);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Version file 'VERSION' does not exist");
    });

    test("shows error when trying to patch a release candidate", async () => {
      await runCLI(['init', '1.0.0-RC.0']);
      const result = await runCLI(['patch']);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Cannot patch a release candidate');
    });
  });

  describe("git integration", () => {
    test("all version commands create commits", async () => {
      const initialCommitCount = getCommitCount();
      
      await runCLI(['init']);
      expect(getCommitCount()).toBe(initialCommitCount + 1);
      
      await runCLI(['patch']);
      expect(getCommitCount()).toBe(initialCommitCount + 2);
      
      await runCLI(['patch-rc']);
      expect(getCommitCount()).toBe(initialCommitCount + 3);
    });

    test("commits have proper messages", async () => {
      await runCLI(['init', '1.0.0']);
      
      const commitMessage = execSync('git log -1 --pretty=format:"%s"', {
        cwd: TEST_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      expect(commitMessage).toBe('To version 1.0.0');
    });

    test("tags have proper messages", async () => {
      await runCLI(['init', '1.0.0']);
      
      const tagMessage = execSync('git tag -l --format="%(contents)" 1.0.0', {
        cwd: TEST_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      expect(tagMessage.trim()).toBe('Release version 1.0.0');
    });
  });
});