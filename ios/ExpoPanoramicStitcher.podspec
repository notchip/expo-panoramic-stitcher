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
  # iOS only: yeatse/opencv-spm ships no tvOS slice in its XCFramework.
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # OpenCV via Swift Package Manager — prebuilt XCFramework that tracks upstream
  # OpenCV releases (4.13.0+). Ships device + arm64-simulator slices, so NO manual
  # framework download and NO simulator EXCLUDED_ARCHS hack is needed.
  # `spm_dependency` is a global helper from React Native's pod scripts
  # (react_native_pods.rb, RN >= 0.75) — every Expo SDK 56 host Podfile loads it.
  # It is NOT a CocoaPods API and must be called as a function with the spec as
  # the first argument, not as a method on the spec.
  spm_dependency(s,
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
