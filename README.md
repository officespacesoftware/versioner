# Versioner

Version-numbering tasks that create the appropriate Git objects, plus a Git Flow release
management stack built on top of them.

The repository holds two implementations of the same versioning contract — a Ruby gem and
a set of JavaScript packages — and, on the JavaScript side, an orchestration layer with a
CLI and an MCP server.

| Documentation | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, dependency direction, layers, `VERSION` contract, GitHub token resolution |
| [docs/actions.md](docs/actions.md) | Every action, its ordered steps, and the exact git objects it creates |
| [js/README.md](js/README.md) | The JavaScript workspace: packages, registry, workspace commands, publishing |
| [js/packages/versioner/README.md](js/packages/versioner/README.md) | The `@officespacesoftware/versioner` CLI and library |
| [js/packages/release-management-core/README.md](js/packages/release-management-core/README.md) | The `release-management-core` library API |
| [js/packages/release-management-cli/README.md](js/packages/release-management-cli/README.md) | The `release-management` CLI, its flags, exit codes, and GitHub Actions use |
| [js/packages/release-management-mcp/README.md](js/packages/release-management-mcp/README.md) | The MCP server, its thirteen tools, and setup for Claude Code, Codex and Cursor |

## Layout

```
VERSION                                  version + short commit hash (two lines)
versioner.gemspec                        gem spec; sources live in ruby/
ruby/                                    Ruby gem: version:* rake tasks
js/                                      pnpm workspace
  packages/versioner                     @officespacesoftware/versioner
  packages/release-management-core       @officespacesoftware/release-management-core
  packages/release-management-cli        @officespacesoftware/release-management-cli
  packages/release-management-mcp        @officespacesoftware/release-management-mcp
docs/                                    architecture.md, actions.md
```

## The VERSION file

Two lines, shared by every implementation:

```
1.2.3-RC.4
36780700aa00
```

1. the semantic version, `X.Y.Z` or `X.Y.Z-RC.N`
2. the short git commit hash captured when the line was written

Every reader trims, so the two implementations' differing trailing newline is immaterial.
Details are in [docs/architecture.md](docs/architecture.md#the-version-file-contract).

## Ruby gem

The gem provides Rake tasks for version management in Ruby and Rails projects. The gemspec
lives at the repository root; the sources live under `ruby/`.

### Installation

Add to your application's Gemfile:

```ruby
gem 'versioner', git: 'git@github.com:officespacesoftware/versioner.git'
```

Then `bundle`. To build and install from a clone:

```sh
git clone git@github.com:officespacesoftware/versioner.git
cd versioner
gem build versioner.gemspec
gem install versioner-1.2.0.gem
```

### Usage

Rails projects load the tasks automatically through the railtie. On non-Rails projects, add
to your Rakefile:

```ruby
require 'versioner/rake'
```

Then:

```sh
rake version:init                         # initializes the project with the version file (optional VERSION=0.1.0-RC.0)
rake version:patch                        # create a new patch-level (n.n.X) release
rake version:minor                        # create a new minor-level (n.X.n) release
rake version:major                        # create a new major-level (X.n.n) release
rake version:patch_release_candidate      # create a new patch-level (n.n.X-RC.0) release candidate
rake version:minor_release_candidate      # create a new minor-level (n.X.n-RC.0) release candidate
rake version:major_release_candidate      # create a new major-level (X.n.n-RC.0) release candidate
rake version:increment_release_candidate  # increments the current release candidate (n.n.n-RCX)
rake version:release                      # releases the current release candidate (n.n.n)
rake version:show                         # print the current version level from the VERSION file
```

Each task except `show` rewrites `VERSION`, runs `git add VERSION`,
`git commit -m 'To version <version>'`, and
`git tag <version> -a -m "Release version <version>"`.

### Configuration

The `VERSION` file location is configurable:

```ruby
require 'versioner/options'
Versioner.options[:version_file_path] = '/some/other/path/VERSION_FILE'
```

### Development

```sh
cd ruby
bundle install
bundle exec rspec        # or: bundle exec rake, the default task
bundle exec rubocop
```

`.tool-versions` pins Ruby `4.0.5`.

## JavaScript packages

Four packages, published to GitHub Packages under the `@officespacesoftware` scope.

| Package | Purpose |
| --- | --- |
| [`@officespacesoftware/versioner`](js/packages/versioner/README.md) | `versioner` CLI and library: reads and writes `VERSION`, creates commits and annotated tags |
| [`@officespacesoftware/release-management-core`](js/packages/release-management-core/README.md) | Shared Git Flow primitives and workflow orchestration; consumed by the two front-ends |
| [`@officespacesoftware/release-management-cli`](js/packages/release-management-cli/README.md) | `release-management` CLI for shells and GitHub Actions |
| [`@officespacesoftware/release-management-mcp`](js/packages/release-management-mcp/README.md) | `release-management-mcp` MCP stdio server for AI assistants |

Each package's README covers its own install and use — including, for the MCP server, setup
for Claude Code, Codex and Cursor from either the registry or a local build. See
[js/README.md](js/README.md) for the workspace itself and [docs/actions.md](docs/actions.md)
for what each action does.

## Registry

`.npmrc` points the scope at GitHub Packages:

```
@officespacesoftware:registry=https://npm.pkg.github.com
```

Installing the packages requires a token with `read:packages` for the
`officespacesoftware` organization.

The current line of all four packages is a prerelease published under the `next` dist-tag,
so install them explicitly as `@next` — `latest` is not set on this line.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `master`: the JS
workspace typechecks and tests on Node 20 with pnpm 10, and the Ruby gem runs RSpec and
RuboCop on Ruby 4.0.5.

`.github/workflows/publish-js.yml` publishes one JS package when a tag of the form
`@officespacesoftware/<package>@<version>` is pushed. It refuses when the tag version and
the package's `package.json` version disagree. For a stable version it also refuses a
commit that is not reachable from `origin/master`; prerelease versions — anything carrying
a `-` suffix, such as `0.5.0-RC.0` — are exempt from that check and publish from any branch
under the `next` dist-tag, so `latest` keeps pointing at the last stable release.

## License

MIT License — see the LICENSE file for details.
