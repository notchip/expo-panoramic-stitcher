import type {
  StitchBase64Result,
  StitchOptions,
  StitchResult,
} from "./ExpoPanoramicStitcher.types";
import ExpoPanoramicStitcher from "./ExpoPanoramicStitcherModule";

export * from "./ExpoPanoramicStitcher.types";
export { default } from "./ExpoPanoramicStitcherModule";

const DEFAULTS: Required<StitchOptions> = {
  warpMode: "spherical",
  blendStrength: 5,
  matchConf: 0.3,
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
