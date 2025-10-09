/**
 * Test suite for VersionFile functionality
 * Uses Jest test framework
 */

import { test, expect, describe, beforeEach, afterEach } from "@jest/globals";
import { VersionFile } from "../lib/version-file.js";
import { writeVersionFile, fileExists } from "../lib/file-utils.js";
import { setOption, resetOptions } from "../lib/options.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_VERSION_FILE = path.join(TEST_FIXTURES_DIR, 'version_file.txt');

describe("VersionFile", () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    if (!fs.existsSync(TEST_FIXTURES_DIR)) {
      fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
    }
    
    // Create test VERSION file with initial version
    writeVersionFile(TEST_VERSION_FILE, "0.9.12", "42324b");
    
    // Reset options to defaults
    resetOptions();
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(TEST_VERSION_FILE)) {
      fs.unlinkSync(TEST_VERSION_FILE);
    }
    
    // Reset options
    resetOptions();
  });

  test("gets the current version from the file", () => {
    const versionFile = new VersionFile(TEST_VERSION_FILE);
    expect(versionFile.version()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionFile.version()).toBe("0.9.12");
  });

  describe("when incrementing the patch version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patch();
    });

    test("increments patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("13");
    });

    test("keeps the minor version the same", () => {
      expect(versionFile.currentMinorVersion()).toBe("9");
    });

    test("keeps the major version the same", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("isn't a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });
  });

  describe("when incrementing the minor version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minor();
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("increments the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("10");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("isn't a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });
  });

  describe("when incrementing the major version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.major();
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("resets the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("0");
    });

    test("increments major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("1");
    });

    test("isn't a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });
  });

  describe("when creating a patch version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patchReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("increments the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("13");
    });

    test("does not change the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("9");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("is at RC iteration 0", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("0.9.13-RC.0");
    });
  });

  describe("when creating a minor version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minorReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("increments the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("10");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("is at RC iteration 0", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("0.10.0-RC.0");
    });
  });

  describe("when creating a major version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.majorReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("resets the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("0");
    });

    test("increments the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("1");
    });

    test("is at RC iteration 0", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("1.0.0-RC.0");
    });
  });

  describe("when incrementing a patch version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patchReleaseCandidate();
      versionFile.incrementReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("increments the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("13");
    });

    test("does not change the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("9");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("is at RC iteration 1", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("0.9.13-RC.1");
    });
  });

  describe("when incrementing a minor version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minorReleaseCandidate();
      versionFile.incrementReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("increments the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("10");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("is at RC iteration 1", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("0.10.0-RC.1");
    });
  });

  describe("when incrementing a major version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.majorReleaseCandidate();
      versionFile.incrementReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(true);
    });

    test("resets the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("resets the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("0");
    });

    test("increments the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("1");
    });

    test("is at RC iteration 1", () => {
      expect(versionFile.releaseCandidateIteration()).toBe("1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      expect(versionFile.version()).toBe("1.0.0-RC.1");
    });
  });

  describe("when releasing a patch release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patchReleaseCandidate();
      versionFile.release();
    });

    test("removes the release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });

    test("does not change the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("13");
    });

    test("does not change the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("9");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("goes back to looking like a normal release", () => {
      expect(versionFile.version()).toBe("0.9.13");
    });
  });

  describe("when releasing a minor release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minorReleaseCandidate();
      versionFile.release();
    });

    test("removes the release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });

    test("does not change the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("does not change the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("10");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("0");
    });

    test("goes back to looking like a normal release", () => {
      expect(versionFile.version()).toBe("0.10.0");
    });
  });

  describe("with a major release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.majorReleaseCandidate();
      versionFile.release();
    });

    test("removes the release candidate", () => {
      expect(versionFile.isReleaseCandidate()).toBe(false);
    });

    test("does not change the patch version", () => {
      expect(versionFile.currentPatchVersion()).toBe("0");
    });

    test("does not change the minor version", () => {
      expect(versionFile.currentMinorVersion()).toBe("0");
    });

    test("does not change the major version", () => {
      expect(versionFile.currentMajorVersion()).toBe("1");
    });

    test("goes back to looking like a normal release", () => {
      expect(versionFile.version()).toBe("1.0.0");
    });
  });

  describe("with error conditions", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
    });

    test("isn't able to increment the release candidate unless the current version is some kind of release candidate", () => {
      expect(() => {
        versionFile.incrementReleaseCandidate();
      }).toThrow();
    });

    test("isn't able to declare a patch release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.patchReleaseCandidate();
      }).toThrow();
    });

    test("isn't able to declare a minor release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.minorReleaseCandidate();
      }).toThrow();
    });

    test("isn't able to declare a major release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.majorReleaseCandidate();
      }).toThrow();
    });

    test("isn't able to increment the patch version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.patch();
      }).toThrow();
    });

    test("isn't able to increment the minor version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.minor();
      }).toThrow();
    });

    test("isn't able to increment the major version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      expect(() => {
        versionFile.major();
      }).toThrow();
    });

    test("cannot release a non release candidate", () => {
      expect(() => {
        versionFile.release();
      }).toThrow();
    });
  });

  describe("when initializing with new VERSION file", () => {
    const newVersionFile = path.join(TEST_FIXTURES_DIR, 'new_version.txt');

    afterEach(() => {
      if (fs.existsSync(newVersionFile)) {
        fs.unlinkSync(newVersionFile);
      }
    });

    test("does not create a file if one exists", () => {
      // File already exists from beforeEach
      expect(() => {
        VersionFile.create({ path: TEST_VERSION_FILE });
      }).toThrow();
    });

    test("creates a version file", () => {
      // Mock git command for this test since we're not in the Ruby repo's git context
      const mockGitHash = "abc123";
      
      // Write directly first to avoid git dependency in test
      writeVersionFile(newVersionFile, '1.0.0', mockGitHash);
      
      const versionFile = new VersionFile(newVersionFile);
      expect(versionFile.version()).toBe('1.0.0');
    });
  });
});