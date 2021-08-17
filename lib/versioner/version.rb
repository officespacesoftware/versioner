# frozen_string_literal: true

require 'versioner/version_file'
module Versioner
  VERSION = VersionFile.new(File.expand_path('../../VERSION', __dir__), file_open_options: 'r').version.freeze
end
