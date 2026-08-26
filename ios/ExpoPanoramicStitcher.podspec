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
    # c++17 + libc++ are for PanoramaStitcherShim.mm, which compiles as ObjC++
    # by file extension. Keep both.
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++'
    # NEVER reintroduce 'SWIFT_OBJC_INTEROP_MODE' => 'objcxx' here. The Swift
    # file never touches a C++ type — it talks to PanoramaStitcherShim through
    # a plain ObjC header, and the .mm shim compiles as ObjC++ by file
    # extension regardless of this flag. With objcxx interop ON,
    # `import ExpoModulesCore` in a precompiled-modules Expo SDK 57 app
    # activates the `#ifdef __cplusplus` includes inside ExpoModulesCore's
    # headers (BridgelessJSCallInvoker.h -> #include <ReactCommon/CallInvoker.h>),
    # which cannot resolve against the prebuilt React.xcframework header layout
    # (the header is nested at Headers/React_callinvoker/ReactCommon/CallInvoker.h).
    # The consumer build then fails while compiling
    # ExpoPanoramicStitcherModule.swift with:
    #   'ReactCommon/CallInvoker.h' file not found
    #   ... could not build Objective-C module 'ExpoModulesCore'
    # This module is typically the ONLY source-built pod importing
    # ExpoModulesCore in an SDK 57 app, so only it trips this.
  }

  s.source_files = '*.{h,m,mm,swift}'
end
