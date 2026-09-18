/**
 * geometry.ts is pure TS over OpenCV's warp model — these tests use
 * synthetic geometries (no native) to pin the coordinate conventions:
 * u = warpScale·atan2(x, z), spherical v = warpScale·(π − acos(y/|p|)),
 * cylindrical v = warpScale·y/hypot(x, z), R camera-to-world, y down.
 */
import type {
  Mat3,
  StitchCamera,
  StitchGeometry,
  StitchProjection,
  SweepStripGeometry,
} from "../ExpoPanoramicStitcher.types";
import {
  anglesToPanoPixel,
  cameraAngles,
  cameraAzimuthIntervalDeg,
  coverageFromGeometry,
  fitGyroToPano,
  imagePointToPano,
  panoPixelToAngles,
  parseGeometry,
  wrapDeg,
} from "../geometry";

const RAD = Math.PI / 180;

/** Rotation about the (down-pointing) y axis: yaw `deg`, turning right for +. */
const rotY = (deg: number): Mat3 => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};

/** Rotation about the x axis (pitch); positive tilts the optical axis UP. */
const rotX = (deg: number): Mat3 => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  // Optical axis (third column) = (0, -s, c): y down, so -s is "up".
  return [1, 0, 0, 0, c, -s, 0, s, c];
};

const cam = (
  inputIndex: number,
  R: Mat3,
  opts: { srcWidth?: number; srcHeight?: number; focal?: number } = {},
): StitchCamera => {
  const srcWidth = opts.srcWidth ?? 4000;
  const srcHeight = opts.srcHeight ?? 3000;
  const focal = opts.focal ?? 1000;
  return {
    inputIndex,
    srcWidth,
    srcHeight,
    focal,
    ppx: srcWidth / 2,
    ppy: srcHeight / 2,
    aspect: 1,
    R,
    roi: { x: 0, y: 0, width: srcWidth, height: srcHeight },
  };
};

const geo = (
  projection: StitchProjection,
  cameras: StitchCamera[],
  opts: Partial<
    Pick<
      StitchGeometry,
      "warpScale" | "origin" | "output" | "compositeWidth" | "compositeHeight"
    >
  > = {},
): StitchGeometry => ({
  v: 1,
  projection,
  workScale: 0.5,
  warpScale: opts.warpScale ?? 1000,
  origin: opts.origin ?? { x: -1571, y: -500 },
  compositeWidth: opts.compositeWidth ?? 3142,
  compositeHeight: opts.compositeHeight ?? 1000,
  selfCheck: true,
  output: opts.output ?? { sx: 1, sy: 1, tx: 0, ty: 0 },
  cameras,
});

describe("wrapDeg", () => {
  it("wraps to (-180, 180]", () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(540)).toBe(180);
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(725)).toBeCloseTo(5, 9);
  });
});

describe("cameraAngles", () => {
  it("identity R looks straight ahead", () => {
    expect(cameraAngles(cam(0, rotY(0)))).toEqual({
      yawDeg: 0,
      pitchDeg: -0,
      rollDeg: 0,
    });
  });

  it("yaw is atan2(R[2], R[8]) and increases turning right", () => {
    expect(cameraAngles(cam(0, rotY(30))).yawDeg).toBeCloseTo(30, 9);
    expect(cameraAngles(cam(0, rotY(-120))).yawDeg).toBeCloseTo(-120, 9);
  });

  it("pitch is up-positive", () => {
    expect(cameraAngles(cam(0, rotX(10))).pitchDeg).toBeCloseTo(10, 9);
  });
});

describe("cylindrical (warpScale 1000, identity R)", () => {
  const g = geo("cylindrical", [cam(0, rotY(0))]);

  it("image centre -> azimuth 0 / elevation 0", () => {
    const p = imagePointToPano(g, 0, 2000, 1500)!;
    expect(p).not.toBeNull();
    // Global (u, v) = (0, 0) -> composite = -origin.
    expect(p.x).toBeCloseTo(1571, 9);
    expect(p.y).toBeCloseTo(500, 9);
    const a = panoPixelToAngles(g, p.x, p.y)!;
    expect(a.azimuthDeg).toBeCloseTo(0, 9);
    expect(a.elevationDeg).toBeCloseTo(0, 9);
  });

  it("a pixel above the centre has positive elevation (tan model)", () => {
    const y = 1500 - 1000 * Math.tan(20 * RAD);
    const p = imagePointToPano(g, 0, 2000, y)!;
    expect(panoPixelToAngles(g, p.x, p.y)!.elevationDeg).toBeCloseTo(20, 9);
    // v = -warpScale·tan(20°) relative to the horizon row.
    expect(p.y - 500).toBeCloseTo(-1000 * Math.tan(20 * RAD), 6);
  });

  it("a pixel right of the centre has positive azimuth = atan(dx/f)", () => {
    const p = imagePointToPano(g, 0, 2000 + 1000 * Math.tan(25 * RAD), 1500)!;
    expect(panoPixelToAngles(g, p.x, p.y)!.azimuthDeg).toBeCloseTo(25, 9);
  });
});

describe("rotated camera", () => {
  it("camera rotated 30° about y maps its centre to azimuth 30", () => {
    const g = geo("cylindrical", [cam(0, rotY(0)), cam(1, rotY(30))]);
    const p = imagePointToPano(g, 1, 2000, 1500)!;
    expect(panoPixelToAngles(g, p.x, p.y)!.azimuthDeg).toBeCloseTo(30, 9);
    // u = warpScale · 30° in radians.
    expect(p.x - 1571).toBeCloseTo(1000 * 30 * RAD, 6);
  });

  it("imagePointToPano of the principal point equals the camera azimuth (spherical too)", () => {
    for (const projection of ["spherical", "cylindrical"] as const) {
      for (const yaw of [-150, -45, 0, 60, 170]) {
        const g = geo(projection, [cam(0, rotY(yaw))]);
        const p = imagePointToPano(g, 0, 2000, 1500)!;
        const a = panoPixelToAngles(g, p.x, p.y)!;
        expect(a.azimuthDeg).toBeCloseTo(cameraAngles(g.cameras[0]!).yawDeg, 9);
        expect(a.elevationDeg).toBeCloseTo(0, 9);
      }
    }
  });

  it("spherical: a pitched camera's centre lands at that elevation", () => {
    const g = geo("spherical", [cam(0, rotX(15))]);
    const p = imagePointToPano(g, 0, 2000, 1500)!;
    expect(panoPixelToAngles(g, p.x, p.y)!.elevationDeg).toBeCloseTo(15, 9);
  });
});

describe("panoPixelToAngles <-> anglesToPanoPixel", () => {
  const output = { sx: 0.5, sy: 0.25, tx: 3, ty: -2 };

  it("round-trips through a non-trivial output affine (both projections)", () => {
    for (const projection of ["spherical", "cylindrical"] as const) {
      const g = geo(projection, [cam(0, rotY(0))], { output });
      for (const [az, el] of [
        [0, 0],
        [37.5, 12],
        [-120, -40],
        [179, 60],
      ]) {
        const p = anglesToPanoPixel(g, az!, el!)!;
        const a = panoPixelToAngles(g, p.x, p.y)!;
        expect(a.azimuthDeg).toBeCloseTo(az!, 9);
        expect(a.elevationDeg).toBeCloseTo(el!, 9);
      }
    }
  });

  it("applies the output affine as X_out = sx·X_comp + tx", () => {
    const g = geo("cylindrical", [cam(0, rotY(0))], { output });
    // Global (0, 0) -> composite (1571, 500) -> output.
    const p = anglesToPanoPixel(g, 0, 0)!;
    expect(p.x).toBeCloseTo(0.5 * 1571 + 3, 9);
    expect(p.y).toBeCloseTo(0.25 * 500 - 2, 9);
  });

  it("spherical horizon sits at v = warpScale·π/2, top pole at v = 0", () => {
    const g = geo("spherical", [cam(0, rotY(0))], { origin: { x: 0, y: 0 } });
    expect(anglesToPanoPixel(g, 0, 0)!.y).toBeCloseTo((1000 * Math.PI) / 2, 9);
    expect(anglesToPanoPixel(g, 0, 90)!.y).toBeCloseTo(0, 9);
    expect(anglesToPanoPixel(g, 0, -90)!.y).toBeCloseTo(1000 * Math.PI, 9);
  });

  it("returns null for degenerate output scales", () => {
    const g = geo("cylindrical", [cam(0, rotY(0))], {
      output: { sx: 0, sy: 1, tx: 0, ty: 0 },
    });
    expect(panoPixelToAngles(g, 1, 1)).toBeNull();
    expect(anglesToPanoPixel(g, 1, 1)).toBeNull();
    expect(imagePointToPano(g, 0, 1, 1)).toBeNull();
  });
});

describe("affine", () => {
  // focal = 1/workScale = 2 (workScale 0.5), pp = 0, R = 2-D similarity.
  const affineCam: StitchCamera = {
    inputIndex: 0,
    srcWidth: 100,
    srcHeight: 50,
    focal: 2,
    ppx: 0,
    ppy: 0,
    aspect: 1,
    R: [1, 0, 5, 0, 1, 7, 0, 0, 1],
    roi: { x: 0, y: 0, width: 100, height: 50 },
  };
  const g = geo("affine", [affineCam], {
    warpScale: 2,
    origin: { x: 0, y: 0 },
  });

  it("angle helpers return null", () => {
    expect(panoPixelToAngles(g, 10, 10)).toBeNull();
    expect(anglesToPanoPixel(g, 10, 10)).toBeNull();
    expect(coverageFromGeometry(g)).toBeNull();
  });

  it("imagePointToPano replays AffineWarper (u = ws·(t + x'/z'))", () => {
    // K⁻¹·(10, 4, 1) = (5, 2, 1); u = 2·(5 + 5) = 20; v = 2·(7 + 2) = 18.
    const p = imagePointToPano(g, 0, 10, 4)!;
    expect(p.x).toBeCloseTo(20, 9);
    expect(p.y).toBeCloseTo(18, 9);
  });
});

describe("cameraAzimuthIntervalDeg / coverageFromGeometry", () => {
  // srcWidth 1000 / focal 1000 -> hfov = 2·atan(0.5) = 53.13°.
  const narrow = { srcWidth: 1000, srcHeight: 750, focal: 1000 };
  const half = Math.atan(0.5) * (180 / Math.PI); // 26.565°

  it("interval is yaw ± hfov/2, unnormalised", () => {
    const iv = cameraAzimuthIntervalDeg(cam(0, rotY(170), narrow));
    expect(iv.fromDeg).toBeCloseTo(170 - half, 9);
    expect(iv.toDeg).toBeCloseTo(170 + half, 9); // 196.57, past 180 on purpose
  });

  it("unions overlapping intervals and reports the holes", () => {
    const g = geo(
      "cylindrical",
      [0, 40, 80].map((yaw, i) => cam(i, rotY(yaw), narrow)),
      { compositeWidth: 2000 },
    );
    const c = coverageFromGeometry(g)!;
    expect(c.spanDeg).toBeCloseTo((2000 / 1000) * (180 / Math.PI), 9);
    expect(c.intervals).toHaveLength(1);
    expect(c.intervals[0]!.fromDeg).toBeCloseTo(-half, 9);
    expect(c.intervals[0]!.toDeg).toBeCloseTo(80 + half, 9);
    expect(c.coveredDeg).toBeCloseTo(80 + 2 * half, 9);
    expect(c.holes).toHaveLength(1);
    expect(c.holes[0]!.fromDeg).toBeCloseTo(80 + half, 9);
    expect(c.holes[0]!.toDeg).toBeCloseTo(360 - half, 9);
  });

  it("merges across the ±180° seam (seam-straddling interval)", () => {
    const g = geo(
      "cylindrical",
      [
        cam(0, rotY(0), narrow),
        cam(1, rotY(170), narrow), // [143.4, 196.6] — straddles the seam
        cam(2, rotY(-150), narrow), // [-176.6, -123.4] — overlaps its far end
      ],
      { compositeWidth: 3142 },
    );
    const c = coverageFromGeometry(g)!;
    expect(c.intervals).toHaveLength(2);
    const [a, b] = c.intervals;
    expect(a!.fromDeg).toBeCloseTo(-half, 9);
    expect(a!.toDeg).toBeCloseTo(half, 9);
    expect(b!.fromDeg).toBeCloseTo(170 - half, 9);
    expect(b!.toDeg).toBeCloseTo(210 + half, 9); // = -150 + half, +360
    expect(c.coveredDeg).toBeCloseTo(2 * half + 40 + 2 * half, 9);
    expect(c.holes).toHaveLength(2);
    expect(c.holes[0]!.fromDeg).toBeCloseTo(-150 + half, 9);
    expect(c.holes[0]!.toDeg).toBeCloseTo(-half, 9);
    expect(c.holes[1]!.fromDeg).toBeCloseTo(half, 9);
    expect(c.holes[1]!.toDeg).toBeCloseTo(170 - half, 9);
  });

  it("a full turn collapses to one interval and no holes, spanDeg capped at 360", () => {
    const g = geo(
      "cylindrical",
      Array.from({ length: 9 }, (_, i) => cam(i, rotY(i * 40), narrow)),
      { compositeWidth: 9999 },
    );
    const c = coverageFromGeometry(g)!;
    expect(c.spanDeg).toBe(360);
    expect(c.coveredDeg).toBe(360);
    expect(c.intervals).toEqual([{ fromDeg: -180, toDeg: 180 }]);
    expect(c.holes).toEqual([]);
  });

  it("uses yaw ± hfov/2, not roi widths", () => {
    const wide = cam(0, rotY(179), narrow);
    wide.roi = { x: -1571, y: 0, width: 3142, height: 750 }; // seam-straddler ROI = whole canvas
    const c = coverageFromGeometry(geo("cylindrical", [wide]))!;
    expect(c.coveredDeg).toBeCloseTo(2 * half, 9);
  });

  it("returns null with no cameras", () => {
    expect(coverageFromGeometry(geo("cylindrical", []))).toBeNull();
  });
});

describe("fitGyroToPano", () => {
  const strip = (
    yaws: number[],
    photoIndexOf: (i: number) => number = (i) => i,
  ): SweepStripGeometry => ({
    ...geo(
      "cylindrical",
      yaws.map((yaw, i) => cam(i, rotY(yaw))),
    ),
    cameras: yaws.map((yaw, i) => ({
      ...cam(i, rotY(yaw)),
      photoIndex: photoIndexOf(i),
    })),
  });

  it("recovers sign -1 and the offset (mirrored sensor)", () => {
    const gyro = [0, 30, 60, 90, 120];
    const pano = gyro.map((g) => -g + 15); // sign -1, offset 15
    const fit = fitGyroToPano(
      gyro.map((yawDeg) => ({ yawDeg })),
      strip(pano),
    )!;
    expect(fit.sign).toBe(-1);
    expect(fit.offsetDeg).toBeCloseTo(15, 9);
    expect(fit.rmsDeg).toBeCloseTo(0, 9);
    expect(fit.residuals.map((r) => r.photoIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("recovers sign +1 with a wrapping offset and reports residuals", () => {
    const gyro = [0, 90, 180, 270]; // a full sweep in unbounded gyro yaw
    const pano = [-170, -80, 10, 100 + 2]; // sign +1, offset -170, last one 2° off
    const fit = fitGyroToPano(
      gyro.map((yawDeg) => ({ yawDeg })),
      strip(pano),
    )!;
    expect(fit.sign).toBe(1);
    expect(fit.offsetDeg).toBeCloseTo(-170 + 0.5, 1); // circular mean pulls 0.5°
    expect(fit.rmsDeg).toBeLessThan(2);
    expect(fit.rmsDeg).toBeGreaterThan(0);
    expect(fit.residuals[3]!.residualDeg).toBeCloseTo(1.5, 1);
  });

  it("maps cameras through photoIndex and needs >= 2 samples", () => {
    const photos = [{ yawDeg: 0 }, { yawDeg: 999 }, { yawDeg: 45 }];
    // Cameras 0 and 1 point at photos 0 and 2 (photo 1 is not in the strip).
    const fit = fitGyroToPano(
      photos,
      strip([10, 55], (i) => (i === 0 ? 0 : 2)),
    )!;
    expect(fit.sign).toBe(1);
    expect(fit.offsetDeg).toBeCloseTo(10, 9);
    expect(fit.residuals.map((r) => r.photoIndex)).toEqual([0, 2]);
    expect(
      fitGyroToPano(
        photos,
        strip([10], () => 0),
      ),
    ).toBeNull();
    expect(fitGyroToPano([], strip([10, 20]))).toBeNull(); // no matching photos
  });
});

describe("parseGeometry", () => {
  const valid = JSON.stringify({
    v: 1,
    projection: "cylindrical",
    workScale: 0.5,
    warpScale: 1.5e3,
    origin: { x: -10, y: 20 },
    compositeWidth: 100,
    compositeHeight: 50,
    selfCheck: true,
    output: { sx: 0.5, sy: 0.5, tx: 0, ty: 0 },
    cameras: [
      {
        inputIndex: 3,
        srcWidth: 40,
        srcHeight: 30,
        focal: 25,
        ppx: 20,
        ppy: 15,
        aspect: 1,
        R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        roi: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
  });

  it("parses a valid v1 payload into a fresh, fully-typed object", () => {
    const g = parseGeometry(valid)!;
    expect(g).toEqual({
      v: 1,
      projection: "cylindrical",
      workScale: 0.5,
      warpScale: 1500,
      origin: { x: -10, y: 20 },
      compositeWidth: 100,
      compositeHeight: 50,
      selfCheck: true,
      output: { sx: 0.5, sy: 0.5, tx: 0, ty: 0 },
      cameras: [
        {
          inputIndex: 3,
          srcWidth: 40,
          srcHeight: 30,
          focal: 25,
          ppx: 20,
          ppy: 15,
          aspect: 1,
          R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          roi: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    });
  });

  it("returns null (never throws) for empty, missing, malformed, wrong version or non-finite input", () => {
    expect(parseGeometry("")).toBeNull();
    expect(parseGeometry(null)).toBeNull();
    expect(parseGeometry(undefined)).toBeNull();
    expect(parseGeometry("{not json")).toBeNull();
    expect(parseGeometry("[]")).toBeNull();
    expect(parseGeometry(valid.replace('"v":1', '"v":2'))).toBeNull();
    expect(
      parseGeometry(valid.replace('"cylindrical"', '"fisheye"')),
    ).toBeNull();
    expect(
      parseGeometry(valid.replace('"focal":25', '"focal":null')),
    ).toBeNull(); // native's NaN
    expect(
      parseGeometry(valid.replace("[1,0,0,0,1,0,0,0,1]", "[1,0,0]")),
    ).toBeNull();
    expect(
      parseGeometry(valid.replace('"selfCheck":true', '"selfCheck":1')),
    ).toBeNull();
  });
});
