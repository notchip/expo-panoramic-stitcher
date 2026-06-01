require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoPanoramicStitcher'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # OpenCV via Swift Package Manager — prebuilt XCFramework that tracks upstream
  # OpenCV releases (4.13.0+). Ships device + arm64-simulator slices, so NO manual
  # framework download and NO simulator EXCLUDED_ARCHS hack is needed.
  # Requires CocoaPods >= 1.16 (spm_dependency) and platform >= 15.1.
  s.spm_dependency(
    url: 'https://github.com/yeatse/opencv-spm.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '4.13.0' },
    products: ['OpenCV']
  )

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    # The .mm shim needs C++ interop; Swift talks to the shim through a plain ObjC header.
    'SWIFT_OBJC_INTEROP_MODE' => 'objcxx'
  }

  s.source_files = '*.{h,m,mm,swift}'
end
