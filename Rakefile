require 'bundler/gem_tasks'
require 'rspec/core/rake_task'

RSpec::Core::RakeTask.new(:spec)

$LOAD_PATH.unshift File.expand_path('..', __FILE__)
task default: :spec
load File.expand_path('../lib/tasks/versioner.rake', __FILE__)
