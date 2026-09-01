import type { CameraView } from "expo-camera";
import type { ReactNode, RefObject } from "react";

/** One auto-captured frame of a guided sweep. */
export type SweepPhoto = {
  /** File URI of the captured JPEG (from expo-camera). */
  uri: string;
  width: number;
  height: number;
  /** Integrated yaw (degrees) at the moment the shutter was triggered. */
  yawDeg: number;
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
  /** Called with the sweep's photos when the user accepts them. */
  onComplete: (photos: SweepPhoto[]) => void;
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
