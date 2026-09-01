/**
 * stitchSweep is plain-TS orchestration over the native stitchImagePaths —
 * everything here runs against a mocked native module, so these tests cover
 * the wrap-closure index mapping, arc salvage, gap computation, and the
 * single spherical→cylindrical fallback without a device.
 */
import type { StitchResult } from "../ExpoPanoramicStitcher.types";
import ExpoPanoramicStitcher from "../ExpoPanoramicStitcherModule";
import { stitchSweep } from "../index";

jest.mock("../ExpoPanoramicStitcherModule", () => ({
  __esModule: true,
  default: { stitchImagePaths: jest.fn() },
}));

const nativeStitch = ExpoPanoramicStitcher.stitchImagePaths as jest.Mock;

const ok = (usedIndices: number[], path = "/tmp/pano.jpg"): StitchResult => ({
  success: true,
  path,
  width: 4096,
  height: 2048,
  aspectRatio: 2,
  usedIndices,
  usedCount: usedIndices.length,
  errorMessage: "",
});

/** n photos, stepDeg apart, uris p0..p{n-1}. */
const sweep = (n: number, stepDeg: number) =>
  Array.from({ length: n }, (_, i) => ({ uri: `p${i}`, yawDeg: i * stepDeg }));

beforeEach(() => nativeStitch.mockReset());

it("rejects warpMode 'plane' with a clear error", async () => {
  await expect(
    // @ts-expect-error — 'plane' is deliberately not in SweepWarpMode
    stitchSweep(sweep(4, 15), { warpMode: "plane" }),
  ).rejects.toThrow(/plane/);
  expect(nativeStitch).not.toHaveBeenCalled();
});

it("defaults to cylindrical + panoConfidence 0.7, no wrap below ~330°", async () => {
  nativeStitch.mockResolvedValueOnce(ok([0, 1, 2, 3]));
  const res = await stitchSweep(sweep(4, 15)); // span 45°
  expect(nativeStitch).toHaveBeenCalledTimes(1);
  const [paths, opts] = nativeStitch.mock.calls[0];
  expect(paths).toEqual(["p0", "p1", "p2", "p3"]);
  expect(opts.warpMode).toBe("cylindrical");
  expect(opts.panoConfidence).toBe(0.7);
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
