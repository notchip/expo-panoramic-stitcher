/**
 * Guided panorama sweep — headless capture state machine.
 *
 * iOS-pano-style capture: the user stands in one spot and rotates in
 * place; the hook auto-captures a photo every `stepDeg` degrees of yaw,
 * enforcing the overlap the stitcher needs. Guidance comes from
 * DeviceMotion, not camera frames:
 *
 *  - Yaw = gyro angular velocity projected onto the gravity axis,
 *    integrated on the SENSOR's clock (rotationRate.timestamp — wall
 *    clock at JS arrival under-counts rotation whenever the JS thread
 *    stalls and queued samples burst in). Survives the Euler singularity
 *    at portrait-upright and needs no platform sign conventions.
 *  - A settle window after start(): capture is armed only after
 *    `settleSamples` consecutive calm samples, and the level reference
 *    g0 is the average gravity over that window — a single sample would
 *    bake the press-wobble into every tilt reading of the sweep.
 *  - Sweep direction locks only after the sign of motion is sustained
 *    `dirLockMs` past `dirLockDeg`, and may re-latch once while ≤1 shot
 *    is taken, so a settling backswing can't brick the sweep.
 *  - Capture gates: at/past the next yaw target, angular speed below
 *    `maxRateDegS` (no motion blur), tilt within `tiltBlockDeg` (true
 *    angular deviation of gravity, not per-axis approximations).
 *  - Backgrounding aborts the sweep — integrated gyro yaw cannot
 *    survive an app suspension.
 *
 * The sensor math and every default below were tuned and verified on
 * real devices. Do not "improve" them without re-testing in the field.
 *
 * Known limitation: expo-camera cannot lock AE/AWB, so exposure may
 * drift across a sweep — OpenCV's gain compensation absorbs moderate
 * drift.
 */
import type { CameraCapturedPicture, CameraView } from "expo-camera";
import { DeviceMotion, type DeviceMotionMeasurement } from "expo-sensors";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import {
  SweepStatus,
  type GuidedSweep,
  type GuidedSweepConfig,
  type GuidedSweepHud,
  type GuidedSweepOptions,
  type SweepCaptureMeta,
  type SweepEndReason,
  type SweepPhase,
  type SweepPhoto,
  type SweepVec3,
} from "./GuidedSweep.types";
import { normalizeExif, readExifOrientation } from "./exifIntrinsics";
import { hapticShotFeedback } from "./optionalDeps";

export const GUIDED_SWEEP_DEFAULTS: GuidedSweepConfig = {
  stepDeg: 15, // ~70% overlap at a portrait phone's ~50° horizontal FOV
  tolDeg: 2.5, // capture window starts this far before a target
  overshootDeg: 9, // past target+this → tell the user to come back
  maxRateDegS: 14, // hold-still gate for capture
  tiltWarnDeg: 5, // HUD warning only — never gates capture
  tiltBlockDeg: 10,
  maxShots: 24, // 360° at 15° — hard stop for a runaway sweep
  settleSamples: 10, // ~330ms of calm before shot 0 arms
  dirLockDeg: 3,
  dirLockMs: 300,
  sensorIntervalMs: 33,
  photoQuality: 0.9,
  haptics: true,
  exif: true, // per-frame EXIF → focal-length prior (see GuidedSweepOptions.exif)
};

const rad2deg = 57.29577951308232;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Sensor readings of the tick that fired a capture. Pure copies of values
 * onMotion already computes — recorded on the SweepPhoto so consumers can
 * relate each frame to the sweep's level/direction references.
 */
type TriggerSample = {
  tiltDeg: number;
  rollDeg: number;
  tiltMagDeg: number;
  rateDegS: number;
  gravity: SweepVec3;
  sensorTs: number;
};

/** True for expo-camera's EXIF processing rejection (iOS "Failed to process EXIF data"). */
function isExifFailure(e: unknown): boolean {
  const msg =
    e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  return /exif/i.test(msg);
}

/** Dependency-free sweep id: a UUID where the runtime has one, else time + entropy. */
function randomId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    const c = g.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // fall through to the portable id
  }
  const entropy = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${entropy()}${entropy()}`;
}

function platformName(): SweepCaptureMeta["platform"] {
  switch (Platform.OS) {
    case "ios":
    case "android":
    case "web":
      return Platform.OS;
    default:
      return "other";
  }
}

const INITIAL_HUD: GuidedSweepHud = {
  yawDeg: 0,
  toTargetDeg: 0,
  tiltDeg: 0,
  rollDeg: 0,
  status: SweepStatus.HOLD,
};

export function useGuidedSweep(options: GuidedSweepOptions = {}): GuidedSweep {
  const config: GuidedSweepConfig = { ...GUIDED_SWEEP_DEFAULTS, ...options };
  const cfgRef = useRef(config);
  useEffect(() => {
    cfgRef.current = config;
  });

  const cameraRef = useRef<CameraView | null>(null);
  const [isCameraReady, setCameraReady] = useState(false);
  const onCameraReady = useCallback(() => setCameraReady(true), []);

  const [phase, setPhase] = useState<SweepPhase>("idle");
  const [shots, setShots] = useState<SweepPhoto[]>([]);
  const [hud, setHud] = useState<GuidedSweepHud>(INITIAL_HUD);

  const motion = useRef({
    gen: 0, // sweep generation — invalidates in-flight captures on reset/redo
    yaw: 0,
    rateEma: 0,
    lastSensorTs: 0, // rotationRate.timestamp, seconds
    dir: 0, // +1/-1 once locked, 0 while unknown
    dirCandSign: 0,
    dirCandSince: 0,
    relatchUsed: false,
    settled: false,
    settleCount: 0,
    gSum: { x: 0, y: 0, z: 0 },
    g0: null as { x: number; y: number; z: number } | null,
    shotCount: 0,
    capturing: false,
    active: false,
    hudTick: 0,
    lastStatus: "" as SweepStatus | "",
    exifDisabled: false, // set when a capture rejected with EXIF requested (iOS "Failed to process EXIF data")
  });

  // Sweep-level record. Written only in start() / settle / endSweep() —
  // never per sensor tick — and mirrored into `meta` state on start/end.
  const metaRef = useRef<SweepCaptureMeta | null>(null);
  const [meta, setMeta] = useState<SweepCaptureMeta | null>(null);

  const endSweep = useCallback((endedBy: SweepEndReason) => {
    const st = motion.current;
    const wasActive = st.active;
    st.active = false;
    const m = metaRef.current;
    // Only a live sweep's end is recorded: finish() from idle/done must not
    // restamp a previous (or abandoned) sweep's record.
    if (m && wasActive) {
      m.finishedAt = Date.now();
      m.endedBy = endedBy;
      m.direction = st.dir > 0 ? 1 : st.dir < 0 ? -1 : 0;
      m.relatched = st.relatchUsed;
      setMeta({ ...m });
    }
    setPhase("done");
  }, []);

  const finish = useCallback(() => endSweep("finish"), [endSweep]);

  const start = useCallback(() => {
    const st = motion.current;
    st.gen += 1;
    st.yaw = 0;
    st.rateEma = 0;
    st.lastSensorTs = 0;
    st.dir = 0;
    st.dirCandSign = 0;
    st.dirCandSince = 0;
    st.relatchUsed = false;
    st.settled = false;
    st.settleCount = 0;
    st.gSum = { x: 0, y: 0, z: 0 };
    st.g0 = null;
    st.shotCount = 0;
    st.capturing = false;
    st.active = true;
    st.hudTick = 0;
    st.lastStatus = "";
    st.exifDisabled = false;
    const cfg = cfgRef.current;
    const m: SweepCaptureMeta = {
      id: randomId(),
      platform: platformName(),
      startedAt: Date.now(),
      finishedAt: null,
      endedBy: null,
      config: { ...cfg },
      gravityRef: null,
      direction: 0,
      relatched: false,
      camera: {
        facing: "back",
        zoom: 0, // CameraView default; the built-in screen never sets `zoom`
        photoQuality: cfg.photoQuality,
        exifRequested: cfg.exif !== false,
      },
    };
    metaRef.current = m;
    setMeta({ ...m });
    setShots([]);
    setHud(INITIAL_HUD);
    setPhase("sweeping");
  }, []);

  const reset = useCallback(() => {
    const st = motion.current;
    st.gen += 1; // drop any capture still awaiting the shutter
    st.active = false;
    st.capturing = false;
    setShots([]);
    setHud(INITIAL_HUD);
    setPhase("idle");
  }, []);

  const pushHud = (next: GuidedSweepHud) => {
    const st = motion.current;
    st.hudTick += 1;
    // ~15Hz is plenty for the HUD; always flush on a status change so
    // guidance never lags a state transition.
    if (next.status !== st.lastStatus || st.hudTick % 2 === 0) {
      st.lastStatus = next.status;
      setHud(next);
    }
  };

  const doCapture = async (
    yawAtTrigger: number,
    gen: number,
    sample: TriggerSample,
  ) => {
    const st = motion.current;
    const cfg = cfgRef.current;
    const quality = cfg.photoQuality;
    let withExif = cfg.exif !== false && !st.exifDisabled;
    const triggeredAt = Date.now();
    try {
      let photo: CameraCapturedPicture | undefined;
      try {
        photo = await cameraRef.current?.takePictureAsync(
          withExif ? { quality, exif: true } : { quality },
        );
      } catch (e) {
        // iOS rejects with "Failed to process EXIF data" when the Exif
        // dictionary is missing from the capture metadata. Only for an
        // EXIF-related rejection: retry this shot once without EXIF and stop
        // asking for the rest of the sweep so it never stalls on a device
        // that can't supply it. Any other failure keeps the pre-existing
        // behaviour (target stays uncaptured, the gates retry next tick) so
        // a transient camera error never silently drops EXIF for the sweep.
        if (!withExif || gen !== st.gen || !isExifFailure(e)) throw e;
        st.exifDisabled = true;
        withExif = false;
        photo = await cameraRef.current?.takePictureAsync({ quality });
      }
      const resolvedAt = Date.now();
      if (gen !== st.gen) return; // reset/redo/unmount raced the shutter — drop it
      if (photo) {
        const yawDegAtResolve = st.yaw;
        const rawExif: unknown = withExif ? photo.exif : null;
        const exifOrientation = readExifOrientation(rawExif);
        let { width, height } = photo;
        // With EXIF requested, Android's expo-camera skips the upright
        // rotation of the bitmap (ResolveTakenPicture.decodeBitmap) and
        // reports the RAW dims while the file carries Orientation 6/8 for
        // a portrait shot. iOS reports UIImage.size, which is already
        // orientation-aware, so only Android needs the swap.
        if (
          Platform.OS === "android" &&
          exifOrientation !== null &&
          exifOrientation >= 5 &&
          exifOrientation <= 8
        ) {
          [width, height] = [height, width];
        }
        st.shotCount += 1;
        const rec: SweepPhoto = {
          uri: photo.uri,
          width,
          height,
          yawDeg: yawAtTrigger,
          tiltDeg: sample.tiltDeg,
          rollDeg: sample.rollDeg,
          tiltMagDeg: sample.tiltMagDeg,
          rateDegS: sample.rateDegS,
          gravity: sample.gravity,
          sensorTs: sample.sensorTs,
          triggeredAt,
          resolvedAt,
          yawDegAtResolve,
          exifOrientation,
          exif: normalizeExif(rawExif, {
            width,
            height,
            keepRaw: cfg.exif === "full",
          }),
        };
        setShots((prev) => [...prev, rec]);
        if (cfgRef.current.haptics) hapticShotFeedback();
        if (st.shotCount >= cfgRef.current.maxShots) endSweep("maxShots");
      }
    } catch {
      // Unmount mid-capture rejects; a live failure just leaves the
      // target uncaptured and the gates will retry on the next tick.
    } finally {
      if (gen === st.gen) st.capturing = false;
    }
  };

  const maybeCapture = (
    toTarget: number,
    tiltMag: number,
    sample: TriggerSample,
  ) => {
    const st = motion.current;
    const cfg = cfgRef.current;
    if (st.capturing || !st.active || !st.settled) return;
    if (toTarget > cfg.tolDeg || toTarget < -cfg.overshootDeg) return;
    if (tiltMag > cfg.tiltBlockDeg || st.rateEma > cfg.maxRateDegS) return;
    st.capturing = true;
    doCapture(st.yaw, st.gen, sample); // never rejects — all failure paths are handled inside
  };

  const onMotion = (m: DeviceMotionMeasurement) => {
    const st = motion.current;
    const cfg = cfgRef.current;
    const g = m.accelerationIncludingGravity;
    const rr = m.rotationRate;
    if (!g || !rr) return;

    // dt on the sensor's own clock; fall back to the configured interval
    // for duplicate/coalesced timestamps. Reset (not clamp) on absurd
    // gaps — AppState abort covers real suspensions.
    const ts = rr.timestamp;
    let dt = st.lastSensorTs ? ts - st.lastSensorTs : 0;
    st.lastSensorTs = ts;
    if (dt <= 0) dt = (m.interval || cfg.sensorIntervalMs) / 1000;
    if (dt > 0.5) dt = 0;

    const gMag = Math.hypot(g.x, g.y, g.z) || 1;
    const gn = { x: g.x / gMag, y: g.y / gMag, z: g.z / gMag };

    if (!st.active) return;

    // Angular velocity about the gravity axis, deg/s. Axis mapping is
    // verified against expo-sensors NATIVE sources, not its docs — the
    // platforms disagree with the web spec and with each other:
    //   iOS     DeviceMotionModule.swift: alpha=Z, beta=Y, gamma=X
    //   Android DeviceMotionModule.kt:    alpha=X, beta=Y, gamma=Z
    // Getting this wrong projects pitch wobble instead of yaw — turns
    // read as ~0 and the sweep never advances.
    const omega =
      Platform.OS === "ios"
        ? { x: rr.gamma, y: rr.beta, z: rr.alpha }
        : { x: rr.alpha, y: rr.beta, z: rr.gamma };
    const yawRate = omega.x * gn.x + omega.y * gn.y + omega.z * gn.z;

    // Settle window: arm capture only after sustained calm, and average
    // gravity over it for the sweep's level reference.
    if (!st.settled) {
      if (Math.abs(yawRate) < cfg.maxRateDegS) {
        st.settleCount += 1;
        st.gSum.x += gn.x;
        st.gSum.y += gn.y;
        st.gSum.z += gn.z;
        if (st.settleCount >= cfg.settleSamples) {
          const mag = Math.hypot(st.gSum.x, st.gSum.y, st.gSum.z) || 1;
          st.g0 = {
            x: st.gSum.x / mag,
            y: st.gSum.y / mag,
            z: st.gSum.z / mag,
          };
          st.rateEma = Math.abs(yawRate);
          st.yaw = 0;
          st.settled = true;
          // Record the level reference on the sweep meta (pure read of g0).
          if (metaRef.current) metaRef.current.gravityRef = { ...st.g0 };
        }
      } else {
        st.settleCount = 0;
        st.gSum = { x: 0, y: 0, z: 0 };
      }
      pushHud({
        yawDeg: 0,
        toTargetDeg: 0,
        tiltDeg: 0,
        rollDeg: 0,
        status: SweepStatus.HOLD,
      });
      return;
    }
    const g0 = st.g0!;

    st.yaw += yawRate * dt;
    st.rateEma = st.rateEma * 0.8 + Math.abs(yawRate) * 0.2;

    // Direction lock: sustained sign past dirLockDeg for dirLockMs,
    // not an instantaneous peak — a settling backswing must not latch.
    const now = Date.now();
    if (st.dir === 0) {
      const sign = Math.abs(st.yaw) > cfg.dirLockDeg ? Math.sign(st.yaw) : 0;
      if (sign !== 0 && sign === st.dirCandSign) {
        if (now - st.dirCandSince >= cfg.dirLockMs) st.dir = sign;
      } else {
        st.dirCandSign = sign;
        st.dirCandSince = now;
      }
    }

    let progress = st.dir === 0 ? Math.abs(st.yaw) : st.yaw * st.dir;

    // One re-latch while at most the anchor shot exists: if the user
    // committed the other way after a false lock, follow them.
    if (
      st.dir !== 0 &&
      !st.relatchUsed &&
      st.shotCount <= 1 &&
      progress < -cfg.dirLockDeg
    ) {
      st.dir = -st.dir;
      st.relatchUsed = true;
      progress = st.yaw * st.dir;
    }

    // Tilt gate uses the true angular deviation of gravity; the HUD
    // shows per-axis deltas for directional feedback.
    const dot = gn.x * g0.x + gn.y * g0.y + gn.z * g0.z;
    const tiltMag = Math.acos(clamp1(dot)) * rad2deg;
    const tiltDeg =
      (Math.asin(clamp1(gn.z)) - Math.asin(clamp1(g0.z))) * rad2deg;
    const rollDeg =
      (Math.asin(clamp1(gn.x)) - Math.asin(clamp1(g0.x))) * rad2deg;

    const target = st.shotCount * cfg.stepDeg;
    const toTarget = target - progress;

    let status: SweepStatus;
    if (tiltMag > cfg.tiltBlockDeg) {
      status = SweepStatus.LEVEL_THE_PHONE;
    } else if (st.dir !== 0 && progress < -cfg.tolDeg) {
      status = SweepStatus.GO_BACK; // moving against the locked direction
    } else if (toTarget < -cfg.overshootDeg) {
      status = SweepStatus.GO_BACK; // overshot the target
    } else if (toTarget > cfg.tolDeg) {
      status =
        st.dir === 0 ? SweepStatus.START_TURNING : SweepStatus.KEEP_TURNING;
    } else if (st.rateEma > cfg.maxRateDegS) {
      status = SweepStatus.SLOW_DOWN;
    } else {
      status = SweepStatus.HOLD;
      maybeCapture(toTarget, tiltMag, {
        tiltDeg,
        rollDeg,
        tiltMagDeg: tiltMag,
        rateDegS: st.rateEma,
        gravity: { x: gn.x, y: gn.y, z: gn.z },
        sensorTs: ts,
      });
    }

    pushHud({
      yawDeg: st.yaw,
      toTargetDeg: toTarget,
      tiltDeg,
      rollDeg,
      status,
    });
  };

  // Latest-closure indirection so the subscription effect below never
  // holds a stale onMotion (all mutable sweep state lives in refs, but
  // options may change between renders).
  const onMotionRef = useRef(onMotion);
  useEffect(() => {
    onMotionRef.current = onMotion;
  });

  const sensorIntervalMs = config.sensorIntervalMs;
  useEffect(() => {
    if (phase !== "sweeping") return;
    DeviceMotion.setUpdateInterval(sensorIntervalMs);
    const sub = DeviceMotion.addListener((m) => onMotionRef.current(m));
    return () => sub.remove();
  }, [phase, sensorIntervalMs]);

  // Integrated gyro yaw cannot survive an app suspension — abort to
  // "done" (shots taken so far remain valid) rather than resume blind.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" && motion.current.active) endSweep("background");
    });
    return () => sub.remove();
  }, [endSweep]);

  return {
    phase,
    shots,
    hud,
    start,
    finish,
    reset,
    cameraRef,
    onCameraReady,
    isCameraReady,
    config,
    meta,
  };
}
