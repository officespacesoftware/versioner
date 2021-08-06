# frozen_string_literal: true

require 'versioner/options'

module Versioner
  def self.version_file
    Versioner.options[:version_file_path]
  end

  class VersionFile
    def initialize(file_name = Versioner.version_file, file_creation_options: nil)
      create_file(file_creation_options) unless file_creation_options.nil? || file_creation_options.empty?
      raise "Version file '#{file_name}' does not exist." unless File.file?(file_name)

      @version_file ||= File.open(file_name, 'r+')
    end

    def self.create(version: '0.1.0-RC.0', path: Versioner.version_file)
      VersionFile.new(Versioner.version_file, file_creation_options: { version: version, path: path })
    end

    def version
      @version_file.rewind
      @version_file.readline.chomp
    end

    def short_version
      return version unless release_candidate?

      version.split('-')[0]
    end

    def patch
      raise 'Cannot patch a release candidate, it needs to be released first.' if release_candidate?

      version = version_as_array
      version[2] = version[2].to_i + 1

      write(version.join('.'))
    end

    def minor
      raise 'Cannot minor increment a release candidate, it needs to be released first.' if release_candidate?

      version = version_as_array
      new_version = [version[0], version[1].to_i + 1, '0']

      write(new_version.join('.'))
    end

    def major
      raise 'Cannot major increment a release candidate, it needs to be released first.' if release_candidate?

      new_version = [version_as_array[0].to_i + 1, '0', '0']

      write(new_version.join('.'))
    end

    def minor_release_candidate
      if release_candidate?
        raise 'Cannot make a release candidate out of a release candidate. To increment to the '\
              'next release candidate, invoke "increment_release_candidate".'
      end
      minor
      write("#{short_version}-RC.0")
    end

    def major_release_candidate
      if release_candidate?
        raise 'Cannot make a release candidate out of a release candidate. To increment to the '\
              'next release candidate, invoke "increment_release_candidate".'
      end
      major
      write("#{version}-RC.0")
    end

    def increment_release_candidate
      raise 'Cannot increment the release candidate version on a non release candidate.' unless release_candidate?

      write("#{short_version}-RC.#{next_release_candidate}")
    end

    def release
      raise 'Cannot release a non release candidate.' unless release_candidate?

      write(short_version)
    end

    def current_patch_version
      if version.include?('RC.')
        version_as_array[2].split('-')[0]
      else
        version_as_array[2]
      end
    end

    def current_minor_version
      version_as_array[1]
    end

    def current_major_version
      version_as_array[0]
    end

    def release_candidate_iteration
      version.split('RC.')[1].to_s
    end

    def release_candidate?
      version.include?('RC.')
    end

    private

    def create_file(version: '0.1.0-RC.0', path: Versioner.version_file)
      raise "Cannot initialize the project with a version file: The file #{path} already exists." if File.exist? path
      raise 'The usage of this gem requires an existing git project with at least one revision.' if revision.empty?

      @version_file = File.new(path, 'w')
      write(version)
    end

    def write(version)
      @version_file.rewind
      @version_file.puts(version)
      @version_file.print(revision)
      @version_file.rewind
      version
    end

    def version_as_array
      version.split('.')
    end

    def next_release_candidate
      return 0 unless release_candidate?

      release_candidate_iteration.to_i + 1
    end

    def revision
      `git rev-parse --short HEAD`.chomp
    end
  end
end
