import { registerWebModule, NativeModule } from "expo";

import type {
  ExpoPanoramicStitcherModuleEvents,
  StitchBase64Result,
  StitchResult,
} from "./ExpoPanoramicStitcher.types";

const UNSUPPORTED = "Panorama stitching is not available on web.";

class ExpoPanoramicStitcherModule extends NativeModule<ExpoPanoramicStitcherModuleEvents> {
  isAvailable(): boolean {
    return false;
  }
  helloFromNative(name: string): string {
    return `Hello ${name} (web stub)`;
  }
  async stitchImagePaths(): Promise<StitchResult> {
    return {
      success: false,
      path: "",
      width: 0,
      height: 0,
      aspectRatio: 0,
      errorMessage: UNSUPPORTED,
    };
  }
  async stitchBase64(): Promise<StitchBase64Result> {
    return {
      success: false,
      base64Image: "",
      width: 0,
      height: 0,
      errorMessage: UNSUPPORTED,
    };
  }
  async stitchIncrementalBase64(): Promise<StitchBase64Result> {
    return {
      success: false,
      base64Image: "",
      width: 0,
      height: 0,
      errorMessage: UNSUPPORTED,
    };
  }
}

export default registerWebModule(
  ExpoPanoramicStitcherModule,
  "ExpoPanoramicStitcher",
);
