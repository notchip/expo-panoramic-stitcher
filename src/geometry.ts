/**
 * Pure-TS interpretation of the stitch geometry native reports
 * (`StitchGeometry`, parsed from the raw `geometryJson`). No native calls —
 * everything here is plain math over OpenCV's warp model, so it runs in
 * jest, on web and on saved results alike. Native deliberately reports only
 * the raw camera model (K, R, warpScale, ROIs); angles are derived HERE so
 * the coordinate conventions live in one place.
 *
 * Conventions (OpenCV's, verified against `stitching/detail/warpers_inl.hpp`):
 *  - Camera frame: x right, y DOWN, z forward (optical axis). `R` is
 *    camera-to-world, row-major; a pixel's world ray is
 *    `p = R · K⁻¹ · (x, y, 1)`.
 *  - Global warped coords `(u, v)`, pixels at compose scale:
 *      u = warpScale · atan2(p.x, p.z)                (both projections)
 *      v = warpScale · (π − acos(p.y / |p|))          (spherical)
 *      v = warpScale · p.y / hypot(p.x, p.z)          (cylindrical)
 *    so azimuth is linear in `u` and increases turning RIGHT; the horizon is
 *    `v = warpScale·π/2` (spherical; top pole at v = 0) or `v = 0`
 *    (cylindrical; `v = −warpScale·tan(elevation)`).
 *  - Composite pixel = global − origin; output pixel = `output` affine of
 *    that (`X_out = sx·X + tx`).
 *  - `affine` (warpMode 'plane') composites have no angles: the angle
 *    helpers return `null` for them; `imagePointToPano` still works.
 */
import type {
  AzimuthInterval,
  CameraAngles,
  GyroPanoFit,
  Mat3,
  PanoAngles,
  PanoPoint,
  StitchCamera,
  StitchGeometry,
  StitchProjection,
  SweepCoverage,
  SweepStripGeometry,
} from "./ExpoPanoramicStitcher.types";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const EPS_DEG = 1e-9;

/** Wrap an angle in degrees to (−180, 180]. */
export function wrapDeg(a: number): number {
  const r = ((((a + 180) % 360) + 360) % 360) - 180; // [-180, 180)
  return r === -180 ? 180 : r;
}

/** Normalise an angle in degrees to [0, 360). */
function norm360(a: number): number {
  return ((a % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseCamera(raw: unknown): StitchCamera | null {
  if (!isRecord(raw)) return null;
  const inputIndex = finiteNumber(raw.inputIndex);
  const srcWidth = finiteNumber(raw.srcWidth);
  const srcHeight = finiteNumber(raw.srcHeight);
  const focal = finiteNumber(raw.focal);
  const ppx = finiteNumber(raw.ppx);
  const ppy = finiteNumber(raw.ppy);
  const aspect = finiteNumber(raw.aspect);
  if (
    inputIndex === null ||
    srcWidth === null ||
    srcHeight === null ||
    focal === null ||
    ppx === null ||
    ppy === null ||
    aspect === null
  ) {
    return null;
  }
  if (!Array.isArray(raw.R) || raw.R.length !== 9) return null;
  const R: number[] = [];
  for (const entry of raw.R) {
    const n = finiteNumber(entry);
    if (n === null) return null;
    R.push(n);
  }
  if (!isRecord(raw.roi)) return null;
  const rx = finiteNumber(raw.roi.x);
  const ry = finiteNumber(raw.roi.y);
  const rw = finiteNumber(raw.roi.width);
  const rh = finiteNumber(raw.roi.height);
  if (rx === null || ry === null || rw === null || rh === null) return null;
  return {
    inputIndex,
    srcWidth,
    srcHeight,
    focal,
    ppx,
    ppy,
    aspect,
    R: R as Mat3,
    roi: { x: rx, y: ry, width: rw, height: rh },
  };
}

/**
 * Parse native's compact `geometryJson` into a validated {@link StitchGeometry}.
 * Returns `null` (never throws) for an empty/missing string, malformed JSON,
 * a payload version other than 1, an unknown projection, or any non-finite
 * number (native writes `null` for non-finite values). The result is a fresh
 * object with exactly the documented shape.
 */
export function parseGeometry(
  json: string | null | undefined,
): StitchGeometry | null {
  if (typeof json !== "string" || json.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const projection = raw.projection;
  if (
    projection !== "spherical" &&
    projection !== "cylindrical" &&
    projection !== "affine"
  ) {
    return null;
  }
  const workScale = finiteNumber(raw.workScale);
  const warpScale = finiteNumber(raw.warpScale);
  const compositeWidth = finiteNumber(raw.compositeWidth);
  const compositeHeight = finiteNumber(raw.compositeHeight);
  if (
    workScale === null ||
    warpScale === null ||
    compositeWidth === null ||
    compositeHeight === null ||
    typeof raw.selfCheck !== "boolean" ||
    !isRecord(raw.origin) ||
    !isRecord(raw.output) ||
    !Array.isArray(raw.cameras)
  ) {
    return null;
  }
  const ox = finiteNumber(raw.origin.x);
  const oy = finiteNumber(raw.origin.y);
  const sx = finiteNumber(raw.output.sx);
  const sy = finiteNumber(raw.output.sy);
  const tx = finiteNumber(raw.output.tx);
  const ty = finiteNumber(raw.output.ty);
  if (
    ox === null ||
    oy === null ||
    sx === null ||
    sy === null ||
    tx === null ||
    ty === null
  ) {
    return null;
  }
  const cameras: StitchCamera[] = [];
  for (const entry of raw.cameras) {
    const cam = parseCamera(entry);
    if (!cam) return null;
    cameras.push(cam);
  }
  return {
    v: 1,
    projection: projection as StitchProjection,
    workScale,
    warpScale,
    origin: { x: ox, y: oy },
    compositeWidth,
    compositeHeight,
    selfCheck: raw.selfCheck,
    output: { sx, sy, tx, ty },
    cameras,
  };
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/**
 * Yaw / pitch / roll of a camera from its camera-to-world `R`. The optical
 * axis in world coords is the third column `(R[2], R[5], R[8])`, so
 * `yawDeg = atan2(R[2], R[8])` — the same `atan2(x, z)` the warper uses,
 * i.e. the camera's pano azimuth, increasing when turning right.
 * `pitchDeg = −asin(R[5])` (up positive); `rollDeg = atan2(R[3], R[0])` is
 * diagnostic only. Meaningless for `affine` composites.
 */
export function cameraAngles(cam: StitchCamera): CameraAngles {
  const R = cam.R;
  const yawDeg = Math.atan2(R[2], R[8]) * DEG;
  const pitchDeg = -Math.asin(Math.max(-1, Math.min(1, R[5]))) * DEG;
  const rollDeg = Math.atan2(R[3], R[0]) * DEG;
  return { yawDeg, pitchDeg, rollDeg };
}

/**
 * Azimuth interval a camera covers: `yawDeg ± hfov/2` with
 * `hfov = 2·atan(srcWidth / (2·focal))`. NOT normalised — the ends may fall
 * outside (−180, 180] (coverage helpers handle the wrap). Prefer this over
 * `roi.width` for coverage: an image straddling the ±180° seam gets a ROI
 * as wide as the whole canvas.
 */
export function cameraAzimuthIntervalDeg(cam: StitchCamera): AzimuthInterval {
  const yaw = cameraAngles(cam).yawDeg;
  const half = Math.atan(cam.srcWidth / (2 * cam.focal)) * DEG;
  return { fromDeg: yaw - half, toDeg: yaw + half };
}

// ---------------------------------------------------------------------------
// Pixels <-> angles
// ---------------------------------------------------------------------------

function usableOutput(
  geometry: StitchGeometry,
): { sx: number; sy: number; tx: number; ty: number; ws: number } | null {
  const { sx, sy, tx, ty } = geometry.output;
  const ws = geometry.warpScale;
  if (!(sx > 0) || !(sy > 0) || !(ws > 0)) return null;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  return { sx, sy, tx, ty, ws };
}

/**
 * Direction of a pixel of the OUTPUT panorama (the JPEG you received).
 * `null` for `affine` composites (no angular model) or a degenerate
 * geometry. Azimuth is not wrapped — a full-turn composite spans (−180, 180].
 */
export function panoPixelToAngles(
  geometry: StitchGeometry,
  xOut: number,
  yOut: number,
): PanoAngles | null {
  if (geometry.projection === "affine") return null;
  const o = usableOutput(geometry);
  if (!o) return null;
  const u = (xOut - o.tx) / o.sx + geometry.origin.x;
  const v = (yOut - o.ty) / o.sy + geometry.origin.y;
  const azimuthDeg = (u / o.ws) * DEG;
  const elevationDeg =
    geometry.projection === "spherical"
      ? 90 - (v / o.ws) * DEG
      : -Math.atan(v / o.ws) * DEG;
  return { azimuthDeg, elevationDeg };
}

/**
 * Inverse of {@link panoPixelToAngles}: output-panorama pixel of a direction.
 * `null` for `affine` composites. The result is not clamped to the image.
 */
export function anglesToPanoPixel(
  geometry: StitchGeometry,
  azimuthDeg: number,
  elevationDeg: number,
): PanoPoint | null {
  if (geometry.projection === "affine") return null;
  const o = usableOutput(geometry);
  if (!o) return null;
  const u = azimuthDeg * RAD * o.ws;
  const v =
    geometry.projection === "spherical"
      ? (90 - elevationDeg) * RAD * o.ws
      : -Math.tan(elevationDeg * RAD) * o.ws;
  return {
    x: o.sx * (u - geometry.origin.x) + o.tx,
    y: o.sy * (v - geometry.origin.y) + o.ty,
  };
}

/**
 * Where a pixel `(x, y)` of input image `geometry.cameras[cameraIndex]`
 * landed in the OUTPUT panorama: `p = R · K⁻¹ · (x, y, 1)`, then the
 * projection's forward map, then `− origin`, then the output affine. Works
 * for all three projections (for `affine` it replays OpenCV's
 * `AffineWarper`: `u = warpScale·(t + (a·x' + b·y') / z')`). `null` for an
 * unknown camera, a degenerate K, or a ray on the vertical axis.
 */
export function imagePointToPano(
  geometry: StitchGeometry,
  cameraIndex: number,
  x: number,
  y: number,
): PanoPoint | null {
  const cam = geometry.cameras[cameraIndex];
  if (!cam) return null;
  const o = usableOutput(geometry);
  if (!o) return null;
  const fx = cam.focal;
  const fy = cam.focal * cam.aspect;
  if (!(fx > 0) || !(fy > 0)) return null;
  const qx = (x - cam.ppx) / fx;
  const qy = (y - cam.ppy) / fy;
  const R = cam.R;
  let u: number;
  let v: number;
  if (geometry.projection === "affine") {
    // AffineWarper: translation (R[2], R[5]) is split off before R·K⁻¹.
    const zr = R[6] * qx + R[7] * qy + R[8];
    if (!(Math.abs(zr) > 0)) return null;
    u = o.ws * (R[2] + (R[0] * qx + R[1] * qy) / zr);
    v = o.ws * (R[5] + (R[3] * qx + R[4] * qy) / zr);
  } else {
    const px = R[0] * qx + R[1] * qy + R[2];
    const py = R[3] * qx + R[4] * qy + R[5];
    const pz = R[6] * qx + R[7] * qy + R[8];
    const horiz = Math.hypot(px, pz);
    if (!(horiz > 0)) return null;
    u = o.ws * Math.atan2(px, pz);
    if (geometry.projection === "spherical") {
      const w = py / Math.hypot(px, py, pz);
      v = o.ws * (Math.PI - Math.acos(Math.max(-1, Math.min(1, w))));
    } else {
      v = (o.ws * py) / horiz;
    }
  }
  return {
    x: o.sx * (u - geometry.origin.x) + o.tx,
    y: o.sy * (v - geometry.origin.y) + o.ty,
  };
}

// ---------------------------------------------------------------------------
// Coverage on the circle
// ---------------------------------------------------------------------------

interface Arc {
  start: number; // [0, 360)
  end: number; // > start, <= start + 360
}

function toInterval(start: number, end: number): AzimuthInterval {
  const from = start >= 180 ? start - 360 : start;
  return { fromDeg: from, toDeg: from + (end - start) };
}

/**
 * Azimuth coverage of a composite: the union, on the circle, of every
 * camera's `yaw ± hfov/2` interval ({@link cameraAzimuthIntervalDeg}), plus
 * the complementary holes. `spanDeg` is the canvas's angular width
 * (`compositeWidth / warpScale`, capped at 360). `null` for `affine`
 * composites, a degenerate `warpScale`, or no cameras. Intervals use the
 * {@link AzimuthInterval} convention (`fromDeg` in [−180, 180), `toDeg` may
 * exceed 180 across the seam); a full turn is the single interval
 * `[−180, 180]` with no holes.
 */
export function coverageFromGeometry(
  geometry: StitchGeometry,
): SweepCoverage | null {
  if (geometry.projection === "affine") return null;
  if (!(geometry.warpScale > 0) || geometry.cameras.length === 0) return null;
  const spanDeg = Math.min(
    360,
    (geometry.compositeWidth / geometry.warpScale) * DEG,
  );

  let full = false;
  const arcs: Arc[] = [];
  for (const cam of geometry.cameras) {
    const iv = cameraAzimuthIntervalDeg(cam);
    const len = iv.toDeg - iv.fromDeg;
    if (!(len > 0)) continue;
    if (len >= 360) {
      full = true;
      break;
    }
    const start = norm360(iv.fromDeg);
    arcs.push({ start, end: start + len });
  }
  if (arcs.length === 0 && !full) return null;

  let merged: Arc[] = [];
  if (!full) {
    arcs.sort((a, b) => a.start - b.start);
    for (const arc of arcs) {
      const last = merged[merged.length - 1];
      if (last && arc.start <= last.end + EPS_DEG) {
        last.end = Math.max(last.end, arc.end);
      } else {
        merged.push({ ...arc });
      }
    }
    // The last arc may run past 360 and swallow the first ones.
    let last = merged[merged.length - 1]!;
    while (merged.length > 1 && merged[0]!.start + 360 <= last.end + EPS_DEG) {
      last.end = Math.max(last.end, merged[0]!.end + 360);
      merged.shift();
      last = merged[merged.length - 1]!;
    }
    if (last.end - last.start >= 360 - EPS_DEG) full = true;
  }

  if (full) {
    return {
      spanDeg,
      coveredDeg: 360,
      intervals: [{ fromDeg: -180, toDeg: 180 }],
      holes: [],
    };
  }

  const holes: Arc[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]!;
    const nextStart =
      i + 1 < merged.length ? merged[i + 1]!.start : merged[0]!.start + 360;
    const gap = nextStart - cur.end;
    if (gap > EPS_DEG) {
      const start = norm360(cur.end);
      holes.push({ start, end: start + gap });
    }
  }

  const byFrom = (a: AzimuthInterval, b: AzimuthInterval) =>
    a.fromDeg - b.fromDeg;
  const intervals = merged.map((a) => toInterval(a.start, a.end)).sort(byFrom);
  const coveredDeg = Math.min(
    360,
    merged.reduce((sum, a) => sum + (a.end - a.start), 0),
  );
  merged = [];
  return {
    spanDeg,
    coveredDeg,
    intervals,
    holes: holes.map((a) => toInterval(a.start, a.end)).sort(byFrom),
  };
}

// ---------------------------------------------------------------------------
// Gyro <-> pano
// ---------------------------------------------------------------------------

function circularMeanDeg(anglesDeg: number[]): number {
  let s = 0;
  let c = 0;
  for (const a of anglesDeg) {
    s += Math.sin(a * RAD);
    c += Math.cos(a * RAD);
  }
  return Math.atan2(s, c) * DEG;
}

/**
 * Fit `panoAzimuth ≈ sign · gyroYaw + offsetDeg` between the capture-time
 * gyro yaws (`photos[photoIndex].yawDeg`) and the stitched camera azimuths
 * (`cameraAngles(cam).yawDeg`) of a strip. Both signs are tried (the sensor
 * handedness is not assumed); for each, the offset is the circular mean of
 * `wrap(pano − sign·gyro)` and the fit with the lower RMS residual wins
 * (ties → `+1`). All differences are wrapped to (−180, 180]. Needs at least
 * two cameras with a matching photo; `null` otherwise.
 */
export function fitGyroToPano(
  photos: readonly { yawDeg: number }[],
  stripGeometry: SweepStripGeometry,
): GyroPanoFit | null {
  const samples: { photoIndex: number; gyro: number; pano: number }[] = [];
  for (const cam of stripGeometry.cameras) {
    const photo = photos[cam.photoIndex];
    if (!photo || !Number.isFinite(photo.yawDeg)) continue;
    samples.push({
      photoIndex: cam.photoIndex,
      gyro: photo.yawDeg,
      pano: cameraAngles(cam).yawDeg,
    });
  }
  if (samples.length < 2) return null;

  let best: GyroPanoFit | null = null;
  for (const sign of [1, -1] as const) {
    const diffs = samples.map((s) => wrapDeg(s.pano - sign * s.gyro));
    const offsetDeg = circularMeanDeg(diffs);
    const residuals = samples.map((s, i) => ({
      photoIndex: s.photoIndex,
      residualDeg: wrapDeg(diffs[i]! - offsetDeg),
    }));
    const rmsDeg = Math.sqrt(
      residuals.reduce((sum, r) => sum + r.residualDeg * r.residualDeg, 0) /
        residuals.length,
    );
    if (!best || rmsDeg < best.rmsDeg) {
      best = { sign, offsetDeg, rmsDeg, residuals };
    }
  }
  return best;
}
