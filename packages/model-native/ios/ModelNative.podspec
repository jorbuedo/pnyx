require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ModelNative'
  s.version        = package['version'] || '0.1.0'
  s.summary        = 'On-device language model (Apple Foundation Models) for the Pnyx explain rail.'
  s.description    = 'Expo module exposing the on-device system language model: availability plus one-shot text generation. No tool calling.'
  s.license        = 'Apache-2.0'
  s.author         = 'Pnyx'
  s.homepage       = 'https://pnyx.pxkq.uk'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://pnyx.pxkq.uk/pnyx.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.{h,m,mm,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
