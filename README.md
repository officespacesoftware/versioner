# Versioner

Version-numbering tasks that create the appropriate Git objects, available in both Ruby and Node.js implementations.


## Installation

### Ruby Version (Gem)

Add this line to your application's Gemfile:

```ruby
gem 'versioner', git: 'git@github.com:officespacesoftware/versioner.git'
```

And then execute:

    $ bundle

Or install it yourself as:

    $ git clone git@github.com:officespacesoftware/versioner.git
    $ cd versioner
    $ gem build versioner.gemspec
    $ gem install versioner-VERSION.gem

### Node.js Version

For production use with Node.js:

    $ git clone git@github.com:officespacesoftware/versioner.git
    $ cd versioner/node
    $ npm install -g .

For development with Bun (recommended):

    $ git clone git@github.com:officespacesoftware/versioner.git
    $ cd versioner/node
    $ bun install

## Usage

### Ruby Version

The tasks are automatically loaded on Rails projects.
On non-rails projects you can add this to your Rakefile:
```ruby
require versioner/rake
```

Then you can run:

```sh
rake version:init                         # initializes the project with the version file (optional VERSION=0.1.0-RC1)
rake version:increment_release_candidate  # increments the current release candidate (n.n.n-RCX)
rake version:major                        # create a new major-level (X.n.n) release
rake version:major_release_candidate      # create a new major-level (X.n.n-RC.0) release candidate
rake version:minor                        # create a new minor-level (n.X.n) release
rake version:minor_release_candidate      # create a new minor-level (n.X.n-RC.0) release candidate
rake version:patch                        # create a new patch-level (n.n.X) release
rake version:patch_release_candidate      # create a new patch-level (n.n.X-RC.0) release candidate
rake version:release                      # releases the current release candidate (n.n.n)
rake version:show                         # print the current version level from the VERSION file
```

### Node.js Version

After installing the Node.js version, you can use the `versioner` command:

```sh
versioner init [VERSION]                 # initializes the project with the version file
versioner increment-rc                   # increments the current release candidate (n.n.n-RCX)
versioner major                          # create a new major-level (X.n.n) release
versioner major-rc                       # create a new major-level (X.n.n-RC.0) release candidate
versioner minor                          # create a new minor-level (n.X.n) release
versioner minor-rc                       # create a new minor-level (n.X.n-RC.0) release candidate
versioner patch                          # create a new patch-level (n.n.X) release
versioner patch-rc                       # create a new patch-level (n.n.X-RC.0) release candidate
versioner release                        # releases the current release candidate (n.n.n)
versioner show                           # print the current version level from the VERSION file
```


## Configuration

Both versions store the current version and latest commit in a file by default named VERSION, located in the root of your project.

### Ruby Version Configuration

You can change this by adding this to an initializer:
```ruby
require 'versioner/options'
Versioner.options[:version_file_path] = '/some/other/path/VERSION_FILE'
```

### Node.js Version Configuration

The Node.js version uses the same VERSION file format and location as the Ruby version, ensuring compatibility between implementations.

**Development Notes:**
- Uses Bun for development and testing (faster execution)
- Library code uses only Node.js built-ins (no Bun-specific APIs)
- Can be used in production with Node.js or Bun
- Tests run with `bun test` in development

## VERSION File Format

Both implementations use the same file format:
- Line 1: Version string (e.g., "1.2.3" or "1.2.3-RC.1")
- Line 2: Git commit hash (short format)

This ensures full compatibility - you can switch between Ruby and Node.js versions without any migration.
