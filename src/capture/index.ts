/**
 * `@notchip/expo-panoramic-stitcher/capture` — guided-sweep capture UI.
 *
 * Separate subpath entry so the core stitcher stays dependency-lean:
 * this entry (and only this entry) needs the `expo-camera` and
 * `expo-sensors` peers, plus optionally `expo-haptics` and
 * `react-native-safe-area-context`. The core `index.ts` must never
 * import from here.
 */
export { GuidedSweepCapture } from "./GuidedSweepCapture";
export { GUIDED_SWEEP_DEFAULTS, useGuidedSweep } from "./useGuidedSweep";
export * from "./GuidedSweep.types";
