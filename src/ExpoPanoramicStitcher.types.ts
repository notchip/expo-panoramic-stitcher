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
  /** Human-readable error (empty on success; only the web stub populates it). */
  errorMessage: string;
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
  errorMessage: string;
}

/**
 * Minimal photo shape `stitchSweep` needs. The capture entry's `SweepPhoto`
 * (`@notchip/expo-panoramic-stitcher/capture`) is structurally assignable —
 * the type is duplicated here because the core entry must not import from
 * the capture entry.
 */
export interface SweepInputPhoto {
  /** Image file URI/path (anything `stitchImagePaths` accepts). */
  uri: string;
  /** Integrated yaw (degrees) at capture time — signed, monotonic along the sweep. */
  yawDeg: number;
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
   * photos were re-appended after the last so OpenCV could close the circular
   * chain, and the panorama's TRAILING edge therefore duplicates its start —
   * callers may crop.
   */
  wrapClosed: boolean;
  /** The warp mode that actually produced the primary strip. */
  warpModeUsed: SweepWarpMode;
  /** True when a failed `spherical` stitch fell back to `cylindrical` (happens at most once). */
  fellBackToCylindrical: boolean;
  errorMessage: string;
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
