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
  /** Multiband blend strength 1-10. Higher = smoother seams, slower. Default: 5. */
  blendStrength?: number;
  /** Feature-match confidence 0.0-1.0. Lower = more lenient matching. Default: 0.3. */
  matchConf?: number;
  /** Output width in px. Height auto-derives (2:1 when `autoResize`). Default: 4096. */
  outputWidth?: number;
  /** Resize result to equirectangular 2:1 aspect ratio. Default: true. */
  autoResize?: boolean;
  /** JPEG quality 1-100 for base64 / file output. Default: 95. */
  jpegQuality?: number;
}

/** Result of a file-path based stitch. */
export interface StitchResult {
  success: boolean;
  /** Absolute path to the written panorama JPEG (empty on failure). */
  path: string;
  width: number;
  height: number;
  /** Width / height. ~2.0 for equirectangular. */
  aspectRatio: number;
  /** Human-readable error (empty on success). */
  errorMessage: string;
}

/**
 * Result of a base64 stitch. Identical shape on iOS and Android
 * (the legacy module returned different payloads per platform — fixed here).
 */
export interface StitchBase64Result {
  success: boolean;
  /** Base64-encoded JPEG (no data-URL prefix). Empty on failure. */
  base64Image: string;
  width: number;
  height: number;
  errorMessage: string;
}

export type ExpoPanoramicStitcherModuleEvents = {
  /** Coarse progress 0..1 emitted during long stitches. */
  onStitchProgress: (params: { progress: number; stage: string }) => void;
};
