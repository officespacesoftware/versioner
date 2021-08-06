# frozen_string_literal: true

require 'versioner'

describe Versioner::VersionFile do
  subject(:version_file) do
    described_class.new(file_path)
  end

  let(:file_path) { 'spec/fixtures/txt/version_file.txt' }

  before do
    File.write(file_path, "0.9.12\n42324b")
  end

  it 'gets the current version from the file' do
    # versions should be in format: i.e. '0.9.12'
    expect(version_file.version).to match(/^\d+\.\d+.\d+/)
  end

  context 'when incrementing the patch version' do
    before do
      version_file.patch
    end

    it 'increments patch version' do
      expect(version_file.current_patch_version).to eq '13'
    end

    it 'keeps the minor version the same' do
      expect(version_file.current_minor_version).to eq '9'
    end

    it 'keeps the major version the same' do
      expect(version_file.current_major_version).to eq '0'
    end

    it 'isn\'t a release candidate' do
      expect(version_file).not_to be_release_candidate
    end
  end

  context 'when incrementing the minor version' do
    before do
      version_file.minor
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'increments the minor version' do
      expect(version_file.current_minor_version).to eq '10'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '0'
    end

    it 'isn\'t a release candidate' do
      expect(version_file).not_to be_release_candidate
    end
  end

  context 'when incrementing the major version' do
    before do
      version_file.major
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'resets the minor version' do
      expect(version_file.current_minor_version).to eq '0'
    end

    it 'increments major version' do
      expect(version_file.current_major_version).to eq '1'
    end

    it 'isn\'t a release candidate' do
      expect(version_file).not_to be_release_candidate
    end
  end

  context 'when creating a minor version release candidate' do
    before do
      version_file.minor_release_candidate
    end

    it 'marks the version as a release candidate' do
      expect(version_file).to be_release_candidate
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'increments the minor version' do
      expect(version_file.current_minor_version).to eq '10'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '0'
    end

    it 'is at RC iteration 0' do
      expect(version_file.release_candidate_iteration).to eq '0'
    end

    it 'has RC and the RC version number at the end of the name' do
      expect(version_file.version).to eq '0.10.0-RC.0'
    end
  end

  context 'when creating a major version release candidate' do
    before do
      version_file.major_release_candidate
    end

    it 'marks the version as a release candidate' do
      expect(version_file).to be_release_candidate
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'increments the minor version' do
      expect(version_file.current_minor_version).to eq '0'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '1'
    end

    it 'is at RC iteration 0' do
      expect(version_file.release_candidate_iteration).to eq '0'
    end

    it 'has RC and the RC version number at the end of the name' do
      expect(version_file.version).to eq '1.0.0-RC.0'
    end
  end

  context 'when incrementing a minor version release candidate' do
    before do
      version_file.minor_release_candidate
      version_file.increment_release_candidate
    end

    it 'marks the version as a release candidate' do
      expect(version_file).to be_release_candidate
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'increments the minor version' do
      expect(version_file.current_minor_version).to eq '10'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '0'
    end

    it 'is at RC iteration 1' do
      expect(version_file.release_candidate_iteration).to eq '1'
    end

    it 'has RC and the RC version number at the end of the name' do
      expect(version_file.version).to eq '0.10.0-RC.1'
    end
  end

  context 'when incrementing a major version release candidate' do
    before do
      version_file.major_release_candidate
      version_file.increment_release_candidate
    end

    it 'marks the version as a release candidate' do
      expect(version_file).to be_release_candidate
    end

    it 'resets the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'increments the minor version' do
      expect(version_file.current_minor_version).to eq '0'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '1'
    end

    it 'is at RC iteration 1' do
      expect(version_file.release_candidate_iteration).to eq '1'
    end

    it 'has RC and the RC version number at the end of the name' do
      expect(version_file.version).to eq '1.0.0-RC.1'
    end
  end

  context 'when releasing a minor release candidate' do
    before do
      version_file.minor_release_candidate
      version_file.release
    end

    it 'removes the release candidate' do
      expect(version_file).not_to be_release_candidate
    end

    it 'does not change the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'does not change the minor version' do
      expect(version_file.current_minor_version).to eq '10'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '0'
    end

    it 'goes back to looking like a normal release' do
      expect(version_file.version).to eq '0.10.0'
    end
  end

  context 'with a major release candidate' do
    before do
      version_file.major_release_candidate
      version_file.release
    end

    it 'removes the release candidate' do
      expect(version_file).not_to be_release_candidate
    end

    it 'does not change the patch version' do
      expect(version_file.current_patch_version).to eq '0'
    end

    it 'does not change the minor version' do
      expect(version_file.current_minor_version).to eq '0'
    end

    it 'does not change the major version' do
      expect(version_file.current_major_version).to eq '1'
    end

    it 'goes back to looking like a normal release' do
      expect(version_file.version).to eq '1.0.0'
    end
  end

  context 'with error conditions' do
    it 'isn\'t able to increment the release candidate unless the current version is some kind '\
       'of release candidate' do
      expect { version_file.increment_release_candidate }.to raise_error(RuntimeError)
    end

    it 'isn\'t able to declare a minor release candidate unless the current version is not a release candidate' do
      version_file.minor_release_candidate

      expect { version_file.minor_release_candidate }.to raise_error(RuntimeError)
    end

    it 'isn\'t able to declare a major release candidate unless the current version is not a release candidate' do
      version_file.minor_release_candidate

      expect { version_file.major_release_candidate }.to raise_error(RuntimeError)
    end

    it 'isn\'t able to increment the patch version on a release candidate' do
      version_file.minor_release_candidate

      expect { version_file.patch }.to raise_error(RuntimeError)
    end

    it 'isn\'t able to increment the minor version on a release candidate' do
      version_file.minor_release_candidate

      expect { version_file.minor }.to raise_error(RuntimeError)
    end

    it 'isn\'t able to increment the major version on a release candidate' do
      version_file.minor_release_candidate

      expect { version_file.major }.to raise_error(RuntimeError)
    end

    it 'cannot release a non release candidate' do
      expect { version_file.release }.to raise_error(RuntimeError)
    end
  end

  context 'when initializing with new VERSION file' do
    it 'does not create a file if one exists' do
      expect { described_class.create }.to raise_error(RuntimeError)
    end

    it 'creates a version file' do
      allow(Versioner).to receive(:options).and_return(version_file_path: file_path)
      File.delete(file_path)
      described_class.create(version: '1.0.0')
      expect(version_file.version).to eq '1.0.0'
    end
  end
end
