/**
 * stitchSweep is plain-TS orchestration over the native stitchImagePaths —
 * everything here runs against a mocked native module, so these tests cover
 * the wrap-closure index mapping, arc salvage, gap computation, and the
 * single spherical→cylindrical fallback without a device.
 */
import type {
  NativeStitchResult,
  SweepManifest,
} from "../ExpoPanoramicStitcher.types";
import ExpoPanoramicStitcher from "../ExpoPanoramicStitcherModule";
import {
  buildSweepManifest,
  normalizeImagePath,
  stitchImagePaths,
  stitchSweep,
} from "../index";
import { toFileUri } from "../optionalFileSystem";

jest.mock("../ExpoPanoramicStitcherModule", () => ({
  __esModule: true,
  default: { stitchImagePaths: jest.fn() },
}));

// expo-file-system is loaded lazily via a guarded require in
// src/optionalFileSystem.ts; mock its `File` class so the sidecar write is
// observable (uri + text) and can be made to throw.
const mockFileWrite = jest.fn<void, [string, string]>();
const mockFileSystemModule = () => ({
  File: class MockFile {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    write(text: string) {
      mockFileWrite(this.uri, text);
    }
  },
});
jest.mock("expo-file-system", () => mockFileSystemModule());

const nativeStitch = ExpoPanoramicStitcher.stitchImagePaths as jest.Mock;

// Deliberately typed loosely: most tests omit geometryJson (as older native
// builds / other mocks would) and the wrappers must tolerate that.
const ok = (
  usedIndices: number[],
  path = "/tmp/pano.jpg",
  geometryJson?: string,
): Partial<NativeStitchResult> => ({
  success: true,
  path,
  width: 4096,
  height: 2048,
  aspectRatio: 2,
  usedIndices,
  usedCount: usedIndices.length,
  ...(geometryJson === undefined ? {} : { geometryJson }),
  errorMessage: "",
});

const RAD = Math.PI / 180;

/**
 * Synthetic native geometryJson: one cylindrical camera per input index,
 * rotated about y by `yawOf(i)` degrees (R camera-to-world, y down).
 */
const geometryJson = (inputIndices: number[], yawOf: (i: number) => number) =>
  JSON.stringify({
    v: 1,
    projection: "cylindrical",
    workScale: 0.5,
    warpScale: 1000,
    origin: { x: -3142, y: -500 },
    compositeWidth: 6284,
    compositeHeight: 1000,
    selfCheck: true,
    output: { sx: 1, sy: 1, tx: 0, ty: 0 },
    cameras: inputIndices.map((i) => {
      const c = Math.cos(yawOf(i) * RAD);
      const s = Math.sin(yawOf(i) * RAD);
      return {
        inputIndex: i,
        srcWidth: 4000,
        srcHeight: 3000,
        focal: 1000,
        ppx: 2000,
        ppy: 1500,
        aspect: 1,
        R: [c, 0, s, 0, 1, 0, -s, 0, c],
        roi: { x: 0, y: 0, width: 4000, height: 3000 },
      };
    }),
  });

/** n photos, stepDeg apart, uris p0..p{n-1}. */
const sweep = (n: number, stepDeg: number) =>
  Array.from({ length: n }, (_, i) => ({ uri: `p${i}`, yawDeg: i * stepDeg }));

beforeEach(() => {
  nativeStitch.mockReset();
  mockFileWrite.mockReset();
});

it("rejects warpMode 'plane' with a clear error", async () => {
  await expect(
    // @ts-expect-error — 'plane' is deliberately not in SweepWarpMode
    stitchSweep(sweep(4, 15), { warpMode: "plane" }),
  ).rejects.toThrow(/plane/);
  expect(nativeStitch).not.toHaveBeenCalled();
});

it("defaults to cylindrical + panoConfidence 0.7 + no 2:1 stretch, no wrap below ~330°", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3]));
  const res = await stitchSweep(sweep(4, 15)); // span 45°
  expect(nativeStitch).toHaveBeenCalledTimes(1);
  const [paths, opts] = nativeStitch.mock.calls[0];
  expect(paths).toEqual(["p0", "p1", "p2", "p3"]);
  expect(opts.warpMode).toBe("cylindrical");
  expect(opts.panoConfidence).toBe(0.7);
  expect(opts.autoResize).toBe(false); // a partial sweep is never stretched to 2:1
  expect(opts.outputWidth).toBe(4096); // core DEFAULTS still merged underneath
  expect(res.yawSpanDeg).toBe(45);
  expect(res.wrapClosed).toBe(false);
  expect(res.strips).toHaveLength(1);
  expect(res.usedIndices).toEqual([0, 1, 2, 3]);
  expect(res.gaps).toEqual([]);
});

it("closes the wrap at ≥330° span and maps duplicate indices back", async () => {
  // 24 shots × 15° = span 345°; the first two photos are re-appended.
  nativeStitch.mockResolvedValueOnce(
    ok(Array.from({ length: 26 }, (_, i) => i)),
  );
  const res = await stitchSweep(sweep(24, 15));
  const [paths] = nativeStitch.mock.calls[0];
  expect(paths).toHaveLength(26);
  expect(paths[24]).toBe("p0");
  expect(paths[25]).toBe("p1");
  expect(res.wrapClosed).toBe(true);
  // 26 raw indices dedupe to the 24 canonical photos.
  expect(res.usedCount).toBe(24);
  expect(res.usedIndices).toEqual(Array.from({ length: 24 }, (_, i) => i));
  expect(res.gaps).toEqual([]);
  expect(nativeStitch).toHaveBeenCalledTimes(1); // nothing dropped → no salvage
});

it("salvages the dropped complement and reports unsalvaged gaps", async () => {
  // Field shape: primary keeps [2..18]; complement is [0,1,19..23].
  nativeStitch.mockResolvedValueOnce(
    ok(
      Array.from({ length: 17 }, (_, i) => i + 2),
      "/tmp/main.jpg",
    ),
  );
  // Salvage keeps 5 of its 7 inputs (drops local 5,6 → photos 22,23).
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3, 4], "/tmp/arc.jpg"));

  const res = await stitchSweep(sweep(24, 15));
  expect(nativeStitch).toHaveBeenCalledTimes(2);
  const [salvagePaths, salvageOpts] = nativeStitch.mock.calls[1];
  expect(salvagePaths).toEqual(["p0", "p1", "p19", "p20", "p21", "p22", "p23"]);
  expect(salvageOpts.warpMode).toBe("cylindrical");

  expect(res.strips).toHaveLength(2);
  expect(res.strips[0]!.path).toBe("/tmp/main.jpg"); // largest first
  expect(res.strips[1]!.usedIndices).toEqual([0, 1, 19, 20, 21]);
  // Photos 22,23 ended up in no strip → one contiguous yaw gap 330–345°.
  expect(res.gaps).toEqual([{ fromDeg: 330, toDeg: 345 }]);
});

it("lets the caller opt back into autoResize explicitly", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3]));
  await stitchSweep(sweep(4, 15), { autoResize: true });
  expect(nativeStitch.mock.calls[0][1].autoResize).toBe(true);
});

it("normalizes file:// URIs (expo-camera output) to bare paths for native", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1]));
  const photos = [
    { uri: "file:///var/mobile/Camera/IMG%20001.jpg", yawDeg: 0 },
    { uri: "file:///data/user/0/app/cache/Camera/b.jpg", yawDeg: 15 },
  ];
  await stitchSweep(photos);
  expect(nativeStitch.mock.calls[0][0]).toEqual([
    "/var/mobile/Camera/IMG 001.jpg",
    "/data/user/0/app/cache/Camera/b.jpg",
  ]);
  // Salvage re-stitches must be normalized too.
  nativeStitch.mockReset();
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/main.jpg"));
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/arc.jpg"));
  await stitchSweep([
    ...photos,
    { uri: "file:///c.jpg", yawDeg: 30 },
    { uri: "file:///d.jpg", yawDeg: 45 },
  ]);
  expect(nativeStitch.mock.calls[1][0]).toEqual(["/c.jpg", "/d.jpg"]);
});

it("normalizeImagePath: bare paths, file://localhost, malformed escapes", () => {
  expect(normalizeImagePath("/a/b.jpg")).toBe("/a/b.jpg");
  expect(normalizeImagePath("FILE:///a/b.jpg")).toBe("/a/b.jpg");
  expect(normalizeImagePath("file://localhost/a/b.jpg")).toBe("/a/b.jpg");
  expect(normalizeImagePath("file:///a/100%.jpg")).toBe("/a/100%.jpg"); // bad escape → raw
  expect(normalizeImagePath("content://media/1")).toBe("content://media/1"); // untouched
  expect(normalizeImagePath("file://relative")).toBe("file://relative"); // not a file path
});

it("treats a failed complement as no strip, not an error", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3], "/tmp/main.jpg"));
  nativeStitch.mockRejectedValueOnce(new Error("ERR_NEED_MORE_IMGS"));
  const res = await stitchSweep(sweep(8, 15));
  expect(res.strips).toHaveLength(1);
  expect(res.gaps).toEqual([{ fromDeg: 60, toDeg: 105 }]); // photos 4..7
});

it("falls back spherical → cylindrical exactly once", async () => {
  nativeStitch.mockRejectedValueOnce(
    new Error("ERR_CAMERA_PARAMS_ADJUST_FAIL"),
  );
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3]));
  const res = await stitchSweep(sweep(4, 15), { warpMode: "spherical" });
  expect(nativeStitch).toHaveBeenCalledTimes(2);
  expect(nativeStitch.mock.calls[0][1].warpMode).toBe("spherical");
  expect(nativeStitch.mock.calls[1][1].warpMode).toBe("cylindrical");
  expect(res.fellBackToCylindrical).toBe(true);
  expect(res.warpModeUsed).toBe("cylindrical");
});

it("does not fall back when cylindrical itself fails", async () => {
  nativeStitch.mockRejectedValueOnce(new Error("ERR_NEED_MORE_IMGS"));
  await expect(stitchSweep(sweep(4, 15))).rejects.toThrow("ERR_NEED_MORE_IMGS");
  expect(nativeStitch).toHaveBeenCalledTimes(1);
});

// --- neighbour-only matching -------------------------------------------------

it("sets matchWrap to wrapClosed unless given, and passes matchNeighbors through", async () => {
  nativeStitch.mockResolvedValue(ok([0, 1, 2, 3]));
  await stitchSweep(sweep(4, 15), { matchNeighbors: 2 }); // span 45°
  expect(nativeStitch.mock.calls[0][1].matchNeighbors).toBe(2);
  expect(nativeStitch.mock.calls[0][1].matchWrap).toBe(false);

  nativeStitch.mockClear();
  nativeStitch.mockResolvedValue(ok(Array.from({ length: 26 }, (_, i) => i)));
  await stitchSweep(sweep(24, 15), { matchNeighbors: 3 }); // span 345°
  expect(nativeStitch.mock.calls[0][1].matchNeighbors).toBe(3);
  expect(nativeStitch.mock.calls[0][1].matchWrap).toBe(true);

  nativeStitch.mockClear();
  nativeStitch.mockResolvedValue(ok(Array.from({ length: 26 }, (_, i) => i)));
  await stitchSweep(sweep(24, 15), { matchWrap: false }); // explicit wins
  expect(nativeStitch.mock.calls[0][1].matchWrap).toBe(false);
  expect(nativeStitch.mock.calls[0][1].matchNeighbors).toBe(0); // core DEFAULTS
});

// --- geometry ----------------------------------------------------------------

it("stitchImagePaths parses geometryJson into geometry and drops the raw string", async () => {
  nativeStitch.mockResolvedValueOnce(
    ok(
      [0, 1],
      "/tmp/pano.jpg",
      geometryJson([0, 1], (i) => i * 20),
    ),
  );
  const res = await stitchImagePaths(["/a.jpg", "/b.jpg"]);
  expect(res.geometry).not.toBeNull();
  expect(res.geometry!.projection).toBe("cylindrical");
  expect(res.geometry!.cameras.map((c) => c.inputIndex)).toEqual([0, 1]);
  expect(
    (res as unknown as Record<string, unknown>).geometryJson,
  ).toBeUndefined();

  nativeStitch.mockResolvedValueOnce(ok([0, 1])); // no geometryJson at all
  expect((await stitchImagePaths(["/a.jpg", "/b.jpg"])).geometry).toBeNull();
});

it("tags a wrap-closed primary's cameras with canonical photoIndex and measures closure", async () => {
  // 24 photos + 2 duplicates. Duplicates 24/25 (photos 0/1) come back 2° off
  // their sources: yaw 2 and 17 instead of 0 and 15.
  const yawOf = (i: number) => (i >= 24 ? (i - 24) * 15 + 2 : i * 15);
  const all26 = Array.from({ length: 26 }, (_, i) => i);
  nativeStitch.mockResolvedValueOnce(
    ok(all26, "/tmp/main.jpg", geometryJson(all26, yawOf)),
  );
  const res = await stitchSweep(sweep(24, 15));
  expect(res.wrapClosed).toBe(true);

  const g = res.strips[0]!.geometry!;
  expect(g).not.toBeNull();
  expect(res.geometry).toBe(g);
  expect(g.cameras).toHaveLength(26);
  expect(g.cameras[24]!.photoIndex).toBe(0);
  expect(g.cameras[24]!.inputIndex).toBe(24);
  expect(g.cameras[25]!.photoIndex).toBe(1);
  expect(g.cameras[5]!.photoIndex).toBe(5);

  expect(res.wrapClosure).not.toBeNull();
  expect(res.wrapClosure!.closureErrorDeg).toBeCloseTo(2, 6);
  expect(res.wrapClosure!.pairs.map((p) => p.photoIndex)).toEqual([0, 1]);
  expect(res.wrapClosure!.pairs[0]!.azimuthDeg).toBeCloseTo(0, 6);
  expect(res.wrapClosure!.pairs[0]!.duplicateAzimuthDeg).toBeCloseTo(2, 6);
  expect(res.wrapClosure!.pairs[1]!.azimuthDeg).toBeCloseTo(15, 6);
  expect(res.wrapClosure!.pairs[1]!.duplicateAzimuthDeg).toBeCloseTo(17, 6);

  // 24 cameras 15° apart with a ~127° hfov cover the whole circle.
  expect(res.strips[0]!.coverage).not.toBeNull();
  expect(res.strips[0]!.coverage!.coveredDeg).toBe(360);
  expect(res.strips[0]!.coverage!.holes).toEqual([]);
});

it("maps a salvage strip's cameras through dropped[]", async () => {
  const primaryUsed = Array.from({ length: 17 }, (_, i) => i + 2); // [2..18]
  nativeStitch.mockResolvedValueOnce(
    ok(
      primaryUsed,
      "/tmp/main.jpg",
      geometryJson(primaryUsed, (i) => i * 15),
    ),
  );
  // Salvage input is dropped = [0,1,19,20,21,22,23]; it keeps local 0..4.
  nativeStitch.mockResolvedValueOnce(
    ok(
      [0, 1, 2, 3, 4],
      "/tmp/arc.jpg",
      geometryJson([0, 1, 2, 3, 4], (i) => i * 15),
    ),
  );
  const res = await stitchSweep(sweep(24, 15));
  expect(res.strips).toHaveLength(2);
  const arc = res.strips[1]!.geometry!;
  expect(arc.cameras.map((c) => c.inputIndex)).toEqual([0, 1, 2, 3, 4]);
  expect(arc.cameras.map((c) => c.photoIndex)).toEqual([0, 1, 19, 20, 21]);
  expect(res.strips[1]!.coverage!.intervals).toHaveLength(1);
  // Wrap closure fired (span 345°) but the primary geometry has no duplicate
  // cameras (inputs 24/25 were dropped), so there is nothing to measure.
  expect(res.wrapClosed).toBe(true);
  expect(res.wrapClosure).toBeNull();
});

it("invalid or empty geometryJson yields null geometry/coverage/wrapClosure without rejecting", async () => {
  const all26 = Array.from({ length: 26 }, (_, i) => i);
  nativeStitch.mockResolvedValueOnce(ok(all26, "/tmp/main.jpg", "{oops"));
  let res = await stitchSweep(sweep(24, 15));
  expect(res.strips[0]!.geometry).toBeNull();
  expect(res.strips[0]!.coverage).toBeNull();
  expect(res.geometry).toBeNull();
  expect(res.wrapClosure).toBeNull();
  expect(res.wrapClosed).toBe(true);
  expect(res.usedCount).toBe(24);

  nativeStitch.mockResolvedValueOnce(ok(all26, "/tmp/main.jpg", ""));
  res = await stitchSweep(sweep(24, 15));
  expect(res.geometry).toBeNull();
  expect(res.wrapClosure).toBeNull();
});

// --- manifest + sidecar --------------------------------------------------------

/** The manifest JSON the (mocked) sidecar write received, parsed back. */
const writtenManifest = (call = 0): SweepManifest =>
  JSON.parse(mockFileWrite.mock.calls[call]![1]) as SweepManifest;

it("writes the manifest sidecar next to the pano as <pano>.json (file:// URI)", async () => {
  nativeStitch.mockResolvedValueOnce(
    ok(
      [0, 1],
      "/tmp/pano-stitch/panorama_ab cd.jpg",
      geometryJson([0, 1], (i) => i * 20),
    ),
  );
  const photos = [
    {
      uri: "file:///var/mobile/Camera/IMG%20001.jpg",
      yawDeg: 0,
      width: 3024,
      height: 4032,
    },
    { uri: "/data/user/0/app/cache/Camera/b.jpg", yawDeg: 20, tiltDeg: 1.5 },
  ];
  const res = await stitchSweep(photos);

  expect(res.success).toBe(true);
  expect(res.sidecarError).toBeNull();
  expect(res.sidecarPath).toBe("/tmp/pano-stitch/panorama_ab cd.json");
  expect(mockFileWrite).toHaveBeenCalledTimes(1);
  // Scheme-less paths are turned into file:// URIs (iOS rejects bare paths).
  expect(mockFileWrite.mock.calls[0]![0]).toBe(
    "file:///tmp/pano-stitch/panorama_ab%20cd.json",
  );

  const m = writtenManifest();
  expect(m).toEqual(res.manifest); // the sidecar IS the in-memory manifest
  expect(m.schemaVersion).toBe(1);
  expect(m.generator).toBe("@notchip/expo-panoramic-stitcher");
  expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);
  expect(m.platform).toBe("unknown"); // no meta → no platform claim
  expect(m.sweep).toBeNull();

  // photos[]: canonical photos, uri as given, path normalized, extras kept.
  expect(m.photos).toHaveLength(2);
  expect(m.photos[0]).toMatchObject({
    index: 0,
    uri: "file:///var/mobile/Camera/IMG%20001.jpg",
    path: "/var/mobile/Camera/IMG 001.jpg",
    yawDeg: 0,
    width: 3024,
    height: 4032,
  });
  expect(m.photos[1]).toMatchObject({
    index: 1,
    uri: "/data/user/0/app/cache/Camera/b.jpg",
    path: "/data/user/0/app/cache/Camera/b.jpg",
    tiltDeg: 1.5,
  });

  // stitch: result fields + geometry passthrough + resolved native options.
  expect(m.stitch.path).toBe("/tmp/pano-stitch/panorama_ab cd.jpg");
  expect(m.stitch.usedIndices).toEqual([0, 1]);
  expect(m.stitch.strips).toHaveLength(1);
  expect(m.stitch.strips[0]!.geometry).toEqual(res.strips[0]!.geometry);
  expect(
    m.stitch.strips[0]!.geometry!.cameras.map((c) => c.photoIndex),
  ).toEqual([0, 1]);
  expect(m.stitch.strips[0]!.coverage).toEqual(res.strips[0]!.coverage);
  expect(m.stitch.wrapClosed).toBe(false);
  expect(m.stitch.warpModeUsed).toBe("cylindrical");
  expect(m.stitch.yawSpanDeg).toBe(20);
  expect(m.stitch.options).toEqual(nativeStitch.mock.calls[0]![1]); // exactly what native got
  expect(m.stitch.options).toMatchObject({
    warpMode: "cylindrical",
    panoConfidence: 0.7,
    autoResize: false,
    outputWidth: 4096,
    matchNeighbors: 0,
    matchWrap: false,
  });
  // The manifest never contains itself or the sidecar bookkeeping.
  expect(
    (m.stitch as unknown as Record<string, unknown>).manifest,
  ).toBeUndefined();
  expect((m as unknown as Record<string, unknown>).sidecarPath).toBeUndefined();
});

it("stores meta as manifest.sweep, takes platform from it, and keeps meta/sidecar out of native options", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1]));
  const meta = {
    id: "sweep-1",
    platform: "android" as const,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_012_000,
    endedBy: "finish" as const,
    gravityRef: { x: 0, y: 0.98, z: 0.2 },
    direction: 1 as const,
    relatched: false,
    config: { stepDeg: 15, exif: true },
    camera: { facing: "back", zoom: 0, photoQuality: 0.9, exifRequested: true },
  };
  const res = await stitchSweep(sweep(2, 15), { meta, sidecar: true });
  expect(res.manifest.sweep).toEqual(meta);
  expect(res.manifest.platform).toBe("android");
  const nativeOpts = nativeStitch.mock.calls[0]![1];
  expect(nativeOpts.meta).toBeUndefined();
  expect(nativeOpts.sidecar).toBeUndefined();
});

it("sidecar: false skips the write but still returns the manifest in memory", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/pano.jpg"));
  const res = await stitchSweep(sweep(2, 15), { sidecar: false });
  expect(mockFileWrite).not.toHaveBeenCalled();
  expect(res.sidecarPath).toBeNull();
  expect(res.sidecarError).toBeNull();
  expect(res.manifest.stitch.path).toBe("/tmp/pano.jpg");
  expect(res.manifest.photos.map((p) => p.path)).toEqual(["p0", "p1"]);
});

it("honours a custom sidecar path (bare path or file:// URI)", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/pano.jpg"));
  let res = await stitchSweep(sweep(2, 15), {
    sidecar: { path: "/data/user/0/app/files/sweeps/s1.json" },
  });
  expect(res.sidecarPath).toBe("/data/user/0/app/files/sweeps/s1.json");
  expect(mockFileWrite.mock.calls[0]![0]).toBe(
    "file:///data/user/0/app/files/sweeps/s1.json",
  );

  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/pano.jpg"));
  res = await stitchSweep(sweep(2, 15), {
    sidecar: { path: "file:///var/mobile/Documents/s2.json" },
  });
  expect(res.sidecarPath).toBe("file:///var/mobile/Documents/s2.json");
  expect(mockFileWrite.mock.calls[1]![0]).toBe(
    "file:///var/mobile/Documents/s2.json",
  );

  // `{}` (no path) behaves like `true`.
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/pano.jpg"));
  res = await stitchSweep(sweep(2, 15), { sidecar: {} });
  expect(res.sidecarPath).toBe("/tmp/pano.json");
});

it("a throwing write degrades to sidecarPath null + sidecarError, success unchanged", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1], "/tmp/pano.jpg"));
  mockFileWrite.mockImplementationOnce(() => {
    throw new Error("EACCES: permission denied");
  });
  const res = await stitchSweep(sweep(2, 15));
  expect(res.success).toBe(true);
  expect(res.path).toBe("/tmp/pano.jpg");
  expect(res.sidecarPath).toBeNull();
  expect(res.sidecarError).toBe("EACCES: permission denied");
  expect(res.manifest.schemaVersion).toBe(1); // still returned in memory
  expect(res.manifest.stitch.usedIndices).toEqual([0, 1]);
});

it("a missing expo-file-system degrades the same way (guarded require)", () => {
  // A fresh registry: the mock instantiated by earlier tests must not be
  // served from Jest's mock registry ahead of the throwing factory below.
  jest.resetModules();
  jest.doMock("expo-file-system", () => {
    throw new Error("Cannot find module 'expo-file-system'");
  });
  try {
    const fs =
      require("../optionalFileSystem") as typeof import("../optionalFileSystem");
    expect(() => fs.writeTextFile("/tmp/x.json", "{}")).toThrow(
      /expo-file-system is not installed/,
    );
    // Memoized: the second call does not retry the require.
    expect(() => fs.writeTextFile("/tmp/x.json", "{}")).toThrow(
      /expo-file-system is not installed/,
    );
  } finally {
    jest.doMock("expo-file-system", () => mockFileSystemModule());
  }
});

it("buildSweepManifest is pure and usable on its own", () => {
  const stitch = {
    path: "/tmp/pano.jpg",
    width: 4096,
    height: 1200,
    aspectRatio: 4096 / 1200,
    usedIndices: [0, 1],
    usedCount: 2,
    strips: [],
    gaps: [],
    wrapClosed: false,
    wrapClosure: null,
    warpModeUsed: "cylindrical" as const,
    fellBackToCylindrical: false,
    yawSpanDeg: 15,
    options: {
      warpMode: "cylindrical" as const,
      blendStrength: 5,
      matchConf: 0.3,
      panoConfidence: 0.7,
      matchNeighbors: 0,
      matchWrap: false,
      outputWidth: 4096,
      autoResize: false,
      jpegQuality: 95,
    },
  };
  const photos = [
    { uri: "file:///a/x%20y.jpg", yawDeg: 0 },
    { uri: "file:///a/z.jpg", yawDeg: 15 },
  ];
  const m = buildSweepManifest(photos, stitch, { id: "s", startedAt: 1 });
  expect(m.sweep).toEqual({ id: "s", startedAt: 1 });
  expect(m.platform).toBe("unknown"); // no platform in meta → "unknown" (core never reads react-native)
  expect(m.photos.map((p) => p.path)).toEqual(["/a/x y.jpg", "/a/z.jpg"]);
  expect(m.stitch).toBe(stitch);
  expect(photos[0]).toEqual({ uri: "file:///a/x%20y.jpg", yawDeg: 0 }); // input untouched
  expect(mockFileWrite).not.toHaveBeenCalled();
});

it("toFileUri: schemes pass through, bare paths get file:// + percent-encoding", () => {
  expect(toFileUri("file:///a/b.json")).toBe("file:///a/b.json");
  expect(toFileUri("content://x/1")).toBe("content://x/1");
  expect(toFileUri("/a/b c.json")).toBe("file:///a/b%20c.json");
  expect(toFileUri("/a/#1?x.json")).toBe("file:///a/%231%3Fx.json");
  expect(toFileUri("/a/ü.json")).toBe("file:///a/%C3%BC.json");
});
