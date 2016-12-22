# Versioner

Version-numbering Rake tasks that creates the appropriate Git objects.


## Installation

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

## Usage

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
rake version:major_release_candidate      # create a new major-level (X.n.n-RC1) release candidate
rake version:minor                        # create a new minor-level (n.X.n) release
rake version:minor_release_candidate      # create a new minor-level (n.X.n-RC1) release candidate
rake version:patch                        # create a new patch-level (n.n.X) release
rake version:release                      # releases the current release candidate (n.n.n)
rake version:show                         # print the current version level from the VERSION file
```


## Configuration

This gem stores the current version and latest commit in a file by default named VERSION, located in the root of your project.

You can change this by adding this to an initializer:
```ruby
require 'versioner/options'
Versioner.options[:version_file_path] = '/some/other/path/VERSION_FILE'
```
