# @notchip/expo-panoramic-stitcher

360° / wide panorama image stitching for **Expo SDK 56** (RN 0.85), written in
**Swift + Kotlin** with the Expo Modules API, powered by **OpenCV 4.13**.

> **No manual OpenCV download.** Android pulls OpenCV from Maven Central; iOS pulls
> a prebuilt OpenCV XCFramework via Swift Package Manager. No vendored
> `opencv2.framework`, no `OpenCV-android-sdk/`, no simulator arch hacks.

## How this avoids the old OpenCV pain

| | Old way (manual) | This module |
|---|---|---|
| Android OpenCV | download `OpenCV-android-sdk`, wire `jniLibs.srcDirs`, hand-roll CMake + JNI | `implementation 'org.opencv:opencv:4.13.0'` — native libs auto-bundled. One ~150-line JNI shim compiled against the AAR's prefab headers (the AAR's Java API does not cover the stitching module). |
| iOS OpenCV | download `opencv2.framework`, vendor it, fight Apple-Silicon simulator arches (`withOpenCVSimulatorFix.js`) | SPM dependency on `yeatse/opencv-spm` XCFramework (device + arm64-sim slices). No vendoring, no arch hack. |
| iOS bridge | Swift → ObjC++ `Bridge.mm` → C++ `.mm` (two layers) | Swift → one thin `PanoramaStitcherShim.mm` (~140 lines, file-IO via OpenCV, no UIKit) |
| Result payload | iOS returned base64, Android returned RGBA bytes (asymmetric) | identical `StitchBase64Result` on both platforms |

OpenCV is a C++ library, so each platform keeps exactly **one** small C++ shim:
`PanoramaStitcherShim.mm` on iOS, `panorama_stitcher_jni.cpp` on Android. The two
contain the same stitch core and must be edited together. (The Maven AAR's
Java/Kotlin bindings do not wrap OpenCV's stitching module — upstream wraps it
for Python only — which is why Android needs the JNI shim.)

## Install (into an Expo app)

```bash
npx expo install @notchip/expo-panoramic-stitcher   # or: add as a local module
npx expo prebuild --clean
```

Requirements: Expo SDK 56+ (React Native 0.85+), iOS 16.4+, Xcode 26.4+,
Android minSdk 24. First iOS `pod install` resolves the OpenCV Swift package
(downloads the XCFramework once, then cached).

> `spm_dependency` in the podspec is provided by React Native's pod helpers
> (RN ≥ 0.75), which every Expo host Podfile loads. It is **not** a CocoaPods
> feature — linting the podspec standalone (`pod spec lint`) will not resolve it.

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

### Options (`StitchOptions`)

| field | default | notes |
|---|---|---|
| `warpMode` | `spherical` | `spherical` (360°), `cylindrical` (wide horizontal), `plane` (flat scans, affine) |
| `blendStrength` | 5 | 1–10, number of multiband blending bands (clamped) |
| `matchConf` | 0.3 | feature-match confidence 0–1, lower = more lenient |
| `outputWidth` | 4096 | height auto = width/2 when `autoResize` |
| `autoResize` | true | force equirectangular 2:1 |
| `jpegQuality` | 95 | 1–100 |

### Progress events

`onStitchProgress` fires coarse stages: `decoding` (0.1) → `stitching` (0.3) →
`encoding` (0.85) → `done` (1.0). `stitchImagePaths` emits only `stitching` and
`done`; the incremental first-frame pass-through emits nothing.

## Architecture

```
JS / TS  (index.ts — defaults, validation, typed API)
   │  requireNativeModule('ExpoPanoramicStitcher')
   ├── iOS:   ExpoPanoramicStitcherModule.swift   (base64 ↔ temp file, own dispatch queue)
   │            └─ PanoramaStitcherShim.mm  → cv::Stitcher  (OpenCV via SPM)
   └── Android: ExpoPanoramicStitcherModule.kt    (base64 ↔ temp file, own thread)
                └─ panorama_stitcher_jni.cpp → cv::Stitcher  (OpenCV via Maven, prefab headers)
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
- If your app uses `use_frameworks! :linkage => :static`, verify the OpenCV
  XCFramework links cleanly.
- iOS only (no tvOS): the prebuilt OpenCV XCFramework has no tvOS slice.
- Web is a stub (`isAvailable() === false`; stitch calls resolve `success: false`).
