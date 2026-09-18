/**
 * Warp surface used when projecting images before blending.
 * - `spherical`   best for full 360° / equirectangular output (default)
 * - `cylindrical` good for wide horizontal panoramas
 * - `plane`       flat scenes / near-planar subjects
 */
export type WarpMode = "spherical" | "cylindrical" | "plane";

export interface StitchOptions {
  /** Warp surface. Default: `spherical`. */
  warpMode?: WarpMode;
  /**
   * Number of multiband blending bands, 1-10 (values are clamped).
   * More bands = smoother seams, slower. Default: 5.
   */
  blendStrength?: number;
  /** Feature-match confidence 0.0-1.0. Lower = more lenient matching. Default: 0.3. */
  matchConf?: number;
  /**
   * Panorama confidence threshold (OpenCV `setPanoConfidenceThresh`). After
   * matching, OpenCV keeps only the largest connected component of images whose
   * pairwise confidence clears this bar — at the default 1.0 it can silently
   * drop weakly-matched images (e.g. low-texture walls) and stitch a partial
   * panorama. Lower values (0.5-0.7) keep more images at the risk of worse
   * alignment. Check `usedIndices`/`usedCount` on the result to see what was
   * actually composited. Default: 1.0 (OpenCV's default).
   */
  panoConfidence?: number;
  /**
   * Neighbour-only feature matching (opt-in). `0` = match every pair of
   * images (OpenCV's default). `k > 0` = only pairs whose input indices
   * differ by at most `k` (`0 < |i-j| <= k`) are matched. An ordered sweep
   * only ever overlaps its neighbours, so all-pairs matching wastes time
   * (O(n²) pairs) and invites false matches between repetitive indoor
   * textures (identical doors, tiles, radiators) that can pull the bundle
   * adjustment apart. Default: `0`.
   */
  matchNeighbors?: number;
  /**
   * With `matchNeighbors > 0`, also match the two ends of the ordered input
   * (pairs with `|i-j| >= n-k`) — the principled loop closure for a full-turn
   * sweep, instead of hoping a far-apart pair matches by chance. No effect
   * when `matchNeighbors` is `0`. Default: `false` (`stitchSweep` sets it to
   * its `wrapClosed` flag unless you pass it explicitly).
   */
  matchWrap?: boolean;
  /** Output width in px. Height auto-derives (2:1 when `autoResize`). Default: 4096. */
  outputWidth?: number;
  /** Resize result to equirectangular 2:1 aspect ratio. Default: true. */
  autoResize?: boolean;
  /** JPEG quality 1-100 for base64 / file output. Default: 95. */
  jpegQuality?: number;
}

/**
 * Result of a file-path based stitch.
 * On iOS/Android, failures REJECT the promise — a resolved result always has
 * `success: true`. The `success`/`errorMessage` fields exist for shape symmetry
 * with the web stub, which resolves with `success: false` instead.
 */
export interface StitchResult {
  success: boolean;
  /** Absolute filesystem path to the written panorama JPEG (no `file://` scheme). */
  path: string;
  width: number;
  height: number;
  /** Width / height. ~2.0 for equirectangular. */
  aspectRatio: number;
  /**
   * Indices (into the input array, ascending) of the images OpenCV actually
   * composited. OpenCV keeps only the largest connected component of matched
   * images, so this can be a subset — `usedCount < inputs.length` means a
   * partial panorama (see `panoConfidence`).
   */
  usedIndices: number[];
  /** `usedIndices.length` — compare against your input count. */
  usedCount: number;
  /**
   * Warp geometry of the composite (camera intrinsics/rotations, pixels per
   * radian, ROIs) parsed from native's `geometryJson`, or `null` when native
   * could not recover it (never fails the stitch). See {@link StitchGeometry}
   * and the pure-TS helpers in `geometry.ts` (`panoPixelToAngles`, …).
   */
  geometry: StitchGeometry | null;
  /** Human-readable error (empty on success; only the web stub populates it). */
  errorMessage: string;
}

/**
 * What the raw native module (the default export) actually resolves for
 * `stitchImagePaths`: the public {@link StitchResult} shape but with the
 * geometry still as the compact JSON string native produced (`""` when
 * unavailable). The `stitchImagePaths` wrapper parses it into `geometry`.
 */
export interface NativeStitchResult extends Omit<StitchResult, "geometry"> {
  /** Compact JSON (`StitchGeometry` v1) or `""`. */
  geometryJson: string;
}

/**
 * Result of a base64 stitch. Identical shape on iOS and Android
 * (the legacy module returned different payloads per platform — fixed here).
 * On iOS/Android, failures REJECT the promise — a resolved result always has
 * `success: true`; only the web stub resolves with `success: false`.
 */
export interface StitchBase64Result {
  success: boolean;
  /** Base64-encoded JPEG (no data-URL prefix). */
  base64Image: string;
  width: number;
  height: number;
  /**
   * Indices (into the input array, ascending) of the images OpenCV actually
   * composited — a subset means a partial panorama (see `panoConfidence`).
   * The incremental first-frame pass-through reports `[0]` / `1`.
   */
  usedIndices: number[];
  /** `usedIndices.length` — compare against your input count. */
  usedCount: number;
  /**
   * Warp geometry of the composite (see {@link StitchGeometry}) or `null`
   * when unavailable — always `null` for the incremental first-frame
   * pass-through (nothing was stitched).
   */
  geometry: StitchGeometry | null;
  errorMessage: string;
}

/**
 * What the raw native module (the default export) actually resolves for
 * `stitchBase64` / `stitchIncrementalBase64`: {@link StitchBase64Result} with
 * the geometry still as native's compact JSON string (`""` when unavailable).
 */
export interface NativeStitchBase64Result extends Omit<
  StitchBase64Result,
  "geometry"
> {
  /** Compact JSON (`StitchGeometry` v1) or `""`. */
  geometryJson: string;
}

// ---------------------------------------------------------------------------
// Stitch geometry (native reports the raw camera model; all interpretation —
// angles, coverage, gyro fit — is plain TS in geometry.ts).
// ---------------------------------------------------------------------------

/**
 * Projection of a stitched composite. `spherical` = PANORAMA mode with
 * OpenCV's default warper, `cylindrical` = `warpMode: 'cylindrical'`,
 * `affine` = `warpMode: 'plane'` (SCANS mode — angles are undefined there).
 */
export type StitchProjection = "spherical" | "cylindrical" | "affine";

/** 3×3 matrix, row-major: `[r00, r01, r02, r10, r11, r12, r20, r21, r22]`. */
export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Integer pixel rectangle. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One input image that made it into the composite, with the camera model
 * OpenCV estimated for it, at compose scale (= the input image's own pixel
 * scale — native multiplies the registration-scale cameras by
 * `1 / workScale`, exactly as `composePanorama` does).
 *
 * `K = [[focal, 0, ppx], [0, focal·aspect, ppy], [0, 0, 1]]` maps a camera
 * ray to image pixels; `R` is camera-to-world (x right, y DOWN, z forward),
 * so a pixel `(x, y)` becomes the world ray `p = R · K⁻¹ · (x, y, 1)` — the
 * ray OpenCV's warper then projects (see {@link StitchGeometry}).
 *
 * For `affine` composites OpenCV's estimator reports `focal = 1` (scaled to
 * `1 / workScale`), `ppx = ppy = 0`, and `R` holds the 2-D similarity
 * `[[a, b, tx], [c, d, ty], [0, 0, 1]]` instead of a rotation.
 */
export interface StitchCamera {
  /** Index into the input array passed to the stitch call. */
  inputIndex: number;
  /** Source image size in pixels (what `cv::imread` decoded). */
  srcWidth: number;
  srcHeight: number;
  /** Focal length in pixels at compose scale. */
  focal: number;
  /** Principal point in pixels at compose scale (OpenCV keeps it at the image centre). */
  ppx: number;
  ppy: number;
  /** Pixel aspect (`fy = focal · aspect`); 1 in practice. */
  aspect: number;
  /** Camera-to-world rotation, row-major (see above). */
  R: Mat3;
  /**
   * This image's footprint on the warped canvas in GLOBAL warped coords
   * (`warpRoi`). Composite position = `roi.x - origin.x`, `roi.y - origin.y`.
   * An image straddling the ±180° seam gets a ROI as wide as the whole
   * canvas — use the camera's yaw ± half-FOV for azimuth coverage instead.
   */
  roi: PixelRect;
}

/**
 * Warp geometry of a stitched composite, recovered natively (identically on
 * both platforms) by replaying `cv::Stitcher::composePanorama`. Everything
 * is in pixels at compose scale; `output` maps composite pixels to the pixels
 * of the JPEG you actually received (which may have been downscaled).
 *
 * Global warped coordinates `(u, v)` of a world ray `p` (pixels, both
 * projections use OpenCV's `warpScale` = pixels per radian):
 *
 *   u = warpScale · atan2(p.x, p.z)                  azimuth, linear in u,
 *                                                     increasing turning RIGHT
 *   v = warpScale · (π − acos(p.y / |p|))             spherical: top pole v = 0,
 *                                                     horizon v = warpScale·π/2
 *   v = warpScale · p.y / hypot(p.x, p.z)             cylindrical: horizon v = 0,
 *                                                     v = −warpScale·tan(elevation)
 *
 * Composite pixel `(X, Y) = (u − origin.x, v − origin.y)`; output pixel
 * `(sx·X + tx, sy·Y + ty)`. Hence, for an output pixel:
 *
 *   azimuthDeg   = ((xOut − tx)/sx + origin.x) / warpScale · 180/π
 *   elevationDeg = 90 − ((yOut − ty)/sy + origin.y) / warpScale · 180/π   (spherical)
 *   elevationDeg = −atan(((yOut − ty)/sy + origin.y) / warpScale) · 180/π  (cylindrical)
 *
 * `geometry.ts` implements these (`panoPixelToAngles`, `anglesToPanoPixel`,
 * `imagePointToPano`, `cameraAngles`, `coverageFromGeometry`, …). Azimuths
 * are relative to OpenCV's world frame (wave-corrected, first-camera-ish),
 * not to north — use `fitGyroToPano` to relate them to the gyro yaw.
 */
export interface StitchGeometry {
  /** Payload version. */
  v: 1;
  projection: StitchProjection;
  /** OpenCV registration scale (features were found on images scaled by this). */
  workScale: number;
  /** Pixels per radian at compose scale (OpenCV's median focal · 1/workScale). */
  warpScale: number;
  /** Top-left of the composite canvas in global warped coords (`resultRoi(...).tl()`). */
  origin: { x: number; y: number };
  /** Composite size BEFORE any `outputWidth` / `autoResize` resize. */
  compositeWidth: number;
  compositeHeight: number;
  /**
   * `true` when the replayed canvas rect equals the real composite size —
   * i.e. the ROIs/origin above are exact. `false` means OpenCV composed
   * differently than modelled; treat the geometry as approximate.
   */
  selfCheck: boolean;
  /**
   * Composite → output affine: `X_out = sx·X + tx`, `Y_out = sy·Y + ty`.
   * Today `tx = ty = 0`; `sx = sy` (up to rounding) for the isotropic
   * `outputWidth` downscale, `sx ≠ sy` for the legacy `autoResize` 2:1
   * stretch, `1 / 1` when nothing was resized.
   */
  output: { sx: number; sy: number; tx: number; ty: number };
  /** One entry per composited input, in OpenCV's (unsorted) component order. */
  cameras: StitchCamera[];
}

/** Yaw/pitch/roll of a camera derived from its `R` (see `cameraAngles`). */
export interface CameraAngles {
  /** `atan2(R[2], R[8])` in degrees — pano azimuth of the optical axis, increasing turning right. */
  yawDeg: number;
  /** `−asin(R[5])` in degrees — up positive. */
  pitchDeg: number;
  /** `atan2(R[3], R[0])` in degrees — diagnostic only. */
  rollDeg: number;
}

/** Direction of a panorama pixel (see `panoPixelToAngles`). */
export interface PanoAngles {
  /** Not wrapped: a full-turn composite spans (−180, 180]. */
  azimuthDeg: number;
  /** Up positive. */
  elevationDeg: number;
}

/** A pixel position in the OUTPUT panorama (after the output affine). */
export interface PanoPoint {
  x: number;
  y: number;
}

/**
 * A closed azimuth interval `[fromDeg, toDeg]`. As produced by the coverage
 * helpers: `fromDeg` in [−180, 180) and `toDeg > fromDeg`; `toDeg` may
 * exceed 180 when the interval crosses the ±180° seam (subtract 360 to get
 * the wrapped end). `cameraAzimuthIntervalDeg` returns the raw
 * `yaw ± hfov/2` without normalising.
 */
export interface AzimuthInterval {
  fromDeg: number;
  toDeg: number;
}

/** Azimuth coverage of a strip on the circle (see `coverageFromGeometry`). */
export interface SweepCoverage {
  /** `min(360, compositeWidth / warpScale · 180/π)` — the canvas's angular width. */
  spanDeg: number;
  /** Total degrees covered by the union of the cameras' `yaw ± hfov/2` intervals (≤ 360). */
  coveredDeg: number;
  /** Union of the per-camera azimuth intervals, merged on the circle, sorted by `fromDeg`. */
  intervals: AzimuthInterval[];
  /** Complement of `intervals` on the circle (empty for a full turn). */
  holes: AzimuthInterval[];
}

/** Per-photo residual of a gyro-to-pano fit. */
export interface GyroPanoResidual {
  photoIndex: number;
  /** `wrap(panoYaw − (sign·gyroYaw + offsetDeg))`, degrees. */
  residualDeg: number;
}

/**
 * Least-squares (circular) fit `panoAzimuth ≈ sign · gyroYaw + offsetDeg`
 * between the capture-time gyro yaws and the stitched camera azimuths
 * (see `fitGyroToPano`). `sign` absorbs the sensor's handedness; `rmsDeg`
 * tells you how well the sweep's gyro integration agrees with the stitch.
 */
export interface GyroPanoFit {
  sign: 1 | -1;
  offsetDeg: number;
  rmsDeg: number;
  residuals: GyroPanoResidual[];
}

// ---------------------------------------------------------------------------
// Sweep input (capture record mirror). The capture entry's `SweepPhoto` /
// `SweepCaptureMeta` (`@notchip/expo-panoramic-stitcher/capture`) are
// structurally assignable to the types below — the shapes are DUPLICATED
// here, field name for field name, because the core entry must never import
// from `src/capture/` (not even `import type`). Keep the two in sync: when
// the capture record gains a field, mirror it here as an OPTIONAL field.
// ---------------------------------------------------------------------------

/** A unit-free 3-vector in the device frame (mirror of capture's `SweepVec3`). */
export interface SweepInputVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Per-frame EXIF record as the capture entry normalizes it (mirror of
 * capture's `SweepPhotoExif`; every field nullable). `focalPx` is the
 * per-frame pixel focal-length PRIOR (35 mm equivalence, ≈ ±5 %) — a
 * stitch-estimated focal (`StitchCamera.focal`) supersedes it for frames
 * that were stitched.
 */
export interface SweepInputPhotoExif {
  focalLengthMm: number | null;
  focalLength35mm: number | null;
  focalPx: number | null;
  focalPxSource: "exif35" | null;
  lensModel: string | null;
  make: string | null;
  model: string | null;
  iso: number | null;
  exposureTimeS: number | null;
  fNumber: number | null;
  digitalZoomRatio: number | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  dateTimeOriginal: string | null;
  subsecTimeOriginal: string | null;
  /** Raw dictionary (minus maker blobs) when captured with `exif: "full"`. */
  raw?: Record<string, unknown>;
}

/**
 * Photo shape `stitchSweep` accepts. Only `uri` and `yawDeg` are required
 * (what the stitch itself needs); the optional fields mirror the capture
 * entry's `SweepPhoto` record one-to-one so a captured sweep can be passed
 * straight through — and everything present is carried into the
 * {@link SweepManifest} (`photos[]`) verbatim, so downstream pipelines
 * (per-frame pose priors, intrinsics, shutter-latency bracketing) get the
 * capture record next to the stitch result.
 */
export interface SweepInputPhoto {
  /**
   * Image file URI or bare path. `file://` URIs (what expo-camera returns)
   * are normalized to bare paths before the native call — see
   * {@link normalizeImagePath}.
   */
  uri: string;
  /** Integrated yaw (degrees) at capture time — signed, monotonic along the sweep. */
  yawDeg: number;
  /** Upright pixel width of the frame (capture reports it upright on both platforms). */
  width?: number;
  /** Upright pixel height of the frame. */
  height?: number;
  /** Pitch delta vs the settle baseline at trigger, degrees (signed). */
  tiltDeg?: number;
  /** Roll delta vs the settle baseline at trigger, degrees (signed). */
  rollDeg?: number;
  /** True angular deviation of gravity from the settle baseline at trigger (the capture gate value). */
  tiltMagDeg?: number;
  /** Smoothed yaw rate at trigger, deg/s (the hold-still gate value). */
  rateDegS?: number;
  /** Normalized gravity direction at trigger, device frame. */
  gravity?: SweepInputVec3;
  /** Sensor-clock timestamp of the trigger sample, seconds. */
  sensorTs?: number;
  /** `Date.now()` immediately before the shutter call. */
  triggeredAt?: number;
  /** `Date.now()` when the shutter call resolved. */
  resolvedAt?: number;
  /** Integrated yaw when the picture resolved — with `yawDeg` brackets the shutter latency. */
  yawDegAtResolve?: number;
  /** EXIF `Orientation` (1–8) of the delivered file, `null` when EXIF was off or absent. */
  exifOrientation?: number | null;
  /** Normalized EXIF record, `null` when off, unavailable or rejected. */
  exif?: SweepInputPhotoExif | null;
}

/** Why a sweep ended (mirror of capture's `SweepEndReason`). */
export type SweepInputEndReason = "finish" | "maxShots" | "background";

/**
 * Snapshot of the capture configuration (mirror of capture's
 * `GuidedSweepConfig`, every field optional).
 */
export interface SweepCaptureConfigInput {
  stepDeg?: number;
  tolDeg?: number;
  overshootDeg?: number;
  maxRateDegS?: number;
  tiltWarnDeg?: number;
  tiltBlockDeg?: number;
  maxShots?: number;
  settleSamples?: number;
  dirLockDeg?: number;
  dirLockMs?: number;
  sensorIntervalMs?: number;
  photoQuality?: number;
  haptics?: boolean;
  exif?: boolean | "full";
}

/**
 * Sweep-level capture record accepted by `stitchSweep({ meta })` and stored
 * as `manifest.sweep` — a structural mirror of the capture entry's
 * `SweepCaptureMeta` with every field optional except `id` / `startedAt`,
 * so the `meta` the capture hook / `onComplete` hands you is assignable
 * as-is.
 */
export interface SweepCaptureMetaInput {
  /** Random id of the sweep. */
  id: string;
  platform?: "ios" | "android" | "web" | "other";
  /** `Date.now()` at the start of the sweep. */
  startedAt: number;
  finishedAt?: number | null;
  endedBy?: SweepInputEndReason | null;
  /** Snapshot of the resolved capture options. */
  config?: SweepCaptureConfigInput;
  /** Level reference `g0` (normalized gravity over the settle window), device frame. */
  gravityRef?: SweepInputVec3 | null;
  /** Locked sweep direction, `0` if never locked. */
  direction?: 1 | -1 | 0;
  relatched?: boolean;
  camera?: {
    facing?: string;
    zoom?: number;
    photoQuality?: number;
    exifRequested?: boolean;
  };
}

/** Warp modes `stitchSweep` accepts — `plane` is rejected (see `stitchSweep`). */
export type SweepWarpMode = "spherical" | "cylindrical";

export interface StitchSweepOptions extends Omit<StitchOptions, "warpMode"> {
  /**
   * Default: `cylindrical` (not `spherical` — long single chains have been
   * observed to diverge in spherical bundle adjustment). `plane` is rejected
   * with an error: an affine/plane projection cannot cover a rotational sweep
   * beyond ~120° FOV (it remains available via `stitchImagePaths` for
   * diagnostics).
   */
  warpMode?: SweepWarpMode;
  /**
   * Sweep-level capture record (the `meta` from the capture entry is
   * assignable). Stored verbatim as `manifest.sweep`; never sent to native.
   */
  meta?: SweepCaptureMetaInput;
  /**
   * Best-effort JSON sidecar of the {@link SweepManifest}, written with
   * `expo-file-system` next to the primary panorama (`<pano>.json`) —
   * or at `path` when given (bare path or `file://` URI; the parent
   * directory must exist). `false` skips the write. A failed write (module
   * missing, I/O error) NEVER rejects: `sidecarPath` is `null` and
   * `sidecarError` says why, while `manifest` is still returned in memory.
   * Default: `true`.
   */
  sidecar?: boolean | { path?: string };
}

/** One stitched strip returned by `stitchSweep` (primary panorama or a salvaged arc). */
export interface SweepStrip {
  /** Absolute filesystem path to this strip's JPEG (no `file://` scheme). */
  path: string;
  width: number;
  height: number;
  /**
   * Original `photos[]` indices composited into this strip, ascending and
   * deduplicated (wrap-closure duplicates are mapped back to their source
   * photo).
   */
  usedIndices: number[];
  /**
   * This strip's warp geometry with every camera tagged by its canonical
   * `photoIndex` (wrap-closure duplicates map back to their source photo,
   * salvage-strip cameras to the dropped photo they came from), or `null`
   * when native could not recover it.
   */
  geometry: SweepStripGeometry | null;
  /** Azimuth coverage derived from `geometry` (`coverageFromGeometry`), or `null`. */
  coverage: SweepCoverage | null;
}

/** A {@link StitchCamera} tagged with the canonical `photos[]` index it came from. */
export interface SweepStripCamera extends StitchCamera {
  /**
   * Index into the `photos` passed to `stitchSweep`. A wrap-closed primary
   * strip can contain the same `photoIndex` twice (source + re-appended
   * duplicate — `inputIndex` tells them apart).
   */
  photoIndex: number;
}

/** {@link StitchGeometry} whose cameras carry `photoIndex`. */
export interface SweepStripGeometry extends Omit<StitchGeometry, "cameras"> {
  cameras: SweepStripCamera[];
}

/** One re-appended photo and where the stitch put its two copies. */
export interface SweepWrapClosurePair {
  photoIndex: number;
  /** Pano azimuth (degrees) of the photo's original copy. */
  azimuthDeg: number;
  /** Pano azimuth (degrees) of the re-appended duplicate. */
  duplicateAzimuthDeg: number;
}

/**
 * Measured loop closure of a wrap-closed sweep. Under OpenCV's rotation
 * model the re-appended duplicates should land exactly on their sources;
 * `closureErrorDeg` is the mean absolute circular difference between each
 * duplicate's azimuth and its source's — the accumulated drift around the
 * loop the bundle adjustment could not absorb.
 */
export interface SweepWrapClosure {
  closureErrorDeg: number;
  pairs: SweepWrapClosurePair[];
}

/** A yaw range (degrees, from `photos[].yawDeg`) not covered by any returned strip. */
export interface SweepGap {
  fromDeg: number;
  toDeg: number;
}

/**
 * Result of `stitchSweep`. The top-level `path`/`width`/`height`/
 * `usedIndices`/`usedCount` mirror `StitchResult` and describe the LARGEST
 * strip (always `strips[0]`); salvaged secondary arcs follow in `strips`.
 */
export interface StitchSweepResult {
  success: boolean;
  /** Largest strip's JPEG path (same as `strips[0].path`). */
  path: string;
  width: number;
  height: number;
  /** Width / height of the largest strip. */
  aspectRatio: number;
  /** Original photo indices in the largest strip (ascending, deduplicated). */
  usedIndices: number[];
  usedCount: number;
  /** All stitched strips, largest first (by number of photos used). */
  strips: SweepStrip[];
  /**
   * Yaw ranges covered by photos that ended up in NO strip — show the user
   * "re-sweep near X°". Empty when every photo was used somewhere.
   */
  gaps: SweepGap[];
  /**
   * True when wrap closure fired (total yaw span ≥ ~330°): the first two
   * photos were re-appended after the last so the matcher sees the chain's
   * own loop. Do NOT assume this duplicates the panorama's trailing edge:
   * under OpenCV's rotation model (`u = warpScale · atan2(x, z)`, bounded to
   * one turn) the duplicates land ON their sources rather than widening the
   * canvas, so there is normally nothing to crop. `wrapClosure` reports the
   * measured closure error instead (and `geometry`/`coverage` where the
   * canvas actually ends).
   */
  wrapClosed: boolean;
  /**
   * Measured loop closure — present only when `wrapClosed`, the primary
   * geometry is available, and at least one re-appended duplicate AND its
   * source photo were both composited. `null` otherwise.
   */
  wrapClosure: SweepWrapClosure | null;
  /** The largest strip's geometry (same as `strips[0].geometry`). */
  geometry: SweepStripGeometry | null;
  /** The warp mode that actually produced the primary strip. */
  warpModeUsed: SweepWarpMode;
  /** True when a failed `spherical` stitch fell back to `cylindrical` (happens at most once). */
  fellBackToCylindrical: boolean;
  /**
   * Gyro yaw span of the sweep in degrees: `max(yawDeg) - min(yawDeg)` over
   * `photos`. This is the *sensor* span (relative, before any stitch), the
   * same value that gates wrap closure. Useful to label a partial sweep's
   * field of view; it does not include the last photo's own horizontal FOV.
   */
  yawSpanDeg: number;
  /**
   * The sweep manifest (capture record + every input photo + the stitch
   * result and the exact options sent to native) — always present in
   * memory, whether or not the sidecar was written. See {@link SweepManifest}.
   */
  manifest: SweepManifest;
  /** Where the manifest sidecar was written (bare path or the `sidecar.path` you gave), or `null`. */
  sidecarPath: string | null;
  /** Why the sidecar was not written (`expo-file-system` missing, I/O error…), or `null` on success / `sidecar: false`. */
  sidecarError: string | null;
  errorMessage: string;
}

// ---------------------------------------------------------------------------
// Sweep manifest (pure TS — `buildSweepManifest`; written as a JSON sidecar
// next to the panorama by `stitchSweep` unless `sidecar: false`).
// ---------------------------------------------------------------------------

/** One input photo as recorded in the manifest. */
export interface SweepManifestPhoto extends SweepInputPhoto {
  /** Index into the `photos` array passed to `stitchSweep` (= the canonical photo index everywhere else). */
  index: number;
  /** `uri` normalized to the bare filesystem path native read (`normalizeImagePath`). */
  path: string;
}

/**
 * The stitch half of a {@link SweepManifest}: the `stitchSweep` result
 * fields that describe the output, plus the fully-resolved options that
 * were actually sent to native for the primary stitch.
 */
export interface SweepManifestStitch {
  /** Largest strip's JPEG path (bare path). */
  path: string;
  width: number;
  height: number;
  aspectRatio: number;
  usedIndices: number[];
  usedCount: number;
  /** Every strip (path, size, canonical `usedIndices`, tagged `geometry`, `coverage`), largest first. */
  strips: SweepStrip[];
  gaps: SweepGap[];
  wrapClosed: boolean;
  wrapClosure: SweepWrapClosure | null;
  warpModeUsed: SweepWarpMode;
  fellBackToCylindrical: boolean;
  yawSpanDeg: number;
  /** The resolved `StitchOptions` sent to native for the primary strip (DEFAULTS merged; `warpMode` = `warpModeUsed`). */
  options: Required<StitchOptions>;
}

/**
 * Everything a downstream pipeline needs to interpret a stitched sweep
 * without the app: the capture record, the per-photo records (sensor tick,
 * timing, EXIF/focal prior) and the stitch result with its geometry and
 * the exact options used. Plain JSON-serializable data.
 *
 * Note the panorama, the photos and the sidecar all live in temp/cache
 * directories the OS may purge — copy what you want to keep into a
 * document directory.
 */
export interface SweepManifest {
  schemaVersion: 1;
  generator: "@notchip/expo-panoramic-stitcher";
  /** ISO-8601 timestamp of when the manifest was built. */
  createdAt: string;
  /** `meta.platform` when given (the capture entry's `meta` always carries it), else `"unknown"`. */
  platform: "ios" | "android" | "web" | "other" | "unknown";
  /** The capture record passed as `meta`, or `null`. */
  sweep: SweepCaptureMetaInput | null;
  /** The canonical `photos` (never the wrap-extended input), each with `index` + normalized `path` and every field the caller passed. */
  photos: SweepManifestPhoto[];
  stitch: SweepManifestStitch;
}

export type ExpoPanoramicStitcherModuleEvents = {
  /**
   * Coarse stage progress emitted during stitches.
   * Stages: `decoding` (0.1) → `stitching` (0.3) → `encoding` (0.85) → `done` (1.0).
   * `stitchImagePaths` emits only `stitching` and `done`; the incremental
   * first-frame pass-through emits nothing.
   */
  onStitchProgress: (params: { progress: number; stage: string }) => void;
};
