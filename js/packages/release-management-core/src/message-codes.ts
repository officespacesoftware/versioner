export interface CodedMessage {
  code?: string;
  text: string;
}

type Pattern = [code: string, pattern: RegExp, actions?: readonly string[]];

const REVERT = ["revert_version"] as const;
const CREATE = ["create_release_candidate", "create_hotfix"] as const;

const PATTERNS: readonly Pattern[] = [
  ["D1", /^The repository changed since this plan was created\./],

  ["A1", /^Branch synchronization check failed: Main has /],
  ["A2", /^Branch synchronization check failed: Failed to verify /],
  ["A3", /^(develop|main) has no readable VERSION file$/],
  ["A4", /^Failed to create branch '/],
  ["A6", /^Failed to create (major|minor|patch) release candidate: /],
  ["A7", /^Failed to push branch '[^']*' and tag '/, CREATE],
  ["A18", /^Failed to push branch '[^']*' and tag '/],
  ["A26", /^Failed to push branch '[^']*': /],
  ["A8", /^Failed to create pull request: /],
  ["A9", /^No open PR found for head '/],
  ["A10", /^Failed to edit PR #\d+: /],
  ["A36", /^No commit "To version [^"]+" on origin\/\S+ to tag$/],
  ["A27", /^Failed to (check out branch|reset) '/, REVERT],
  ["A11", /^Failed to (check out branch|reset) '/],
  ["A12", /Only RC versions can be incremented\.$/],
  ["A13", /\. Cannot proceed with increment\.$/],
  ["A14", /^Could not read version from \S+ branch VERSION file$/],
  ["A15", /^Failed to validate branch version: /],
  ["A16", /^Failed to increment release candidate: /],
  ["A17", /^Target version not available for push operation$/],
  ["A19", /Only RC versions can be released\.$/],
  ["A20", /^Failed to release version: /],
  ["A22", /^Target version not available (for tag operation|in context)$/],
  ["A23", /^Failed to create GitHub release: /],
  ["A24", /^Reverting \S+ conflicts with the current state of the branch/],
  ["A25", /^Failed to delete GitHub release /],
  ["A37", /^Origin refused to delete tag /],
  ["A38", /^Origin refused to delete \S+, so it is still on origin, and the local branch was kept\./],
  ["A39", /^Could not delete the local branch /],
  ["A28", /^Failed to downmerge [a-z ]+: Error: \S+ is already merged into \S+, so the merge produced no commit\./],
  ["A29", /^Failed to downmerge [a-z ]+: Error: Refusing to probe for merge conflicts/],
  ["A30", /^Failed to downmerge [a-z ]+: Error: Merge probe of /],
  ["A31", /^Failed to downmerge [a-z ]+: /],
  ["A40", / Removing what it created also failed \(/],
  ["A32", /^Cannot initialize the project with a version file: The file VERSION already exists\./],
  ["A33", /^The usage of this tool requires an existing git project with at least one revision\./],
  ["A34", /^Invalid version format: .*Nothing was written\.$/],
  ["A35", /^Tag '[^']+' already exists\. Nothing was written\.$/],

  ["G1", /^Directory '.*' is not a Git repository$/],
  ["G2", /Cannot proceed: Staged changes detected in git repository/],
  ["G3", /^Failed to validate git status: /],
  ["G4", /^Versioner MCP is not available\./],
  ["G5", /^Versioner is not available; the version management library failed to load\./],
  ["G6", /^Failed to initialize ReleaseAgent: /],
  ["G7", /^No GitHub token available\./],
  ["G8", /^Could not parse owner\/repo from origin URL: /],
  ["G9", /^Failed to look up existing PR for '/],
  ["G10", /^Failed to look up open PRs from '/],
  ["G11", /^Failed to look up the GitHub release for /],
  ["G12", /^Git command timed out after \d+ms: /],
  ["G14", /^Could not resolve a commit for branch '/],
  ["G15", /^Failed to look up open PRs into '/],
  ["G16", /^A GitHub App private key is set /],
  ["G17", /^GITHUB_APP_ID is set but no private key is/],
  ["G18", /^Both GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are set\./],
  ["G19", / does not hold a valid RSA private key in PEM form\./],
  ["G20", /^Could not read the GitHub App private key file /],
  ["G21", /^GitHub App \S+ is not installed on \S+ \(404\)\./],
  ["G22", /^GitHub rejected the credentials of GitHub App /],
  ["G23", /^GitHub refused .* for GitHub App \S+ \(403\)\./],
  ["G24", /^GitHub answered \d+ while .* for GitHub App /],
  ["G25", /^Could not reach GitHub while .* for GitHub App /],

  ["U5", /^releaseType must be one of: major, minor, patch/],
  ["U6", /^There is no downmerge from '/],

  ["S1", /^Ambiguous: Both release\/\S+ and hotfix\/\S+ branches exist\./],
  ["S8", /^Ambiguous: both release\/\S+ and hotfix\/\S+ exist\./],
  ["S2", /^No release\/\S+ or hotfix\/\S+ branch found for version \S+$/],
  ["S9", /^No release\/\S+ or hotfix\/\S+ branch found\.$/],
  ["S9", /^No (release|hotfix)\/\S+ branch found\.$/, REVERT],
  ["S2", /^No (release|hotfix)\/\S+ branch found$/],
  ["S3", /^Checked-out branch '[^']+' is at \S+, which is not a release candidate\. Refusing/],
  ["S11", /^Checked-out branch '[^']+' has no readable VERSION file, so there is no version to revert\.$/],
  ["S4", /^Checked-out branch '[^']+' has no readable VERSION file\. Refusing/],
  ["S5", /^No release candidate branches found\./],
  ["S7", /^Failed to select target release branch: /],
  ["S10", /is not a release or hotfix branch, and revert_version will not pick one for you/],
  ["S12", /^(Release|Hotfix) branch for version \S+ not found$/],
  ["S13", /^No (release|hotfix) branches found$/],

  ["P1", /is at \S+, which is not a release candidate, so \S+ cannot be planned for it\./],
  ["P2", /^Tag \S+ already exists on origin, so creating it again would fail\./],
  ["P3", /has no readable VERSION file at \S+, so \S+ cannot be planned\./],
  ["P4", /which is still an active release candidate, so \S+ cannot be planned\./],
  ["P5", /which is not a semantic version, so \S+ cannot be planned\./],
  ["P6", /^Branch \S+ already exists on origin at .*, not \S+, so \S+ cannot create it/],
  ["P7", /^origin\/main has \d+ commit\(s\) whose content is not in origin\/develop/],
  ["P8", /is already merged into \S+, so there is nothing to downmerge\.$/],
  ["P9", /has no readable VERSION file at \S+, so there is nothing to revert\.$/],
  ["P10", /^The head of \S+ is ".*", not "To version /],
  ["P11", /is already in main, so it has shipped and cannot be reverted/],
  ["P12", /holds \d+ commit\(s\) that are not in \S+, so abandoning it would destroy work/],
  ["P13", /^Could not compare '[^']+' with '[^']+': git merge-tree exited /],
  ["P14", /is on origin at \S+ but tag \S+ is not, and no commit "To version /],
  ["P15", /is already open from an earlier downmerge of \S+, and \S+ has moved on since/],
  ["P16", /is stale and increment_release_candidate cannot be planned for it\./],
  ["P17", /^Could not compare \S+ with \S+'s version \(/],

  ["W1", /reached main but not \S+, so \S+ is missing (a fix|fixes) already in production\./],
  ["W2", /^Could not check for hotfixes missing from /],
  ["W3", /^main holds \d+ commit\(s\) that \S+ does not, touching \d+ file\(s\)/],
  ["W4", /^Merging \S+ into main conflicts in \d+ file\(s\): .*The downmerge into main will create nothing/],
  ["W15", /^Merging \S+ into main conflicts in \d+ file\(s\): .*The apply still opens or updates/],
  ["W5", /^Could not check whether \S+ merges cleanly into main: /],
  ["W6", /^Could not resolve \S+ or main, so the merge into main was not checked: /],
  ["W7", /is not valid \(.*\), so no pre-version checks ran\.$/],
  ["W8", /^Pre-version check ".*" failed on .* \(exit \d+\)\./],
  ["W9", /^Pre-version check ".*" did not finish within \d+s on /],
  ["W10", /^Could not run the pre-version checks on /],
  ["W11", /is not valid \(.*\), so the pipeline trigger cannot run\./],
  ["W12", /^\S+ is a FINAL version, not a release candidate\.$/],
  ["W13", /is the first version on \S+, so there is no earlier version to return to\./],
  ["W14", /^Local \S+ (has|exists but origin has no \S+, and it has) \d+ commit\(s\) that origin\/\S+ does not: /],

  ["N1", /^PR #\d+ is already open for \S+ → \S+; it will be updated, not created\.$/],
  ["N2", /pull request opens as a draft holding only a version bump/],
  ["N3", /^No tag \S+ exists locally or on origin; nothing to delete\.$/],
  ["N4", /^Deleting a tag does not undo a build or deployment it already triggered\./],
  ["N5", /is already on origin at \S+ \(\S+\), so an earlier run got as far as the push\./],
  ["N6", /pull request is open, so one opens as a draft placeholder/],
  ["N7", /is already open from an earlier downmerge and holds \S+ at \S+, so nothing new is created\./],
  ["N8", /conflicts with develop in \d+ file\(s\): .*pull request is open, so the apply will not open the one listed above/],
  ["N9", /conflicts with develop in \d+ file\(s\): .*stays open and is updated, and the apply also returns/],
  ["N10", /^Could not check whether \S+ merges cleanly into develop \(/],

  ["T1", /^Would start the pipeline for \S+: it has no open pull request\./],
  ["T2", /^Started the pipeline for \S+: it has no open pull request\.$/],
  ["T3", /^Did not start the pipeline for \S+: PR #\d+ is open/],
  ["T4", /^Could not read \.release-management\.json at \S+ \(/],
  ["T5", /^Could not check whether \S+ has an open pull request \(/],
  ["T6", /^\.release-management\.json at \S+ is not valid \(.*\), so the pipeline for /],
  ["T7", /^The pipeline trigger for \S+ did not finish within \d+s\./],
  ["T8", /^The pipeline trigger for \S+ failed \(exit \d+\)/],
  ["T9", /^Could not run the pipeline trigger for /],
  ["T10", /^Could not resolve the pushed head of /],

  ["R2", /^GitHub returned empty release notes for \S+ on \S+ \(attempt \d+\/\d+\)\.$/],
  ["R3", /^generateReleaseNotes failed \(attempt \d+\/\d+\): /],
  ["R4", /^GitHub returned empty release notes — generate them manually/],
  ["R5", /^Failed to patch release notes after creation: /],

  ["G13", /^Git command failed: /],
];

const STEP_PREFIX = /^Step \d+ failed: /;
const ERROR_PREFIX = /^Error: /;

export function messageCode(text: string, action?: string): string | undefined {
  const bare = text.replace(STEP_PREFIX, "").replace(ERROR_PREFIX, "");
  for (const [code, pattern, actions] of PATTERNS) {
    if (actions && (action === undefined || !actions.includes(action))) {
      continue;
    }
    if (pattern.test(bare)) {
      return code;
    }
  }
  return undefined;
}

export function codedMessage(text: string, action?: string): CodedMessage {
  const code = messageCode(text, action);
  return code === undefined ? { text } : { code, text };
}
