import { NativeModule, requireNativeModule } from "expo";

import type {
  ExpoPanoramicStitcherModuleEvents,
  NativeStitchBase64Result,
  NativeStitchResult,
  StitchOptions,
} from "./ExpoPanoramicStitcher.types";

/**
 * Raw native surface. Results carry the stitch geometry as the compact JSON
 * string native produced (`geometryJson`, `""` when unavailable); the public
 * wrappers in `index.ts` parse it into `geometry: StitchGeometry | null`.
 * Options arrive fully defaulted (the wrappers merge `DEFAULTS`).
 */
declare class ExpoPanoramicStitcherModule extends NativeModule<ExpoPanoramicStitcherModuleEvents> {
  /** True if OpenCV loaded and stitching is usable on this device. */
  isAvailable(): boolean;
  /** Smoke-test the native bridge. */
  helloFromNative(name: string): string;

  /** Stitch image files -> writes a JPEG, resolves the file path + dims + geometryJson. */
  stitchImagePaths(
    imagePaths: string[],
    options: StitchOptions,
  ): Promise<NativeStitchResult>;
  /** Stitch base64 JPEGs -> resolves a base64 JPEG (same payload both platforms). */
  stitchBase64(
    images: string[],
    options: StitchOptions,
  ): Promise<NativeStitchBase64Result>;
  /**
   * Add one base64 image onto an existing base64 panorama. Pass null/'' to
   * start — that first call passes the image through as the seed panorama
   * (with `geometryJson: ""`).
   */
  stitchIncrementalBase64(
    existingPanorama: string | null,
    newImage: string,
    options: StitchOptions,
  ): Promise<NativeStitchBase64Result>;
}

export default requireNativeModule<ExpoPanoramicStitcherModule>(
  "ExpoPanoramicStitcher",
);
