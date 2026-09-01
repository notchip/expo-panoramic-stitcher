# @notchip/expo-panoramic-stitcher

360° / wide panorama image stitching for **Expo SDK 56+** (RN 0.85+), written in
**Swift + Kotlin** with the Expo Modules API, powered by **OpenCV 4.13**.

> **No manual OpenCV download.** Android auto-downloads the official OpenCV
> Android SDK on first build (Gradle does it, once, into a shared cache) and
> statically links the stitching modules; iOS auto-downloads a prebuilt
> `opencv2.xcframework` once at `npm install` (postinstall script) and vendors
> it into the pod. No hand-wired `OpenCV-android-sdk/`, no simulator arch
> hacks.

## How this avoids the old OpenCV pain

| | Old way (manual) | This module |
|---|---|---|
| Android OpenCV | download `OpenCV-android-sdk`, wire `jniLibs.srcDirs`, hand-roll CMake + JNI | Gradle downloads the official `opencv-4.13.0-android-sdk.zip` once (~303 MB, SHA-256-verified) into the Gradle user-home cache and statically links `libopencv_stitching.a` + friends into the one ~150-line JNI shim. (The Maven `org.opencv:opencv` AAR is not usable: its `libopencv_java4.so` does not compile in the stitching module at all.) |
| iOS OpenCV | download `opencv2.framework`, vendor it by hand, fight Apple-Silicon simulator arches (`withOpenCVSimulatorFix.js`) | `npm install` fetches the `yeatse/opencv-spm` prebuilt `opencv2.xcframework` (~191 MB zip, SHA-256-verified, device + arm64-sim slices) once into the package's `ios/` dir; the podspec vendors it (`vendored_frameworks`). No manual step, no arch hack — and it links under **static frameworks**, which the previous SPM approach did not (an SPM product attaches to the pod target only and never reaches the app's link line when the pod is a static framework). |
| iOS bridge | Swift → ObjC++ `Bridge.mm` → C++ `.mm` (two layers) | Swift → one thin `PanoramaStitcherShim.mm` (~140 lines, file-IO via OpenCV, no UIKit) |
| Result payload | iOS returned base64, Android returned RGBA bytes (asymmetric) | identical `StitchBase64Result` on both platforms |

OpenCV is a C++ library, so each platform keeps exactly **one** small C++ shim:
`PanoramaStitcherShim.mm` on iOS, `panorama_stitcher_jni.cpp` on Android. The two
contain the same stitch core and must be edited together. (OpenCV ships no
Java/Kotlin bindings for the stitching module — upstream wraps it for Python
only — and the Maven AAR's `libopencv_java4.so` does not even compile the
stitching module in, which is why Android links the official SDK's static
libraries through the JNI shim.)

## Install (into an Expo app)

```bash
npx expo install @notchip/expo-panoramic-stitcher   # or: add as a local module
npx expo prebuild --clean
```

Requirements: Expo SDK 56+ (React Native 0.85+; developed and verified
against SDK 57 / RN 0.86), iOS 16.4+, Xcode 26.4+,
Android minSdk 24. **`npm install` (postinstall, macOS only)** downloads the
prebuilt `opencv2.xcframework` once (~191 MB zip, SHA-256-verified) into this
package's `ios/` directory, where the podspec vendors it — rerun manually with
`node node_modules/@notchip/expo-panoramic-stitcher/scripts/download-opencv-ios.js`
if the install was interrupted (offline installs: point
`EXPO_PANORAMIC_STITCHER_OPENCV_ZIP` at a pre-downloaded zip). The **first
Android build**
downloads the official OpenCV 4.13.0 Android SDK zip once (~303 MB,
SHA-256-verified) into the Gradle user-home cache
(`~/.gradle/caches/opencv-android-sdk/4.13.0`); every later build — and every
other project on the machine — reuses it, and `clean` does not evict it.

> Why not SPM? Versions ≤ 0.3.x pulled OpenCV via `spm_dependency` — that
> compiles, but with CocoaPods **static frameworks** (the Expo default via
> `expo-build-properties` `ios.useFrameworks: "static"`, mandatory for
> Firebase-using apps) the SPM product never reaches the app's link line and
> every `cv::` symbol comes up undefined at the final app link. A vendored
> framework is propagated by CocoaPods into the app's xcconfig
> (`-framework "opencv2"` + search paths), which is exactly what static
> linkage needs.

## Usage

```ts
import {
  stitchBase64,
  stitchImagePaths,
  stitchIncrementalBase64,
  isStitchingAvailable,
} from '@notchip/expo-panoramic-stitcher';

// 1) File paths in, JPEG file out (lowest memory)
const res = await stitchImagePaths(photoPaths, { warpMode: 'spherical', outputWidth: 4096 });
// res.path is a bare filesystem path — prefix it for <Image>:
// <Image source={{ uri: `file://${res.path}` }} />

// 2) Base64 in, base64 out (same payload on iOS + Android)
const b = await stitchBase64([imgA64, imgB64], { jpegQuality: 90 });
// <Image source={{ uri: `data:image/jpeg;base64,${b.base64Image}` }} />

// 3) Incremental — build a panorama one frame at a time.
// The first call (null) is a pass-through: it returns frame1 itself as the seed.
let pano = await stitchIncrementalBase64(null, frame1);
pano = await stitchIncrementalBase64(pano.base64Image, frame2);
```

Native failures (unreadable input, not enough overlap, encode errors) **reject
the promise** — use `try/catch`. A resolved result always has `success: true`
on iOS/Android; only the web stub resolves with `success: false`.

**Partial panoramas:** a successful stitch is not necessarily a *complete* one.
OpenCV composites only the largest connected component of matched images, so a
9-photo set can resolve as a 3-photo panorama with no error. Every result
carries `usedIndices` (ascending indices into your input array) and `usedCount`
— treat `usedCount < inputs.length` as a partial and either re-shoot the gaps
or retry with a lower `panoConfidence`. Stitch failures reject with distinct
per-status messages: `ERR_NEED_MORE_IMGS` (too few matched images),
`ERR_HOMOGRAPHY_EST_FAIL` (typical when `warpMode: 'plane'` is used on a
rotational capture — plane/affine assumes a flat scene), and
`ERR_CAMERA_PARAMS_ADJUST_FAIL` (bundle adjustment collapsed; usually overlap
or feature starvation). The message text is identical on both platforms.

### Options (`StitchOptions`)

| field | default | notes |
|---|---|---|
| `warpMode` | `spherical` | `spherical` (360°), `cylindrical` (wide horizontal), `plane` (flat scans, affine) |
| `blendStrength` | 5 | 1–10, number of multiband blending bands (clamped) |
| `matchConf` | 0.3 | feature-match confidence 0–1, lower = more lenient |
| `panoConfidence` | 1.0 | pano confidence threshold — OpenCV keeps only the largest connected component of images clearing this bar, so at 1.0 weakly-matched shots (low-texture walls) can be **silently dropped**. Lower (0.5–0.7) keeps more images at the risk of worse alignment; check `usedIndices` on the result |
| `outputWidth` | 4096 | height auto = width/2 when `autoResize` |
| `autoResize` | true | force equirectangular 2:1 |
| `jpegQuality` | 95 | 1–100 |

### Progress events

`onStitchProgress` fires coarse stages: `decoding` (0.1) → `stitching` (0.3) →
`encoding` (0.85) → `done` (1.0). `stitchImagePaths` emits only `stitching` and
`done`; the incremental first-frame pass-through emits nothing.

## Guided capture (`/capture`)

The stitcher is only as good as its input. The optional
`@notchip/expo-panoramic-stitcher/capture` entry ships an iOS-panorama-style
**guided sweep**: the user stands in one spot and rotates in place while the
screen auto-captures a photo every 15° of yaw (gyro-integrated, gravity-aligned),
gated on hold-still speed and tilt — which is what reliably produces the
~30–40% overlap OpenCV needs. The state machine was tuned on real devices.

It is a separate subpath export so the core stitcher stays dependency-lean:
importing only `@notchip/expo-panoramic-stitcher` pulls in none of the
capture dependencies.

### Install (capture peers)

```bash
npx expo install expo-camera expo-sensors   # required by /capture
npx expo install expo-haptics               # optional: shutter feedback
```

`expo-camera` and `expo-sensors` are peer dependencies of the `/capture` entry
only (marked optional in `peerDependenciesMeta` so plain-stitcher installs stay
lean — install them yourself when you use `/capture`). `expo-haptics` is fully
optional: it is feature-detected with a guarded require, and when absent the
capture UI simply skips the per-shot haptic. `react-native-safe-area-context`
is likewise optional — used for HUD edge padding when present (it is in
virtually every Expo app), with a fixed-padding fallback otherwise. Remember
`expo-camera` needs the camera permission set up via its config plugin (and
iOS DeviceMotion needs `NSMotionUsageDescription`).

### Quick start — full-screen component

```tsx
import { stitchSweep } from '@notchip/expo-panoramic-stitcher';
import { GuidedSweepCapture, type SweepPhoto } from '@notchip/expo-panoramic-stitcher/capture';

function CaptureScreen({ onDone }: { onDone: (panoPath: string) => void }) {
  return (
    <GuidedSweepCapture
      onComplete={async (photos: SweepPhoto[]) => {
        // stitchSweep uses the photos' yawDeg for wrap closure + gap feedback
        const res = await stitchSweep(photos);
        onDone(res.path);
      }}
      onCancel={() => {/* navigate back */}}
      // every threshold is overridable:
      // stepDeg={15} tolDeg={2.5} overshootDeg={9} maxRateDegS={14}
      // tiltWarnDeg={5} tiltBlockDeg={10} maxShots={24}
      accentColor="#0A84FF"
      strings={{ statuses: { HOLD: 'Halten…' } }} // localize any copy
      // renderHUD={(sweep) => <MyOverlay {...sweep} />} // replace the overlay entirely
    />
  );
}
```

`SweepPhoto` is `{ uri, width, height, yawDeg }` — `yawDeg` is the integrated
yaw at the moment each shutter fired, useful for diagnosing gaps in a partial
panorama (`usedIndices`).

### Headless hook — bring your own UI

`useGuidedSweep(options)` is the full state machine with no UI: phases
(`idle → sweeping → done`), sensor fusion, capture gating. You render the
camera and HUD yourself and bind the returned ref + ready callback:

```tsx
import { CameraView } from 'expo-camera';
import { useGuidedSweep, SweepStatus } from '@notchip/expo-panoramic-stitcher/capture';

function MyCapture() {
  const { phase, shots, hud, start, finish, reset, cameraRef, onCameraReady, isCameraReady } =
    useGuidedSweep({ stepDeg: 15 });

  return (
    <>
      <CameraView ref={cameraRef} onCameraReady={onCameraReady} facing="back" animateShutter={false} />
      {/* hud = { yawDeg, toTargetDeg, tiltDeg, rollDeg, status } at ~15 Hz.
          hud.status is a SweepStatus enum (START_TURNING, KEEP_TURNING,
          SLOW_DOWN, HOLD, LEVEL_THE_PHONE, GO_BACK) — map it to your own
          localized strings; the hook never produces display copy. */}
    </>
  );
}
```

The sweep auto-finishes at `maxShots` and **aborts to `done` when the app
backgrounds** — integrated gyro yaw cannot survive an app suspension, so the
shots taken so far are kept rather than resuming blind.

> **⚠️ expo-sensors axis mapping.** The hook projects `rotationRate` onto
> gravity to get yaw. The `rotationRate` axis mapping in expo-sensors is
> **platform-specific and contradicts the documentation** (verified against
> the native sources, `DeviceMotionModule.swift` / `DeviceMotionModule.kt`):
> iOS delivers `alpha=Z, beta=Y, gamma=X`; Android delivers
> `alpha=X, beta=Y, gamma=Z`. The hook handles this internally — but if you
> build your own sensor math on expo-sensors, do not trust the docs' axis
> labels. Getting it wrong projects pitch wobble instead of yaw and the sweep
> never advances.

**Known limitation:** `expo-camera` cannot lock AE/AWB, so exposure may drift
across a sweep (e.g. panning past a window). OpenCV's gain compensation absorbs
moderate drift; extreme lighting swings can still leave visible seams.

## Sweep-aware stitching (`stitchSweep`)

`stitchSweep(photos, options?)` lives in the **core** entry (plain TS over
`stitchImagePaths` — no native changes) and understands what a sweep *is*,
which the raw OpenCV Stitcher does not. The field result that motivates it:
a 24-shot 360° sweep stitched as 17/24 (`[2–18]`) in cylindrical, while a
diagnostic plane run independently used `[19–23, 0–10]` — contiguous **across
the wrap**, proving shot 23 matches shot 0. The pairwise matcher connects
everything; the high-level Stitcher simply picks one maximal arc and discards
the rest, because it has no concept of a circular chain. `stitchSweep` adds
that concept:

1. **Wrap closure** — when the sweep's total yaw span (from `photos[].yawDeg`)
   is ≥ ~330°, copies of the first two photos are appended after the last so
   the chain can see its own loop. `wrapClosed: true` on the result means the
   panorama's **trailing edge duplicates its start** — crop if you care.
2. **Arc salvage** — if the primary stitch used only a subset
   (`usedCount < photos.length`), the dropped complement is re-stitched once
   (same options, order preserved) and **all** successful strips are returned:
   `strips: [{ path, width, height, usedIndices }]`, largest first (the
   top-level `path`/`width`/`height`/`usedIndices` mirror `strips[0]`). One
   failed complement is not an error — you get what succeeded.
3. **Gap feedback** — `gaps: [{ fromDeg, toDeg }]` are the yaw ranges covered
   by dropped-and-unsalvaged photos, so a caller can show "re-sweep near
   280°". Empty when every photo landed in some strip.

```ts
import { stitchSweep } from '@notchip/expo-panoramic-stitcher';

const res = await stitchSweep(photos); // photos: { uri, yawDeg }[]
// res.path        largest panorama strip (res.wrapClosed → trailing edge = start)
// res.strips      every stitched strip, largest first
// res.gaps        e.g. [{ fromDeg: 270, toDeg: 300 }] → "re-sweep near 280°"
```

Defaults (deliberately different from `stitchImagePaths`):
`warpMode: 'cylindrical'` and `panoConfidence: 0.7`. Two hard rules:

- **`warpMode: 'plane'` is rejected** with a clear error — an affine/plane
  projection cannot cover a rotational sweep beyond ~120° of FOV. It remains
  available via `stitchImagePaths` for diagnostics.
- **Spherical caveat:** long single chains can diverge in spherical bundle
  adjustment (observed in the field). If you pass `warpMode: 'spherical'` and
  the stitch fails, `stitchSweep` falls back to cylindrical **exactly once**
  (`fellBackToCylindrical: true` on the result) and never auto-retries beyond
  that.

## Architecture

```
JS / TS  (index.ts — defaults, validation, typed API)
   │  requireNativeModule('ExpoPanoramicStitcher')
   ├── iOS:   ExpoPanoramicStitcherModule.swift   (base64 ↔ temp file, own dispatch queue)
   │            └─ PanoramaStitcherShim.mm  → cv::Stitcher  (vendored opencv2.xcframework)
   └── Android: ExpoPanoramicStitcherModule.kt    (base64 ↔ temp file, own thread)
                └─ panorama_stitcher_jni.cpp → cv::Stitcher  (OpenCV Android SDK, static libs)
```

Both platforms share one contract: the C++ shims work on **image file paths**
(`cv::imread` → `cv::imwrite`); base64 is encoded/decoded in Swift/Kotlin. This
keeps the native surface tiny and the two platforms symmetric. Stitching runs on
a dedicated queue/thread per platform so it never blocks other Expo modules'
async functions.

## Known caveats

- OpenCV stitching needs ~30–40% overlap between adjacent images, or it returns a
  non-OK status (surfaced as a rejected promise with the status code).
- **Inputs must be formats OpenCV's `imread` can decode** (JPEG/PNG). HEIC/AVIF are
  not supported — convert iOS camera captures to JPEG first. (The incremental
  first-frame pass-through validates with the platform decoder, which is more
  permissive; an HEIC seed would only fail on the *second* call.)
- Match rejection errors by **substring, not equality**: iOS wraps messages as
  `"Calling the 'stitchBase64' function has failed → Caused by: <message>"`, and
  `error.code` is not populated on iOS async rejections (expo-modules-core
  behavior). The `<message>` part is identical across platforms.
- Base64 strictness differs slightly outside the contract: Android rejects
  URL-safe/polluted base64 (`Invalid base64 at index N`), iOS skips unknown
  characters and fails later. Send standard base64 (data-URL prefix is fine).
- CocoaPods **static frameworks are supported** (`use_frameworks! :linkage =>
  :static` / expo-build-properties `ios.useFrameworks: "static"`) — that
  configuration is the reason OpenCV is vendored rather than pulled via SPM.
- iOS only (no tvOS): the prebuilt OpenCV XCFramework has no tvOS slice.
- **EAS iOS builds with Expo SDK 57 precompiled binaries** need an Xcode whose
  Swift matches those binaries — e.g. the `macos-tahoe-26.4-xcode-26.4` EAS
  image as of Aug 2026.
- The Swift target does **not** enable C++ interop (`SWIFT_OBJC_INTEROP_MODE`
  is deliberately absent from the podspec — with it, `import ExpoModulesCore`
  fails against SDK 57 precompiled binaries). Swift talks to the shim through a
  plain ObjC header; `PanoramaStitcherShim.mm` still compiles as ObjC++ by file
  extension.
- Android statically links OpenCV, so `libpanostitcher.so` is several MB per
  ABI larger than an AAR-based setup would be — the price of a working
  stitching module. The `.so` is linked with 16 KB page alignment
  (Play targetSdk 35+).
- Web is a stub (`isAvailable() === false`; stitch calls resolve `success: false`).
