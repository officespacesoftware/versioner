require 'bundler/gem_tasks'
require 'rspec/core/rake_task'

RSpec::Core::RakeTask.new(:spec)

$LOAD_PATH.unshift File.expand_path(__dir__)
task default: :spec
load File.expand_path('lib/tasks/versioner.rake', __dir__)
