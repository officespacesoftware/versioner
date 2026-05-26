# frozen_string_literal: true

module Versioner
  def self.options
    @options ||= {
      version_file_path: 'VERSION'
    }
  end
end
