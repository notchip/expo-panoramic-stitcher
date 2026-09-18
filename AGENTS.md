# AGENTS.md

Instructions for AI agents (and new humans) working in this repository.
Checked in — keep it updated when invariants change. `CLAUDE.md` or any llm's md file is a
gitignored local pointer to this file.

## What this is

`expo-panoramic-stitcher` is a standalone Expo Module (not an app) for
**Expo SDK 56+** (dev/verification matrix: **SDK 57 / RN 0.86.3 / React
19.2.3**) that stitches images into 360°/wide panoramas using **OpenCV
4.13**. Published to npm as `@notchip/expo-panoramic-stitcher` and consumed
by Expo apps. Two JS entry points (see `package.json` `exports`):

- `.` — the stitcher API (`stitchImagePaths`, `stitchBase64`,
  `stitchIncrementalBase64`, `stitchSweep`, events).
- `./capture` — the guided-sweep capture UI (`useGuidedSweep`,
  `<GuidedSweepCapture />`). Separate on purpose; see rules below.

## Commands

```bash
npm run build      # expo-module build  -> compiles src/ -> build/
npm run clean      # expo-module clean
npm run lint       # expo-module lint   (ESLint flat config, eslint.config.js)
npm test           # expo-module test --passWithNoTests (jest; 3 suites, see below)
npm run prepare    # expo-module prepare (runs on install / before publish)
```

Toolchain facts that are easy to break:

- All scripts delegate to `expo-module-scripts` (`^56.x` — **no 57 line
  exists**; 56.0.3 is latest and serves SDK 57 too). Because devDeps sit on
  SDK 57 (RN 0.86) while module-scripts' jest chain assumes SDK 56,
  `package.json` `overrides` pin `jest-expo@~57.0.5` (scoped to
  expo-module-scripts) and `@react-native/jest-preset@0.86.3`, and
  `jest@^29` is a direct devDependency (`jest-expo@57` stopped shipping the
  binary transitively). Don't remove any of those without re-running
  `npm install && npm test`.
- Root `babel.config.js` exists **only for jest** (delegates to
  `expo-module-scripts/babel.config.base`); the published build is plain
  tsc. It is deliberately not in the npm tarball.
- The tsconfig (module-scripts base) enables `verbatimModuleSyntax` — type
  imports must use `import type`. Also strict + `noUncheckedIndexedAccess`.
- The jest preset does NOT transform `react-native` — a runtime `import`
  from `react-native` in a core file breaks every suite that imports
  `src/index.ts` (the capture entry may import it; it is not under jest).
  This is why `buildSweepManifest` takes the platform from `meta` only.
- Jest suites (all native-free): `src/__tests__/stitchSweep.test.ts`
  (orchestration, manifest, sidecar — native module and `expo-file-system`
  mocked), `src/__tests__/geometry.test.ts`, `src/__tests__/exifIntrinsics.test.ts`.
- There is no native build in-tree — iOS/Android compile only inside a host
  app's `expo prebuild` + Xcode/Gradle. To exercise native code, add this
  package as a local module to an Expo app and `npx expo prebuild --clean`.
  For JS-only verification, the proven recipe is: `npm pack`, install the
  tarball into a fresh `create-expo-app` (blank-typescript), `npx tsc
  --noEmit`, `CI=1 npx expo export --platform android`.
- `expo-camera`/`expo-sensors`/`expo-haptics` are devDependencies **only for
  typechecking** the capture entry.
- **Publishing:** CI (`.github/workflows/publish.yml`) publishes on push to
  main whenever the package.json version is absent from a registry — npmjs
  via **OIDC trusted publishing** (no `NPM_TOKEN` secret; the trusted
  publisher is configured on npmjs.com for this repo + `publish.yml`, and
  needs npm ≥ 11.5.1, upgraded in the workflow), GitHub Packages via the
  built-in `GITHUB_TOKEN`. The repo `.npmrc` deliberately has **no npmjs
  authToken line** — a `${NPM_TOKEN}` line shadows `~/.npmrc` for local
  publishes and makes `npm publish` fail with a misleading 404/401. Manual
  local publish works with a plain `npm login` (+ 2FA OTP).

## Architecture

Design goals (see README): **no manual OpenCV vendoring**, a **tiny,
symmetric native surface**, and sweep intelligence kept in **plain TS**.
Keep changes faithful to those.

```
src/index.ts                 public API: DEFAULTS merge, validation, typed wrappers,
  │                          + stitchSweep (pure-TS sweep orchestration, no native calls of its own)
  │                          + buildSweepManifest (pure) ; src/geometry.ts (pure pixel<->angle math)
  │                          ; src/optionalFileSystem.ts (guarded require of expo-file-system, sidecar only)
  └─ requireNativeModule('ExpoPanoramicStitcher')
       ├─ iOS:     ios/ExpoPanoramicStitcherModule.swift   (base64 <-> temp file, own dispatch queue)
       │             └─ ios/PanoramaStitcherShim.{h,mm}    (ObjC++ -> cv::Stitcher, vendored opencv2.xcframework)
       └─ Android: android/.../ExpoPanoramicStitcherModule.kt  (base64 <-> temp file, own thread)
                     └─ android/src/main/cpp/panorama_stitcher_jni.cpp
                        (JNI -> cv::Stitcher, static libs from the official OpenCV Android SDK)

src/capture/                 subpath entry ./capture — camera/sensor UI layer (never imported by core)
```

**Core invariant:** native code always operates on **image file paths**
(`cv::imread` → write JPEG). Base64 is decoded to temp files on the way in
and encoded from the output file on the way out, in Swift/Kotlin. This keeps
the C++ boundary minimal and the two platforms behaving identically.
**`file://` normalization is a JS-side invariant:** `stitchImagePaths` (and
therefore `stitchSweep`, including salvage re-stitches) maps every input
through the exported `normalizeImagePath()` — `file://` / `file://localhost/`
URIs (expo-camera's output) become bare percent-decoded paths, anything else
passes through untouched. Native never sees a URL scheme; do not add scheme
handling to Swift/Kotlin/C++.

**Symmetric payloads:** `stitchBase64`/`stitchIncrementalBase64` return the
identical `StitchBase64Result` shape on both platforms (the legacy module
this ports from returned different payloads per platform — do not
reintroduce that asymmetry). Native failures REJECT the promise (coded
`StitchError`/`StitchException`); a resolved result always has
`success: true` natively. Only the web stub
(`src/ExpoPanoramicStitcherModule.web.ts`) resolves `success: false`.

**OpenCV is C++ on both platforms.** Each platform has exactly ONE C++ shim:
`PanoramaStitcherShim.mm` (ObjC++, so Swift never sees a C++ type) and
`panorama_stitcher_jni.cpp` (JNI — OpenCV ships no Java/Kotlin bindings for
the stitching module; `org.opencv.stitching.*` does not exist). **The two
shims contain the same stitch core and must be edited together** (mode
selection, matcher, matching mask, blender, warper, geometry recompute,
resize, geometry JSON, imwrite). Both shims also carry a
`// BEGIN SHARED STITCH-CORE HELPERS … // END SHARED STITCH-CORE HELPERS`
block (`buildMatchingMask`, `jsonDouble/jsonFloat/jsonInt/jsonBool`,
`GeometryCamera`, `StitchGeometry`, `computeStitchGeometry`,
`buildGeometryJson`) that must stay **byte-identical** — check with:

```bash
diff <(sed -n '/BEGIN SHARED STITCH-CORE HELPERS/,/END SHARED STITCH-CORE HELPERS/p' ios/PanoramaStitcherShim.mm) \
     <(sed -n '/BEGIN SHARED STITCH-CORE HELPERS/,/END SHARED STITCH-CORE HELPERS/p' android/src/main/cpp/panorama_stitcher_jni.cpp)
```

Order inside the stitch core is fixed: status OK → sorted COPY of
`component()` for `usedIndices` (the geometry needs the unsorted order to
pair with `cameras()`) → `computeStitchGeometry` on the UN-resized pano
(`selfCheck` compares against it) → the existing resize →
`buildGeometryJson` (adds the output affine from final vs composite size) →
imwrite → return. Geometry never fails a successful stitch (try/catch → empty
string). Number formatting in the JSON must stay locale-safe (`snprintf`
`%.17g`/`%.9g` + comma→dot, non-finite → `null`; never
`std::to_string(double)`).

The Kotlin↔JNI protocol is a string with FIVE segments:
`"ok|<width>|<height>|<idx,idx,...>|<geometryJson>"` (ascending composited
input indices, then the geometry JSON — always the LAST segment, possibly
empty; Kotlin splits with `limit = 5` and `parts.getOrNull(4) ?: ""`) or
`"err|<message>"`. iOS returns the same data as an NSDictionary
(`PanoStitchGeometryKey` = `"geometryJson"`); both Swift records carry
`@Field geometryJson: String`.

**Threading:** stitching is CPU-bound for seconds-to-minutes. iOS uses
`.runOnQueue(stitchQueue)` (dedicated serial queue), Android a single-thread
executor + explicit `Promise` — never let stitches run on the shared Expo
AsyncFunction queue (it is process-wide on both platforms; blocking it
stalls every other Expo module).

## Guided capture layer (`src/capture/`, subpath export `./capture`)

Pure-JS guided-sweep capture UI (auto-shoot every `stepDeg` of
gyro-integrated yaw), ported from a field-tested app screen. Rules:

- **The core entry (`src/index.ts`) must never import anything from
  `src/capture/`** — the subpath split exists so the plain stitcher pulls in
  none of the capture dependencies. `package.json` has an `exports` map for
  `.` and `./capture`.
- `useGuidedSweep.ts` holds the sensor state machine. **The sensor math and
  defaults were tuned on real devices — do not "improve" them.** In
  particular: the per-platform `rotationRate` axis mapping (iOS
  `alpha=Z, beta=Y, gamma=X`; Android `alpha=X, beta=Y, gamma=Z`) is
  verified against expo-sensors *native sources* and contradicts its docs;
  yaw integrates on the sensor clock (`rotationRate.timestamp`) with dt
  falling back to `interval/1000` on duplicate timestamps and resetting (not
  clamping) on gaps > 0.5 s; the AppState listener aborts a sweep on
  backgrounding (integrated yaw can't survive suspension); a generation
  counter invalidates in-flight captures on reset/redo.
- `SweepStatus` is a machine-readable enum (consumers localize). It
  deliberately collapses the original screen's copy: settle-window "hold
  still" and capture-window "hold" are both `HOLD`; wrong-way and overshoot
  are both `GO_BACK`.
- `expo-camera`/`expo-sensors` are peers of the capture entry;
  `expo-haptics` and `react-native-safe-area-context` are optional extras.
  All four are `optional: true` in `peerDependenciesMeta` (so core-only
  installs stay lean — npm must not auto-install camera/sensors for
  stitcher-only consumers; the README tells capture users to install them)
  and the optional two are loaded via literal `require(...)` inside
  try/catch in `optionalDeps.ts` — Metro's `allowOptionalDependencies`
  (Expo default) depends on exactly that pattern, so never convert those to
  static imports.
- **The capture record is additive-only.** `SweepPhoto` carries, besides
  `uri`/`width`/`height`/`yawDeg`, the trigger tick (`tiltDeg`, `rollDeg`,
  `tiltMagDeg`, `rateDegS`, `gravity`, `sensorTs`), timing (`triggeredAt`,
  `resolvedAt`, `yawDegAtResolve`) and EXIF (`exifOrientation`, `exif`);
  `SweepCaptureMeta` (`meta` on the hook, second arg of `onComplete`) is
  written only at `start()`, once at settle (`gravityRef`) and at sweep end
  — never per tick. Fields are pure COPIES of values `onMotion` already
  computes; never add a field that requires new sensor math or changes a
  gate. Every field name must be mirrored as an OPTIONAL field on the core
  `SweepInputPhoto` / `SweepCaptureMetaInput` (see sweep orchestration).
- `SweepPhoto.width/height` are **upright on both platforms** — the
  Android-only swap in `doCapture` exists because expo-camera skips the
  bitmap rotation when `exif: true` (it writes `Orientation` 6/8 instead);
  iOS must NOT be swapped (`UIImage.size` is already orientation-aware while
  the injected `Orientation` tag still says 6/8). `exif` defaults to `true`;
  a capture rejected with an EXIF-related error (`isExifFailure`, message
  matches /exif/i) while EXIF was requested is retried once without it and
  EXIF is disabled for the rest of that sweep; other failures keep the
  pre-existing retry-next-tick behaviour. `exifIntrinsics.ts` is pure and
  import-free (`normalizeExif`, `deriveFocalPx`, `readExifOrientation`).

## Sweep orchestration (`stitchSweep`, core entry)

`stitchSweep` in `src/index.ts` is plain-TS orchestration over
`stitchImagePaths` — **never** move its behaviors into native code. It takes
`SweepInputPhoto` (`{ uri, yawDeg }`, defined in the core types file) rather
than importing capture's `SweepPhoto` (structurally assignable; core must
not import `src/capture/`). Its behaviors encode field findings — a 24-shot
360° sweep stitched 17/24 `[2–18]` cylindrical while a plane run
independently used `[19–23,0–10]`, contiguous across the wrap: the matcher
connects the loop, but OpenCV's high-level Stitcher keeps one maximal arc
and has no concept of a circular chain. Hence:

- **Wrap closure:** yaw span ≥ 330° → re-append copies of the first two
  photos so the chain sees its own loop, and `matchWrap` defaults to
  `wrapClosed` (`options.matchWrap ?? wrapClosed`, sent on the primary AND
  the salvage stitch; `matchNeighbors` passes through unchanged). Duplicate
  indices are mapped back to their source photos everywhere. **`wrapClosed`
  does NOT mean a duplicated trailing edge:** under OpenCV's rotation model
  (`u = warpScale·atan2`, one turn) the duplicates land ON their sources
  rather than widening the canvas — never document "caller may crop".
  `wrapClosure` (`measureWrapClosure`) MEASURES the loop drift from
  duplicate/source camera pairs (`inputIndex >= n` ↔ `inputIndex − n`) and is
  `null` unless at least one pair was composited with geometry available.
- **Arc salvage:** one re-stitch of the dropped complement (same options,
  order preserved); all strips returned largest-first in `strips`; a failed
  complement is not an error.
- **Gap feedback:** `gaps` = yaw ranges of dropped-and-unsalvaged photos;
  `yawSpanDeg` = `max − min` of `photos[].yawDeg` (the wrap gate value).
- **Tagged geometry:** each strip carries `geometry` (`SweepStripGeometry`:
  cameras tagged `photoIndex` — `toCanonical(inputIndex)` for the primary,
  `dropped[inputIndex]` for the salvage strip; a wrap-closed primary holds
  the same `photoIndex` twice) and `coverage` (`coverageFromGeometry`).
- **Manifest + sidecar:** `buildSweepManifest(photos, stitch, meta?)` is pure
  (no I/O, no `react-native`; `platform` = `meta.platform ?? "unknown"`).
  `stitchSweep` always returns `manifest` and then, unless `sidecar: false`,
  writes it best-effort to `options.sidecar.path ?? <strips[0].path with
  .json>` via `writeTextFile` from `src/optionalFileSystem.ts`. ANY failure
  → `sidecarPath: null` + `sidecarError: message`; it must never reject and
  never touch `success`. `manifest.photos` are the canonical n photos (never
  the wrap-extended input), each `{ index, uri, path: normalizeImagePath(uri),
  ...everything the caller passed }`; `manifest.stitch.options` is exactly
  `{ ...DEFAULTS, ...sweepOptions, warpMode: warpModeUsed }` — what native
  received for the successful primary stitch. `meta` and `sidecar` are
  destructured OUT of the options before they reach native.
- **`src/optionalFileSystem.ts`** loads `expo-file-system` lazily via a
  literal `require("expo-file-system")` inside try/catch (same
  `declare const require` + Metro `allowOptionalDependencies` rationale as
  `src/capture/optionalDeps.ts`) — never a static import, never a computed
  module id. `expo-file-system` is an `optional: true` peer (every Expo app
  has it through `expo`; NOT a devDependency here). `writeTextFile` builds
  `new File(uri).write(text)` where `uri` = the path if it already has a
  scheme else `file://` + percent-encoded path (iOS rejects scheme-less
  paths; `File.write` is synchronous in SDK 56/57 and creates the file but
  not parent dirs).
- **Core mirror types:** `SweepInputPhoto` (optional fields),
  `SweepInputPhotoExif`, `SweepInputVec3`, `SweepCaptureMetaInput` (all
  optional except `id`/`startedAt`) and `SweepCaptureConfigInput` DUPLICATE
  the capture entry's shapes field-for-field so capture output is assignable
  — the core must not import `src/capture/`, not even `import type`. When
  the capture record changes, update both sides.
- Defaults `warpMode: 'cylindrical'` + `panoConfidence: 0.7` +
  `autoResize: false` (a sweep is never stretched to 2:1; callers opt back in
  explicitly); `'plane'` is rejected (an affine projection can't exceed ~120°
  FOV — it stays available via `stitchImagePaths` for diagnostics); a failed
  `spherical` stitch falls back to cylindrical **exactly once**
  (`fellBackToCylindrical`), never auto-retries beyond that.

Covered by `src/__tests__/stitchSweep.test.ts` (jest, native module and
`expo-file-system` mocked). Run `npm test` after touching it.

## Geometry interpretation (`src/geometry.ts`)

Pure TS, no native calls, never imports `src/capture/`. Native reports ONLY
the raw camera model (`K`, `R`, `warpScale`, `origin`, ROIs, output affine);
angles (yaw/pitch/roll, azimuth/elevation), coverage on the circle and the
gyro fit are derived HERE — do not add angle math to the shims. Conventions
(OpenCV's, verified against `warpers_inl.hpp`): `R` camera-to-world, camera
frame x right / y DOWN / z forward, `u = warpScale·atan2(x, z)`, spherical
`v = warpScale·(π − acos(y/|p|))`, cylindrical `v = warpScale·y/hypot(x, z)`;
composite pixel = global − origin; output pixel = `output` affine. `affine`
composites (`warpMode: 'plane'`) → the angle helpers return `null`
(`imagePointToPano` replays `AffineWarper`). Coverage uses `yaw ± hfov/2`
(`hfov = 2·atan(srcWidth/(2·focal))`), never ROI widths (a seam-straddling
ROI spans the whole canvas). `parseGeometry` never throws (validates `v === 1`,
projection, finite numbers, 9-entry `R`; anything else → `null`). Covered by
`src/__tests__/geometry.test.ts`.

Verified OpenCV 4.13 facts the native geometry relies on: `cameras()` are at
registration scale and `composePanorama` scales a private copy by
`1/workScale` (`compose_scale` is 1 because `compositingResol()` defaults to
`ORIG_RESOL`); `cameras()[k]` pairs with the UNSORTED `component()[k]`;
`warped_image_scale_` is private but equals the median focal with `(float)`
casts; `MultiBandBlender` crops to `resultRoi(corners, sizes)` exactly, hence
`selfCheck`. Setting a compositing resolution or swapping the blender would
make `selfCheck` report `false` (geometry approximate), not crash.

## Adding or changing a native method

A method must be kept in sync across **five** places or it will break:

1. `src/ExpoPanoramicStitcher.types.ts` — shared types. Result types come in
   pairs: `Native*` (what native resolves: raw `geometryJson: string`) vs
   the public `StitchResult` / `StitchBase64Result` (`geometry:
   StitchGeometry | null`). Options: `matchNeighbors`, `matchWrap` live in
   `StitchOptions` next to the older fields.
2. `src/ExpoPanoramicStitcherModule.ts` — the `declare class` signature
   (returns the `Native*` types).
3. `src/index.ts` — public wrapper (DEFAULTS merge + validation live here,
   not in native; DEFAULTS include `matchNeighbors: 0`, `matchWrap: false`);
   the wrappers convert via `parseGeometry` (`toStitchResult` /
   `toStitchBase64Result`).
4. `ios/ExpoPanoramicStitcherModule.swift` — `Function`/`AsyncFunction` in
   `definition()`; native `Record` structs mirror the TS types
   (`StitchOptions` fields incl. `matchNeighbors`/`matchWrap`; both result
   records carry `geometryJson`); the shim method signature in
   `PanoramaStitcherShim.h/.mm` is `…panoConfidence:matchNeighbors:matchWrap:
   outputWidth:autoResize:jpegQuality:`.
5. `android/.../ExpoPanoramicStitcherModule.kt` — matching function; options
   arrive as `Map<String, Any?>` parsed via `StitchOptions.from(map)`;
   `external fun nativeStitch` and the JNI `Java_…_nativeStitch` signature
   must match parameter order EXACTLY: `…, panoConfidence, matchNeighbors,
   matchWrap, outputWidth, autoResize, jpegQuality`; result maps carry
   `geometryJson`.

If the change touches the stitch core itself, the **two C++ shims** are a
sixth and seventh place — keep them identical (and the SHARED block
byte-identical). Update the web stub too (it returns the raw native shape:
`geometryJson: ""`, `success: false`).
`expo-module.config.json` registers the module classes; the native module
name string (`"ExpoPanoramicStitcher"`) must match in the Swift `Name(...)`,
Kotlin `Name(...)`, and `requireNativeModule(...)`.

## Native dependency wiring (the part that's easy to get wrong)

- **iOS** (`ios/ExpoPanoramicStitcher.podspec`): OpenCV is a **vendored**
  `opencv2.xcframework` (`s.vendored_frameworks`), downloaded once at npm
  **postinstall** by `scripts/download-opencv-ios.js` (yeatse/opencv-spm
  4.13.0 release zip, SHA-256-pinned, device + arm64/x86_64-simulator
  slices; no tvOS slice, so the podspec is iOS-only; git-ignored and
  excluded from the npm tarball — `files` deliberately lists `ios/*.podspec`
  etc. instead of the `ios` dir, because a `files` directory entry overrides
  `.npmignore`). Do NOT switch back to `spm_dependency`: under CocoaPods
  static frameworks (Expo default `ios.useFrameworks: "static"`) an SPM
  product attaches to the pod target only and every `cv::` symbol comes up
  undefined at the final app link; `vendored_frameworks` is what propagates
  `-framework "opencv2"` + search paths into the app xcconfig. The download
  runs at postinstall, NOT CocoaPods `prepare_command`, because
  `prepare_command` never runs for `:path` development pods (how Expo
  autolinking consumes this package). iOS 16.4+.
  `CLANG_CXX_LANGUAGE_STANDARD = c++17` is required for the `.mm` shim;
  `SWIFT_OBJC_INTEROP_MODE` must stay absent (with it, `import
  ExpoModulesCore` breaks against SDK 57 precompiled binaries — see podspec
  comment). No simulator `EXCLUDED_ARCHS` hack.
- **Android** (`android/build.gradle` + `android/CMakeLists.txt`): the Maven
  `org.opencv:opencv` AAR is **not usable** — its `libopencv_java4.so` does
  not compile the stitching module in. Instead a Gradle task downloads the
  official `opencv-4.13.0-android-sdk.zip` once (SHA-256-verified, with
  corrupt/partial-download recovery) into a Gradle user-home cache shared
  across projects and surviving `clean`, and CMake statically links
  `libopencv_stitching.a` + its dependency closure (calib3d, features2d,
  flann, imgcodecs, imgproc, core, plus bundled 3rdparty archives) into the
  single JNI shim. Built with `-DANDROID_STL=c++_shared` (RN apps already
  package `libc++_shared.so`); `libpanostitcher.so` is linked with
  `-Wl,-z,max-page-size=16384` for 16 KB page-size devices.
  `System.loadLibrary("panostitcher")` is the only load — `OpenCVLoader` is
  not used. A missing ABI in the SDK is a hard CMake error, never silently
  dropped. minSdk 24, compile/target SDK 36.
- In `PanoramaStitcherShim.mm`, OpenCV headers redefine `YES`/`NO`; they are
  `#undef`'d before the OpenCV import and restored after. Preserve that
  dance if editing the shim.
- `package.json` `files` must keep `android/CMakeLists.txt` and
  `android/src` (which includes `src/main/cpp/`) or published packages
  cannot build.

## Behavioral notes

- `warpMode: 'plane'` maps to `Stitcher.SCANS` (affine matcher);
  `'cylindrical'` sets `cv::CylindricalWarper` in PANORAMA mode; everything
  else is PANORAMA with the default spherical warper.
- `matchConf` is the feature-match confidence, not the pano confidence
  threshold — that is `panoConfidence` (default 1.0,
  `setPanoConfidenceThresh`, set before `stitch()`); at 1.0 OpenCV's
  `leaveBiggestComponent` can silently drop weakly-matched images, and every
  result reports `usedIndices`/`usedCount` (from
  `cv::Stitcher::component()`, sorted ascending) so callers can detect
  partial panoramas. `blendStrength` 1–10 is the `MultiBandBlender` band
  count (clamped). Stitch failures map `Stitcher::Status` to distinct
  messages (NEED_MORE_IMGS / HOMOGRAPHY_EST_FAIL /
  CAMERA_PARAMS_ADJUST_FAIL), identical text on both platforms.
- `matchNeighbors > 0` builds an n×n CV_8U mask (symmetric, zero diagonal;
  pairs `0 < |i−j| ≤ k`, plus `|i−j| ≥ n−k` when `matchWrap`) and calls
  `setMatchingMask` before `stitch()`; `0` = no mask (OpenCV default).
  Identical-image pairs (a photo vs its wrap duplicate) are harmless: OpenCV
  zeroes confidence > 3 for near-identical images.
- `computeStitchGeometry` re-runs `warper->warpRoi` per composited image.
  That is cheap: OpenCV's `CylindricalWarper`/`SphericalWarper` implement
  `detectResultRoi` by walking the image BORDER (`detectResultRoiByBorder`,
  ~2·(w+h) `mapForward` calls per image; spherical adds two pole checks),
  not the full image. Do not hand-roll the ROI from four corners or from
  `roi.width` assumptions — use the warper so `selfCheck` stays exact.
- OpenCV stitching needs ~30–40% overlap between adjacent images or it
  returns a non-OK status, surfaced as a rejected promise.
- `autoResize` forces an equirectangular 2:1 output
  (`height = outputWidth / 2`).
- `stitchIncrementalBase64(null/'', firstImage)` is a **pass-through**: it
  validates + measures the image and returns it unchanged as the seed
  panorama (no native stitch, no progress events).
- `onStitchProgress` emits coarse stages: `decoding` 0.1 → `stitching` 0.3 →
  `encoding` 0.85 → `done` 1.0 (`stitchImagePaths`: only `stitching` +
  `done`). Keep stage names identical across platforms.
- All temp files are written under a `pano-stitch/` temp dir and cleaned up
  in `defer`/`finally` blocks — including when a later input fails to decode.
  Keep that cleanup when adding code paths. The OUTPUT panorama (and the
  sweep sidecar next to it) also live there and are purgeable by the OS —
  the README tells consumers to copy photos + pano + sidecar to a document
  directory; the module never does that itself.
- Known, documented asymmetries module code cannot fully fix: (1) iOS wraps
  thrown errors in `FunctionCallException` and does not attach `error.code`
  on async rejections, while Android rejects the raw coded exception — the
  inner message text is identical, so consumers match by substring;
  (2) base64 decoding is strict on Android (`Base64.DEFAULT`), lenient on
  iOS (`.ignoreUnknownCharacters`); (3) the incremental first-frame
  pass-through validates with the platform image decoder, which accepts more
  formats (e.g. HEIC) than `cv::imread` can later stitch.
