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

  # OpenCV as a VENDORED xcframework (downloaded by this package's npm
  # postinstall script, scripts/download-opencv-ios.js — not checked in, not
  # shipped in the npm tarball). Do NOT go back to `spm_dependency` on
  # yeatse/opencv-spm: an SPM product attaches to the POD target only, so when
  # the consumer uses CocoaPods static frameworks (Expo default via
  # expo-build-properties ios.useFrameworks "static") the pod's archive holds
  # just the shim's objects — a static framework cannot merge another static
  # library — and nothing puts opencv2 on the APP's link line. The app link
  # then fails with every cv:: symbol undefined. `vendored_frameworks` is the
  # fix precisely because CocoaPods propagates `-framework "opencv2"` plus the
  # framework search path into the consuming app's xcconfig.
  # The xcframework ships ios-arm64 device + arm64/x86_64 simulator slices,
  # so no EXCLUDED_ARCHS hack is needed.
  s.vendored_frameworks = 'opencv2.xcframework'

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
