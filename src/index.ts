import type {
  NativeStitchBase64Result,
  NativeStitchResult,
  StitchBase64Result,
  StitchGeometry,
  StitchOptions,
  StitchResult,
  StitchSweepOptions,
  StitchSweepResult,
  SweepCaptureMetaInput,
  SweepGap,
  SweepInputPhoto,
  SweepManifest,
  SweepManifestPhoto,
  SweepManifestStitch,
  SweepStrip,
  SweepStripCamera,
  SweepStripGeometry,
  SweepWarpMode,
  SweepWrapClosure,
  SweepWrapClosurePair,
} from "./ExpoPanoramicStitcher.types";
import ExpoPanoramicStitcher from "./ExpoPanoramicStitcherModule";
import {
  cameraAngles,
  coverageFromGeometry,
  parseGeometry,
  wrapDeg,
} from "./geometry";
import { writeTextFile } from "./optionalFileSystem";

export * from "./ExpoPanoramicStitcher.types";
export * from "./geometry";
export { toFileUri } from "./optionalFileSystem";
/**
 * The raw native module. Unlike the wrappers below it takes fully-specified
 * options and resolves `NativeStitchResult` / `NativeStitchBase64Result`,
 * i.e. with the geometry still as the `geometryJson` string (parse it with
 * `parseGeometry`).
 */
export { default } from "./ExpoPanoramicStitcherModule";

const DEFAULTS: Required<StitchOptions> = {
  warpMode: "spherical",
  blendStrength: 5,
  matchConf: 0.3,
  panoConfidence: 1.0,
  matchNeighbors: 0,
  matchWrap: false,
  outputWidth: 4096,
  autoResize: true,
  jpegQuality: 95,
};

/** Native → public result: `geometryJson` string → parsed `geometry` (null when empty/invalid). */
function toStitchResult(raw: NativeStitchResult): StitchResult {
  const { geometryJson, ...rest } = raw;
  return { ...rest, geometry: parseGeometry(geometryJson) };
}

function toStitchBase64Result(
  raw: NativeStitchBase64Result,
): StitchBase64Result {
  const { geometryJson, ...rest } = raw;
  return { ...rest, geometry: parseGeometry(geometryJson) };
}

/** True if OpenCV is loaded and stitching can run on this device. */
export function isStitchingAvailable(): boolean {
  try {
    return ExpoPanoramicStitcher.isAvailable();
  } catch {
    return false;
  }
}

/** Verify the native bridge end-to-end. */
export function helloFromNative(name: string): string {
  return ExpoPanoramicStitcher.helloFromNative(name);
}

/**
 * Normalize an image location to the bare filesystem path native expects.
 * `file://` URIs (what expo-camera's `takePictureAsync` returns on both
 * platforms) are stripped and percent-decoded; anything else is returned
 * untouched. Native reads with `cv::imread`, which cannot open URL-scheme
 * strings — the wrappers below apply this automatically.
 */
export function normalizeImagePath(uri: string): string {
  const m = /^file:\/\/(localhost)?(\/.*)$/i.exec(uri);
  if (!m) return uri;
  const path = m[2]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // malformed percent-encoding: pass the raw path through
  }
}

/**
 * Stitch image files into a panorama, written to a JPEG on disk.
 * Lowest memory path — prefer this for large / many images.
 * Accepts bare paths or `file://` URIs (see {@link normalizeImagePath}).
 * Failures reject the returned promise (including validation errors).
 */
export async function stitchImagePaths(
  imagePaths: string[],
  options?: StitchOptions,
): Promise<StitchResult> {
  if (!imagePaths || imagePaths.length < 2) {
    throw new Error("At least 2 images are required for stitching");
  }
  const raw = await ExpoPanoramicStitcher.stitchImagePaths(
    imagePaths.map(normalizeImagePath),
    {
      ...DEFAULTS,
      ...options,
    },
  );
  return toStitchResult(raw);
}

/**
 * Stitch base64 JPEGs into a base64 JPEG panorama.
 * Returns the same payload shape on iOS and Android.
 * Failures reject the returned promise (including validation errors).
 */
export async function stitchBase64(
  images: string[],
  options?: StitchOptions,
): Promise<StitchBase64Result> {
  if (!images || images.length < 2) {
    throw new Error("At least 2 images are required for stitching");
  }
  const raw = await ExpoPanoramicStitcher.stitchBase64(images, {
    ...DEFAULTS,
    ...options,
  });
  return toStitchBase64Result(raw);
}

// Wrap closure fires when the sweep's total yaw span reaches this. Field
// result that motivates it (24-shot 360° sweep): cylindrical stitched 17/24
// as [2–18] while a diagnostic plane run independently used [19–23,0–10] —
// contiguous ACROSS the wrap, proving shot 23 matches shot 0. The pairwise
// matcher connects everything; it is the high-level Stitcher that picks one
// maximal arc and discards the rest, because it has no concept of a circular
// chain. Re-appending the first two photos lets the chain see its own loop.
const WRAP_MIN_SPAN_DEG = 330;

/**
 * Sweep-aware orchestration over `stitchImagePaths` (plain TS — no native
 * changes). Compared to a raw stitch it:
 *
 *  1. **Closes the wrap:** when the yaw span is ≥ ~330°, the first two photos
 *     are re-appended after the last so the matcher sees the chain's own
 *     loop, and `matchWrap` defaults to true so the ends are matched
 *     explicitly. `wrapClosed: true` does NOT mean the trailing edge
 *     duplicates the start — under OpenCV's rotation model the duplicates
 *     land on their sources; `wrapClosure` reports the measured closure
 *     error instead.
 *  2. **Salvages dropped arcs:** if the primary stitch used only a subset,
 *     the dropped complement is re-stitched once (same options, order
 *     preserved) and every successful strip is returned in `strips`,
 *     largest first. A failed complement is not an error.
 *  3. **Reports gaps:** `gaps` lists the yaw ranges of photos no strip used,
 *     so the caller can show "re-sweep near 280°".
 *  4. **Tags geometry:** each strip's `geometry` carries the canonical
 *     `photoIndex` per camera and a `coverage` (azimuth union on the circle)
 *     so consumers can turn pixels into angles (see `geometry.ts`).
 *  5. **Writes a manifest:** `manifest` (always, in memory) bundles the
 *     capture `meta`, every input photo with all the fields you passed, and
 *     the stitch result + the exact options sent to native; unless
 *     `sidecar: false` it is also written best-effort as `<pano>.json` next
 *     to the primary strip via `expo-file-system` (`sidecarPath` /
 *     `sidecarError` — a failed write never rejects).
 *
 * `matchNeighbors` passes through unchanged (0 = all pairs); `matchWrap`
 * defaults to `wrapClosed` unless given explicitly. `meta` and `sidecar`
 * are consumed here and never reach native.
 *
 * Defaults differ from `stitchImagePaths`: `warpMode: 'cylindrical'`,
 * `panoConfidence: 0.7` and `autoResize: false` — a sweep is NEVER stretched
 * to 2:1 by default (a 120° strip forced into an equirectangular frame is
 * geometrically meaningless; the strip keeps its natural aspect and is only
 * downscaled to `outputWidth`). `warpMode: 'plane'` is rejected (an affine/plane
 * projection cannot cover a rotational sweep beyond ~120° FOV — it stays
 * available through `stitchImagePaths` for diagnostics). A failed
 * `spherical` stitch falls back to `cylindrical` exactly once
 * (`fellBackToCylindrical`), never more.
 */
export async function stitchSweep(
  photos: SweepInputPhoto[],
  options?: StitchSweepOptions,
): Promise<StitchSweepResult> {
  if (!photos || photos.length < 2) {
    throw new Error("At least 2 images are required for stitching");
  }
  const warpMode: SweepWarpMode = options?.warpMode ?? "cylindrical";
  if ((warpMode as string) === "plane") {
    throw new Error(
      "stitchSweep does not support warpMode 'plane': an affine/plane projection " +
        "cannot cover a rotational sweep beyond ~120° of FOV. Use 'cylindrical' " +
        "(default) or 'spherical'; 'plane' remains available via stitchImagePaths " +
        "for diagnostics.",
    );
  }
  // `meta` / `sidecar` are orchestration inputs — keep them out of the
  // options object that is forwarded to native.
  const { meta, sidecar, ...stitchOnlyOptions } = options ?? {};
  const sweepOptions: StitchOptions = {
    panoConfidence: 0.7,
    autoResize: false, // never stretch a sweep to 2:1 (see doc comment)
    ...stitchOnlyOptions,
    warpMode,
  };

  const n = photos.length;
  const yaws = photos.map((p) => p.yawDeg);
  const span = Math.max(...yaws) - Math.min(...yaws);
  const wrapClosed = n >= 3 && span >= WRAP_MIN_SPAN_DEG;
  // The explicit end-to-end match pair is the principled loop closure for a
  // full turn; only meaningful when neighbour-only matching is on.
  sweepOptions.matchWrap = options?.matchWrap ?? wrapClosed;

  const inputPaths = photos.map((p) => p.uri);
  if (wrapClosed) {
    inputPaths.push(photos[0]!.uri, photos[1]!.uri);
  }
  // Map an index in the (possibly wrap-extended) input back to its photo.
  const toCanonical = (i: number) => (i >= n ? i - n : i);

  let warpModeUsed = warpMode;
  let fellBackToCylindrical = false;
  let primary: StitchResult;
  try {
    primary = await stitchImagePaths(inputPaths, sweepOptions);
  } catch (e) {
    if (warpMode !== "spherical") throw e;
    // Long single chains can diverge in spherical bundle adjustment
    // (observed in the field). One fallback, then done — never retry again.
    warpModeUsed = "cylindrical";
    fellBackToCylindrical = true;
    primary = await stitchImagePaths(inputPaths, {
      ...sweepOptions,
      warpMode: "cylindrical",
    });
  }

  const primaryUsed = [...new Set(primary.usedIndices.map(toCanonical))].sort(
    (a, b) => a - b,
  );
  const usedAnywhere = new Set(primaryUsed);
  const primaryGeometry = tagGeometry(primary.geometry, toCanonical);
  const strips: SweepStrip[] = [
    {
      path: primary.path,
      width: primary.width,
      height: primary.height,
      usedIndices: primaryUsed,
      geometry: primaryGeometry,
      coverage: primaryGeometry ? coverageFromGeometry(primaryGeometry) : null,
    },
  ];

  // Arc salvage: one re-stitch of the dropped complement. (OpenCV keeps only
  // the largest connected component per stitch, so the complement can itself
  // be a valid strip — see the field result above.)
  const dropped: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!usedAnywhere.has(i)) dropped.push(i);
  }
  if (dropped.length >= 2) {
    try {
      const salvage = await stitchImagePaths(
        dropped.map((i) => photos[i]!.uri),
        { ...sweepOptions, warpMode: warpModeUsed },
      );
      const salvageUsed = salvage.usedIndices
        .map((k) => dropped[k]!)
        .sort((a, b) => a - b);
      for (const i of salvageUsed) usedAnywhere.add(i);
      const salvageGeometry = tagGeometry(salvage.geometry, (k) => dropped[k]);
      strips.push({
        path: salvage.path,
        width: salvage.width,
        height: salvage.height,
        usedIndices: salvageUsed,
        geometry: salvageGeometry,
        coverage: salvageGeometry
          ? coverageFromGeometry(salvageGeometry)
          : null,
      });
    } catch {
      // One failed complement is not an error — return what succeeded.
    }
  }
  // Largest first. The primary strip is always the largest (OpenCV already
  // kept the biggest component of the full input), so this is stable.
  strips.sort((a, b) => b.usedIndices.length - a.usedIndices.length);

  // Gap feedback: contiguous runs of photos no strip used → yaw ranges.
  const gaps: SweepGap[] = [];
  let run: number[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const ys = run.map((i) => photos[i]!.yawDeg);
    gaps.push({ fromDeg: Math.min(...ys), toDeg: Math.max(...ys) });
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (usedAnywhere.has(i)) flushRun();
    else run.push(i);
  }
  flushRun();

  const main = strips[0]!;
  const stitch: SweepManifestStitch = {
    path: main.path,
    width: main.width,
    height: main.height,
    aspectRatio: main.height > 0 ? main.width / main.height : 0,
    usedIndices: main.usedIndices,
    usedCount: main.usedIndices.length,
    strips,
    gaps,
    wrapClosed,
    wrapClosure: wrapClosed ? measureWrapClosure(primaryGeometry, n) : null,
    warpModeUsed,
    fellBackToCylindrical,
    yawSpanDeg: span,
    // Exactly what stitchImagePaths sent to native for the (successful)
    // primary stitch: DEFAULTS merged, warpMode = the mode that produced it.
    options: { ...DEFAULTS, ...sweepOptions, warpMode: warpModeUsed },
  };
  const manifest = buildSweepManifest(photos, stitch, meta);

  // Best-effort sidecar. Any failure — expo-file-system absent, the write
  // throwing — degrades to sidecarPath: null + sidecarError; never rejects
  // and never touches `success` (the panorama itself is fine).
  let sidecarPath: string | null = null;
  let sidecarError: string | null = null;
  if (sidecar !== false) {
    const target =
      (typeof sidecar === "object" && sidecar.path) ||
      replaceExtension(main.path, ".json");
    try {
      writeTextFile(target, JSON.stringify(manifest, null, 2));
      sidecarPath = target;
    } catch (e) {
      sidecarError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    success: primary.success,
    ...stitch,
    geometry: main.geometry,
    manifest,
    sidecarPath,
    sidecarError,
    errorMessage: primary.errorMessage,
  };
}

/** `/a/b/pano.jpg` → `/a/b/pano.json`; a path without an extension just gets one. */
function replaceExtension(path: string, ext: string): string {
  return path.replace(/\.[^./\\]*$/, "") + ext;
}

/**
 * Build the {@link SweepManifest} for a sweep — pure, no I/O. `stitchSweep`
 * calls this for you (`result.manifest`); use it directly to re-create a
 * manifest from a saved result, e.g. `buildSweepManifest(photos, { ...res,
 * options }, meta)`.
 *
 * `photos` are the canonical input photos (never the wrap-extended list);
 * each entry keeps every field the caller passed (the capture record's
 * sensor tick, timing and EXIF travel through verbatim) plus `index` and
 * the normalized `path`. `platform` is `meta.platform` when given, else
 * `"unknown"` — the core entry deliberately imports nothing from
 * `react-native` (it would drag the RN runtime into every consumer's jest
 * suite); the capture entry's `meta` always carries the platform.
 */
export function buildSweepManifest(
  photos: SweepInputPhoto[],
  stitch: SweepManifestStitch,
  meta?: SweepCaptureMetaInput | null,
): SweepManifest {
  const manifestPhotos: SweepManifestPhoto[] = photos.map((photo, index) => ({
    ...photo,
    index,
    uri: photo.uri,
    path: normalizeImagePath(photo.uri),
  }));
  return {
    schemaVersion: 1,
    generator: "@notchip/expo-panoramic-stitcher",
    createdAt: new Date().toISOString(),
    platform: meta?.platform ?? "unknown",
    sweep: meta ?? null,
    photos: manifestPhotos,
    stitch,
  };
}

/**
 * Tag every camera of a strip's geometry with its canonical photo index.
 * Cameras whose input index has no photo (should not happen) are dropped.
 */
function tagGeometry(
  geometry: StitchGeometry | null,
  toPhotoIndex: (inputIndex: number) => number | undefined,
): SweepStripGeometry | null {
  if (!geometry) return null;
  const cameras: SweepStripCamera[] = [];
  for (const cam of geometry.cameras) {
    const photoIndex = toPhotoIndex(cam.inputIndex);
    if (photoIndex === undefined) continue;
    cameras.push({ ...cam, photoIndex });
  }
  return { ...geometry, cameras };
}

/**
 * Closure error of a wrap-closed primary stitch: for every re-appended
 * duplicate (`inputIndex >= n`) whose source photo was also composited,
 * compare the two cameras' azimuths. Mean absolute circular difference.
 */
function measureWrapClosure(
  geometry: SweepStripGeometry | null,
  n: number,
): SweepWrapClosure | null {
  if (!geometry) return null;
  const byInput = new Map<number, SweepStripCamera>();
  for (const cam of geometry.cameras) {
    if (cam.inputIndex < n) byInput.set(cam.inputIndex, cam);
  }
  const pairs: SweepWrapClosurePair[] = [];
  for (const dup of geometry.cameras) {
    if (dup.inputIndex < n) continue;
    const src = byInput.get(dup.inputIndex - n);
    if (!src) continue;
    pairs.push({
      photoIndex: dup.inputIndex - n,
      azimuthDeg: cameraAngles(src).yawDeg,
      duplicateAzimuthDeg: cameraAngles(dup).yawDeg,
    });
  }
  if (pairs.length === 0) return null;
  const closureErrorDeg =
    pairs.reduce(
      (sum, p) => sum + Math.abs(wrapDeg(p.duplicateAzimuthDeg - p.azimuthDeg)),
      0,
    ) / pairs.length;
  return { closureErrorDeg, pairs };
}

/**
 * Build a panorama one image at a time.
 * Pass `null` (or '') as `existingPanorama` for the first image — that call is a
 * pass-through that returns the image itself (with its dimensions) as the seed
 * panorama. Feed each result's `base64Image` back in as `existingPanorama`.
 */
export async function stitchIncrementalBase64(
  existingPanorama: string | null,
  newImage: string,
  options?: StitchOptions,
): Promise<StitchBase64Result> {
  const raw = await ExpoPanoramicStitcher.stitchIncrementalBase64(
    existingPanorama,
    newImage,
    {
      ...DEFAULTS,
      ...options,
    },
  );
  return toStitchBase64Result(raw);
}
