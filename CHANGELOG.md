# Changelog

Notable changes to `@notchip/expo-panoramic-stitcher`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.7.0] — 2026-09-17

### Added

- **Stitch geometry on every result** — `geometry: StitchGeometry | null` on
  `StitchResult` / `StitchBase64Result`: per composited image its intrinsics
  `K` (`focal`, `ppx`, `ppy`, `aspect`) and camera-to-world rotation `R` at
  the input's pixel scale, `warpScale` (pixels per radian), the canvas
  `origin`, the un-resized composite size, `selfCheck`, and the
  composite→output affine (`output: { sx, sy, tx, ty }`), recovered natively
  by replaying `cv::Stitcher::composePanorama` — the same C++ on both
  platforms. Geometry never fails a successful stitch (`null` when it could
  not be recovered; always `null` for the incremental first-frame
  pass-through). The raw native module still resolves it as a compact
  `geometryJson: string` (`NativeStitchResult` / `NativeStitchBase64Result`).
- **`src/geometry.ts`** (pure TS, re-exported from the core entry):
  `parseGeometry`, `cameraAngles`, `panoPixelToAngles`, `anglesToPanoPixel`,
  `imagePointToPano`, `cameraAzimuthIntervalDeg`, `coverageFromGeometry`,
  `fitGyroToPano`, `wrapDeg` — pixel↔angle conversion, azimuth coverage on
  the circle and a gyro-to-pano fit (`panoAzimuth ≈ sign·gyroYaw + offset`).
  Types: `StitchGeometry`, `StitchCamera`, `StitchProjection`, `Mat3`,
  `PixelRect`, `CameraAngles`, `PanoAngles`, `PanoPoint`, `AzimuthInterval`,
  `SweepCoverage`, `GyroPanoFit`, `GyroPanoResidual`.
- **`StitchOptions.matchNeighbors`** (default `0`) and **`matchWrap`**
  (default `false`): neighbour-only feature matching via
  `setMatchingMask` (`0 < |i−j| ≤ k`, plus `|i−j| ≥ n−k` when `matchWrap`);
  `stitchSweep` defaults `matchWrap` to its `wrapClosed` flag.
- **`stitchSweep` additions:** `strips[].geometry` (`SweepStripGeometry` —
  cameras tagged with the canonical `photoIndex`), `strips[].coverage`,
  top-level `geometry` (= `strips[0].geometry`), `wrapClosure`
  (`{ closureErrorDeg, pairs }` — the measured loop-closure error from the
  re-appended duplicates, or `null`), `yawSpanDeg` (gyro yaw span of the
  sweep), and the **sweep manifest**: `manifest: SweepManifest` (always, in
  memory — `schemaVersion: 1`, `generator`, `createdAt`, `platform`,
  `sweep` = the capture `meta`, `photos[]` with `index` + normalized `path`
  + every field the caller passed, `stitch` with strips/geometry/coverage/
  gaps/wrap info and the exact resolved `options` sent to native) plus a
  **best-effort JSON sidecar** written as `<pano>.json` next to the primary
  strip with `expo-file-system` (`sidecarPath` / `sidecarError`; `sidecar:
  false` skips it, `sidecar: { path }` relocates it; a failed write never
  rejects). New options `StitchSweepOptions.meta` and `sidecar`; exported
  `buildSweepManifest()`, `toFileUri()`; types `SweepManifest`,
  `SweepManifestPhoto`, `SweepManifestStitch`, `SweepCaptureMetaInput`,
  `SweepCaptureConfigInput`, `SweepInputPhotoExif`, `SweepInputVec3`,
  `SweepInputEndReason`, `SweepStripCamera`, `SweepStripGeometry`,
  `SweepWrapClosure`, `SweepWrapClosurePair`.
- **`SweepInputPhoto`** (core) gained optional fields mirroring the capture
  record one-to-one (`width`, `height`, `tiltDeg`, `rollDeg`, `tiltMagDeg`,
  `rateDegS`, `gravity`, `sensorTs`, `triggeredAt`, `resolvedAt`,
  `yawDegAtResolve`, `exifOrientation`, `exif`) so a captured sweep passes
  straight through into the manifest. The core entry still imports nothing
  from `/capture` — the shapes are duplicated on purpose.
- **`expo-file-system`** is a new **optional** peer dependency (`>=56.0.0`,
  guarded `require`; every Expo app already ships it via `expo`). Used only
  for the manifest sidecar.
- **capture:** `SweepPhoto` now records the trigger tick — `tiltDeg`,
  `rollDeg`, `tiltMagDeg`, `rateDegS`, `gravity`, `sensorTs`, `triggeredAt`,
  `resolvedAt`, `yawDegAtResolve` (shutter-latency bracket),
  `exifOrientation`, `exif`.
- **capture:** `SweepCaptureMeta` — per-sweep `id`, `platform`, start/finish
  times, `endedBy` (`finish` | `maxShots` | `background`), config snapshot,
  `gravityRef` (settle-window g0), locked `direction`, `relatched`, camera
  settings. Exposed as `meta` on `useGuidedSweep()` and as the second
  argument of `GuidedSweepCapture`'s `onComplete(photos, meta)`.
- **capture:** `exif` option (default `true`; `"full"` keeps the raw
  dictionary minus maker blobs) requests EXIF per capture; new pure helpers
  `normalizeExif()`, `deriveFocalPx()`, `readExifOrientation()`, constant
  `FULL_FRAME_DIAGONAL_MM` and type `SweepPhotoExif`, giving a per-frame
  pixel focal-length prior (`exif.focalPx`, diagonal 35 mm equivalence on
  the full 4:3 frame, ≈ ±5 %).
- Tests: `src/__tests__/geometry.test.ts`, `src/__tests__/exifIntrinsics.test.ts`,
  and manifest/sidecar/geometry cases in `src/__tests__/stitchSweep.test.ts`
  (63 tests total, native module and `expo-file-system` mocked).

### Changed

- **`stitchSweep` no longer stretches a sweep to 2:1:** it now defaults
  `autoResize: false` (the strip keeps its natural aspect and is only
  downscaled to `outputWidth`); pass `autoResize: true` to opt back in.
  `stitchImagePaths` / `stitchBase64` keep `autoResize: true`.
- **`wrapClosed` semantics corrected:** it means the first two photos were
  re-appended so the matcher sees the chain's own loop (and `matchWrap`
  defaults to `true`). It does **not** mean the trailing edge duplicates the
  start — under OpenCV's rotation model the duplicates land on their sources,
  so do not crop; use `wrapClosure` / `strips[0].coverage` instead.
- **capture (Android): EXIF orientation behaviour.** With `exif: true`
  (now the default) expo-camera on Android does not rotate the bitmap upright
  and reports raw sensor dims with `Orientation` 6/8 on the file; the hook now
  swaps `width`/`height` when `exifOrientation` is 5–8 so
  `SweepPhoto.width/height` are guaranteed **upright on both platforms** (iOS
  already reports orientation-aware dims and is left alone). `cv::imread`
  honours the tag, so stitching is unaffected.
- **capture:** a capture rejected with an EXIF-related error while EXIF was
  requested (iOS `Failed to process EXIF data`) is retried once without EXIF
  and EXIF is disabled for the rest of that sweep; other capture failures
  behave as before (target retried on the next tick).
- **Native protocol** (requires `npx expo prebuild --clean`): the Android
  Kotlin↔JNI string is now `ok|<w>|<h>|<idx,...>|<geometryJson>` (geometry is
  the LAST segment, possibly empty; Kotlin splits with `limit = 5`); the iOS
  shim dictionary gains `geometryJson`; both native `StitchOptions` gain
  `matchNeighbors` / `matchWrap`. Old native + new JS (or vice versa) degrade
  to `geometry: null`, never a crash.
- **Typing:** `geometry` is a required field on `StitchResult` /
  `StitchBase64Result`, and `manifest` / `sidecarPath` / `sidecarError` on
  `StitchSweepResult`; `SweepPhoto` (capture) gained required fields. Code
  that constructs these literals by hand (mocks, fixtures) must add them;
  readers are unaffected.
- Sensor math, gates and every pre-existing `GUIDED_SWEEP_DEFAULTS` value are
  unchanged; `exif: true` is the only new default key.

### Fixed

- **`file://` URIs are accepted as input.** `stitchImagePaths` / `stitchSweep`
  now normalize `file://` (and `file://localhost/`) URIs — what expo-camera's
  `takePictureAsync` returns on both platforms — to bare, percent-decoded
  paths before the native call (`normalizeImagePath()` is exported).
  Previously `cv::imread` received the URL string and the stitch failed with
  `Failed to read image: file:///…`. Salvage re-stitches are normalized too.
- Stale Kotlin KDoc claiming OpenCV comes from the Maven AAR corrected (it is
  statically linked from the official SDK, as documented since 0.3.0).

## [0.6.0] — 2026-09-01

### Added

- **Guided-sweep capture layer** under a new subpath export
  `@notchip/expo-panoramic-stitcher/capture` — an iOS-panorama-style capture
  flow (auto-shoot every N degrees of yaw while the user rotates in place),
  ported from a field-tested implementation. Two layers:
  - `useGuidedSweep(options)`: headless hook — full `idle → sweeping → done`
    state machine, DeviceMotion sensor fusion (gyro yaw integrated on the
    sensor clock and projected onto gravity, with the platform-specific
    `rotationRate` axis mapping verified against expo-sensors native sources),
    settle-window leveling baseline, direction auto-detect with single
    re-latch, overshoot/wrong-way guidance, EMA rate gate, tilt gate,
    AppState-background abort, and a generation counter that drops in-flight
    captures on reset. HUD status is a machine-readable `SweepStatus` enum
    (`START_TURNING`, `KEEP_TURNING`, `SLOW_DOWN`, `HOLD`, `LEVEL_THE_PHONE`,
    `GO_BACK`) — consumers localize.
  - `<GuidedSweepCapture />`: batteries-included fullscreen screen —
    CameraView + the hook + a default HUD (tick rail, level bar, status text,
    thumbnail strip, start/finish/redo controls), plain RN `StyleSheet` only.
    Props: `onComplete(photos)`, `onCancel`, overrides for every threshold
    (`stepDeg` 15, `tolDeg` 2.5, `overshootDeg` 9, `maxRateDegS` 14,
    `tiltWarnDeg` 5, `tiltBlockDeg` 10, `maxShots` 24, …), a `strings` map
    for localization, `accentColor`, and `renderHUD(state)` to replace the
    overlay entirely. Photos are `{ uri, width, height, yawDeg }`.
- **`stitchSweep(photos, options)`** in the core entry — sweep-aware
  orchestration over `stitchImagePaths`, plain TS, **no native changes**.
  Informed by full-circle field results (a 24-shot 360° sweep stitched 17/24
  `[2–18]` cylindrical while a plane run independently used `[19–23,0–10]`,
  contiguous across the wrap — the matcher connects the loop, but the
  high-level Stitcher keeps one maximal arc and has no concept of a circular
  chain). Behaviors: **wrap closure** (yaw span ≥ ~330° → the first two
  photos are re-appended so the chain sees its loop; `wrapClosed: true` =
  trailing edge duplicates the start, caller may crop), **arc salvage** (a
  dropped complement is re-stitched once; all strips returned in `strips`,
  largest first; a failed complement is not an error), **gap feedback**
  (`gaps` = yaw ranges of dropped-and-unsalvaged photos, for "re-sweep near
  280°" UX). Defaults `warpMode: 'cylindrical'` + `panoConfidence: 0.7`;
  `warpMode: 'plane'` is rejected (can't exceed ~120° FOV — still available
  via `stitchImagePaths` for diagnostics); a failed `spherical` stitch falls
  back to cylindrical exactly once (`fellBackToCylindrical`). New types:
  `SweepInputPhoto`, `StitchSweepOptions`, `StitchSweepResult`, `SweepStrip`,
  `SweepGap`, `SweepWarpMode`.
- **First in-tree tests** (`src/__tests__/stitchSweep.test.ts`): the
  wrap-closure index mapping, salvage mapping, gap computation, plane
  rejection, and the single spherical fallback run under jest against a
  mocked native module (plus a root `babel.config.js` delegating to
  `expo-module-scripts/babel.config.base`, used only by jest).
- **New peer dependencies (capture entry only):** `expo-camera` and
  `expo-sensors` (>= 56), plus optional `expo-haptics` (feature-detected —
  missing haptics is a silent no-op) and optional
  `react-native-safe-area-context` (HUD edge padding fallback). All four are
  marked optional in `peerDependenciesMeta` so plain-stitcher installs stay
  lean; the core `@notchip/expo-panoramic-stitcher` entry imports none of
  them.
- **`exports` map in package.json** for `.` and `./capture` (with `types`
  conditions); `main`/`types` kept for older resolvers.

### Changed

- **Dev/verification matrix moved to Expo SDK 57** (stable line as of
  2026-09-01): `expo@~57.0.18`, React Native 0.86.3, React 19.2.3,
  `expo-camera@~57.0.4`, `expo-sensors@~57.0.2`, `expo-haptics@~57.0.2` as
  devDependencies. Consumer support is unchanged — peers stay `>=56.0.0`
  (SDK 56 and 57 apps both work). Notes for maintainers (all dev-only):
  `expo-module-scripts` has no 57 line yet (56.0.3 is latest), so
  `overrides` pin its `jest-expo` to `~57.0.5` and
  `@react-native/jest-preset` to `0.86.3` to keep the tree consistent with
  RN 0.86; `jest@^29` is now a direct devDependency because `jest-expo@57`
  no longer ships the `jest` binary transitively.
- Core stitcher API and native packaging are untouched (vendored iOS
  xcframework postinstall, Android Gradle SDK download, JNI protocol).

## [0.5.0] — 2026-08-30

### Added

- **`panoConfidence` option** (default `1.0`, both platforms): exposes OpenCV's
  `setPanoConfidenceThresh`. At the previous hard-wired default of 1.0,
  `leaveBiggestComponent()` can silently drop weakly-matched images (observed
  in the field: 6 of 9 room photos discarded on low-texture walls) — lower
  values (0.5–0.7) keep more images at the risk of worse alignment. Applied
  before `estimateTransform` on iOS and Android.
- **`usedIndices: number[]` + `usedCount: number` on every result**
  (`StitchResult` and `StitchBase64Result`): the ascending input indices
  OpenCV actually composited (`cv::Stitcher::component()`), so callers can
  tell a full panorama from a 3-of-9 partial. The incremental first-frame
  pass-through reports `[0]` / `1`; the web stub `[]` / `0`. The Kotlin↔JNI
  protocol grew a fourth segment: `ok|<w>|<h>|<idx,idx,...>`.

### Changed

- **Readable stitch errors:** `Stitcher::Status` codes now map to distinct
  messages, identical text on both platforms — `ERR_NEED_MORE_IMGS`
  (too few matched images; raise overlap or lower `panoConfidence`),
  `ERR_HOMOGRAPHY_EST_FAIL` (typical when `warpMode: 'plane'` runs on a
  rotational capture — affine assumes a flat scene, use
  spherical/cylindrical), `ERR_CAMERA_PARAMS_ADJUST_FAIL` (bundle adjustment
  failed; overlap/feature starvation) — replacing the generic
  "OpenCV stitch failed (status N)".
- No packaging changes: 0.4.0's vendored iOS xcframework and the Android
  Gradle SDK download are untouched.

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
