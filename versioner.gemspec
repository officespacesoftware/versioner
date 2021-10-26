# frozen_string_literal: true

lib = File.expand_path('lib', __dir__)
$LOAD_PATH.unshift(lib) unless $LOAD_PATH.include?(lib)
require 'versioner/version'

Gem::Specification.new do |spec|
  spec.name          = 'versioner'
  spec.version       = Versioner::VERSION
  spec.authors       = ['Esteban Trejos']
  spec.email         = ['joseestetq@hotmail.com']
  spec.license       = 'MIT'

  spec.summary       = 'Adds rake tasks to manage project versioning using git.'
  spec.description   = ''
  spec.homepage      = 'https://github.com/officespacesoftware/versioner'

  # Prevent pushing this gem to RubyGems.org. To allow pushes either set the
  # 'allowed_push_host' to allow pushing to a single host or delete this section
  # to allow pushing to any host.
  if spec.respond_to?(:metadata)
    spec.metadata['allowed_push_host'] = 'https://github.com'
  else
    raise 'RubyGems 2.0 or newer is required to protect against ' \
      'public gem pushes.'
  end

  spec.files = `git ls-files -z`.split("\x0").reject do |f|
    f.match(%r{^(test|spec|features)/})
  end
  spec.bindir        = 'exe'
  spec.executables   = spec.files.grep(%r{^exe/}) { |f| File.basename(f) }
  spec.require_paths = ['lib']

  spec.required_ruby_version = '>= 2.7', '< 4'

  spec.add_runtime_dependency 'packaging_rake_tasks', '~> 1.1'
  spec.add_runtime_dependency 'rake', '~> 13.0'

  spec.add_development_dependency 'bundler', '~> 2.0'
  spec.add_development_dependency 'rspec', '~> 3.0'
  spec.add_development_dependency 'rubocop', '~> 0.62'
  spec.add_development_dependency 'rubocop-rspec', '~> 1.31'
end
