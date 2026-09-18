/**
 * EXIF → camera-intrinsics helpers for guided-sweep frames.
 *
 * Pure TypeScript with no imports so it unit-tests in isolation and can be
 * reused outside the hook. `normalizeExif` flattens the per-platform
 * dictionaries expo-camera returns from `takePictureAsync({ exif: true })`
 * into one shape; `deriveFocalPx` turns the 35 mm-equivalent focal length
 * into a pixel focal-length prior for metric monodepth / intrinsics.
 *
 * Platform shapes handled (expo-camera 57, verified against its sources):
 *
 *  - iOS hands back the Exif sub-dictionary with Apple key spellings:
 *    `FocalLength` (mm), `FocalLenIn35mmFilm` (note the `Len` spelling),
 *    `LensModel`, `ISOSpeedRatings` as an ARRAY, `SubsecTimeOriginal`, plus
 *    expo-injected `Orientation` / `PixelXDimension` / `PixelYDimension`.
 *    `Make` / `Model` are NOT returned (they live in the TIFF dictionary).
 *  - Android hands back androidx `ExifInterface` tag names with parsed
 *    types: `FocalLength` (double), `FocalLengthIn35mmFilm` (int, often
 *    absent), `DigitalZoomRatio`, `Make` / `Model`, `ISOSpeedRatings` (int),
 *    `SubSecTimeOriginal`, `Orientation`, `PixelX/YDimension`. No `LensModel`.
 *
 * Numeric strings (including `"28/10"` rationals) are accepted everywhere a
 * number is expected, so raw `ExifInterface.getAttribute` output works too.
 */

/** Camera metadata for one sweep frame, normalized across platforms. */
export type SweepPhotoExif = {
  /** Physical focal length, mm (`FocalLength`). */
  focalLengthMm: number | null;
  /** 35 mm-equivalent focal length (`FocalLenIn35mmFilm` / `FocalLengthIn35mmFilm`). */
  focalLength35mm: number | null;
  /**
   * Pixel focal-length PRIOR for the delivered frame, derived from
   * `focalLength35mm` by {@link deriveFocalPx}. Roughly ±5 % — a stitch-
   * estimated focal (bundle adjustment) supersedes it for stitched frames.
   */
  focalPx: number | null;
  /** How `focalPx` was obtained; `null` when it could not be derived. */
  focalPxSource: "exif35" | null;
  /** `LensModel` (iOS only in practice). */
  lensModel: string | null;
  /** `Make` (Android only in practice). */
  make: string | null;
  /** `Model` (Android only in practice). */
  model: string | null;
  /** ISO sensitivity — iOS's `[n]` array and Android's int both collapse to `n`. */
  iso: number | null;
  /** `ExposureTime`, seconds. */
  exposureTimeS: number | null;
  /** `FNumber`. */
  fNumber: number | null;
  /** `DigitalZoomRatio` (Android). `1` or `null` means no digital zoom. */
  digitalZoomRatio: number | null;
  /**
   * `PixelXDimension` — NOTE: on iOS this is the RAW sensor frame width
   * (before EXIF orientation), on Android whatever the HAL wrote. Prefer
   * `SweepPhoto.width`/`height` for the upright delivered size.
   */
  pixelWidth: number | null;
  /** `PixelYDimension` — see `pixelWidth`. */
  pixelHeight: number | null;
  /** `DateTimeOriginal` as the camera wrote it (`YYYY:MM:DD HH:MM:SS`). */
  dateTimeOriginal: string | null;
  /** `SubsecTimeOriginal` / `SubSecTimeOriginal` — fractional-second digits. */
  subsecTimeOriginal: string | null;
  /**
   * The untouched dictionary (minus `MakerNote` / maker blobs), present only
   * when normalized with `keepRaw: true` (`GuidedSweepOptions.exif: "full"`).
   */
  raw?: Record<string, unknown>;
};

/** Diagonal of a 36 × 24 mm full-frame sensor, mm — the 35 mm-equivalence reference. */
export const FULL_FRAME_DIAGONAL_MM = 43.2666;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Pixel focal length from the 35 mm-equivalent focal length, using the
 * DIAGONAL equivalence (the CIPA definition — phones report `f35` as
 * `f × 43.27 / sensorDiagonal`) on the FULL 4:3 sensor frame.
 *
 * The delivered frame may be a crop of the sensor (a 9:16 or 1:1 capture
 * ratio, or expo-camera's preview-aspect crop); a crop changes the
 * delivered width/height but not the pixel focal length, so the full 4:3
 * frame is reconstructed from the delivered dims before applying the
 * diagonal:
 *
 *     long = max(w, h), short = min(w, h)
 *     fullLong  = max(long, short × 4/3)
 *     fullShort = max(short, long × 3/4)
 *     focalPx   = f35 × hypot(fullLong, fullShort) / 43.2666
 *
 * Accuracy: roughly ±5 % — `f35` is written as an integer by the camera
 * stack, phone sensors are not exactly 4:3, and some vendors fold digital
 * zoom or lens correction into it. Treat it as a PRIOR (good enough to seed
 * metric monodepth or a bundle adjuster); a focal estimated by the stitcher
 * itself supersedes it for frames that were stitched.
 *
 * Returns `null` when `focalLength35mm` or the dims are missing / non-positive.
 */
export function deriveFocalPx(
  focalLength35mm: number | null | undefined,
  width: number,
  height: number,
): number | null {
  if (!isFiniteNumber(focalLength35mm) || focalLength35mm <= 0) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const fullLong = Math.max(long, (short * 4) / 3);
  const fullShort = Math.max(short, (long * 3) / 4);
  return (
    (focalLength35mm * Math.hypot(fullLong, fullShort)) / FULL_FRAME_DIAGONAL_MM
  );
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Coerce an EXIF value to a finite number: numbers pass through, numeric
 * strings and `"n/d"` rationals are parsed, arrays use their first element
 * (iOS `ISOSpeedRatings: [100]`). Anything else → `null`.
 */
function toNumber(v: unknown): number | null {
  if (isFiniteNumber(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const rational = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (rational) {
      const den = Number(rational[2]);
      return den > 0 ? Number(rational[1]) / den : null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(v)) return v.length > 0 ? toNumber(v[0]) : null;
  return null;
}

function toText(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }
  if (isFiniteNumber(v)) return String(v);
  return null;
}

/** First key whose value is present (not `null`/`undefined`). */
function pick(src: Dict, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = src[k];
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

/**
 * Binary maker blobs — never useful to a consumer and, on some Android
 * devices, tens of kilobytes per frame. Dropped from `raw`.
 */
const RAW_DROP_KEYS = new Set(["MakerNote", "{MakerApple}", "MakerApple"]);

/**
 * Flatten a full ImageIO-style metadata dictionary (`{Exif}` / `{TIFF}`
 * sub-dicts) when handed one instead of the Exif sub-dictionary expo-camera
 * returns — lets the same function serve other pickers' `exif` payloads.
 */
function flatten(raw: Dict): Dict {
  const exif = raw["{Exif}"];
  const tiff = raw["{TIFF}"];
  if (!isDict(exif) && !isDict(tiff)) return raw;
  return {
    ...raw,
    ...(isDict(tiff) ? tiff : {}),
    ...(isDict(exif) ? exif : {}),
  };
}

/**
 * Read the EXIF `Orientation` tag (1–8) from a raw expo-camera `exif`
 * dictionary; `null` when absent or out of range.
 */
export function readExifOrientation(raw: unknown): number | null {
  if (!isDict(raw)) return null;
  const o = toNumber(pick(flatten(raw), ["Orientation"]));
  return o !== null && Number.isInteger(o) && o >= 1 && o <= 8 ? o : null;
}

/**
 * Normalize an expo-camera `photo.exif` dictionary (either platform's
 * shape, see the module doc) into a {@link SweepPhotoExif}.
 *
 * `opts.width` / `opts.height` are the UPRIGHT delivered pixel dims of the
 * frame (what `SweepPhoto.width`/`height` carry) and feed
 * {@link deriveFocalPx}; orientation does not matter to the formula.
 * `opts.keepRaw` attaches the source dictionary as `raw` (minus maker
 * blobs). Returns `null` when `raw` is not a dictionary — an empty
 * dictionary yields a record of `null`s, so "EXIF requested but empty" is
 * distinguishable from "EXIF not requested".
 */
export function normalizeExif(
  raw: unknown,
  opts: { width: number; height: number; keepRaw: boolean },
): SweepPhotoExif | null {
  if (!isDict(raw)) return null;
  const src = flatten(raw);

  const focalLength35mm = toNumber(
    pick(src, ["FocalLenIn35mmFilm", "FocalLengthIn35mmFilm"]),
  );
  const focalPx = deriveFocalPx(focalLength35mm, opts.width, opts.height);

  const out: SweepPhotoExif = {
    focalLengthMm: toNumber(pick(src, ["FocalLength"])),
    focalLength35mm,
    focalPx,
    focalPxSource: focalPx !== null ? "exif35" : null,
    lensModel: toText(pick(src, ["LensModel"])),
    make: toText(pick(src, ["Make"])),
    model: toText(pick(src, ["Model"])),
    iso: toNumber(
      pick(src, ["ISOSpeedRatings", "PhotographicSensitivity", "ISOSpeed"]),
    ),
    exposureTimeS: toNumber(pick(src, ["ExposureTime"])),
    fNumber: toNumber(pick(src, ["FNumber"])),
    digitalZoomRatio: toNumber(pick(src, ["DigitalZoomRatio"])),
    pixelWidth: toNumber(pick(src, ["PixelXDimension"])),
    pixelHeight: toNumber(pick(src, ["PixelYDimension"])),
    dateTimeOriginal: toText(pick(src, ["DateTimeOriginal"])),
    subsecTimeOriginal: toText(
      pick(src, ["SubsecTimeOriginal", "SubSecTimeOriginal"]),
    ),
  };

  if (opts.keepRaw) {
    const kept: Dict = {};
    for (const k of Object.keys(raw)) {
      if (!RAW_DROP_KEYS.has(k)) kept[k] = raw[k];
    }
    out.raw = kept;
  }
  return out;
}
