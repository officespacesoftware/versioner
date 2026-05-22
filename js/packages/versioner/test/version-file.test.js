import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
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
    assert.match(versionFile.version(), /^\d+\.\d+\.\d+$/);
    assert.strictEqual(versionFile.version(), "0.9.12");
  });

  describe("when incrementing the patch version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patch();
    });

    test("increments patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "13");
    });

    test("keeps the minor version the same", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "9");
    });

    test("keeps the major version the same", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("isn't a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });
  });

  describe("when incrementing the minor version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minor();
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("increments the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "10");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("isn't a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });
  });

  describe("when incrementing the major version", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.major();
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("resets the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "0");
    });

    test("increments major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "1");
    });

    test("isn't a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });
  });

  describe("when creating a patch version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.patchReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("increments the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "13");
    });

    test("does not change the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "9");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("is at RC iteration 0", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "0.9.13-RC.0");
    });
  });

  describe("when creating a minor version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.minorReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("increments the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "10");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("is at RC iteration 0", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "0.10.0-RC.0");
    });
  });

  describe("when creating a major version release candidate", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
      versionFile.majorReleaseCandidate();
    });

    test("marks the version as a release candidate", () => {
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("resets the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "0");
    });

    test("increments the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "1");
    });

    test("is at RC iteration 0", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "0");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "1.0.0-RC.0");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("increments the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "13");
    });

    test("does not change the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "9");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("is at RC iteration 1", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "0.9.13-RC.1");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("increments the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "10");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("is at RC iteration 1", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "0.10.0-RC.1");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), true);
    });

    test("resets the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("resets the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "0");
    });

    test("increments the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "1");
    });

    test("is at RC iteration 1", () => {
      assert.strictEqual(versionFile.releaseCandidateIteration(), "1");
    });

    test("has RC and the RC version number at the end of the name", () => {
      assert.strictEqual(versionFile.version(), "1.0.0-RC.1");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });

    test("does not change the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "13");
    });

    test("does not change the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "9");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("goes back to looking like a normal release", () => {
      assert.strictEqual(versionFile.version(), "0.9.13");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });

    test("does not change the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("does not change the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "10");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "0");
    });

    test("goes back to looking like a normal release", () => {
      assert.strictEqual(versionFile.version(), "0.10.0");
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
      assert.strictEqual(versionFile.isReleaseCandidate(), false);
    });

    test("does not change the patch version", () => {
      assert.strictEqual(versionFile.currentPatchVersion(), "0");
    });

    test("does not change the minor version", () => {
      assert.strictEqual(versionFile.currentMinorVersion(), "0");
    });

    test("does not change the major version", () => {
      assert.strictEqual(versionFile.currentMajorVersion(), "1");
    });

    test("goes back to looking like a normal release", () => {
      assert.strictEqual(versionFile.version(), "1.0.0");
    });
  });

  describe("with error conditions", () => {
    let versionFile;

    beforeEach(() => {
      versionFile = new VersionFile(TEST_VERSION_FILE);
    });

    test("isn't able to increment the release candidate unless the current version is some kind of release candidate", () => {
      assert.throws(() => {
        versionFile.incrementReleaseCandidate();
      });
    });

    test("isn't able to declare a patch release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.patchReleaseCandidate();
      });
    });

    test("isn't able to declare a minor release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.minorReleaseCandidate();
      });
    });

    test("isn't able to declare a major release candidate unless the current version is not a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.majorReleaseCandidate();
      });
    });

    test("isn't able to increment the patch version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.patch();
      });
    });

    test("isn't able to increment the minor version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.minor();
      });
    });

    test("isn't able to increment the major version on a release candidate", () => {
      versionFile.minorReleaseCandidate();
      assert.throws(() => {
        versionFile.major();
      });
    });

    test("cannot release a non release candidate", () => {
      assert.throws(() => {
        versionFile.release();
      });
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
      assert.throws(() => {
        VersionFile.create({ path: TEST_VERSION_FILE });
      });
    });

    test("creates a version file", () => {
      const mockGitHash = "abc123";
      
      writeVersionFile(newVersionFile, '1.0.0', mockGitHash);
      
      const versionFile = new VersionFile(newVersionFile);
      assert.strictEqual(versionFile.version(), '1.0.0');
    });
  });
});