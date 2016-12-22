# frozen_string_literal: true
require 'rake'
require 'versioner/options'
require 'versioner/version_file'
namespace :version do
  def version
    Versioner::VersionFile.new.version
  end

  def file_name
    Versioner.options[:version_file_path]
  end

  def commit
    system("git add #{file_name}")
    system("git commit -m 'To version #{version}'")
  end

  def tag
    system("git tag #{version} -a -m \"Release version #{version}\"")
  end

  desc 'initializes the project with the version file (optional VERSION)'
  task :init do
    options = { version: ENV['VERSION'] }.select { |_, value| !value.nil? }
    Versioner::VersionFile.create(options)
    commit
    tag
  end

  desc 'create a new patch-level (n.n.X) release'
  task :patch do
    Versioner::VersionFile.new.patch
    commit
    tag
  end

  desc 'create a new minor-level (n.X.n) release'
  task :minor do
    Versioner::VersionFile.new.minor
    commit
    tag
  end

  desc 'create a new major-level (X.n.n) release'
  task :major do
    Versioner::VersionFile.new.major
    commit
    tag
  end

  desc 'create a new minor-level (n.X.n-RC1) release candidate'
  task :minor_release_candidate do
    Versioner::VersionFile.new.minor_release_candidate
    commit
    tag
  end

  desc 'create a new major-level (X.n.n-RC1) release candidate'
  task :major_release_candidate do
    Versioner::VersionFile.new.major_release_candidate
    commit
    tag
  end

  desc 'increments the current release candidate (n.n.n-RCX)'
  task :increment_release_candidate do
    Versioner::VersionFile.new.increment_release_candidate
    commit
    tag
  end

  desc 'releases the current release candidate (n.n.n)'
  task :release do
    Versioner::VersionFile.new.release
    commit
    tag
  end

  desc 'print the current version level from the VERSION file'
  task :show do
    puts version
  end
end
