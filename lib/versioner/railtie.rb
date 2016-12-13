# frozen_string_literal: true
module Versioner
  require 'rails'

  class Railtie < Rails::Railtie
    rake_tasks { load File.expand_path('../../tasks/versioner.rake', __FILE__) }
  end
end
