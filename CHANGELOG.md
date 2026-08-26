# Changelog

Notable changes to `@notchip/expo-panoramic-stitcher`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.4.0] — 2026-08-26

### Fixed

- **iOS:** the app-level link failed with every `cv::` symbol undefined when
  the consumer used CocoaPods **static frameworks** (the Expo default via
  `expo-build-properties` `ios.useFrameworks: "static"`). Root cause: the
  podspec's `spm_dependency` attached the OpenCV Swift-package product to the
  pod target only — a static framework cannot merge another static library,
  so nothing put `opencv2` on the app's link line (CocoaPods even warned:
  *"Pod ExpoPanoramicStitcher is using swift package(s) OpenCV with static
  linking, this might cause linker errors"*).

### Changed

- **iOS packaging:** OpenCV is now a **vendored `opencv2.xcframework`**
  (`s.vendored_frameworks`) instead of an SPM dependency, so CocoaPods
  propagates `-framework "opencv2"` + the framework search path into the
  consuming app's xcconfig under both static and dynamic linkage. The
  framework (yeatse/opencv-spm 4.13.0 build, ~191 MB zip, SHA-256-verified,
  `ios-arm64` device + `arm64/x86_64` simulator slices) is downloaded once by
  a dependency-free **npm `postinstall`** script into the package's `ios/`
  dir — not by a CocoaPods `prepare_command`, which never runs for the
  `:path` pods Expo autolinking generates. The script skips non-macOS
  platforms, is rerunnable manually
  (`node scripts/download-opencv-ios.js`), and honors
  `EXPO_PANORAMIC_STITCHER_OPENCV_ZIP` for offline installs. The xcframework
  is neither committed nor shipped in the npm tarball.
- Android is unchanged from 0.3.0.

## [0.3.0] — 2026-08-26

### Fixed

- **iOS:** removed `SWIFT_OBJC_INTEROP_MODE = objcxx` from the Swift target's
  `pod_target_xcconfig`. With the flag on, `import ExpoModulesCore` in a
  precompiled-modules Expo SDK 57 app activates ExpoModulesCore's
  `#ifdef __cplusplus` includes, which cannot resolve
  `ReactCommon/CallInvoker.h` against the prebuilt `React.xcframework` header
  layout — the consumer build fails while compiling
  `ExpoPanoramicStitcherModule.swift`. Swift never touches a C++ type, so the
  flag was never needed; the ObjC++ shim (`PanoramaStitcherShim.mm`) is
  unaffected (it compiles as ObjC++ by file extension). The podspec comment
  now documents why the flag must never come back.
- **Android:** the Maven `org.opencv:opencv` AAR ships **no stitching
  symbols** (`cv::Stitcher` and `cv::detail::*` are absent from its
  `libopencv_java4.so`), so the JNI shim could never actually link. The module
  now statically links `libopencv_stitching.a` and its dependency closure
  (calib3d, features2d, flann, imgcodecs, imgproc, core, plus the SDK's
  bundled 3rdparty archives) from the official **OpenCV 4.13.0 Android SDK**.
  A Gradle task downloads the SDK zip once (~303 MB, SHA-256-verified, with
  corrupt/partial-download recovery) into the Gradle user-home cache and
  reuses it across builds and projects. `libpanostitcher.so` is linked with
  `-Wl,-z,max-page-size=16384` for 16 KB page-size devices (Play
  targetSdk 35+).

### Changed

- Publishes to the **public npm registry**: `publishConfig` now points at
  `https://registry.npmjs.org/` with `access: public`, and the `@notchip`
  scope is no longer pinned to GitHub Packages in `.npmrc` (CI routes the
  GitHub Packages publish with explicit `--@notchip:registry` flags instead).
- Package description now says Expo **SDK 56+** — SDK 57 consumers are
  verified.

### Note

- With Expo SDK 57 precompiled binaries, EAS iOS builds need an Xcode whose
  Swift matches the precompiled binaries — e.g. the
  `macos-tahoe-26.4-xcode-26.4` EAS image as of Aug 2026.

## [0.2.0] — 2026-06-11

- Fixed Android stitching wiring, iOS `pod install`, and the JS API contract
  after an audit (symmetric `StitchBase64Result` on both platforms; coded
  rejections).
- Added CI auto-publish to npmjs and GitHub Packages on version bump.

## [0.1.0] — 2026-06-01

- Initial release: Expo Module (SDK 56 / RN 0.85) stitching 360°/wide
  panoramas via OpenCV 4.13 — Swift + ObjC++ shim on iOS (OpenCV via SPM),
  Kotlin + JNI shim on Android; `stitchBase64`, `stitchImagePaths`,
  `stitchIncrementalBase64`, progress events, web stub.
