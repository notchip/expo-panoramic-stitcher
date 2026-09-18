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
| Android OpenCV | download `OpenCV-android-sdk`, wire `jniLibs.srcDirs`, hand-roll CMake + JNI | Gradle downloads the official `opencv-4.13.0-android-sdk.zip` once (~303 MB, SHA-256-verified) into the Gradle user-home cache and statically links `libopencv_stitching.a` + friends into the one JNI shim. (The Maven `org.opencv:opencv` AAR is not usable: its `libopencv_java4.so` does not compile in the stitching module at all.) |
| iOS OpenCV | download `opencv2.framework`, vendor it by hand, fight Apple-Silicon simulator arches (`withOpenCVSimulatorFix.js`) | `npm install` fetches the `yeatse/opencv-spm` prebuilt `opencv2.xcframework` (~191 MB zip, SHA-256-verified, device + arm64-sim slices) once into the package's `ios/` dir; the podspec vendors it (`vendored_frameworks`). No manual step, no arch hack — and it links under **static frameworks**, which the previous SPM approach did not (an SPM product attaches to the pod target only and never reaches the app's link line when the pod is a static framework). |
| iOS bridge | Swift → ObjC++ `Bridge.mm` → C++ `.mm` (two layers) | Swift → one thin `PanoramaStitcherShim.mm` (file-IO via OpenCV, no UIKit) |
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
//    Bare paths or file:// URIs (what expo-camera returns) — both accepted.
const res = await stitchImagePaths(photoPaths, { warpMode: 'spherical', outputWidth: 4096 });
// res.path is a bare filesystem path — prefix it for <Image>:
// <Image source={{ uri: `file://${res.path}` }} />
// res.geometry (or null) — the warp model, see "Stitch geometry" below

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

**Input paths:** `stitchImagePaths` / `stitchSweep` accept bare filesystem
paths *or* `file://` URIs — expo-camera's `takePictureAsync` returns `file://`
URIs on both platforms, and native reads with `cv::imread`, which cannot open a
URL-scheme string, so the wrappers strip and percent-decode `file://` (and
`file://localhost/`) automatically (`normalizeImagePath()` is exported if you
need it yourself). Other schemes (`content://`, `ph://`) are passed through
untouched and will fail natively — copy those to a file first.

### Options (`StitchOptions`)

| field | default | notes |
|---|---|---|
| `warpMode` | `spherical` | `spherical` (360°), `cylindrical` (wide horizontal), `plane` (flat scans, affine) |
| `blendStrength` | 5 | 1–10, number of multiband blending bands (clamped) |
| `matchConf` | 0.3 | feature-match confidence 0–1, lower = more lenient |
| `panoConfidence` | 1.0 | pano confidence threshold — OpenCV keeps only the largest connected component of images clearing this bar, so at 1.0 weakly-matched shots (low-texture walls) can be **silently dropped**. Lower (0.5–0.7) keeps more images at the risk of worse alignment; check `usedIndices` on the result |
| `matchNeighbors` | 0 | Neighbour-only feature matching (opt-in). `0` = match every pair (OpenCV's default). `k > 0` = only pairs whose input indices differ by at most `k` (`0 < \|i−j\| ≤ k`) are matched. An ordered sweep only overlaps its neighbours, so all-pairs matching wastes time (O(n²) pairs) and invites false matches between repetitive indoor textures (identical doors, tiles, radiators) that can pull the bundle adjustment apart |
| `matchWrap` | false | With `matchNeighbors > 0`, also match the two ends of the input (`\|i−j\| ≥ n−k`) — the principled loop closure for a full-turn sweep. No effect when `matchNeighbors` is 0. `stitchSweep` sets it to its `wrapClosed` flag unless you pass it explicitly |
| `outputWidth` | 4096 | height auto = width/2 when `autoResize`; otherwise the composite is only downscaled to this width (never upscaled) |
| `autoResize` | true | force equirectangular 2:1 (`stitchSweep` defaults this to **false** — a partial sweep must not be stretched) |
| `jpegQuality` | 95 | 1–100 |

### Result fields

Every result (`StitchResult`, `StitchBase64Result`) carries `width`/`height`,
`usedIndices`/`usedCount` (see *Partial panoramas* above) and
`geometry: StitchGeometry | null` — the warp model OpenCV actually composed
with (next section). `geometry` is `null` when native could not recover it
(a successful stitch is never failed because of geometry) and always `null`
for the incremental first-frame pass-through. The raw native module (the
default export) still returns it as a compact `geometryJson: string`
(`NativeStitchResult` / `NativeStitchBase64Result`); `parseGeometry()` turns
that into the same object.

### Stitch geometry (pixels → angles)

Every successful stitch reports the warp model OpenCV actually composed with,
recovered natively (identically on iOS and Android) by replaying
`cv::Stitcher::composePanorama`: per composited image its intrinsics `K` and
camera-to-world rotation `R` at the input image's pixel scale, the canvas scale
`warpScale` (pixels per radian), the canvas `origin`, the un-resized
`compositeWidth`/`compositeHeight`, and an `output` affine mapping composite
pixels to the JPEG you received (`X_out = sx·X + tx`; `tx = ty = 0` today,
`sx ≈ sy` for the `outputWidth` downscale, `sx ≠ sy` for the legacy
`autoResize` 2:1 stretch, `1/1` when nothing was resized). `selfCheck: true`
means the replayed canvas rect equals the real composite size (the ROIs and
origin are exact).

Conventions (OpenCV's): camera frame x right, **y down**, z forward; a pixel's
world ray is `p = R · K⁻¹ · (x, y, 1)` with
`K = [[focal, 0, ppx], [0, focal·aspect, ppy], [0, 0, 1]]`. Global warped
coordinates:

```
u = warpScale · atan2(p.x, p.z)              azimuth, linear in u, increasing turning RIGHT
v = warpScale · (π − acos(p.y / |p|))        spherical  (top pole v = 0, horizon v = warpScale·π/2)
v = warpScale · p.y / hypot(p.x, p.z)        cylindrical (horizon v = 0, v = −warpScale·tan(elevation))
```

Composite pixel = `(u − origin.x, v − origin.y)`; output pixel = `output`
affine of that. For an output pixel:

```
azimuthDeg   = ((xOut − tx)/sx + origin.x) / warpScale · 180/π
elevationDeg = 90 − ((yOut − ty)/sy + origin.y) / warpScale · 180/π          (spherical)
elevationDeg = −atan(((yOut − ty)/sy + origin.y) / warpScale) · 180/π       (cylindrical)
```

Azimuths are relative to OpenCV's (wave-corrected) world frame, not north — use
`fitGyroToPano` to relate them to the capture-time gyro yaw
(`panoAzimuth ≈ sign·gyroYaw + offsetDeg`; `sign` absorbs the sensor
handedness, `rmsDeg` reports the agreement). `warpMode: 'plane'` composites
are `projection: 'affine'`: `focal = 1/workScale`, `ppx = ppy = 0`, `R` holds
the 2-D similarity; the angle helpers return `null` for them
(`imagePointToPano` still works).

Pure-TS helpers (no native, exported from the core entry): `parseGeometry`,
`cameraAngles`, `panoPixelToAngles`, `anglesToPanoPixel`, `imagePointToPano`,
`cameraAzimuthIntervalDeg`, `coverageFromGeometry`, `fitGyroToPano`,
`wrapDeg`. Coverage uses each camera's `yaw ± hfov/2`
(`hfov = 2·atan(srcWidth/(2·focal))`), never `roi.width` — an image straddling
the ±180° seam gets a ROI as wide as the whole canvas.

```ts
import { panoPixelToAngles } from '@notchip/expo-panoramic-stitcher';

const a = panoPixelToAngles(res.geometry!, xOut, yOut); // { azimuthDeg, elevationDeg } | null
// Azimuth differences between two wall-corner pixels are true angles,
// regardless of the JPEG's resize — the basis for relative wall widths.
```

Raw payload (`geometryJson`, version 1, compact ASCII, locale-safe numbers,
non-finite → `null`):
`{v:1, projection, workScale, warpScale, origin:{x,y}, compositeWidth, compositeHeight, selfCheck, output:{sx,sy,tx,ty}, cameras:[{inputIndex, srcWidth, srcHeight, focal, ppx, ppy, aspect, R:[9], roi:{x,y,width,height}}]}`.
For `stitchIncrementalBase64` the geometry describes the
`[existing panorama, new image]` pair — the "camera" fitted to an
already-warped panorama is not a physical pinhole; treat it as diagnostic.

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
      onComplete={async (photos: SweepPhoto[], meta) => {
        // stitchSweep uses the photos' yawDeg for wrap closure + gap feedback;
        // `meta` (the sweep record) travels into the manifest sidecar.
        const res = await stitchSweep(photos, { meta });
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

`SweepPhoto` carries the four fields the stitcher needs — `uri`, `width`,
`height`, `yawDeg` (the integrated yaw at the moment each shutter fired) — plus
the sensor/timing/EXIF record of the tick that fired it (below). It is
structurally assignable to the core `SweepInputPhoto`, and everything on it is
carried into the sweep manifest verbatim.

### Per-frame capture record (`SweepPhoto`)

| Field | Meaning |
|---|---|
| `tiltDeg`, `rollDeg` | Pitch / roll delta vs the settle-window baseline at trigger (signed; the same numbers the HUD showed on that tick). |
| `tiltMagDeg` | True angular deviation of gravity from the baseline — the capture gate value. |
| `rateDegS` | Smoothed yaw rate (EMA, deg/s) at trigger — the hold-still gate value. |
| `gravity` | Normalized gravity direction at trigger, device frame (`{x,y,z}`). |
| `sensorTs` | Sensor-clock timestamp of the trigger sample (`rotationRate.timestamp`, seconds). |
| `triggeredAt` / `resolvedAt` | `Date.now()` immediately before `takePictureAsync` and when it resolved. |
| `yawDegAtResolve` | Integrated yaw when the picture resolved. With `yawDeg` this brackets the shutter latency — the true exposure yaw lies between the two. |
| `exifOrientation` | EXIF `Orientation` (1–8) of the delivered file, `null` when EXIF is off/absent. |
| `exif` | Normalized `SweepPhotoExif` (below), `null` when EXIF is off, unavailable or was rejected. |

`width`/`height` are the **upright** pixel dimensions on both platforms (see
the Android note under EXIF).

### Sweep-level metadata (`SweepCaptureMeta`)

`useGuidedSweep()` returns `meta` (`null` before the first `start()`), and
`<GuidedSweepCapture onComplete={(photos, meta) => …} />` passes it as the
second argument (one-argument handlers still typecheck). It is written at
`start()`, once when the settle window completes (`gravityRef`), and when the
sweep ends — never per sensor tick. Pass it to `stitchSweep(photos, { meta })`
and it becomes `manifest.sweep`.

```ts
type SweepCaptureMeta = {
  id: string;                       // random per sweep
  platform: "ios" | "android" | "web" | "other";
  startedAt: number;                // Date.now() at start()
  finishedAt: number | null;
  endedBy: "finish" | "maxShots" | "background" | null;
  config: GuidedSweepConfig;        // snapshot of the resolved options at start()
  gravityRef: { x; y; z } | null;   // g0: normalized gravity averaged over the settle window — every frame's tilt/roll is relative to this
  direction: 1 | -1 | 0;            // locked sweep direction at finish
  relatched: boolean;               // the direction lock re-latched once after a false start
  camera: { facing: "back"; zoom: number; photoQuality: number; exifRequested: boolean };
};
```

`endedBy` distinguishes the user pressing Finish (`finish`), the `maxShots`
auto-stop (`maxShots`) and the AppState abort on backgrounding (`background`;
shots taken so far are kept). `reset()` does not clear `meta`; the next
`start()` replaces it.

### EXIF and the focal-length prior (`exif` option, default **on**)

`GuidedSweepOptions.exif?: boolean | "full"` (default `true`) requests EXIF
with every capture (`takePictureAsync({ quality, exif: true })`) and attaches
it as `photo.exif`, normalized across platforms:

```ts
type SweepPhotoExif = {
  focalLengthMm; focalLength35mm; focalPx; focalPxSource: "exif35" | null;
  lensModel; make; model; iso; exposureTimeS; fNumber; digitalZoomRatio;
  pixelWidth; pixelHeight; dateTimeOriginal; subsecTimeOriginal;   // all `T | null`
  raw?: Record<string, unknown>;                                    // only with exif: "full"
};
```

- iOS returns Apple spellings (`FocalLenIn35mmFilm`, `LensModel`,
  `ISOSpeedRatings` as an array, `SubsecTimeOriginal`) and no `Make`/`Model`;
  Android returns `ExifInterface` names (`FocalLengthIn35mmFilm` — often
  absent, `Make`/`Model`, ISO as an int, `SubSecTimeOriginal`) and no
  `LensModel`. `normalizeExif()` (exported) handles both, plus numeric strings
  and `"n/d"` rationals.
- `"full"` keeps the raw dictionary as `exif.raw` with `MakerNote` (and Apple's
  maker blob) dropped — on some Android devices that blob is tens of kilobytes
  per frame.
- **iOS retry:** iOS rejects a capture with `Failed to process EXIF data` when
  the Exif dictionary is missing from the photo metadata. On an EXIF-related
  rejection (message mentions EXIF) the hook retries that shot once without
  EXIF and stops requesting EXIF for the rest of the sweep, so a sweep never
  stalls; those frames simply have `exif: null`. Any other capture failure
  keeps the usual behaviour (the target is retried on the next tick) and
  leaves EXIF on.
- **Android orientation behaviour:** with `exif: true`, expo-camera on Android
  does **not** rotate the bitmap upright (it writes the `Orientation` tag onto
  the file instead), so `takePictureAsync` reports the raw sensor dimensions
  and portrait shots carry `Orientation` 6/8. The hook swaps `width`/`height`
  when `exifOrientation` is 5–8 so `SweepPhoto.width/height` remain upright on
  both platforms (iOS already reports orientation-aware dims and is left
  alone). The stitcher is unaffected: `cv::imread` honours EXIF orientation.
  `exif.pixelWidth/pixelHeight` are the raw frame dims as the platform wrote
  them — prefer `SweepPhoto.width/height`.

**Focal-length prior.** `exif.focalPx` is derived from the 35 mm-equivalent
focal length with the diagonal equivalence (the CIPA definition phones use) on
the full 4:3 sensor frame, reconstructed from the delivered dimensions so a
9:16 / 1:1 / preview-aspect crop gives the same value as the uncropped frame:

```
long = max(w, h), short = min(w, h)
fullLong  = max(long, short × 4/3)
fullShort = max(short, long × 3/4)
focalPx   = f35 × hypot(fullLong, fullShort) / 43.2666      // 36 × 24 mm diagonal
```

For a 3024 × 4032 frame at 26 mm this gives ≈ 3029 px. Treat it as a **prior
with roughly ±5 % accuracy** — `f35` is written as an integer, sensors are not
exactly 4:3, and some vendors fold digital zoom or lens correction into it. It
is good enough to seed metric monodepth or a bundle adjuster; the focal the
stitcher itself estimates (`geometry.cameras[].focal`) supersedes it for
frames that were stitched. `focalPx`/`focalPxSource` are `null` when the 35 mm
tag is absent (common on Android). `deriveFocalPx()` is exported for use on
other images. Set `exif: false` to skip all of this.

### Headless hook — bring your own UI

`useGuidedSweep(options)` is the full state machine with no UI: phases
(`idle → sweeping → done`), sensor fusion, capture gating. You render the
camera and HUD yourself and bind the returned ref + ready callback:

```tsx
import { CameraView } from 'expo-camera';
import { useGuidedSweep, SweepStatus } from '@notchip/expo-panoramic-stitcher/capture';

function MyCapture() {
  const { phase, shots, hud, meta, start, finish, reset, cameraRef, onCameraReady, isCameraReady } =
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
   the chain can see its own loop, and `matchWrap` defaults to `true` so the
   two ends are matched explicitly. `wrapClosed: true` does **not** mean the
   trailing edge duplicates the start: under OpenCV's rotation model
   (`u = warpScale·atan2`, bounded to one turn) the duplicates land on their
   sources rather than widening the panorama, so do not crop. Instead
   `wrapClosure: { closureErrorDeg, pairs } | null` reports the **measured**
   loop drift (mean absolute circular difference between each re-appended
   duplicate's azimuth and its source's — non-null only when a duplicate and
   its source were both composited and geometry is available), and
   `strips[0].coverage` tells you where the canvas actually ends.
2. **Arc salvage** — if the primary stitch used only a subset
   (`usedCount < photos.length`), the dropped complement is re-stitched once
   (same options, order preserved) and **all** successful strips are returned:
   `strips: [{ path, width, height, usedIndices, geometry, coverage }]`,
   largest first (the top-level `path`/`width`/`height`/`usedIndices`/
   `geometry` mirror `strips[0]`). `usedIndices` are canonical photo indices
   (duplicates mapped back). One failed complement is not an error — you get
   what succeeded.
3. **Gap feedback** — `gaps: [{ fromDeg, toDeg }]` are the yaw ranges covered
   by dropped-and-unsalvaged photos, so a caller can show "re-sweep near
   280°". Empty when every photo landed in some strip. `yawSpanDeg` is the
   sweep's gyro yaw span (`max − min` of `photos[].yawDeg`), the value that
   gated wrap closure — handy to label a partial sweep's field of view.
4. **Tagged geometry** — every strip's `geometry` is a `SweepStripGeometry`:
   the stitch geometry with each camera tagged by its canonical `photoIndex`
   (a wrap-closed primary contains the same `photoIndex` twice — source and
   duplicate; `inputIndex` tells them apart), and `coverage`
   (`coverageFromGeometry`: union of the cameras' `yaw ± hfov/2` on the circle,
   plus `holes`). Pair it with `fitGyroToPano(photos, strip.geometry)` to map
   pano azimuths onto the capture-time gyro frame.
5. **Sweep manifest + sidecar** — `manifest` (always present, in memory) is a
   plain-JSON record of the whole sweep: `sweep` (the capture `meta` you pass
   in, or `null`), `photos[]` (the canonical photos, each with `index`, the
   `uri` as given, the normalized `path`, and **every other field you passed**
   — the capture record's sensor tick, timing and EXIF travel through
   verbatim) and `stitch` (path/size/`usedIndices`, `strips` with geometry and
   coverage, `gaps`, `wrapClosed`/`wrapClosure`, `warpModeUsed`,
   `fellBackToCylindrical`, `yawSpanDeg`, and `options`: the fully resolved
   `StitchOptions` actually sent to native for the primary stitch).
   `schemaVersion: 1`, `generator`, `createdAt` (ISO) and `platform`
   (`meta.platform`, else `"unknown"`) head it. Unless `sidecar: false`, it is
   also written **best-effort** as `<pano>.json` next to the primary strip
   (or at `sidecar: { path }`) with `expo-file-system`'s synchronous
   `File.write`: `sidecarPath` is the path on success, otherwise `null` with
   the reason in `sidecarError` — a failed write (module missing, I/O error)
   **never rejects** and never touches `success`. `buildSweepManifest()` is
   exported for rebuilding a manifest from a saved result.

```ts
import { stitchSweep } from '@notchip/expo-panoramic-stitcher';

const res = await stitchSweep(photos, { meta }); // photos: { uri, yawDeg, ...capture record }[]
// res.path         largest panorama strip (bare path)
// res.strips       every stitched strip, largest first, each with geometry + coverage
// res.gaps         e.g. [{ fromDeg: 270, toDeg: 300 }] → "re-sweep near 280°"
// res.wrapClosure  { closureErrorDeg, pairs } when the loop was closed and measured
// res.manifest     the sweep manifest (in memory) — res.sidecarPath is its JSON twin on disk
```

> **Everything lives in temp/cache directories.** expo-camera writes photos to
> the app cache, the stitcher writes the panorama under a `pano-stitch/` temp
> dir, and the sidecar lands next to the panorama — all of which the OS may
> purge at any time. Copy the photos, the panorama and the sidecar into a
> document directory (e.g. `Paths.document` with `expo-file-system`) before
> you rely on them. `manifest.photos[].path` / `manifest.stitch.path` record
> where things were at stitch time, not a promise that they are still there.

`expo-file-system` is an **optional** peer (every Expo app already has it —
`expo` depends on it) loaded with a guarded `require`; without it the sidecar
simply reports `sidecarError` and nothing else changes.

Defaults (deliberately different from `stitchImagePaths`):
`warpMode: 'cylindrical'`, `panoConfidence: 0.7`, `autoResize: false` (a
sweep is **never stretched to 2:1** by default — a 120° strip forced into an
equirectangular frame is geometrically meaningless; the strip keeps its
natural aspect and is only downscaled to `outputWidth`; pass
`autoResize: true` to opt back in) and `matchWrap: wrapClosed`. `matchNeighbors`
passes through unchanged. Two hard rules:

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
- Output paths (`res.path`, `strips[].path`, `sidecarPath`) are in a temp
  directory (`pano-stitch/` under the platform temp/cache dir) that the OS may
  purge — move what you want to keep into a document directory.
- Web is a stub (`isAvailable() === false`; stitch calls resolve `success: false`).
