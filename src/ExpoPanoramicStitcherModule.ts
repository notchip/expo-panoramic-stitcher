import { NativeModule, requireNativeModule } from "expo";

import type {
  ExpoPanoramicStitcherModuleEvents,
  StitchBase64Result,
  StitchOptions,
  StitchResult,
} from "./ExpoPanoramicStitcher.types";

declare class ExpoPanoramicStitcherModule extends NativeModule<ExpoPanoramicStitcherModuleEvents> {
  /** True if OpenCV loaded and stitching is usable on this device. */
  isAvailable(): boolean;
  /** Smoke-test the native bridge. */
  helloFromNative(name: string): string;

  /** Stitch image files -> writes a JPEG, resolves the file path + dims. */
  stitchImagePaths(
    imagePaths: string[],
    options: StitchOptions,
  ): Promise<StitchResult>;
  /** Stitch base64 JPEGs -> resolves a base64 JPEG (same payload both platforms). */
  stitchBase64(
    images: string[],
    options: StitchOptions,
  ): Promise<StitchBase64Result>;
  /**
   * Add one base64 image onto an existing base64 panorama. Pass null/'' to
   * start — that first call passes the image through as the seed panorama.
   */
  stitchIncrementalBase64(
    existingPanorama: string | null,
    newImage: string,
    options: StitchOptions,
  ): Promise<StitchBase64Result>;
}

export default requireNativeModule<ExpoPanoramicStitcherModule>(
  "ExpoPanoramicStitcher",
);
