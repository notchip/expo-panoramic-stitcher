/**
 * exifIntrinsics is pure TS (no imports), so these run without a device:
 * both platforms' EXIF shapes from expo-camera 57, the iOS ISO array vs
 * Android int, numeric-string coercion, the missing-35mm case, the
 * diagonal focal-length derivation (and its crop invariance), and the raw
 * dictionary's MakerNote drop.
 */
import {
  FULL_FRAME_DIAGONAL_MM,
  deriveFocalPx,
  normalizeExif,
  readExifOrientation,
} from "../capture/exifIntrinsics";

// iPhone-style: Exif sub-dictionary with Apple spellings, ISO as an array,
// expo-injected Orientation / PixelX/YDimension (raw sensor frame), no
// Make/Model.
const IOS_EXIF = {
  FocalLength: 5.7,
  FocalLenIn35mmFilm: 26,
  LensModel: "iPhone 14 Pro back triple camera 6.86mm f/1.78",
  LensMake: "Apple",
  LensSpecification: [2.22, 9, 1.78, 2.8],
  FNumber: 1.78,
  ExposureTime: 0.0166,
  ISOSpeedRatings: [125],
  DateTimeOriginal: "2026:09:17 10:12:33",
  SubsecTimeOriginal: "412",
  Orientation: 6,
  PixelXDimension: 4032,
  PixelYDimension: 3024,
  MakerNote: "<binary>",
  "{MakerApple}": { "1": 12 },
};

// Pixel-style: androidx ExifInterface tag names, parsed types, no 35mm tag.
const ANDROID_EXIF = {
  FocalLength: 6.81,
  DigitalZoomRatio: 1,
  Make: "Google",
  Model: "Pixel 8",
  Orientation: 6,
  PixelXDimension: 4080,
  PixelYDimension: 3072,
  ExposureTime: 0.0125,
  FNumber: 1.68,
  ISOSpeedRatings: 54,
  DateTimeOriginal: "2026:09:17 10:12:33",
  SubSecTimeOriginal: "087",
  MakerNote: "<binary>",
};

describe("deriveFocalPx", () => {
  it("uses the diagonal 35 mm equivalence on the full 4:3 frame (3024x4032 @ 26 mm)", () => {
    const px = deriveFocalPx(26, 3024, 4032);
    // hypot(4032, 3024) = 5040 exactly (3:4:5), so 26 * 5040 / 43.2666.
    expect(px).toBeCloseTo((26 * 5040) / FULL_FRAME_DIAGONAL_MM, 6);
    expect(px).toBeGreaterThan(3000);
    expect(px).toBeLessThan(3060);
    // Orientation of the dims must not matter.
    expect(deriveFocalPx(26, 4032, 3024)).toBe(px);
  });

  it("gives a 9:16-cropped frame the same value as the uncropped 4:3 frame", () => {
    const full = deriveFocalPx(26, 3024, 4032)!;
    // 9:16 crop of the same sensor keeps the long side, trims the short one.
    const cropped = deriveFocalPx(26, 2268, 4032)!;
    expect(cropped).toBeCloseTo(full, 6);
    // A 1:1 crop (keeps the short side) reconstructs the same frame too.
    expect(deriveFocalPx(26, 3024, 3024)!).toBeCloseTo(full, 6);
  });

  it("scales with the delivered resolution", () => {
    const hi = deriveFocalPx(26, 3024, 4032)!;
    const lo = deriveFocalPx(26, 1512, 2016)!;
    expect(lo).toBeCloseTo(hi / 2, 6);
  });

  it("returns null for a missing / non-positive focal or bad dims", () => {
    expect(deriveFocalPx(null, 3024, 4032)).toBeNull();
    expect(deriveFocalPx(undefined, 3024, 4032)).toBeNull();
    expect(deriveFocalPx(0, 3024, 4032)).toBeNull();
    expect(deriveFocalPx(Number.NaN, 3024, 4032)).toBeNull();
    expect(deriveFocalPx(26, 0, 4032)).toBeNull();
    expect(deriveFocalPx(26, 3024, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("normalizeExif", () => {
  const dims = { width: 3024, height: 4032 };

  it("normalizes an iOS-shaped dictionary (Apple spellings, ISO array)", () => {
    const e = normalizeExif(IOS_EXIF, { ...dims, keepRaw: false })!;
    expect(e).not.toBeNull();
    expect(e.focalLengthMm).toBe(5.7);
    expect(e.focalLength35mm).toBe(26);
    expect(e.focalPx).toBeCloseTo(deriveFocalPx(26, 3024, 4032)!, 6);
    expect(e.focalPxSource).toBe("exif35");
    expect(e.lensModel).toBe("iPhone 14 Pro back triple camera 6.86mm f/1.78");
    expect(e.make).toBeNull();
    expect(e.model).toBeNull();
    expect(e.iso).toBe(125); // [125] → 125
    expect(e.exposureTimeS).toBe(0.0166);
    expect(e.fNumber).toBe(1.78);
    expect(e.digitalZoomRatio).toBeNull();
    expect(e.pixelWidth).toBe(4032);
    expect(e.pixelHeight).toBe(3024);
    expect(e.dateTimeOriginal).toBe("2026:09:17 10:12:33");
    expect(e.subsecTimeOriginal).toBe("412");
    expect(e.raw).toBeUndefined();
  });

  it("normalizes an Android-shaped dictionary (ExifInterface names, ISO int)", () => {
    const e = normalizeExif(ANDROID_EXIF, {
      width: 3072,
      height: 4080,
      keepRaw: false,
    })!;
    expect(e.focalLengthMm).toBe(6.81);
    expect(e.make).toBe("Google");
    expect(e.model).toBe("Pixel 8");
    expect(e.lensModel).toBeNull();
    expect(e.iso).toBe(54);
    expect(e.digitalZoomRatio).toBe(1);
    expect(e.exposureTimeS).toBe(0.0125);
    expect(e.fNumber).toBe(1.68);
    expect(e.pixelWidth).toBe(4080);
    expect(e.pixelHeight).toBe(3072);
    expect(e.subsecTimeOriginal).toBe("087"); // SubSecTimeOriginal spelling
  });

  it("missing 35 mm tag → focalPx null with focalPxSource null", () => {
    const e = normalizeExif(ANDROID_EXIF, { ...dims, keepRaw: false })!;
    expect(e.focalLength35mm).toBeNull();
    expect(e.focalPx).toBeNull();
    expect(e.focalPxSource).toBeNull();
  });

  it("accepts the Android FocalLengthIn35mmFilm spelling", () => {
    const e = normalizeExif(
      { ...ANDROID_EXIF, FocalLengthIn35mmFilm: 24 },
      { width: 3072, height: 4080, keepRaw: false },
    )!;
    expect(e.focalLength35mm).toBe(24);
    expect(e.focalPx).toBeCloseTo(deriveFocalPx(24, 3072, 4080)!, 6);
    expect(e.focalPxSource).toBe("exif35");
  });

  it("coerces numeric strings and rationals, ignores garbage", () => {
    const e = normalizeExif(
      {
        FocalLength: "6.81",
        FocalLengthIn35mmFilm: "26",
        FNumber: "168/100",
        ExposureTime: "1/80",
        ISOSpeedRatings: "54",
        PixelXDimension: "4080",
        DigitalZoomRatio: "abc",
        Orientation: "6",
      },
      { ...dims, keepRaw: false },
    )!;
    expect(e.focalLengthMm).toBe(6.81);
    expect(e.focalLength35mm).toBe(26);
    expect(e.fNumber).toBeCloseTo(1.68, 9);
    expect(e.exposureTimeS).toBeCloseTo(1 / 80, 9);
    expect(e.iso).toBe(54);
    expect(e.pixelWidth).toBe(4080);
    expect(e.digitalZoomRatio).toBeNull();
    expect(e.focalPxSource).toBe("exif35");
  });

  it("keepRaw attaches the dictionary without MakerNote / maker blobs", () => {
    const e = normalizeExif(IOS_EXIF, { ...dims, keepRaw: true })!;
    expect(e.raw).toBeDefined();
    expect(e.raw).not.toHaveProperty("MakerNote");
    expect(e.raw).not.toHaveProperty("{MakerApple}");
    expect(e.raw).toHaveProperty("LensSpecification");
    expect(e.raw!.FocalLenIn35mmFilm).toBe(26);
    // Android's MakerNote is dropped too.
    const a = normalizeExif(ANDROID_EXIF, { ...dims, keepRaw: true })!;
    expect(a.raw).not.toHaveProperty("MakerNote");
    expect(a.raw!.Model).toBe("Pixel 8");
    // The input is never mutated.
    expect(IOS_EXIF).toHaveProperty("MakerNote");
  });

  it("returns null for non-dictionaries and an all-null record for an empty one", () => {
    expect(normalizeExif(null, { ...dims, keepRaw: false })).toBeNull();
    expect(normalizeExif(undefined, { ...dims, keepRaw: false })).toBeNull();
    expect(normalizeExif("x", { ...dims, keepRaw: false })).toBeNull();
    expect(normalizeExif([1], { ...dims, keepRaw: false })).toBeNull();
    const empty = normalizeExif({}, { ...dims, keepRaw: false })!;
    expect(empty).not.toBeNull();
    expect(empty.focalPx).toBeNull();
    expect(empty.focalPxSource).toBeNull();
    expect(empty.iso).toBeNull();
  });

  it("flattens a full ImageIO metadata dictionary ({Exif}/{TIFF})", () => {
    const e = normalizeExif(
      {
        "{Exif}": { FocalLenIn35mmFilm: 26, ISOSpeedRatings: [100] },
        "{TIFF}": { Make: "Apple", Model: "iPhone 14 Pro" },
      },
      { ...dims, keepRaw: false },
    )!;
    expect(e.focalLength35mm).toBe(26);
    expect(e.iso).toBe(100);
    expect(e.make).toBe("Apple");
    expect(e.model).toBe("iPhone 14 Pro");
  });
});

describe("readExifOrientation", () => {
  it("reads 1–8, tolerates strings, rejects garbage", () => {
    expect(readExifOrientation(IOS_EXIF)).toBe(6);
    expect(readExifOrientation(ANDROID_EXIF)).toBe(6);
    expect(readExifOrientation({ Orientation: "8" })).toBe(8);
    expect(readExifOrientation({ Orientation: 1 })).toBe(1);
    expect(readExifOrientation({ Orientation: 0 })).toBeNull();
    expect(readExifOrientation({ Orientation: 9 })).toBeNull();
    expect(readExifOrientation({ Orientation: 6.5 })).toBeNull();
    expect(readExifOrientation({})).toBeNull();
    expect(readExifOrientation(null)).toBeNull();
    expect(readExifOrientation(undefined)).toBeNull();
  });
});
