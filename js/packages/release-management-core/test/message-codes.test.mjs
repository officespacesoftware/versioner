import { test } from "node:test";
import assert from "node:assert/strict";

import { codedMessage, messageCode } from "../lib/message-codes.js";

const samples = [
  ["G1", "Directory '/tmp/x' is not a Git repository"],
  ["G2", "❌ Cannot proceed: Staged changes detected in git repository\n📋 Staged files:\n  a"],
  ["G5", "Versioner is not available; the version management library failed to load."],
  ["G7", "No GitHub token available. Set GH_TOKEN or GITHUB_TOKEN, or run 'gh auth login' so `gh auth token` returns a token."],
  ["G8", "Could not parse owner/repo from origin URL: /tmp/origin. Expected github.com SSH or HTTPS URL."],
  ["G9", "Failed to look up existing PR for 'release/1.4.0' → 'develop': boom"],
  ["G12", "Git command timed out after 30000ms: git status. The operation may have partially completed — inspect the repository before retrying."],
  ["G13", "Git command failed: Error: fatal: bad object"],
  ["G14", "Could not resolve a commit for branch 'develop'"],
  ["G21", "GitHub App 123 is not installed on acme/widgets (404). Install the app on that repository, or add the repository to the installation's selected repositories."],
  ["U5", "releaseType must be one of: major, minor, patch (defaults to minor if not specified)"],
  ["U6", "There is no downmerge from 'main' to 'main'. Valid routes: main → develop."],
  ["D1", "The repository changed since this plan was created. Expected digest 3f2a1b, got 000000. Review the new plan and confirm again."],
  ["S1", "Ambiguous: Both release/1.4.0 and hotfix/1.4.0 branches exist. Pass the full branch name, release/1.4.0 or hotfix/1.4.0, as the version."],
  ["S2", "No release/1.9.0 or hotfix/1.9.0 branch found for version 1.9.0"],
  ["S2", "No release/1.9.0 branch found"],
  ["S3", "Checked-out branch 'release/1.4.0' is at 1.4.0, which is not a release candidate. Refusing to auto-select a different branch."],
  ["S4", "Checked-out branch 'release/1.4.0' has no readable VERSION file. Refusing to auto-select a different branch."],
  ["S5", "No release candidate branches found. Cannot determine target branch for release."],
  ["S8", "Ambiguous: both release/1.4.0 and hotfix/1.4.0 exist. Pass the full branch name, release/1.4.0 or hotfix/1.4.0, as the version, or check out the one you mean."],
  ["S9", "No release/1.9.0 or hotfix/1.9.0 branch found."],
  ["S10", "'develop' is not a release or hotfix branch, and revert_version will not pick one for you — it deletes tags and can delete a branch."],
  ["S11", "Checked-out branch 'release/1.4.0' has no readable VERSION file, so there is no version to revert."],
  ["S12", "Release branch for version 9.9.9 not found"],
  ["S13", "No hotfix branches found"],
  ["P1", "release/1.4.0 is at 1.4.0, which is not a release candidate, so release_version cannot be planned for it. Use list_versions to find a branch holding an RC."],
  ["P2", "Tag 1.4.0-RC.2 already exists on origin, so creating it again would fail. Use list_versions to see where that version stands."],
  ["P3", "develop has no readable VERSION file at 3f2a1b0c9d8, so create_release_candidate cannot be planned. Use initialize_versioner to create one."],
  ["P4", "develop is at 1.4.0-RC.0, which is still an active release candidate, so create_release_candidate cannot be planned. Promote or retire that candidate first."],
  ["P6", "Branch release/1.4.0 already exists on origin at 1.4.0-RC.3, not 1.4.0-RC.0, so create_release_candidate cannot create it and there is no earlier run to resume."],
  ["P7", "origin/main has 2 commit(s) whose content is not in origin/develop, so the synchronization check aborts the action. Downmerge main into develop first."],
  ["P8", "release/1.4.0 is already merged into develop, so there is nothing to downmerge."],
  ["P9", "release/1.4.0 has no readable VERSION file at 3f2a1b0c9d8, so there is nothing to revert."],
  ["P10", 'The head of release/1.4.0 is "Fix", not "To version 1.4.0-RC.2". revert_version undoes a version bump.'],
  ["P11", "1.4.0 is already in main, so it has shipped and cannot be reverted — it can only be superseded by a new version."],
  ["P12", "release/1.4.0 holds 1 commit(s) that are not in develop, so abandoning it would destroy work:\n  abc Fix\nMerge them first."],
  ["P13", "Could not compare 'release/1.4.0' with 'develop': git merge-tree exited 128 — fatal. Check that both refs exist and share history."],
  ["P14", 'release/1.4.0 is on origin at 1.4.0-RC.0 but tag 1.4.0-RC.0 is not, and no commit "To version 1.4.0-RC.0" on the branch can be tagged.'],
  ["P15", "PR #9 (main-into-develop-1 → develop) is already open from an earlier downmerge of main, and main has moved on since: abc is not in main-into-develop-1."],
  ["P16", "release/1.4.0 is at 1.4.0-RC.1, behind develop at 1.5.0: a newer version has already reached develop, so release/1.4.0 is stale and increment_release_candidate cannot be planned for it."],
  ["P17", "Could not compare release/1.4.0 with develop's version (Could not read version from develop branch VERSION file), so increment_release_candidate cannot be planned."],
  ["W1", "hotfix/1.3.1 reached main but not develop, so develop is missing a fix already in production. Downmerge it into develop first."],
  ["W2", "Could not check for hotfixes missing from develop: boom"],
  ["W3", "main holds 2 commit(s) that release/1.4.0 does not, touching 1 file(s): a. The artifact tagged from release/1.4.0 will not contain them."],
  ["W4", "Merging release/1.4.0 into main conflicts in 1 file(s): a. The downmerge into main will create nothing and stop for a human decision until this is resolved."],
  ["W5", "Could not check whether hotfix/1.3.1 merges cleanly into main: boom"],
  ["W6", "Could not resolve release/1.4.0 or main, so the merge into main was not checked: boom"],
  ["W7", ".release-management.json on develop at 3f2a1b0c9d8 is not valid (\"checks\" must be an array), so no pre-version checks ran."],
  ["W8", 'Pre-version check "audit" failed on develop at 3f2a1b0c9d8 (exit 1). Its output is at the end of the plan.'],
  ["W9", 'Pre-version check "audit" did not finish within 60s on develop at 3f2a1b0c9d8.'],
  ["W10", "Could not run the pre-version checks on develop at 3f2a1b0c9d8: boom"],
  ["W11", ".release-management.json on develop at 3f2a1b0c9d8 is not valid (pipeline.trigger must be a non-empty string), so the pipeline trigger cannot run. If x has no open pull request after the push, start its build by hand."],
  ["W12", "1.4.0 is a FINAL version, not a release candidate."],
  ["W13", "1.4.0-RC.0 is the first version on release/1.4.0, so there is no earlier version to return to. The branch is abandoned rather than rewound."],
  ["W14", "Local release/1.4.0 has 1 commit(s) that origin/release/1.4.0 does not: abc To version 1.4.0-RC.2. Origin is the source of truth."],
  ["W14", "Local release/1.4.0 exists but origin has no release/1.4.0, and it has 1 commit(s) that origin/develop does not: abc x. The apply recreates it."],
  ["W15", "Merging hotfix/1.3.1 into main conflicts in 1 file(s): a. The apply still opens or updates the hotfix/1.3.1 → main pull request."],
  ["N1", "PR #41 is already open for release/1.4.0 → develop; it will be updated, not created."],
  ["N2", "The hotfix/1.3.1 → develop pull request opens as a draft holding only a version bump, and conflicts on VERSION until the fix lands."],
  ["N3", "No tag 1.4.0-RC.2 exists locally or on origin; nothing to delete."],
  ["N4", "Deleting a tag does not undo a build or deployment it already triggered. Pushing to release/1.4.0 may itself trigger a new one."],
  ["N5", "release/1.4.0 is already on origin at 1.4.0-RC.0 (3f2a1b0c9d8), so an earlier run got as far as the push. This resumes it."],
  ["N6", "No hotfix/1.3.1 → develop pull request is open, so one opens as a draft placeholder: it conflicts on VERSION by construction."],
  ["N7", "PR #9 (main-into-develop-1 → develop) is already open from an earlier downmerge and holds main at 3f2a1b0c9d8, so nothing new is created."],
  ["N8", "release/1.4.0 conflicts with develop in 1 file(s): a. No release/1.4.0 → develop pull request is open, so the apply will not open the one listed above: it returns a handoff."],
  ["N9", "release/1.4.0 conflicts with develop in 1 file(s): a. PR #41 stays open and is updated, and the apply also returns a handoff."],
  ["N10", "Could not check whether release/1.4.0 merges cleanly into develop (boom). The apply checks again after the push."],
  ["T1", "Would start the pipeline for release/1.4.0: it has no open pull request. Checked again after the push."],
  ["T2", "Started the pipeline for release/1.4.0: it has no open pull request."],
  ["T3", "Did not start the pipeline for release/1.4.0: PR #41 is open, so its own build runs on the push."],
  ["T4", "Could not read .release-management.json at 3f2a1b0c9d8 (boom), so the pipeline trigger did not run."],
  ["T5", "Could not check whether release/1.4.0 has an open pull request (boom), so the pipeline was not started."],
  ["T6", ".release-management.json at 3f2a1b0c9d8 is not valid (bad), so the pipeline for release/1.4.0 was not started."],
  ["T7", "The pipeline trigger for release/1.4.0 did not finish within 60s. Check whether a build started."],
  ["T8", "The pipeline trigger for release/1.4.0 failed (exit 1), and release/1.4.0 has no open pull request."],
  ["T9", "Could not run the pipeline trigger for release/1.4.0: boom. Start the build by hand."],
  ["T10", "Could not resolve the pushed head of release/1.4.0 (boom), so the pipeline trigger did not run."],
  ["A1", "Step 2 failed: Branch synchronization check failed: Main has 2 commits with actual content differences not in develop."],
  ["A3", "Step 1 failed: develop has no readable VERSION file"],
  ["A4", "Step 3 failed: Failed to create branch 'release/1.4.0' from refs/remotes/origin/develop: boom"],
  ["A6", "Step 4 failed: Failed to create minor release candidate: boom"],
  ["A11", "Failed to check out branch 'release/1.4.0': boom"],
  ["A12", "Branch release/1.4.0 version 1.4.0 is not a release candidate. Only RC versions can be incremented."],
  ["A16", "Failed to increment release candidate: Tag '1.4.0-RC.2' already exists."],
  ["A18", "Failed to push branch 'release/1.4.0' and tag '1.4.0-RC.2': Error: Git command failed: rejected"],
  ["A19", "Branch version 1.4.0 is not a release candidate. Only RC versions can be released."],
  ["A23", "Failed to create GitHub release: Validation Failed"],
  ["A24", "Reverting 3f2a1b0c9d8 conflicts with the current state of the branch, so it was aborted and nothing was changed. Resolve by hand."],
  ["A26", "Failed to push branch 'release/1.4.0': rejected"],
  ["A37", "Origin refused to delete tag 1.4.0-RC.2, so it is still on origin."],
  ["A38", "Origin refused to delete release/1.4.0, so it is still on origin, and the local branch was kept. Already done: tag 1.4.0-RC.0 was deleted."],
  ["A39", "Could not delete the local branch release/1.4.0: boom"],
  ["A28", "Failed to downmerge main to develop: Error: main is already merged into develop, so the merge produced no commit. Nothing was pushed and no pull request was opened."],
  ["A31", "Failed to downmerge release to develop: Error: Failed to create pull request: boom"],
  ["A32", "Cannot initialize the project with a version file: The file VERSION already exists."],
  ["A34", "Invalid version format: 1.0. Expected format: X.Y.Z or X.Y.Z-RC.N. Nothing was written."],
  ["A35", "Tag '1.0.0' already exists. Nothing was written."],
  ["R2", "GitHub returned empty release notes for 1.4.0 on release/1.4.0 (attempt 3/3)."],
  ["R3", "generateReleaseNotes failed (attempt 3/3): boom"],
  ["R4", "GitHub returned empty release notes — generate them manually from the release page."],
  ["R5", "Failed to patch release notes after creation: boom"],
];

for (const [code, text] of samples) {
  test(`${code}: ${text.slice(0, 60)}`, () => {
    assert.equal(messageCode(text), code);
  });
}

test("texts two actions share are told apart by the action", () => {
  const push = "Step 5 failed: Failed to push branch 'release/1.4.0' and tag '1.4.0-RC.0': rejected";
  assert.equal(messageCode(push, "create_release_candidate"), "A7");
  assert.equal(messageCode(push, "increment_release_candidate"), "A18");

  const checkout = "Failed to check out branch 'release/1.4.0': boom";
  assert.equal(messageCode(checkout, "revert_version"), "A27");
  assert.equal(messageCode(checkout, "release_version"), "A11");

  const missing = "No release/1.9.0 branch found.";
  assert.equal(messageCode(missing, "revert_version"), "S9");
});

test("a text the catalog does not list has no code", () => {
  assert.equal(messageCode("Something unexpected"), undefined);
  assert.deepEqual(codedMessage("Something unexpected"), {
    text: "Something unexpected",
  });
  assert.deepEqual(codedMessage("Merge once green, maybe"), {
    text: "Merge once green, maybe",
  });
});
