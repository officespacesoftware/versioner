# @officespacesoftware/versioner

Version-numbering tasks that create the appropriate Git objects.

This package owns the `VERSION` file. Every version change it makes is followed by a git
commit and an annotated git tag. It is the JavaScript counterpart of the `versioner` Ruby
gem in the same repository, and the two share the `VERSION` file format and the git object
formats.

Pure ESM JavaScript, no build step, no runtime dependencies — only Node built-ins (`fs`,
`path`, `child_process`). Node 14 or newer.

## Install

The package publishes to GitHub Packages, so the scope needs to be pointed there. In your
project's `.npmrc`:

```
@officespacesoftware:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The token needs `read:packages`. Then:

```sh
npm install -g @officespacesoftware/versioner@next
# or run it without installing
npx @officespacesoftware/versioner@next show
pnpm dlx @officespacesoftware/versioner@next show
```

The current line is a prerelease published under the `next` dist-tag, so install it
explicitly as `@next` or pin an exact version.

> This package was renumbered from `1.0.1` down to the `0.x` line it shares with the
> release-management packages, to stop claiming a stability it had not earned. The API did
> not change. If you pinned `^1.0.1`, move to `@next`.

## CLI

```sh
versioner init [VERSION]   # create VERSION (default 0.1.0-RC.0)
versioner patch            # new patch-level (n.n.X) release
versioner minor            # new minor-level (n.X.n) release
versioner major            # new major-level (X.n.n) release
versioner patch-rc         # new patch-level (n.n.X-RC.0) release candidate
versioner minor-rc         # new minor-level (n.X.n-RC.0) release candidate
versioner major-rc         # new major-level (X.n.n-RC.0) release candidate
versioner increment-rc     # increment the current release candidate (n.n.n-RC.X)
versioner release          # release the current release candidate (n.n.n)
versioner show             # print the current version from the VERSION file
versioner help             # show help
```

`patch-rc`, `minor-rc`, `major-rc`, and `increment-rc` also answer to their underscored
long forms (`patch_release_candidate`, `minor_release_candidate`,
`major_release_candidate`, `increment_release_candidate`). `help` also answers to `--help`
and `-h`; running the CLI with no arguments prints help. Each command prints the resulting
version.

`init` takes its version from the argument, then the `VERSION` environment variable, then
the `0.1.0-RC.0` default:

```sh
versioner init                    # 0.1.0-RC.0
versioner init 1.0.0              # 1.0.0
VERSION=2.0.0-RC.0 versioner init # 2.0.0-RC.0
```

### What each command creates

Every command except `show` rewrites `VERSION` and then runs, in order:

```sh
git add "VERSION"
git commit -m "To version <version>"
git tag "<version>" -a -m "Release version <version>"
```

Tags are annotated, named for the version with no prefix, and carry the message
`Release version <version>`. Nothing is pushed.

### Guard rails

- `patch`, `minor`, `major`, `patch-rc`, `minor-rc`, and `major-rc` refuse to run while a
  release candidate is active; the error names the current version and the two ways
  forward.
- `increment-rc` and `release` refuse to run when the current version is not a release
  candidate.
- `init` refuses when a `VERSION` file already exists, and requires a repository with at
  least one commit.

## Programmatic API

```js
import {
  VersionFile,
  init, patch, minor, major,
  patchReleaseCandidate, minorReleaseCandidate, majorReleaseCandidate,
  incrementReleaseCandidate, release, showVersion,
  options, fileUtils, gitUtils, versionParser,
} from '@officespacesoftware/versioner';
```

### Task functions

Each mirrors one CLI command, returns the new version string, and performs the same
add/commit/tag sequence. `showVersion()` returns the current version and creates nothing.

```js
const version = patch();      // rewrites VERSION, commits, tags; returns "1.2.4"
console.log(showVersion());   // "1.2.4"
```

### `VersionFile`

```js
const vf = new VersionFile();            // uses the configured path, default 'VERSION'
const vf2 = new VersionFile('./VERSION'); // explicit path
VersionFile.create({ version, path });    // create a new VERSION file

vf.version();                    // "1.2.3-RC.4"
vf.shortVersion();               // "1.2.3"
vf.isReleaseCandidate();         // true
vf.currentMajorVersion();        // "1"
vf.currentMinorVersion();        // "2"
vf.currentPatchVersion();        // "3"
vf.releaseCandidateIteration();  // "4"

vf.patch();                      // these rewrite VERSION and return the new version
vf.minor();
vf.major();
vf.patchReleaseCandidate();
vf.minorReleaseCandidate();
vf.majorReleaseCandidate();
vf.incrementReleaseCandidate();
vf.release();
```

The `VersionFile` methods write the file; they do not commit or tag. The task functions
add the git operations on top. Constructing a `VersionFile` for a path that does not exist
throws.

### Utility modules

```js
options.getOptions();
options.setOption('version_file_path', 'custom/VERSION');
options.getVersionFilePath();
options.updateOptions({ version_file_path: 'VERSION' });
options.resetOptions();

fileUtils.fileExists(path);
fileUtils.readVersionFile(path);            // { version, gitHash }
fileUtils.writeVersionFile(path, version, gitHash);
fileUtils.createVersionFile(path, version, gitHash);

gitUtils.isGitRepository();
gitUtils.getShortCommitHash();
gitUtils.gitAdd(file);
gitUtils.gitCommit(message);
gitUtils.gitTag(tag, message);
gitUtils.hasUncommittedChanges();
gitUtils.getCurrentBranch();

versionParser.parseVersion('1.2.3-RC.1');   // { major, minor, patch, isRC, rcNumber }
versionParser.formatVersion(versionObj);
versionParser.incrementMajor(versionObj);
versionParser.incrementMinor(versionObj);
versionParser.incrementPatch(versionObj);
versionParser.makeReleaseCandidate(versionObj, rcNumber);
versionParser.removeReleaseCandidate(versionObj);
versionParser.incrementReleaseCandidate(versionObj);
versionParser.getShortVersion(versionObj);
versionParser.isReleaseCandidate('1.2.3-RC.1');
```

The default export bundles the same surface: `{ VersionFile, tasks, options, fileUtils,
gitUtils, versionParser }`.

## The VERSION file

```
1.2.3-RC.4
36780700aa00
```

1. the semantic version, `X.Y.Z` or `X.Y.Z-RC.N`
2. the short git commit hash captured at write time

Readers trim and take the first line, so the file is interchangeable with the one the Ruby
gem writes. The path defaults to `VERSION` and is configurable through
`options.setOption('version_file_path', …)`.

## Development

From this directory:

```sh
npm test                                # node --test test/*.test.js
npm run dev:test                        # the same, in watch mode
node --test test/version-file.test.js   # one file
```

`npm run build` is a placeholder echo — there is nothing to compile. `npm test` also runs
as `prepublishOnly`. From the workspace root (`js/`), `pnpm test` runs this suite along with
the core package's.

```
packages/versioner/
├── lib/
│   ├── index.js          # public entry point
│   ├── version-file.js   # VersionFile class
│   ├── tasks.js          # task functions + performGitOperations
│   ├── options.js        # configuration
│   ├── file-utils.js     # VERSION file I/O
│   ├── git-utils.js      # git add / commit / tag
│   └── version-parser.js # semantic version arithmetic
├── bin/
│   └── versioner         # CLI
└── test/
    ├── version-file.test.js
    └── cli.test.js
```

## Related documentation

- [../../../docs/architecture.md](../../../docs/architecture.md) — where this package sits
  in the wider system
- [../../../docs/actions.md](../../../docs/actions.md) — the release workflows that call
  into it
- [../release-management-core/README.md](../release-management-core/README.md) — the
  orchestration layer that drives this package

## License

MIT License — see the LICENSE file for details.
