import type { CameraView } from "expo-camera";
import type { ReactNode, RefObject } from "react";

import type { SweepPhotoExif } from "./exifIntrinsics";

/** A unit-free 3-vector in the DEVICE frame (expo-sensors axes). */
export type SweepVec3 = { x: number; y: number; z: number };

/**
 * One auto-captured frame of a guided sweep.
 *
 * `uri`/`width`/`height`/`yawDeg` are what the stitcher needs (the shape is
 * structurally assignable to the core entry's `SweepInputPhoto`); the rest
 * is the sensor/timing/EXIF record of the trigger tick, for consumers that
 * interpret frames geometrically (per-frame pose priors, intrinsics,
 * shutter-latency bracketing). All angles are degrees.
 */
export type SweepPhoto = {
  /** File URI of the captured JPEG (from expo-camera). */
  uri: string;
  /**
   * UPRIGHT pixel width of the delivered frame on both platforms. On
   * Android with EXIF enabled expo-camera does not rotate the bitmap and
   * reports raw dims, so the hook swaps them when `exifOrientation` is 5–8
   * (iOS already reports orientation-aware dims). `cv::imread` honours the
   * file's EXIF orientation, so the stitcher sees the same upright frame.
   */
  width: number;
  /** UPRIGHT pixel height — see `width`. */
  height: number;
  /** Integrated yaw at the moment the shutter was triggered. */
  yawDeg: number;
  /** Pitch delta vs the settle baseline at trigger (signed; the HUD's `tiltDeg` on that tick). */
  tiltDeg: number;
  /** Roll delta vs the settle baseline at trigger (signed; the HUD's `rollDeg` on that tick). */
  rollDeg: number;
  /** True angular deviation of gravity from the settle baseline at trigger — the capture gate value. */
  tiltMagDeg: number;
  /** Smoothed yaw rate (deg/s, EMA) at trigger — the hold-still gate value. */
  rateDegS: number;
  /** Normalized gravity direction at trigger, device frame. */
  gravity: SweepVec3;
  /** Sensor-clock timestamp of the trigger sample (`rotationRate.timestamp`, seconds). */
  sensorTs: number;
  /** `Date.now()` immediately before `takePictureAsync` was called. */
  triggeredAt: number;
  /** `Date.now()` when `takePictureAsync` resolved. */
  resolvedAt: number;
  /**
   * Integrated yaw when the picture resolved. Together with `yawDeg` this
   * brackets the shutter latency: the true exposure yaw lies in between.
   */
  yawDegAtResolve: number;
  /** EXIF `Orientation` (1–8) of the delivered file, `null` when EXIF was off or absent. */
  exifOrientation: number | null;
  /** Normalized EXIF (see `GuidedSweepOptions.exif`), `null` when off, unavailable or rejected. */
  exif: SweepPhotoExif | null;
};

/** Why a sweep ended. */
export type SweepEndReason =
  /** `finish()` was called (the user pressed Finish). */
  | "finish"
  /** `maxShots` was reached and the hook auto-finished. */
  | "maxShots"
  /** The app left the foreground and the sweep was aborted (shots so far are kept). */
  | "background";

/**
 * Sweep-level capture record: identity, timing, the exact config and camera
 * settings in force, and the level/direction references the frames'
 * per-tick values are relative to. Built by `start()`, completed by
 * `finish()`; delivered as `meta` on the hook and as the second argument
 * of `GuidedSweepCapture`'s `onComplete`.
 */
export type SweepCaptureMeta = {
  /** Random id for this sweep (no external dependency; UUID where the runtime offers one). */
  id: string;
  platform: "ios" | "android" | "web" | "other";
  /** `Date.now()` at `start()`. */
  startedAt: number;
  /** `Date.now()` when the sweep ended, `null` while sweeping. */
  finishedAt: number | null;
  endedBy: SweepEndReason | null;
  /** Snapshot of the resolved options at `start()`. */
  config: GuidedSweepConfig;
  /**
   * The level reference `g0` — normalized gravity averaged over the settle
   * window, device frame. `null` until the settle window completed. Every
   * frame's `tiltDeg`/`rollDeg`/`tiltMagDeg` is relative to this.
   */
  gravityRef: SweepVec3 | null;
  /** Locked sweep direction at finish (sign of yaw along the sweep), `0` if never locked. */
  direction: 1 | -1 | 0;
  /** True when the direction lock re-latched once after a false start. */
  relatched: boolean;
  /** Camera settings in force for every frame of the sweep. */
  camera: {
    facing: "back";
    /** expo-camera `zoom` prop (0 = the `CameraView` default the built-in screen uses). */
    zoom: number;
    /** `quality` passed to `takePictureAsync`. */
    photoQuality: number;
    /** Whether EXIF was requested at `start()` (`GuidedSweepOptions.exif !== false`). */
    exifRequested: boolean;
  };
};

export type SweepPhase = "idle" | "sweeping" | "done";

/**
 * Guidance status for the user, as a machine-readable enum — consumers
 * map these to (localized) display strings, the package never renders
 * copy from the hook.
 *
 *  - `HOLD` covers both "hold still to arm" (the settle window before
 *    shot 0) and "hold, capturing" (inside a capture window) — the user
 *    action is the same.
 *  - `GO_BACK` covers both overshooting the next target and moving
 *    against the locked sweep direction — the user action is the same.
 */
export const SweepStatus = {
  START_TURNING: "START_TURNING",
  KEEP_TURNING: "KEEP_TURNING",
  SLOW_DOWN: "SLOW_DOWN",
  HOLD: "HOLD",
  LEVEL_THE_PHONE: "LEVEL_THE_PHONE",
  GO_BACK: "GO_BACK",
} as const;
export type SweepStatus = (typeof SweepStatus)[keyof typeof SweepStatus];

/**
 * Tuning knobs for the sweep state machine. Every default was tuned on
 * real devices — override with care.
 */
export type GuidedSweepOptions = {
  /**
   * Degrees of yaw between auto-captures. 15° is ~70% overlap at a
   * portrait phone's ~50° horizontal FOV. Default 15.
   */
  stepDeg?: number;
  /** The capture window starts this many degrees before a target. Default 2.5. */
  tolDeg?: number;
  /** Past target + this → the user is told to come back. Default 9. */
  overshootDeg?: number;
  /** Hold-still gate for capture, deg/s (motion-blur guard). Default 14. */
  maxRateDegS?: number;
  /** Tilt/roll beyond this turns the HUD level bar red (warning only). Default 5. */
  tiltWarnDeg?: number;
  /** Tilt beyond this blocks capture entirely. Default 10. */
  tiltBlockDeg?: number;
  /** Hard stop for a runaway sweep. 24 = 360° at 15°. Default 24. */
  maxShots?: number;
  /** Consecutive calm sensor samples before shot 0 arms (~330 ms at 33 ms). Default 10. */
  settleSamples?: number;
  /** Yaw magnitude before a sweep direction can start latching. Default 3. */
  dirLockDeg?: number;
  /** How long the direction sign must be sustained before it locks. Default 300. */
  dirLockMs?: number;
  /** DeviceMotion update interval in ms. Default 33 (~30 Hz). */
  sensorIntervalMs?: number;
  /** `quality` passed to expo-camera `takePictureAsync`. Default 0.9. */
  photoQuality?: number;
  /**
   * Fire a success haptic on each capture. Requires the optional
   * `expo-haptics` peer — silently a no-op when it is not installed.
   * Default true.
   */
  haptics?: boolean;
  /**
   * Request EXIF with every capture (`takePictureAsync({ exif: true })`)
   * and attach the normalized record as `SweepPhoto.exif` — the source of
   * the per-frame focal-length prior (`exif.focalPx`). `"full"` also keeps
   * the raw dictionary (minus maker blobs) as `exif.raw`; `false` skips
   * EXIF entirely (`exif`/`exifOrientation` are `null`).
   *
   * Platform notes: iOS rejects a capture with "Failed to process EXIF
   * data" when the Exif dictionary is missing — on an EXIF-related
   * rejection the hook retries that shot once without EXIF and disables
   * EXIF for the rest of the sweep, so a sweep never stalls (other capture
   * failures keep the usual behaviour: the target is retried on the next
   * tick). Android does not rotate the bitmap when EXIF is
   * requested (it writes the `Orientation` tag instead); the hook swaps
   * `width`/`height` to upright for you. Default true.
   */
  exif?: boolean | "full";
};

/** {@link GuidedSweepOptions} with every default applied. */
export type GuidedSweepConfig = Required<GuidedSweepOptions>;

/** Live guidance values, throttled to ~15 Hz (always flushed on a status change). */
export type GuidedSweepHud = {
  /** Integrated yaw since the sweep armed, degrees (signed, before direction lock). */
  yawDeg: number;
  /** Degrees of rotation remaining until the next capture target. */
  toTargetDeg: number;
  /** Pitch delta vs the settle-window baseline, degrees (signed, for directional UI). */
  tiltDeg: number;
  /** Roll delta vs the settle-window baseline, degrees (signed, for directional UI). */
  rollDeg: number;
  status: SweepStatus;
};

/** Everything `useGuidedSweep` returns. */
export type GuidedSweep = {
  phase: SweepPhase;
  /** Photos captured so far in the current sweep. */
  shots: SweepPhoto[];
  hud: GuidedSweepHud;
  /** Begin a sweep (also serves as "redo" from `done`). */
  start: () => void;
  /** End the sweep, keeping the shots taken so far. */
  finish: () => void;
  /** Abandon the sweep and return to `idle`; in-flight captures are dropped. */
  reset: () => void;
  /** Bind to `<CameraView ref={cameraRef} onCameraReady={onCameraReady} />`. */
  cameraRef: RefObject<CameraView | null>;
  onCameraReady: () => void;
  /** True once the bound camera reported ready; `start` should be gated on it. */
  isCameraReady: boolean;
  /** The resolved options, for HUD rendering (tick spacing, thresholds…). */
  config: GuidedSweepConfig;
  /**
   * Sweep-level record of the most recent sweep started — `null` before the
   * first `start()`. Refreshed on `start()` and when the sweep ends (never
   * per sensor tick); `gravityRef` is filled in once the settle window
   * completes and is visible on the next refresh.
   */
  meta: SweepCaptureMeta | null;
};

/** Overridable copy for the built-in `<GuidedSweepCapture />` overlay. */
export type GuidedSweepStrings = {
  /** Display string per {@link SweepStatus}. */
  statuses: Record<SweepStatus, string>;
  /** Small caps title above the HUD stats line. */
  hudTitle: string;
  /** Stats line template: `{count}`, `{yaw}`, `{next}`, `{tilt}`, `{roll}`. */
  hudStats: string;
  /** Idle-phase instructions; `{stepDeg}` is replaced. */
  idleInstructions: string;
  startButton: string;
  /** Start-button label while the camera is still initializing. */
  cameraStarting: string;
  /** Finish-button label; `{count}` is replaced. */
  finishButton: string;
  redoButton: string;
  /** Accept-button label; `{count}` is replaced. */
  useButton: string;
  cancelButton: string;
  permissionMessage: string;
  permissionButton: string;
};

export type GuidedSweepCaptureProps = GuidedSweepOptions & {
  /** Called with the sweep's photos and its {@link SweepCaptureMeta} when the user accepts them. */
  onComplete: (photos: SweepPhoto[], meta: SweepCaptureMeta) => void;
  /** Renders a Cancel affordance when provided. */
  onCancel?: () => void;
  /** Tint for captured ticks, warnings, and primary buttons. Default `#0A84FF`. */
  accentColor?: string;
  /** Minimum shots before "use photos" enables (the stitcher needs 2). Default 2. */
  minShots?: number;
  /** Partial override of the built-in copy — merged over the English defaults. */
  strings?: Partial<Omit<GuidedSweepStrings, "statuses">> & {
    statuses?: Partial<Record<SweepStatus, string>>;
  };
  /** Replace the entire overlay; the camera preview underneath stays. */
  renderHUD?: (sweep: GuidedSweep) => ReactNode;
};
