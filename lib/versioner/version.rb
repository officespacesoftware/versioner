# frozen_string_literal: true
require 'versioner/version_file'
module Versioner
  VERSION = VersionFile.new(File.expand_path('../../../VERSION', __FILE__)).version.freeze
end
