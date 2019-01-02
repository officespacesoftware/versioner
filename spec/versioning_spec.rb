require 'spec_helper'
require 'rake'
require 'versioner'

describe Versioner do
  before do
    Rake::Task.clear
    load(File.expand_path('../lib/versioner/rake.rb', __dir__))
  end

  let(:versioner_tasks) do
    %w[version:increment_release_candidate
       version:init
       version:major
       version:major_release_candidate
       version:minor
       version:minor_release_candidate
       version:patch
       version:release
       version:show]
  end

  after { Rake::Task.clear }

  it 'allows manual requiring of the tasks' do
    expect(Rake::Task.tasks.map(&:name)).to eq versioner_tasks
  end

  it 'gets the default options' do
    expect(described_class.options).to eq(version_file_path: 'VERSION')
  end
end
