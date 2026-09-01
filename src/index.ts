import type {
  StitchBase64Result,
  StitchOptions,
  StitchResult,
  StitchSweepOptions,
  StitchSweepResult,
  SweepGap,
  SweepInputPhoto,
  SweepStrip,
  SweepWarpMode,
} from "./ExpoPanoramicStitcher.types";
import ExpoPanoramicStitcher from "./ExpoPanoramicStitcherModule";

export * from "./ExpoPanoramicStitcher.types";
export { default } from "./ExpoPanoramicStitcherModule";

const DEFAULTS: Required<StitchOptions> = {
  warpMode: "spherical",
  blendStrength: 5,
  matchConf: 0.3,
  panoConfidence: 1.0,
  outputWidth: 4096,
  autoResize: true,
  jpegQuality: 95,
};

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
 * Stitch image files into a panorama, written to a JPEG on disk.
 * Lowest memory path — prefer this for large / many images.
 * Failures reject the returned promise (including validation errors).
 */
export async function stitchImagePaths(
  imagePaths: string[],
  options?: StitchOptions,
): Promise<StitchResult> {
  if (!imagePaths || imagePaths.length < 2) {
    throw new Error("At least 2 images are required for stitching");
  }
  return ExpoPanoramicStitcher.stitchImagePaths(imagePaths, {
    ...DEFAULTS,
    ...options,
  });
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
  return ExpoPanoramicStitcher.stitchBase64(images, {
    ...DEFAULTS,
    ...options,
  });
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
 *     are re-appended after the last so OpenCV can close the circular chain;
 *     `wrapClosed: true` on the result means the panorama's trailing edge
 *     duplicates its start (callers may crop).
 *  2. **Salvages dropped arcs:** if the primary stitch used only a subset,
 *     the dropped complement is re-stitched once (same options, order
 *     preserved) and every successful strip is returned in `strips`,
 *     largest first. A failed complement is not an error.
 *  3. **Reports gaps:** `gaps` lists the yaw ranges of photos no strip used,
 *     so the caller can show "re-sweep near 280°".
 *
 * Defaults differ from `stitchImagePaths`: `warpMode: 'cylindrical'` and
 * `panoConfidence: 0.7`. `warpMode: 'plane'` is rejected (an affine/plane
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
  const sweepOptions: StitchOptions = {
    panoConfidence: 0.7,
    ...options,
    warpMode,
  };

  const n = photos.length;
  const yaws = photos.map((p) => p.yawDeg);
  const span = Math.max(...yaws) - Math.min(...yaws);
  const wrapClosed = n >= 3 && span >= WRAP_MIN_SPAN_DEG;

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
  const strips: SweepStrip[] = [
    {
      path: primary.path,
      width: primary.width,
      height: primary.height,
      usedIndices: primaryUsed,
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
      strips.push({
        path: salvage.path,
        width: salvage.width,
        height: salvage.height,
        usedIndices: salvageUsed,
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
  return {
    success: primary.success,
    path: main.path,
    width: main.width,
    height: main.height,
    aspectRatio: main.height > 0 ? main.width / main.height : 0,
    usedIndices: main.usedIndices,
    usedCount: main.usedIndices.length,
    strips,
    gaps,
    wrapClosed,
    warpModeUsed,
    fellBackToCylindrical,
    errorMessage: primary.errorMessage,
  };
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
  return ExpoPanoramicStitcher.stitchIncrementalBase64(
    existingPanorama,
    newImage,
    {
      ...DEFAULTS,
      ...options,
    },
  );
}
